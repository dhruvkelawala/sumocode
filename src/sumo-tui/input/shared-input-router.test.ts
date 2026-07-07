import { describe, expect, it, vi } from "vitest";
import {
	containsCtrlCToken,
	filterKeyReleaseEvents,
	isAppleTerminalSession,
	isCtrlCInput,
	normalizeAppleTerminalInput,
	SharedInputRouter,
	splitInputTokens,
} from "./shared-input-router.js";

const CTRL_SLASH = "";

describe("SharedInputRouter — command palette vs. modal/overlay focus", () => {
	it("routes Ctrl+/ to a focused modal instead of opening the palette", () => {
		const openCommandPalette = vi.fn();
		const handleFocusedModalInput = vi.fn(() => true);
		const router = new SharedInputRouter({
			openCommandPalette,
			handleFocusedModalInput,
			handleFocusedOverlayInput: vi.fn(() => false),
		});

		const result = router.handleInput(CTRL_SLASH);

		expect(handleFocusedModalInput).toHaveBeenCalledWith(CTRL_SLASH);
		expect(openCommandPalette).not.toHaveBeenCalled();
		expect(result).toEqual({ consume: true });
	});

	it("routes Ctrl+/ to a focused overlay (e.g. an approval prompt) instead of opening the palette", () => {
		const openCommandPalette = vi.fn();
		// Simulate an approval overlay: it swallows input and does NOT resolve
		// its pending promise just because Ctrl+/ arrived.
		let overlayResolved = false;
		const approvalPromise = new Promise<string>((resolve) => {
			void resolve;
		}).then((value) => {
			overlayResolved = true;
			return value;
		});
		void approvalPromise;

		const handleFocusedOverlayInput = vi.fn(() => true);
		const router = new SharedInputRouter({
			openCommandPalette,
			handleFocusedModalInput: vi.fn(() => false),
			handleFocusedOverlayInput,
		});

		const result = router.handleInput(CTRL_SLASH);

		expect(handleFocusedOverlayInput).toHaveBeenCalledWith(CTRL_SLASH);
		expect(openCommandPalette).not.toHaveBeenCalled();
		expect(overlayResolved).toBe(false);
		expect(result).toEqual({ consume: true });
	});

	it("opens the palette on Ctrl+/ when neither a modal nor an overlay has focus", () => {
		const openCommandPalette = vi.fn();
		const router = new SharedInputRouter({
			openCommandPalette,
			handleFocusedModalInput: vi.fn(() => false),
			handleFocusedOverlayInput: vi.fn(() => false),
		});

		const result = router.handleInput(CTRL_SLASH);

		expect(openCommandPalette).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ consume: true });
	});

	it("opens the palette on Ctrl+/ when no focus callbacks are wired at all (plain editor focus)", () => {
		const openCommandPalette = vi.fn();
		const router = new SharedInputRouter({ openCommandPalette });

		const result = router.handleInput(CTRL_SLASH);

		expect(openCommandPalette).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ consume: true });
	});
});

// Kitty keyboard flag 2 ("report event types") sends key release (and repeat)
// events as CSI-u sequences: `\x1b[<codepoint>;<mods>:3u` for release, `:2u`
// for repeat. SumoCode's RPC host pushes flags 1+2+4 (terminal-controller.ts)
// but routes stdin through this router instead of pi-tui's TUI loop, which
// normally drops releases (pi-tui tui.js `isKeyRelease(data) &&
// !focusedComponent.wantsKeyRelease`). Without an equivalent filter here, a
// keypress and its release both decode to the same character and get typed
// twice.
const H_PRESS = "h";
const H_RELEASE = "\x1b[104;1:3u";
const H_REPEAT = "\x1b[104;1:2u";
const ARROW_RELEASE_D = "\x1b[1;1:3D";
const ARROW_RELEASE_A = "\x1b[1;1:3A";
const CTRL_C_PRESS = "";
const CTRL_C_RELEASE = "\x1b[99;5:3u";
const PASTE_WITH_COLON_3F = "\x1b[200~90:62:3F:A5\x1b[201~";

