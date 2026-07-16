import { describe, expect, it } from "vitest";
import { EditorImageDraftState, isLikelyClipboardImagePath, normalizePastedImagePath } from "./editor-draft-state.js";

describe("EditorImageDraftState", () => {
	it("detects Pi clipboard image temp paths", () => {
		expect(isLikelyClipboardImagePath("/var/folders/x/pi-clipboard-abc.png")).toBe(true);
		expect(isLikelyClipboardImagePath("/tmp/pi-clipboard-abc.jpeg")).toBe(true);
		expect(isLikelyClipboardImagePath("/tmp/not-an-image.txt")).toBe(false);
	});

	it("detects general pasted/dropped image paths so they collapse to [Image N]", () => {
		expect(isLikelyClipboardImagePath("/Users/me/Desktop/Screenshot 2026-07-08.png")).toBe(true);
		expect(isLikelyClipboardImagePath("~/Downloads/photo.jpg")).toBe(true);
		expect(isLikelyClipboardImagePath("./assets/logo.webp")).toBe(true);
		expect(isLikelyClipboardImagePath("pi-clipboard-9f3a.png")).toBe(true);
		// Paths embedded in sentences or multi-line pastes must NOT collapse.
		expect(isLikelyClipboardImagePath("look at /tmp/shot.png please")).toBe(false);
		expect(isLikelyClipboardImagePath("/tmp/a.png\n/tmp/b.png")).toBe(false);
		// Non-path words ending in an image extension must not collapse.
		expect(isLikelyClipboardImagePath("logo.png")).toBe(false);
		expect(isLikelyClipboardImagePath("/etc/passwd")).toBe(false);
	});

	it("normalizes terminal paste forms: escaped spaces and surrounding quotes", () => {
		expect(normalizePastedImagePath("/Users/me/Desktop/Screenshot\\ 2026-07-08\\ at\\ 12.10.57.png")).toBe("/Users/me/Desktop/Screenshot 2026-07-08 at 12.10.57.png");
		expect(normalizePastedImagePath('"/tmp/with space.png"')).toBe("/tmp/with space.png");
		expect(normalizePastedImagePath("'/tmp/with space.png'")).toBe("/tmp/with space.png");
		expect(normalizePastedImagePath("  /tmp/plain.png  ")).toBe("/tmp/plain.png");
	});

	it("expands tokens for paths with spaces as quoted paths", () => {
		const state = new EditorImageDraftState();
		const token = state.addImage("/Users/me/Desktop/Screenshot 2026-07-08 at 12.10.57.png");
		expect(state.expandTokensToPaths(`see ${token}`)).toBe('see "/Users/me/Desktop/Screenshot 2026-07-08 at 12.10.57.png"');
	});

	it("allocates readable image tokens and expands them back to paths on submit", () => {
		const state = new EditorImageDraftState();
		const first = state.addImage("/tmp/pi-clipboard-one.png");
		const second = state.addImage("/tmp/pi-clipboard-two.png");

		expect(first).toBe("[Image 1]");
		expect(second).toBe("[Image 2]");
		expect(state.expandTokensToPaths("see [Image 1] and [Image 2]")).toBe("see /tmp/pi-clipboard-one.png and /tmp/pi-clipboard-two.png");
	});

	it("prunes orphan map entries when tokens are deleted", () => {
		const state = new EditorImageDraftState();
		state.addImage("/tmp/pi-clipboard-one.png");
		state.addImage("/tmp/pi-clipboard-two.png");

		state.pruneMissingTokens("keep [Image 2]");

		expect(state.list()).toEqual([{ token: "[Image 2]", path: "/tmp/pi-clipboard-two.png" }]);
	});
});
