import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	installRpcChildProfile,
	isSumocodeAlreadyInstalledInProcess,
	markSumocodeInstalledInProcess,
	shouldInstallNativeTaskTool,
} from "./extension-core.js";
import { logDiagnostic } from "./sumo-tui/runtime/diagnostics.js";
import { applyStartupTheme } from "./themes/index.js";

/** Source-mode RPC entry: load only the headless child profile, not classic UI. */
export default function rpcChildSumocode(pi: ExtensionAPI): void {
	logDiagnostic("extension_activate_begin", {
		taskMode: process.env.SUMOCODE_TASK_MODE === "1",
		sumoTui: process.env.SUMO_TUI ?? null,
		launcher: process.env.SUMOCODE_LAUNCHER ?? null,
	});
	if (isSumocodeAlreadyInstalledInProcess(pi)) {
		console.warn("[sumocode] Skipping duplicate SumoCode entry: this Pi runtime already installed SumoCode via another entry path.");
		logDiagnostic("extension_activate_skipped_duplicate_process_entry", {});
		return;
	}
	markSumocodeInstalledInProcess(pi);
	applyStartupTheme();
	installRpcChildProfile(pi);
	logDiagnostic("extension_activate_end", {
		profile: "rpc-child",
		nativeTaskInstalled: shouldInstallNativeTaskTool({ force: process.env.SUMOCODE_NATIVE_TASK }),
	});
}
