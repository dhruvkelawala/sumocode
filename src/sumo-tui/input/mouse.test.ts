import { describe, expect, it } from "vitest";
import { parseSgrMouseEvent, parseSgrMouseStream } from "./mouse.js";

describe("SGR mouse parser", () => {
	it("parses down/up events as zero-based cell coordinates", () => {
		expect(parseSgrMouseEvent("\x1b[<0;10;5M")).toMatchObject({ type: "down", button: 0, col: 9, row: 4 });
		expect(parseSgrMouseEvent("\x1b[<0;10;5m")).toMatchObject({ type: "up", button: 0, col: 9, row: 4 });
	});

	it("parses drag and move events", () => {
		expect(parseSgrMouseEvent("\x1b[<32;4;3M")).toMatchObject({ type: "drag", button: 0, col: 3, row: 2 });
		expect(parseSgrMouseEvent("\x1b[<35;4;3M")).toMatchObject({ type: "move", col: 3, row: 2 });
	});

	it("parses wheel up/down and modifiers", () => {
		expect(parseSgrMouseEvent("\x1b[<68;2;1M")).toEqual({
			type: "scroll",
			button: 64,
			scrollDir: "up",
			col: 1,
			row: 0,
			modifiers: { shift: true, alt: false, ctrl: false },
		});
		expect(parseSgrMouseEvent("\x1b[<65;2;1M")).toMatchObject({ type: "scroll", button: 65, scrollDir: "down" });
	});

	it("consumes complete sequences and preserves incomplete rest", () => {
		const parsed = parseSgrMouseStream(`noise\x1b[<0;1;1M\x1b[<65;2;2M\x1b[<64;`);
		expect(parsed.events.map((event) => event.type)).toEqual(["down", "scroll"]);
		expect(parsed.rest).toBe("\x1b[<64;");
	});
});
