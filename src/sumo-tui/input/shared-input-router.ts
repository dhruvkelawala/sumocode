import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
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
	readonly isSensitiveInputFocused?: () => boolean;
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

// oxlint-disable-next-line no-control-regex -- intentional ESC byte match for ANSI input parsing
const BRACKETED_PASTE_BLOCK_PATTERN = /\x1b\[200~[\s\S]*?\x1b\[201~/g;
// Keep CSI (including Kitty and SGR mouse) and SS3 sequences whole.
// oxlint-disable-next-line no-control-regex -- intentional ESC byte match for ANSI input parsing
const CSI_OR_SS3_SEQUENCE_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|O[A-Za-z])/g;
const inputGraphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Split complete chunks without breaking paste blocks, escape sequences or graphemes. */
export function splitInputTokens(data: string): string[] {
	const { tokens, pending } = parseInputTokens(data);
	return pending ? [...tokens, pending] : tokens;
}

function parseInputTokens(data: string) {
	const tokens: string[] = [];
	const graphemes = inputGraphemes.segment(data);
	let index = 0;
	while (index < data.length) {
		BRACKETED_PASTE_BLOCK_PATTERN.lastIndex = index;
		const pasteMatch = BRACKETED_PASTE_BLOCK_PATTERN.exec(data);
		const pasteStart = pasteMatch && pasteMatch.index === index ? index : -1;

		if (pasteStart === index && pasteMatch) {
			tokens.push(pasteMatch[0]);
			index += pasteMatch[0].length;
			continue;
		}

		if (data[index] === "\x1b") {
			const remaining = data.slice(index);
			// Kitty terminals can batch a bare Escape with its CSI-u release.
			if (remaining.startsWith("\x1b\x1b")) {
				tokens.push("\x1b");
				index += 1;
				continue;
			}
			if ("\x1b[200~".startsWith(remaining) || remaining.startsWith("\x1b[200~")) {
				return { tokens, pending: remaining };
			}
			CSI_OR_SS3_SEQUENCE_PATTERN.lastIndex = index;
			const escMatch = CSI_OR_SS3_SEQUENCE_PATTERN.exec(data);
			if (escMatch && escMatch.index === index) {
				tokens.push(escMatch[0]);
				index += escMatch[0].length;
				continue;
			}
			if (remaining.startsWith("\x1b[") || remaining === "\x1bO") {
				return { tokens, pending: remaining };
			}
			const meta = graphemes.containing(index + 1)?.segment;
			if (meta) {
				tokens.push("\x1b" + meta);
				index += 1 + meta.length;
				continue;
			}
		}

		const grapheme = graphemes.containing(index)?.segment ?? "";
		tokens.push(grapheme);
		index += grapheme.length;
	}
	return { tokens, pending: "" };
}

/**
 * Drop Kitty/xterm key-release tokens (flag 2 report-event-types sends a
 * `:3` suffixed CSI-u/arrow/func sequence on key-up). Repeats (`:2`) and
 * presses pass through unchanged. Bracketed-paste tokens are never filtered
 * (and `isKeyRelease` itself refuses to match inside `\x1b[200~`, so a pasted
 * MAC address like `90:62:3F:A5` is safe either way).
 *
 * This is the RPC host's substitute for pi-tui's own release filtering in
 * `tui.js` (`if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease)
 * return;`), which the RPC host bypasses entirely (stub TUI, no
 * `focusedComponent.handleInput` loop).
 */
export function filterKeyReleaseEvents(data: string): string {
	const tokens = splitInputTokens(data);
	return tokens.filter((token) => !isKeyRelease(token)).join("");
}
const BARE_ESCAPE_DISPATCH_DELAY_MS = 25;

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

/**
 * True only for a single, discrete Ctrl-C key token: a bare 0x03 byte or a
 * CSI-u ctrl-c press (e.g. `\x1b[99;5u`). Deliberately NOT a substring test --
 * `data` here may be a whole coalesced stdin chunk, and a bracketed-paste
 * block or other pasted terminal output can legitimately contain a literal
 * 0x03 byte in its content without being an interrupt keypress. Callers that
 * receive multi-token chunks must split with `splitInputTokens` first and
 * test each token individually (see `containsCtrlCToken` below).
 */
export function isCtrlCInput(data: string): boolean {
	return data === "\u0003" || matchesKey(data, Key.ctrl("c"));
}

export function isEscapeInput(data: string): boolean {
	return data === "\u001b" || data === "escape" || data === "esc" || matchesKey(data, Key.escape);
}

const APPLE_TERMINAL_SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";

/**
 * True on macOS's Terminal.app. Apple Terminal doesn't support the Kitty
 * keyboard protocol or xterm's modifyOtherKeys, so a Shift+Enter keypress
 * there arrives as a bare `\r` -- indistinguishable from plain Enter -- with
 * no way to recover the Shift modifier from the byte stream alone.
 *
 * This is a local, from-scratch reimplementation of the equivalent check in
 * pi-tui's `terminal.ts` (`process.platform === "darwin" && process.env
 * .TERM_PROGRAM === "Apple_Terminal"`), NOT an import of it: that function
 * lives in an internal, non-exported module
 * (`@earendil-works/pi-tui/dist/terminal.js`) -- only `ProcessTerminal`/
 * `Terminal` are re-exported from pi-tui's public package entrypoint
 * (`dist/index.js`) -- and reaching into it would mean depending on pi-tui
 * internals with no stability guarantee.
 */
export function isAppleTerminalSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return process.platform === "darwin" && env.TERM_PROGRAM === "Apple_Terminal";
}

