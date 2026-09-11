// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- account-config boundary parser: claude-accounts.json (and the legacy multi-pass.json it migrates from) are untrusted user-authored JSON; the typeof predicates below are the sanctioned parse and unknown keys must survive round-trips untouched.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Api, Credential, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CLAUDE_ACCOUNTS_MIGRATION_FIELD } from "./accounts-config.js";
import { claudeAccountProviderId, isClaudeProvider } from "../config/claude-providers.js";
import { filterToEnabled, readEnabledModelPatterns } from "../config/enabled-models.js";
import { executeSumoReload } from "./reload.js";
import { logDiagnostic } from "../sumo-tui/runtime/diagnostics.js";
import {
	executeRpcLogin,
	getRpcCredentialStore,
	getRpcLoginRuntime,
	type RpcCredentialStore,
	type RpcLoginRuntime,
} from "../sumo-tui/pi-compat/login-command.js";
import {
	CLAUDE_SETUP_TOKEN_COMMAND,
	acquireLongLivedToken,
	isLongLivedClaudeToken,
	isStaticClaudeCredential,
	parseAuthorizationUrl,
	staticClaudeCredential,
	validateLongLivedToken,
	type AcquireResult,
	type AcquireTokenOptions,
	type StaticClaudeCredential,
	type TokenValidation,
	type ValidateRuntime,
} from "./claude-token.js";
import { secretInputTitle } from "../sumo-tui/pi-compat/secret-input.js";

/** Adapter-native account config; the pi-claude-oauth-adapter reads this first. */
const ACCOUNTS_CONFIG_FILE = "claude-accounts.json";
/** Legacy pi-multi-pass config, read once so existing accounts migrate forward. */
const LEGACY_CONFIG_FILE = "multi-pass.json";
/**
 * The exact adapter source that registers `anthropic-N` providers with working
 * OAuth. Verified by exact equality, not substring matching: textual variants
 * (`@not-multi-account` refs, checkout paths that merely contain the words)
 * would otherwise pass a substring probe while leaving added accounts unable
 * to sign in. Unrecognized sources re-enter the install flow instead.
 */
const ADAPTER_PACKAGE_SOURCE = "git:github.com/dhruvkelawala/pi-claude-oauth-adapter@multi-account";

const execFileAsync = promisify(execFile);
const sessionPendingReloadProviders = new Set<string>();

export interface ClaudeSubscription {
	readonly provider: string;
	readonly index: number;
	readonly label?: string;
}

interface AccountsDocument {
	subscriptions?: unknown;
	[key: string]: unknown;
}

/** Sign-in methods offered for an account, in the order the modal lists them. */
export const SIGN_IN_LONG_LIVED = "use a long-lived token";
export const SIGN_IN_BROWSER = "sign in with a browser";
export const RENEW_LONG_LIVED = "mint a new long-lived token";

/** How an account's stored credential authenticates, read from auth.json. */
export type StoredClaudeCredential = "long-lived-token" | "oauth" | "api-key";

export interface AccountsCommandDeps {
	readonly agentDir?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly homeDir?: string;
	readonly installAdapter?: () => Promise<void>;
	readonly login?: (providerId: string, ctx: ExtensionCommandContext) => Promise<void>;
	readonly reload?: (ctx: ExtensionCommandContext) => Promise<void>;
	/** Repaint the account chrome after a label change; a rename runs no agent turn. */
	readonly refreshAccountStatus?: (ctx: ExtensionCommandContext) => void;
	/** Session-local providers whose config was written after registry startup. */
	readonly pendingReloadProviders?: Set<string>;
	/** Token-flow seams; tests inject them so no spawn, fetch, or Pi runtime is needed. */
	readonly acquireToken?: (options: AcquireTokenOptions) => Promise<AcquireResult>;
	readonly validateToken?: (token: string, runtime: ValidateRuntime) => Promise<TokenValidation>;
	readonly storeCredential?: (providerId: string, credential: StaticClaudeCredential) => Promise<void>;
	readonly readStoredCredential?: (providerId: string) => Promise<StoredClaudeCredential | undefined>;
	readonly now?: () => number;
}

