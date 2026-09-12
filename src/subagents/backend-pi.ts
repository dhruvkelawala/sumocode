import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SubagentEvent } from "./domain.js";
import { safeValuePreview } from "../activity/domain.js";
import {
	BoundedUtf8Head,
	BoundedUtf8Tail,
	CHILD_RETAINED_RESULT_MAX_BYTES,
	JsonLineDecoder,
	TRUNCATED_HEAD_MARKER,
	boundRetainedResult,
	boundStableIdentifier,
} from "../child-protocol.js";
import { resolveExecutableProvenance } from "../executable-provenance.js";
import { type BuiltInToolName, resolveTaskConfig } from "./task-config.js";
import { isRecord, type TaskThinking, type ThinkingLevel } from "./task-params.js";
import { systemProcessTree, terminateProcessTree, type ProcessTreeOperations, type ProcessTreeIdentity, type ProcessTreeVerification, type ProcessTreeMemberAnchor } from "../background-tasks/process-tree.js";
import { CHILD_MODEL_ID_ENV, CHILD_MODEL_PROVIDER_ENV } from "./pi-child-model-bootstrap.js";
import type { RetainedBootstrapDescriptor } from "./retained-bootstrap.js";
import { RetainedAnchor } from "./retained-anchor.js";
import { RETAINED_BOOTSTRAP_ENV, assertNoFactoryReceipt, createBootstrapBinding, readBoundBootstrap, waitForFactoryReceipt } from "./retained-bootstrap-receipt.js";

/** Runtime string discriminator for decoded child-process payloads. */
const isString = <T>(value: T): value is T & string => typeof value === "string";

/** Fallback only — callers should thread the parent's active tool set through. */
// SAFETY: every entry is a literal from the BuiltInToolName union.
const DEFAULT_BUILT_IN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const satisfies readonly BuiltInToolName[];
const PREVIEW_MAX = 160;
const TOOL_IDENTIFIER_MAX_BYTES = 256;
const ERROR_MAX = 4096;

const boundedToolIdentifier = <T>(value: T, fallback = "tool"): string => {
	const identifier = isString(value) && value ? value : fallback;
	return boundStableIdentifier(identifier, TOOL_IDENTIFIER_MAX_BYTES);
};

const CLAUDE_OAUTH_ADAPTER_PACKAGE = "pi-claude-oauth-adapter";
const MULTI_ACCOUNT_ADAPTER_SOURCE = "git:github.com/dhruvkelawala/pi-claude-oauth-adapter@multi-account";
const NUMBERED_ANTHROPIC_PROVIDER = /^anthropic-\d+$/;

function adapterEntryFromPackageDir(packageDir: string): string | undefined {
	try {
		// SAFETY: malformed manifests reject into the catch below; only the optional extensions list is read.
		const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { pi?: { extensions?: unknown } };
		const entries = manifest.pi?.extensions;
		const first = Array.isArray(entries) ? entries[0] : undefined;
		if (!isString(first)) return undefined;
		const entryPath = join(packageDir, first);
		return existsSync(entryPath) ? entryPath : undefined;
	} catch {
		return undefined;
	}
}