/**
 * Rewrites a bare Apple Terminal Enter (`\r`) into the CSI-u Shift+Enter
 * sequence the editor already recognizes as "insert newline" (see editor.ts's
 * `CSI_U_ENTER` / cathedral-editor's multiline handling) when the caller has
 * observed Shift held.
 *
 * Local reimplementation of pi-tui's `normalizeAppleTerminalInput` in
 * `terminal.ts` (same non-exported-module rationale as
 * `isAppleTerminalSession` above). Pi's real Apple Terminal path first checks
 * that the incoming sequence is bare `\r`, then calls
 * `isNativeModifierPressed("shift")` from pi-tui's Darwin native modifier
 * helper and passes that boolean here. Keeping this helper pure makes the
 * runtime call site the only place that reaches into the native probe.
 */
export function normalizeAppleTerminalInput(data: string, isAppleTerminal: boolean, isShiftPressed: boolean): string {
	if (isAppleTerminal && data === "\r" && isShiftPressed) return APPLE_TERMINAL_SHIFT_ENTER_SEQUENCE;
	return data;
}

/**
 * True when a possibly multi-token, coalesced stdin chunk contains a
 * discrete Ctrl-C key token once split into individual input tokens.
 * `splitInputTokens` keeps bracketed-paste blocks whole (never splitting
 * their interior into separate tokens), so a paste containing a literal
 * 0x03 byte in its content is a single paste token -- never mistaken for
 * `isCtrlCInput` -- and cannot hijack the whole chunk into the interrupt
 * tier. A bare Ctrl-C token, or a CSI-u ctrl-c press, still triggers it.
 */
export function containsCtrlCToken(data: string): boolean {
	// Tokenization is the single authority: paste blocks stay whole, while a
	// coalesced real Ctrl-C after a paste becomes its own token.
	return splitInputTokens(data).some((token) => isCtrlCInput(token));
}

export class SharedInputRouter {
	private pendingInput = "";
	private pendingBareEscapeTimer: ReturnType<typeof setTimeout> | undefined;

	public constructor(private readonly callbacks: SharedInputRouterCallbacks = {}) {}

	public clearPendingMouseInput(): void {
		this.pendingInput = "";
		this.clearPendingBareEscapeTimer();
	}