interface ClaudeAccount {
	readonly providerId: string;
	readonly label: string;
	readonly subscription?: ClaudeSubscription;
	readonly configured: boolean;
	/** True when the session's current model already routes through this account. */
	readonly active: boolean;
	/** True when the stored credential is a long-lived setup token, not a login. */
	readonly longLivedToken: boolean;
}

function resolveAgentDir(deps: AccountsCommandDeps): string {
	return deps.agentDir ?? deps.env?.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(deps.homeDir ?? homedir(), ".pi", "agent");
}

export function resolveAccountsConfigPath(deps: AccountsCommandDeps = {}): string {
	return join(resolveAgentDir(deps), ACCOUNTS_CONFIG_FILE);
}

function resolvePrivateAccountsPath(deps: AccountsCommandDeps): string {
	const privateConfigDir = resolve(deps.env?.SUMOCODE_CONFIG_DIR ?? process.env.SUMOCODE_CONFIG_DIR ?? join(deps.homeDir ?? homedir(), ".config", "sumocode"));
	return join(privateConfigDir, ACCOUNTS_CONFIG_FILE);
}

function accountPathsShareParent(targetPath: string, managedPath: string): boolean {
	try {
		return realpathSync(dirname(targetPath)) === realpathSync(dirname(managedPath));
	} catch {
		return false;
	}
}

function ensurePrivateAccountsLink(deps: AccountsCommandDeps, privatePath: string): void {
	const targetPath = resolveAccountsConfigPath(deps);
	if (accountPathsShareParent(targetPath, privatePath)) return;
	const privateStat = lstatSync(privatePath);
	if (privateStat.isSymbolicLink() || !privateStat.isFile()) throw new Error(`Expected a regular private accounts source: ${privatePath}`);
	let targetStat: ReturnType<typeof lstatSync> | undefined;
	try {
		targetStat = lstatSync(targetPath);
	} catch {
		// Missing target is linked below.
	}
	if (targetStat?.isSymbolicLink()) {
		const linkTarget = resolve(dirname(targetPath), readlinkSync(targetPath));
		if (linkTarget !== privatePath) throw new Error(`Refusing to replace an unmanaged accounts symlink: ${targetPath}`);
		return;
	}
	if (targetStat) {
		if (!targetStat.isFile()) throw new Error(`Expected a regular accounts file or managed symlink: ${targetPath}`);
		const backup = `${targetPath}.pre-managed-backup-${Date.now()}`;
		renameSync(targetPath, backup);
	}
	mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
	symlinkSync(privatePath, targetPath);
}

function resolveAccountsReadPath(deps: AccountsCommandDeps): string {
	const privatePath = resolvePrivateAccountsPath(deps);
	if (existsSync(privatePath)) {
		ensurePrivateAccountsLink(deps, privatePath);
		return privatePath;
	}
	return resolveAccountsConfigPath(deps);
}

interface AccountsWriteDestination {
	readonly writePath: string;
	readonly linkPath?: string;
}

function pathEntryExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function resolveAccountsWriteDestination(deps: AccountsCommandDeps): AccountsWriteDestination {
	const targetPath = resolveAccountsConfigPath(deps);
	const managedTarget = resolvePrivateAccountsPath(deps);
	const privateConfigDir = dirname(managedTarget);
	// Supported canonical layout: ~/.pi/agent itself points at the private
	// config repo, so both lexical paths name the same file already.
	if (accountPathsShareParent(targetPath, managedTarget)) return { writePath: managedTarget };
	if (pathEntryExists(managedTarget) && lstatSync(managedTarget).isSymbolicLink()) {
		throw new Error(`Refusing to replace a symlinked private accounts source: ${managedTarget}`);
	}
	let targetStat: ReturnType<typeof lstatSync> | undefined;
	try {
		targetStat = lstatSync(targetPath);
	} catch {
		// A missing target can be bootstrapped below when the private repo exists.
	}
	if (targetStat?.isSymbolicLink()) {
		const linkTarget = resolve(dirname(targetPath), readlinkSync(targetPath));
		if (linkTarget !== managedTarget) throw new Error(`Refusing to write accounts through an unmanaged symlink: ${targetPath}`);
		return { writePath: managedTarget };
	}
	// Match /sumo:sync's managed-config contract directly: command ordering
	// must not decide whether account metadata lands in the private repository.
	if (existsSync(join(privateConfigDir, ".git"))) return { writePath: managedTarget, linkPath: targetPath };
	return { writePath: targetPath };
}

