import type { NotificationLevel } from "../widgets/notification.js";

export interface ErrorNotifier {
	notify(message: string, level?: NotificationLevel): void;
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
	} catch (cause) {
		// Default to error, not warning: every caller of a function named
		// `notifyOnError` is reporting a failure, and an unmarked failure must
		// render as a sticky error notice (issue 481 home B) rather than a
		// 3s transient hint that silently rots future call sites the same way.
		notifier.notify(`${options.prefix ?? "rpc error"}: ${errorMessage(cause)}`, options.level ?? "error");
	}
}
