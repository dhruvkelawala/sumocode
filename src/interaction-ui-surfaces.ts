import { installCommandPalette } from "./command-palette.js";
import { installSidebar } from "./sidebar.js";
import type { InteractionRegistry } from "./interaction-registry.js";

/** Classic-only interactions excluded from the headless RPC child import graph. */
export function installSumoUiSurfaces(registry: InteractionRegistry): void {
	registry.install("command-palette", installCommandPalette);
	registry.install("sidebar", installSidebar);
}