function resolveLegacyConfigPath(deps: AccountsCommandDeps): string {
	return join(resolveAgentDir(deps), LEGACY_CONFIG_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSubscription(value: unknown): ClaudeSubscription | undefined {
	if (!isRecord(value) || typeof value.provider !== "string" || typeof value.index !== "number") return undefined;
	if (!Number.isInteger(value.index) || value.index < 2) return undefined;
	const label = typeof value.label === "string" ? value.label.trim() : "";
	const subscription: ClaudeSubscription = { provider: value.provider, index: value.index };
	if (label) return { ...subscription, label };
	return subscription;
}

function readDocument(path: string): AccountsDocument {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function readDocumentForSave(path: string): AccountsDocument {
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(`Invalid accounts config; repair before saving: ${path}`);
	}
	if (!isRecord(parsed)) throw new Error(`Invalid accounts config; expected an object: ${path}`);
	if (parsed.subscriptions !== undefined && !Array.isArray(parsed.subscriptions)) {
		throw new Error(`Invalid accounts config subscriptions; expected an array: ${path}`);
	}
	return parsed;
}

function claudeSubscriptionsFrom(document: AccountsDocument): ClaudeSubscription[] {
	if (!Array.isArray(document.subscriptions)) return [];
	return document.subscriptions
		.map(parseSubscription)
		.filter((entry): entry is ClaudeSubscription => entry?.provider === "anthropic")
		.sort((left, right) => left.index - right.index);
}

/**
 * Load Claude subscriptions, preferring the adapter-native config and falling
 * back to the legacy pi-multi-pass file so existing setups keep working until
 * the next save migrates them forward.
 */
export function loadClaudeSubscriptions(deps: AccountsCommandDeps = {}): ClaudeSubscription[] {
	const primaryPath = resolveAccountsReadPath(deps);
	const primary = claudeSubscriptionsFrom(readDocument(primaryPath));
	if (primary.length > 0) return primary;
	if (existsSync(primaryPath)) return primary;
	return claudeSubscriptionsFrom(readDocument(resolveLegacyConfigPath(deps)));
}

export function saveClaudeSubscriptions(subscriptions: readonly ClaudeSubscription[], deps: AccountsCommandDeps = {}): void {
	const destination = resolveAccountsWriteDestination(deps);
	const primaryPath = resolveAccountsReadPath(deps);
	const document = readDocumentForSave(existsSync(primaryPath) ? primaryPath : resolveLegacyConfigPath(deps));
	const existing = Array.isArray(document.subscriptions) ? document.subscriptions : [];
	const nonClaude = existing.filter((entry) => parseSubscription(entry)?.provider !== "anthropic");
	const next: AccountsDocument = {
		...document,
		[CLAUDE_ACCOUNTS_MIGRATION_FIELD]: true,
		subscriptions: [...nonClaude, ...subscriptions],
	};
	mkdirSync(dirname(destination.writePath), { recursive: true, mode: 0o700 });
	const temporary = `${destination.writePath}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, destination.writePath);
	if (destination.linkPath) {
		if (pathEntryExists(destination.linkPath)) rmSync(destination.linkPath, { force: true });
		mkdirSync(dirname(destination.linkPath), { recursive: true, mode: 0o700 });
		symlinkSync(destination.writePath, destination.linkPath);
	}
}

function nextIndex(subscriptions: readonly ClaudeSubscription[]): number {
	const used = new Set(subscriptions.map((entry) => entry.index));
	let index = 2;
	while (used.has(index)) index += 1;
	return index;
}

function packageSource(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (isRecord(value) && typeof value.source === "string") return value.source;
	return undefined;
}

/**
 * Detect the multi-account OAuth adapter in settings.json packages by exact
 * source equality. Only this source registers the `anthropic-N` provider ids;
 * anything else (upstream builds, other refs, local checkouts) re-enters the
 * install flow rather than silently skipping it.
 */
export function isAdapterInstalled(deps: AccountsCommandDeps = {}): boolean {
	const settingsPath = join(resolveAgentDir(deps), "settings.json");
	if (!existsSync(settingsPath)) return false;
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
		if (!isRecord(parsed) || !Array.isArray(parsed.packages)) return false;
		return parsed.packages.some((entry) => packageSource(entry) === ADAPTER_PACKAGE_SOURCE);
	} catch {
		return false;
	}
}

async function defaultInstallAdapter(): Promise<void> {
	// bin/sumocode.sh exports PI_BIN for the sessions it launches; a source
	// checkout may have no `pi` on PATH at all.
	const command = process.env.PI_BIN?.trim() || "pi";
	await execFileAsync(command, ["install", ADAPTER_PACKAGE_SOURCE], {
		env: process.env,
		timeout: 120_000,
		maxBuffer: 1024 * 1024,
	});
}

function accountProviderId(subscription: ClaudeSubscription): string {
	return claudeAccountProviderId(subscription.index);
}

function authConfigured(ctx: ExtensionCommandContext, providerId: string): boolean {
	return ctx.modelRegistry.getProviderAuthStatus(providerId).configured;
}

/**
 * Credential kind for an account, read through the same store Pi resolves
 * requests against. Only the credential's shape is inspected; key material is
 * never returned, logged, or rendered.
 */
async function readStoredCredentialKind(ctx: ExtensionCommandContext, providerId: string): Promise<StoredClaudeCredential | undefined> {
	let store: RpcCredentialStore | undefined;
	try {
		store = getRpcCredentialStore(ctx);
	} catch (error) {
		// Degraded, not fatal: the account list still renders, labelled from the
		// auth snapshot alone. Logged because a row then cannot tell a token from
		// a login until Pi's runtime is back.
		logDiagnostic("accounts_credential_store_unavailable", {
			provider: providerId,
			errorName: error instanceof Error ? error.name : "unknown",
		});
		return undefined;
	}
	if (!store) return undefined;
	let credential: Credential | undefined;
	try {
		credential = await store.read(providerId);
	} catch (error) {
		logDiagnostic("accounts_credential_read_failed", {
			provider: providerId,
			errorName: error instanceof Error ? error.name : "unknown",
		});
		return undefined;
	}
	if (isStaticClaudeCredential(credential)) return "long-lived-token";
	if (credential?.type === "oauth") return "oauth";
	if (credential?.type === "api_key") return "api-key";
	return undefined;
}

async function accounts(ctx: ExtensionCommandContext, deps: AccountsCommandDeps): Promise<ClaudeAccount[]> {
	const activeProvider = ctx.model?.provider;
	const read = deps.readStoredCredential ?? ((providerId: string) => readStoredCredentialKind(ctx, providerId));
	const subscriptions = loadClaudeSubscriptions(deps);
	const providerIds = ["anthropic", ...subscriptions.map(accountProviderId)];
	const kinds = await Promise.all(providerIds.map((providerId) => read(providerId)));
	const accountList: ClaudeAccount[] = [
		{
			providerId: "anthropic",
			label: "default account",
			configured: authConfigured(ctx, "anthropic"),
			active: activeProvider === "anthropic",
			longLivedToken: kinds[0] === "long-lived-token",
		},
	];
	for (const [index, subscription] of subscriptions.entries()) {
		const providerId = accountProviderId(subscription);
		accountList.push({
			providerId,
			label: subscription.label ?? `Claude account ${subscription.index}`,
			subscription,
			configured: authConfigured(ctx, providerId),
			active: activeProvider === providerId,
			longLivedToken: kinds[index + 1] === "long-lived-token",
		});
	}
	return accountList;
}

async function defaultLogin(providerId: string, ctx: ExtensionCommandContext): Promise<void> {
	let runtime: RpcLoginRuntime;
	try {
		runtime = getRpcLoginRuntime(ctx);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logDiagnostic("accounts_login_runtime_unavailable", { provider: providerId, errorMessage: message });
		ctx.ui.notify(`Sign-in unavailable: ${message}`, "error");
		return;
	}
	logDiagnostic("accounts_login_start", { provider: providerId });
	await executeRpcLogin(providerId, ctx, runtime);
}

function acquireFailureText(result: Exclude<AcquireResult, { status: "ok" }>): string {
	switch (result.status) {
		case "unavailable":
			return "the claude CLI is not on PATH";
		case "timeout":
			return "the command timed out";
		case "failed":
			return result.reason;
	}
}

/**
 * Store a credential Pi did not mint itself. The write goes through Pi's own
 * credential store so it takes the same lock as a concurrent token refresh;
 * writing auth.json directly could drop another provider's rotation.
 */
async function defaultStoreCredential(
	ctx: ExtensionCommandContext,
	providerId: string,
	credential: StaticClaudeCredential,
): Promise<void> {
	const store = getRpcCredentialStore(ctx);
	if (!store) throw new Error("Pi's credential store is unavailable; update SumoCode's Pi compatibility adapter");
	// Pi validates stored credentials structurally (type/access/refresh/expires) and
	// permits additional fields, which is how `mintedAt` rides along.
	await store.modify(providerId, () => credential);
	try {
		// Pi builds its auth snapshot at startup and after its own credential
		// operations. A write straight to the store must re-run the availability
		// pass, or /accounts keeps reading the provider as unconfigured until the
		// next reload even though requests already authenticate.
		await ctx.modelRegistry.refresh({ providers: [providerId] });
	} catch {
		// The credential is stored; a failed snapshot refresh is not a flow failure.
	}
}

/**
 * Mint (or paste) a long-lived token and store it for `account`.
 *
 * The mint runs first so the common path needs nothing but the browser
 * authorization; the masked input is the fallback when the CLI is missing or
 * the mint fails, and the only path when the user already has a token.
 */
async function useLongLivedToken(ctx: ExtensionCommandContext, account: ClaudeAccount, deps: AccountsCommandDeps): Promise<void> {
	const controller = new AbortController();
	try {
		ctx.ui.setStatus("sumocode.accounts", `minting a long-lived token for ${account.label}…`);
		let acquired: string | undefined;
		try {
			const result = await (deps.acquireToken ?? ((options: AcquireTokenOptions) => acquireLongLivedToken(options)))({
				signal: controller.signal,
				onProgress: (line) => {
					const url = parseAuthorizationUrl(line);
					if (url) ctx.ui.setWidget("sumocode.accounts", [`authorize in the browser: ${url}`], { placement: "aboveEditor" });
				},
			});
			if (result.status === "ok") acquired = result.token;
			else if (!(result.status === "failed" && result.reason === "cancelled")) {
				ctx.ui.notify(`could not run ${CLAUDE_SETUP_TOKEN_COMMAND}: ${acquireFailureText(result)} — run it yourself and paste the token`, "warning");
			}
		} finally {
			ctx.ui.setStatus("sumocode.accounts", undefined);
			ctx.ui.setWidget("sumocode.accounts", undefined);
		}
		const pasted = acquired ?? (await pasteLongLivedToken(ctx, account, controller.signal));
		const token = pasted?.trim();
		if (!token) return;
		if (!isLongLivedClaudeToken(token)) {
			ctx.ui.notify(`that is not a Claude long-lived token; ${CLAUDE_SETUP_TOKEN_COMMAND} prints one starting with sk-ant-oat`, "warning");
			return;
		}
		const validation = await (deps.validateToken ?? validateLongLivedToken)(token, { signal: controller.signal });
		if (validation.status === "rejected") {
			ctx.ui.notify(`${account.label}: Anthropic rejected that token — mint a fresh one with ${CLAUDE_SETUP_TOKEN_COMMAND}`, "error");
			return;
		}
		if (validation.status === "unreachable") {
			ctx.ui.notify("Anthropic could not be reached to check the token; storing it anyway", "warning");
		}
		const organization = validation.status === "ok" ? validation.organization : undefined;
		const credential = staticClaudeCredential(token, (deps.now ?? Date.now)());
		const store = deps.storeCredential ?? ((providerId: string, value: StaticClaudeCredential) => defaultStoreCredential(ctx, providerId, value));
		try {
			await store(account.providerId, credential);
		} catch (error) {
			// Deliberately not rendering the raw error: a credential-store failure
			// must never be able to echo token material into the transcript.
			logDiagnostic("accounts_long_lived_token_store_failed", {
				provider: account.providerId,
				errorName: error instanceof Error ? error.name : "unknown",
			});
			ctx.ui.notify(`unable to store the token for ${account.label} — see /sumo:diag output`, "error");
			return;
		}
		logDiagnostic("accounts_long_lived_token_stored", { provider: account.providerId, organization: organization ?? null });
		ctx.ui.notify(
			`stored a long-lived token for ${account.label}${organization ? ` · ${organization}` : ""} — it never refreshes, so mint a new one when it expires`,
			"info",
		);
	} finally {
		controller.abort();
	}
}

/**
 * Masked paste fallback. The command travels in the widget above the editor,
 * not only in the transient notification, because the modal is where the user
 * is looking when they need it.
 */
async function pasteLongLivedToken(
	ctx: ExtensionCommandContext,
	account: ClaudeAccount,
	signal: AbortSignal,
): Promise<string | undefined> {
	ctx.ui.setWidget("sumocode.accounts", [`run \`${CLAUDE_SETUP_TOKEN_COMMAND}\`, then paste the token here`], {
		placement: "aboveEditor",
	});
	try {
		return await ctx.ui.input(secretInputTitle(`CLAUDE SETUP TOKEN · ${account.label}`), "sk-ant-oat01-…", { signal });
	} finally {
		ctx.ui.setWidget("sumocode.accounts", undefined);
	}
}

