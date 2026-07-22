import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TerminalTaskManager, type TerminalTaskManagerOptions } from "./task-manager.js";

export function installBackgroundTasks(
	pi: ExtensionAPI,
	managerOptions: TerminalTaskManagerOptions = {},
): TerminalTaskManager {
	const manager = new TerminalTaskManager(managerOptions);
	const processSessionIds = new Set<string>();

	pi.on("session_start", (_event, ctx) => {
		const ownerSessionId = ctx.sessionManager.getSessionId();
		if (ownerSessionId) processSessionIds.add(ownerSessionId);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		const reason = (event as { reason?: string } | null | undefined)?.reason;
		if (reason !== "quit") {
			// Pi rebinds the surviving extension runtime across ordinary session
			// replacement. Keep its one manager/poller set alive; delivery separately
			// unbinds the old session and session_start binds the next context.
			return;
		}
		const currentSessionId = ctx.sessionManager.getSessionId();
		if (currentSessionId) processSessionIds.add(currentSessionId);
		await Promise.all([...processSessionIds].map((ownerSessionId) => manager.stopOwned(ownerSessionId)));
		manager.detach();
	});

	return manager;
}
