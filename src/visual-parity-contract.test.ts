import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { SIDEBAR_MIN_TERMINAL_WIDTH, SIDEBAR_WIDTH } from "./sidebar.js";

// `pngjs` has no bundled type declarations and this repo intentionally does
// not add a project-wide ambient module for it (see scripts/visual-v2/*.mjs,
// which consume it untyped via plain JS). Loading it through `createRequire`
// keeps this single test file's PNG-fixture helper out of strict-mode's way
// without adding a new type dependency or a repo-wide `declare module`.
const require = createRequire(import.meta.url);
type PngInstance = { width: number; height: number; data: Buffer };
type PngCtor = (new (opts: { width: number; height: number }) => PngInstance) & { sync: { write: (png: PngInstance) => Buffer } };
const { PNG } = require("pngjs") as { PNG: PngCtor };

type CropDefinition =
	| { kind: "full" }
	| {
			x: number;
			y: number;
			cols: number;
			rows: number;
	  };

type ScenarioCrop = {
	id: string;
	status?: "review" | "approved" | "required";
	threshold?: number;
};

type RuntimeInput =
	| {
			afterMs?: number;
			type: "text" | "key";
			value: string;
	  }
	| {
			afterMs?: number;
			type: "waitForOutput";
			pattern: string;
			timeoutMs?: number;
	  }
	| {
			afterMs?: number;
			type: "waitForFinalScreenMatches";
			include: string[];
			exclude?: string[];
			timeoutMs?: number;
	  };

type Scenario = {
	id: string;
	lane: "component" | "runtime" | "fixture";
	status: "review" | "approved" | "required";
	bibleTarget: string;
	dimensions: {
		cols: number;
		rows: number;
	};
	runtime?: {
		command: string;
		args: string[];
		env?: Record<string, string>;
		inputs?: RuntimeInput[];
	};
	fixture?: {
		id: string;
	};
	rejectIfOutputMatches?: string[];
	rejectIfFinalScreenMatches?: string[];
	crops: ScenarioCrop[];
};

type ScenarioManifest = {
	version: number;
	crops: Record<string, CropDefinition>;
	scenarios: Scenario[];
};

