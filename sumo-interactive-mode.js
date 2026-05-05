import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url, {
	moduleCache: true,
	// Node's native TypeScript loader is strip-only and cannot handle parameter
	// properties used in SumoInteractiveMode, so keep transpilation on jiti.
	tryNative: false,
});

const mod = await jiti.import("./src/sumo-tui/pi-compat/sumo-interactive-mode.ts");

export const SumoInteractiveMode = mod.SumoInteractiveMode;
export const sumoInteractiveMode = mod.sumoInteractiveMode;
