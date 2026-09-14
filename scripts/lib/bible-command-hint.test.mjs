import { describe, expect, it } from "vitest";
import { INPUT_FRAME_HINT_KEYBINDS } from "../../src/cathedral/input-frame.js";
import { COMMAND_HINT_HTML, COMMAND_HINT_LEN } from "./bible-command-hint.mjs";

describe("bible command hint", () => {
	it("paints the runtime keybind at its visible width", () => {
		const plain = COMMAND_HINT_HTML.replace(/<[^>]+>/g, "");
		expect(plain).toBe(INPUT_FRAME_HINT_KEYBINDS);
		expect(COMMAND_HINT_LEN).toBe(plain.length);
	});
});
