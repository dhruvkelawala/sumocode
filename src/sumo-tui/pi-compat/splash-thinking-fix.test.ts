import { describe, expect, it } from "vitest";

describe("UX_SPEC §0 — splash takes no-messages slot, not empty-chat-quote (#60)", () => {
	it("splash predicate triggers when chat has zero messages regardless of sidebar visibility", () => {
		// Pure regression guard: ensure shouldShowEmptyChatQuote is not on the
		// hot path of syncChatSlot. We test by inspecting the source surface.
		const path = new URL("./sumo-interactive-mode.ts", import.meta.url);
		const source = require("node:fs").readFileSync(path, "utf8") as string;
		const syncBlock = source.slice(source.indexOf("private syncChatSlot()"), source.indexOf("private syncChatSlot()") + 1500);
		// The body must NOT branch on showEmptyQuote anymore.
		expect(syncBlock).not.toContain("showEmptyQuote");
		// Splash mount must remain.
		expect(syncBlock).toContain("this.root.addChild(this.splash.root)");
	});
});

describe("Footer thinking level reads ctx.getThinkingLevel() (#60)", () => {
	it("uses Pi 0.70.2 public getter when present, not the legacy property fallback", () => {
		const fs = require("node:fs") as typeof import("node:fs");
		const path = new URL("../../footer.ts", import.meta.url);
		const source = fs.readFileSync(path, "utf8") as string;
		const fnSlice = source.slice(source.indexOf("function getThinkingLevel"), source.indexOf("function getSessionUsage"));
		expect(fnSlice).toContain("getThinkingLevel?: () => ThinkingLevel");
		expect(fnSlice).toContain("getter.call(ctx)");
	});
});
