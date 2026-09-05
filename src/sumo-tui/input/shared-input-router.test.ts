import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
/* oxlint-disable anti-slop/no-chained-type-assertions -- test doubles cast minimal stub objects to Pi context types. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- stub shape is exercised by the assertions below. */

const CTRL_SLASH = "";

it("redacts sensitive modal keystrokes from diagnostics", () => {
	const path = join(tmpdir(), `sumocode-sensitive-input-${process.pid}-${Date.now()}.jsonl`);
	const previous = process.env.SUMO_TUI_DIAG_FILE;
	try {
		process.env.SUMO_TUI_DIAG_FILE = path;
		const router = new SharedInputRouter({
			isSensitiveInputFocused: () => true,
			handleFocusedModalInput: () => true,
		});

		router.handleInput("sk-secret");

		const diagnostics = readFileSync(path, "utf8");
		expect(diagnostics).not.toContain("sk-secret");
		expect(diagnostics).not.toContain("736b2d736563726574");
		expect(diagnostics).toContain("[redacted]");
	} finally {
		if (previous === undefined) delete process.env.SUMO_TUI_DIAG_FILE;
		else process.env.SUMO_TUI_DIAG_FILE = previous;
		rmSync(path, { force: true });
	}
});

it("never logs paste payloads, including late tails after sensitive focus changes", () => {
	const path = join(tmpdir(), `sumocode-paste-input-${process.pid}-${Date.now()}.jsonl`);
	const previous = process.env.SUMO_TUI_DIAG_FILE;
	vi.useFakeTimers();
	try {
		process.env.SUMO_TUI_DIAG_FILE = path;
		let sensitive = true;
		const router = new SharedInputRouter({ isSensitiveInputFocused: () => sensitive, forwardToEditor: () => true });
		router.handleInput("\x1b[20");
		router.handleInput("0~private-prefix");
		vi.advanceTimersByTime(1_000);
		sensitive = false;
		router.handleInput("private-tail");
		router.handleInput("\x1b[201~");
		router.handleInput("\x1b[200~ordinary-paste\x1b[201~");
		const diagnostics = readFileSync(path, "utf8");
		for (const payload of ["private-prefix", "private-tail", "ordinary-paste"]) {
			expect(diagnostics).not.toContain(payload);
			expect(diagnostics).not.toContain(Buffer.from(payload).toString("hex"));
		}
		expect(diagnostics).toContain("[redacted]");
		router.dispose();
	} finally {
		if (previous === undefined) delete process.env.SUMO_TUI_DIAG_FILE;
		else process.env.SUMO_TUI_DIAG_FILE = previous;
		vi.useRealTimers();
		rmSync(path, { force: true });
	}
});

