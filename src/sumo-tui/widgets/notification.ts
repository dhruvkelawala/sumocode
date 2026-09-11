import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { activeThemeColors } from "../../themes/index.js";
import { lineToAnsi, textLine } from "../render/primitives.js";

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

const DEFAULT_NOTICE_TIMEOUT_MS = 3_000;

/** Named inputs for {@link NotificationCenter.notify}. */
export interface NotifyOptions {
	/**
	 * Explicit sticky request: paint above the input frame and survive
	 * keystrokes and expiry until Escape or the next host action clears it.
	 * Errors are sticky without this flag; a plain timeout of 0 is not a
	 * sticky request.
	 */
	readonly sticky?: boolean;
	/** Override the default transient expiry. Ignored for sticky notices. */
	readonly timeoutMs?: number;
}

/**
 * The one live host notice. Issue 481 replaced the top-right toast stack with
 * two surfaces fed from this single slot: transient hints paint in the
 * belowEditor hint row, sticky failures paint as a notice above the input
 * frame (see `renderHostNotice`). Notices are last-writer-wins -- a repeat of
 * the live notice refreshes its expiry instead of stacking.
 */
export interface HostNotice {
	readonly message: string;
	readonly level: NotificationLevel;
	/** Sticky notices survive keystrokes and expiry; only Escape or the next host action clears them. */
	readonly sticky: boolean;
}

/**
 * Host notification model consumed by `RpcHostActions`, the RPC extension UI
 * responder, and the pi-compat ExtensionUI adapter. Issue 481 removed the
 * top-right toast surface: `render` is intentionally empty and `getToasts`
 * stays empty forever, while `notify` keeps funneling host feedback and
 * extension notify requests into one last-writer-wins notice slot.
 */
export class NotificationCenter implements Component {
	private readonly defaultTimeoutMs: number;
	private readonly setTimer: typeof setTimeout;
	private readonly clearTimer: typeof clearTimeout;
	private readonly onChange: () => void;
	private notice: HostNotice | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private noticeId = 0;
	private nextId = 1;

	public constructor(options: NotificationCenterOptions = {}) {
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_NOTICE_TIMEOUT_MS;
		this.setTimer = options.setTimeout ?? setTimeout;
		this.clearTimer = options.clearTimeout ?? clearTimeout;
		this.onChange = options.onChange ?? (() => undefined);
	}

	/**
	 * Records the live host notice. Errors are sticky, an explicit
	 * `options.sticky` makes any level sticky, and everything else is a
	 * transient hint that expires after `options.timeoutMs` (default 3s).
	 */
	public notify(message: string, level: NotificationLevel = "info", options: NotifyOptions = {}): number {
		const sticky = level === "error" || options.sticky === true;
		const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
		if (this.notice?.message === message && this.notice.level === level && this.notice.sticky === sticky) {
			this.armExpiry(sticky ? 0 : timeoutMs);
			return this.noticeId;
		}
		this.notice = { message, level, sticky };
		this.noticeId = this.nextId++;
		this.armExpiry(sticky ? 0 : timeoutMs);
		this.onChange();
		return this.noticeId;
	}

	public getNotice(): HostNotice | undefined {
		return this.notice;
	}

	public dismiss(id: number): void {
		if (id !== this.noticeId) return;
		this.clearNotice();
	}

	/** Keystroke dismissal: transient hints go, sticky failures stay. */
	public dismissTransient(): void {
		if (this.notice?.sticky !== false) return;
		this.clearNotice();
	}

	/** Escape / next-host-action dismissal: sticky failures go, a live hint stays. */
	public dismissSticky(): void {
		if (this.notice?.sticky !== true) return;
		this.clearNotice();
	}

	public clear(): void {
		if (this.notice === undefined) return;
		this.clearNotice();
	}

	/** The removed toast surface: retained as an always-empty compatibility read. */
	public getToasts(): readonly Toast[] {
		return [];
	}

	public invalidate(): void {}

	public render(_width: number): string[] {
		return [];
	}

	public dispose(): void {
		this.clearNotice();
	}

	private clearNotice(): void {
		if (this.timer !== undefined) this.clearTimer(this.timer);
		this.timer = undefined;
		this.notice = undefined;
		this.noticeId = 0;
		this.onChange();
	}

	private armExpiry(timeoutMs: number): void {
		if (this.timer !== undefined) this.clearTimer(this.timer);
		this.timer = undefined;
		if (timeoutMs <= 0) return;
		const timer = this.setTimer(() => {
			this.timer = undefined;
			this.clearNotice();
		}, timeoutMs);
		timer.unref?.();
		this.timer = timer;
	}
}

/**
 * Renders a sticky host notice as above-the-input rows. This is the sibling
 * render of `InputRecoveryNotice` (same text wrap, same surface fill) with the
 * rust/approval tone; the router-owned recovery notice keeps its own lifecycle.
 */
export function renderHostNotice(notice: HostNotice, width: number): string[] {
	if (!notice.message || width <= 0) return [];
	const colors = activeThemeColors();
	return wrapTextWithAnsi(notice.message, width).map((text) => lineToAnsi(textLine([text], {
		fg: colors.states.approval, bg: colors.surface,
	}), { width }));
}
