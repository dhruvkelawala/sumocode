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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isInCmux } from "./commands/cmux-split.js";

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
	if (!shouldInstallTaskModeAutoExit(options)) return;

	const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
	let userTookOver = false;
	let pending: { tick: ReturnType<typeof setInterval>; shutdown: ReturnType<typeof setTimeout> } | undefined;
	let armed = false;

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
		if (!isInCmux()) return;
		try {
			await pi.exec("cmux", ["close-surface"], { timeout: 5000 });
		} catch {
			// best-effort — if cmux is unreachable, leave the pane open
		}
	};

	pi.on("input", (event, ctx) => {
		// Only count actual interactive typing as a take-over. Kickoff prompts
		// from the CLI positional / sendUserMessage shouldn't disarm the timer.
		if (event.source !== "interactive") return;
		if (pending) {
			cancelPending(ctx, "user");
			ctx.ui.notify("task auto-exit cancelled — pane will stay open", "info");
		} else {
			// User started typing before agent_end fired — preempt the first
			// auto-exit attempt entirely.
			userTookOver = true;
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		if (userTookOver) return;
		// Only auto-exit on the FIRST agent_end after launch. Subsequent
		// agent_end events (multi-turn sessions) mean the user has engaged
		// even if they haven't typed yet.
		if (armed) return;
		armed = true;

		let remaining = Math.ceil(graceMs / 1000);
		ctx.ui.setStatus(STATUS_KEY, `task done · auto-closing in ${remaining}s · type to cancel`);

		const tick = setInterval(() => {
			remaining -= 1;
			if (remaining > 0) {
				ctx.ui.setStatus(STATUS_KEY, `task done · auto-closing in ${remaining}s · type to cancel`);
			}
		}, TICK_MS);

		const shutdown = setTimeout(() => {
			cancelPending(ctx, "fired");
			void closeOwnSurface();
		}, graceMs);

		pending = { tick, shutdown };
	});

	pi.on("session_shutdown", (_event, ctx) => {
		// Defensive cleanup if shutdown is triggered by a different path
		// (e.g. user hits Ctrl+D while our timer is running).
		cancelPending(ctx, "fired");
	});
}
