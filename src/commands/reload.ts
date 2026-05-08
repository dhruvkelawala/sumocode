/**
 * `/sumo:reload` — hard-reload SumoCode source code.
 *
 * Pi's built-in `/reload` reloads keybindings, themes, prompts, skills, and
 * extension metadata, but it does NOT re-import a `pi -e ./src/extension.ts`
 * extension's TypeScript source. Once jiti has cached our modules, `/reload`
 * keeps using the cached graph, so iterating on SumoCode itself still
 * required a Ctrl+C + relaunch.
 *
 * `/sumo:reload` exits the inner pi process with `SUMOCODE_RELOAD_EXIT_CODE`
 * (100). The `bin/sumocode.sh` wrapper runs pi inside a `while :;` loop and
 * re-launches on that exit code with `--continue` appended, so the session
 * resumes against fresh source code without leaving the terminal.
 *
 * If SumoCode is run without the launcher (vanilla `pi -e .`), the slash
 * command falls back to a notify + clean exit.
 */

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
			"sumo:reload needs the bin/sumocode.sh launcher; please rerun via `sumocode` or quit + relaunch",
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
	pi.registerCommand("sumo:reload", {
		description: "hard reload SumoCode source (re-execs pi via the launcher with --continue)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await executeSumoReload(ctx, deps);
		},
	});
}
