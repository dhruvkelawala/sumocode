/**
 * The Claude account a session's models resolve to, published by the Pi child
 * for the retained host.
 *
 * In the SumoCode runtime the host renders the footer while only the child holds
 * the model registry, so the resolved account travels over the existing
 * extension status channel — the same way fast mode does. Two keys encode the
 * state so neither side parses a composite value: the active key means the
 * session's current model is on that account (bright), the plain key means the
 * account is only where a Claude task would resolve (dim). The classic
 * (non-host) footer resolves the same value directly from its own context.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveClaudeAccountStatus, type ClaudeAccountStatus } from "./config/claude-account-status.js";
import { filterToEnabled, readEnabledModelPatterns } from "./config/enabled-models.js";
import type { RpcLoginRuntime } from "./sumo-tui/pi-compat/login-command.js";

export const CLAUDE_ACCOUNT_STATUS_KEY = "sumocode.claude-account";
export const CLAUDE_ACCOUNT_ACTIVE_STATUS_KEY = "sumocode.claude-account-active";

interface PublishedClaudeAccount {
	readonly label: string;
	readonly active: boolean;
}

/** The account the host should paint, from the child's published statuses. */
export function hasPublishedClaudeAccount(
	statuses: ReadonlyMap<string, string | undefined> | undefined,
): PublishedClaudeAccount | undefined {
	if (!statuses) return undefined;
	const active = statuses.get(CLAUDE_ACCOUNT_ACTIVE_STATUS_KEY);
	if (active) return { label: active, active: true };
	const dim = statuses.get(CLAUDE_ACCOUNT_STATUS_KEY);
	return dim ? { label: dim, active: false } : undefined;
}

function safeRead<T>(read: () => T, fallback: T): T {
	try {
		return read();
	} catch {
		return fallback;
	}
}

/**
 * Which Claude account this session's Claude models resolve to, over the same
 * enabled-model set `/accounts` uses to decide which accounts are reachable.
 */
export function resolveSessionClaudeAccount(
	ctx: ExtensionContext,
	subscriptionLabel?: (providerId: string) => string | undefined,
): ClaudeAccountStatus | undefined {
	const registry = ctx.modelRegistry;
	const available = safeRead(() => registry.getAvailable(), []);
	return resolveClaudeAccountStatus({
		models: filterToEnabled(available, readEnabledModelPatterns()),
		currentProvider: safeRead(() => ctx.model?.provider, undefined),
		subscriptionLabel,
	});
}

interface StatusUi {
	setStatus?: (key: string, text: string | undefined) => void;
}

function isSetStatusFunction(value: ((key: string, text: string | undefined) => void) | undefined): value is (key: string, text: string | undefined) => void {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- capability probe for the optional extension status registrar, mirrored from fast-mode.ts
	return typeof value === "function";
}

type ClaudeSubscriptionLabel = (providerId: string) => string | undefined;

function publish(ctx: ExtensionContext, resolve: () => ClaudeAccountStatus | undefined): void {
	if (!ctx.hasUI) return;
	// SAFETY: the ui surface exposes an optional setStatus registrar; the
	// typeof guard below verifies it before calling.
	const ui = ctx.ui as StatusUi;
	if (!isSetStatusFunction(ui.setStatus)) return;
	const status = safeRead(resolve, undefined);
	// Exactly one key is set, so a stale bright label can never outlive its
	// account becoming the dim fallback.
	ui.setStatus(CLAUDE_ACCOUNT_ACTIVE_STATUS_KEY, status?.active ? status.label : undefined);
	ui.setStatus(CLAUDE_ACCOUNT_STATUS_KEY, status && !status.active ? status.label : undefined);
}

/**
 * Publish the resolved account now. `/accounts` renames its label and finishes
 * without an agent turn — Pi executes an extension command inside `prompt()`
 * and returns before the agent loop starts — so no `agent_end` follows to
 * re-resolve it, and the host would keep painting the old label indefinitely.
 */
export function publishClaudeAccountStatus(
	ctx: ExtensionContext,
	options: { subscriptionLabel?: ClaudeSubscriptionLabel } = {},
): void {
	publish(ctx, () => resolveSessionClaudeAccount(ctx, options.subscriptionLabel));
}

/**
 * `/login` runs outside the agent loop too, so a successful sign-in that makes
 * a Claude provider reachable produces no `agent_end` for the publisher to
 * catch. Delegating every other runtime method keeps Pi's login orchestration
 * intact; only a resolved credential repaints.
 */
export function loginRuntimeWithAccountRefresh(
	ctx: ExtensionContext,
	runtime: RpcLoginRuntime,
	options: { subscriptionLabel?: ClaudeSubscriptionLabel } = {},
): RpcLoginRuntime {
	return {
		getAvailable: () => runtime.getAvailable(),
		getProviders: () => runtime.getProviders(),
		login: async (providerId, type, interaction) => {
			const credential = await runtime.login(providerId, type, interaction);
			publishClaudeAccountStatus(ctx, options);
			return credential;
		},
	};
}

/**
 * Publish the resolved account on session start, model select, and each turn
 * boundary (so an `/accounts` rename lands without waiting for a model switch).
 * Never inside a render: the resolution reads settings.json.
 */
export function installClaudeAccountStatus(
	pi: ExtensionAPI,
	options: { subscriptionLabel?: ClaudeSubscriptionLabel } = {},
): void {
	const publishFor = (ctx: ExtensionContext): void => publishClaudeAccountStatus(ctx, options);
	pi.on("session_start", (_event, ctx) => publishFor(ctx));
	pi.on("model_select", (_event, ctx) => publishFor(ctx));
	pi.on("agent_end", (_event, ctx) => publishFor(ctx));
}
