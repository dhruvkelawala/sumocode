/**
 * Which Claude account the session's Claude models resolve to.
 *
 * `/accounts` can only mark an account "in use" while the current model routes
 * through it, so on a non-Claude model nothing told the owner which subscription
 * Claude work lands on: the account a Claude model picked without an explicit
 * provider resolves to. This resolves that account over the same enabled-model
 * set `/accounts` and the model picker use — base `anthropic` first, then extra
 * accounts by index — so the chrome can show one small, truthful label.
 *
 * Pure by construction: the caller supplies the reachable models, the current
 * provider, and the subscription labels, so the footer memoizes one call per
 * session start / model select instead of touching the filesystem per render.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { CLAUDE_BASE_PROVIDER, isClaudeProvider } from "./claude-providers.js";

/** Footer chip budget: `claude ` plus at most this many label columns, ellipsis included. */
const MAX_LABEL_COLUMNS = 8;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Clip by grapheme, not by UTF-16 code unit: a user-authored label can carry a
 * surrogate pair or a combining mark, and slicing `String.length` would split it
 * into a replacement character.
 */
function clipToGraphemes(text: string, max: number): string {
	const graphemes = [...graphemeSegmenter.segment(text)].map((entry) => entry.segment);
	if (graphemes.length <= max) return text;
	return `${graphemes.slice(0, Math.max(1, max - 1)).join("")}…`;
}

export interface ClaudeAccountStatus {
	/** Provider the Claude models resolve to (`anthropic`, `anthropic-2`, …). */
	readonly providerId: string;
	/** Display label: the subscription label, or `default` for the base provider. */
	readonly label: string;
	/** True when the session's current model routes through this provider. */
	readonly active: boolean;
}

interface ClaudeAccountStatusInputs {
	/** Models the picker and cycle ring can reach: available, then enabled-filtered. */
	readonly models: readonly Model<Api>[];
	readonly currentProvider?: string;
	/** Subscription label for an extra account provider, from claude-accounts.json. */
	readonly subscriptionLabel?: (providerId: string) => string | undefined;
}

/**
 * The footer label for an account: the subscription label lowercased, `#N` for
 * an unlabelled extra account, `default` for the built-in provider.
 */
export function claudeAccountLabel(providerId: string, subscriptionLabel: string | undefined): string {
	if (providerId === CLAUDE_BASE_PROVIDER) return "default";
	const labelled = subscriptionLabel?.trim();
	if (labelled) return labelled.toLowerCase();
	const index = /^anthropic-(\d+)$/.exec(providerId)?.[1];
	return index ? `#${index}` : providerId;
}

/**
 * Resolution order, made explicit rather than inherited from registry
 * insertion order: the built-in provider first, then extra accounts by index.
 */
function accountRank(providerId: string): number {
	if (providerId === CLAUDE_BASE_PROVIDER) return 0;
	const index = /^anthropic-(\d+)$/.exec(providerId)?.[1];
	return index ? Number(index) : Number.MAX_SAFE_INTEGER;
}

/** The account a Claude model with no explicit provider resolves to. */
function firstResolvedAccount(models: readonly Model<Api>[]): string {
	return [...models].sort((a, b) => accountRank(a.provider) - accountRank(b.provider))[0].provider;
}

export function resolveClaudeAccountStatus(inputs: ClaudeAccountStatusInputs): ClaudeAccountStatus | undefined {
	const claudeModels = inputs.models.filter((model) => isClaudeProvider(model.provider));
	// A live Claude model is authoritative even when its own models fall outside
	// the enabled subset: the session is demonstrably on that account, so
	// reporting a different (or no) account would be wrong. Only the fallback —
	// which account a bare id resolves to next — depends on the enabled set.
	const liveProvider = inputs.currentProvider !== undefined && isClaudeProvider(inputs.currentProvider)
		? inputs.currentProvider
		: undefined;
	if (liveProvider === undefined && claudeModels.length === 0) return undefined;
	const providerId = liveProvider ?? firstResolvedAccount(claudeModels);
	return {
		providerId,
		label: claudeAccountLabel(providerId, inputs.subscriptionLabel?.(providerId)),
		active: liveProvider !== undefined,
	};
}

/** `claude company` — the footer segment, with the label clipped to its budget. */
export function formatClaudeAccountChip(status: { readonly label: string }): string {
	return `claude ${clipToGraphemes(status.label, MAX_LABEL_COLUMNS)}`;
}
