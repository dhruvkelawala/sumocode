/**
 * Task mode auto-exit.
 *
 * When SumoCode launches via `sumocode task "<prompt>"` (i.e.
 * `SUMOCODE_TASK_MODE=1`), the session is a hand-off from an orchestrator:
 * do one delegated turn, then close. This module wires the lifecycle that
 * makes the pane close itself after the agent finishes — without leaving
 * the user staring at an idle editor in a child pane they probably don't
 * want to interact with.
 *
 * Behavior:
 *
 * - On the first `agent_end` after launch, schedule a close after a grace
 *   period (default 10s) so the user has time to read the response.
 * - During the grace period, a status entry in the footer counts down
 *   ("auto-closing in 9s · type to cancel").
 * - If the user types anything in the editor (source=interactive), cancel
 *   the auto-exit permanently for this session. User has taken over.
 * - Opt out entirely with `SUMOCODE_TASK_KEEP_OPEN=1`.
 *
 * Closing the pane uses `cmux close-surface` (no args; cmux defaults to
 * `$CMUX_SURFACE_ID` which is auto-set in every cmux terminal). This is
 * cmux's documented "close this pane" method and bypasses Pi's deferred
 * `ctx.shutdown()` semantics, which in practice do not reliably terminate
 * Pi from inside an extension handler.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isInCmux } from "./commands/cmux-split.js";

/**
 * Env-gated diagnostic logging. Set `SUMOCODE_TASK_DIAG_FILE=/tmp/xxx.jsonl`
 * to capture every lifecycle event the auto-exit goes through. Used by
 * `scripts/diag-task-auto-exit.mjs` to figure out where the close stalls.
 * No-op when the env var is unset (production default).
 */
function diagLog(event: string, detail?: Record<string, unknown>): void {
	const file = process.env.SUMOCODE_TASK_DIAG_FILE;
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
 * Writes to `$SUMOCODE_TASK_RESPONSE_FILE` which the bg_task spawn pipeline
 * sets when it launches a visible agent pane. The orchestrator polls this
 * path; when it appears, the task transitions to status=completed and the
 * `bg_task log` action returns this file's contents.
 */
function persistResponse(messages: unknown[]): void {
	const file = process.env.SUMOCODE_TASK_RESPONSE_FILE;
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
	if (!shouldInstallTaskModeAutoExit(options)) {
		diagLog("install_skipped", {
			taskMode: process.env.SUMOCODE_TASK_MODE,
			keepOpen: process.env.SUMOCODE_TASK_KEEP_OPEN,
		});
		return;
	}

	const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
	let userTookOver = false;
	let pending: { tick: ReturnType<typeof setInterval>; shutdown: ReturnType<typeof setTimeout> } | undefined;
	let armed = false;

	diagLog("install", {
		graceMs,
		inCmux: isInCmux(),
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

	const closeOwnSurface = async (): Promise<void> => {
		// `cmux close-surface` with no args defaults to $CMUX_SURFACE_ID, which
		// is auto-set in every cmux terminal. From inside the child pane this
		// is the documented way to ask cmux to tear down the surface we are
		// running in. cmux then signals the pane's leading process; the bash
		// wrapper and pi both exit cleanly without any process.exit() hack.
		if (!isInCmux()) {
			diagLog("close_skipped", { reason: "not_in_cmux" });
			return;
		}
		diagLog("close_invoking", { surface: process.env.CMUX_SURFACE_ID });
		try {
			const result = await pi.exec("cmux", ["close-surface"], { timeout: 5000 });
			diagLog("close_result", { code: result.code, stdout: result.stdout?.slice(0, 200), stderr: result.stderr?.slice(0, 200), killed: result.killed });
		} catch (error) {
			diagLog("close_threw", { message: error instanceof Error ? error.message : String(error) });
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
		if (userTookOver) return;
		// Only auto-exit on the FIRST agent_end after launch. Subsequent
		// agent_end events fire because the user typed follow-up prompts
		// during the grace period (input handler would already have cancelled).
		if (armed) return;
		armed = true;

		// Persist the final assistant text to disk so the orchestrator can
		// harvest the delegated work's output. Best-effort — if SUMOCODE_TASK_RESPONSE_FILE
		// isn't set (running outside the bg_task pipeline), this no-ops.
		persistResponse((event as { messages?: unknown[] }).messages ?? []);

		let remaining = Math.ceil(graceMs / 1000);
		ctx.ui.setStatus(STATUS_KEY, `task done · auto-closing in ${remaining}s · type to cancel`);
		diagLog("timer_armed", { graceMs, remaining });

		const tick = setInterval(() => {
			remaining -= 1;
			if (remaining > 0) {
				ctx.ui.setStatus(STATUS_KEY, `task done · auto-closing in ${remaining}s · type to cancel`);
			}
		}, TICK_MS);

		const shutdown = setTimeout(() => {
			diagLog("timer_fired");
			cancelPending(ctx, "fired");
			void closeOwnSurface();
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
