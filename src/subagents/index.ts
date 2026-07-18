import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnPiChild } from "./backend-pi.js";
import { SubagentManager } from "./manager.js";
import { registerSubagentTools } from "./tools.js";

export { SubagentManager } from "./manager.js";
export type { AtCapacityDetails, SpawnSubagentTask } from "./manager.js";

export function installSubagents(pi: ExtensionAPI): SubagentManager {
	const manager = new SubagentManager((task) => spawnPiChild({
		prompt: task.prompt,
		cwd: task.cwd,
		model: task.model,
		thinking: task.thinking,
		inherited: task.inherited ?? {},
		signal: task.signal,
	}));
	registerSubagentTools(pi, manager);
	pi.on("session_shutdown", () => manager.disposeAll());
	return manager;
}
