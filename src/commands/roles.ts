import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BUILT_IN_TOOLS } from "../native-task-config.js";
import { BUILT_IN_ROLES, loadRoles, resolveRolesPath, type LoadedRoles, type SubagentRole } from "../subagents/roles.js";
import { showSearchPalette, type SearchPaletteOptions, type SearchPaletteRow } from "./roles-palette.js";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;
const THINKING_LEVELS = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type EditableRoleField = "model" | "thinking" | "tools" | "worktree" | "visible" | "systemPrompt";

export type RolesCommandResult = {
	readonly kind: "success" | "error" | "instructions";
	readonly message: string;
	readonly opened: boolean;
};

export type RolesFileMutation =
	| { readonly kind: "set"; readonly roleId: string; readonly field: string; readonly value: unknown };

export interface RolesCommandDeps {
	readonly rolesPath: string;
	readonly isTTY: boolean;
	readonly loadRoles: () => LoadedRoles;
	readonly writeRolesFile: (mutation: RolesFileMutation) => void | Promise<void>;
	readonly showPalette: (options: SearchPaletteOptions) => Promise<string | undefined>;
	readonly getAvailableModels: () => { readonly id: string; readonly provider?: string }[];
	readonly input: (title: string, placeholder: string) => Promise<string | undefined>;
}

