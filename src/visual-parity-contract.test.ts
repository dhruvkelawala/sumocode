import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SIDEBAR_MIN_TERMINAL_WIDTH, SIDEBAR_WIDTH } from "./sidebar.js";

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

type Scenario = {
	id: string;
	lane: "component" | "runtime" | "fixture";
	status: "review" | "approved" | "required";
	dimensions: {
		cols: number;
		rows: number;
	};
	runtime?: {
		command: string;
		args: string[];
		env?: Record<string, string>;
		inputs?: Array<{
			afterMs?: number;
			type: "text" | "key";
			value: string;
		}>;
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

		expect(active.runtime?.inputs?.at(-1)).toEqual({
			afterMs: 250,
			type: "key",
			value: "\u001b[13u",
		});
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

		expect(portrait.dimensions.cols).toBeLessThan(SIDEBAR_MIN_TERMINAL_WIDTH);
		expect(portrait.runtime?.inputs?.at(-1)).toEqual({
			afterMs: 250,
			type: "key",
			value: "\u001b[13u",
		});
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

	it("keeps fixture scenes deterministic and review-only", () => {
		expect(scenario("fixture-completed-landscape")).toMatchObject({ status: "review" });
		expect(scenario("fixture-completed-portrait")).toMatchObject({ status: "review" });
		expect(scenario("fixture-command-palette-overlay")).toMatchObject({ status: "review" });
		expect(scenario("fixture-tool-ledger-landscape")).toMatchObject({ status: "review" });
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
