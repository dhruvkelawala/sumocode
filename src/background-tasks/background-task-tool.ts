import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TerminalTaskManager, type TerminalTaskManagerOptions } from "./task-manager.js";

export function installBackgroundTasks(
	pi: ExtensionAPI,
	managerOptions: TerminalTaskManagerOptions = {},
): TerminalTaskManager {
	const manager = new TerminalTaskManager(managerOptions);

	pi.on("session_shutdown", async (event, ctx) => {
		const reason = (event as { reason?: string } | null | undefined)?.reason;
		if (reason === "quit" || reason === undefined) {
			await manager.stopOwned(ctx.sessionManager.getSessionId());
		}
		// Replacement never signals children. It only retires this extension
		// instance's observers; the newly bound manager recovers the same durable
		// records without competing stale-revision pollers.
		manager.detach();
	});

	return manager;
}
