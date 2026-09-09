import { describe, expect, it } from "vitest";
import { evaluateSubagentBudget, validateSubagentBudget, SUBAGENT_BUDGET_MAX } from "./budget-policy.js";

const running = { status: "running" as const, startedAt: 0, lastProgressAt: 0, progress: "events" as const, liveness: "unknown" as const };

describe("warning-only subagent policy", () => {
	it.each([999, 1000, 1001])("evaluates wall/token/cost boundaries at %s", (used) => {
		const result = evaluateSubagentBudget({ ...running, now: used, budget: { wallTimeMs: 1000, tokens: 1000, costUsd: 1000 }, usage: { tokens: used, costUsd: used } });
		expect(result.health).toBe(used < 1000 ? "active" : "over-budget-warning");
		expect(result.warnings).toEqual(used < 1000 ? [] : ["wall-time", "tokens", "cost"]);
	});

	it.each([undefined, NaN, -1, Infinity])("keeps missing/invalid usage unknown (%s)", (value) => {
		const result = evaluateSubagentBudget({ ...running, now: 0, budget: { tokens: 100, costUsd: 10 }, usage: { tokens: value, costUsd: value } });
		expect(result.utilization).toEqual({ wallTime: null, tokens: null, cost: null });
		expect(result.warnings).toEqual([]);
	});

	it("keeps utilization serializable for a tiny positive cost budget", () => {
		const result = evaluateSubagentBudget({ ...running, now: 0, budget: { costUsd: Number.MIN_VALUE }, usage: { costUsd: 1 } });
		expect(result.health).toBe("over-budget-warning");
		expect(Number.isFinite(result.utilization.cost)).toBe(true);
		expect(JSON.parse(JSON.stringify(result)).utilization.cost).not.toBeNull();
	});

	it("distinguishes quiet, startup grace, tool grace and stalled warnings", () => {
		expect(evaluateSubagentBudget({ ...running, now: 30_000 }).health).toBe("quiet");
		expect(evaluateSubagentBudget({ ...running, lastProgressAt: null, budget: { stallAfterMs: 1000 }, now: 59_999 }).health).toBe("quiet");
		expect(evaluateSubagentBudget({ ...running, lastProgressAt: null, budget: { stallAfterMs: 1000 }, now: 60_000 }).health).toBe("stalled-warning");
		expect(evaluateSubagentBudget({ ...running, now: 299_999, toolStartedAt: 0 }).health).toBe("quiet");
		expect(evaluateSubagentBudget({ ...running, now: 300_000, toolStartedAt: 0 }).health).toBe("stalled-warning");
		expect(evaluateSubagentBudget({ ...running, now: 300_000, lastProgressAt: 300_000 }).health).toBe("active");
	});

	it.each(["alive", "gone", "unknown"] as const)("reports %s liveness separately without inventing visible progress", (liveness) => {
		const result = evaluateSubagentBudget({ ...running, liveness, now: 1_000_000, progress: "liveness-only" });
		expect(result).toMatchObject({ health: "quiet", liveness, warnings: [] });
	});

	it.each(["queued", "done", "error"] as const)("does not warn or enforce on %s work", (status) => {
		expect(evaluateSubagentBudget({ ...running, status, now: 1_000_000, budget: { wallTimeMs: 1 } })).toMatchObject({ health: "quiet", warnings: [] });
	});

	it("does not count queued/setup time without a backend start", () => {
		expect(evaluateSubagentBudget({ ...running, startedAt: null, lastProgressAt: null, now: 1_000_000, budget: { wallTimeMs: 1 } })).toMatchObject({ health: "quiet", elapsedMs: 0, warnings: [] });
	});

	it.each([null, [], { extra: 1 }, { tokens: 0 }, { tokens: -1 }, { tokens: 0.5 }, { costUsd: NaN }, { costUsd: Infinity }, { stallAfterMs: undefined }])("rejects invalid budget input %j", (input) => {
		expect(() => validateSubagentBudget(input)).toThrow(/invalid subagent budget/);
	});

	it.each(Object.entries(SUBAGENT_BUDGET_MAX))("bounds %s and accepts its maximum", (key, limit) => {
		expect(() => validateSubagentBudget({ [key]: limit })).not.toThrow();
		expect(() => validateSubagentBudget({ [key]: limit + 1 })).toThrow();
	});

	it("warns at a wall budget without granting any enforcement action", () => {
		expect(evaluateSubagentBudget({ ...running, now: 1000, budget: { wallTimeMs: 1000 } })).toEqual({
			health: "over-budget-warning", elapsedMs: 1000, lastProgressAt: 0, liveness: "unknown",
			utilization: { wallTime: 1, tokens: null, cost: null }, warnings: ["wall-time"],
		});
	});
});