interface RoleFieldSelection {
	readonly role: SubagentRole;
	readonly field: EditableRoleField;
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

async function writeMutation(deps: RolesCommandDeps, mutation: RolesFileMutation): Promise<RolesCommandResult | undefined> {
	try {
		await deps.writeRolesFile(mutation);
		return undefined;
	} catch (error) {
		return { kind: "error", opened: false, message: `unable to update roles.json: ${errorText(error)}` };
	}
}

function sameTools(actual: readonly string[], expected: readonly string[]): boolean {
	return actual.length === expected.length && actual.every((tool, index) => tool === expected[index]);
}

function toolsValue(role: SubagentRole): string {
	if (!role.tools) return "inherit parent";
	if (sameTools(role.tools, READ_ONLY_TOOLS)) return "read-only";
	if (sameTools(role.tools, BUILT_IN_TOOLS)) return "full built-in set";
	return role.tools.join(", ");
}

function booleanValue(value: boolean | undefined): string {
	return value === undefined ? "inherit default" : String(value);
}

function systemPromptValue(role: SubagentRole): string {
	const builtIn = BUILT_IN_ROLES.find((candidate) => candidate.id === role.id);
	return builtIn?.systemPrompt === role.systemPrompt ? "(built-in)" : "(custom)";
}

function roleFieldId(roleId: string, field: EditableRoleField): string {
	return `field:${roleId}:${field}`;
}

/** Surface-1 summary column: model · thinking · worktree posture. */
function roleSummary(role: SubagentRole): string {
	const worktree = role.defaultWorktree === true ? "worktree" : role.defaultWorktree === false ? "no worktree" : "inherit wt";
	return `${role.model ?? "inherit"} · ${role.thinking ?? "inherit"} · ${worktree}`;
}

/** Surface 1 — one row per role. */
function roleListRows(roles: readonly SubagentRole[]): SearchPaletteRow[] {
	return roles.map((role) => ({ id: `role:${role.id}`, label: role.id, value: roleSummary(role) }));
}

/** Surface 2 — the chosen role's editable fields with current values. */
function roleFieldRows(role: SubagentRole): { rows: SearchPaletteRow[]; selections: Map<string, RoleFieldSelection> } {
	const rows: SearchPaletteRow[] = [];
	const selections = new Map<string, RoleFieldSelection>();
	const add = (field: EditableRoleField, label: string, value: string): void => {
		const id = roleFieldId(role.id, field);
		rows.push({ id, label, value });
		selections.set(id, { role, field });
	};

	add("model", "model", role.model ?? "inherit");
	add("thinking", "thinking", role.thinking ?? "inherit");
	add("tools", "tools", toolsValue(role));
	add("worktree", "worktree", booleanValue(role.defaultWorktree));
	add("visible", "visible", booleanValue(role.defaultVisible));
	add("systemPrompt", "system prompt", systemPromptValue(role));
	return { rows, selections };
}

function pickerRows(values: readonly string[]): SearchPaletteRow[] {
	return values.map((value) => ({ id: value, label: value, value: "" }));
}

function modelValue(model: { readonly id: string; readonly provider?: string }): string {
	// Registry ids may themselves contain slashes (for example OpenRouter's
	// `z-ai/glm-5.3`). The subagent model contract is provider/modelId, so the
	// registry provider must still prefix the complete id.
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

async function chooseMutation(deps: RolesCommandDeps, selection: RoleFieldSelection): Promise<RolesFileMutation | undefined> {
	const { role, field } = selection;
	if (field === "model") {
		const models = deps.getAvailableModels();
		const rows: SearchPaletteRow[] = [
			{ id: "inherit", label: "inherit", value: "use parent session's model" },
			...models.map((model, index) => ({ id: `registry:${index}`, label: model.id, value: model.provider ?? "" })),
			{ id: "other", label: "other", value: "type provider/modelId…" },
		];
		const selected = await deps.showPalette({ title: `${role.id.toUpperCase()} MODEL`, placeholder: "choose a model…", rows });
		if (selected === undefined) return undefined;
		if (selected === "inherit") return { kind: "set", roleId: role.id, field: "model", value: "inherit" };
		if (selected === "other") {
			const model = await deps.input("model (provider/modelId)", role.model ?? "");
			if (model === undefined || !model.trim()) return undefined;
			return { kind: "set", roleId: role.id, field: "model", value: model.trim() };
		}
		const model = models[Number(selected.replace("registry:", ""))];
		return model ? { kind: "set", roleId: role.id, field: "model", value: modelValue(model) } : undefined;
	}
	if (field === "thinking") {
		const thinking = await deps.showPalette({ title: `${role.id.toUpperCase()} THINKING`, placeholder: "choose a thinking level…", rows: pickerRows(THINKING_LEVELS) });
		return thinking === undefined ? undefined : { kind: "set", roleId: role.id, field: "thinking", value: thinking };
	}
	if (field === "tools") {
		const tools = await deps.showPalette({
			title: `${role.id.toUpperCase()} TOOLS`,
			placeholder: "choose a tool policy…",
			rows: pickerRows(["inherit parent", "read-only (read, grep, find, ls, bash)", "full built-in set"]),
		});
		if (tools === undefined) return undefined;
		return {
			kind: "set",
			roleId: role.id,
			field: "tools",
			value: tools === "inherit parent" ? "inherit" : tools.startsWith("read-only") ? [...READ_ONLY_TOOLS] : [...BUILT_IN_TOOLS],
		};
	}
	if (field === "worktree" || field === "visible") {
		const value = await deps.showPalette({
			title: `${role.id.toUpperCase()} ${field.toUpperCase()}`,
			placeholder: "choose a default…",
			rows: pickerRows(["inherit default", "true", "false"]),
		});
		return value === undefined ? undefined : {
			kind: "set",
			roleId: role.id,
			field: field === "worktree" ? "defaultWorktree" : "defaultVisible",
			value: value === "inherit default" ? "inherit" : value === "true",
		};
	}
	// systemPrompt is handled by the caller (instructions pointing at the file).
	return undefined;
}

const successResult = (opened: boolean): RolesCommandResult => ({
	kind: "success",
	opened,
	message: "role updated — applies to the next spawn",
});

export async function runRolesCommand(deps: RolesCommandDeps): Promise<RolesCommandResult | undefined> {
	if (!deps.isTTY) {
		return {
			kind: "instructions",
			opened: false,
			message: `roles file: ${deps.rolesPath} — edit it directly; changes apply to the next spawn`,
		};
	}

	let latestResult: RolesCommandResult | undefined;
	// One level of nesting (operator preference, 2026-08-25): surface 1 lists
	// roles; surface 2 drills into the chosen role's fields; Esc walks back
	// UP one level instead of exiting. Edits keep you on surface 2 so multiple
	// tweaks to one role don't re-descend.
	while (true) {
		const roles = deps.loadRoles().roles;
		const selectedRole = await deps.showPalette({
			title: "SUBAGENT ROLES",
			placeholder: "which role shall we attend to…",
			rows: roleListRows(roles),
		});
		if (selectedRole === undefined) return latestResult;

		const roleId = selectedRole.startsWith("role:") ? selectedRole.slice("role:".length) : undefined;
		const role = roles.find((candidate) => candidate.id === roleId);
		if (!role) continue;

		while (true) {
			const surface = roleFieldRows(deps.loadRoles().roles.find((candidate) => candidate.id === role.id) ?? role);
			const selected = await deps.showPalette({
				title: `ROLE — ${role.id.toUpperCase()}`,
				placeholder: "what shall we tune…",
				rows: surface.rows,
			});
			if (selected === undefined) break; // Esc walks back up to surface 1

			const fieldSelection = surface.selections.get(selected);
			if (!fieldSelection) break;
			if (fieldSelection.field === "systemPrompt") {
				// Long-form prompts don't belong in a one-line input and $EDITOR
				// cannot run from the rpc host (plan 085) — point at the file.
				latestResult = {
					kind: "instructions",
					opened: false,
					message: `role system prompts live in ${deps.rolesPath} under "systemPrompt" — edit the file directly; changes apply to the next spawn`,
				};
				continue;
			}
			const mutation = await chooseMutation(deps, fieldSelection);
			if (!mutation) continue;
			const failed = await writeMutation(deps, mutation);
			if (failed) return failed;
			latestResult = successResult(false);
		}
	}
}

interface RolesDocument {
	roles: Array<Record<string, unknown> & { id: string }>;
	[key: string]: unknown;
}

function readRolesDocument(path: string): RolesDocument {
	if (!existsSync(path)) return { roles: [] };
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { roles?: unknown }).roles)) {
		throw new Error("roles.json must contain a roles array");
	}
	const roles = (parsed as { roles: unknown[] }).roles;
	if (!roles.every((entry) => typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string")) {
		throw new Error("roles.json contains an invalid role entry");
	}
	return parsed as RolesDocument;
}