	public handleInput(data: string): SharedInputRouterResult | void {
		// Unconditional raw-input trace (no-ops unless SUMO_TUI_DIAG_FILE is
		// set): ground truth for "keybindings are broken" reports, since a
		// terminal's actual byte encoding (plain vs Kitty CSI-u press/repeat/
		// release) can only be confirmed by capturing what it really sends.
		// Run `sumocode -d .`, reproduce the broken key, then `sumocode diag`
		// or grep the diag file for "raw_key_input" to see the exact bytes.
		logDiagnostic("raw_key_input", { hex: this.diagnosticHex(data), length: data.length });
		let pendingInput = this.pendingInput;
		if (pendingInput === "\x1b" && !data.startsWith("[") && !data.startsWith("O")) {
			this.clearPendingBareEscapeTimer();
			this.pendingInput = "";
			this.dispatchDeferredInput("\x1b");
			pendingInput = "";
		} else if (pendingInput === "\x1b") {
			this.clearPendingBareEscapeTimer();
		}
		const source = pendingInput + data;
		const normalized = normalizeRawMultilinePasteInput(source);
		if (normalized !== source) {
			logDiagnostic("raw_multiline_paste_normalized", { sourceLength: source.length, normalizedLength: normalized.length });
		}
		// Preserve the existing unbracketed multiline-paste heuristic before
		// splitting keys: its newlines are draft content, not submit presses.
		const parsed = normalized !== source || (!source.includes("\x1b") && source.length > 1 && source.includes("\n"))
			|| isCommandPaletteInput(source) || selectionCopyKeyFromInput(source) || (source !== "\x1b" && isEscapeInput(source))
			? { tokens: [normalized], pending: "" }
			: parseInputTokens(source);
		this.pendingInput = parsed.pending;
		if (parsed.pending === "\x1b") this.armBareEscapeTimer();
		let consumed = parsed.pending.length > 0;
		let forwarded = false;
		let mouseViewportDirty = false;
		const mouseEvents: MouseEvent[] = [];
		const leftovers: string[] = [];
		for (const token of parsed.tokens) {
			if (token.startsWith("\x1b[<")) {
				const mouse = parseSgrMouseStream(token);
				mouseEvents.push(...mouse.events);
				for (const event of mouse.events) {
					mouseViewportDirty = this.callbacks.handleMouseEvent?.(event) === true || mouseViewportDirty;
				}
				consumed = true;
				continue;
			}
			const result = this.routeNonMouseInput(token);
			if (result?.consume) {
				consumed = true;
				forwarded = result.forwarded === true || forwarded;
			} else if (parsed.tokens.length > 1 && this.callbacks.dispatchDelayedInput?.(result?.data ?? token) === true) {
				consumed = true;
			} else {
				leftovers.push(result?.data ?? token);
			}
		}
		if (mouseViewportDirty) this.callbacks.scheduleMouseRender?.();
		const remaining = leftovers.join("");
		if (mouseEvents.length > 0 || parsed.pending) {
			logDiagnostic("mouse_batch", { rawBytes: source.length, events: mouseEvents.length, types: mouseEvents.map((event) => event.type) });
			diagnoseMouseInput({
				dataLength: data.length,
				sourceLength: source.length,
				eventCount: mouseEvents.length,
				consumed,
				pendingLength: parsed.pending.length,
				leftoverLength: remaining.length,
				sourceHex: this.diagnosticHex(source.slice(0, 64)),
				leftoverHex: this.diagnosticHex(remaining.slice(0, 64)),
			});
		}
		if (leftovers.length > 0) {
			if (data.includes("\x1b") || remaining !== data || consumed) {
				logDiagnostic("bridge_input_verdict", {
					inLen: data.length, outLen: remaining.length, consumed, rewritten: remaining !== data,
					inHex: this.diagnosticHex(data.slice(0, 32)), outHex: this.diagnosticHex(remaining.slice(0, 32)),
				});
			}
			if (remaining !== data) logDiagnostic("route_verdict", { target: "noOpForwarded", hex: this.diagnosticHex(remaining) });
			return remaining === data && !consumed ? undefined : { data: remaining };
		}
		return forwarded ? { consume: true, forwarded: true } : { consume: true };
	}

	private diagnosticHex(value: string): string {
		return this.callbacks.isSensitiveInputFocused?.() === true ? "[redacted]" : toHex(value);
	}

