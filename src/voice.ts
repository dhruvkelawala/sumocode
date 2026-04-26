/**
 * SumoCode product voice — the typed copy module.
 *
 * Two voices coexist in SumoCode:
 *
 * 1. **Zeus** — the agent (anything coming out of the LLM). Casual, can use
 *    whatever the model produces. Lives in `APPEND_SYSTEM.md`.
 * 2. **SumoCode** — the product UI (footers, notifications, slash command
 *    output, sidebar microcopy). This module owns it.
 *
 * Voice rules for SumoCode product UI (Element 5 from CATHEDRAL_DECISIONS.md):
 *   - state labels are UPPERCASE cathedral verbs:
 *       READY / MEDITATING / ILLUMINATING / DEFERRING / INSCRIBING
 *   - other product copy stays lowercase, terse, no exclamation marks,
 *     no apologies, no hedging
 *   - punctuation only when necessary; never trailing periods on labels
 *
 * The cathedral state vocabulary maps internal Pi states to scribe-of-the
 * scriptorium verbs:
 *
 *   internal state    UI label       reason
 *   ────────────────    ─────────────    ────────────────────
 *   idle           →  READY          most common state, stays practical
 *   thinking       →  MEDITATING     contemplative thought
 *   tool           →  ILLUMINATING   the scribe writes / decorates
 *   approval       →  DEFERRING      agent defers decision to user
 *   learning       →  INSCRIBING     writing into the codex (memory)
 */

export const VOICE = {
	status: {
		idle: "READY",
		thinking: "MEDITATING",
		tool: "ILLUMINATING",
		approval: "DEFERRING",
		learning: "INSCRIBING",
	},
	sections: {
		context: "context",
		mcp: "mcp",
		memory: "memory",
	},
	errors: {
		daemonDown: "memory unavailable",
	},
	empty: {
		memory: "no memory match",
	},
} as const;

export type VoiceStatus = keyof typeof VOICE.status;
export type VoiceSection = keyof typeof VOICE.sections;
