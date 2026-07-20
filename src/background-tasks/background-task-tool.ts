import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BackgroundTaskManager, type BackgroundTaskManagerOptions } from "./task-manager.js";

export function installBackgroundTasks(
	pi: ExtensionAPI,
	managerOptions: BackgroundTaskManagerOptions = {},
): BackgroundTaskManager {
	const manager = new BackgroundTaskManager(pi, managerOptions);

	// `session_shutdown` fires not only on process exit but also during
	// /reload, /new, /resume, /fork (Pi tears down and rebinds the extension
	// runtime). If we killed every running task on those events, a user
	// reloading SumoCode would lose every long-running background terminal they
	// had in flight. Only kill on a real process-quit shutdown; on session
	// replacement, leave the child processes running (they're already detached
	// or terminal-host-owned) and let the new manager recover from persisted
	// meta.json on startup.
	pi.on("session_shutdown", (event) => {
		const reason = (event as { reason?: string } | null | undefined)?.reason;
		if (reason === "quit" || reason === undefined) {
			manager.shutdown();
		}
	});

	pi.registerCommand("bg", {
		description: "List tracked background tasks (use /ps for the full process viewer)",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`${manager.formatTaskListText()}\nUse /ps for the full process viewer.`, "info");
		},
	});

	return manager;
}
