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
	status: "review" | "approved" | "required";
	dimensions: {
		cols: number;
		rows: number;
	};
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
		expect(cropDefinition("sidebar")).toEqual({ x: 130, y: 3, cols: 30, rows: 34 });
	});

	it("keeps required crop gates backed by committed runtime goldens", () => {
		const requiredCrops = manifest.scenarios.flatMap((item) =>
			item.crops
				.filter((crop) => (crop.status ?? item.status) === "required")
				.map((crop) => ({ scenarioId: item.id, crop })),
		);

		expect(requiredCrops.map(({ scenarioId, crop }) => `${scenarioId}/${crop.id}`)).toEqual([
			"input-typed-component/input-frame",
			"footer-ready-component/footer",
			"top-bar-default-component/top-bar",
		]);

		for (const { scenarioId, crop } of requiredCrops) {
			const goldenPath = join(process.cwd(), "docs/visual/parity/approved-runtime", scenarioId, `${crop.id}.png`);
			expect(existsSync(goldenPath), `${scenarioId}/${crop.id} is required but has no golden`).toBe(true);
		}
	});
});