/**
 * A signed-in account reads "signed in" regardless of which provider the
 * session's current model uses — a fresh session starts on the settings default
 * (often non-Claude), and an earlier "inactive" label sent users through
 * needless re-auth. A stored long-lived token is authoritative over the auth
 * snapshot, which is refreshed asynchronously after a store write; a token row
 * reading "sign in required" during that window is the confusion this flow
 * exists to remove.
 */
function accountState(account: ClaudeAccount): string {
	if (account.active) return "in use";
	if (account.longLivedToken) return "token";
	return account.configured ? "signed in" : "sign in required";
}

/**
 * Portrait/narrow modals clip the right-aligned value column first, so the
 * account state (which account a session is actually on) lives left of the
 * two-space seam and the provider id — derivable from the label — is what
 * gets truncated instead.
 */
function accountRow(account: ClaudeAccount): string {
	return `${account.label} · ${accountState(account)}  ${account.providerId}`;
}

/**
 * Ensure the multi-account OAuth adapter is installed before flows that need
 * it (adding an extra account, acting on one). The default `anthropic` account
 * works without it, so it is never gated. Returns false when the user declines
 * or the install fails; in both cases nothing further should run.
 */
function pendingReloadProviders(deps: AccountsCommandDeps): Set<string> {
	return deps.pendingReloadProviders ?? sessionPendingReloadProviders;
}

