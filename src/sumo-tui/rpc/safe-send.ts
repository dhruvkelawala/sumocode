import type { NotificationLevel } from "../widgets/notification.js";

export interface ErrorNotifier {
	notify(message: string, level?: NotificationLevel): void;
	/**
	 * Optional cleanup hook a starting host action calls to supersede the
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
	// A new host action is exactly the "next host action" that supersedes a
	// stale sticky failure (issue 481 home B), so clear it at ENTRY. Clearing
	// after the action would clobber a notice the action itself raised: host
	// commands report validation rejections by returning normally while
	// raising a sticky (`unknown command`, `unknown model`, `unknown thinking
	// level`, `memory unavailable`, `login already in progress`), and those
	// notices are the home B error surface. Anything the action raises below
	// therefore survives; a failure (catch) re-arms its own notice.
	notifier.dismissSticky?.();
	try {
		await action();
	} catch (cause) {
		// Default to error, not warning: every caller of a function named
		// `notifyOnError` is reporting a failure, and an unmarked failure must
		// render as a sticky error notice (issue 481 home B) rather than a
		// 3s transient hint that silently rots future call sites the same way.
		notifier.notify(`${options.prefix ?? "rpc error"}: ${errorMessage(cause)}`, options.level ?? "error");
	}
}
