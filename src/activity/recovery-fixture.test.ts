import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parseActivitySnapshot } from "./domain.js";

// Evaluate only committed fixture declarations; never import the capture runtime.
const source = readFileSync("scripts/visual-v2/fixture-capture.mjs", "utf8");
const declarations = source.slice(source.indexOf("const FIXTURE_TIMES ="), source.indexOf("export async function captureFixtureScenario"));
interface Fixture {
	transcript: { messages: Array<{ blocks: Array<{ type: string; activity?: unknown }> }> };
}
// SAFETY: the committed declaration has this shape; each Activity is parsed below.
const fixtures = runInNewContext(`${declarations}\nFIXTURES`, {}, { timeout: 1000 }) as Record<string, Fixture>;
// SAFETY: this is the committed scenario manifest, checked at the registration seam.
const manifest = JSON.parse(readFileSync("docs/visual/parity/scenarios.json", "utf8")) as {
	scenarios: Array<{ id: string; fixture?: { id: string; activityExpansion: Record<string, boolean> } }>;
};
const scenario = manifest.scenarios.find((item) => item.id === "fixture-subagent-recovery-states-landscape")!;
const blocks = fixtures[scenario.fixture!.id].transcript.messages.flatMap((message) => message.blocks);
const activities = blocks.filter((block) => block.type === "activity").map((block) => parseActivitySnapshot(block.activity));

describe("recovery Activity fixture contract (no capture)", () => {
	it("registers the review-only landscape fixture without required crops or goldens", () => {
		expect(scenario).toEqual({
			id: "fixture-subagent-recovery-states-landscape", lane: "fixture", status: "review",
			dimensions: { cols: 160, rows: 45 }, bibleTarget: "scene-activity-cards.png",
			fixture: { id: "subagent-recovery-states", activityExpansion: {
				"fixture-recovered-subagent": true, "fixture-lost-subagent": true, "fixture-ambiguous-subagent": true,
				"fixture-completed-terminal": false, "fixture-failed-terminal": false,
			} },
			crops: [{ id: "full", targetCrop: "full", runtimeCrop: "full" }, { id: "chat-area", targetCrop: "chat-area", runtimeCrop: "chat-area" }],
			geometrySpec: { regions: [{ startRow: 1, endRow: 1, category: "top-bar", firstCol: 1 }], contentBounds: { minFirst: 0, maxLast: 159 } },
		});
	});

	it("uses valid Activity states and expands all three distinct recovery evidence cards", () => {
		expect(activities).toHaveLength(5);
		for (const activity of activities) expect(activity).toBeDefined();
		expect(activities.slice(0, 3).map((activity) => [activity?.status, activity?.currentStep])).toEqual([
			["running", "recovered-running"], ["lost", "lost"], ["lost", "ambiguous identity"],
		]);
		for (const activity of activities.slice(0, 3)) {
			expect(scenario.fixture!.activityExpansion[activity!.id]).toBe(true);
			expect(activity!.body).toMatchObject({ kind: "text", text: expect.stringContaining("inspect") });
		}
		expect(activities[0]!.body).toMatchObject({ text: expect.stringContaining("writer unchanged") });
		expect(activities[1]!.body).toMatchObject({ text: expect.stringContaining("backend transport lost") });
		expect(activities[2]!.body).toMatchObject({ text: expect.stringContaining("no signal authorized") });
		expect(new Set(activities.map((activity) => activity!.id)).size).toBe(activities.length);
	});
});