async function installAdapterPackage(ctx: ExtensionCommandContext, deps: AccountsCommandDeps): Promise<boolean> {
	ctx.ui.setStatus("sumocode.accounts", "installing pi-claude-oauth-adapter…");
	try {
		await (deps.installAdapter ?? defaultInstallAdapter)();
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logDiagnostic("accounts_install_adapter_failed", { errorMessage: message });
		ctx.ui.notify(`Unable to install pi-claude-oauth-adapter: ${message}`, "error");
		return false;
	} finally {
		ctx.ui.setStatus("sumocode.accounts", undefined);
	}
}

async function ensureAdapterInstalled(ctx: ExtensionCommandContext, deps: AccountsCommandDeps): Promise<boolean> {
	if (isAdapterInstalled(deps)) return true;
	const install = await ctx.ui.confirm(
		"SET UP MULTI-ACCOUNT CLAUDE",
		"/accounts needs the Claude OAuth adapter (pi-claude-oauth-adapter) to register and sign in extra accounts. Install it now?",
	);
	return install ? installAdapterPackage(ctx, deps) : false;
}

async function addAccount(ctx: ExtensionCommandContext, deps: AccountsCommandDeps): Promise<void> {
	if (!(await ensureAdapterInstalled(ctx, deps))) return;
	const subscriptions = loadClaudeSubscriptions(deps);
	const index = nextIndex(subscriptions);
	const suggestedLabel = index === 2 ? "company" : `Claude account ${index}`;
	const label = await ctx.ui.input("ACCOUNT LABEL", suggestedLabel);
	if (label === undefined) return;
	const subscription: ClaudeSubscription = {
		provider: "anthropic",
		index,
		label: label.trim() || suggestedLabel,
	};
	saveClaudeSubscriptions([...subscriptions, subscription], deps);
	pendingReloadProviders(deps).add(`anthropic-${index}`);
	ctx.ui.notify(`Added ${subscription.label} as anthropic-${index}`, "info");
	const reload = await ctx.ui.confirm(
		"RELOAD TO ACTIVATE ACCOUNT",
		"Reload SumoCode now? After reload, open /accounts and sign in to the new account.",
	);
	if (reload) await (deps.reload ?? ((reloadCtx) => executeSumoReload(reloadCtx)))(ctx);
}

