export interface SubagentBudget {
	readonly wallTimeMs?: number;
	/** Sum of provider-reported per-turn tokens, including cache tokens; not context occupancy. */
	readonly tokens?: number;
	readonly costUsd?: number;
	readonly stallAfterMs?: number;
}

export const SUBAGENT_BUDGET_MAX = { wallTimeMs: 604_800_000, tokens: 1_000_000_000, costUsd: 100_000, stallAfterMs: 86_400_000 } as const;
export type SubagentHealth = "active" | "quiet" | "stalled-warning" | "over-budget-warning";
export interface SubagentBudgetState {
	readonly health: SubagentHealth;
	readonly elapsedMs: number;
	readonly lastProgressAt: number | null;
	readonly liveness: "alive" | "gone" | "unknown";
	/** null means no limit or no reported usage, never zero consumption. */
	readonly utilization: { readonly wallTime: number | null; readonly tokens: number | null; readonly cost: number | null };
	readonly warnings: readonly ("wall-time" | "tokens" | "cost" | "stall")[];
}

interface BudgetObservation {
	readonly now: number;
	readonly status: "queued" | "running" | "done" | "error";
	readonly startedAt: number | null;
	readonly lastProgressAt: number | null;
	readonly progress: "events" | "liveness-only";
	readonly liveness: SubagentBudgetState["liveness"];
	readonly toolStartedAt?: number;
	readonly budget?: SubagentBudget;
	readonly usage?: { readonly tokens?: number; readonly costUsd?: number };
}

/** Metadata only: neither warning can grant a control or queue operation. */
export function evaluateSubagentBudget(observation: BudgetObservation): SubagentBudgetState {
	const { now, startedAt, lastProgressAt, liveness, budget, usage } = observation;
	const elapsedMs = startedAt === null ? 0 : Math.max(0, now - startedAt);
	const utilization = {
		wallTime: startedAt === null ? null : ratio(elapsedMs, budget?.wallTimeMs),
		tokens: ratio(usage?.tokens, budget?.tokens),
		cost: ratio(usage?.costUsd, budget?.costUsd),
	};
	const warnings: Array<SubagentBudgetState["warnings"][number]> = [];
	let health: SubagentHealth = "quiet";
	if (observation.status === "running") {
		if (utilization.wallTime !== null && utilization.wallTime >= 1) warnings.push("wall-time");
		if (utilization.tokens !== null && utilization.tokens >= 1) warnings.push("tokens");
		if (utilization.cost !== null && utilization.cost >= 1) warnings.push("cost");
		const silentMs = Math.max(0, now - (lastProgressAt ?? startedAt ?? now));
		const startupGrace = lastProgressAt === null && elapsedMs < 60_000;
		const toolGrace = observation.toolStartedAt !== undefined && now - observation.toolStartedAt < 300_000;
		if (observation.progress === "events" && startedAt !== null) {
			health = silentMs < 30_000 ? "active" : "quiet";
			if (!startupGrace && !toolGrace && silentMs >= (budget?.stallAfterMs ?? 120_000)) warnings.push("stall");
		}
		if (warnings.some((warning) => warning !== "stall")) health = "over-budget-warning";
		else if (warnings.includes("stall")) health = "stalled-warning";
	}
	return { health, elapsedMs, lastProgressAt, liveness, utilization, warnings };
}

// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- spawn/registry JSON boundary; reject every unknown key and invalid numeric limit.
export function validateSubagentBudget(value: unknown): asserts value is SubagentBudget {
	if (value === null || typeof value !== "object" || Array.isArray(value)
		|| ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("invalid subagent budget");
	for (const [key, limit] of Object.entries(value)) {
		// SAFETY: the own-key guard precedes indexing the fixed limits object.
		if (!Object.hasOwn(SUBAGENT_BUDGET_MAX, key) || typeof limit !== "number" || !Number.isFinite(limit)
			|| limit <= 0 || limit > SUBAGENT_BUDGET_MAX[key as keyof SubagentBudget]
			|| (key !== "costUsd" && !Number.isSafeInteger(limit))) throw new Error("invalid subagent budget");
	}
}
// oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof

export function formatSubagentBudget(state: Partial<SubagentBudgetState>): string | undefined {
	if (!state.health) return undefined;
	const percent = (value: number | null | undefined): string => value == null ? "unknown" : `${Math.round(value * 100)}%`;
	const parts = [state.health, `elapsed ${Math.round((state.elapsedMs ?? 0) / 1000)}s`,
		`wall ${percent(state.utilization?.wallTime)}`, `reported tokens ${percent(state.utilization?.tokens)}`,
		`reported cost ${percent(state.utilization?.cost)}`, `liveness ${state.liveness ?? "unknown"}`,
		`last progress ${state.lastProgressAt == null ? "unobserved" : new Date(state.lastProgressAt).toISOString()}`];
	if (state.health.endsWith("-warning")) parts.push("inspect or explicitly cancel with subagent_cancel");
	return parts.join(" · ");
}

function ratio(used: number | undefined, limit: number | undefined): number | null {
	// ponytail: cap extreme warning ratios; use decimal arithmetic if exact ratios ever matter.
	return used === undefined || !Number.isFinite(used) || used < 0 || limit === undefined ? null : Math.min(Number.MAX_SAFE_INTEGER, used / limit);
}
