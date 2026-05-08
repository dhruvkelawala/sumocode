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

const LEVEL_PREFIX: Record<NotificationLevel, string> = {
	info: "ⓘ",
	success: "✓",
	warning: "⚠",
	error: "✖",
};

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function truncateVisible(text: string, width: number): string {
	const plain = stripAnsi(text);
	if (plain.length <= width) return text;
	if (width <= 1) return "…";
	return `${plain.slice(0, width - 1)}…`;
}

function pad(text: string, width: number): string {
	const visible = stripAnsi(text).length;
	return visible >= width ? text : `${text}${" ".repeat(width - visible)}`;
}

/** Minimal top-right toast stack used by the Phase 4 ExtensionUI adapter. */
export class NotificationCenter implements Component {
	private readonly defaultTimeoutMs: number;
	private readonly getNow: () => number;
	private readonly setTimer: typeof setTimeout;
	private readonly clearTimer: typeof clearTimeout;
	private readonly onChange: () => void;
	private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
	private readonly toasts: Toast[] = [];
	private nextId = 1;

	public constructor(options: NotificationCenterOptions = {}) {
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? 3_000;
		this.getNow = options.now ?? Date.now;
		this.setTimer = options.setTimeout ?? setTimeout;
		this.clearTimer = options.clearTimeout ?? clearTimeout;
		this.onChange = options.onChange ?? (() => undefined);
	}

	public notify(message: string, level: NotificationLevel = "info", timeoutMs = this.defaultTimeoutMs): number {
		const id = this.nextId++;
		this.toasts.push({ id, message, level, createdAt: this.getNow() });
		if (timeoutMs > 0) {
			const timer = this.setTimer(() => this.dismiss(id), timeoutMs);
			timer.unref?.();
			this.timers.set(id, timer);
		}
		this.onChange();
		return id;
	}

	public dismiss(id: number): void {
		const index = this.toasts.findIndex((toast) => toast.id === id);
		if (index === -1) return;
		this.toasts.splice(index, 1);
		const timer = this.timers.get(id);
		if (timer) this.clearTimer(timer);
		this.timers.delete(id);
		this.onChange();
	}

	public clear(): void {
		for (const timer of this.timers.values()) this.clearTimer(timer);
		this.timers.clear();
		this.toasts.length = 0;
		this.onChange();
	}

	public getToasts(): readonly Toast[] {
		return this.toasts;
	}

	public invalidate(): void {}

	public render(width: number): string[] {
		if (this.toasts.length === 0 || width <= 0) return [];
		const boxWidth = Math.min(Math.max(24, Math.floor(width * 0.45)), width);
		const leftPad = Math.max(0, width - boxWidth);
		const indent = " ".repeat(leftPad);
		return this.toasts.slice(-4).map((toast) => {
			const content = `${LEVEL_PREFIX[toast.level]} ${toast.message}`;
			const text = truncateVisible(content, Math.max(0, boxWidth - 2));
			return `${indent} ${pad(text, boxWidth - 1)}`;
		});
	}

	public dispose(): void {
		this.clear();
	}
}
