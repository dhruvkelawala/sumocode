import { Key, matchesKey } from "@earendil-works/pi-tui";
import { normalizeRawMultilinePasteInput } from "../../cathedral/multiline-paste.js";
import { logDiagnostic } from "../runtime/diagnostics.js";
import { chatScrollCommandFromInput } from "../widgets/chat-scroll-command.js";
import type { KeyEvent } from "./key-router.js";
import { parseSgrMouseStream, type MouseEvent } from "./mouse.js";

export interface SharedInputRouterResult {
	readonly consume?: boolean;
	readonly data?: string;
	readonly forwarded?: boolean;
}

export interface SharedInputRouterCallbacks {
	readonly openCommandPalette?: () => void | Promise<void>;
	readonly requestRender?: () => void;
	readonly requestExit?: (code: number) => void;
	readonly handleFocusedModalInput?: (data: string) => boolean | void;
	readonly handleFocusedOverlayInput?: (data: string) => boolean | void;
	readonly handlePreEditorInput?: (data: string) => boolean | void;
	readonly handleMouseEvent?: (event: MouseEvent) => boolean | void;
	readonly scheduleMouseRender?: () => void;
	readonly handleChatScrollKey?: (event: KeyEvent) => boolean | void;
	readonly handleSelectionKey?: (event: KeyEvent) => boolean | void;
	readonly forwardToEditor?: (data: string) => boolean | void;
	readonly forwardToPi?: (data: string) => boolean | void;
	readonly handleUnhandledInput?: (data: string) => boolean | void;
	readonly dispatchDelayedInput?: (data: string) => boolean | void;
}

interface MouseInputDiagnosticsFields {
	readonly dataLength: number;
	readonly sourceLength: number;
	readonly eventCount: number;
	readonly consumed: boolean;
	readonly pendingLength: number;
	readonly leftoverLength: number;
	readonly sourceHex: string;
	readonly leftoverHex: string;
}

