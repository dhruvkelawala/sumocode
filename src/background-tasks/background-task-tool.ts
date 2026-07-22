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
			manager.detach();
		}
		// Replacement clears only the delivery binding in terminal-tools.ts.
		// Running children and their lifecycle observers remain intact.
	});

	return manager;
}
