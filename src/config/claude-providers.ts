/**
 * Provider-id rules for Claude subscriptions, shared by the classic
 * `/accounts` command and the retained renderer's enabled-model policy.
 * Neither UI layer owns them, so they live in the neutral config layer.
 */

/** Pi's built-in provider that every extra Claude account clones models from. */
export const CLAUDE_BASE_PROVIDER = "anthropic";

/** Provider id the OAuth adapter registers for the extra Claude subscription at `index`. */
export function claudeAccountProviderId(index: number): string {
	return `${CLAUDE_BASE_PROVIDER}-${index}`;
}

/**
 * True for provider ids the adapter registers for extra Claude accounts
 * (`anthropic-2`, `anthropic-3`, …). Their models are clones of the base
 * provider's, so base-provider policy (enabled models, model choice) applies
 * to them by the same model id.
 */
export function isClaudeAccountProvider(providerId: string): boolean {
	return /^anthropic-[1-9]\d*$/.test(providerId);
}
