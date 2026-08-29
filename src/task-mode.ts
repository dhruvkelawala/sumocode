/**
 * Task mode auto-exit.
 *
 * When SumoCode launches via `sumocode task "<prompt>"` (i.e.
 * `SUMOCODE_TASK_MODE=1`), the session is a hand-off from an orchestrator:
 * do one delegated turn, then shut down the child process. This module wires
 * the lifecycle that exits the agent while leaving the terminal pane itself as
 * a preserved viewport the orchestrator/human can inspect.
 *
 * Behavior:
 *
 * - On each `agent_end`, write the latest assistant response for the parent.
 * - Every `agent_end` (re)arms a silence countdown (default 30s): when a full
 *   window passes with no turn running and no interactive input, the child
 *   shuts down. `agent_start` and interactive typing cancel the pending
 *   countdown; the next `agent_end` re-arms. A child therefore always exits
 *   after it goes quiet — steering or takeover can never pin it open forever.
 * - While the countdown runs, a footer status entry counts down
 *   ("task done · exiting in 9s · type or steer to extend").
 * - Opt out entirely with `SUMOCODE_TASK_KEEP_OPEN=1`.
 *
 * Shutdown uses Pi's `ctx.shutdown()`: task completion belongs to the child
 * process lifecycle, while pane close is an explicit orchestrator/user decision
 * (for example subagent cancellation).
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Marker-file env vars set by the visible-subagent spawn pipeline. They
 * are a contract between the orchestrator and THIS process only: if they leak
 * to subprocesses (bash tool commands, integration-test PTY children, nested
 * pi runs), those descendants write their own lifecycle into OUR marker
 * files — e.g. a SIGTERM'd test child writes 143 to SUMOCODE_TASK_EXIT_FILE
 * and the orchestrator falsely declares this agent dead. At install time the
 * values are captured into a module-level snapshot and deleted from the env
 * so descendants never see them.
 */
const TASK_MARKER_ENV_KEYS = [
	"SUMOCODE_TASK_RESPONSE_FILE",
	"SUMOCODE_TASK_EXIT_FILE",
	"SUMOCODE_TASK_STARTED_FILE",
	"SUMOCODE_TASK_DIAG_FILE",
	"SUMOCODE_TASK_CONTROL_DIR",
] as const;

let capturedMarkerEnv: NodeJS.ProcessEnv | undefined;

/**
 * Capture the marker-file env vars into a snapshot and scrub them from the
 * given env (typically `process.env`). Returns the snapshot.
 *
 * MERGES with any previous capture instead of replacing it. Pi recreates the
 * extension API in the SAME process for `/new`, `/resume`, and `/fork`, so a
 * second install sees an env this function already scrubbed. Replacing the
 * snapshot there would blank every marker path: response persistence would
 * stop and no replacement control watcher could be installed, silently
 * breaking steering and graceful close for the rest of the process lifetime.
 */
export function captureAndScrubTaskMarkerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const snapshot: NodeJS.ProcessEnv = { ...capturedMarkerEnv };
	for (const key of TASK_MARKER_ENV_KEYS) {
		const value = env[key];
		if (value !== undefined) {
			snapshot[key] = value;
			delete env[key];
		}
	}
	capturedMarkerEnv = snapshot;
	return snapshot;
}

/** Test seam: forget the captured marker snapshot. */
export function resetTaskMarkerEnvForTests(): void {
	capturedMarkerEnv = undefined;
}

interface DiagDetail {
	readonly reason?: string;
	readonly file?: string;
	readonly bytes?: number;
	readonly message?: string;
	readonly taskMode?: string;
	readonly keepOpen?: string;
	readonly graceMs?: number;
	readonly source?: string;
	readonly pending?: boolean;
	readonly code?: number;
	readonly remaining?: number;
}

/**
 * Env-gated diagnostic logging. Set `SUMOCODE_TASK_DIAG_FILE=/tmp/xxx.jsonl`
 * to capture every lifecycle event the auto-exit goes through.
 * No-op when the env var is unset (production default).
 */
function diagLog(event: string, detail?: DiagDetail): void {
	const file = capturedMarkerEnv?.SUMOCODE_TASK_DIAG_FILE ?? process.env.SUMOCODE_TASK_DIAG_FILE;
	if (!file) return;
	try {
		appendFileSync(
			file,
			`${JSON.stringify({ t: Date.now(), pid: process.pid, event, ...(detail ?? undefined) })}\n`,
		);
	} catch {
		// diagnostics must never crash the extension
	}
}