/**
 * Model to select when switching onto `account`. Keep the current model id
 * when the session is already on a Claude account, so switching accounts
 * never silently changes the model. Otherwise (fresh sessions start on the
 * settings default provider) pick the first model the user has enabled for
 * the base anthropic provider, since those patterns mirror onto every
 * account, and only then fall back to the provider's first available model.
 */
function preferredAccountModel(ctx: ExtensionCommandContext, account: ClaudeAccount, deps: AccountsCommandDeps): Model<Api> | undefined {
	const available = ctx.modelRegistry.getAvailable();
	const availableForAccount = available.filter((model) => model.provider === account.providerId);
	const current = ctx.model;
	if (current && isClaudeProvider(current.provider)) {
		const sameModel = availableForAccount.find((model) => model.id === current.id);
		if (sameModel) return sameModel;
	}
	// Resolve the patterns over the same set the cycle ring and /model picker
	// use — models whose provider has credentials — so a pattern means the
	// same thing here as it does there. Resolving over one provider's models
	// would disambiguate an id the picker rejects; resolving over every
	// registered model would treat an unreachable provider as a collision.
	const enabled = filterToEnabled(available, readEnabledModelPatterns({ PI_CODING_AGENT_DIR: resolveAgentDir(deps) }));
	return enabled.find((model) => model.provider === account.providerId) ?? availableForAccount[0];
}

