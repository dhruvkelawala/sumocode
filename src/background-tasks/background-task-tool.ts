import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TerminalTaskManager, type TerminalTaskManagerOptions } from "./task-manager.js";

interface ProcessTerminalLifecycle {
	ownerSessionIds: Set<string>;
	activityWriterTokens: Map<string, string>;
}

const PROCESS_LIFECYCLE_KEY = Symbol.for("@dhruvkelawala/sumocode/terminal-process-lifecycle");

function processLifecycle(): ProcessTerminalLifecycle {
	const global = globalThis as typeof globalThis & {
		[PROCESS_LIFECYCLE_KEY]?: Partial<ProcessTerminalLifecycle>;
	};
	const lifecycle = global[PROCESS_LIFECYCLE_KEY] ??= {};
	// Symbol.for state intentionally survives module/factory reloads. Normalize
	// the pre-Plan-081 shape, which had only ownerSessionIds, before using the
	// writer-token map added by the Activity lease integration.
	lifecycle.ownerSessionIds ??= new Set<string>();
	lifecycle.activityWriterTokens ??= new Map<string, string>();
	return lifecycle as ProcessTerminalLifecycle;
}

/** Session IDs this Pi process has actually owned through a session_start event. */
export function processOwnedTerminalSessionIds(): readonly string[] {
	return [...processLifecycle().ownerSessionIds];
}

/** Serialize one Activity feed bridge per owned session inside this Pi process. */
export function claimProcessActivitySession(ownerSessionId: string, token: string): boolean {
	const lifecycle = processLifecycle();
	if (!lifecycle.ownerSessionIds.has(ownerSessionId)) return false;
	const current = lifecycle.activityWriterTokens.get(ownerSessionId);
	if (current !== undefined && current !== token) return false;
	lifecycle.activityWriterTokens.set(ownerSessionId, token);
	return true;
}

export function releaseProcessActivitySession(ownerSessionId: string, token: string): void {
	const lifecycle = processLifecycle();
	if (lifecycle.activityWriterTokens.get(ownerSessionId) === token) lifecycle.activityWriterTokens.delete(ownerSessionId);
}

export function installBackgroundTasks(
	pi: ExtensionAPI,
	managerOptions: TerminalTaskManagerOptions = {},
): TerminalTaskManager {
	const manager = new TerminalTaskManager(managerOptions);
	const lifecycle = processLifecycle();

	pi.on("session_start", (_event, ctx) => {
		const ownerSessionId = ctx.sessionManager.getSessionId();
		if (ownerSessionId) lifecycle.ownerSessionIds.add(ownerSessionId);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		const reason = (event as { reason?: string } | null | undefined)?.reason;
		if (reason !== "quit") {
			// Pi 0.80.6 recreates the extension factory/manager for /new, /resume,
			// and /fork. Detach this invalidated instance's pollers without stopping
			// durable children; the replacement manager adopts them from the store.
			manager.detach();
			return;
		}
		const currentSessionId = ctx.sessionManager.getSessionId();
		if (currentSessionId) lifecycle.ownerSessionIds.add(currentSessionId);
		try {
			// The registry is process-global (not merely module-global) so even an
			// extension reload that reevaluates this module retains quit ownership.
			await Promise.all([...lifecycle.ownerSessionIds].map((ownerSessionId) => manager.stopOwned(ownerSessionId)));
		} finally {
			lifecycle.ownerSessionIds.clear();
			lifecycle.activityWriterTokens.clear();
			manager.detach();
		}
	});

	return manager;
}
