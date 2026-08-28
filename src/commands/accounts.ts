import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { executeSumoReload } from "./reload.js";
import { executeRpcLogin, getRpcLoginRuntime, type RpcLoginRuntime } from "../sumo-tui/pi-compat/login-command.js";

const execFileAsync = promisify(execFile);
const MULTI_PASS_SOURCE = "npm:pi-multi-pass";

export interface MultiPassSubscription {
	readonly provider: string;
	readonly index: number;
	readonly label?: string;
}

interface MultiPassDocument {
	subscriptions?: unknown;
	pools?: unknown;
	chains?: unknown;
	presets?: unknown;
	[key: string]: unknown;
}

export interface AccountsCommandDeps {
	readonly agentDir?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly homeDir?: string;
	readonly installMultiPass?: () => Promise<void>;
	readonly login?: (providerId: string, ctx: ExtensionCommandContext) => Promise<void>;
	readonly reload?: (ctx: ExtensionCommandContext) => Promise<void>;
}

interface ClaudeAccount {
	readonly providerId: string;
	readonly label: string;
	readonly subscription?: MultiPassSubscription;
	readonly configured: boolean;
}

function resolveAgentDir(deps: AccountsCommandDeps): string {
	return deps.agentDir ?? deps.env?.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(deps.homeDir ?? homedir(), ".pi", "agent");
}

export function resolveMultiPassConfigPath(deps: AccountsCommandDeps = {}): string {
	return join(resolveAgentDir(deps), "multi-pass.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSubscription(value: unknown): MultiPassSubscription | undefined {
	if (!isRecord(value) || typeof value.provider !== "string" || typeof value.index !== "number") return undefined;
	if (!Number.isInteger(value.index) || value.index < 2) return undefined;
	return {
		provider: value.provider,
		index: value.index,
		...(typeof value.label === "string" && value.label.trim() ? { label: value.label.trim() } : {}),
	};
}

function readDocument(path: string): MultiPassDocument {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export function loadClaudeSubscriptions(deps: AccountsCommandDeps = {}): MultiPassSubscription[] {
	const raw = readDocument(resolveMultiPassConfigPath(deps)).subscriptions;
	if (!Array.isArray(raw)) return [];
	return raw
		.map(parseSubscription)
		.filter((entry): entry is MultiPassSubscription => entry?.provider === "anthropic")
		.sort((left, right) => left.index - right.index);
}

export function saveClaudeSubscriptions(subscriptions: readonly MultiPassSubscription[], deps: AccountsCommandDeps = {}): void {
	const path = resolveMultiPassConfigPath(deps);
	const document = readDocument(path);
	const existing = Array.isArray(document.subscriptions) ? document.subscriptions : [];
	const nonClaude = existing.filter((entry) => parseSubscription(entry)?.provider !== "anthropic");
	const next: MultiPassDocument = {
		...document,
		subscriptions: [...nonClaude, ...subscriptions],
		pools: Array.isArray(document.pools) ? document.pools : [],
		chains: Array.isArray(document.chains) ? document.chains : [],
		presets: Array.isArray(document.presets) ? document.presets : [],
	};
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
}

function packageSource(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (isRecord(value) && typeof value.source === "string") return value.source;
	return undefined;
}

export function isMultiPassInstalled(deps: AccountsCommandDeps = {}): boolean {
	const settingsPath = join(resolveAgentDir(deps), "settings.json");
	if (!existsSync(settingsPath)) return false;
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
		if (!isRecord(parsed) || !Array.isArray(parsed.packages)) return false;
		return parsed.packages.some((entry) => packageSource(entry)?.includes("pi-multi-pass") === true);
	} catch {
		return false;
	}
}

async function defaultInstallMultiPass(): Promise<void> {
	await execFileAsync("pi", ["install", MULTI_PASS_SOURCE], {
		env: process.env,
		timeout: 120_000,
		maxBuffer: 1024 * 1024,
	});
}

function nextIndex(subscriptions: readonly MultiPassSubscription[]): number {
	const used = new Set(subscriptions.map((entry) => entry.index));
	let index = 2;
	while (used.has(index)) index += 1;
	return index;
}

function accountProviderId(subscription: MultiPassSubscription): string {
	return `${subscription.provider}-${subscription.index}`;
}

function authConfigured(ctx: ExtensionCommandContext, providerId: string): boolean {
	return ctx.modelRegistry.getProviderAuthStatus(providerId).configured;
}

function accounts(ctx: ExtensionCommandContext, deps: AccountsCommandDeps): ClaudeAccount[] {
	return [
		{
			providerId: "anthropic",
			label: "default Claude account",
			configured: authConfigured(ctx, "anthropic"),
		},
		...loadClaudeSubscriptions(deps).map((subscription) => ({
			providerId: accountProviderId(subscription),
			label: subscription.label ?? `Claude account ${subscription.index}`,
			subscription,
			configured: authConfigured(ctx, accountProviderId(subscription)),
		})),
	];
}

async function defaultLogin(providerId: string, ctx: ExtensionCommandContext): Promise<void> {
	let runtime: RpcLoginRuntime;
	try {
		runtime = getRpcLoginRuntime(ctx);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Sign-in unavailable: ${message}`, "error");
		return;
	}
	await executeRpcLogin(providerId, ctx, runtime);
}

function accountRow(account: ClaudeAccount): string {
	return `${account.label}  ${account.providerId} · ${account.configured ? "signed in" : "sign in required"}`;
}

async function addAccount(ctx: ExtensionCommandContext, deps: AccountsCommandDeps): Promise<void> {
	if (!isMultiPassInstalled(deps)) {
		const install = await ctx.ui.confirm(
			"SET UP MULTI-ACCOUNT CLAUDE",
			"SumoCode uses pi-multi-pass to keep each OAuth subscription separate. Install it now?",
		);
		if (!install) return;
		ctx.ui.setStatus("sumocode.accounts", "installing pi-multi-pass…");
		try {
			await (deps.installMultiPass ?? defaultInstallMultiPass)();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Unable to install pi-multi-pass: ${message}`, "error");
			return;
		} finally {
			ctx.ui.setStatus("sumocode.accounts", undefined);
		}
	}

	const subscriptions = loadClaudeSubscriptions(deps);
	const index = nextIndex(subscriptions);
	const suggestedLabel = index === 2 ? "company" : `Claude account ${index}`;
	const label = await ctx.ui.input("ACCOUNT LABEL", suggestedLabel);
	if (label === undefined) return;
	const subscription: MultiPassSubscription = {
		provider: "anthropic",
		index,
		label: label.trim() || suggestedLabel,
	};
	saveClaudeSubscriptions([...subscriptions, subscription], deps);
	ctx.ui.notify(`Added ${subscription.label} as anthropic-${index}`, "info");
	const reload = await ctx.ui.confirm(
		"RELOAD TO ACTIVATE ACCOUNT",
		"Reload SumoCode now? After reload, open /accounts and choose the new account to sign in.",
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
	const actions = [
		...(account.configured ? ["use this account"] : []),
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
	const addLabel = "add Claude account  install/configure pi-multi-pass";
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
