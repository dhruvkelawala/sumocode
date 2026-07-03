import type { NotificationLevel } from "../widgets/notification.js";

export interface ErrorNotifier {
	notify(message: string, level?: NotificationLevel): unknown;
}

export interface NotifyOnErrorOptions {
	readonly prefix?: string;
	readonly level?: NotificationLevel;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function notifyOnError(
	action: () => void | Promise<void>,
	notifier: ErrorNotifier,
	options: NotifyOnErrorOptions = {},
): Promise<void> {
	try {
		await action();
	} catch (error) {
		notifier.notify(`${options.prefix ?? "rpc error"}: ${errorMessage(error)}`, options.level ?? "warning");
	}
}