	private clearPendingBareEscapeTimer(): void {
		if (!this.pendingBareEscapeTimer) return;
		clearTimeout(this.pendingBareEscapeTimer);
		this.pendingBareEscapeTimer = undefined;
	}

	private armBareEscapeTimer(): void {
		this.clearPendingBareEscapeTimer();
		this.pendingBareEscapeTimer = setTimeout(() => {
			this.pendingBareEscapeTimer = undefined;
			if (this.pendingInput !== "\x1b") return;
			this.pendingInput = "";
			this.dispatchDeferredInput("\x1b");
		}, BARE_ESCAPE_DISPATCH_DELAY_MS);
		this.pendingBareEscapeTimer.unref?.();
	}

	private dispatchDeferredInput(data: string): void {
		if (this.callbacks.dispatchDelayedInput?.(data) === true) return;
		void this.routeNonMouseInput(data);
	}

	private routeNonMouseInput(nextData: string): SharedInputRouterResult | void {
		if (isKeyRelease(nextData)) {
			logDiagnostic("key_release_filtered", { sourceLength: nextData.length, filteredLength: 0 });
			return { consume: true };
		}

		if (isCtrlCInput(nextData) && this.callbacks.handlePreEditorInput?.(nextData) === true) {
			logDiagnostic("route_verdict", { target: "ctrlCPreEditor", hex: this.diagnosticHex(nextData) });
			this.callbacks.requestRender?.();
			return { consume: true };
		}

		if (this.callbacks.handleFocusedModalInput?.(nextData) === true) {
			logDiagnostic("route_verdict", { target: "focusedModal", hex: this.diagnosticHex(nextData) });
			this.callbacks.requestRender?.();
			return { consume: true };
		}

		if (this.callbacks.handleFocusedOverlayInput?.(nextData) === true) {
			logDiagnostic("route_verdict", { target: "focusedOverlay", hex: this.diagnosticHex(nextData) });
			this.callbacks.requestRender?.();
			return { consume: true };
		}

		if (isCommandPaletteInput(nextData)) {
			logDiagnostic("route_verdict", { target: "commandPalette", hex: this.diagnosticHex(nextData) });
			void this.callbacks.openCommandPalette?.();
			this.callbacks.requestRender?.();
			return { consume: true };
		}

		const keyEvent = chatScrollCommandFromInput(nextData);
		if (keyEvent && this.callbacks.handleChatScrollKey?.(keyEvent) === true) {
			logDiagnostic("route_verdict", { target: "chatScroll", hex: this.diagnosticHex(nextData), keyEvent: keyEvent.key });
			this.callbacks.requestRender?.();
			return { consume: true };
		}

		const selectionKey = selectionCopyKeyFromInput(nextData);
		if (selectionKey && this.callbacks.handleSelectionKey?.(selectionKey) === true) {
			logDiagnostic("route_verdict", { target: "selectionCopy", hex: this.diagnosticHex(nextData) });
			this.callbacks.requestRender?.();
			return { consume: true };
		}

		if (this.callbacks.handlePreEditorInput?.(nextData) === true) {
			logDiagnostic("route_verdict", { target: "preEditor", hex: this.diagnosticHex(nextData) });
			this.callbacks.requestRender?.();
			return { consume: true };
		}

		if (this.callbacks.forwardToEditor?.(nextData) === true) {
			logDiagnostic("route_verdict", { target: "editor", hex: this.diagnosticHex(nextData) });
			this.callbacks.requestRender?.();
			return { consume: true, forwarded: true };
		}

		if (this.callbacks.forwardToPi?.(nextData) === true) {
			logDiagnostic("route_verdict", { target: "forwardToPi", hex: this.diagnosticHex(nextData) });
			return { consume: true, forwarded: true };
		}

		if (this.callbacks.handleUnhandledInput?.(nextData) === true) {
			logDiagnostic("route_verdict", { target: "unhandledFallback", hex: this.diagnosticHex(nextData) });
			this.callbacks.requestRender?.();
			return { consume: true };
		}

		logDiagnostic("route_verdict", { target: "dropped", hex: this.diagnosticHex(nextData) });
		return undefined;
	}
}