/**
 * Pull the final assistant text out of an agent_end message bundle.
 *
 * Pi's agent_end fires with `event.messages` for the just-completed turn.
 * The terminal assistant message holds the response we want to harvest;
 * earlier assistant messages are intermediate tool-calling turns.
 * Content is a block array (text blocks, tool_use blocks, etc.) — we
 * concatenate all text blocks of the last assistant message.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- predicate over an untyped Pi block field; the typeof check is the sanctioned parse.
function isText(value: unknown): value is string {
	return typeof value === "string";
}

export function extractFinalAssistantText(messages: unknown[]): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		// SAFETY: agent_end messages are untrusted Pi payloads; each entry is
		// narrowed by the role/content guards below.
		const msg = messages[i] as { role?: unknown; content?: unknown } | null;
		if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const parts: string[] = [];
		// SAFETY: msg.content was checked to be an array above; each block is
		// narrowed by the type/text guards below.
		for (const block of msg.content as Array<{ type?: unknown; text?: unknown }>) {
			if (block && block.type === "text" && isText(block.text)) {
				parts.push(block.text);
			}
		}
		if (parts.length > 0) return parts.join("\n").trim();
	}
	return "";
}

/**
 * Persist the agent's final response so the orchestrating session can read it.
 *
 * Writes to `$SUMOCODE_TASK_RESPONSE_FILE`, which the visible-subagent
 * backend reads after the child process settles. Updated on every agent_end
 * so a multi-turn pane always exposes its latest assistant response.
 */