/** Map a Pi `git:` package source to its managed global checkout. */
function gitPackageDir(source: string, agentDir: string): string | undefined {
	if (!source.startsWith("git:")) return undefined;
	const spec = source.slice("git:".length);
	let host: string;
	let repoPath: string;
	if (spec.startsWith("git@")) {
		const separator = spec.indexOf(":");
		if (separator < 0) return undefined;
		host = spec.slice("git@".length, separator);
		repoPath = spec.slice(separator + 1);
	} else {
		const separator = spec.indexOf("/");
		if (separator < 0) return undefined;
		host = spec.slice(0, separator);
		repoPath = spec.slice(separator + 1);
	}
	// Pi checkout identity excludes the pinned ref. Refs may themselves contain
	// slashes, so split on the final @ after host parsing rather than by segment.
	const refSeparator = repoPath.lastIndexOf("@");
	if (refSeparator >= 0) repoPath = repoPath.slice(0, refSeparator);
	if (repoPath.endsWith(".git")) repoPath = repoPath.slice(0, -".git".length);
	const segments = repoPath.split("/").filter(Boolean);
	if (!host || host === "." || host === ".." || host.includes("\\") || segments.length < 2 || segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\"))) return undefined;
	return join(agentDir, "git", host, ...segments);
}

/** Trusted global package directories from settings that look like the adapter. */
function adapterPackageDirsFromSettings(settingsPath: string, agentDir: string): string[] {
	try {
		// SAFETY: malformed settings files reject into the catch below.
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { packages?: unknown };
		if (!Array.isArray(settings.packages)) return [];
		// SAFETY: package entries may be plain strings or { source } objects.
		const sources = settings.packages
			.map((entry) => isString(entry) ? entry : (entry as { source?: unknown })?.source)
			.filter((source): source is string => isString(source) && source.includes(CLAUDE_OAUTH_ADAPTER_PACKAGE))
			// The numbered-provider fork must win over stale upstream/configured
			// variants that share the same package name.
			.sort((left, right) => Number(right.trim() === MULTI_ACCOUNT_ADAPTER_SOURCE) - Number(left.trim() === MULTI_ACCOUNT_ADAPTER_SOURCE));
		return sources.flatMap((source) => {
			const gitDir = gitPackageDir(source, agentDir);
			if (gitDir) return [gitDir];
			if (source.startsWith("npm:") || source.startsWith("http")) return [];
			if (source.startsWith("~/")) return [join(homedir(), source.slice(2))];
			// Pi resolves relative package sources against the settings file's
			// directory, not the process cwd — mirror that.
			return [isAbsolute(source) ? source : resolve(dirname(settingsPath), source)];
		});
	} catch {
		return [];
	}
}

/**
 * Children spawn with --no-extensions, which also drops the user's
 * pi-claude-oauth-adapter — the extension that shapes Anthropic OAuth
 * (subscription) requests. Without it, anthropic-provider children fail with
 * misleading 400s (observed live: "You're out of extra usage" while the same
 * model+auth works with the adapter loaded). Re-inject JUST that extension via
 * an explicit `-e <entry>` when the package can be located.
 *
 * Pi documents multiple package sources (npm cache, project-local installs,
 * local checkout paths). Resolution probes TRUSTED-SCOPE candidates only:
 *   1. SUMOCODE_CLAUDE_OAUTH_ADAPTER env — explicit entry file or package dir
 *   2. global agent-dir cache: <agentDir>/npm/node_modules/<pkg>
 *   3. Pi-managed git checkouts named in the GLOBAL settings packages
 *   4. local-checkout path sources named in the GLOBAL settings packages
 * Project-scoped candidates (<cwd>/.pi/...) are deliberately EXCLUDED: a
 * hostile repository could name arbitrary repo-controlled code as the adapter
 * and have children boot-load it via -e, softening the --no-extensions
 * boundary. Repos that legitimately install the adapter project-locally use
 * the env override. Best-effort: nothing found → no flag.
 */
export function resolveClaudeOauthAdapterEntry(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const override = env.SUMOCODE_CLAUDE_OAUTH_ADAPTER;
	if (override) {
		// Probe the filesystem instead of sniffing extensions: a FILE is the
		// entry itself (any .ts/.js/.mjs/.cjs variant); a DIRECTORY is a
		// package dir whose manifest names the entry. Missing → no flag.
		try {
			const stat = statSync(override);
			if (stat.isFile()) return override;
			if (stat.isDirectory()) return adapterEntryFromPackageDir(override);
		} catch {
			// fall through
		}
		return undefined;
	}
	const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const candidateDirs = [
		// Configured sources reflect the active package choice and must precede a
		// stale npm cache left behind after switching to the multi-account fork.
		...adapterPackageDirsFromSettings(join(agentDir, "settings.json"), agentDir),
		join(agentDir, "npm", "node_modules", CLAUDE_OAUTH_ADAPTER_PACKAGE),
	];
	for (const dir of candidateDirs) {
		const entry = adapterEntryFromPackageDir(dir);
		if (entry) return entry;
	}
	return undefined;
}

export interface SpawnedChild {
	/** In-process retained owner registration; its parser must not be subscribed again. */
	readonly retained?: Omit<import("./retained-adoption.js").RetainedSubagent, "snapshot">;
	readonly retentionUnsupported?: true;
	readonly events: AsyncIterable<SubagentEvent> | ((emit: (e: SubagentEvent) => void) => void);
	readonly sessionFilePath?: string;
	readonly ready?: Promise<void>;
	interrupt(beforeEffect?: () => void): void | Promise<void>;
	/**
	 * Publish steering text to a running child's control channel and wait for the
	 * child watcher to consume it and synchronously submit it to Pi. Rejects when
	 * unsupported, unconfirmed, or the child settles first; Pi exposes no
	 * post-acceptance acknowledgement, so this never proves model-turn delivery.
	 */
	send?(text: string, beforeEffect?: () => void): Promise<void>;
	/** Ask the child to persist its response and shut down gracefully. */
	requestClose?(beforeEffect?: () => void): void;
}

/** Persistence-owner fences, NOT authorization for user control requests.
 * A refusal holds the pipe and permanently stops local effects, not the child. */
export interface HeadlessLaunchGate {
	beforeSpawn(): string | void;
	beforePrompt(pid: number): void;
	beforeStdin(pid: number): void;
	beforeSignal(pid: number): { readonly identity: ProcessTreeIdentity; readonly verification: ProcessTreeVerification };
	onRefused(): void;
}

type SpawnLike = typeof nodeSpawn;

interface Message {
	role: "assistant" | "user" | "toolResult";
	content?: unknown;
	text?: unknown;
	usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } };
	stopReason?: unknown;
	errorMessage?: unknown;
}

const sanitizePreview = <T>(value: T, max = PREVIEW_MAX): string | undefined => {
	if (value === undefined) return undefined;
	let text: string;
	if (isString(value)) text = value;
	else {
		try {
			text = JSON.stringify(value);
		} catch {
			text = String(value);
		}
	}
	// oxlint-disable-next-line no-control-regex -- intentional ESC byte match to strip ANSI escape sequences
	const flattened = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\t\r\n]+/g, " ").trim();
	return flattened.length > max ? `${flattened.slice(0, max - 1)}…` : flattened;
};

const safeToolArgumentsPreview = <T>(value: T): string | undefined => {
	if (value === undefined) return undefined;
	const preview = safeValuePreview(value, {
		maxChars: PREVIEW_MAX,
		maxDepth: 4,
		maxEntries: 16,
		maxStringChars: PREVIEW_MAX,
	});
	return preview.replace(/[\t\r\n]+/g, " ").trim();
};

