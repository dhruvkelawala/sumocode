import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { writePrivateJsonExclusive } from "../activity/persistence.js";
import type { ExecutableProvenance } from "../executable-provenance.js";
import { BUILT_IN_TOOLS, type BuiltInToolName } from "../native-task-config.js";
import { VALID_THINKING_LEVELS, type ProviderModel, type ThinkingLevel } from "../native-task-params.js";
import { assertPrivateArtifact, assertPrivateDir, isOwnedByUs, nodeArtifactFs, validatedArtifactStat } from "../private-artifact.js";
import type { AgentPanePlacement } from "../terminal-host/types.js";
import type { SubagentRole } from "./roles.js";
import type { SubagentRecord } from "./registry.js";

/** Fully resolved values only: null means absent, never inherit or reload roles/config. */
export interface RetainedBootstrapConfiguration {
	readonly cwd: string;
	readonly baseRef: string;
	readonly model: Readonly<ProviderModel>;
	readonly thinking: ThinkingLevel;
	readonly builtInTools: readonly BuiltInToolName[];
	readonly role: Pick<SubagentRole, "id" | "label"> | null;
	readonly pi: ExecutableProvenance["pi"];
	readonly adapterEntry: string | null;
	readonly modelBootstrapEntry: string | null;
	readonly visible: {
		readonly name: string;
		readonly placement: AgentPanePlacement;
		readonly launcher: ExecutableProvenance["sumocode"];
	} | null;
}

type BootstrapBinding = Pick<SubagentRecord, "id" | "ownerSessionId" | "taskDir">;
type PromptPointer = { readonly file: string; readonly bytes: number; readonly sha256: string };
export interface RetainedBootstrapDescriptor extends BootstrapBinding {
	readonly schemaVersion: 1;
	readonly nonce: string;
	readonly backend: SubagentRecord["backend"];
	readonly worktree: SubagentRecord["worktree"];
	readonly config: RetainedBootstrapConfiguration;
	readonly prompt: PromptPointer;
	readonly systemPrompt: PromptPointer | null;
}

const MAX_DESCRIPTOR_BYTES = 32 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
// JSON escaping can expand each text byte sixfold; the files contain JSON strings.
const MAX_PROMPT_FILE_BYTES = MAX_TEXT_BYTES * 6 + 3;
const PROMPT_FILE = "bootstrap-prompt.json";
const SYSTEM_FILE = "bootstrap-system-prompt.json";
const FAILURE = "unsafe retained bootstrap";

/**
 * Parent calls AFTER registry.create(unowned starting), BEFORE controller spawn.
 * Publish secrets first, descriptor last, all exclusively. Refusal/crash preserves
 * partial artifacts; never reuse that task directory to retry this preparation.
 * This is data, not writer/control authority and not a Pi CLI invocation.
 */
export function prepareRetainedBootstrap(
	record: SubagentRecord,
	config: RetainedBootstrapConfiguration,
	prompts: { readonly prompt: string; readonly systemPrompt: string | null },
): RetainedBootstrapDescriptor {
	try {
		if (record.schemaVersion !== 2 || record.revision !== 1 || record.status !== "starting"
			|| record.writerLease !== null || record.controlLease !== null || record.controlHead !== 0
			|| record.child !== null || record.supervisor !== null || record.pane !== null
			|| record.result !== null || record.manifest !== null) throw new Error(FAILURE);
		if (!object(prompts, "prompt systemPrompt") || !promptText(prompts.prompt) || prompts.prompt.length === 0
			|| !(prompts.systemPrompt === null || promptText(prompts.systemPrompt))) throw new Error(FAILURE);
		const descriptor = {
			schemaVersion: 1, nonce: randomUUID(), id: record.id, ownerSessionId: record.ownerSessionId,
			taskDir: record.taskDir, backend: record.backend, worktree: structuredClone(record.worktree),
			config: structuredClone(config), prompt: pointer(PROMPT_FILE, prompts.prompt),
			systemPrompt: prompts.systemPrompt === null ? null : pointer(SYSTEM_FILE, prompts.systemPrompt),
		};
		if (!validDescriptor(descriptor) || descriptor.config.role?.id !== (record.roleId ?? undefined)
			|| (record.modelLabel !== null && record.modelLabel !== descriptor.config.model.label)
			|| Buffer.byteLength(serialize(descriptor)) > MAX_DESCRIPTOR_BYTES) throw new Error(FAILURE);
		const directory = assertDirectory(record.taskDir);
		assertConfigurationPaths(descriptor);
		for (const file of ["bootstrap.json", PROMPT_FILE, SYSTEM_FILE]) {
			if (validatedArtifactStat(nodeArtifactFs, join(record.taskDir, file), record.taskDir, "bootstrap artifact")) throw new Error(FAILURE);
		}
		writePrivateJsonExclusive(join(record.taskDir, PROMPT_FILE), prompts.prompt);
		assertDirectory(record.taskDir, directory);
		if (prompts.systemPrompt !== null) writePrivateJsonExclusive(join(record.taskDir, SYSTEM_FILE), prompts.systemPrompt);
		assertDirectory(record.taskDir, directory);
		writePrivateJsonExclusive(join(record.taskDir, "bootstrap.json"), descriptor);
		return readRetainedBootstrap(record, descriptor.nonce).descriptor;
	} catch { throw new Error(FAILURE); }
}

