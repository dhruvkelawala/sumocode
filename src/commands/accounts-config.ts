/** Unknown top-level field preserved by the adapter and used to prevent repeat legacy seeding. */
export const CLAUDE_ACCOUNTS_MIGRATION_FIELD = "_sumocodeClaudeAccountsMigrated" as const;

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
