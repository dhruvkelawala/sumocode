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
		notifier.notify(`${options.prefix ?? "rpc error"}: ${errorMessage(cause)}`, options.level ?? "warning");
	}
}
