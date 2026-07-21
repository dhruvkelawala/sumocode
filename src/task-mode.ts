/**
 * Task mode auto-exit.
 *
 * When SumoCode launches via `sumocode task "<prompt>"` (i.e.
 * `SUMOCODE_TASK_MODE=1`), the session is a hand-off from an orchestrator:
 * do one delegated turn, then shut down the child process. This module wires
 * the lifecycle that exits the agent while leaving the cmux pane itself as a
 * preserved viewport the orchestrator/human can inspect.
 *
 * Behavior:
 *
 * - On each `agent_end`, write the latest assistant response for the parent.
 * - On the first `agent_end` after launch, schedule process shutdown after a
 *   grace period (default 10s) so the user has time to read the response.
 * - During the grace period, a status entry in the footer counts down
 *   ("exiting in 9s · type to cancel").
 * - If the user types anything in the editor (source=interactive), cancel
 *   the auto-exit permanently for this session. User has taken over.
 * - Opt out entirely with `SUMOCODE_TASK_KEEP_OPEN=1`.
 *
 * Shutdown uses Pi's `ctx.shutdown()` instead of `cmux close-surface`: task
 * completion belongs to the child process lifecycle, while pane close is an
 * explicit orchestrator/user decision (for example subagent cancellation).
 */

import { appendFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
] as const;

let capturedMarkerEnv: NodeJS.ProcessEnv | undefined;

/**
 * Capture the marker-file env vars into a snapshot and scrub them from the
 * given env (typically `process.env`). Returns the snapshot. Exposed for
 * tests; production code calls this once via `installTaskModeAutoExit`.
 */
export function captureAndScrubTaskMarkerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const snapshot: NodeJS.ProcessEnv = {};
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

/**
 * Env-gated diagnostic logging. Set `SUMOCODE_TASK_DIAG_FILE=/tmp/xxx.jsonl`
 * to capture every lifecycle event the auto-exit goes through. Used by
 * `scripts/diag-task-auto-exit.mjs` to figure out where the close stalls.
 * No-op when the env var is unset (production default).
 */
function diagLog(event: string, detail?: Record<string, unknown>): void {
	const file = capturedMarkerEnv?.SUMOCODE_TASK_DIAG_FILE ?? process.env.SUMOCODE_TASK_DIAG_FILE;
	if (!file) return;
	try {
		appendFileSync(
			file,
			`${JSON.stringify({ t: Date.now(), pid: process.pid, event, ...(detail ?? {}) })}\n`,
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
export function extractFinalAssistantText(messages: unknown[]): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i] as { role?: unknown; content?: unknown } | null;
		if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const parts: string[] = [];
		for (const block of msg.content as Array<{ type?: unknown; text?: unknown }>) {
			if (block && block.type === "text" && typeof block.text === "string") {
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

function installTaskExitMarker(env: NodeJS.ProcessEnv = process.env): void {
	if (!env.SUMOCODE_TASK_EXIT_FILE) return;
	process.once("exit", (code) => writeTaskExitMarker(typeof code === "number" ? code : 0, env));
}

const STATUS_KEY = "sumocode-task-auto-exit";
const DEFAULT_GRACE_MS = 10_000;
const TICK_MS = 1_000;

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

/**
 * Install the auto-exit lifecycle. Idempotent within a session — the
 * extension calls this once during install, and a single agent_end +
 * grace-period cycle handles the close.
 */
export function installTaskModeAutoExit(pi: ExtensionAPI, options: TaskModeAutoExitOptions = {}): void {
	const env = options.env ?? process.env;
	if (isActive(env)) {
		// Capture marker paths, then scrub them from the env so subprocesses
		// spawned by this agent cannot clobber the orchestrator's marker files.
		const markers = captureAndScrubTaskMarkerEnv(env);
		writeTaskStartedMarker(markers);
		installTaskExitMarker(markers);
	}

	if (!shouldInstallTaskModeAutoExit(options)) {
		diagLog("install_skipped", {
			taskMode: env.SUMOCODE_TASK_MODE,
			keepOpen: env.SUMOCODE_TASK_KEEP_OPEN,
		});
		return;
	}

	const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
	let userTookOver = false;
	let pending: { tick: ReturnType<typeof setInterval>; shutdown: ReturnType<typeof setTimeout> } | undefined;
	let armed = false;
	diagLog("install", {
		graceMs,
		cmuxSurfaceId: process.env.CMUX_SURFACE_ID,
		cmuxWorkspaceId: process.env.CMUX_WORKSPACE_ID,
	});

	const cancelPending = (ctx: { ui: { setStatus: (key: string, value?: string) => void } }, reason: "user" | "fired"): void => {
		if (!pending) return;
		clearInterval(pending.tick);
		clearTimeout(pending.shutdown);
		pending = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (reason === "user") {
			userTookOver = true;
		}
	};

	pi.on("input", (event, ctx) => {
		diagLog("input", { source: event.source, armed });
		// Ignore input until the first agent_end has armed the timer. Pi
		// delivers the CLI kickoff prompt as an `input` event with source
		// `interactive` — same shape as a real user keypress — so we can't
		// distinguish them by source alone. The agent_end-gated check is the
		// reliable boundary: anything before the first agent_end is either
		// the kickoff or steering during the kickoff turn (which is still
		// part of the delegated turn the orchestrator handed off).
		if (!armed) return;
		if (event.source !== "interactive") return;
		if (pending) {
			cancelPending(ctx, "user");
			ctx.ui.notify("task auto-exit cancelled — pane will stay open", "info");
		}
	});

	pi.on("agent_end", (event, ctx) => {
		diagLog("agent_end", { userTookOver, armed });
		// Always persist the latest completed turn. Completion is keyed off the
		// real process-exit marker, so response.md can be overwritten safely if a
		// human takes over and sends follow-up turns before shutdown.
		persistResponse((event as { messages?: unknown[] }).messages ?? []);
		if (userTookOver) return;
		// Only auto-exit on the FIRST agent_end after launch. Subsequent
		// agent_end events fire because the user typed follow-up prompts
		// during the grace period (input handler would already have cancelled).
		if (armed) return;
		armed = true;

		let remaining = Math.ceil(graceMs / 1000);
		ctx.ui.setStatus(STATUS_KEY, `task done · exiting in ${remaining}s · type to cancel`);
		diagLog("timer_armed", { graceMs, remaining });

		const tick = setInterval(() => {
			remaining -= 1;
			if (remaining > 0) {
				ctx.ui.setStatus(STATUS_KEY, `task done · exiting in ${remaining}s · type to cancel`);
			}
		}, TICK_MS);

		const shutdown = setTimeout(() => {
			diagLog("timer_fired");
			cancelPending(ctx, "fired");
			ctx.shutdown();
		}, graceMs);

		pending = { tick, shutdown };
	});

	pi.on("session_shutdown", (_event, ctx) => {
		diagLog("session_shutdown");
		// Defensive cleanup if shutdown is triggered by a different path
		// (e.g. user hits Ctrl+D while our timer is running).
		cancelPending(ctx, "fired");
	});
}