async function switchAccount(pi: ExtensionAPI, ctx: ExtensionCommandContext, account: ClaudeAccount, deps: AccountsCommandDeps): Promise<void> {
	if (!account.configured && !account.longLivedToken) {
		ctx.ui.notify(`${account.label} must be signed in before it can be selected`, "warning");
		return;
	}
	const target = preferredAccountModel(ctx, account, deps);
	if (!target) {
		ctx.ui.notify(`${account.providerId} has no selectable model; reload SumoCode before switching`, "warning");
		return;
	}
	const selected = await pi.setModel(target);
	ctx.ui.notify(selected ? `Using ${account.label} · ${target.id}` : `Unable to select ${account.label}`, selected ? "info" : "error");
}

async function renameAccount(ctx: ExtensionCommandContext, account: ClaudeAccount, deps: AccountsCommandDeps): Promise<void> {
	if (!account.subscription) return;
	const label = await ctx.ui.input("ACCOUNT LABEL", account.label);
	if (label === undefined || !label.trim()) return;
	const subscriptions = loadClaudeSubscriptions(deps).map((entry) =>
		entry.index === account.subscription?.index ? { ...entry, label: label.trim() } : entry,
	);
	saveClaudeSubscriptions(subscriptions, deps);
	ctx.ui.notify(`Renamed ${account.providerId} to ${label.trim()}`, "info");
}