const COMPLETE_SGR_MOUSE_SEQUENCE = /\x1b\[<\d+;\d+;\d+[Mm]/g;
const BARE_ESCAPE_DISPATCH_DELAY_MS = 25;
/**
 * Match a trailing prefix of an SGR mouse sequence so we can buffer partial
 * input across stdin chunks. Matches any of:
 *
 *   ESC, ESC [, ESC [ <, ESC [ < digits, ESC [ < digits ; digits ...
 *
 * The terminating M / m is intentionally absent because that would be a
 * complete sequence. Anchored to end-of-string only.
 */
const SGR_MOUSE_PREFIX_TAIL_PATTERN = /(?:\x1b(?:\[(?:<\d*(?:;\d*){0,2})?)?)$/;

function toHex(value: string): string {
	let hex = "";
	for (let index = 0; index < value.length; index += 1) {
		hex += value.charCodeAt(index).toString(16).padStart(2, "0");
	}
	return hex;
}

function diagnoseMouseInput(fields: MouseInputDiagnosticsFields): void {
	logDiagnostic("sumo_mouse_input", {
		data_length: fields.dataLength,
		source_length: fields.sourceLength,
		events: fields.eventCount,
		consumed: fields.consumed,
		pending_length: fields.pendingLength,
		leftover_length: fields.leftoverLength,
		source_hex: fields.sourceHex,
		leftover_hex: fields.leftoverHex,
	});
}

function selectionCopyKeyFromInput(data: string): KeyEvent | undefined {
	if (data.length === 0) return undefined;
	const lower = data.toLowerCase();
	if (lower === "cmd+c" || lower === "command+c" || lower === "meta+c") return { key: "c", sequence: data, meta: true };
	return undefined;
}

function isCommandPaletteInput(data: string): boolean {
	return data === "\u001f"
		|| data === "ctrl+/"
		|| matchesKey(data, Key.ctrl("/"));
}

export function isCtrlCInput(data: string): boolean {
	return data.includes("\u0003") || matchesKey(data, Key.ctrl("c"));
}

export function isEscapeInput(data: string): boolean {
	return data === "\u001b" || data === "escape" || data === "esc" || matchesKey(data, Key.escape);
}

export class SharedInputRouter {
	private pendingMouseInput = "";
	private pendingBareEscapeTimer: ReturnType<typeof setTimeout> | undefined;

	public constructor(private readonly callbacks: SharedInputRouterCallbacks = {}) {}

	public clearPendingMouseInput(): void {
		this.pendingMouseInput = "";
		this.clearPendingBareEscapeTimer();
	}

	public handleInput(data: string): SharedInputRouterResult | void {
		let pendingMouseInput = this.pendingMouseInput;
		if (pendingMouseInput === "\x1b" && !data.startsWith("[")) {
			this.clearPendingBareEscapeTimer();
			this.pendingMouseInput = "";
			this.dispatchDeferredInput("\x1b");
			pendingMouseInput = "";
		} else if (pendingMouseInput === "\x1b") {
			this.clearPendingBareEscapeTimer();
		}
		const hadPendingMouseInput = pendingMouseInput.length > 0;
		const rememberBareEscape = !hadPendingMouseInput && data === "\x1b";
		const source = pendingMouseInput + data;
		this.pendingMouseInput = "";
		let nextData = source;
		let consumed = false;

		if (hadPendingMouseInput || source.includes("\x1b[<") || source === "\x1b[") {
			const parsed = parseSgrMouseStream(source);
			logDiagnostic("mouse_batch", {
				rawBytes: source.length,
				events: parsed.events.length,
				types: parsed.events.map((event) => event.type),
			});
			let mouseViewportDirty = false;
			for (const event of parsed.events) {
				mouseViewportDirty = this.callbacks.handleMouseEvent?.(event) === true || mouseViewportDirty;
			}
			if (mouseViewportDirty) this.callbacks.scheduleMouseRender?.();

			const beforeCompleteStrip = nextData;
			nextData = nextData.replace(COMPLETE_SGR_MOUSE_SEQUENCE, "");
			if (nextData !== beforeCompleteStrip) consumed = true;

			const tailMatch = nextData.match(SGR_MOUSE_PREFIX_TAIL_PATTERN);
			if (tailMatch && tailMatch[0].length > 0) {
				this.pendingMouseInput = tailMatch[0];
				nextData = nextData.slice(0, nextData.length - tailMatch[0].length);
				consumed = true;
				if (this.pendingMouseInput === "\x1b") this.armBareEscapeTimer();
			}

			if (nextData.includes("\x1b[<")) {
				const stripped = nextData.replace(/\x1b\[<[\d;]*[Mm]?/g, "");
				if (stripped !== nextData) {
					nextData = stripped;
					consumed = true;
				}
			}

			diagnoseMouseInput({
				dataLength: data.length,
				sourceLength: source.length,
				eventCount: parsed.events.length,
				consumed,
				pendingLength: this.pendingMouseInput.length,
				leftoverLength: nextData.length,
				sourceHex: toHex(source.slice(0, 64)),
				leftoverHex: toHex(nextData.slice(0, 64)),
			});
		}

		if (rememberBareEscape && nextData === data && !consumed) {
			this.deferBareEscape();
			return { consume: true };
		}

		return this.routeNonMouseInput(nextData, data, consumed);
	}

	private clearPendingBareEscapeTimer(): void {
		if (!this.pendingBareEscapeTimer) return;
		clearTimeout(this.pendingBareEscapeTimer);
		this.pendingBareEscapeTimer = undefined;
	}

	private deferBareEscape(): void {
		this.clearPendingBareEscapeTimer();
		this.pendingMouseInput = "\x1b";
		this.armBareEscapeTimer();
	}

	private armBareEscapeTimer(): void {
		this.clearPendingBareEscapeTimer();
		this.pendingBareEscapeTimer = setTimeout(() => {
			this.pendingBareEscapeTimer = undefined;
			if (this.pendingMouseInput !== "\x1b") return;
			this.pendingMouseInput = "";
			this.dispatchDeferredInput("\x1b");
		}, BARE_ESCAPE_DISPATCH_DELAY_MS);
		this.pendingBareEscapeTimer.unref?.();
	}

	private dispatchDeferredInput(data: string): void {
		if (this.callbacks.dispatchDelayedInput?.(data) === true) return;
		void this.routeNonMouseInput(data, data, false);
	}

	private routeNonMouseInput(nextData: string, originalData: string, consumed: boolean): SharedInputRouterResult | void {
		const normalizedPasteData = normalizeRawMultilinePasteInput(nextData);
		if (normalizedPasteData !== nextData) {
			logDiagnostic("raw_multiline_paste_normalized", { sourceLength: nextData.length, normalizedLength: normalizedPasteData.length });
			nextData = normalizedPasteData;
			consumed = true;
		}

		if (nextData.length === 0 && consumed) return { consume: true };

		if (isCommandPaletteInput(nextData)) {
			void this.callbacks.openCommandPalette?.();
			this.callbacks.requestRender?.();
			return { consume: true };
		}

		if (isCtrlCInput(nextData) && this.callbacks.handlePreEditorInput?.(nextData) === true) {
			this.callbacks.requestRender?.();
			return { consume: true };
		}

		if (this.callbacks.handleFocusedModalInput?.(nextData) === true) {
			this.callbacks.requestRender?.();
			return { consume: true };
		}

		if (this.callbacks.handleFocusedOverlayInput?.(nextData) === true) {
			this.callbacks.requestRender?.();
			return { consume: true };
		}

		const keyEvent = chatScrollCommandFromInput(nextData);
		if (keyEvent && this.callbacks.handleChatScrollKey?.(keyEvent) === true) {
			this.callbacks.requestRender?.();
			return { consume: true };
		}

		const selectionKey = selectionCopyKeyFromInput(nextData);
		if (selectionKey && this.callbacks.handleSelectionKey?.(selectionKey) === true) {
			this.callbacks.requestRender?.();
			return { consume: true };
		}

		if (this.callbacks.handlePreEditorInput?.(nextData) === true) {
			this.callbacks.requestRender?.();
			return { consume: true };
		}

		if (this.callbacks.forwardToEditor?.(nextData) === true) {
			this.callbacks.requestRender?.();
			return { consume: true, forwarded: true };
		}

		if (this.callbacks.forwardToPi?.(nextData) === true) {
			return { consume: true, forwarded: true };
		}

		if (this.callbacks.handleUnhandledInput?.(nextData) === true) {
			this.callbacks.requestRender?.();
			return { consume: true };
		}

		if (originalData.includes("\x1b") || originalData !== nextData || consumed) {
			logDiagnostic("bridge_input_verdict", {
				inLen: originalData.length,
				outLen: nextData.length,
				consumed,
				rewritten: nextData !== originalData,
				inHex: toHex(originalData.slice(0, 32)),
				outHex: toHex(nextData.slice(0, 32)),
			});
		}

		if (nextData !== originalData) return { data: nextData };
		return undefined;
	}
}