describe("splitInputTokens", () => {
	it("splits a coalesced press+release chunk into discrete tokens", () => {
		expect(splitInputTokens(H_PRESS + H_RELEASE)).toEqual([H_PRESS, H_RELEASE]);
	});

	it("keeps a bracketed paste block as a single token even with CSI-like content inside", () => {
		expect(splitInputTokens(PASTE_WITH_COLON_3F)).toEqual([PASTE_WITH_COLON_3F]);
	});

	it("splits a ctrl-c press+release pair into discrete tokens", () => {
		expect(splitInputTokens(CTRL_C_PRESS + CTRL_C_RELEASE)).toEqual([CTRL_C_PRESS, CTRL_C_RELEASE]);
	});
});

describe("filterKeyReleaseEvents", () => {
	it("drops a release-only chunk", () => {
		expect(filterKeyReleaseEvents(H_RELEASE)).toBe("");
	});

	it("delivers the press and drops the release from a coalesced chunk", () => {
		expect(filterKeyReleaseEvents(H_PRESS + H_RELEASE)).toBe(H_PRESS);
	});

	it("delivers repeat events unchanged (holding a key must keep typing)", () => {
		expect(filterKeyReleaseEvents(H_REPEAT)).toBe(H_REPEAT);
	});

	it("drops arrow-key release variants", () => {
		expect(filterKeyReleaseEvents(ARROW_RELEASE_D)).toBe("");
		expect(filterKeyReleaseEvents(ARROW_RELEASE_A)).toBe("");
	});

	it("delivers bracketed paste content unmodified even when it contains a :3F-like substring", () => {
		expect(filterKeyReleaseEvents(PASTE_WITH_COLON_3F)).toBe(PASTE_WITH_COLON_3F);
	});

	it("delivers exactly one event from a ctrl-c press+release pair", () => {
		expect(filterKeyReleaseEvents(CTRL_C_PRESS + CTRL_C_RELEASE)).toBe(CTRL_C_PRESS);
	});
});

describe("SharedInputRouter key-release filtering", () => {
	it("delivers exactly one 'h' to the editor when press and release arrive as separate chunks", () => {
		const forwardToEditor = vi.fn(() => true);
		const router = new SharedInputRouter({ forwardToEditor });

		router.handleInput(H_PRESS);
		router.handleInput(H_RELEASE);

		expect(forwardToEditor).toHaveBeenCalledTimes(1);
		expect(forwardToEditor).toHaveBeenCalledWith(H_PRESS);
	});

	it("delivers exactly one 'h' to the editor when press+release are coalesced into one chunk", () => {
		const forwardToEditor = vi.fn(() => true);
		const router = new SharedInputRouter({ forwardToEditor });

		router.handleInput(H_PRESS + H_RELEASE);

		expect(forwardToEditor).toHaveBeenCalledTimes(1);
		expect(forwardToEditor).toHaveBeenCalledWith(H_PRESS);
	});

	it("still delivers repeat events to the editor", () => {
		const forwardToEditor = vi.fn(() => true);
		const router = new SharedInputRouter({ forwardToEditor });

		router.handleInput(H_REPEAT);

		expect(forwardToEditor).toHaveBeenCalledTimes(1);
		expect(forwardToEditor).toHaveBeenCalledWith(H_REPEAT);
	});

	it("never forwards a release to the pre-editor interception point (e.g. ctrl-c interrupt tiers)", () => {
		const handlePreEditorInput = vi.fn(() => true);
		const router = new SharedInputRouter({ handlePreEditorInput });

		router.handleInput(CTRL_C_PRESS + CTRL_C_RELEASE);

		expect(handlePreEditorInput).toHaveBeenCalledTimes(1);
		expect(handlePreEditorInput).toHaveBeenCalledWith(CTRL_C_PRESS);
		expect(isCtrlCInput(CTRL_C_PRESS)).toBe(true);
	});

	it("delivers a bracketed paste containing a :3F-like substring to the editor unmodified", () => {
		const forwardToEditor = vi.fn(() => true);
		const router = new SharedInputRouter({ forwardToEditor });

		router.handleInput(PASTE_WITH_COLON_3F);

		expect(forwardToEditor).toHaveBeenCalledTimes(1);
		expect(forwardToEditor).toHaveBeenCalledWith(PASTE_WITH_COLON_3F);
	});

	it("filters releases before the modal layer sees them", () => {
		const handleFocusedModalInput = vi.fn(() => true);
		const router = new SharedInputRouter({ handleFocusedModalInput });

		router.handleInput(H_RELEASE);

		expect(handleFocusedModalInput).not.toHaveBeenCalled();
	});

	it("filters releases before the overlay layer sees them", () => {
		const handleFocusedOverlayInput = vi.fn(() => true);
		const router = new SharedInputRouter({ handleFocusedOverlayInput });

		router.handleInput(H_RELEASE);

		expect(handleFocusedOverlayInput).not.toHaveBeenCalled();
	});
});

