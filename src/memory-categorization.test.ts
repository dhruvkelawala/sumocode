import { describe, expect, it } from "vitest";
import {
	groupFactsByPanel,
	MEMORY_PANELS,
	routeFactToPanel,
	type PanelId,
} from "./memory-categorization.js";
import type { MemoryFact } from "./memory.js";

function fact(overrides: Partial<MemoryFact> = {}): MemoryFact {
	return {
		id: `fact-${Math.random().toString(36).slice(2)}`,
		text: "default fact text",
		...overrides,
	};
}

describe("MEMORY_PANELS constant", () => {
	it("exposes the 6 cathedral panels in the locked order", () => {
		expect(MEMORY_PANELS).toEqual([
			"IDENTITY",
			"PREFERENCES",
			"WORKFLOW",
			"PROJECTS",
			"SYSTEM",
			"GENERAL",
		]);
	});
});

describe("routeFactToPanel — explicit sumocode tag wins", () => {
	it.each([
		["sumocode:identity", "IDENTITY"],
		["sumocode:preferences", "PREFERENCES"],
		["sumocode:workflow", "WORKFLOW"],
		["sumocode:projects", "PROJECTS"],
		["sumocode:system", "SYSTEM"],
		["sumocode:general", "GENERAL"],
	])("tag %s routes to %s", (tag, panel) => {
		expect(routeFactToPanel(fact({ tags: [tag], text: "could match anything" }))).toBe(panel);
	});

	it("tag wins over category", () => {
		expect(
			routeFactToPanel(
				fact({ tags: ["sumocode:identity"], category: "preference", text: "irrelevant" }),
			),
		).toBe("IDENTITY");
	});

	it("tag wins over keyword content", () => {
		expect(
			routeFactToPanel(
				fact({ tags: ["sumocode:projects"], text: "dhruv is in london" }),
			),
		).toBe("PROJECTS");
	});

	it("ignores unknown sumocode:* tags and falls through", () => {
		expect(routeFactToPanel(fact({ tags: ["sumocode:nonsense"], text: "" }))).toBe("GENERAL");
	});

	it("ignores non-sumocode tags", () => {
		expect(routeFactToPanel(fact({ tags: ["random-tag"], text: "" }))).toBe("GENERAL");
	});
});

describe("routeFactToPanel — Remnic category", () => {
	it("preference/rule/principle → PREFERENCES", () => {
		for (const cat of ["preference", "rule", "principle"]) {
			expect(routeFactToPanel(fact({ category: cat, text: "" }))).toBe("PREFERENCES");
		}
	});

	it("procedure/skill/decision → WORKFLOW", () => {
		for (const cat of ["procedure", "skill", "decision"]) {
			expect(routeFactToPanel(fact({ category: cat, text: "" }))).toBe("WORKFLOW");
		}
	});

	it("entity/relationship → IDENTITY", () => {
		for (const cat of ["entity", "relationship"]) {
			expect(routeFactToPanel(fact({ category: cat, text: "" }))).toBe("IDENTITY");
		}
	});

	it("unrecognized category falls through to keyword rules", () => {
		expect(routeFactToPanel(fact({ category: "fact", text: "dhruv is here" }))).toBe("IDENTITY");
	});
});

describe("routeFactToPanel — keyword rules", () => {
	it("Dhruv/Argent/London/senior frontend → IDENTITY", () => {
		expect(routeFactToPanel(fact({ text: "Dhruv works at Argent" }))).toBe("IDENTITY");
		expect(routeFactToPanel(fact({ text: "based in London" }))).toBe("IDENTITY");
		expect(routeFactToPanel(fact({ text: "senior frontend at SomeCorp" }))).toBe("IDENTITY");
	});

	it("cmux/portrait/landscape/terminal → SYSTEM", () => {
		expect(routeFactToPanel(fact({ text: "runs SumoCode inside cmux" }))).toBe("SYSTEM");
		expect(routeFactToPanel(fact({ text: "mac mini in portrait orientation" }))).toBe("SYSTEM");
		expect(routeFactToPanel(fact({ text: "macbook is landscape" }))).toBe("SYSTEM");
	});

	it("sumocode/openclaw/cathedral → PROJECTS", () => {
		expect(routeFactToPanel(fact({ text: "SumoCode is the cathedral product" }))).toBe("PROJECTS");
		expect(routeFactToPanel(fact({ text: "OpenClaw ACPX integration" }))).toBe("PROJECTS");
	});

	it("tdd/workflow/prefer → WORKFLOW", () => {
		expect(routeFactToPanel(fact({ text: "always use TDD for new features" }))).toBe("WORKFLOW");
		expect(routeFactToPanel(fact({ text: "never autoformat go" }))).toBe("WORKFLOW");
	});

	it("typescript/pnpm/etc → PREFERENCES", () => {
		expect(routeFactToPanel(fact({ text: "prefers TypeScript strict" }))).toBe("PREFERENCES");
		expect(routeFactToPanel(fact({ text: "uses pnpm not npm" }))).toBe("PREFERENCES");
		expect(routeFactToPanel(fact({ text: "Bun where possible" }))).toBe("PREFERENCES");
	});
});

describe("routeFactToPanel — fallback", () => {
	it("returns GENERAL when no rule matches", () => {
		expect(routeFactToPanel(fact({ text: "the sky is blue" }))).toBe("GENERAL");
	});
});

describe("groupFactsByPanel", () => {
	it("returns groups in MEMORY_PANELS order", () => {
		const facts = [
			fact({ text: "dhruv argent" }),       // IDENTITY
			fact({ text: "tdd workflow" }),       // WORKFLOW
			fact({ text: "mac mini portrait" }),  // SYSTEM
			fact({ text: "typescript pnpm" }),    // PREFERENCES
			fact({ text: "sumocode cathedral" }), // PROJECTS
		];
		const groups = groupFactsByPanel(facts).map((g) => g.panel);
		const expected: PanelId[] = ["IDENTITY", "PREFERENCES", "WORKFLOW", "PROJECTS", "SYSTEM"];
		expect(groups).toEqual(expected);
	});

	it("hides GENERAL panel when empty", () => {
		const facts = [fact({ text: "dhruv london" })];
		const groups = groupFactsByPanel(facts);
		expect(groups.some((g) => g.panel === "GENERAL")).toBe(false);
	});

	it("includes GENERAL panel when non-empty", () => {
		const facts = [fact({ text: "the sky is blue" })];
		const groups = groupFactsByPanel(facts);
		const general = groups.find((g) => g.panel === "GENERAL");
		expect(general).toBeDefined();
		expect(general!.facts.length).toBe(1);
	});

	it("preserves fact order within each panel", () => {
		const f1 = fact({ id: "a", text: "tdd 1" });
		const f2 = fact({ id: "b", text: "tdd 2" });
		const groups = groupFactsByPanel([f1, f2]);
		const workflow = groups.find((g) => g.panel === "WORKFLOW");
		expect(workflow?.facts.map((f) => f.id)).toEqual(["a", "b"]);
	});
});
