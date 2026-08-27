// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters, anti-slop/require-safety-comment-for-type-assertion -- roles.json file boundary parser: user-authored role overlays arrive as untrusted JSON,
// so unknown-typed inputs, runtime typeof decoding guards, open records, and widening
// assertions onto record shapes are this module's parsing contract.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BUILT_IN_TOOLS } from "../native-task-config.js";

const MAX_ROLES_FILE_BYTES = 256 * 1024;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const ROLE_FIELDS = new Set(["id", "label", "description", "systemPrompt", "model", "thinking", "tools", "defaultWorktree", "defaultVisible"]);

export interface SubagentRole {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly systemPrompt: string;
	readonly model?: string;
	readonly thinking?: (typeof THINKING_LEVELS)[number];
	readonly tools?: readonly string[];
	readonly defaultWorktree?: boolean;
	readonly defaultVisible?: boolean;
}

export const BUILT_IN_ROLES: readonly SubagentRole[] = [
	{
		id: "research",
		label: "Research",
		description: "use proactively for read-only investigation and evidence gathering",
		systemPrompt: "act as a read-only investigator. never modify files. answer with evidence using file:line references or urls. state what was not checked. report findings only, not fixes.",
		tools: ["read", "grep", "find", "ls", "bash"],
	},
	{
		id: "review",
		label: "Review",
		description: "use for evidence-backed technical review of a bounded change",
		systemPrompt: "review like a tech lead. verify claims by opening cited code. report findings ordered by severity with file:line evidence. never edit files. flag out-of-scope diff hunks explicitly.",
		tools: ["read", "grep", "find", "ls", "bash"],
	},
	{
		id: "documentor",
		label: "Documentor",
		description: "use for writing or updating repository documentation",
		systemPrompt: "write or update documentation only. match the repository's existing documentation voice and structure. never change source code semantics. list every file touched.",
		defaultWorktree: true,
	},
	{
		id: "designer",
		label: "Designer",
		description: "use for ui and ux changes that require visual review evidence",
		systemPrompt: "perform ui and ux work. read the repository's design conventions and visual specifications before changing any surface. produce capture and review evidence for visual changes. never promote goldens.",
		defaultWorktree: true,
	},
	{
		id: "implement-cheap",
		label: "Implement Cheap",
		description: "use for a precise, fully specified implementation slice or verification run",
		systemPrompt: "implement exactly the specified slice. make the smallest diff that passes verification. run the named verification commands. if the specification is ambiguous, stop and report instead of improvising.",
		thinking: "low",
		defaultWorktree: true,
	},
	{
		id: "implement-smart",
		label: "Implement Smart",
		description: "use for a bounded implementation slice that needs judgment or tradeoffs mid-flight",
		systemPrompt: "implement with judgment. keep scope tight. document tradeoffs made. run full relevant verification.",
		thinking: "high",
		defaultWorktree: true,
	},
];

export interface LoadRolesDependencies {
	readonly readFile?: (path: string, encoding: "utf8") => string;
	readonly env?: NodeJS.ProcessEnv;
}

export interface LoadedRoles {
	readonly roles: readonly SubagentRole[];
	readonly warnings: readonly string[];
}

export function resolveRolesPath(env: NodeJS.ProcessEnv = process.env): string {
	const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "sumocode", "roles.json");
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hasOwn = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);
const isThinking = (value: string): value is SubagentRole["thinking"] & string => (THINKING_LEVELS as readonly string[]).includes(value);

interface MutableRoleOverlay {
	id: string;
	label?: string;
	description?: string;
	systemPrompt?: string;
	model?: string;
	thinking?: SubagentRole["thinking"];
	tools?: string[];
	defaultWorktree?: boolean;
	defaultVisible?: boolean;
}

