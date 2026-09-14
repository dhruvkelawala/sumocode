import { describe, expect, it } from "vitest";
import { auditGeometry } from "./geometry-audit.mjs";

function snapshot(lines) {
	return { plainText: lines.join("\n"), cols: 160, rows: lines.length };
}

describe("geometry-audit row classification", () => {
	it("classifies the landscape footer carrying the keybind as footer", () => {
		// Issue #559: the landscape footer paints `CTRL+/ · COMMANDS` in its
		// right zone; the `● STATE` left zone still makes it a footer.
		const audit = auditGeometry(snapshot([
			" ● MEDITATING · active-working · off                                                                          CTRL+/ · COMMANDS ",
		]));
		expect(audit.rows[0].category).toBe("footer");
	});

	it("classifies the portrait hint row as hint-row", () => {
		const audit = auditGeometry(snapshot([
			" sumocode (main)                                                                          CTRL+/ · COMMANDS ",
		]));
		expect(audit.rows[0].category).toBe("hint-row");
	});

	it("classifies a right-aligned keybind-only hint row as hint-row", () => {
		const audit = auditGeometry(snapshot([
			"                                                                                          CTRL+/ · COMMANDS ",
		]));
		expect(audit.rows[0].category).toBe("hint-row");
	});

	it("classifies the centered splash hint row as hint-row", () => {
		const audit = auditGeometry(snapshot([
			"                             ╰─ no model · medium                                    CTRL+/ · COMMANDS ",
		]));
		expect(audit.rows[0].category).toBe("hint-row");
	});

	it("classifies the portrait footer (tokens + cost, no keybind) as footer", () => {
		const audit = auditGeometry(snapshot([
			" ● READY · gpt-5.5 · medium                                                         42k/200k · $0.42 ",
		]));
		expect(audit.rows[0].category).toBe("footer");
	});

	it("keeps a ●-prefixed content row out of the footer category", () => {
		// Only a state dot followed by a Cathedral state verb is a footer; a bare
		// bullet in chat content or a card line stays content.
		const audit = auditGeometry(snapshot([
			" ● Track D smoke session                                                                                      ",
		]));
		expect(audit.rows[0].category).toBe("content");
	});

	it("accepts a lowercase state label as a footer", () => {
		const audit = auditGeometry(snapshot([
			" ● ready · claude-opus-4-6 · high                                                         42k/200k · $0.42 ",
		]));
		expect(audit.rows[0].category).toBe("footer");
	});

	it("passes a geometry spec that expects the landscape footer category", () => {
		const audit = auditGeometry(
			snapshot([" ● READY · gpt-5.5 · medium                                                                   CTRL+/ · COMMANDS "]),
			{ regions: [{ startRow: 0, endRow: 0, category: "footer" }] },
		);
		expect(audit.passed).toBe(true);
	});
});