/**
 * Bind to a fresh registry read's immutable tuple and the parent's launch nonce.
 * Public code paths are parent-selected inputs, NOT private data paths; validate
 * them but do not resolve executables or load extensions here. Same-user private
 * persistence is not authentication against a user able to rewrite the files.
 * Returned prompt strings stay private: never log/serialize this return value or
 * put its text in argv/env. These JSON files are not Pi system-prompt file flags.
 */
export function readRetainedBootstrap(expected: BootstrapBinding, nonce: string): {
	readonly descriptor: RetainedBootstrapDescriptor;
	readonly prompt: string;
	readonly systemPrompt: string | null;
} {
	try {
		if (!binding(expected) || !uuid(nonce)) throw new Error(FAILURE);
		const directory = assertDirectory(expected.taskDir);
		const descriptor: unknown = JSON.parse(readArtifact(expected.taskDir, "bootstrap.json", MAX_DESCRIPTOR_BYTES));
		if (!validDescriptor(descriptor) || descriptor.id !== expected.id || descriptor.ownerSessionId !== expected.ownerSessionId
			|| descriptor.taskDir !== expected.taskDir || descriptor.nonce !== nonce) throw new Error(FAILURE);
		assertConfigurationPaths(descriptor);
		if (descriptor.systemPrompt === null && validatedArtifactStat(nodeArtifactFs, join(expected.taskDir, SYSTEM_FILE), expected.taskDir, "bootstrap artifact")) throw new Error(FAILURE);
		const prompt = readPrompt(descriptor.taskDir, descriptor.prompt);
		const systemPrompt = descriptor.systemPrompt === null ? null : readPrompt(descriptor.taskDir, descriptor.systemPrompt);
		if (prompt.length === 0) throw new Error(FAILURE);
		assertDirectory(expected.taskDir, directory);
		return Object.freeze({ descriptor: freeze(descriptor), prompt, systemPrompt });
	} catch { throw new Error(FAILURE); }
}

function serialize(value: RetainedBootstrapDescriptor | string): string { return `${JSON.stringify(value, null, 2)}\n`; }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function pointer(file: string, text: string): PromptPointer {
	const encoded = serialize(text);
	return { file, bytes: Buffer.byteLength(encoded), sha256: hash(encoded) };
}
function readPrompt(taskDir: string, pointer: PromptPointer): string {
	const encoded = readArtifact(taskDir, pointer.file, MAX_PROMPT_FILE_BYTES);
	if (Buffer.byteLength(encoded) !== pointer.bytes || hash(encoded) !== pointer.sha256) throw new Error(FAILURE);
	const text: unknown = JSON.parse(encoded);
	if (!promptText(text)) throw new Error(FAILURE);
	return text;
}

function assertDirectory(path: string, expected?: { dev: number; ino: number }) {
	assertPrivateDir(nodeArtifactFs, path, "bootstrap directory");
	const stat = lstatSync(path);
	if (!pathValue(path) || realpathSync(path) !== path || (stat.mode & 0o7777) !== 0o700
		|| (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino))) throw new Error(FAILURE);
	return stat;
}

// Unlike readPrivateJson, bootstrap decoding must reject malformed UTF-8 and
// cap the actual read even if a file grows after stat. Only three fixed files.
function readArtifact(taskDir: string, file: string, maxBytes: number): string {
	const path = join(taskDir, file);
	assertPrivateArtifact(nodeArtifactFs, path, taskDir, "bootstrap artifact");
	const before = lstatSync(path);
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || !isOwnedByUs(opened) || (opened.mode & 0o7777) !== 0o600
			|| opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes) throw new Error(FAILURE);
		const buffer = Buffer.alloc(maxBytes + 1);
		let size = 0;
		while (size < buffer.length) {
			const count = readSync(fd, buffer, size, buffer.length - size, null);
			if (count === 0) break;
			size += count;
		}
		const after = fstatSync(fd);
		const current = lstatSync(path);
		if (size > maxBytes || size !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
			|| after.ctimeMs !== opened.ctimeMs || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error(FAILURE);
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
	} finally { closeSync(fd); }
}

