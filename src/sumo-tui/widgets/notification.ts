import type { Component } from "@earendil-works/pi-tui";

export type NotificationLevel = "info" | "success" | "warning" | "error";

export interface Toast {
	readonly id: number;
	readonly message: string;
	readonly level: NotificationLevel;
	readonly createdAt: number;
}

export interface NotificationCenterOptions {
	readonly defaultTimeoutMs?: number;
	readonly now?: () => number;
	readonly setTimeout?: typeof setTimeout;
	readonly clearTimeout?: typeof clearTimeout;
	readonly onChange?: () => void;
}

/**
 * Host notification model consumed by `RpcHostActions`, the RPC extension UI
 * responder, and the pi-compat ExtensionUI adapter. Issue 481 removed the
 * top-right toast surface: `render` never paints rows, while `notify` keeps
 * funneling host feedback and extension notify requests into one sink.
 */
export class NotificationCenter implements Component {
	private nextId = 1;

	public constructor(_options: NotificationCenterOptions = {}) {}

	public notify(_message: string, _level: NotificationLevel = "info", _timeoutMs?: number): number {
		return this.nextId++;
	}

	public dismiss(_id: number): void {}

	public clear(): void {}

	public getToasts(): readonly Toast[] {
		return [];
	}

	public invalidate(): void {}

	public render(_width: number): string[] {
		return [];
	}

	public dispose(): void {
		this.clear();
	}
}