const stringifyToolOutput = <T>(value: T): string | undefined => {
	if (value === undefined) return undefined;
	if (isString(value)) return value;
	if (isRecord(value)) {
		const content = value.content;
		if (Array.isArray(content)) {
			const text = content
				.map((part) => isRecord(part) && part.type === "text" && isString(part.text) ? part.text : undefined)
				.filter((part): part is string => part !== undefined)
				.join("\n");
			if (text.trim().length > 0) return text;
		}
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

/** Decoded JSON object from a child-process output line; fields are validated at each read site. */
interface ParsedJsonLine {
	[key: string]: string | number | boolean | null | ParsedJsonLine | readonly ParsedJsonLine[] | undefined;
}

const parseJsonLine = (line: string): ParsedJsonLine | undefined => {
	if (!line.trim()) return undefined;
	try {
		const decoded: unknown = JSON.parse(line);
		if (!isRecord(decoded)) return undefined;
		// SAFETY: isRecord verified an object payload; per-field checks happen where each field is read.
		return decoded as ParsedJsonLine;
	} catch {
		return undefined;
	}
};

const isMessage = <T>(value: T): value is T & Message => {
	return isRecord(value) && (value.role === "assistant" || value.role === "user" || value.role === "toolResult");
};

const messageText = (message: Message): string => {
	if (isString(message.text)) return message.text;
	if (isString(message.content)) return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.map((part) => isRecord(part) && isString(part.text) ? part.text : "")
			.join("");
	}
	return "";
};

interface RetainedMessageText {
	readonly text: string;
	readonly replacesRetainedText?: true;
}

/** Owns all human-readable event text emitted for one Pi child run. */
class PiRunPayloadBudget {
	private retainedBytes = 0;
	private liveBytes = 0;
	private markerRetained = false;
	private retainedFull = false;
	private liveMarker = false;
	private liveTruncated = false;
	private omissionBehindLive = false;
	private readonly markerBytes = Buffer.byteLength(TRUNCATED_HEAD_MARKER, "utf8");

	public appendLive(delta: string): string {
		if (delta.length === 0 || this.retainedFull || this.liveTruncated) return "";
		const deltaBytes = Buffer.byteLength(delta, "utf8");
		const markerReserve = this.markerRetained || this.liveMarker ? 0 : this.markerBytes;
		const contentBytesLeft = CHILD_RETAINED_RESULT_MAX_BYTES - markerReserve - this.retainedBytes - this.liveBytes;
		if (deltaBytes <= contentBytesLeft) {
			this.liveBytes += deltaBytes;
			return delta;
		}
		const retained = this.markerRetained
			? this.unmarkedHead(delta, Math.max(0, contentBytesLeft))
			: this.markedHead(delta, Math.max(0, contentBytesLeft));
		this.liveBytes += Buffer.byteLength(retained, "utf8");
		this.liveMarker = !this.markerRetained;
		this.liveTruncated = true;
		return retained;
	}

	public retainMessage(role: Message["role"], text: string): RetainedMessageText {
		let replacesRetainedText = false;
		let requiresMarker = false;
		const textBytes = Buffer.byteLength(text, "utf8");
		// SubagentManager replaces liveText only at the corresponding completed
		// assistant message, so reclaim those provisional bytes at that boundary.
		if (role === "assistant") {
			const liveOmitted = this.liveTruncated || this.omissionBehindLive;
			this.liveBytes = 0;
			this.liveMarker = false;
			this.liveTruncated = false;
			this.omissionBehindLive = false;
			// Any prior omission belongs on the newest real assistant answer. Reclaim
			// earlier readable text so the marker and remaining cap move together.
			const markerReserve = this.markerRetained ? 0 : this.markerBytes;
			if (text.length > 0 && (
				this.markerRetained ||
				liveOmitted ||
				this.retainedFull ||
				textBytes > CHILD_RETAINED_RESULT_MAX_BYTES - markerReserve - this.retainedBytes
			)) {
				this.retainedBytes = 0;
				this.markerRetained = false;
				this.retainedFull = false;
				replacesRetainedText = true;
				requiresMarker = true;
			}
		}
		if (text.length === 0) return { text: "" };
		if (this.retainedFull) return { text: "" };
		if (this.liveTruncated) {
			this.omissionBehindLive = text.length > 0;
			return { text: "" };
		}
		if (requiresMarker && !this.markerRetained) {
			const contentBytesLeft = CHILD_RETAINED_RESULT_MAX_BYTES - this.markerBytes - this.retainedBytes - this.liveBytes;
			const retained = this.markedHead(text, Math.max(0, contentBytesLeft));
			this.retainedBytes += Buffer.byteLength(retained, "utf8");
			this.markerRetained = true;
			this.retainedFull = textBytes > contentBytesLeft;
			return replacesRetainedText ? { text: retained, replacesRetainedText: true } : { text: retained };
		}
		const markerReserve = this.markerRetained ? 0 : this.markerBytes;
		const contentBytesLeft = CHILD_RETAINED_RESULT_MAX_BYTES - markerReserve - this.retainedBytes - this.liveBytes;
		let retained: string;
		if (textBytes <= contentBytesLeft) {
			retained = text;
		} else {
			retained = this.markerRetained
				? this.unmarkedHead(text, Math.max(0, contentBytesLeft))
				: this.markedHead(text, Math.max(0, contentBytesLeft));
			this.markerRetained = true;
			this.retainedFull = true;
		}
		this.retainedBytes += Buffer.byteLength(retained, "utf8");
		return replacesRetainedText ? { text: retained, replacesRetainedText: true } : { text: retained };
	}

	private markedHead(text: string, contentBytes: number): string {
		const head = new BoundedUtf8Head(contentBytes + this.markerBytes);
		head.append(text);
		return head.append(TRUNCATED_HEAD_MARKER);
	}

	private unmarkedHead(text: string, contentBytes: number): string {
		return this.markedHead(text, contentBytes).slice(0, -TRUNCATED_HEAD_MARKER.length);
	}
}

const mapPiEvent = (event: ParsedJsonLine): SubagentEvent[] => {
	const typeText = isString(event.type) ? event.type : "";
	if (typeText === "message_update") {
		const assistantEvent = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
		if (assistantEvent?.type === "text_delta" && isString(assistantEvent.delta)) {
			return [{ kind: "assistant-delta", delta: assistantEvent.delta }];
		}
		if ((assistantEvent?.type === "thinking_delta" || assistantEvent?.type === "toolcall_delta")
			&& isString(assistantEvent.delta) && assistantEvent.delta.length > 0) return [{ kind: "progress" }];
	}
	if (typeText === "tool_execution_start") {
		return [{
			kind: "tool-start",
			toolId: boundedToolIdentifier(event.toolCallId, boundedToolIdentifier(event.toolName)),
			name: boundedToolIdentifier(event.toolName),
			argsPreview: safeToolArgumentsPreview(event.args),
		}];
	}
	if (typeText === "tool_execution_update") {
		return [{
			kind: "tool-update",
			toolId: boundedToolIdentifier(event.toolCallId, boundedToolIdentifier(event.toolName)),
			outputPreview: sanitizePreview(stringifyToolOutput(event.partialResult)),
		}];
	}
	if (typeText === "tool_execution_end") {
		return [{
			kind: "tool-end",
			toolId: boundedToolIdentifier(event.toolCallId, boundedToolIdentifier(event.toolName)),
			name: boundedToolIdentifier(event.toolName),
			isError: event.isError === true,
			outputPreview: sanitizePreview(stringifyToolOutput(event.result)),
		}];
	}
	const messageValue = event.message;
	if ((typeText === "message_end" || typeText === "tool_result_end") && isMessage(messageValue)) {
		const events: SubagentEvent[] = [{ kind: "message-end", role: messageValue.role, text: messageText(messageValue) }];
		if (messageValue.role === "assistant") {
			events.push({
				kind: "usage",
				// Per-message provider usage, not the model's context-window capacity.
				// The manager separately sums reports for warning-only run budgets.
				tokens: messageValue.usage?.totalTokens,
				costUsd: messageValue.usage?.cost?.total,
			});
		}
		return events;
	}
	return [];
};

/**
 * A pid is owned only when it is a positive number: `process.kill(-0)` targets
 * the caller's process group and a negative pid targets arbitrary processes
 * rather than this child.
 */
const isOwnedPid = <T>(value: T): value is T & number => typeof value === "number" && value > 0;

/**
 * Signal the child's whole PROCESS GROUP on POSIX (negative pid), falling back
 * to the single pid. Signalling only the `pi` pid leaves tool grandchildren
 * (e.g. a long-running command under the child's bash tool) alive and mutating
 * files after a cancel — the same reason background-tasks' task-manager uses
 * `signalProcessOrGroup`. Requires the child to be spawned `detached` so it
 * leads its own group.
 */
const signalGroup = (proc: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void => {
	// A handle without an owned pid has no child to signal (spawn failed, has
	// not completed, or carries a zero/negative pid).
	if (!isOwnedPid(proc.pid)) return;
	if (process.platform !== "win32") {
		try {
			process.kill(-proc.pid, signal);
			return;
		} catch {
			// group gone or not a leader — fall through to single-pid kill
		}
	}
	try {
		proc.kill(signal);
	} catch {
		// process already gone
	}
};

interface AbortState {
	isAborted: () => boolean;
	interrupt: () => void;
	terminate: () => void;
	dispose: () => void;
	finished?: () => Promise<void> | undefined;
}

const attachAbortSignal = (proc: ChildProcessWithoutNullStreams, signal: AbortSignal | undefined): AbortState => {
	let aborted = false;
	let exited = false;
	let forceKill: ReturnType<typeof setTimeout> | undefined;
	const onClose = () => {
		exited = true;
		if (forceKill) clearTimeout(forceKill);
		forceKill = undefined;
	};
	proc.once("close", onClose);
	const terminate = () => {
		// Without an owned positive pid there is no
		// signal to send and no escalation to schedule.
		if (exited || forceKill || !isOwnedPid(proc.pid)) return;
		signalGroup(proc, "SIGTERM");
		forceKill = setTimeout(() => {
			if (!exited) signalGroup(proc, "SIGKILL");
		}, 5000);
		forceKill.unref?.();
	};
	const interrupt = () => {
		aborted = true;
		terminate();
	};
	if (signal?.aborted) interrupt();
	else signal?.addEventListener("abort", interrupt, { once: true });
	return {
		isAborted: () => aborted,
		interrupt,
		terminate,
		dispose: () => {
			signal?.removeEventListener("abort", interrupt);
			proc.removeListener("close", onClose);
			if (forceKill) clearTimeout(forceKill);
			forceKill = undefined;
		},
	};
};

// The shared signalTree performs more OS probes after its caller's fence (and
// Windows can await several taskkills). For retained POSIX work, verification
// stays in terminateProcessTree + the gate; this last operation is one signal.
export const retainedProcessTree: ProcessTreeOperations = {
	...systemProcessTree,
	async signalTree(identity, signal) {
		try {
			if (identity.processGroupId <= 1 || identity.processGroupId !== identity.pid) throw new Error("unsafe retained process group");
			process.kill(-identity.processGroupId, signal);
			return { ok: true, gone: false };
		} catch {
			return { ok: false, gone: false, error: "retained signal refused" };
		}
	},
};

function attachRetainedAbortSignal(
	proc: ChildProcessWithoutNullStreams,
	signal: AbortSignal | undefined,
	beforeSignal: HeadlessLaunchGate["beforeSignal"],
	operations: ProcessTreeOperations,
	refuse: (error: Error) => void,
	anchor: RetainedAnchor,
): AbortState {
	let aborted = false;
	let exited = false;
	let termination: Promise<void> | undefined;
	const onClose = (): void => { exited = true; };
	proc.once("close", onClose);
	const terminate = (): void => {
		if (exited || termination) return;
		termination = (async () => {
			if (proc.pid === undefined) throw new Error("retained child pid unavailable");
			const pid = proc.pid;
			const tree = beforeSignal(pid);
			// Preserve the original anchors: terminateProcessTree normally recaptures.
			const fenced: ProcessTreeOperations = {
				...operations,
				captureTreeVerification: () => tree.verification,
				signalTree: (identity, signal, verification) => {
					if (exited) throw new Error("retained child closed before tree cleanup finished");
					beforeSignal(pid);
					anchor.beforeSignal(signal);
					return operations.signalTree(identity, signal, verification);
				},
			};
			if (!await terminateProcessTree(fenced, tree.identity, { termGraceMs: 5000, killGraceMs: 1000 })) {
				throw new Error("retained cleanup could not be verified");
			}
			// An escaped descendant can retain a pipe after the owned group is
			// empty. Bound drainage; never signal its new, unowned group.
			if (!exited) await new Promise<void>((resolve, reject) => {
				const closed = (): void => { clearTimeout(timer); resolve(); };
				const timer = setTimeout(() => {
					proc.removeListener("close", closed);
					reject(new Error("retained pipes did not close after cleanup"));
				}, 1000);
				timer.unref?.();
				proc.once("close", closed);
			});
		})().catch((error) => {
			refuse(error instanceof Error ? error : new Error("retained cleanup refused"));
		});
	};
	const interrupt = (): void => { aborted = true; terminate(); };
	if (signal?.aborted) interrupt();
	else signal?.addEventListener("abort", interrupt, { once: true });
	return {
		isAborted: () => aborted, interrupt, terminate,
		finished: () => termination,
		dispose: () => {
			exited = true;
			signal?.removeEventListener("abort", interrupt);
			proc.removeListener("close", onClose);
		},
	};
}

export function resolvePiBinary(env: NodeJS.ProcessEnv = process.env): string {
	return resolveExecutableProvenance({ env }).pi;
}

export function resolvePiChildModelBootstrapEntry(
	env: NodeJS.ProcessEnv = process.env,
	moduleUrl: string = import.meta.url,
): string | undefined {
	const override = env.SUMOCODE_CHILD_MODEL_BOOTSTRAP?.trim();
	const moduleDir = dirname(fileURLToPath(moduleUrl));
	const candidates = [
		override,
		env.SUMOCODE_ROOT_DIR ? join(env.SUMOCODE_ROOT_DIR, "src", "subagents", "pi-child-model-bootstrap.ts") : undefined,
		join(moduleDir, "pi-child-model-bootstrap.ts"),
		// A generated extension bundle lives at dist/extension/*.mjs while this
		// child-only entry remains executable TypeScript under src/subagents.
		resolve(moduleDir, "..", "..", "src", "subagents", "pi-child-model-bootstrap.ts"),
	];
	return candidates.find((candidate): candidate is string => !!candidate && existsSync(candidate));
}

function childModelSelection(modelLabel: string | undefined): { provider: string; modelId: string } | undefined {
	if (!modelLabel) return undefined;
	const separator = modelLabel.indexOf("/");
	if (separator <= 0) return undefined;
	const provider = modelLabel.slice(0, separator);
	const modelId = modelLabel.slice(separator + 1);
	return NUMBERED_ANTHROPIC_PROVIDER.test(provider) && modelId ? { provider, modelId } : undefined;
}

function removeCliModelSelection(args: readonly string[]): string[] {
	const result: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === "--provider" || args[index] === "--model") {
			index += 1;
			continue;
		}
		result.push(args[index] ?? "");
	}
	return result;
}