describe("SharedInputRouter coalesced commands", () => {
	it("defers the palette and independently dispatches Ctrl-D during stalled hydration", () => {
		const events: string[] = [];
		const router = new SharedInputRouter({
			openCommandPalette: () => { events.push("palette deferred"); },
			forwardToEditor: (data) => {
				events.push(data === "\x04" ? "exit empty editor" : `unexpected ${data}`);
				return true;
			},
		});
		router.handleInput(CTRL_SLASH + "\x04");
		expect(events).toEqual(["palette deferred", "exit empty editor"]);
	});

	it("rechecks focus after each adjacent command", () => {
		let focused = false;
		const events: string[] = [];
		const router = new SharedInputRouter({
			openCommandPalette: () => { focused = true; events.push("open"); },
			handleFocusedModalInput: (data) => {
				if (!focused) return false;
				events.push(`modal:${data}`);
				if (data === "\x1b[A") focused = false;
				return true;
			},
			forwardToEditor: (data) => { events.push(`editor:${data}`); return true; },
		});
		router.handleInput(CTRL_SLASH + "x\x1b[A\x04");
		expect(events).toEqual(["open", "modal:x", "modal:\x1b[A", "editor:\x04"]);
	});

	it.each<[string, string, string[]]>([
		["CSI/SS3/Kitty", "\x1b[A\x1bOP\x1b[104;1:1u\x1b[104;1:2u\x1b[104;1:3u", ["\x1b[A", "\x1bOP", "\x1b[104;1:1u", "\x1b[104;1:2u"]],
		["composition", "😀e\u0301👩‍💻中文", ["😀", "e\u0301", "👩‍💻", "中", "文"]],
		["legacy modifier enter", "\x1b\r\x1b\n", ["\x1b\r", "\x1b\n"]],
		["Kitty Escape press/release", "\x1b\x1b[27;1:3u", ["\x1b"]],
		["raw multiline paste", "one\r\ntwo", ["one\ntwo"]],
		["LF paste", "one\ntwo", ["one\ntwo"]],
	])("preserves %s tokens", (_name, data, expected) => {
		const forwardToEditor = vi.fn((_data: string) => true);
		new SharedInputRouter({ forwardToEditor }).handleInput(data);
		expect(forwardToEditor.mock.calls.map(([token]) => token)).toEqual(expected);
	});

	it("keeps pasted controls and mouse bytes atomic across every chunk boundary", () => {
		const paste = "\x1b[200~😀\r\n\x1f\x04\x03\x1b[<64;10;5M\x1b[104;1:3u\x1b[201~";
		for (let cut = 1; cut < paste.length; cut += 1) {
			const forwardToEditor = vi.fn((_data: string) => true);
			const openCommandPalette = vi.fn();
			const handleMouseEvent = vi.fn();
			const router = new SharedInputRouter({ forwardToEditor, openCommandPalette, handleMouseEvent });
			router.handleInput(paste.slice(0, cut));
			expect(forwardToEditor).not.toHaveBeenCalled();
			router.handleInput(paste.slice(cut) + "\x04");
			expect(forwardToEditor.mock.calls.map(([token]) => token)).toEqual([paste, "\x04"]);
			expect(openCommandPalette).not.toHaveBeenCalled();
			expect(handleMouseEvent).not.toHaveBeenCalled();
			router.clearPendingMouseInput();
		}
	});

	it.each(["\x1b[A", "\x1bOP", "\x1b[104;1:2u"])("retains partial %j until complete", (sequence) => {
		for (let cut = 1; cut < sequence.length; cut += 1) {
			const forwardToEditor = vi.fn((_data: string) => true);
			const router = new SharedInputRouter({ forwardToEditor });
			router.handleInput(sequence.slice(0, cut));
			expect(forwardToEditor).not.toHaveBeenCalled();
			router.handleInput(sequence.slice(cut));
			expect(forwardToEditor).toHaveBeenCalledExactlyOnceWith(sequence);
			router.clearPendingMouseInput();
		}
	});

	it.each(["\x1b[<1z", "\x1b[<1;0;5M"])("forwards unrecognized complete CSI %j intact", (sequence) => {
		const forwardToEditor = vi.fn((_data: string) => true);
		const handleMouseEvent = vi.fn();
		const router = new SharedInputRouter({ forwardToEditor, handleMouseEvent });
		router.handleInput(sequence + "x");
		expect(forwardToEditor.mock.calls).toEqual([[sequence], ["x"]]);
		expect(handleMouseEvent).not.toHaveBeenCalled();
	});

	it("keeps mouse and keyboard actions in stream order while batching mouse renders", () => {
		const events: string[] = [];
		const scheduleMouseRender = vi.fn();
		const router = new SharedInputRouter({
			handleMouseEvent: () => { events.push("mouse"); return true; },
			forwardToPi: (data) => { events.push(data); return true; },
			scheduleMouseRender,
		});
		router.handleInput("a\x1b[<64;10;5Mb\x1b[<64;10;5M");
		expect(events).toEqual(["a", "mouse", "b", "mouse"]);
		expect(scheduleMouseRender).toHaveBeenCalledTimes(1);
	});

	it("reports retained text not inserted when the application blocks a completed paste", () => {
		const forwardToEditor = vi.fn(() => true);
		const setInputNotice = vi.fn();
		const router = new SharedInputRouter({ forwardToEditor, setInputNotice, handleInputGate: () => true });
		router.handleInput("\x1b[200~draft\x1b[201~");
		expect(forwardToEditor).not.toHaveBeenCalled();
		expect(setInputNotice).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("5 retained bytes not inserted"));
	});

	it("keeps unfinished paste ownership across clear and focus changes", () => {
		const forwardToEditor = vi.fn(() => true);
		let sensitive = true;
		const router = new SharedInputRouter({ forwardToEditor, isSensitiveInputFocused: () => sensitive });
		router.handleInput("\x1b[200~unfinished");
		router.clearPendingMouseInput();
		sensitive = false;
		router.handleInput("x\x04");
		expect(forwardToEditor).not.toHaveBeenCalled();
		router.handleInput("\x1b[201~");
		expect(forwardToEditor).toHaveBeenCalledExactlyOnceWith("\x1b[200~unfinishedx\x04\x1b[201~");
	});

	it("pauses incomplete paste once on idle, retains text and resumes only at the actual fragmented end", () => {
		vi.useFakeTimers();
		try {
			const forwardToEditor = vi.fn(() => true);
			const setInputNotice = vi.fn();
			const handleMouseEvent = vi.fn();
			const router = new SharedInputRouter({ forwardToEditor, setInputNotice, handleMouseEvent });
			router.handleInput("\x1b[200~draft");
			vi.advanceTimersByTime(1_000);
			expect(setInputNotice).toHaveBeenCalledTimes(1);
			expect(setInputNotice).toHaveBeenLastCalledWith(expect.stringContaining("INPUT PAUSED"));
			vi.advanceTimersByTime(20_000);
			expect(setInputNotice).toHaveBeenCalledTimes(1);
			router.handleInput("\x04\x1b[<1z\x1b[<0;1;1M\x1b[20");
			expect(forwardToEditor).not.toHaveBeenCalled();
			expect(handleMouseEvent).not.toHaveBeenCalled();
			router.handleInput("1~\x04");
			expect(forwardToEditor.mock.calls).toEqual([
				["\x1b[200~draft\x04\x1b[<1z\x1b[<0;1;1M\x1b[201~"], ["\x04"],
			]);
			expect(setInputNotice).toHaveBeenLastCalledWith(expect.stringContaining("input resumed"));
			expect(vi.getTimerCount()).toBe(0);
		} finally { vi.useRealTimers(); }
	});

	it("retains only a 64 KiB UTF-8 prefix, never executing overflow controls", () => {
		const forwardToEditor = vi.fn(() => true);
		const setInputNotice = vi.fn();
		const handleMouseEvent = vi.fn();
		const router = new SharedInputRouter({ forwardToEditor, setInputNotice, handleMouseEvent });
		const prefix = "😀".repeat(16_383) + "abc";
		router.handleInput("\x1b[200~" + prefix + "😀");
		expect(setInputNotice).toHaveBeenLastCalledWith(expect.stringContaining("65535/65536"));
		router.handleInput("\x04\x1b[<1z\x1b[<0;1;1M");
		expect(forwardToEditor).not.toHaveBeenCalled();
		expect(handleMouseEvent).not.toHaveBeenCalled();
		router.handleInput("\x1b[201~\x04");
		expect(forwardToEditor.mock.calls).toEqual([["\x1b[200~" + prefix + "\x1b[201~"], ["\x04"]]);
		expect(setInputNotice).toHaveBeenLastCalledWith("input resumed — paste complete; 65535/65536 bytes retained; 19 bytes truncated");
	});

	it.each(["\x1b[200~", "\x1b[20"])("recognizes paste ownership after malformed CSI before forwarding its payload (%j)", (start) => {
		const forwardToEditor = vi.fn(() => true);
		const router = new SharedInputRouter({ forwardToEditor });
		router.handleInput("\x1b[12;\x04" + start);
		if (start === "\x1b[20") router.handleInput("0~");
		router.handleInput("secret\x04");
		expect(forwardToEditor.mock.calls).toEqual([["\x1b[12;\x04"]]);
		router.handleInput("\x1b[201~");
		expect(forwardToEditor.mock.calls.at(-1)).toEqual(["\x1b[200~secret\x04\x1b[201~"]);
	});

	it("does not let raw CR normalization hide a fragmented paste after malformed CSI", () => {
		const forwardToEditor = vi.fn(() => true);
		const router = new SharedInputRouter({ forwardToEditor });
		router.handleInput("\x1b[12;\r\x1b[20");
		router.handleInput("0~secret\x04");
		expect(forwardToEditor.mock.calls).toEqual([["\x1b[12;\r"]]);
		router.handleInput("\x1b[201~");
		expect(forwardToEditor.mock.calls.at(-1)).toEqual(["\x1b[200~secret\x04\x1b[201~"]);
	});

	it.each(["draft\r", "draft\n"])("keeps a raw multiline draft atomic without hiding a following paste opener (%j)", (draft) => {
		const forwardToEditor = vi.fn(() => true);
		const router = new SharedInputRouter({ forwardToEditor });
		router.handleInput(draft + "\x1b[20");
		router.handleInput("0~secret\x04");
		expect(forwardToEditor.mock.calls).toEqual([["draft\n"]]);
		router.handleInput("\x1b[201~");
		expect(forwardToEditor.mock.calls.at(-1)).toEqual(["\x1b[200~secret\x04\x1b[201~"]);
	});

	it("keeps prefix storage bounded across tiny Unicode chunks and false end prefixes", () => {
		const forwardToEditor = vi.fn(() => true);
		const router = new SharedInputRouter({ forwardToEditor });
		router.handleInput("\x1b[200~");
		for (let index = 0; index < 16_385; index += 1) {
			router.handleInput("\ud83d");
			router.handleInput("\ude00");
		}
		router.handleInput("\x1b[201x\x1b[201\x1b[20");
		expect(forwardToEditor).not.toHaveBeenCalled();
		router.handleInput("1~");
		expect(forwardToEditor).toHaveBeenCalledExactlyOnceWith("\x1b[200~" + "😀".repeat(16_384) + "\x1b[201~");
	});

	it.each(["\x1b", "\x1b[12;", "\x1b[200~draft"])("disposes %j timers once and never routes late input", (prefix) => {
		vi.useFakeTimers();
		try {
			const forwardToEditor = vi.fn(() => true);
			const setInputNotice = vi.fn();
			const router = new SharedInputRouter({ forwardToEditor, setInputNotice });
			router.handleInput(prefix);
			router.dispose();
			router.dispose();
			router.clearPendingMouseInput();
			router.handleInput("\x1b[201~\x04");
			vi.advanceTimersByTime(2_000);
			expect(forwardToEditor).not.toHaveBeenCalled();
			expect(setInputNotice).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally { vi.useRealTimers(); }
	});

	it("expires incomplete CSI atomically through delayed dispatch", () => {
		vi.useFakeTimers();
		try {
			const dispatchDelayedInput = vi.fn(() => true);
			const router = new SharedInputRouter({ dispatchDelayedInput });
			router.handleInput("\x1b[12;");
			vi.advanceTimersByTime(25);
			expect(dispatchDelayedInput).toHaveBeenCalledExactlyOnceWith("\x1b[12;");
			expect(vi.getTimerCount()).toBe(0);
		} finally { vi.useRealTimers(); }
	});

	it.each(["\x1b[12;\x04", "\x1b[ 1\x04", "\x1b[" + "1".repeat(300) + "\x04"])("forwards failed CSI %j without executing its interior", (data) => {
		const forwardToEditor = vi.fn(() => true);
		const router = new SharedInputRouter({ forwardToEditor });
		router.handleInput(data);
		expect(forwardToEditor).toHaveBeenCalledExactlyOnceWith(data);
		router.clearPendingMouseInput();
	});

	it("redispatches unclaimed classic Pi tokens in order without returning duplicates", () => {
		const dispatchDelayedInput = vi.fn((_data: string) => true);
		const router = new SharedInputRouter({ dispatchDelayedInput });
		expect(router.handleInput("ab")).toEqual({ consume: true });
		expect(dispatchDelayedInput.mock.calls).toEqual([["a"], ["b"]]);
	});
});

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
