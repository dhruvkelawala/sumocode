import type { NotificationLevel } from "../widgets/notification.js";

export interface ErrorNotifier {
	notify(message: string, level?: NotificationLevel): void;
	/**
	 * Optional cleanup hook a completed host action calls to supersede the
	 * previous sticky failure (issue 481 home B). Absent on notifiers that do
	 * not own a notice slot (test doubles, plain adapters).
	 */
	dismissSticky?(): void;
}

export interface NotifyOnErrorOptions {
	readonly prefix?: string;
	readonly level?: NotificationLevel;
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export async function notifyOnError(
	action: () => void | Promise<void>,
	notifier: ErrorNotifier,
	options: NotifyOnErrorOptions = {},
): Promise<void> {
	try {
		await action();
		// A successful host action is exactly the "next host action" that
		// supersedes a stale sticky failure: clear it only after the action
		// really completed, so a failure (below) re-arms its own notice and an
		// internal transient warning is left alone (dismissSticky only clears
		// sticky notices).
		notifier.dismissSticky?.();
	} catch (cause) {
		// Default to error, not warning: every caller of a function named
		// `notifyOnError` is reporting a failure, and an unmarked failure must
		// render as a sticky error notice (issue 481 home B) rather than a
		// 3s transient hint that silently rots future call sites the same way.
		notifier.notify(`${options.prefix ?? "rpc error"}: ${errorMessage(cause)}`, options.level ?? "error");
	}
}
