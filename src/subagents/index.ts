import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BUILT_IN_TOOLS, getBuiltInToolsFromActiveTools } from "../native-task-config.js";
import { getTerminalHost } from "../terminal-host/index.js";
import { spawnPaneChild } from "./backend-pane.js";
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

const settledPayload = (snapshot: SubagentSnapshot): DeliveryPayload => {
	const result = buildSubagentResultMessage({
		id: snapshot.id,
		title: snapshot.title,
		status: snapshot.status === "done" ? "done" : "error",
		errorText: snapshot.errorText,
		output: snapshot.finalText,
		sessionFilePath: snapshot.sessionFilePath,
		manifest: snapshot.manifest,
	});
	const paneLine = snapshot.pane
		? `Pane: ${snapshot.pane.paneId ?? snapshot.pane.tabId ?? snapshot.pane.workspaceId ?? "unknown"} · agent ${snapshot.pane.agentName}`
		: undefined;
	return {
		id: snapshot.id,
		customType: "subagent-result",
		title: snapshot.title,
		status: snapshot.status,
		content: paneLine ? `${result}\n\n${paneLine}` : result,
		details: {
			id: snapshot.id,
			title: snapshot.title,
			status: snapshot.status,
			manifest: snapshot.manifest,
			...(snapshot.pane ? { pane: snapshot.pane } : {}),
		},
	};
};

export function installSubagents(
	pi: ExtensionAPI,
	sharedDelivery?: DeferredResultDelivery,
): SubagentManager {
	const host = getTerminalHost();
	const manager = new SubagentManager((task) => {
		if (task.visible) {
			if (!task.placement) {
				return {
					events: (emit) => emit({ kind: "run-settled", outcome: { kind: "failed", errorText: "visible subagent placement was not resolved" } }),
					interrupt: () => undefined,
				};
			}
			// Mirror the headless child's inheritance: explicit overrides win, else
			// the parent session's model/thinking flow through (PR #335 review —
			// visible children must not silently reset to defaults).
			const inheritedModel = task.inherited?.model ? `${task.inherited.model.provider}/${task.inherited.model.id}` : undefined;
			// pi's --tools is an allowlist across built-in AND extension tools, so
			// forwarding the parent's full built-in set would strip the child's
			// extension tools for nothing. Only a NARROWED parent narrows the
			// child (fail-closed: the restricted child also loses extension tools,
			// which is the conservative direction — extension tools like bg_start
			// are shell-execution escapes a --tools read parent must not grant).
			const paneBuiltIn = getBuiltInToolsFromActiveTools([...(task.builtInTools ?? [])]);
			// Derived from the canonical list: a literal count would fail OPEN if
			// the built-in set ever grows (full-set parents would look narrowed-
			// by-one and vice versa).
			//
			// Known conservative edge: a parent whose config disables some built-in
			// (without any security intent) also counts as "narrowed", so its
			// visible children get --tools and lose extension tools. That degrades
			// toward LESS access, never more — acceptable until pi grows a
			// built-ins-only restriction flag.
			const paneNarrowed = task.builtInTools !== undefined && paneBuiltIn.length < BUILT_IN_TOOLS.length;
			return spawnPaneChild({
				prompt: task.prompt,
				name: task.title,
				cwd: task.cwd,
				id: task.id,
				model: task.model ?? inheritedModel,
				thinking: task.thinking ?? task.inherited?.thinking,
				tools: paneNarrowed ? paneBuiltIn : undefined,
				signal: task.signal,
				host,
				pi,
				placement: task.placement,
			});
		}
		return spawnPiChild({
			prompt: task.prompt,
			cwd: task.cwd,
			model: task.model,
			thinking: task.thinking,
			inherited: task.inherited ?? {},
			builtInTools: getBuiltInToolsFromActiveTools([...(task.builtInTools ?? [])]),
			signal: task.signal,
		});
	}, { terminalHost: host, pi });
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

	registerSubagentTools(pi, manager, delivery, host);
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
