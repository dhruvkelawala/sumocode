import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BUILT_IN_TOOLS } from "../native-task-config.js";
import { BUILT_IN_ROLES, loadRoles, resolveRolesPath, type LoadedRoles, type SubagentRole } from "../subagents/roles.js";
import { showSearchPalette, type SearchPaletteOptions, type SearchPaletteRow } from "./roles-palette.js";

const OPEN_ACTION_ID = "action:open";
const RESET_ACTION_ID = "action:reset";
const OPEN_ACTION = "open roles.json in $EDITOR";
const RESET_ACTION = "reset a role to built-in…";
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;
const THINKING_LEVELS = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type EditableRoleField = "model" | "thinking" | "tools" | "worktree" | "visible" | "systemPrompt";

export type RolesCommandResult = {
	readonly kind: "success" | "error" | "instructions";
	readonly message: string;
	readonly opened: boolean;
};

export type RolesFileMutation =
	| { readonly kind: "ensure" }
	| { readonly kind: "reset"; readonly roleId: string }
	| { readonly kind: "set" | "set-if-absent"; readonly roleId: string; readonly field: string; readonly value: unknown };

export interface RolesEditorOutcome {
	readonly status: number;
	readonly error?: string;
}

export interface RolesCommandDeps {
	readonly rolesPath: string;
	readonly isTTY: boolean;
	readonly loadRoles: () => LoadedRoles;
	readonly writeRolesFile: (mutation: RolesFileMutation) => void | Promise<void>;
	readonly showPalette: (options: SearchPaletteOptions) => Promise<string | undefined>;
	readonly getAvailableModels: () => { readonly id: string; readonly provider?: string }[];
	readonly input: (title: string, placeholder: string) => Promise<string | undefined>;
	readonly openEditor: (path: string) => RolesEditorOutcome | Promise<RolesEditorOutcome>;
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

async function openRolesEditor(deps: RolesCommandDeps): Promise<RolesCommandResult> {
	const ensured = await writeMutation(deps, { kind: "ensure" });
	if (ensured) return ensured;
	const outcome = await deps.openEditor(deps.rolesPath);
	if (outcome.status === 0) return { kind: "success", opened: true, message: "role updated — applies to the next spawn" };
	if (outcome.error) return { kind: "error", opened: true, message: `failed to launch editor: ${outcome.error}` };
	return { kind: "error", opened: true, message: `editor exited with code ${outcome.status}` };
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

function surfaceRows(roles: readonly SubagentRole[]): { rows: SearchPaletteRow[]; selections: Map<string, RoleFieldSelection> } {
	const rows: SearchPaletteRow[] = [];
	const selections = new Map<string, RoleFieldSelection>();
	const add = (role: SubagentRole, field: EditableRoleField, label: string, value: string): void => {
		const id = roleFieldId(role.id, field);
		rows.push({ id, label: `${role.id} ${label}`, value });
		selections.set(id, { role, field });
	};

	for (const role of roles) {
		add(role, "model", "model", role.model ?? "inherit");
		add(role, "thinking", "thinking", role.thinking ?? "inherit");
		add(role, "tools", "tools", toolsValue(role));
		add(role, "worktree", "worktree", booleanValue(role.defaultWorktree));
		add(role, "visible", "visible", booleanValue(role.defaultVisible));
	}
	for (const role of roles) add(role, "systemPrompt", "system prompt", systemPromptValue(role));
	rows.push({ id: OPEN_ACTION_ID, label: OPEN_ACTION, value: "" });
	rows.push({ id: RESET_ACTION_ID, label: RESET_ACTION, value: "" });
	return { rows, selections };
}

function pickerRows(values: readonly string[]): SearchPaletteRow[] {
	return values.map((value) => ({ id: value, label: value, value: "" }));
}

function modelValue(model: { readonly id: string; readonly provider?: string }): string {
	return model.provider && !model.id.includes("/") ? `${model.provider}/${model.id}` : model.id;
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
		return thinking === undefined ? undefined : { kind: "set", roleId: role.id, field: "thinking", value: thinking === "inherit" ? undefined : thinking };
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
			value: tools === "inherit parent" ? undefined : tools.startsWith("read-only") ? [...READ_ONLY_TOOLS] : [...BUILT_IN_TOOLS],
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
			value: value === "inherit default" ? undefined : value === "true",
		};
	}
	return { kind: "set-if-absent", roleId: role.id, field: "systemPrompt", value: role.systemPrompt };
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
	while (true) {
		const surface = surfaceRows(deps.loadRoles().roles);
		const selected = await deps.showPalette({
			title: "SUBAGENT ROLES",
			placeholder: "what shall we tune…",
			rows: surface.rows,
		});
		if (selected === undefined) return latestResult;

		if (selected === OPEN_ACTION_ID) {
			const result = await openRolesEditor(deps);
			if (result.kind === "error") return result;
			latestResult = result;
			continue;
		}
		if (selected === RESET_ACTION_ID) {
			const roleId = await deps.showPalette({
				title: "RESET ROLE TO BUILT-IN",
				placeholder: "choose a role…",
				rows: BUILT_IN_ROLES.map((role) => ({ id: role.id, label: role.id, value: role.label })),
			});
			if (roleId === undefined) continue;
			const failed = await writeMutation(deps, { kind: "reset", roleId });
			if (failed) return failed;
			latestResult = successResult(false);
			continue;
		}

		const fieldSelection = surface.selections.get(selected);
		if (!fieldSelection) continue;
		const mutation = await chooseMutation(deps, fieldSelection);
		if (!mutation) continue;
		const failed = await writeMutation(deps, mutation);
		if (failed) return failed;
		if (fieldSelection.field === "systemPrompt") {
			const result = await openRolesEditor(deps);
			if (result.kind === "error") return result;
			latestResult = result;
		} else {
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
	if (mutation.kind === "reset") {
		document.roles = document.roles.filter((role) => role.id !== mutation.roleId);
	} else if (mutation.kind === "set" || mutation.kind === "set-if-absent") {
		let overlay = document.roles.find((role) => role.id === mutation.roleId);
		if (!overlay) {
			overlay = { id: mutation.roleId };
			document.roles.push(overlay);
		}
		if (mutation.kind === "set-if-absent" && Object.prototype.hasOwnProperty.call(overlay, mutation.field)) {
			// Keep the operator's existing long-form text intact before opening it.
		} else if (mutation.value === undefined) delete overlay[mutation.field];
		else overlay[mutation.field] = mutation.value;
	}
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

function defaultOpenEditor(editor: string, path: string): RolesEditorOutcome {
	const child = spawnSync(editor, [path], { stdio: "inherit", env: process.env });
	return { status: child.status ?? 1, error: child.error?.message };
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
					openEditor: (editorPath) => defaultOpenEditor(process.env.EDITOR?.trim() || "vi", editorPath),
				});
				if (result) notify(ctx, result);
			} catch (error) {
				notify(ctx, { kind: "error", opened: false, message: `unable to edit roles: ${errorText(error)}` });
			}
		},
	});
}