const manifestPath = join(process.cwd(), "docs/visual/parity/scenarios.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ScenarioManifest;

function scenario(id: string): Scenario {
	const found = manifest.scenarios.find((item) => item.id === id);
	if (!found) throw new Error(`Missing visual parity scenario ${id}`);
	return found;
}

function cropDefinition(id: string): CropDefinition {
	const found = manifest.crops[id];
	if (!found) throw new Error(`Missing visual parity crop ${id}`);
	return found;
}

function requiredCropIds(id: string): string[] {
	return scenario(id).crops
		.filter((crop) => (crop.status ?? scenario(id).status) === "required")
		.map((crop) => crop.id);
}

function assertActiveRuntimeInputContract(active: Scenario): void {
	const inputs = active.runtime?.inputs ?? [];
	expect(inputs.some((input) => "value" in input && input.value === "\u001b[13u")).toBe(false);
	expect(inputs[0]).toMatchObject({
		type: "waitForFinalScreenMatches",
		include: expect.arrayContaining(["DIVINE INVOCATION"]),
	});
	expect(inputs).toEqual(expect.arrayContaining([
		expect.objectContaining({
			type: "key",
			value: "Enter",
		}),
		expect.objectContaining({
			type: "waitForFinalScreenMatches",
			include: expect.arrayContaining([
				"SUMOCODE",
				"inspecting src/auth/session\\.ts",
				"review src/auth/session\\.ts and tighten the return type",
			]),
			exclude: expect.arrayContaining([
				"No API key found",
				"rpc error: prompt failed",
				"DIVINE INVOCATION",
				"unknown · off",
				"\\^\\[\\[13u",
			]),
		}),
	]));
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function writeOnePixelPng(path: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
}

function blankSnapshot(cols: number, rows: number): unknown {
	const cell = { char: " ", fg: "#f5e6c8", bg: "#1a1511", bold: false, dim: false };
	return {
		cols,
		rows,
		cells: Array.from({ length: rows }, () => Array.from({ length: cols }, () => cell)),
	};
}

type CellOverride = { row: number; col: number; char?: string; fg?: string; bg?: string };

/** A blank snapshot with independent (non-shared) cell objects per position,
 * so callers can mutate individual cells via `writeRowText` without
 * accidentally rewriting the whole grid. `blankSnapshot` above intentionally
 * shares one cell object across every position — fine for read-only fixtures,
 * unsafe for mutation. */
function mutableBlankSnapshot(cols: number, rows: number): any {
	return {
		cols,
		rows,
		cells: Array.from({ length: rows }, () =>
			Array.from({ length: cols }, () => ({ char: " ", fg: "#f5e6c8", bg: "#1a1511", bold: false, dim: false }))),
	};
}

/** Blank snapshot with individual cell text overrides applied — lets a test
 * write specific characters into specific rows/cols without hand-building
 * the full 160/60-wide cell grid. */
function snapshotWithText(cols: number, rows: number, overrides: readonly CellOverride[]): any {
	const snapshot = mutableBlankSnapshot(cols, rows);
	for (const override of overrides) {
		const cell = snapshot.cells[override.row]?.[override.col];
		if (!cell) throw new Error(`snapshotWithText override out of bounds: row ${override.row} col ${override.col}`);
		if (override.char !== undefined) cell.char = override.char;
		if (override.fg !== undefined) cell.fg = override.fg;
		if (override.bg !== undefined) cell.bg = override.bg;
	}
	return snapshot;
}

/** Write a row of text starting at `col` into a snapshot's given row. */
function writeRowText(snapshot: any, row: number, col: number, text: string): void {
	for (let index = 0; index < text.length; index += 1) {
		const cell = snapshot.cells[row]?.[col + index];
		if (cell) cell.char = text[index];
	}
}

/** Write a solid-color PNG sized for a crop's pixel dimensions (cellWidth/cellHeight
 * px per terminal cell, matching the harness's own crop screenshot convention). */
function writeCropPng(path: string, cropCols: number, cropRows: number, rgb: readonly [number, number, number]): void {
	mkdirSync(join(path, ".."), { recursive: true });
	const cellPx = 8;
	const width = cropCols * cellPx;
	const height = cropRows * cellPx;
	const png = new PNG({ width, height });
	for (let index = 0; index < png.data.length; index += 4) {
		png.data[index] = rgb[0];
		png.data[index + 1] = rgb[1];
		png.data[index + 2] = rgb[2];
		png.data[index + 3] = 255;
	}
	writeFileSync(path, PNG.sync.write(png));
}

describe("V2 visual parity contract", () => {
	it("locks the V2 sidebar and scenario dimensions", () => {
		expect(SIDEBAR_WIDTH).toBe(30);
		expect(SIDEBAR_MIN_TERMINAL_WIDTH).toBe(120);
		expect(scenario("input-typed-component").dimensions).toEqual({ cols: 160, rows: 4 });
		expect(scenario("footer-ready-component").dimensions).toEqual({ cols: 160, rows: 1 });
		expect(scenario("top-bar-default-component").dimensions).toEqual({ cols: 160, rows: 1 });
		expect(scenario("sidebar-editorial-component").dimensions).toEqual({ cols: 30, rows: 26 });
		expect(scenario("splash-runtime").dimensions).toEqual({ cols: 160, rows: 45 });
		expect(scenario("active-landscape-runtime").dimensions).toEqual({ cols: 160, rows: 45 });
		expect(scenario("active-portrait-runtime").dimensions).toEqual({ cols: 60, rows: 100 });
		expect(scenario("fixture-completed-landscape").dimensions).toEqual({ cols: 160, rows: 45 });
		expect(scenario("fixture-completed-portrait").dimensions).toEqual({ cols: 60, rows: 100 });
		expect(cropDefinition("sidebar")).toEqual({ x: 130, y: 3, cols: 30, rows: 34 });
	});

	it("keeps splash runtime capture on the user-facing invocation contract", () => {
		const splash = scenario("splash-runtime");

		expect(splash.runtime?.command).toBe("./bin/sumocode.sh");
		expect(splash.runtime?.args).toEqual(["--offline", "--no-extensions", "--no-session"]);
		expect(splash.runtime?.env).toMatchObject({ SUMO_TUI: "1", PI_OFFLINE: "1" });
		expect(splash.rejectIfOutputMatches).toEqual(expect.arrayContaining([
			"ERR_MODULE_NOT_FOUND",
			"Rendered line .* exceeds terminal width",
			"Skipping installed SumoCode extension because this session is already inside an active SumoCode dev checkout",
			"Error \\\[",
		]));
		expect(splash.rejectIfOutputMatches).not.toEqual(expect.arrayContaining([
			"SUMOCODE RPC",
			"empty transcript",
			"sumocode \\u00b7 rpc host",
		]));
		expect(splash.rejectIfFinalScreenMatches).toEqual(expect.arrayContaining([
			"SUMOCODE RPC",
			"empty transcript",
			"sumocode \\u00b7 rpc host",
		]));
		expect(requiredCropIds("splash-runtime")).toEqual(["full"]);
	});

	it("keeps active landscape runtime composition crops present", () => {
		const active = scenario("active-landscape-runtime");

		expect(active.bibleTarget).toBe("scene-active-runtime.png");
		expect(active.bibleTarget).not.toBe("scene-active.png");
		expect(active.runtime?.args).toEqual([
			"--offline",
			"--no-extensions",
			"--no-session",
			"-e",
			"./scripts/visual-v2/runtime-faux-provider.mjs",
			"--model",
			"sumocode-visual/active-working",
		]);
		expect(active.runtime?.env).not.toHaveProperty("SUMOCODE_VISUAL_RPC_FIXTURE");
		assertActiveRuntimeInputContract(active);
		expect(active.crops.map((crop) => crop.id)).toEqual([
			"full",
			"top-bar",
			"sidebar",
			"chat-area",
			"input-frame",
			"hint-row",
			"footer",
		]);
		expect(active.rejectIfOutputMatches).not.toEqual(expect.arrayContaining([
			"SUMOCODE RPC",
			"empty transcript",
			"sumocode \\u00b7 rpc host",
		]));
		expect(active.rejectIfFinalScreenMatches).toEqual(expect.arrayContaining([
			"No API key found",
			"rpc error: prompt failed",
			"DIVINE INVOCATION",
			"unknown · off",
			"\\^\\[\\[13u",
			"SUMOCODE RPC",
			"empty transcript",
			"sumocode \\u00b7 rpc host",
		]));
		expect(requiredCropIds("active-landscape-runtime")).toEqual([
			"top-bar",
			"sidebar",
			"chat-area",
			"input-frame",
			"hint-row",
			"footer",
		]);
	});

	it("keeps the V1 portrait runtime no-sidebar with crop-level evidence", () => {
		const portrait = scenario("active-portrait-runtime");

		expect(portrait.bibleTarget).toBe("scene-active-runtime-portrait.png");
		expect(portrait.bibleTarget).not.toBe("scene-active-portrait.png");
		expect(portrait.dimensions.cols).toBeLessThan(SIDEBAR_MIN_TERMINAL_WIDTH);
		expect(portrait.runtime?.env).toMatchObject({
			COLUMNS: "60",
			LINES: "100",
		});
		expect(portrait.runtime?.env).not.toHaveProperty("SUMOCODE_VISUAL_RPC_FIXTURE");
		expect(portrait.runtime?.args).toEqual([
			"--offline",
			"--no-extensions",
			"--no-session",
			"-e",
			"./scripts/visual-v2/runtime-faux-provider.mjs",
			"--model",
			"sumocode-visual/active-working",
		]);
		assertActiveRuntimeInputContract(portrait);
		expect(portrait.crops.map((crop) => crop.id)).toEqual([
			"full",
			"top-bar",
			"chat-area",
			"input-frame",
			"hint-row",
			"footer",
		]);
		expect(portrait.crops.map((crop) => crop.id)).not.toContain("sidebar");
		expect(portrait.rejectIfOutputMatches).not.toEqual(expect.arrayContaining([
			"SUMOCODE RPC",
			"empty transcript",
			"sumocode \\u00b7 rpc host",
		]));
		expect(portrait.rejectIfFinalScreenMatches).toEqual(expect.arrayContaining([
			"No API key found",
			"rpc error: prompt failed",
			"DIVINE INVOCATION",
			"unknown · off",
			"\\^\\[\\[13u",
			"SUMOCODE RPC",
			"empty transcript",
			"sumocode \\u00b7 rpc host",
		]));
		expect(requiredCropIds("active-portrait-runtime")).toEqual([
			"top-bar",
			"chat-area",
			"input-frame",
			"hint-row",
			"footer",
		]);
		expect(cropDefinition("portrait-top-bar")).toEqual({ x: 0, y: 1, cols: 60, rows: 1 });
		expect(cropDefinition("portrait-input-frame")).toEqual({ x: 0, y: 93, cols: 60, rows: 3 });
		expect(cropDefinition("portrait-footer")).toEqual({ x: 0, y: 98, cols: 60, rows: 1 });
	});

	it("places active runtime Bible input rows at terminal coordinates", () => {
		const parserUrl = pathToFileURL(join(process.cwd(), "scripts/visual-v2/styled-cell-grid.mjs")).href;
		const htmlPath = join(process.cwd(), "docs/ui/bible/scene-active-runtime.html");
		const script = `
			import { parseBibleStyledGrid } from ${JSON.stringify(parserUrl)};
			const parsed = parseBibleStyledGrid(${JSON.stringify(htmlPath)});
			const rows = [38, 39, 40].map((row) => ({
				text: parsed.grid[row].map((cell) => cell.char).join(""),
				cursorBg: parsed.grid[row][4]?.bg,
			}));
			console.log(JSON.stringify(rows));
		`;
		const rows = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
			cwd: process.cwd(),
			encoding: "utf8",
		})) as Array<{ text: string; cursorBg: string }>;

		expect(rows[0]?.text.startsWith("┌")).toBe(true);
		expect(rows[0]?.text.endsWith("┐")).toBe(true);
		expect(rows[1]?.text).toContain("│ >");
		expect(rows[1]?.cursorBg).toBe("#D97706");
		expect(rows[1]?.text.endsWith("│")).toBe(true);
		expect(rows[2]?.text.startsWith("└")).toBe(true);
		expect(rows[2]?.text.endsWith("┘")).toBe(true);
	});

	it("keeps modal overlay Bible scenes on overlay target rows", () => {
		const parserUrl = pathToFileURL(join(process.cwd(), "scripts/visual-v2/styled-cell-grid.mjs")).href;
		const htmlPath = join(process.cwd(), "docs/ui/bible/scene-divine-query-overlay.html");
		const script = `
			import { parseBibleStyledGrid, cropStyledGrid } from ${JSON.stringify(parserUrl)};
			const parsed = parseBibleStyledGrid(${JSON.stringify(htmlPath)});
			const crop = cropStyledGrid(parsed, { x: 40, y: 14, cols: 80, rows: 17 });
			console.log(JSON.stringify(crop.grid.map((row) => row.map((cell) => cell.char).join(""))));
		`;
		const rows = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
			cwd: process.cwd(),
			encoding: "utf8",
		})) as string[];

		expect(rows.join("\n")).toContain("DIVINE QUERY");
		expect(rows.join("\n")).toContain("fetchUser");
	});

	it("keeps fixture scenes deterministic and review-only", () => {
		expect(scenario("fixture-completed-landscape")).toMatchObject({ status: "review" });
		expect(scenario("fixture-completed-portrait")).toMatchObject({ status: "review" });
		expect(scenario("fixture-command-palette-overlay")).toMatchObject({ status: "review" });
		expect(scenario("fixture-tool-ledger-landscape")).toMatchObject({ status: "review" });
		expect(scenario("fixture-completed-landscape").bibleTarget).toBe("scene-active.png");
		expect(scenario("fixture-completed-portrait").bibleTarget).toBe("scene-active-portrait.png");
		expect(scenario("fixture-completed-landscape").fixture?.id).toBe("completed-active");
		expect(scenario("fixture-completed-portrait").fixture?.id).toBe("completed-active");
		expect(scenario("fixture-completed-landscape").crops.map((crop) => crop.id)).toEqual([
			"full",
			"top-bar",
			"sidebar",
			"chat-area",
			"input-frame",
			"hint-row",
			"footer",
		]);
		expect(scenario("fixture-command-palette-overlay").crops.map((crop) => crop.id)).toEqual(["full", "overlay-center"]);
		expect(cropDefinition("overlay-center")).toEqual({ x: 40, y: 14, cols: 80, rows: 17 });
	});

	it("keeps runtime scenarios real and exposes the main-vs-branch compare harness", () => {
		const runtimeScenarios = manifest.scenarios.filter((item) => item.lane === "runtime");
		for (const item of runtimeScenarios) {
			expect(item.runtime?.env).not.toHaveProperty("SUMOCODE_VISUAL_RPC_FIXTURE");
			expect(item.runtime?.env).not.toHaveProperty("SUMOCODE_VISUAL_RPC_INPUT_PREVIEW");
		}
		const runtimeCaptureSource = readFileSync(join(process.cwd(), "scripts/visual-v2/runtime-capture.mjs"), "utf8");
		expect(runtimeCaptureSource).toContain('SUMOCODE_HARNESS: "1"');
		expect(runtimeCaptureSource).not.toContain("SUMOCODE_HARNESS_FIXTURE");
		expect(existsSync(join(process.cwd(), "scripts/visual-v2/compare-captures.mjs"))).toBe(true);
	});

	it("allows main-vs-branch comparison to consume legacy main runtime metadata", () => {
		const tmp = mkdtempSync(join(tmpdir(), "sumocode-compare-contract-"));
		try {
			const baseline = join(tmp, "baseline");
			const candidate = join(tmp, "candidate");
			const out = join(tmp, "out");
			for (const root of [baseline, candidate]) {
				writeJson(join(root, "splash-runtime/raw/capture-metadata.json"), {
					command: "./bin/sumocode.sh",
					args: ["--offline", "--no-extensions", "--no-session"],
					cols: 160,
					rows: 45,
					inputCount: 0,
				});
				writeJson(join(root, "splash-runtime/raw/terminal-snapshot.json"), blankSnapshot(160, 45));
				writeOnePixelPng(join(root, "splash-runtime/crops/full-runtime.png"));
			}

			execFileSync("node", [
				join(process.cwd(), "scripts/visual-v2/compare-captures.mjs"),
				"--baseline-root",
				baseline,
				"--candidate-root",
				candidate,
				"--scenario",
				"splash-runtime",
				"--out",
				out,
			], { cwd: process.cwd(), stdio: "pipe" });

			const validation = readFileSync(join(out, "splash-runtime/raw/contract-validation.txt"), "utf8");
			expect(validation).toContain("legacy capture metadata accepted");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("rejects legacy active captures that skipped scripted runtime input", () => {
		const tmp = mkdtempSync(join(tmpdir(), "sumocode-compare-contract-"));
		try {
			const baseline = join(tmp, "baseline");
			const candidate = join(tmp, "candidate");
			const out = join(tmp, "out");
			for (const root of [baseline, candidate]) {
				writeJson(join(root, "active-landscape-runtime/raw/capture-metadata.json"), {
					command: "./bin/sumocode.sh",
					args: ["--offline", "--no-extensions", "--no-session"],
					cols: 160,
					rows: 45,
					inputCount: 0,
				});
			}

			let failed = false;
			try {
				execFileSync("node", [
					join(process.cwd(), "scripts/visual-v2/compare-captures.mjs"),
					"--baseline-root",
					baseline,
					"--candidate-root",
					candidate,
					"--scenario",
					"active-landscape-runtime",
					"--out",
					out,
				], { cwd: process.cwd(), stdio: "pipe" });
			} catch {
				failed = true;
			}

			const validation = readFileSync(join(out, "active-landscape-runtime/raw/contract-validation.txt"), "utf8");
			expect(failed).toBe(true);
			expect(validation).toContain("legacy metadata inputCount differs from current manifest: 0 !== 4");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	describe("plan-024 known-equivalent-region declarations (over-masking guard)", () => {
		const active = scenario("active-landscape-runtime");
		const cropIds = active.crops.map((crop) => crop.id);

		function writeActiveLandscapeCapture(root: string, snapshot: unknown, pngColorByCrop: Record<string, [number, number, number]>): void {
			writeJson(join(root, "active-landscape-runtime/raw/capture-metadata.json"), {
				command: active.runtime!.command,
				args: active.runtime!.args,
				cols: active.dimensions.cols,
				rows: active.dimensions.rows,
				inputCount: active.runtime!.inputs!.length,
			});
			writeJson(join(root, "active-landscape-runtime/raw/terminal-snapshot.json"), snapshot);
			for (const cropId of cropIds) {
				const namedCrop = cropId === "full" ? null : (cropDefinition(cropId) as { x: number; y: number; cols: number; rows: number });
				const dims = namedCrop ?? { cols: active.dimensions.cols, rows: active.dimensions.rows };
				writeCropPng(
					join(root, "active-landscape-runtime/crops", `${cropId}-runtime.png`),
					dims.cols,
					dims.rows,
					pngColorByCrop[cropId] ?? [30, 24, 18],
				);
			}
		}

		// Base scene: only the five declared-equivalent regions differ between
		// baseline and candidate (session id, timestamp, cursor-caret swap,
		// hint-row/sidebar cwd+branch text, D4 constants, MCP roster). Everything
		// else — including the sidebar row immediately below the masked cwd/branch
		// lines — is byte-identical.
		function baseLandscapeSnapshot(sessionId: string, timestampMinute: string, projectLine: string): unknown {
			const snap = snapshotWithText(160, 45, []);
			// Column offsets below are copied verbatim from a real
			// active-landscape-runtime capture so the synthetic fixture exercises
			// the SAME absolute cell coordinates the declared regions cover.
			writeRowText(snap, 0, 0, ` SUMOCODE  ║ • ${sessionId} ║`);
			writeRowText(snap, 6, 0, `┌ SUMO ${"─".repeat(112)} ${timestampMinute} ─┐`);
			writeRowText(snap, 10, 132, projectLine);
			writeRowText(snap, 36, 1, "⊚ Working…"); // stable, NOT masked at cols >=3 — must match both sides
			writeRowText(snap, 39, 0, "│ >");
			writeRowText(snap, 41, 1, `${"".padEnd(128)}CTRL+/ · COMMANDS`);
			writeRowText(snap, 43, 1, `${"● MEDITATING · active-working · off".padEnd(142)}42k/200k · $0.42`);
			return snap;
		}

		it("suppresses only the declared plan-024 mechanical regions and still passes", () => {
			const tmp = mkdtempSync(join(tmpdir(), "sumocode-equivalence-contract-"));
			try {
				const baseline = join(tmp, "baseline");
				const candidate = join(tmp, "candidate");
				const out = join(tmp, "out");

				const baselineSnapshot = baseLandscapeSnapshot("019f2893", "16:22", "sumocode-main-recapture");
				const candidateSnapshot = baseLandscapeSnapshot("019f28ad", "16:51", ""); // hint/sidebar text legitimately blank in candidate

				writeActiveLandscapeCapture(baseline, baselineSnapshot, {});
				writeActiveLandscapeCapture(candidate, candidateSnapshot, {});

				execFileSync("node", [
					join(process.cwd(), "scripts/visual-v2/compare-captures.mjs"),
					"--baseline-root", baseline,
					"--candidate-root", candidate,
					"--scenario", "active-landscape-runtime",
					"--out", out,
				], { cwd: process.cwd(), stdio: "pipe" });

				const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
				const scenarioResult = results.scenarios.find((item: { id: string }) => item.id === "active-landscape-runtime");
				expect(scenarioResult.result).toBe("passed");

				const diffText = readFileSync(join(out, "active-landscape-runtime/raw/styled-cell-diff.txt"), "utf8");
				expect(diffText).toContain("Suppressed by declared equivalence");
				expect(diffText).toContain("session-id chars in top bar");
			} finally {
				rmSync(tmp, { recursive: true, force: true });
			}
		});

		it("does NOT suppress a real content change adjacent to a masked region", () => {
			const tmp = mkdtempSync(join(tmpdir(), "sumocode-equivalence-contract-"));
			try {
				const baseline = join(tmp, "baseline");
				const candidate = join(tmp, "candidate");
				const out = join(tmp, "out");

				const baselineSnapshot = baseLandscapeSnapshot("019f2893", "16:22", "sumocode-main-recapture");
				const candidateSnapshot = baseLandscapeSnapshot("019f28ad", "16:51", "");

				// Sabotage: alter message text one row below the masked sidebar
				// cwd/branch region (row 12, still inside the sidebar column band
				// 130-159, but OUTSIDE the declared [10,11] row range). A real
				// editorial/content change here must still fail the gate — this is
				// the over-masking guard.
				writeRowText(candidateSnapshot as any, 12, 130, "unexpected content drift".padEnd(30));

				writeActiveLandscapeCapture(baseline, baselineSnapshot, {});
				writeActiveLandscapeCapture(candidate, candidateSnapshot, {});

				let failed = false;
				try {
					execFileSync("node", [
						join(process.cwd(), "scripts/visual-v2/compare-captures.mjs"),
						"--baseline-root", baseline,
						"--candidate-root", candidate,
						"--scenario", "active-landscape-runtime",
						"--out", out,
					], { cwd: process.cwd(), stdio: "pipe" });
				} catch {
					failed = true;
				}

				expect(failed).toBe(true);
				const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
				const scenarioResult = results.scenarios.find((item: { id: string }) => item.id === "active-landscape-runtime");
				expect(scenarioResult.result).toBe("failed");

				const diffText = readFileSync(join(out, "active-landscape-runtime/raw/styled-cell-diff.txt"), "utf8");
				expect(diffText).toContain("row  12");
				// Row text is truncated to 80 chars from col 0 in the report, so the
				// sabotaged text (which starts at col 130) shows up as per-cell char
				// diffs instead of in the truncated row-text preview.
				expect(diffText).toContain('char: " "→"u"');

				const sidebarCropDiff = readFileSync(join(out, "active-landscape-runtime/raw/styled-cell-diff-sidebar.txt"), "utf8");
				expect(sidebarCropDiff).not.toContain("Styled cell diff: MATCH");
			} finally {
				rmSync(tmp, { recursive: true, force: true });
			}
		});

		it("does NOT suppress a real content change inside the working-indicator row outside its masked column", () => {
			const tmp = mkdtempSync(join(tmpdir(), "sumocode-equivalence-contract-"));
			try {
				const baseline = join(tmp, "baseline");
				const candidate = join(tmp, "candidate");
				const out = join(tmp, "out");

				const baselineSnapshot = baseLandscapeSnapshot("019f2893", "16:22", "sumocode-main-recapture");
				const candidateSnapshot = baseLandscapeSnapshot("019f28ad", "16:51", "");

				// The working-indicator glyph region only covers row 36 col 1. Altering
				// the WORD text right after it (cols 3+) is a real content change and
				// must still fail even though col 1 on the same row is legitimately masked.
				writeRowText(candidateSnapshot as any, 36, 3, "Rewriting…");

				writeActiveLandscapeCapture(baseline, baselineSnapshot, {});
				writeActiveLandscapeCapture(candidate, candidateSnapshot, {});

				let failed = false;
				try {
					execFileSync("node", [
						join(process.cwd(), "scripts/visual-v2/compare-captures.mjs"),
						"--baseline-root", baseline,
						"--candidate-root", candidate,
						"--scenario", "active-landscape-runtime",
						"--out", out,
					], { cwd: process.cwd(), stdio: "pipe" });
				} catch {
					failed = true;
				}

				expect(failed).toBe(true);
				const diffText = readFileSync(join(out, "active-landscape-runtime/raw/styled-cell-diff.txt"), "utf8");
				expect(diffText).toContain("row  36");
			} finally {
				rmSync(tmp, { recursive: true, force: true });
			}
		});

		// Sixth class (main-is-stale splash rows): the mask is pattern-locked to
		// EXACTLY `unknown · off` (baseline) vs `AWAITING PROMPT` (candidate).
		// Any third string on either side must fail the gate.
		function writeSplashCapture(root: string, snapshot: unknown): void {
			writeJson(join(root, "splash-runtime/raw/capture-metadata.json"), {
				command: "./bin/sumocode.sh",
				args: ["--offline", "--no-extensions", "--no-session"],
				cols: 160,
				rows: 45,
				inputCount: 0,
			});
			writeJson(join(root, "splash-runtime/raw/terminal-snapshot.json"), snapshot);
			writeOnePixelPng(join(root, "splash-runtime/crops/full-runtime.png"));
		}

		function baseSplashSnapshot(hintText: string, versionLine: string): unknown {
			const snap = snapshotWithText(160, 45, []);
			// Column offsets copied from a real splash-runtime capture: the hint
			// row's `╰─ <status>` opens at col 50 (variable segment at cols 53+),
			// and the version line starts at col 56.
			writeRowText(snap, 34, 50, `╰─ ${hintText}`);
			if (versionLine.length > 0) writeRowText(snap, 43, 56, versionLine);
			return snap;
		}

		it("suppresses the adjudicated main-is-stale splash rows when both sides match their locked patterns", () => {
			const tmp = mkdtempSync(join(tmpdir(), "sumocode-equivalence-contract-"));
			try {
				const baseline = join(tmp, "baseline");
				const candidate = join(tmp, "candidate");
				const out = join(tmp, "out");

				writeSplashCapture(baseline, baseSplashSnapshot("unknown · off", ""));
				writeSplashCapture(candidate, baseSplashSnapshot("AWAITING PROMPT", "SUMOCODE V0.3.0 · CATHEDRAL · 160 × 45 MONOSPACE"));

				execFileSync("node", [
					join(process.cwd(), "scripts/visual-v2/compare-captures.mjs"),
					"--baseline-root", baseline,
					"--candidate-root", candidate,
					"--scenario", "splash-runtime",
					"--out", out,
				], { cwd: process.cwd(), stdio: "pipe" });

				const diffText = readFileSync(join(out, "splash-runtime/raw/styled-cell-diff.txt"), "utf8");
				expect(diffText).toContain("Styled cell diff: MATCH");
				expect(diffText).toContain("main-is-stale: splash hint row");
				expect(diffText).toContain("main-is-stale: splash version line");
			} finally {
				rmSync(tmp, { recursive: true, force: true });
			}
		});

		it("does NOT suppress a third splash hint string that matches neither locked pattern", () => {
			const tmp = mkdtempSync(join(tmpdir(), "sumocode-equivalence-contract-"));
			try {
				const baseline = join(tmp, "baseline");
				const candidate = join(tmp, "candidate");
				const out = join(tmp, "out");

				// Candidate renders a THIRD string — neither the baseline's locked
				// `unknown · off` nor the canon `AWAITING PROMPT`. The mask's
				// runtimePattern no longer matches, so the diff must surface.
				writeSplashCapture(baseline, baseSplashSnapshot("unknown · off", ""));
				writeSplashCapture(candidate, baseSplashSnapshot("SCRIPTOR OFFLINE", "SUMOCODE V0.3.0 · CATHEDRAL · 160 × 45 MONOSPACE"));

				let failed = false;
				try {
					execFileSync("node", [
						join(process.cwd(), "scripts/visual-v2/compare-captures.mjs"),
						"--baseline-root", baseline,
						"--candidate-root", candidate,
						"--scenario", "splash-runtime",
						"--out", out,
					], { cwd: process.cwd(), stdio: "pipe" });
				} catch {
					failed = true;
				}

				expect(failed).toBe(true);
				const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
				const scenarioResult = results.scenarios.find((item: { id: string }) => item.id === "splash-runtime");
				expect(scenarioResult.result).toBe("failed");
				const diffText = readFileSync(join(out, "splash-runtime/raw/styled-cell-diff.txt"), "utf8");
				expect(diffText).toContain("row  34");
			} finally {
				rmSync(tmp, { recursive: true, force: true });
			}
		});
	});

	it("keeps required crop gates explicit and preserves promoted goldens", () => {
		const requiredCrops = manifest.scenarios.flatMap((item) =>
			item.crops
				.filter((crop) => (crop.status ?? item.status) === "required")
				.map((crop) => ({ scenarioId: item.id, crop })),
		);

		expect(requiredCrops.map(({ scenarioId, crop }) => `${scenarioId}/${crop.id}`)).toEqual([
			"input-typed-component/input-frame",
			"footer-ready-component/footer",
			"top-bar-default-component/top-bar",
			"splash-runtime/full",
			"active-landscape-runtime/top-bar",
			"active-landscape-runtime/sidebar",
			"active-landscape-runtime/chat-area",
			"active-landscape-runtime/input-frame",
			"active-landscape-runtime/hint-row",
			"active-landscape-runtime/footer",
			"active-portrait-runtime/top-bar",
			"active-portrait-runtime/chat-area",
			"active-portrait-runtime/input-frame",
			"active-portrait-runtime/hint-row",
			"active-portrait-runtime/footer",
			"fixture-tool-ledger-landscape/chat-area",
			"fixture-scroll-scribe-landscape/chat-area",
			"fixture-skill-pill-landscape/chat-area",
			"fixture-code-block-landscape/chat-area",
		]);

		const promotedGoldenCrops = requiredCrops.filter(({ scenarioId }) =>
			["input-typed-component", "footer-ready-component", "top-bar-default-component"].includes(scenarioId),
		);
		for (const { scenarioId, crop } of promotedGoldenCrops) {
			const goldenPath = join(process.cwd(), "docs/visual/parity/approved-runtime", scenarioId, `${crop.id}.png`);
			expect(existsSync(goldenPath), `${scenarioId}/${crop.id} is required but has no golden`).toBe(true);
		}
	});
});
