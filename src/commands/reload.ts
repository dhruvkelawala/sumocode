/**
 * `/reload` — hard-reload SumoCode source code.
 *
 * SumoCode overrides Pi's built-in `/reload`, which refreshes resources but
 * does not replace the process that imported SumoCode. A process restart is
 * required to load a fresh module graph.
 *
 * `/reload` exits the inner pi process with `SUMOCODE_RELOAD_EXIT_CODE`
 * (100). The `bin/sumocode.sh` wrapper runs pi inside a `while :;` loop and
 * re-launches on that exit code with `--continue` appended, so the session
 * resumes against fresh source code without leaving the terminal.
 *
 * If SumoCode is run without the launcher (vanilla `pi -e .`), the slash
 * command falls back to a notify + clean exit.
 */

import { writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const SUMOCODE_RELOAD_EXIT_CODE = 100;

const FLUSH_DELAY_MS = 60;

export interface ReloadCommandDeps {
	readonly env?: NodeJS.ProcessEnv;
	readonly exit?: (code: number) => void;
	readonly delay?: (ms: number) => Promise<void>;
}

function defaultDelay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeSumoReload(
	ctx: ExtensionCommandContext,
	deps: ReloadCommandDeps = {},
): Promise<void> {
	const env = deps.env ?? process.env;
	const exit = deps.exit ?? ((code: number) => process.exit(code));
	const delay = deps.delay ?? defaultDelay;

	if (!env.SUMOCODE_LAUNCHER) {
		ctx.ui.notify(
			"reload needs the bin/sumocode.sh launcher; please rerun via `sumocode` or quit + relaunch",
			"warning",
		);
		return;
	}

	ctx.ui.notify("hard reloading SumoCode\u2026", "info");
	// Give Pi's TUI a chance to flush the toast and clear altscreen state
	// before the inner process exits and the launcher re-execs pi.
	await delay(FLUSH_DELAY_MS);
	exit(SUMOCODE_RELOAD_EXIT_CODE);
}

export function registerSumoReloadCommand(pi: ExtensionAPI, deps: ReloadCommandDeps = {}): void {
	pi.on("session_start", () => {
		const env = deps.env ?? process.env;
		const readyFile = env.SUMOCODE_RELOAD_READY_FILE;
		if (!readyFile || env.SUMOCODE_RPC_CHILD === "1") return;
		try { writeFileSync(readyFile, "ready", { mode: 0o600 }); } catch {}
	});
	pi.registerCommand("reload", {
		description: "Reload SumoCode source and resume this session",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await executeSumoReload(ctx, deps);
		},
	});
}
