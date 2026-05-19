import { appendFileSync } from "node:fs";
import { createJiti } from "jiti";

const bootstrapStart = performance.now();
const diagFile = process.env.SUMO_TUI_DIAG_FILE;
function logBootstrap(event, fields = {}) {
	if (!diagFile) return;
	try {
		appendFileSync(diagFile, `${JSON.stringify({ ts: Date.now(), event, sinceBootstrapMs: Math.round((performance.now() - bootstrapStart) * 100) / 100, ...fields })}\n`, "utf8");
	} catch {}
}

logBootstrap("sumo_bootstrap_start", { pid: process.pid, cwd: process.cwd() });
logBootstrap("jiti_create_start");
const jiti = createJiti(import.meta.url, {
	moduleCache: true,
	// Node's native TypeScript loader is strip-only and cannot handle parameter
	// properties used in SumoInteractiveMode, so keep transpilation on jiti.
	tryNative: false,
});

logBootstrap("jiti_create_end");
logBootstrap("sumo_module_import_start");
const mod = await jiti.import("./src/sumo-tui/pi-compat/sumo-interactive-mode.ts");
logBootstrap("sumo_module_import_end");

export const SumoInteractiveMode = mod.SumoInteractiveMode;
export const sumoInteractiveMode = mod.sumoInteractiveMode;
