import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	tryNative: false,
});

const mod = await jiti.import("./src/sumo-tui/pi-compat/sumo-interactive-mode.ts");

export const SumoInteractiveMode = mod.SumoInteractiveMode;
export const sumoInteractiveMode = mod.sumoInteractiveMode;
