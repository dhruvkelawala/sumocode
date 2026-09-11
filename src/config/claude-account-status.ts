/**
 * Which Claude account the session's Claude models resolve to.
 *
 * `/accounts` can only mark an account "in use" while the current model routes
 * through it; on a non-Claude model nothing tells the owner which subscription a
 * Claude-model subagent, role, or task would use. This resolves that account the
 * same way the model ring does — the first enabled, available Claude model wins,
 * base `anthropic` first — so the chrome can show one small, truthful label.
 *
 * Pure by construction: the caller supplies the registry snapshot, the current
 * provider, and the provider-name lookup, so the footer can memoize one call per
 * session start / model select instead of touching the filesystem per render.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { CLAUDE_BASE_PROVIDER, isClaudeAccountProvider } from "./claude-providers.js";

/** Footer chip budget: `claude ` plus at most this many label columns, ellipsis included. */
const MAX_LABEL_COLUMNS = 8;

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
	/** Registry display name for a provider id, used to read a subscription label. */
	readonly providerName?: (providerId: string) => string | undefined;
}

function isClaudeProviderId(providerId: string | undefined): boolean {
	return providerId === CLAUDE_BASE_PROVIDER || (providerId !== undefined && isClaudeAccountProvider(providerId));
}

/**
 * Subscription label out of the provider's registered display name
 * (`Claude (company)`), or `#N` for an unlabelled extra account, or `default`
 * for the built-in provider.
 */
export function claudeAccountLabel(providerId: string, providerName: string | undefined): string {
	if (providerId === CLAUDE_BASE_PROVIDER) return "default";
	const labelled = /^claude\s*\((.+)\)\s*$/i.exec(providerName?.trim() ?? "");
	if (labelled?.[1]?.trim()) return labelled[1].trim();
	const index = /^anthropic-(\d+)$/.exec(providerId)?.[1];
	return index ? `#${index}` : providerId;
}

export function resolveClaudeAccountStatus(inputs: ClaudeAccountStatusInputs): ClaudeAccountStatus | undefined {
	const claudeModels = inputs.models.filter((model) => isClaudeProviderId(model.provider));
	if (claudeModels.length === 0) return undefined;
	// A live Claude model is authoritative; otherwise the first Claude model is
	// what a bare id resolves to next, which is what a subagent would use.
	const liveProvider = isClaudeProviderId(inputs.currentProvider) && claudeModels.some((model) => model.provider === inputs.currentProvider)
		? inputs.currentProvider
		: undefined;
	const providerId = liveProvider ?? claudeModels[0].provider;
	return {
		providerId,
		label: claudeAccountLabel(providerId, inputs.providerName?.(providerId)),
		active: liveProvider !== undefined,
	};
}

/** `claude company` — the footer segment, with the label clipped to its column budget. */
export function formatClaudeAccountChip(status: ClaudeAccountStatus): string {
	const label = status.label.length > MAX_LABEL_COLUMNS
		? `${status.label.slice(0, MAX_LABEL_COLUMNS - 1)}…`
		: status.label;
	return `claude ${label}`;
}