// Defect: isCtrlCInput used to be `data.includes("\x03")`, a substring test
// that hijacked ANY chunk containing a literal 0x03 byte -- including a
// bracketed-paste block whose *content* happens to contain that byte (e.g.
// pasted terminal output, a binary-ish clipboard snippet) -- into the
// interrupt tier, so the paste never reached the editor. containsCtrlCToken
// token-splits first (splitInputTokens keeps paste blocks whole) and only
// treats a genuine, discrete Ctrl-C key token as a trigger.
const BARE_CTRL_C = "\x03";
const CSI_U_CTRL_C = "\x1b[99;5u";
const PASTE_CONTAINING_BARE_CTRL_C = "\x1b[200~before\x03after\x1b[201~";
const PASTE_WITH_EMBEDDED_BARE_CTRL_C = "\x1b[200~abc\x03def\x1b[201~";
const PASTE_THEN_BARE_CTRL_C = "\x1b[200~abc\x1b[201~\x03";

describe("containsCtrlCToken", () => {
	it("triggers on a bare 0x03 byte", () => {
		expect(containsCtrlCToken(BARE_CTRL_C)).toBe(true);
	});

	it("triggers on a CSI-u ctrl-c press", () => {
		expect(containsCtrlCToken(CSI_U_CTRL_C)).toBe(true);
	});

	it("does NOT trigger on a bracketed-paste block whose content contains a literal 0x03 byte", () => {
		expect(containsCtrlCToken(PASTE_CONTAINING_BARE_CTRL_C)).toBe(false);
	});

	it("does NOT trigger on a complete paste block whose content contains a literal 0x03 byte", () => {
		expect(containsCtrlCToken(PASTE_WITH_EMBEDDED_BARE_CTRL_C)).toBe(false);
	});

	it("does trigger when a completed paste block and a real Ctrl-C coalesce into one stdin chunk", () => {
		// This regressed while containsCtrlCToken had a blanket paste-start guard:
		// the complete paste suppressed the trailing real Ctrl-C before tokenization.
		expect(containsCtrlCToken(PASTE_THEN_BARE_CTRL_C)).toBe(true);
	});
});

