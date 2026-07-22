import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TerminalTaskManager, type TerminalTaskManagerOptions } from "./task-manager.js";

interface ProcessTerminalLifecycle {
	readonly ownerSessionIds: Set<string>;
}

const PROCESS_LIFECYCLE_KEY = Symbol.for("@dhruvkelawala/sumocode/terminal-process-lifecycle");

function processLifecycle(): ProcessTerminalLifecycle {
	const global = globalThis as typeof globalThis & { [PROCESS_LIFECYCLE_KEY]?: ProcessTerminalLifecycle };
	return global[PROCESS_LIFECYCLE_KEY] ??= { ownerSessionIds: new Set<string>() };
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
			manager.detach();
		}
	});

	return manager;
}
