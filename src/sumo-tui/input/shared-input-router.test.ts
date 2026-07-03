import { describe, expect, it, vi } from "vitest";
import { filterKeyReleaseEvents, isCtrlCInput, SharedInputRouter, splitInputTokens } from "./shared-input-router.js";

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
