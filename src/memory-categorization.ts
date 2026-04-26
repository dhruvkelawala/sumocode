/**
 * Memory categorization (Element 7 from CATHEDRAL_DECISIONS.md, per the
 * `docs/ui/MEMORY_CATEGORIZATION_SPIKE.md` Approach 2-lite verdict).
 *
 * Maps each Remnic-stored fact to one of 6 SumoCode display panels using
 * deterministic rules. No LLM. Zero migration risk.
 *
 * Routing precedence (per spike):
 *   1. Explicit `sumocode:<panel>` tag
 *   2. Remnic `category` field
 *   3. Keyword rules on content
 *   4. Fallback to GENERAL
 *
 * GENERAL panel is hidden if empty.
 */

import type { MemoryFact } from "./memory.js";

export const MEMORY_PANELS = [
	"IDENTITY",
	"PREFERENCES",
	"WORKFLOW",
	"PROJECTS",
	"SYSTEM",
	"GENERAL",
] as const;

export type PanelId = (typeof MEMORY_PANELS)[number];

const KNOWN_PANEL_SET = new Set<PanelId>(MEMORY_PANELS);

/**
 * Deterministic routing rules. Returns the panel ID for a given fact.
 */
export function routeFactToPanel(fact: MemoryFact): PanelId {
	// 1. Explicit sumocode:<panel> tag (highest priority)
	for (const tag of fact.tags ?? []) {
		const lower = tag.toLowerCase();
		if (!lower.startsWith("sumocode:")) continue;
		const panel = lower.slice("sumocode:".length).toUpperCase() as PanelId;
		if (KNOWN_PANEL_SET.has(panel)) return panel;
	}

	// 2. Remnic native category
	const cat = fact.category?.toLowerCase();
	if (cat === "preference" || cat === "rule" || cat === "principle") return "PREFERENCES";
	if (cat === "procedure" || cat === "skill" || cat === "decision") return "WORKFLOW";
	if (cat === "entity" || cat === "relationship") return "IDENTITY";

	// 3. Keyword rules on content (case-insensitive)
	const text = (fact.text ?? "").toLowerCase();
	if (/\b(dhruv|argent|london|senior frontend)\b/.test(text)) return "IDENTITY";
	if (/\b(cmux|portrait|landscape|terminal|libghostty|visual verification)\b/.test(text)) return "SYSTEM";
	if (/\b(sumocode|openclaw|cathedral|project:)\b/.test(text)) return "PROJECTS";
	if (/\b(tdd|workflow|always|never|prefer)\b/.test(text)) return "WORKFLOW";
	if (/\b(typescript|pnpm|react|vite|tailwind|next\.?js|bun|node)\b/.test(text)) return "PREFERENCES";

	// 4. Fallback
	return "GENERAL";
}

export type PanelGroup = {
	panel: PanelId;
	facts: MemoryFact[];
};

/**
 * Group facts into the 6 panels in fixed order. GENERAL is excluded if empty.
 * Other panels are always returned (even empty) to preserve the modal's grid
 * shape; rendering decides whether to show the empty header.
 */
export function groupFactsByPanel(facts: readonly MemoryFact[]): PanelGroup[] {
	const buckets = new Map<PanelId, MemoryFact[]>();
	for (const panel of MEMORY_PANELS) buckets.set(panel, []);

	for (const fact of facts) {
		const panel = routeFactToPanel(fact);
		buckets.get(panel)!.push(fact);
	}

	const result: PanelGroup[] = [];
	for (const panel of MEMORY_PANELS) {
		const bucket = buckets.get(panel)!;
		if (panel === "GENERAL" && bucket.length === 0) continue;
		result.push({ panel, facts: bucket });
	}
	return result;
}