export function writeRolesFile(path: string, mutation: RolesFileMutation): void {
	const document = readRolesDocument(path);
	const overlay = document.roles.find((role) => role.id === mutation.roleId);
	if (overlay && mutation.value === undefined) delete overlay[mutation.field];
	else if (overlay) overlay[mutation.field] = mutation.value;
	else document.roles.push({ id: mutation.roleId, [mutation.field]: mutation.value });
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}

function notify(ctx: ExtensionContext, result: RolesCommandResult): void {
	const type = result.kind === "error" ? "error" : "info";
	if (ctx.hasUI) {
		ctx.ui.notify(result.message, type);
		return;
	}
	const stream = type === "error" ? process.stderr : process.stdout;
	stream.write(`${result.message}\n`);
}

export function registerRolesCommand(pi: ExtensionAPI): void {
	pi.registerCommand("sumo:roles", {
		description: "Edit subagent role presets",
		handler: async (_args, ctx) => {
			const path = resolveRolesPath();
			try {
				const result = await runRolesCommand({
					rolesPath: path,
					isTTY: ctx.hasUI,
					loadRoles,
					writeRolesFile: (mutation) => writeRolesFile(path, mutation),
					showPalette: (options) => showSearchPalette(ctx, options),
					getAvailableModels: () => ctx.modelRegistry.getAvailable().map((model) => ({ id: model.id, provider: model.provider })),
					input: (title, placeholder) => ctx.ui.input(title, placeholder),
				});
				if (result) notify(ctx, result);
			} catch (error) {
				notify(ctx, { kind: "error", opened: false, message: `unable to edit roles: ${errorText(error)}` });
			}
		},
	});
}
