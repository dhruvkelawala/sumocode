import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseBibleStyledGrid } from "./styled-cell-grid.mjs";

const tempDirs = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Writes a minimal scene HTML and returns its path for parseBibleStyledGrid. */
function sceneFile(tracks, { middleRule = "grid-row: 4;", template = true, extra = "" } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "styled-cell-grid-"));
	tempDirs.push(dir);
	const path = join(dir, "scene.html");
	const templateRule = template ? `\n\t.scene { display: grid; grid-template-rows: ${tracks}; }` : "";
	writeFileSync(path, `<!doctype html><html><head><style>
	--term-cols: 80; --term-rows: ${ROWS};${templateRule}
	.middle { display: grid; grid-template-columns: 76ch 2ch 0ch; ${middleRule} }
</style></head><body>
	<div class="term scene"><div class="middle"></div>${extra}</div>
</body></html>`);
	return path;
}

const ROWS = 40;
const INPUT_TRACK = "calc(var(--cell-h) * 3)";
const LANDSCAPE_TRACKS = `var(--cell-h) var(--cell-h) var(--cell-h) auto var(--cell-h) ${INPUT_TRACK} var(--cell-h) var(--cell-h)`;
/** Chrome tracks in LANDSCAPE_TRACKS: 6 one-row tracks + the 3-row input frame. */
const LANDSCAPE_CHROME_ROWS = 9;
const TOP = '<pre class="grid" style="grid-row: 5;">TOP</pre>';

function rowOf(grid, text) {
	for (let row = 0; row < grid.length; row++) {
		if (grid[row].map((cell) => cell.char).join("").includes(text)) return row;
	}
	return -1;
}

describe("scene geometry", () => {
	it("derives row starts from the template's own track heights", () => {
		const html = sceneFile(LANDSCAPE_TRACKS, { extra: TOP });
		const { grid } = parseBibleStyledGrid(html);
		expect(rowOf(grid, "TOP")).toBe(3 + (ROWS - LANDSCAPE_CHROME_ROWS));
	});

	it("moves the crop rows when a chrome track changes height", () => {
		const html = sceneFile(LANDSCAPE_TRACKS.replace(INPUT_TRACK, "calc(var(--cell-h) * 2)"), { extra: TOP });
		const { grid } = parseBibleStyledGrid(html);
		expect(rowOf(grid, "TOP")).toBe(3 + (ROWS - (LANDSCAPE_CHROME_ROWS - 1)));
	});

	it("rejects a scene without a .scene grid template", () => {
		const html = sceneFile(LANDSCAPE_TRACKS, { template: false });
		expect(() => parseBibleStyledGrid(html)).toThrow(/no \.scene grid-template-rows/);
	});

	it("rejects a scene whose .middle rule has no grid-row", () => {
		const html = sceneFile(LANDSCAPE_TRACKS, { middleRule: "min-height: 0;" });
		expect(() => parseBibleStyledGrid(html)).toThrow(/no \.middle grid-row/);
	});

	it("rejects a .middle grid-row outside the declared tracks", () => {
		const html = sceneFile(LANDSCAPE_TRACKS, { middleRule: "grid-row: 12;" });
		expect(() => parseBibleStyledGrid(html)).toThrow(/grid-row 12 is outside the 8-track scene grid/);
	});

	it("rejects a chrome track the layout sizes instead of the template", () => {
		const html = sceneFile(LANDSCAPE_TRACKS.replace(INPUT_TRACK, "auto"));
		expect(() => parseBibleStyledGrid(html)).toThrow(/scene track 6 \(auto\) has no fixed row height/);
	});

	it("rejects an unbalanced grid-template-rows value", () => {
		const html = sceneFile(LANDSCAPE_TRACKS.replace(INPUT_TRACK, "calc(var(--cell-h) * 3"));
		expect(() => parseBibleStyledGrid(html)).toThrow(/unbalanced parentheses/);
	});
});