async function accountActions(pi: ExtensionAPI, ctx: ExtensionCommandContext, account: ClaudeAccount, deps: AccountsCommandDeps): Promise<void> {
	// Acting on an extra account needs the adapter. The default `anthropic`
	// account is built into Pi and never gated. A just-installed adapter cannot
	// register providers into the running session, so reload before offering
	// actions that would otherwise dead-end on an unregistered provider.
	if (account.subscription) {
		if (!isAdapterInstalled(deps)) {
			if (!(await ensureAdapterInstalled(ctx, deps))) return;
			ctx.ui.notify("pi-claude-oauth-adapter installed. Reload SumoCode, then re-open /accounts.", "info");
			await (deps.reload ?? ((reloadCtx) => executeSumoReload(reloadCtx)))(ctx);
			return;
		}
		const providerRegistered = ctx.modelRegistry.getAll().some((model) => model.provider === account.providerId);
		if (!providerRegistered) {
			if (pendingReloadProviders(deps).has(account.providerId)) {
				ctx.ui.notify(`${account.providerId} is not registered in this session. Reloading SumoCode…`, "info");
				await (deps.reload ?? ((reloadCtx) => executeSumoReload(reloadCtx)))(ctx);
				return;
			}
			const repair = await ctx.ui.confirm(
				"REPAIR MULTI-ACCOUNT CLAUDE",
				`${account.providerId} failed to register during startup. Reinstall the adapter and reload?`,
			);
			if (!repair) {
				ctx.ui.notify(`${account.providerId} remains unavailable until the adapter is repaired`, "warning");
				return;
			}
			if (!(await installAdapterPackage(ctx, deps))) return;
			await (deps.reload ?? ((reloadCtx) => executeSumoReload(reloadCtx)))(ctx);
			return;
		}
	}
	const actions = [
		...((account.configured || account.longLivedToken) && !account.active ? ["use this account"] : []),
		account.longLivedToken ? RENEW_LONG_LIVED : SIGN_IN_LONG_LIVED,
		SIGN_IN_BROWSER,
		...(account.subscription ? ["rename account"] : []),
	];
	const action = await ctx.ui.select(`${account.label.toUpperCase()} · ${account.providerId}`, actions);
	if (action === "use this account") await switchAccount(pi, ctx, account, deps);
	else if (action === SIGN_IN_LONG_LIVED || action === RENEW_LONG_LIVED) await useLongLivedToken(ctx, account, deps);
	else if (action === SIGN_IN_BROWSER) {
		await (deps.login ?? defaultLogin)(account.providerId, ctx);
	} else if (action === "rename account") await renameAccount(ctx, account, deps);
}

export async function executeAccountsCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, deps: AccountsCommandDeps = {}): Promise<void> {
	if (ctx.mode !== "rpc" || !ctx.hasUI) {
		ctx.ui.notify("/accounts requires the SumoCode RPC interface", "warning");
		return;
	}
	const accountList = await accounts(ctx, deps);
	const rows = accountList.map(accountRow);
	const addLabel = "add Claude account";
	const selected = await ctx.ui.select("CLAUDE ACCOUNTS", [...rows, addLabel]);
	if (selected === addLabel) {
		await addAccount(ctx, deps);
		return;
	}
	const account = accountList[rows.indexOf(selected ?? "")];
	if (!account) return;
	await accountActions(pi, ctx, account, deps);
	// A rename or a stored credential changes the account the footer resolves
	// while the command runs no agent turn — Pi executes an extension command
	// inside `prompt()` and returns before the agent loop — so no `agent_end`
	// follows to repaint it.
	deps.refreshAccountStatus?.(ctx);
}

export function registerAccountsCommand(pi: ExtensionAPI, deps: AccountsCommandDeps = {}): void {
	pi.registerCommand("accounts", {
		description: "Manage and switch Claude subscription accounts",
		handler: async (_args, ctx) => executeAccountsCommand(pi, ctx, deps),
	});
}
