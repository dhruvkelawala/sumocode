import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getBuiltInToolsFromActiveTools } from "../native-task-config.js";
import { spawnPiChild } from "./backend-pi.js";
import { createDeferredResultDelivery, type DeliveryPayload } from "./delivery.js";
import type { SubagentSnapshot } from "./domain.js";
import { SubagentManager } from "./manager.js";
import { buildSubagentResultMessage } from "./prompt.js";
import { registerSubagentTools } from "./tools.js";

export { SubagentManager } from "./manager.js";
export type { AtCapacityDetails, SpawnSubagentTask } from "./manager.js";

const settledPayload = (snapshot: SubagentSnapshot): DeliveryPayload => ({
	id: snapshot.id,
	title: snapshot.title,
	status: snapshot.status,
	content: buildSubagentResultMessage({
		id: snapshot.id,
		title: snapshot.title,
		status: snapshot.status === "done" ? "done" : "error",
		errorText: snapshot.errorText,
		output: snapshot.finalText,
		sessionFilePath: snapshot.sessionFilePath,
	}),
	details: { id: snapshot.id, title: snapshot.title, status: snapshot.status },
});

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
	const delivery = createDeferredResultDelivery();
	const observedSettledIds = new Set<string>();
	let latestContext: ExtensionContext | undefined;

	const flush = (): void => {
		for (const payload of delivery.drain()) {
			pi.sendMessage(
				{
					customType: "subagent-result",
					content: payload.content,
					display: true,
					details: { id: payload.id, title: payload.title, status: payload.status },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}
	};

	const unsubscribe = manager.addChangeListener(() => {
		for (const snapshot of manager.list()) {
			if (snapshot.status === "running" || observedSettledIds.has(snapshot.id)) continue;
			observedSettledIds.add(snapshot.id);
			if (manager.consumedIds.has(snapshot.id)) delivery.consume(snapshot.id);
			else delivery.defer(snapshot.id, () => settledPayload(snapshot));
		}
		if (latestContext?.isIdle()) flush();
	});

	registerSubagentTools(pi, manager, delivery);
	pi.on("session_start", (_event, ctx) => { latestContext = ctx; });
	pi.on("agent_start", (_event, ctx) => { latestContext = ctx; });
	pi.on("agent_end", (_event, ctx) => {
		latestContext = ctx;
		flush();
	});
	// CONSCIOUS DIVERGENCE from background-tasks' reason-gated shutdown
	// (background-task-tool.ts:61-74): bg_task may leave children running on
	// /reload,/new,/fork because it recovers them from on-disk meta.json.
	// Subagents have NO persistent registry (durable reattach is a recorded
	// deferral in plan 065) — a child surviving a reload would be an orphaned,
	// unsupervised pi process nobody can harvest, steer, or stop, which is
	// worse than losing in-flight work. Kill on EVERY shutdown until a durable
	// registry exists; when it does, adopt the same reason gating as bg_task.
	pi.on("session_shutdown", () => {
		unsubscribe();
		delivery.clear();
		manager.disposeAll();
	});
	return manager;
}
