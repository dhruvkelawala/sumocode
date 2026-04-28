import { describe, expect, it } from "vitest";
import { chatScrollCommandFromInput, chatScrollCommandFromKey, chatScrollHintLabel } from "./chat-scroll-command.js";

describe("chat scroll commands", () => {
	it("maps terminal input bytes to scroll key events", () => {
		expect(chatScrollCommandFromInput("\x1b[5~")?.key).toBe("PageUp");
		expect(chatScrollCommandFromInput("\x1b[6~")?.key).toBe("PageDown");
		expect(chatScrollCommandFromInput("\x1b[H")?.key).toBe("Home");
		expect(chatScrollCommandFromInput("\x1b[F")?.key).toBe("End");
		expect(chatScrollCommandFromInput("\x1b[b")?.key).toBe("End");
		expect(chatScrollCommandFromInput("x")).toBeUndefined();
	});

	it("maps key events to semantic scroll commands", () => {
		expect(chatScrollCommandFromKey({ key: "PageUp" })).toBe("page-up");
		expect(chatScrollCommandFromKey({ key: "PgDn" })).toBe("page-down");
		expect(chatScrollCommandFromKey({ key: "Home" })).toBe("jump-top");
		expect(chatScrollCommandFromKey({ key: "End" })).toBe("jump-bottom");
		expect(chatScrollCommandFromKey({ key: "Shift+Down" })).toBe("jump-bottom");
		expect(chatScrollCommandFromKey({ key: "Down" })).toBeUndefined();
	});

	it("keeps user-facing command labels next to command definitions", () => {
		expect(chatScrollHintLabel("jump-bottom")).toBe("⇧↓");
	});
});
