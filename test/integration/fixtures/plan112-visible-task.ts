import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installTaskModeAutoExit } from "../../../src/task-mode.js";

export default function install(pi: ExtensionAPI): void {
	installTaskModeAutoExit(pi, { graceMs: 0 });
}
