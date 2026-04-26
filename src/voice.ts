/**
 * SumoCode product voice — the typed copy module.
 *
 * Two voices coexist in SumoCode (see PLAN.md § Q8):
 *
 * 1. **Zeus** — the agent (anything coming out of the LLM). Casual, can use
 *    whatever the model produces. Lives in `APPEND_SYSTEM.md`.
 * 2. **SumoCode** — the product UI (footers, notifications, slash command
 *    output, sidebar microcopy). This module owns it.
 *
 * Voice rules for SumoCode product UI:
 *   - lowercase status words
 *   - terse — fewer words wins
 *   - no exclamation marks
 *   - no apologies, no hedging
 *   - punctuation only when necessary; never trailing periods on labels
 */

export const VOICE = {
	status: {
		idle: "ready",
		thinking: "thinking",
		tool: "working",
		approval: "needs you",
		learning: "learning",
	},
	sections: {
		context: "context",
		mcp: "mcp",
		memory: "memory",
	},
	errors: {
		daemonDown: "memory unavailable",
	},
} as const;

export type VoiceStatus = keyof typeof VOICE.status;
export type VoiceSection = keyof typeof VOICE.sections;
