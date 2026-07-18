import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBuiltInToolsFromActiveTools } from "../native-task-config.js";
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
		builtInTools: getBuiltInToolsFromActiveTools([...(task.builtInTools ?? [])]),
		signal: task.signal,
	}));
	registerSubagentTools(pi, manager);
	// CONSCIOUS DIVERGENCE from background-tasks' reason-gated shutdown
	// (background-task-tool.ts:61-74): bg_task may leave children running on
	// /reload,/new,/fork because it recovers them from on-disk meta.json.
	// Subagents have NO persistent registry (durable reattach is a recorded
	// deferral in plan 065) — a child surviving a reload would be an orphaned,
	// unsupervised pi process nobody can harvest, steer, or stop, which is
	// worse than losing in-flight work. Kill on EVERY shutdown until a durable
	// registry exists; when it does, adopt the same reason gating as bg_task.
	pi.on("session_shutdown", () => manager.disposeAll());
	return manager;
}