describe("SharedInputRouter paste containing a literal Ctrl-C byte", () => {
	// A realistic host-level handler only claims ctrl-c/escape input (mirrors
	// host.ts's createRpcHostInterruptHandler, which returns false/undefined
	// for anything it doesn't classify as one of those two kinds). The router
	// also calls `handlePreEditorInput` a second, unconditional time later in
	// its fallback chain (for non-ctrl-c input like plain Escape), so a fake
	// that unconditionally returns `true` cannot distinguish "was this treated
	// as an interrupt" from "was this called at all" -- hence the kind-aware
	// fake here instead of a bare `vi.fn(() => true)`.
	function interruptOnlyHandler(triggeredWith: string[]): (data: string) => boolean {
		return (data: string): boolean => {
			if (data === BARE_CTRL_C || data === CSI_U_CTRL_C) {
				triggeredWith.push(data);
				return true;
			}
			return false;
		};
	}

	it("delivers the paste block to the editor unmodified and does not trigger the interrupt tier", () => {
		const triggeredWith: string[] = [];
		const forwardToEditor = vi.fn(() => true);
		const router = new SharedInputRouter({
			handlePreEditorInput: interruptOnlyHandler(triggeredWith),
			forwardToEditor,
		});

		const result = router.handleInput(PASTE_CONTAINING_BARE_CTRL_C);

		expect(triggeredWith).toEqual([]);
		expect(forwardToEditor).toHaveBeenCalledTimes(1);
		expect(forwardToEditor).toHaveBeenCalledWith(PASTE_CONTAINING_BARE_CTRL_C);
		expect(result).toEqual({ consume: true, forwarded: true });
	});

	it("still routes a bare Ctrl-C keypress to the pre-editor interrupt handler", () => {
		const triggeredWith: string[] = [];
		const forwardToEditor = vi.fn(() => true);
		const router = new SharedInputRouter({
			handlePreEditorInput: interruptOnlyHandler(triggeredWith),
			forwardToEditor,
		});

		router.handleInput(BARE_CTRL_C);

		expect(triggeredWith).toEqual([BARE_CTRL_C]);
		expect(forwardToEditor).not.toHaveBeenCalled();
	});

	it("still routes a CSI-u Ctrl-C keypress to the pre-editor interrupt handler", () => {
		const triggeredWith: string[] = [];
		const forwardToEditor = vi.fn(() => true);
		const router = new SharedInputRouter({
			handlePreEditorInput: interruptOnlyHandler(triggeredWith),
			forwardToEditor,
		});

		router.handleInput(CSI_U_CTRL_C);

		expect(triggeredWith).toEqual([CSI_U_CTRL_C]);
		expect(forwardToEditor).not.toHaveBeenCalled();
	});
});

describe("isAppleTerminalSession / normalizeAppleTerminalInput (TERM_PROGRAM stubbed)", () => {
	it("is true only on darwin with TERM_PROGRAM=Apple_Terminal", () => {
		const appleTerminalEnv = { TERM_PROGRAM: "Apple_Terminal" } as NodeJS.ProcessEnv;
		const otherTerminalEnv = { TERM_PROGRAM: "iTerm.app" } as NodeJS.ProcessEnv;
		const noTerminalEnv = {} as NodeJS.ProcessEnv;

		// isAppleTerminalSession also gates on process.platform === "darwin", which
		// this test cannot stub -- assert against the actual runtime platform so
		// the test is meaningful on darwin CI/dev machines and still correct
		// (vacuously false) on any other platform.
		const onDarwin = process.platform === "darwin";
		expect(isAppleTerminalSession(appleTerminalEnv)).toBe(onDarwin);
		expect(isAppleTerminalSession(otherTerminalEnv)).toBe(false);
		expect(isAppleTerminalSession(noTerminalEnv)).toBe(false);
	});

	it("rewrites bare Enter to the CSI-u Shift+Enter sequence only when Apple Terminal AND shift are both true", () => {
		expect(normalizeAppleTerminalInput("\r", true, true)).toBe("\x1b[13;2u");
	});

	it("leaves bare Enter untouched when not an Apple Terminal session", () => {
		expect(normalizeAppleTerminalInput("\r", false, true)).toBe("\r");
	});

	it("leaves bare Enter untouched when shift is not detected", () => {
		expect(normalizeAppleTerminalInput("\r", true, false)).toBe("\r");
	});

	it("leaves non-Enter input untouched regardless of Apple Terminal / shift state", () => {
		expect(normalizeAppleTerminalInput("x", true, true)).toBe("x");
		expect(normalizeAppleTerminalInput("\n", true, true)).toBe("\n");
	});
});
