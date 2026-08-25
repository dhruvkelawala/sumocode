import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showDivineQuery } from "../divine-query.js";
import { BUILT_IN_TOOLS } from "../native-task-config.js";
import { BUILT_IN_ROLES, loadRoles, resolveRolesPath, type LoadedRoles, type SubagentRole } from "../subagents/roles.js";

const OPEN_ACTION = "open roles.json in $EDITOR";
const RESET_ACTION = "reset a role to built-in";
const ROLE_FIELDS = ["model", "thinking", "tools", "default worktree", "default visible", "system prompt"] as const;
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

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
	readonly select: (title: string, options: readonly string[]) => Promise<string | undefined>;
	readonly input: (title: string, placeholder: string) => Promise<string | undefined>;
	readonly openEditor: (path: string) => RolesEditorOutcome | Promise<RolesEditorOutcome>;
}

const roleOption = (role: SubagentRole): string => `${role.id} · ${role.label} · ${role.model ?? "inherit"} · ${role.thinking ?? "inherit"}`;

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

export async function runRolesCommand(deps: RolesCommandDeps): Promise<RolesCommandResult | undefined> {
	if (!deps.isTTY) {
		return {
			kind: "instructions",
			opened: false,
			message: `roles file: ${deps.rolesPath} — edit it directly; changes apply to the next spawn`,
		};
	}

	const loaded = deps.loadRoles();
	const roleOptions = loaded.roles.map(roleOption);
	const selected = await deps.select("SUBAGENT ROLES", [...roleOptions, OPEN_ACTION, RESET_ACTION]);
	if (selected === undefined) return undefined;
	if (selected === OPEN_ACTION) return openRolesEditor(deps);
	if (selected === RESET_ACTION) {
		const resetOptions = BUILT_IN_ROLES.map((role) => `${role.id} · ${role.label}`);
		const resetSelection = await deps.select("RESET ROLE TO BUILT-IN", resetOptions);
		if (resetSelection === undefined) return undefined;
		const role = BUILT_IN_ROLES[resetOptions.indexOf(resetSelection)];
		if (!role) return undefined;
		const failed = await writeMutation(deps, { kind: "reset", roleId: role.id });
		return failed ?? { kind: "success", opened: false, message: "role updated — applies to the next spawn" };
	}

	const role = loaded.roles[roleOptions.indexOf(selected)];
	if (!role) return undefined;
	const field = await deps.select(`${role.id.toUpperCase()} ROLE`, ROLE_FIELDS);
	if (field === undefined) return undefined;

	let mutation: RolesFileMutation | undefined;
	if (field === "model") {
		const mode = await deps.select("MODEL", ["inherit (use parent session's model)", "set a specific model…"]);
		if (mode === undefined) return undefined;
		if (mode === "inherit (use parent session's model)") {
			mutation = { kind: "set", roleId: role.id, field: "model", value: "inherit" };
		} else {
			const model = await deps.input("model (provider/modelId)", role.model ?? "");
			if (model === undefined || !model.trim()) return undefined;
			mutation = { kind: "set", roleId: role.id, field: "model", value: model.trim() };
		}
	} else if (field === "thinking") {
		const thinking = await deps.select("THINKING", ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		if (thinking === undefined) return undefined;
		mutation = { kind: "set", roleId: role.id, field: "thinking", value: thinking === "inherit" ? undefined : thinking };
	} else if (field === "tools") {
		const tools = await deps.select("TOOLS", ["inherit parent", "read-only (read, grep, find, ls, bash)", "full built-in set"]);
		if (tools === undefined) return undefined;
		mutation = {
			kind: "set",
			roleId: role.id,
			field: "tools",
			value: tools === "inherit parent" ? undefined : tools.startsWith("read-only") ? [...READ_ONLY_TOOLS] : [...BUILT_IN_TOOLS],
		};
	} else if (field === "default worktree" || field === "default visible") {
		const value = await deps.select(field.toUpperCase(), ["inherit default", "true", "false"]);
		if (value === undefined) return undefined;
		mutation = {
			kind: "set",
			roleId: role.id,
			field: field === "default worktree" ? "defaultWorktree" : "defaultVisible",
			value: value === "inherit default" ? undefined : value === "true",
		};
	} else {
		const failed = await writeMutation(deps, { kind: "set-if-absent", roleId: role.id, field: "systemPrompt", value: role.systemPrompt });
		if (failed) return failed;
		return openRolesEditor(deps);
	}

	const failed = mutation ? await writeMutation(deps, mutation) : undefined;
	return failed ?? { kind: "success", opened: false, message: "role updated — applies to the next spawn" };
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
					select: (title, options) => showDivineQuery(ctx, title, options),
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
