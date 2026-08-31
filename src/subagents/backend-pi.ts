import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SubagentEvent } from "./domain.js";
import { safeValuePreview } from "../activity/domain.js";
import { type BuiltInToolName, resolveTaskConfig } from "../native-task-config.js";
import { isRecord, type TaskThinking, type ThinkingLevel } from "../native-task-params.js";
import { CHILD_MODEL_ID_ENV, CHILD_MODEL_PROVIDER_ENV } from "./pi-child-model-bootstrap.js";

/** Runtime string discriminator for decoded child-process payloads. */
const isString = <T>(value: T): value is T & string => typeof value === "string";

/** Fallback only — callers should thread the parent's active tool set through. */
// SAFETY: every entry is a literal from the BuiltInToolName union.
const DEFAULT_BUILT_IN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const satisfies readonly BuiltInToolName[];
const PREVIEW_MAX = 160;
const ERROR_MAX = 4096;

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
	readonly events: AsyncIterable<SubagentEvent> | ((emit: (e: SubagentEvent) => void) => void);
	readonly sessionFilePath?: string;
	readonly ready?: Promise<void>;
	interrupt(): void;
	/** Deliver steering text to a running child. Rejects when unsupported or unconfirmed. */
	send?(text: string): Promise<void>;
	/** Ask the child to persist its response and shut down gracefully. */
	requestClose?(): void;
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

const mapPiEvent = (event: ParsedJsonLine): SubagentEvent[] => {
	const typeText = isString(event.type) ? event.type : "";
	if (typeText === "message_update") {
		const assistantEvent = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
		if (assistantEvent?.type === "text_delta" && isString(assistantEvent.delta)) {
			return [{ kind: "assistant-delta", delta: assistantEvent.delta }];
		}
	}
	if (typeText === "tool_execution_start") {
		return [{
			kind: "tool-start",
			toolId: isString(event.toolCallId) ? event.toolCallId : `${event.toolName ?? "tool"}`,
			name: isString(event.toolName) ? event.toolName : "tool",
			argsPreview: safeToolArgumentsPreview(event.args),
		}];
	}
	if (typeText === "tool_execution_update") {
		return [{
			kind: "tool-update",
			toolId: isString(event.toolCallId) ? event.toolCallId : `${event.toolName ?? "tool"}`,
			outputPreview: sanitizePreview(stringifyToolOutput(event.partialResult)),
		}];
	}
	if (typeText === "tool_execution_end") {
		return [{
			kind: "tool-end",
			toolId: isString(event.toolCallId) ? event.toolCallId : `${event.toolName ?? "tool"}`,
			name: isString(event.toolName) ? event.toolName : "tool",
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
				// totalTokens is the child's cumulative context occupancy; the JSON
				// event stream does not carry the model's context-window capacity,
				// so leave contextWindow unset rather than mislabeling input tokens.
				tokens: messageValue.usage?.totalTokens,
				costUsd: messageValue.usage?.cost?.total,
			});
		}
		return events;
	}
	return [];
};

/**
 * Signal the child's whole PROCESS GROUP on POSIX (negative pid), falling back
 * to the single pid. Signalling only the `pi` pid leaves tool grandchildren
 * (e.g. a long-running command under the child's bash tool) alive and mutating
 * files after a cancel — the same reason background-tasks' task-manager uses
 * `signalProcessOrGroup`. Requires the child to be spawned `detached` so it
 * leads its own group.
 */