function retainedSourceHook(binary: string): string {
	// Only physical source checkouts and Node Pi scripts are supported. Bun's
	// virtual source paths are not assets that a separately spawned Pi can read.
	const entry = fileURLToPath(new URL("./retained-system-prompt.ts", import.meta.url));
	try {
		const stat = lstatSync(entry);
		if (!import.meta.url.endsWith("/src/subagents/backend-pi.ts") || realpathSync(entry) !== entry
			|| !stat.isFile() || (stat.mode & 0o022) !== 0) throw new Error("unsupported");
		const fd = openSync(binary, "r");
		try {
			const header = Buffer.alloc(128);
			const size = readSync(fd, header, 0, header.length, 0);
			if (!/^#!(?:\/usr\/bin\/env node|\/[^\n ]*\/node)\r?\n/u.test(header.subarray(0, size).toString("utf8"))) throw new Error("unsupported");
		} finally { closeSync(fd); }
		return entry;
	} catch { throw new Error("retained native unsupported; physical source hook and Node Pi script required"); }
}

export const createPiChildSpawner = (
	spawnImpl: SpawnLike = nodeSpawn,
	resolveAdapterEntry: () => string | undefined = resolveClaudeOauthAdapterEntry,
	resolveBinary: () => string = resolvePiBinary,
	resolveBootstrapEntry: () => string | undefined = resolvePiChildModelBootstrapEntry,
	operations: ProcessTreeOperations = retainedProcessTree,
) => (options: {
	prompt: string;
	cwd: string;
	model?: string;
	thinking?: string;
	inherited: { model?: { provider: string; id: string }; thinking?: string };
	builtInTools?: readonly BuiltInToolName[];
	appendSystemPrompt?: string;
	signal?: AbortSignal;
	launchGate?: HeadlessLaunchGate;
	retainedBootstrap?: RetainedBootstrapDescriptor;
	/** Fresh children persist here; continuations instead append to resumeSessionFile. */
	sessionDir?: string;
	resumeSessionFile?: string;
}): SpawnedChild => {
	const config = resolveTaskConfig({
		// SAFETY: options.thinking comes from the typed SpawnSubagentTask.thinking field.
		item: { model: options.model, thinking: options.thinking as TaskThinking | undefined },
		defaultModel: undefined,
		defaultThinking: "inherit",
		// SAFETY: inherited thinking strings are validated by resolveTaskConfig below.
		inheritedThinking: (options.inherited.thinking ?? "low") as ThinkingLevel,
		ctxModel: options.inherited.model,
		// Children inherit the PARENT's active built-in tool set so a narrowed
		// parent session cannot spawn children with broader tool access.
		//
		// TRUST MODEL (conscious, documented): children
		// run --no-extensions, so SumoCode's approval gate is NOT installed in
		// them. A headless child has no UI to prompt anyway; a child-side gate
		// would hang or fail-closed all bash including legitimate worktree git
		// work. The model-facing guidelines warn against delegating destructive
		// commands; a non-interactive child-side deny-list is a possible future
		// opt-in, tracked in plan 065's maintenance notes.
		builtInTools: [...(options.builtInTools ?? DEFAULT_BUILT_IN_TOOLS)],
	});
	if (!config.ok) {
		return {
			events: (emit) => emit({ kind: "run-settled", outcome: { kind: "failed", errorText: config.error } }),
			interrupt: () => undefined,
		};
	}

	let markReady = (): void => undefined;
	let refuseReady = (_error: Error): void => undefined;
	const ready = options.launchGate ? new Promise<void>((resolve, reject) => {
		markReady = resolve;
		refuseReady = reject;
	}) : undefined;
	// The owner may attach its ready waiter after subscribing to events.
	void ready?.catch(() => undefined);
	let subscribed = false;
	let interrupt: () => void = () => undefined;
	const events = (emit: (event: SubagentEvent) => void): void => {
		if (options.launchGate && subscribed) throw new Error("retained backend already subscribed");
		subscribed = true;
		emit({ kind: "run-started" });
		if (options.retainedBootstrap && !options.launchGate) throw new Error("retained bootstrap requires launch gate");
		if (options.launchGate && options.appendSystemPrompt !== undefined) throw new Error("retained system prompt requires private bootstrap, not appendSystemPrompt");
		const binding = options.retainedBootstrap ? createBootstrapBinding(options.retainedBootstrap) : undefined;
		const adapterEntry = options.retainedBootstrap ? options.retainedBootstrap.config.adapterEntry ?? undefined : resolveAdapterEntry();
		const childModel = childModelSelection(config.modelLabel);
		const bootstrapEntry = options.retainedBootstrap ? options.retainedBootstrap.config.modelBootstrapEntry ?? undefined : childModel ? resolveBootstrapEntry() : undefined;
		if (childModel && (!adapterEntry || !bootstrapEntry)) {
			refuseReady(new Error("numbered child startup unavailable"));
			emit({
				kind: "run-settled",
				outcome: { kind: "failed", errorText: `Numbered Claude child startup unavailable: ${!adapterEntry ? "OAuth adapter not found" : "model bootstrap not found"}` },
			});
			return;
		}
		const roleArgs = options.appendSystemPrompt ? ["--append-system-prompt", options.appendSystemPrompt] : [];
		const adapterArgs = adapterEntry ? ["-e", adapterEntry] : [];
		const bootstrapArgs = bootstrapEntry ? ["-e", bootstrapEntry] : [];
		const configuredArgs = childModel ? removeCliModelSelection(config.subprocessArgs) : config.subprocessArgs;
		const sessionDir = options.resumeSessionFile ? dirname(options.resumeSessionFile) : options.sessionDir;
		if (options.resumeSessionFile && !existsSync(options.resumeSessionFile)) throw new Error("resume session file is unavailable");
		if (sessionDir && !options.resumeSessionFile) mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
		const subprocessArgs = sessionDir
			? [...configuredArgs.filter((arg) => arg !== "--no-session"), ...(options.resumeSessionFile ? ["--session", options.resumeSessionFile] : []), "--session-dir", sessionDir]
			: configuredArgs;
		let childEnv = childModel
			? { ...process.env, [CHILD_MODEL_PROVIDER_ENV]: childModel.provider, [CHILD_MODEL_ID_ENV]: childModel.modelId }
			: process.env;
		const binary = resolveBinary();
		if (options.launchGate && !isAbsolute(binary)) throw new Error("retained launch requires absolute Pi provenance");
		const hookArgs: string[] = [];
		if (binding) {
			const data = readBoundBootstrap(binding);
			const expected = data.descriptor.config;
			if (options.cwd !== expected.cwd || binary !== expected.pi || options.prompt !== data.prompt
				|| config.modelLabel !== expected.model.label || config.thinkingLevel !== expected.thinking
				|| JSON.stringify(options.builtInTools ?? DEFAULT_BUILT_IN_TOOLS) !== JSON.stringify(expected.builtInTools)
				|| Boolean(childModel) !== Boolean(bootstrapEntry)) throw new Error("retained bootstrap options mismatch");
			hookArgs.push("-e", retainedSourceHook(binary));
			assertNoFactoryReceipt(binding);
			childEnv = { ...childEnv, [RETAINED_BOOTSTRAP_ENV]: JSON.stringify(binding) };
		}
		// Windows verified force cleanup may issue multiple asynchronous taskkills
		// inside one operation; that API cannot fence each effect. Do not launch
		// retained work there until a per-taskkill seam exists. Ungated is unchanged.
		if (options.launchGate && process.platform === "win32") throw new Error("retained headless requires POSIX signal fencing");
		const anchorNonce = options.launchGate?.beforeSpawn();
		const args = [...subprocessArgs, ...roleArgs, ...adapterArgs, ...bootstrapArgs, ...hookArgs];
		let piExit: { code: number | null; signal: string | null } | undefined;
		let piChild: ProcessTreeMemberAnchor | undefined;
		const anchor = options.launchGate ? new RetainedAnchor(spawnImpl, binary, args, { cwd: options.cwd, env: childEnv, nonce: anchorNonce || undefined }, {
			started: (child) => { piChild = child; waitForFactory(child); },
			exited: (code, signal) => {
				piExit = { code, signal };
				receiptWait.abort();
				if (!promptReleased) protocolError = "retained child exited before prompt release";
				// Pi exit does not end the group capability. Reap descendants and the
				// anchor before publishing Pi's outcome, including normal completion.
				abortState.terminate();
			},
			refused: (error) => refuseEffect(error),
		}) : undefined;
		// SAFETY: both launch paths return the original handle and three pipes.
		const proc = anchor?.proc ?? spawnImpl(binary, args, {
			cwd: options.cwd, env: childEnv, shell: false,
			stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
		}) as ChildProcessWithoutNullStreams;
		// The prompt travels on stdin, never argv: pinned Pi print mode reads
		// piped stdin as the initial message (interior multiline/Unicode bytes
		// are exact; Pi itself trims leading/trailing whitespace, same as any
		// `echo | pi -p`), while argv is world-readable process metadata. See
		// issue 391. The error listener keeps a child that dies before draining
		// a >pipe-buffer prompt from turning the pending write into an
		// uncaughtException EPIPE — the child's failure settles through the
		// close/error handlers below.
		proc.stdin.on("error", () => undefined);
		if (!options.launchGate) {
			proc.stdin.write(options.prompt);
			proc.stdin.end();
		}
		let authorityLost = false;
		let childClosed = false;
		let promptReleased = false;
		const receiptWait = new AbortController();
		let readinessTimer: ReturnType<typeof setTimeout> | undefined;
		const refuseEffect = (error: Error): void => {
			if (authorityLost) return;
			authorityLost = true;
			receiptWait.abort();
			clearTimeout(readinessTimer);
			refuseReady(error);
			try { options.launchGate?.onRefused(); }
			catch { /* Local authority remains lost even if the owner cannot persist it. */ }
		};
		const abortState = options.launchGate
			? attachRetainedAbortSignal(proc, options.signal, (pid) => {
				if (authorityLost) throw new Error("retained authority lost");
				try { anchor!.assertLive(); return options.launchGate!.beforeSignal(pid); }
				catch (error) {
					refuseEffect(error instanceof Error ? error : new Error("retained signal refused"));
					throw error;
				}
			}, operations, refuseEffect, anchor!)
			: attachAbortSignal(proc, options.signal);
		interrupt = () => {
			if (!authorityLost) { receiptWait.abort(); abortState.interrupt(); }
		};
		const stderr = new BoundedUtf8Tail();
		const payloadBudget = new PiRunPayloadBudget();
		let finalAssistantText = "";
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		let protocolError: string | undefined;
		let settled = false;
		const settle = (outcome: Extract<SubagentEvent, { kind: "run-settled" }>["outcome"]): void => {
			if (settled || authorityLost) return;
			settled = true;
			clearTimeout(readinessTimer);
			refuseReady(new Error("child settled before prompt release"));
			if (sessionDir) {
				try {
					if (options.resumeSessionFile && existsSync(options.resumeSessionFile)) {
						emit({ kind: "session-located", sessionFilePath: options.resumeSessionFile });
					} else {
						const sessions = readdirSync(sessionDir, { recursive: true, encoding: "utf8" }).filter((entry) => entry.endsWith(".jsonl"));
						if (sessions.length === 1) emit({ kind: "session-located", sessionFilePath: join(sessionDir, sessions[0]!) });
					}
				} catch { /* Session discovery is optional evidence; settlement must still publish. */ }
			}
			emit({ kind: "run-settled", outcome });
		};
		const processLine = (line: string) => {
			if (settled || authorityLost) return;
			const parsed = parseJsonLine(line);
			if (!parsed) return;
			for (const event of mapPiEvent(parsed)) {
				if (event.kind === "assistant-delta") {
					const delta = payloadBudget.appendLive(event.delta);
					if (delta) emit({ ...event, delta });
					else if (event.delta.length > 0) emit({ kind: "progress" });
					continue;
				}
				if (event.kind === "message-end") {
					const retained = { ...event, ...payloadBudget.retainMessage(event.role, event.text) };
					if (retained.role === "assistant") finalAssistantText = retained.text;
					emit(retained);
					continue;
				}
				emit(event);
			}
			const messageValue = parsed.message;
			if (isMessage(messageValue) && messageValue.role === "assistant") {
				if (isString(messageValue.stopReason)) stopReason = messageValue.stopReason;
				if (isString(messageValue.errorMessage)) errorMessage = boundRetainedResult(messageValue.errorMessage, ERROR_MAX);
			}
		};
		const stdout = new JsonLineDecoder({
			onLine: processLine,
			onError: (error) => {
				protocolError = error.message;
				receiptWait.abort();
				// TERM starts shutdown; close remains the terminal boundary while the child exists.
				abortState.terminate();
			},
		});
		const onStdout = (data: string | Uint8Array) => stdout.write(data);
		const onStderr = (data: string | Uint8Array) => stderr.append(data);
		const cleanup = () => {
			receiptWait.abort();
			clearTimeout(readinessTimer);
			proc.stdout.removeListener("data", onStdout);
			proc.stderr.removeListener("data", onStderr);
			abortState.dispose();
		};
		proc.stdout.on("data", onStdout);
		proc.stderr.on("data", onStderr);
		proc.once("close", (code, closeSignal) => {
			if (anchor && !abortState.finished?.()) refuseEffect(new Error("retained anchor closed without cleanup"));
			if (piExit) code = piExit.code;
			const exitSignal = piExit ? piExit.signal : closeSignal;
			childClosed = true;
			if (binding && !promptReleased && !protocolError) protocolError = "retained child closed before factory readiness";
			receiptWait.abort();
			clearTimeout(readinessTimer);
			stdout.end();
			const finishClose = (): void => {
				if (protocolError) {
					settle({ kind: "failed", errorText: protocolError, partialText: finalAssistantText || undefined });
				} else if (abortState.isAborted()) {
					settle({ kind: "interrupted", partialText: finalAssistantText || undefined });
				} else if (code === 0 && stopReason !== "error" && stopReason !== "aborted") {
					settle({ kind: "completed", finalText: finalAssistantText });
				} else {
					settle({
						kind: "failed",
						errorText: boundRetainedResult(
							errorMessage || stderr.toString() || (exitSignal ? `pi killed by ${exitSignal}` : `pi exited with code ${code ?? "unknown"}`),
							ERROR_MAX,
						),
						partialText: finalAssistantText || undefined,
					});
				}
				cleanup();
			};
			const pending = abortState.finished?.();
			if (pending) void pending.then(finishClose).catch(refuseEffect);
			else finishClose();
		});
		if (options.launchGate && !authorityLost) {
			readinessTimer = setTimeout(() => {
				refuseReady(new Error("retained readiness timeout"));
				protocolError = "retained readiness timeout";
				receiptWait.abort();
				abortState.terminate();
			}, 10_000);
			readinessTimer.unref?.();
		}
		const beforeStdin = (): void => {
			anchor!.assertLive();
			if (proc.pid === undefined || !piChild || piExit) throw new Error("retained Pi pipe unavailable");
			const tree = options.launchGate!.beforeSignal(proc.pid);
			if (operations.verificationMatches?.(tree.identity, { members: [piChild] }) !== "same") throw new Error("retained Pi left its owned group");
			options.launchGate!.beforeStdin(proc.pid);
		};
		const releasePrompt = (): void => {
			try {
				if (settled || childClosed || authorityLost || protocolError || abortState.isAborted() || proc.pid === undefined) throw new Error("child unavailable before prompt release");
				beforeStdin();
				proc.stdin.write(options.prompt);
				beforeStdin();
				proc.stdin.end();
				promptReleased = true;
				clearTimeout(readinessTimer);
				markReady();
			} catch (error) {
				// Keep the handle/parser and held stdin. Closing stdin or signalling here
				// would create an unfenced effect after authority was refused.
				refuseEffect(error instanceof Error ? error : new Error(String(error)));
			}
		};
		const waitForFactory = (child: ProcessTreeMemberAnchor): void => {
			try {
				if (settled || childClosed || authorityLost || protocolError || abortState.isAborted() || proc.pid === undefined) throw new Error("child unavailable before prompt release");
				if (!binding) { releasePrompt(); return; }
				const signal = options.signal ? AbortSignal.any([receiptWait.signal, options.signal]) : receiptWait.signal;
				void waitForFactoryReceipt(binding, child, signal, () => {
					try { beforeStdin(); }
					catch { refuseEffect(new Error("retained authority lost")); throw new Error("retained authority lost"); }
				}).then(releasePrompt, () => {
					if (settled || childClosed || authorityLost || protocolError || abortState.isAborted()) return;
					protocolError = "retained factory receipt refused";
					clearTimeout(readinessTimer);
					refuseReady(new Error(protocolError));
					abortState.terminate();
				});
			} catch (error) { refuseEffect(error instanceof Error ? error : new Error("retained startup refused")); }
		};
		if (anchor) proc.once("spawn", () => {
			try {
				if (settled || childClosed || authorityLost || protocolError || abortState.isAborted() || proc.pid === undefined) throw new Error("anchor unavailable before release");
				anchor.assertLive();
				options.launchGate!.beforePrompt(proc.pid);
				options.launchGate!.beforeStdin(proc.pid);
				anchor.start();
			} catch (error) { refuseEffect(error instanceof Error ? error : new Error("retained anchor release refused")); }
		});
		proc.once("error", (error) => {
			if (anchor) { refuseEffect(new Error("retained anchor process failed")); return; }
			receiptWait.abort();
			clearTimeout(readinessTimer);
			if (protocolError || abortState.isAborted()) return;
			settle({ kind: "failed", errorText: boundRetainedResult(error.message, ERROR_MAX), partialText: finalAssistantText || undefined });
			cleanup();
		});
	};
	return {
		events: (emit) => {
			try { events(emit); }
			catch (error) {
				refuseReady(error instanceof Error ? error : new Error(String(error)));
				throw error;
			}
		},
		interrupt: () => interrupt(),
		ready,
	};
};

export const spawnPiChild = createPiChildSpawner();