function assertConfigurationPaths(descriptor: RetainedBootstrapDescriptor): void {
	const { config, taskDir, worktree } = descriptor;
	for (const path of [config.cwd, ...(worktree ? [worktree.path, worktree.repoRoot] : [])]) {
		if (realpathSync(path) !== path || !lstatSync(path).isDirectory()) throw new Error(FAILURE);
	}
	for (const [path, executable] of [[config.pi, true], [config.adapterEntry, false],
		[config.modelBootstrapEntry, false], [config.visible?.launcher ?? null, true]] as const) {
		if (path === null) continue;
		const fromTask = relative(taskDir, path);
		const stat = lstatSync(path);
		if (!(fromTask === ".." || fromTask.startsWith("../") || isAbsolute(fromTask))
			|| realpathSync(path) !== path || !stat.isFile() || (stat.mode & 0o022) !== 0
			|| (executable && (stat.mode & 0o111) === 0)) throw new Error(FAILURE);
	}
}

// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- exact untrusted JSON protocol boundary; no extra metadata or secret text fields are accepted.
function object(value: unknown, required: string, optional = ""): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const keys = Object.keys(value);
	const allowed = new Set([...required.split(" "), ...(optional ? optional.split(" ") : [])]);
	return required.split(" ").every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key));
}
function text(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= 4096
		// oxlint-disable-next-line no-control-regex -- metadata is single-line, bounded, valid Unicode.
		&& Buffer.from(value).toString("utf8") === value && !/[\x00-\x1f\x7f]/u.test(value);
}
function pathValue(value: unknown): value is string { return text(value) && isAbsolute(value) && resolve(value) === value; }
function uuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value); }
function binding(value: BootstrapBinding): boolean {
	return text(value.id) && /^sa-[A-Za-z0-9_-]{1,128}$/u.test(value.id) && text(value.ownerSessionId) && pathValue(value.taskDir);
}
function promptText(value: unknown): value is string {
	return typeof value === "string" && Buffer.byteLength(value) <= MAX_TEXT_BYTES
		&& Buffer.from(value).toString("utf8") === value && !value.includes("\0");
}
function validPointer(value: unknown, file: string): value is PromptPointer {
	return object(value, "file bytes sha256") && value.file === file && typeof value.bytes === "number"
		&& Number.isSafeInteger(value.bytes) && value.bytes >= 3 && value.bytes <= MAX_PROMPT_FILE_BYTES
		&& typeof value.sha256 === "string" && /^[0-9a-f]{64}$/u.test(value.sha256);
}
function placement(value: unknown): boolean {
	if (object(value, "kind workspaceId", "paneId") && value.kind === "workspace") return text(value.workspaceId) && (value.paneId === undefined || text(value.paneId));
	if (object(value, "kind tabId direction") && value.kind === "tab") return text(value.tabId) && (value.direction === "right" || value.direction === "down");
	return object(value, "kind label") && value.kind === "new-tab" && text(value.label);
}
function validDescriptor(value: unknown): value is RetainedBootstrapDescriptor {
	if (!object(value, "schemaVersion nonce id ownerSessionId taskDir backend worktree config prompt systemPrompt")
		|| value.schemaVersion !== 1 || !uuid(value.nonce) || !text(value.id) || !text(value.ownerSessionId) || !pathValue(value.taskDir)
		|| !binding({ id: value.id, ownerSessionId: value.ownerSessionId, taskDir: value.taskDir })
		|| (value.backend !== "headless" && value.backend !== "visible") || !validPointer(value.prompt, PROMPT_FILE)
		|| !(value.systemPrompt === null || validPointer(value.systemPrompt, SYSTEM_FILE))) return false;
	const c = value.config;
	if (!object(c, "cwd baseRef model thinking builtInTools role pi adapterEntry modelBootstrapEntry visible")
		|| !pathValue(c.cwd) || !text(c.baseRef) || !object(c.model, "provider modelId label")
		|| !text(c.model.provider) || !text(c.model.modelId) || c.model.label !== `${c.model.provider}/${c.model.modelId}`
		|| !VALID_THINKING_LEVELS.some((level) => level === c.thinking) || !Array.isArray(c.builtInTools)
		|| c.builtInTools.length > BUILT_IN_TOOLS.length || new Set(c.builtInTools).size !== c.builtInTools.length
		|| !c.builtInTools.every((tool) => BUILT_IN_TOOLS.some((allowed) => allowed === tool))
		|| !(c.role === null || (object(c.role, "id label") && text(c.role.id) && text(c.role.label)))
		|| !pathValue(c.pi) || !(c.adapterEntry === null || pathValue(c.adapterEntry))
		|| !(c.modelBootstrapEntry === null || pathValue(c.modelBootstrapEntry))) return false;
	if (value.backend === "headless" ? c.visible !== null : !(object(c.visible, "name placement launcher")
		&& text(c.visible.name) && placement(c.visible.placement) && pathValue(c.visible.launcher))) return false;
	return value.worktree === null || (object(value.worktree, "path branch baseRef repoRoot")
		&& pathValue(value.worktree.path) && pathValue(value.worktree.repoRoot) && text(value.worktree.branch)
		&& value.worktree.baseRef === c.baseRef && value.worktree.path === c.cwd);
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
// oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type
