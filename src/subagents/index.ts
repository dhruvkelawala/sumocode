import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getBuiltInToolsFromActiveTools } from "../native-task-config.js";
import { spawnPiChild } from "./backend-pi.js";
import {
	createDeferredResultDelivery,
	type DeferredResultDelivery,
	type DeliveryPayload,
} from "./delivery.js";
import type { SubagentSnapshot } from "./domain.js";
import { SubagentManager } from "./manager.js";
import { buildSubagentResultMessage } from "./prompt.js";
import { registerSubagentTools } from "./tools.js";

export { SubagentManager } from "./manager.js";
export type { AtCapacityDetails, SpawnSubagentTask } from "./manager.js";

const deliveryFlushers = new WeakMap<DeferredResultDelivery, () => void>();

/** Request the shared 066 flusher after an external producer defers a result. */
export function flushDeferredResultDelivery(delivery: DeferredResultDelivery): void {
	deliveryFlushers.get(delivery)?.();
}

const settledPayload = (snapshot: SubagentSnapshot): DeliveryPayload => ({
	id: snapshot.id,
	customType: "subagent-result",
	title: snapshot.title,
	status: snapshot.status,
	content: buildSubagentResultMessage({
		id: snapshot.id,
		title: snapshot.title,
		status: snapshot.status === "done" ? "done" : "error",
		errorText: snapshot.errorText,
		output: snapshot.finalText,
		sessionFilePath: snapshot.sessionFilePath,
		manifest: snapshot.manifest,
	}),
	details: { id: snapshot.id, title: snapshot.title, status: snapshot.status, manifest: snapshot.manifest },
});

export function installSubagents(
	pi: ExtensionAPI,
	sharedDelivery?: DeferredResultDelivery,
): SubagentManager {
	const manager = new SubagentManager((task) => spawnPiChild({
		prompt: task.prompt,
		cwd: task.cwd,
		model: task.model,
		thinking: task.thinking,
		inherited: task.inherited ?? {},
		builtInTools: getBuiltInToolsFromActiveTools([...(task.builtInTools ?? [])]),
		signal: task.signal,
	}));
	const ownsDelivery = sharedDelivery === undefined;
	const delivery = sharedDelivery ?? createDeferredResultDelivery();
	const observedSettledIds = new Set<string>();
	let latestContext: ExtensionContext | undefined;
	let unsubscribe: (() => void) | undefined;

	const flush = (): void => {
		for (const payload of delivery.drain()) {
			pi.sendMessage(
				{
					customType: payload.customType ?? "subagent-result",
					content: payload.content,
					display: true,
					details: payload.details,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}
	};

	deliveryFlushers.set(delivery, () => {
		if (latestContext?.isIdle()) flush();
	});

	const onManagerChange = (): void => {
		for (const snapshot of manager.list()) {
			if (snapshot.status === "running" || observedSettledIds.has(snapshot.id)) continue;
			observedSettledIds.add(snapshot.id);
			if (manager.consumedIds.has(snapshot.id)) delivery.consume(snapshot.id);
			else delivery.defer(snapshot.id, () => settledPayload(snapshot));
		}
		// Prune the mirror sets in lockstep with the manager's MAX_TRACKED prune
		// so a long-lived session's per-spawn tracking cannot grow unbounded.
		const liveIds = new Set(manager.list().map((snapshot) => snapshot.id));
		for (const id of observedSettledIds) {
			if (!liveIds.has(id)) {
				observedSettledIds.delete(id);
				delivery.forget(id);
			}
		}
		if (latestContext?.isIdle()) flush();
	};

	/**
	 * (Re)arm the delivery listener. session_shutdown fires for in-process
	 * session switches (/new, /resume, /fork) too — the extension instance and
	 * its tools SURVIVE those, so a one-shot unsubscribe would silently kill
	 * auto-delivery for the rest of the process lifetime. On every
	 * session_start we re-subscribe, and first mark every snapshot that
	 * already exists as observed+consumed so settlements belonging to the
	 * PREVIOUS session (e.g. children interrupted during the switch, folding
	 * after shutdown) are never delivered into the new session as stale noise.
	 */
	const armDelivery = (): void => {
		if (unsubscribe) return;
		for (const snapshot of manager.list()) {
			observedSettledIds.add(snapshot.id);
			delivery.consume(snapshot.id);
		}
		unsubscribe = manager.addChangeListener(onManagerChange);
	};
	armDelivery();

	registerSubagentTools(pi, manager, delivery);
	pi.on("session_start", (_event, ctx) => {
		latestContext = ctx;
		armDelivery();
		if (ctx.isIdle()) flush();
	});
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
		latestContext = undefined;
		unsubscribe?.();
		unsubscribe = undefined;
		if (ownsDelivery) {
			delivery.clear();
		} else {
			// A shared buffer may hold durable terminal completions. Drop stale
			// subagent payloads at the session boundary without erasing terminals.
			const terminalPayloads = delivery.drain().filter((payload) => payload.customType === "terminal-result");
			delivery.clear();
			for (const payload of terminalPayloads) delivery.defer(payload.id, () => payload);
		}
		manager.disposeAll();
	});
	return manager;
}
