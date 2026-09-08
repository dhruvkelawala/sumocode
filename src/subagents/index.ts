import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activityFromSubagentSnapshot } from "../activity/subagent-adapter.js";
import { renderSubagentStatusRow, type SubagentStatusRunningEntry } from "../subagent-status-row.js";
import { logDiagnostic } from "../sumo-tui/runtime/diagnostics.js";
import { BUILT_IN_TOOLS, getBuiltInToolsFromActiveTools } from "../native-task-config.js";
import { getTerminalHost } from "../terminal-host/index.js";
import type { TerminalHost } from "../terminal-host/types.js";
import { spawnPaneChild } from "./backend-pane.js";
import { spawnPiChild } from "./backend-pi.js";
import { createDeferredResultDelivery, type DeliveryPayload } from "./delivery.js";
import type { SubagentSnapshot } from "./domain.js";
import { SubagentManager, type SubagentManagerDependencies } from "./manager.js";
import { buildSubagentResultMessage } from "./prompt.js";
import { registerSubagentTools } from "./tools.js";

export { SubagentManager } from "./manager.js";
export type { AtCapacityDetails, SpawnSubagentTask } from "./manager.js";

const LIFECYCLE_KEY = Symbol.for("@dhruvkelawala/sumocode/subagent-replacements");
function pendingReplacements(): Set<SubagentManager> {
	// SAFETY: only this module writes this namespaced host-owned set, including across reloads.
	const state = globalThis as typeof globalThis & { [LIFECYCLE_KEY]?: Set<SubagentManager> };
	return state[LIFECYCLE_KEY] ??= new Set();
}

const SUBAGENT_STATUS_WIDGET_KEY = "sumocode-subagents";
const SUBAGENT_DELIVERY_ERROR_MAX = 4_096;

/** Delivery `details` contract for a settled subagent result. */
interface SettledSubagentDetails {
	id: string;
	title: string;
	status: SubagentSnapshot["status"];
	roleId?: string;
	activity: ReturnType<typeof activityFromSubagentSnapshot>;
	manifest: SubagentSnapshot["manifest"];
	pane: SubagentSnapshot["pane"];
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
	const roleLine = snapshot.roleId ? `Role: ${snapshot.roleId}` : undefined;
	const metadata = [roleLine, paneLine].filter((line): line is string => line !== undefined).join("\n");
	const details: SettledSubagentDetails = {
		id: snapshot.id,
		title: snapshot.title,
		status: snapshot.status,
		activity: activityFromSubagentSnapshot(snapshot),
		manifest: snapshot.manifest,
		pane: snapshot.pane,
	};
	if (snapshot.roleId !== undefined) details.roleId = snapshot.roleId;
	return {
		id: snapshot.id,
		title: snapshot.title,
		status: snapshot.status,
		content: metadata ? `${result}\n\n${metadata}` : result,
		details,
	};
};

export interface SubagentsInstallOptions {
	readonly terminalHost?: TerminalHost;
	readonly spawnPaneChild?: typeof spawnPaneChild;
	readonly spawnPiChild?: typeof spawnPiChild;
	readonly managerDependencies?: SubagentManagerDependencies;
	/** Explicit trusted installation namespace; absent keeps production retention disabled. */
	readonly retainedRegistry?: import("./registry.js").SubagentRegistry;
}

