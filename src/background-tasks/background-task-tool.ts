import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TerminalTaskManager, type TerminalTaskManagerOptions } from "./task-manager.js";

export function installBackgroundTasks(
	pi: ExtensionAPI,
	managerOptions: TerminalTaskManagerOptions = {},
): TerminalTaskManager {
	const manager = new TerminalTaskManager(managerOptions);

	pi.on("session_shutdown", async (event, ctx) => {
		const reason = (event as { reason?: string } | null | undefined)?.reason;
		if (reason !== "quit") return;
		await manager.stopOwned(ctx.sessionManager.getSessionId());
		manager.detach();
	});

	return manager;
}
