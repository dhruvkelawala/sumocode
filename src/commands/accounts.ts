// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- account-config boundary parser: claude-accounts.json (and the legacy multi-pass.json it migrates from) are untrusted user-authored JSON; the typeof predicates below are the sanctioned parse and unknown keys must survive round-trips untouched.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CLAUDE_ACCOUNTS_MIGRATION_FIELD } from "./accounts-config.js";
import { executeSumoReload } from "./reload.js";
import { logDiagnostic } from "../sumo-tui/runtime/diagnostics.js";
import { executeRpcLogin, getRpcLoginRuntime, type RpcLoginRuntime } from "../sumo-tui/pi-compat/login-command.js";

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

export interface AccountsCommandDeps {
	readonly agentDir?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly homeDir?: string;
	readonly installAdapter?: () => Promise<void>;
	readonly login?: (providerId: string, ctx: ExtensionCommandContext) => Promise<void>;
	readonly reload?: (ctx: ExtensionCommandContext) => Promise<void>;
	/** Session-local providers whose config was written after registry startup. */
	readonly pendingReloadProviders?: Set<string>;
}

interface ClaudeAccount {
	readonly providerId: string;
	readonly label: string;
	readonly subscription?: ClaudeSubscription;
	readonly configured: boolean;
	/** True when the session's current model already routes through this account. */
	readonly active: boolean;
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
	const document = readDocument(existsSync(primaryPath) ? primaryPath : resolveLegacyConfigPath(deps));
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
	return `${subscription.provider}-${subscription.index}`;
}

function authConfigured(ctx: ExtensionCommandContext, providerId: string): boolean {
	return ctx.modelRegistry.getProviderAuthStatus(providerId).configured;
}

function accounts(ctx: ExtensionCommandContext, deps: AccountsCommandDeps): ClaudeAccount[] {
	const activeProvider = ctx.model?.provider;
	return [
		{
			providerId: "anthropic",
			label: "default account",
			configured: authConfigured(ctx, "anthropic"),
			active: activeProvider === "anthropic",
		},
		...loadClaudeSubscriptions(deps).map((subscription) => ({
			providerId: accountProviderId(subscription),
			label: subscription.label ?? `Claude account ${subscription.index}`,
			subscription,
			configured: authConfigured(ctx, accountProviderId(subscription)),
			active: activeProvider === accountProviderId(subscription),
		})),
	];
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

function accountState(account: ClaudeAccount): string {
	if (account.active) return "in use";
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

async function switchAccount(pi: ExtensionAPI, ctx: ExtensionCommandContext, account: ClaudeAccount): Promise<void> {
	if (!account.configured) {
		ctx.ui.notify(`${account.label} must be signed in before it can be selected`, "warning");
		return;
	}
	const models = ctx.modelRegistry.getAll().filter((model) => model.provider === account.providerId);
	const target = models.find((model) => model.id === ctx.model?.id) ?? models[0];
	if (!target) {
		ctx.ui.notify(`${account.providerId} is not active; reload SumoCode after adding the account`, "warning");
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
		...(account.configured && !account.active ? ["use this account"] : []),
		account.configured ? "sign in again" : "sign in",
		...(account.subscription ? ["rename account"] : []),
	];
	const action = await ctx.ui.select(`${account.label.toUpperCase()} · ${account.providerId}`, actions);
	if (action === "use this account") await switchAccount(pi, ctx, account);
	else if (action === "sign in" || action === "sign in again") {
		await (deps.login ?? defaultLogin)(account.providerId, ctx);
	} else if (action === "rename account") await renameAccount(ctx, account, deps);
}

export async function executeAccountsCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, deps: AccountsCommandDeps = {}): Promise<void> {
	if (ctx.mode !== "rpc" || !ctx.hasUI) {
		ctx.ui.notify("/accounts requires the SumoCode RPC interface", "warning");
		return;
	}
	const accountList = accounts(ctx, deps);
	const rows = accountList.map(accountRow);
	const addLabel = "add Claude account";
	const selected = await ctx.ui.select("CLAUDE ACCOUNTS", [...rows, addLabel]);
	if (selected === addLabel) {
		await addAccount(ctx, deps);
		return;
	}
	const account = accountList[rows.indexOf(selected ?? "")];
	if (account) await accountActions(pi, ctx, account, deps);
}

export function registerAccountsCommand(pi: ExtensionAPI, deps: AccountsCommandDeps = {}): void {
	pi.registerCommand("accounts", {
		description: "Manage and switch Claude subscription accounts",
		handler: async (_args, ctx) => executeAccountsCommand(pi, ctx, deps),
	});
}
