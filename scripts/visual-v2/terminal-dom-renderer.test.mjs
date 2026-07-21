import { describe, expect, it } from "vitest";
import { terminalSnapshotHtml } from "./terminal-dom-renderer.mjs";

const snapshot = {
	cols: 2,
	rows: 1,
	cells: [[
		{ char: "", fg: "#B974FF", bg: "#06050B", bold: false, dim: false, italic: false, underline: false, inverse: false, width: 1 },
		{ char: "M", fg: "#DCC7FF", bg: "#06050B", bold: false, dim: false, italic: false, underline: false, inverse: false, width: 1 },
	]],
};

describe("terminalSnapshotHtml", () => {
	it("maps only RunCat PUA glyphs before JetBrains Mono", () => {
		const html = terminalSnapshotHtml(snapshot);

		expect(html).toContain("font-family: 'RunCat'");
		expect(html).toContain("format('truetype')");
		expect(html).toContain("assets/fonts/runcat.ttf");
		expect(html).toContain("unicode-range: U+E900-E904");
		expect(html).toContain("font-family: 'RunCat', 'JetBrains Mono', ui-monospace, Menlo, monospace");
	});

	it("preserves fixed cell-run metrics for ordinary cells", () => {
		const html = terminalSnapshotHtml(snapshot, { glyphBaselineShiftPx: 1 });

		expect(html).toContain("width: 1ch; min-width: 1ch");
		expect(html).toContain("height: var(--cell-h)");
		expect(html).toContain("line-height: var(--cell-h)");
		expect(html).toContain("transform: translateY(1px)");
	});
});