function normalizedOverlay(value: unknown, index: number, builtIn: boolean, warnings: string[]): MutableRoleOverlay | undefined {
	if (!isRecord(value)) {
		warnings.push(`roles[${index}] must be an object; entry skipped`);
		return undefined;
	}
	const id = typeof value.id === "string" ? value.id.trim() : "";
	if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
		warnings.push(`roles[${index}] has an invalid id; entry skipped`);
		return undefined;
	}
	if (!builtIn && (typeof value.label !== "string" || !value.label.trim() || typeof value.systemPrompt !== "string" || !value.systemPrompt.trim())) {
		warnings.push(`role ${id} is new and requires label and systemPrompt; entry skipped`);
		return undefined;
	}
	for (const field of Object.keys(value)) {
		if (!ROLE_FIELDS.has(field)) warnings.push(`role ${id} ignores unknown field ${field}`);
	}
	for (const field of ["label", "description", "systemPrompt"] as const) {
		if (hasOwn(value, field) && (typeof value[field] !== "string" || !value[field].trim())) {
			warnings.push(`role ${id} has an invalid ${field}; entry skipped`);
			return undefined;
		}
	}
	if (hasOwn(value, "model") && (typeof value.model !== "string" || !value.model.trim())) {
		warnings.push(`role ${id} has an invalid model; entry skipped`);
		return undefined;
	}
	if (hasOwn(value, "thinking") && (typeof value.thinking !== "string" || (value.thinking !== "inherit" && !isThinking(value.thinking)))) {
		warnings.push(`role ${id} has an invalid thinking level; entry skipped`);
		return undefined;
	}
	for (const field of ["defaultWorktree", "defaultVisible"] as const) {
		if (hasOwn(value, field) && typeof value[field] !== "boolean" && value[field] !== "inherit") {
			warnings.push(`role ${id} has an invalid ${field}; entry skipped`);
			return undefined;
		}
	}
	if (hasOwn(value, "tools") && !Array.isArray(value.tools) && value.tools !== "inherit") {
		warnings.push(`role ${id} has an invalid tools list; entry skipped`);
		return undefined;
	}

	const overlay: MutableRoleOverlay = { id };
	for (const field of ["label", "description", "systemPrompt"] as const) {
		if (typeof value[field] === "string") overlay[field] = value[field];
	}
	if (hasOwn(value, "model")) overlay.model = value.model === "inherit" ? undefined : (value.model as string).trim();
	if (hasOwn(value, "thinking")) overlay.thinking = value.thinking === "inherit" ? undefined : value.thinking as SubagentRole["thinking"];
	if (hasOwn(value, "defaultWorktree")) overlay.defaultWorktree = value.defaultWorktree === "inherit" ? undefined : value.defaultWorktree as boolean;
	if (hasOwn(value, "defaultVisible")) overlay.defaultVisible = value.defaultVisible === "inherit" ? undefined : value.defaultVisible as boolean;
	if (value.tools === "inherit") overlay.tools = undefined;
	else if (Array.isArray(value.tools)) {
		const tools: string[] = [];
		for (const tool of value.tools) {
			if (typeof tool !== "string" || !(BUILT_IN_TOOLS as readonly string[]).includes(tool)) {
				warnings.push(`role ${id} ignores invalid tool ${String(tool)}`);
				continue;
			}
			if (!tools.includes(tool)) tools.push(tool);
		}
		overlay.tools = tools;
	}
	return overlay;
}

export function loadRoles(dependencies: LoadRolesDependencies = {}): LoadedRoles {
	const readFile = dependencies.readFile ?? readFileSync;
	const path = resolveRolesPath(dependencies.env);
	let contents: string;
	try {
		contents = readFile(path, "utf8");
	} catch (error) {
		const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
		return code === "ENOENT"
			? { roles: BUILT_IN_ROLES, warnings: [] }
			: { roles: BUILT_IN_ROLES, warnings: [`unable to read roles.json: ${error instanceof Error ? error.message : String(error)}`] };
	}
	if (Buffer.byteLength(contents, "utf8") > MAX_ROLES_FILE_BYTES) {
		return { roles: BUILT_IN_ROLES, warnings: ["roles.json exceeds 256 KB; using built-in roles"] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents) as unknown;
	} catch (error) {
		return { roles: BUILT_IN_ROLES, warnings: [`invalid roles.json: ${error instanceof Error ? error.message : String(error)}`] };
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.roles)) {
		return { roles: BUILT_IN_ROLES, warnings: ["roles.json must contain a roles array; using built-in roles"] };
	}

	const warnings: string[] = [];
	const roles = BUILT_IN_ROLES.map((role) => ({ ...role }));
	for (let index = 0; index < parsed.roles.length; index += 1) {
		const raw = parsed.roles[index];
		const rawId = isRecord(raw) && typeof raw.id === "string" ? raw.id.trim() : "";
		const roleIndex = roles.findIndex((role) => role.id === rawId);
		const overlay = normalizedOverlay(raw, index, roleIndex >= 0, warnings);
		if (!overlay) continue;
		if (roleIndex >= 0) {
			roles[roleIndex] = { ...roles[roleIndex], ...overlay } as SubagentRole;
			continue;
		}
		roles.push((() => {
			const role: MutableRoleOverlay & { label: string; systemPrompt: string; description: string } = {
				id: overlay.id,
				label: overlay.label as string,
				description: overlay.description ?? "use for a custom operator-defined delegation role",
				systemPrompt: overlay.systemPrompt as string,
			};
			if (hasOwn(overlay, "model")) role.model = overlay.model;
			if (overlay.thinking !== undefined) role.thinking = overlay.thinking;
			if (overlay.tools !== undefined) role.tools = overlay.tools;
			if (overlay.defaultWorktree !== undefined) role.defaultWorktree = overlay.defaultWorktree;
			if (overlay.defaultVisible !== undefined) role.defaultVisible = overlay.defaultVisible;
			return role as SubagentRole;
		})());
	}
	return { roles, warnings };
}
