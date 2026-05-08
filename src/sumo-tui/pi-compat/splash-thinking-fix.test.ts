import { describe, expect, it } from "vitest";

describe("UX_SPEC §0 — splash takes no-messages slot, not empty-chat-quote (#60)", () => {
	it("splash predicate triggers when chat has zero messages regardless of sidebar visibility", () => {
		// Pure regression guard: ensure shouldShowEmptyChatQuote is not on the
		// hot path of syncChatSlot. We test by inspecting the source surface.
		const path = new URL("./retained-shell-transition.ts", import.meta.url);
		const source = require("node:fs").readFileSync(path, "utf8") as string;
		// The transition Module must NOT branch on showEmptyQuote anymore.
		expect(source).not.toContain("showEmptyQuote");
		// Splash mount must remain.
		expect(source).toContain("root.addChild(splash.root)");
	});
});

describe("Footer thinking level reads pi.getThinkingLevel() (#62)", () => {
	it("uses Pi 0.74.0 public getter on ExtensionAPI when present", () => {
		const fs = require("node:fs") as typeof import("node:fs");
		const path = new URL("../../footer.ts", import.meta.url);
		const source = fs.readFileSync(path, "utf8") as string;
		const fnSlice = source.slice(source.indexOf("function getThinkingLevel"), source.indexOf("function getSessionUsage"));
		expect(fnSlice).toContain("getThinkingLevel?: () => ThinkingLevel");
		// PR #62 corrected the lookup target from ctx → pi (ExtensionAPI).
		expect(fnSlice).toContain("piGetter.call(pi)");
	});
});
