import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	claimSumocodeRuntime,
	installRpcChildProfile,
	shouldInstallNativeTaskTool,
} from "./extension-core.js";
import { logDiagnostic } from "./sumo-tui/runtime/diagnostics.js";
import { applyStartupTheme } from "./themes/index.js";

/**
 * Source-mode RPC entry: load only the headless child profile, not classic UI.
 * The installed-copy guard stays in the canonical entry; this launcher-owned
 * entry must install, while the shared process latch still blocks duplicates.
 */
export default function rpcChildSumocode(pi: ExtensionAPI): void {
	logDiagnostic("extension_activate_begin", {
		taskMode: process.env.SUMOCODE_TASK_MODE === "1",
		sumoTui: process.env.SUMO_TUI ?? null,
		launcher: process.env.SUMOCODE_LAUNCHER ?? null,
	});
	if (!claimSumocodeRuntime(pi)) return;
	applyStartupTheme();
	installRpcChildProfile(pi);
	logDiagnostic("extension_activate_end", {
		profile: "rpc-child",
		nativeTaskInstalled: shouldInstallNativeTaskTool({ force: process.env.SUMOCODE_NATIVE_TASK }),
	});
}
