import { describe, expect, it } from "vitest";
import { renderEmptyChatQuote } from "./empty-chat-quote-setheader.js";

describe("empty chat quote header spike", () => {
	it("renders centered quote only when there are no messages", () => {
		const lines = renderEmptyChatQuote({ quote: "nothing left", attribution: "saint-exupéry", hasMessages: false }, 60, 6);
		expect(lines.join("\n")).toContain("\"nothing left\"");
		expect(lines.join("\n")).toContain("— saint-exupéry");
		expect(renderEmptyChatQuote({ quote: "x", attribution: "y", hasMessages: true }, 60)).toEqual([]);
	});
});