function persistResponse(messages: unknown[]): void {
	const file = capturedMarkerEnv?.SUMOCODE_TASK_RESPONSE_FILE ?? process.env.SUMOCODE_TASK_RESPONSE_FILE;
	if (!file) {
		diagLog("response_skipped", { reason: "no_env" });
		return;
	}
	const text = extractFinalAssistantText(messages);
	if (!text) {
		diagLog("response_skipped", { reason: "no_text" });
		return;
	}
	try {
		writeFileSync(file, `${text}\n`);
		diagLog("response_written", { file, bytes: text.length });
	} catch (error) {
		diagLog("response_write_failed", {
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export function writeTaskExitMarker(code: number, env: NodeJS.ProcessEnv = process.env): void {
	const file = env.SUMOCODE_TASK_EXIT_FILE;
	if (!file) return;
	try {
		writeFileSync(file, `${code}\n`);
		diagLog("exit_marker_written", { file, code });
	} catch (error) {
		diagLog("exit_marker_write_failed", {
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export function writeTaskStartedMarker(env: NodeJS.ProcessEnv = process.env): void {
	const file = env.SUMOCODE_TASK_STARTED_FILE;
	if (!file) return;
	try {
		writeFileSync(file, `${process.pid}\n`);
		diagLog("started_marker_written", { file });
	} catch (error) {
		diagLog("started_marker_write_failed", {
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

function isNumber(value: number | undefined): value is number {
	return typeof value === "number";
}

function errorMessage<T>(error: T): string {
	return error instanceof Error ? error.message : String(error);
}

function installTaskExitMarker(env: NodeJS.ProcessEnv = process.env): void {
	if (!env.SUMOCODE_TASK_EXIT_FILE) return;
	process.once("exit", (code) => writeTaskExitMarker(isNumber(code) ? code : 0, env));
}

const STATUS_KEY = "sumocode-task-auto-exit";
const DEFAULT_GRACE_MS = 30_000;
const TICK_MS = 1_000;
const CONTROL_POLL_MS = 500;
const CLOSE_REQUEST_FILE = "close.request";
const STEER_FILE_PATTERN = /^steer-(\d+)\.txt$/;

export interface TaskModeAutoExitOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly graceMs?: number;
}

/** True when task mode is active. Mirrors `isTaskMode` in extension.ts. */
function isActive(env: NodeJS.ProcessEnv): boolean {
	return env.SUMOCODE_TASK_MODE === "1";
}

/** True when the user has explicitly disabled auto-exit. */
function isKeepOpen(env: NodeJS.ProcessEnv): boolean {
	return env.SUMOCODE_TASK_KEEP_OPEN === "1";
}

export function shouldInstallTaskModeAutoExit(options: TaskModeAutoExitOptions = {}): boolean {
	const env = options.env ?? process.env;
	return isActive(env) && !isKeepOpen(env);
}

interface TaskModeControlHooks {
	getLatestCtx(): ExtensionContext | undefined;
	cancelCountdown(): void;
	/** Shut down now, or defer until the active turn reaches `agent_end`. */
	requestShutdown(ctx: ExtensionContext): void;
}

/**
 * Poll `<controlDir>` for orchestrator control files (the parent-side writer
 * lives in `src/subagents/backend-pane.ts`). Steer files are consumed and
 * synchronously submitted to Pi; `close.request` shuts the child down. The
 * watcher is independent of the auto-exit countdown: it also runs for
 * keep-open sessions, because close is explicit while auto-exit is silence.
 */
function installControlWatcher(pi: ExtensionAPI, controlDir: string | undefined, hooks: TaskModeControlHooks): () => void {
	if (!controlDir) return () => undefined;
	let stopped = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	const stop = (): void => {
		stopped = true;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	const submitSteer = (file: string): void => {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (error) {
			diagLog("steer_read_failed", { file, message: errorMessage(error) });
			return;
		}
		if (!text.trim()) {
			// Empty writes carry nothing to submit; deletion still records control
			// consumption so the orchestrator does not wait out its full budget.
			try {
				unlinkSync(file);
			} catch {
				// nothing to salvage from an unreadable empty file
			}
			return;
		}
		try {
			hooks.cancelCountdown();
			// ExtensionAPI.sendUserMessage returns void (unlike the internal
			// ReplacedSessionContext method). A true acceptance ACK requires an
			// upstream awaitable result or callback; this call can observe only a
			// synchronous throw. Do not add a cosmetic await here.
			pi.sendUserMessage(text, { deliverAs: "steer" });
			// Unlink tells the parent that the watcher consumed the control and the
			// synchronous submission did not throw. It is not model-turn delivery.
			unlinkSync(file);
			diagLog("steer_submitted", { file, bytes: text.length });
		} catch (error) {
			// One bad file must not wedge the watcher; preserve it for the next tick.
			diagLog("steer_submit_failed", { file, message: errorMessage(error) });
		}
	};

	const tick = (): void => {
		try {
			const ctx = hooks.getLatestCtx();
			// Gate EVERY control action on a captured context. Its absence means
			// session_start has not fired, i.e. the extension runtime is still
			// loading — and both `sendUserMessage` and `shutdown` throw during
			// loading ("Extension runtime not initialized"). Ticking anyway burns
			// the first submission attempt and can push control consumption past the
			// parent's acknowledgement budget. Retry next tick instead.
			if (!ctx) return;
			if (existsSync(join(controlDir, CLOSE_REQUEST_FILE))) {
				diagLog("close_requested");
				hooks.cancelCountdown();
				stop();
				hooks.requestShutdown(ctx);
				return;
			}
			let entries: string[];
			try {
				entries = readdirSync(controlDir);
			} catch {
				// The parent creates the dir at spawn, but the child can boot
				// first — tolerate a missing dir until it appears.
				return;
			}
			const seqOf = (name: string): number => Number(name.match(STEER_FILE_PATTERN)?.[1] ?? Number.MAX_SAFE_INTEGER);
			const steerFiles = entries.filter((entry) => STEER_FILE_PATTERN.test(entry)).sort((a, b) => seqOf(a) - seqOf(b));
			for (const name of steerFiles) submitSteer(join(controlDir, name));
		} catch (error) {
			diagLog("control_poll_failed", { message: errorMessage(error) });
		}
	};

	timer = setInterval(() => {
		if (!stopped) tick();
	}, CONTROL_POLL_MS);
	timer.unref?.();
	return stop;
}

/**
 * Install the task-mode lifecycle. Idempotent within a session — the
 * extension calls this once during install.
 *
 * Marker capture and the control-file watcher run for EVERY task-mode
 * session (steer/close are orchestrator channels, independent of silence);
 * only the auto-exit countdown wiring is skipped by keep-open.
 */
export function installTaskModeAutoExit(pi: ExtensionAPI, options: TaskModeAutoExitOptions = {}): void {
	const env = options.env ?? process.env;
	if (!isActive(env)) {
		diagLog("install_skipped", {
			taskMode: env.SUMOCODE_TASK_MODE,
			keepOpen: env.SUMOCODE_TASK_KEEP_OPEN,
		});
		return;
	}

	// Capture marker paths, then scrub them from the env so subprocesses
	// spawned by this agent cannot clobber the orchestrator's marker files.
	const markers = captureAndScrubTaskMarkerEnv(env);
	writeTaskStartedMarker(markers);
	installTaskExitMarker(markers);

	const countdownEnabled = shouldInstallTaskModeAutoExit(options);
	const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
	let latestCtx: ExtensionContext | undefined;
	let pending: { tick: ReturnType<typeof setInterval>; shutdown: ReturnType<typeof setTimeout> } | undefined;
	let everArmed = false;
	// A turn is active between agent_start and agent_end. Close requests that
	// arrive inside that window must wait for it: agent_end is the ONLY place
	// response.md is written.
	let turnActive = false;
	let closeRequested = false;

	const cancelPending = (ctx: ExtensionContext): void => {
		if (!pending) return;
		clearInterval(pending.tick);
		clearTimeout(pending.shutdown);
		pending = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	/** Arm a fresh silence countdown, replacing any live one. */
	const armCountdown = (ctx: ExtensionContext): void => {
		cancelPending(ctx);
		let remaining = Math.ceil(graceMs / 1000);
		diagLog(everArmed ? "timer_rearmed" : "timer_armed", { graceMs, remaining });
		everArmed = true;
		ctx.ui.setStatus(STATUS_KEY, `task done · exiting in ${remaining}s · type or steer to extend`);

		const tick = setInterval(() => {
			remaining -= 1;
			if (remaining > 0) {
				ctx.ui.setStatus(STATUS_KEY, `task done · exiting in ${remaining}s · type or steer to extend`);
			}
		}, TICK_MS);

		const shutdown = setTimeout(() => {
			diagLog("timer_fired");
			cancelPending(ctx);
			ctx.shutdown();
		}, graceMs);

		pending = { tick, shutdown };
	};

	const shutdownNow = (ctx: ExtensionContext): void => {
		cancelPending(ctx);
		ctx.shutdown();
	};

	const stopWatcher = installControlWatcher(pi, markers.SUMOCODE_TASK_CONTROL_DIR, {
		getLatestCtx: () => latestCtx,
		cancelCountdown: () => {
			if (latestCtx) cancelPending(latestCtx);
		},
		requestShutdown: (ctx) => {
			if (turnActive) {
				// Exiting mid-turn would settle the parent on a stale or empty
				// response.md while reporting a normal completion — silently losing
				// the work the child is producing right now. agent_end persists the
				// turn and then honors this request.
				closeRequested = true;
				diagLog("close_deferred_active_turn");
				return;
			}
			shutdownNow(ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
	});

	// Turn tracking, response persistence, and deferred close are registered for
	// EVERY task-mode session. They are orchestrator-facing guarantees, not
	// countdown behavior, so keep-open sessions need them too.
	pi.on("agent_start", (_event, ctx) => {
		latestCtx = ctx;
		turnActive = true;
		// A turn is running — never exit mid-turn. agent_end re-arms afterwards.
		if (pending) {
			cancelPending(ctx);
			diagLog("timer_cancelled_agent_start");
		}
	});

	pi.on("agent_end", (event, ctx) => {
		latestCtx = ctx;
		turnActive = false;
		diagLog("agent_end", { pending: pending !== undefined });
		// Always persist the latest completed turn. Completion is keyed off the
		// real process-exit marker, so response.md can be overwritten safely if a
		// human takes over and sends follow-up turns before shutdown.
		persistResponse(
			// SAFETY: agent_end carries the completed turn's messages; non-array
			// payloads fall back to an empty list below.
			(event as { messages?: unknown[] }).messages ?? [],
		);
		if (closeRequested) {
			// The deferred close from mid-turn: the finished turn is now on disk.
			diagLog("close_completed_after_turn");
			shutdownNow(ctx);
			return;
		}
		if (countdownEnabled) armCountdown(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		diagLog("session_shutdown");
		stopWatcher();
		// Defensive cleanup if shutdown is triggered by a different path
		// (e.g. user hits Ctrl+D while our timer is running).
		cancelPending(ctx);
	});

	if (!countdownEnabled) {
		// Keep-open opts out of the silence countdown only; the watcher, turn
		// tracking, and response persistence above stay live.
		diagLog("install_skipped", {
			taskMode: env.SUMOCODE_TASK_MODE,
			keepOpen: env.SUMOCODE_TASK_KEEP_OPEN,
		});
		return;
	}

	diagLog("install", { graceMs });

	pi.on("input", (event, ctx) => {
		latestCtx = ctx;
		diagLog("input", { source: event.source, pending: pending !== undefined });
		if (event.source !== "interactive") return;
		if (pending) {
			// A human is driving the pane. Drop this countdown; the next
			// agent_end re-arms, so the pane only exits after a further full
			// silence window. Before the first agent_end there is no countdown,
			// so the CLI kickoff prompt is naturally a no-op here.
			cancelPending(ctx);
			diagLog("timer_cancelled_input");
			ctx.ui.notify("task auto-exit deferred — the countdown re-arms after this turn", "info");
		}
	});

}