export function installSubagents(pi: ExtensionAPI, options: SubagentsInstallOptions = {}): SubagentManager {
	const host = options.terminalHost ?? getTerminalHost();
	const spawnPane = options.spawnPaneChild ?? spawnPaneChild;
	const spawnHeadless = options.spawnPiChild ?? spawnPiChild;
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
			return spawnPane({
				prompt: task.prompt,
				name: task.title,
				cwd: task.cwd,
				id: task.id,
				model: task.model ?? inheritedModel,
				thinking: task.thinking ?? task.inherited?.thinking,
				tools: paneNarrowed ? paneBuiltIn : undefined,
				appendSystemPrompt: task.appendSystemPrompt,
				signal: task.signal,
				host,
				pi,
				placement: task.placement,
			});
		}
		return spawnHeadless({
			prompt: task.prompt,
			cwd: task.cwd,
			model: task.model,
			thinking: task.thinking,
			inherited: task.inherited ?? {},
			builtInTools: getBuiltInToolsFromActiveTools([...(task.builtInTools ?? [])]),
			appendSystemPrompt: task.appendSystemPrompt,
			signal: task.signal,
		});
	}, {
		terminalHost: host,
		pi,
		// Herdr injects the caller tab into the RPC child. Seed visible placement
		// with it so the first child is actually beside the operator instead of
		// disappearing into a background `subagents` tab.
		initialVisibleTabId: host.kind === "herdr" ? process.env.HERDR_TAB_ID : undefined,
		onDiagnostic: (diagnostic) => logDiagnostic("subagent_manager_diagnostic", { ...diagnostic }),
		...options.managerDependencies,
	});
	const delivery = createDeferredResultDelivery();
	const observedSettledIds = new Set<string>();
	let latestContext: ExtensionContext | undefined;
	let unsubscribe: (() => void) | undefined;
	let statusWidgetVisible = false;

	// Manager callbacks intentionally reuse only a context captured by a Pi
	// session event and cleared before shutdown. This is not an eager/module-load
	// UI call: both owned TUI and RPC need the manager event itself to surface and
	// clear asynchronous work while the parent is idle (live + PTY verified).
	const publishStatusWidget = (): void => {
		const ctx = latestContext;
		if (!ctx?.hasUI) return;
		const snapshots = manager.list();
		const active = snapshots.filter((snapshot) => snapshot.status === "running" || snapshot.status === "queued");
		try {
			if (active.length === 0) {
				if (statusWidgetVisible) ctx.ui.setWidget(SUBAGENT_STATUS_WIDGET_KEY, undefined, { placement: "aboveEditor" });
				statusWidgetVisible = false;
				return;
			}
			// The accepted strip contract is event-driven and explicitly has no age
			// timer: ages are approximate snapshots that advance on manager changes.
			// Avoid a background UI ticker solely for cosmetic elapsed-time drift.
			const now = Date.now();
			const running = active
				.filter((snapshot) => snapshot.status === "running")
				.map((snapshot) => {
					type MutableEntry = { -readonly [K in keyof SubagentStatusRunningEntry]: SubagentStatusRunningEntry[K] };
					const entry: MutableEntry = {
						id: snapshot.id,
						title: snapshot.title,
						ageMs: Math.max(0, now - snapshot.createdAt),
					};
					if (snapshot.roleId !== undefined) entry.roleId = snapshot.roleId;
					return entry;
				});
			const queuedCount = active.length - running.length;
			const render = (width: number) => renderSubagentStatusRow({ width, running, queuedCount });
			// Pi RPC supports setWidget string arrays only; component factories are
			// silently ignored (docs/rpc.md, Extension UI Protocol). Render a bounded
			// line in the child and let the retained host clip it to the real viewport.
			// TUI mode keeps the width-aware factory path.
			if (ctx.mode === "rpc") {
				ctx.ui.setWidget(SUBAGENT_STATUS_WIDGET_KEY, render(240), { placement: "aboveEditor" });
			} else {
				ctx.ui.setWidget(
					SUBAGENT_STATUS_WIDGET_KEY,
					() => ({ invalidate: () => undefined, render }),
					{ placement: "aboveEditor" },
				);
			}
			statusWidgetVisible = true;
		} catch {
			// Settlement delivery must survive UI adapter failures.
		}
	};

	const clearStatusWidget = (ctx: ExtensionContext | undefined): void => {
		if (!ctx?.hasUI || !statusWidgetVisible) return;
		try {
			ctx.ui.setWidget(SUBAGENT_STATUS_WIDGET_KEY, undefined, { placement: "aboveEditor" });
		} catch {
			// Session cleanup remains best-effort when the UI is already gone.
		}
		statusWidgetVisible = false;
	};

	const flush = (mayRetry = true): void => {
		try {
			delivery.flush((payload) => {
				if (!latestContext || !manager.canDeliver(payload.id)) return;
				manager.deliver(payload, (outgoing) => pi.sendMessage(
					{
						customType: outgoing.customType ?? "subagent-result",
						content: outgoing.content,
						display: true,
						details: outgoing.details,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				));
			});
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- ExtensionAPI.sendMessage may throw any JavaScript value at this effect boundary.
		} catch (error: unknown) {
			const message = (error instanceof Error ? error.message : String(error)).slice(0, SUBAGENT_DELIVERY_ERROR_MAX);
			logDiagnostic("subagent_delivery_failed", { message });
			if (mayRetry) queueMicrotask(() => { flush(false); });
		}
	};

	const onManagerChange = (): void => {
		for (const snapshot of manager.list()) {
			if (snapshot.status === "running" || snapshot.status === "queued" || observedSettledIds.has(snapshot.id)) continue;
			observedSettledIds.add(snapshot.id);
			if (manager.consumedIds.has(snapshot.id) || !manager.canDeliver(snapshot.id)) delivery.consume(snapshot.id);
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
		publishStatusWidget();
		if (latestContext?.isIdle()) flush();
	};

	/**
	 * Arm the delivery listener for this factory instance. Pi 0.80.6 recreates
	 * extension factories for /new, /resume, and /fork; RPC mode may still bind
	 * session_start more than once on the new instance, so this remains
	 * idempotent. Mark only pre-existing terminal snapshots consumed; running
	 * children must remain eligible to deliver when this manager is reused.
	 */
	const armDelivery = (): void => {
		if (unsubscribe) return;
		for (const snapshot of manager.list()) {
			if (snapshot.status !== "done" && snapshot.status !== "error") continue;
			observedSettledIds.add(snapshot.id);
			delivery.consume(snapshot.id);
		}
		unsubscribe = manager.addChangeListener(onManagerChange);
	};
	armDelivery();

	registerSubagentTools(pi, manager, delivery, host);
	pi.on("session_start", async (_event, ctx) => {
		latestContext = ctx;
		armDelivery();
		for (const previous of pendingReplacements()) {
			try {
				await manager.adoptFrom(previous, ctx.sessionManager.getSessionId());
			} catch {
				// A corrupt or conflicting replacement must degrade this startup, not wedge every later replacement.
				logDiagnostic("subagent_startup_recovery_refused", { scope: "adoption" });
			} finally {
				pendingReplacements().delete(previous);
			}
		}
		if (options.retainedRegistry) {
			try {
				await manager.reconstruct(options.retainedRegistry, ctx.sessionManager.getSessionId());
			} catch {
				// Corrupt retained evidence stays on disk for inspection; startup still publishes status and delivery.
				logDiagnostic("subagent_startup_recovery_refused", { scope: "reconstruction" });
			}
		}
		publishStatusWidget();
		if (ctx.isIdle()) flush();
	});
	pi.on("agent_start", (_event, ctx) => { latestContext = ctx; });
	pi.on("agent_end", (_event, ctx) => {
		latestContext = ctx;
		flush();
	});
	pi.on("session_shutdown", (event) => {
		clearStatusWidget(latestContext);
		latestContext = undefined;
		unsubscribe?.();
		unsubscribe = undefined;
		delivery.clear();
		if (["new", "fork", "resume", "reload"].includes(event.reason)) {
			// Defer detachment until session_start identifies a distinct successor; Pi may reuse this manager.
			manager.prepareForReplacement();
			pendingReplacements().add(manager);
		} else manager.disposeAll();
	});
	return manager;
}
