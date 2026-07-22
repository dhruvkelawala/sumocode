import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activityFromSubagentSnapshot } from "../activity/subagent-adapter.js";
import { BUILT_IN_TOOLS, getBuiltInToolsFromActiveTools } from "../native-task-config.js";
import { getTerminalHost } from "../terminal-host/index.js";
import { spawnPaneChild } from "./backend-pane.js";
import { spawnPiChild } from "./backend-pi.js";
import { createDeferredResultDelivery, type DeliveryPayload } from "./delivery.js";
import type { SubagentSnapshot } from "./domain.js";
import { SubagentManager } from "./manager.js";
import { buildSubagentResultMessage } from "./prompt.js";
import { registerSubagentTools } from "./tools.js";

export { SubagentManager } from "./manager.js";
export type { AtCapacityDetails, SpawnSubagentTask } from "./manager.js";

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
		title: snapshot.title,
		status: snapshot.status,
		content: paneLine ? `${result}\n\n${paneLine}` : result,
		details: {
			id: snapshot.id,
			title: snapshot.title,
			status: snapshot.status,
			activity: activityFromSubagentSnapshot(snapshot),
			manifest: snapshot.manifest,
			...(snapshot.pane ? { pane: snapshot.pane } : {}),
		},
	};
};

export function installSubagents(pi: ExtensionAPI): SubagentManager {
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
			// which is the conservative direction — extension tools like terminal_start
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
	const delivery = createDeferredResultDelivery();
	const observedSettledIds = new Set<string>();
	let latestContext: ExtensionContext | undefined;
	let unsubscribe: (() => void) | undefined;

	const flush = (): void => {
		for (const payload of delivery.drain()) {
			pi.sendMessage(
				{
					customType: "subagent-result",
					content: payload.content,
					display: true,
					details: payload.details,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}
	};

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
	 * Arm the delivery listener for this factory instance. Pi 0.80.6 recreates
	 * extension factories for /new, /resume, and /fork; RPC mode may still bind
	 * session_start more than once on the new instance, so this remains
	 * idempotent. Mark pre-existing snapshots consumed so a repeated bind cannot
	 * deliver stale settlement noise into the active session.
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
	// CONSCIOUS DIVERGENCE from durable terminal shutdown: terminal tasks
	// detach their replaced manager and leave children running across
	// /reload,/new,/resume,/fork because the next manager adopts on-disk state.
	// Subagents have NO persistent registry (durable reattach is a recorded
	// deferral in plan 065) — a child surviving a reload would be an orphaned,
	// unsupervised pi process nobody can harvest, steer, or stop, which is
	// worse than losing in-flight work. Kill on EVERY shutdown until a durable
	// registry exists; when it does, adopt the terminal lifecycle model.
	pi.on("session_shutdown", () => {
		latestContext = undefined;
		unsubscribe?.();
		unsubscribe = undefined;
		delivery.clear();
		manager.disposeAll();
	});
	return manager;
}
