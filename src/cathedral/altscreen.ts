import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { installLifecycle } from "../sumo-tui/runtime/lifecycle.js";

/**
 * Cathedral compatibility shim.
 *
 * Terminal ownership now lives in sumo-tui's lifecycle controller. Keeping this
 * module preserves the existing extension entry-point while Phase 1 replaces the
 * old one-off altscreen cleanup with the retained renderer foundation.
 */
export function installAltscreen(pi: ExtensionAPI): void {
	installLifecycle(pi);
}
