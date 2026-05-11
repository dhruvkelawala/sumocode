import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildShellCommand, openCommandInNewSplit, type SplitDirection } from "./cmux-split.js";

/**
 * `/sumo:diff` — open `hunkdiff` in a new cmux split pane for quick review.
 *
 *   /sumo:diff                  → `hunk diff`           (working tree)
 *   /sumo:diff --watch          → `hunk diff --watch`   (auto-reload as files change)
 *   /sumo:diff HEAD~1           → `hunk diff HEAD~1`    (compare against a ref)
 *   /sumo:diff show             → `hunk show`           (latest commit)
 *   /sumo:diff show HEAD~1      → `hunk show HEAD~1`    (specific commit)
 *   /sumo:diff before.ts after.ts
 *
 * Requires `cmux` (we're inside a cmux surface) and `hunkdiff` (npm:
 * `npm i -g hunkdiff` or `brew install modem-dev/tap/hunk`). When either is
 * missing, the command notifies and exits without side effects.
 *
 * Split direction is `right` so the diff lands next to the active SUMO
 * session. Users who prefer a downward split can use pi-cmux's `/cmoh hunk
 * diff` instead.
 */

/** First-token subcommands hunk supports as documented in its README. */
const HUNK_SUBCOMMANDS: ReadonlySet<string> = new Set(["diff", "show", "patch", "pager"]);

export function buildHunkCommand(rawArgs: string): string {
	const trimmed = rawArgs.trim();
	if (!trimmed) return "hunk diff";
	const tokens = trimmed.split(/\s+/);
	const first = tokens[0] ?? "";
	if (HUNK_SUBCOMMANDS.has(first)) return `hunk ${trimmed}`;
	// Anything that doesn't look like a hunk subcommand is treated as
	// arguments to `hunk diff` — covers `/sumo:diff --watch`,
	// `/sumo:diff HEAD~1`, `/sumo:diff before.ts after.ts`, etc.
	return `hunk diff ${trimmed}`;
}

/**
 * Check whether `hunkdiff` is on PATH. Using `pi.exec` rather than spawning
 * the new pane and letting hunk's own "command not found" error appear there
 * — better UX to fail fast with a clear install hint.
 */
async function isHunkInstalled(pi: ExtensionAPI): Promise<boolean> {
	try {
		const result = await pi.exec("sh", ["-lc", "command -v hunk >/dev/null 2>&1"], { timeout: 2_000 });
		return result.code === 0 && !result.killed;
	} catch {
		return false;
	}
}

export function registerDiffCommand(pi: ExtensionAPI): void {
	pi.registerCommand("sumo:diff", {
		description: "Open hunk diff in a new cmux split (right) for quick review",
		handler: async (args: string | undefined, ctx: ExtensionContext) => {
			// All failure paths must go through `ctx.ui.notify` per the
			// SumoCode slash-command contract — no exception should ever
			// escape the handler. Wrap the body so unexpected throws from
			// `pi.exec` / cmux helpers / future refactors still surface as a
			// user-visible warning rather than a silent rejection.
			try {
				if (!ctx.hasUI) {
					ctx.ui.notify("/sumo:diff requires interactive UI", "warning");
					return;
				}

				if (!(await isHunkInstalled(pi))) {
					ctx.ui.notify(
						"/sumo:diff needs hunkdiff. install with `npm i -g hunkdiff` or `brew install modem-dev/tap/hunk`",
						"warning",
					);
					return;
				}

				const hunkCmd = buildHunkCommand(args ?? "");
				const shellCmd = buildShellCommand(ctx.cwd, hunkCmd);
				const direction: SplitDirection = "right";

				const result = await openCommandInNewSplit(pi, direction, shellCmd);
				if (result.ok) {
					ctx.ui.notify(`opened ${hunkCmd} in a new cmux pane`, "info");
				} else {
					ctx.ui.notify(`/sumo:diff: ${result.error}`, "warning");
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`/sumo:diff: ${message}`, "warning");
			}
		},
	});
}