const signalGroup = (proc: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void => {
	if (process.platform !== "win32" && proc.pid != null) {
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
}

const attachAbortSignal = (proc: ChildProcessWithoutNullStreams, signal: AbortSignal | undefined): AbortState => {
	let aborted = false;
	// `proc.killed` only means a signal was successfully SENT, not that the
	// process exited — gating SIGKILL on it means a child that ignores SIGTERM
	// is never force-killed. Track real exit via the close event instead.
	let exited = false;
	proc.once("close", () => {
		exited = true;
	});
	const interrupt = () => {
		aborted = true;
		signalGroup(proc, "SIGTERM");
		setTimeout(() => {
			if (!exited) signalGroup(proc, "SIGKILL");
		}, 5000).unref?.();
	};
	if (signal?.aborted) interrupt();
	else signal?.addEventListener("abort", interrupt, { once: true });
	return { isAborted: () => aborted, interrupt };
};

export function resolvePiBinary(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_BIN?.trim() || "pi";
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
		// The committed extension bundle lives at dist/extension/*.mjs while this
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

export const createPiChildSpawner = (
	spawnImpl: SpawnLike = nodeSpawn,
	resolveAdapterEntry: () => string | undefined = resolveClaudeOauthAdapterEntry,
	resolveBinary: () => string = resolvePiBinary,
	resolveBootstrapEntry: () => string | undefined = resolvePiChildModelBootstrapEntry,
) => (options: {
	prompt: string;
	cwd: string;
	model?: string;
	thinking?: string;
	inherited: { model?: { provider: string; id: string }; thinking?: string };
	builtInTools?: readonly BuiltInToolName[];
	appendSystemPrompt?: string;
	signal?: AbortSignal;
}): SpawnedChild => {
	const config = resolveTaskConfig({
		// SAFETY: options.thinking comes from the typed SpawnSubagentTask.thinking field.
		item: { prompt: options.prompt, model: options.model, thinking: options.thinking as TaskThinking | undefined, fork: false },
		defaultModel: undefined,
		defaultThinking: "inherit",
		// SAFETY: inherited thinking strings are validated by resolveTaskConfig below.
		inheritedThinking: (options.inherited.thinking ?? "low") as ThinkingLevel,
		ctxModel: options.inherited.model,
		// Children inherit the PARENT's active built-in tool set (mirroring
		// native-task-tool's getActiveTools threading) so a narrowed parent
		// session cannot spawn children with broader tool access.
		//
		// TRUST MODEL (conscious, documented — parity with native-task): children
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

	let interrupt: () => void = () => undefined;
	const events = (emit: (event: SubagentEvent) => void): void => {
		emit({ kind: "run-started" });
		const adapterEntry = resolveAdapterEntry();
		const childModel = childModelSelection(config.modelLabel);
		const bootstrapEntry = childModel ? resolveBootstrapEntry() : undefined;
		if (childModel && (!adapterEntry || !bootstrapEntry)) {
			emit({
				kind: "run-settled",
				outcome: { kind: "failed", errorText: `Numbered Claude child startup unavailable: ${!adapterEntry ? "OAuth adapter not found" : "model bootstrap not found"}` },
			});
			return;
		}
		const roleArgs = options.appendSystemPrompt ? ["--append-system-prompt", options.appendSystemPrompt] : [];
		const adapterArgs = adapterEntry ? ["-e", adapterEntry] : [];
		const bootstrapArgs = bootstrapEntry ? ["-e", bootstrapEntry] : [];
		const subprocessArgs = childModel ? removeCliModelSelection(config.subprocessArgs) : config.subprocessArgs;
		const childEnv = childModel
			? { ...process.env, [CHILD_MODEL_PROVIDER_ENV]: childModel.provider, [CHILD_MODEL_ID_ENV]: childModel.modelId }
			: process.env;
		// SAFETY: stdio is piped below, so the spawned child always has non-null streams.
		const proc = spawnImpl(resolveBinary(), [...subprocessArgs, ...roleArgs, ...adapterArgs, ...bootstrapArgs, options.prompt], {
			cwd: options.cwd,
			env: childEnv,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			// Own process group on POSIX so interrupt/SIGKILL can signal the
			// whole tree (see signalGroup) instead of just the pi pid.
			detached: process.platform !== "win32",
}) as ChildProcessWithoutNullStreams;
		proc.stdin.end();
		const abortState = attachAbortSignal(proc, options.signal);
		interrupt = abortState.interrupt;
		let stdoutBuffer = "";
		let stderr = "";
		let finalAssistantText = "";
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		const processLine = (line: string) => {
			const parsed = parseJsonLine(line);
			if (!parsed) return;
			for (const event of mapPiEvent(parsed)) {
				if (event.kind === "message-end" && event.role === "assistant") finalAssistantText = event.text;
				emit(event);
			}
			const messageValue = parsed.message;
			if (isMessage(messageValue) && messageValue.role === "assistant") {
								if (isString(messageValue.stopReason)) stopReason = messageValue.stopReason;
				if (isString(messageValue.errorMessage)) errorMessage = messageValue.errorMessage;
			}
		};
		proc.stdout.on("data", (data) => {
			stdoutBuffer += data.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("close", (code, closeSignal) => {
			if (stdoutBuffer.trim()) processLine(stdoutBuffer);
			if (abortState.isAborted()) {
				emit({ kind: "run-settled", outcome: { kind: "interrupted", partialText: finalAssistantText || undefined } });
				return;
			}
			// Success gates on exit code + stop reason, matching native-task-tool's
			// isTaskError semantics. Empty final text at exit 0 is a successful run
			// with empty output, not a failure. Strictly `code === 0`: a null code
			// means the child was killed by an EXTERNAL signal (operator kill,
			// host cleanup) — that must never fold as completed.
			if (code === 0 && stopReason !== "error" && stopReason !== "aborted") {
				emit({ kind: "run-settled", outcome: { kind: "completed", finalText: finalAssistantText } });
				return;
			}
			emit({
				kind: "run-settled",
				outcome: {
					kind: "failed",
					errorText: (errorMessage || stderr || (closeSignal ? `pi killed by ${closeSignal}` : `pi exited with code ${code ?? "unknown"}`)).slice(0, ERROR_MAX),
					partialText: finalAssistantText || undefined,
				},
			});
		});
		proc.on("error", (error) => {
			emit({ kind: "run-settled", outcome: { kind: "failed", errorText: error.message.slice(0, ERROR_MAX), partialText: finalAssistantText || undefined } });
		});
	};
	return { events, interrupt: () => interrupt() };
};

export const spawnPiChild = createPiChildSpawner();
