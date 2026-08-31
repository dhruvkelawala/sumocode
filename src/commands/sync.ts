// oxlint-disable anti-slop/no-runtime-typeof -- account migration parses user-authored JSON at the sync I/O boundary.
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CLAUDE_ACCOUNTS_MIGRATION_FIELD } from "./accounts-config.js";

const execFile = promisify(execFileCallback);
const DEFAULT_TIMEOUT_MS = 120_000;
const CONFIG_REPO_NAME = "sumocode";
const CONFIG_REPO_URL = "git@github.com:dhruvkelawala/sumocode-config.git";
const MANAGED_CONFIG_ITEMS = [
	"APPEND_SYSTEM.md",
	"settings.json",
	"mcp.json",
	"models.json",
	"sumocode.json",
	"claude-accounts.json",
	"xl0-pi-lovely-web.json",
	"extensions",
	"themes",
	"prompts",
	"skills",
] as const;

export interface SyncStepResult {
	readonly label: string;
	readonly ok: boolean;
	readonly output: string;
}

export interface SumoSyncDeps {
	readonly env?: NodeJS.ProcessEnv;
	readonly cwd?: string;
	readonly homeDir?: string;
	readonly moduleUrl?: string;
	readonly exists?: (path: string) => boolean;
	readonly readFile?: (path: string, encoding: BufferEncoding) => string;
	readonly linkConfig?: (configRepo: string, agentDir: string) => SyncStepResult;
	readonly exec?: (file: string, args: readonly string[], options: { cwd?: string; timeout: number }) => Promise<{ stdout: string; stderr: string }>;
}

function moduleUrlToPath(moduleUrl: string): string {
	return moduleUrl.startsWith("file:") ? fileURLToPath(moduleUrl) : moduleUrl;
}

function packageRootFromModule(moduleUrl: string, deps: SumoSyncDeps): string {
	const exists = deps.exists ?? existsSync;
	const modulePath = moduleUrlToPath(moduleUrl);
	let current = dirname(modulePath);
	while (true) {
		if (
			packageNameAt(current, deps) === "@dhruvkelawala/sumocode"
			&& exists(join(current, "src", "extension.ts"))
		) return current;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	// Preserve the source-tree fallback for incomplete/test installations.
	return resolve(dirname(modulePath), "..", "..");
}

/** Resolve the private config repo that backs SumoCode's ~/.pi/agent symlinks. */
function resolveConfigRepo(deps: SumoSyncDeps): string {
	const env = deps.env ?? process.env;
	if (env.SUMOCODE_CONFIG_DIR) return resolve(env.SUMOCODE_CONFIG_DIR);

	const homeDir = deps.homeDir ?? homedir();
	return join(homeDir, ".config", CONFIG_REPO_NAME);
}

function resolvePiAgentDir(deps: SumoSyncDeps): string {
	const homeDir = deps.homeDir ?? homedir();
	return join(homeDir, ".pi", "agent");
}

/** Check if a directory is inside a git repo */
function isGitRepo(dir: string, deps: SumoSyncDeps): boolean {
	const exists = deps.exists ?? existsSync;
	return exists(join(dir, ".git"));
}

/** Runtime check that a decoded package.json carries a usable string name. */
function isNamedPackage(value: { name?: string }): value is { name: string } {
	return typeof value.name === "string";
}

function packageNameAt(dir: string, deps: SumoSyncDeps): string | undefined {
	const exists = deps.exists ?? existsSync;
	const readFile = deps.readFile ?? ((path, encoding) => readFileSync(path, encoding));
	const packagePath = join(dir, "package.json");
	if (!exists(packagePath)) return undefined;
	try {
		// SAFETY: malformed package.json rejects into the catch below; only the optional
		// string `name` field is ever read.
		const parsed = JSON.parse(readFile(packagePath, "utf8")) as { name?: string };
		return isNamedPackage(parsed) ? parsed.name : undefined;
	} catch {
		return undefined;
	}
}

function findActiveSumoDevTree(cwd: string, deps: SumoSyncDeps): string | undefined {
	const exists = deps.exists ?? existsSync;
	let current = resolve(cwd);
	while (true) {
		const isSumocodePackage = packageNameAt(current, deps) === "@dhruvkelawala/sumocode";
		if (isSumocodePackage && exists(join(current, "src", "extension.ts")) && exists(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function resolveSumoCodeRepo(deps: SumoSyncDeps): string {
	const cwd = deps.cwd ?? process.cwd();
	const devTree = findActiveSumoDevTree(cwd, deps);
	if (devTree) return devTree;
	return packageRootFromModule(deps.moduleUrl ?? import.meta.url, deps);
}

function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function resolvesToSamePath(left: string, right: string): boolean {
	try {
		return realpathSync(left) === realpathSync(right);
	} catch {
		return false;
	}
}

interface AccountsLikeDocument {
	readonly subscriptions?: unknown;
	readonly _sumocodeClaudeAccountsMigrated?: unknown;
}

function readAccountsLikeDocument(path: string): AccountsLikeDocument | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		// SAFETY: only subscriptions is inspected below, with an array guard.
		return parsed as AccountsLikeDocument;
	} catch {
		return undefined;
	}
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- decoded subscription entry; guards produce a stable merge identity.
function subscriptionIdentity(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	// SAFETY: object shape was checked above; fields are validated before interpolation.
	const candidate = value as { provider?: unknown; index?: unknown };
	if (typeof candidate.provider !== "string" || typeof candidate.index !== "number" || !Number.isInteger(candidate.index)) return undefined;
	return `${candidate.provider}\u0000${candidate.index}`;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- decoded JSON entry; subscriptionIdentity parses structured rows and JSON.stringify keys the remainder.
function subscriptionMergeKey(value: unknown): string {
	const identity = subscriptionIdentity(value);
	return identity ? `identity:${identity}` : `value:${JSON.stringify(value)}`;
}

function mergeSubscriptions(existing: readonly unknown[], incoming: readonly unknown[]): unknown[] {
	const merged = [...existing];
	const keys = new Set(existing.map(subscriptionMergeKey));
	for (const entry of incoming) {
		const key = subscriptionMergeKey(entry);
		if (keys.has(key)) continue;
		merged.push(entry);
		keys.add(key);
	}
	return merged;
}

function writeAccountsMigration(source: string, document: AccountsLikeDocument): void {
	const temporary = `${source}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, source);
}

function seedUnmigratedPrivateAccounts(source: string, target: string): void {
	const primary = readAccountsLikeDocument(source) ?? {};
	const targetAlreadyManaged = resolvesToSamePath(source, target);
	// The synced marker records document migration; the managed link records
	// completion on this machine. A second machine must still merge its local
	// agent/legacy accounts once before relinking.
	if (primary[CLAUDE_ACCOUNTS_MIGRATION_FIELD] === true && targetAlreadyManaged) return;
	// If target already resolves to source, reading it would merge the same
	// document twice (notably duplicating identity-less extension entries).
	const agentDocument = targetAlreadyManaged ? undefined : readAccountsLikeDocument(target);
	const legacyDocument = readAccountsLikeDocument(join(dirname(target), "multi-pass.json"));
	const privateSubscriptions = Array.isArray(primary.subscriptions) ? primary.subscriptions : [];
	const agentSubscriptions = Array.isArray(agentDocument?.subscriptions) ? agentDocument.subscriptions : [];
	const legacySubscriptions = Array.isArray(legacyDocument?.subscriptions) ? legacyDocument.subscriptions : [];
	// Complete the one-time migration from every available source. Private
	// fields/rows win conflicts, then adapter-native agent state, then legacy.
	const next = {
		...legacyDocument,
		...agentDocument,
		...primary,
		[CLAUDE_ACCOUNTS_MIGRATION_FIELD]: true,
		subscriptions: mergeSubscriptions(mergeSubscriptions(privateSubscriptions, agentSubscriptions), legacySubscriptions),
	};
	writeAccountsMigration(source, next);
}

function initialManagedConfigContent(item: typeof MANAGED_CONFIG_ITEMS[number], target: string): string | undefined {
	if (item !== "claude-accounts.json") return undefined;
	try {
		const targetStat = lstatSync(target);
		if (targetStat.isFile() || targetStat.isSymbolicLink()) return readFileSync(target, "utf8");
	} catch {
		// No regular adapter-native target to migrate; try the legacy source.
	}
	const legacyPath = join(dirname(target), "multi-pass.json");
	if (existsSync(legacyPath)) {
		try {
			return readFileSync(legacyPath, "utf8");
		} catch {
			// Fall through to an empty adapter-native document.
		}
	}
	return `${JSON.stringify({ subscriptions: [] }, null, 2)}\n`;
}

function ensureConfigSymlinks(configRepo: string, agentDir: string): SyncStepResult {
	mkdirSync(agentDir, { recursive: true });
	let backupDir: string | undefined;
	let linked = 0;
	let backedUp = 0;

	for (const item of MANAGED_CONFIG_ITEMS) {
		const source = join(configRepo, item);
		const target = join(agentDir, item);
		if (!pathExists(source)) {
			const initialContent = initialManagedConfigContent(item, target);
			if (initialContent === undefined) continue;
			writeFileSync(source, initialContent, { encoding: "utf8", mode: 0o600 });
		}
		if (item === "claude-accounts.json") seedUnmigratedPrivateAccounts(source, target);

		if (pathExists(target)) {
			if (resolvesToSamePath(source, target)) {
				linked += 1;
				continue;
			}
			const targetStat = lstatSync(target);
			if (targetStat.isSymbolicLink()) {
				rmSync(target);
			} else {
				backupDir ??= join(
					agentDir,
					"pre-sumocode-backup",
					`sync-${new Date().toISOString().replace(/[:.]/g, "-")}`,
				);
				mkdirSync(backupDir, { recursive: true });
				renameSync(target, join(backupDir, item));
				backedUp += 1;
			}
		}

		symlinkSync(source, target);
		linked += 1;
	}

	return {
		label: "config symlinks",
		ok: true,
		output: `Linked ${linked} config item(s) into ${agentDir}${backedUp > 0 ? `; backed up ${backedUp} existing item(s) to ${backupDir}` : ""}`,
	};
}

function runConfigLinkStep(configRepo: string, agentDir: string, deps: SumoSyncDeps): SyncStepResult {
	const linkConfig = deps.linkConfig ?? ensureConfigSymlinks;
	try {
		return linkConfig(configRepo, agentDir);
	} catch (error) {
		return {
			label: "config symlinks",
			ok: false,
			output: error instanceof Error ? error.message : String(error),
		};
	}
}

async function runStep(
	label: string,
	file: string,
	args: readonly string[],
	options: { cwd?: string; timeout?: number },
	deps: SumoSyncDeps,
): Promise<SyncStepResult> {
	const run = deps.exec ?? execFile;
	try {
		const result = await run(file, args, { cwd: options.cwd, timeout: options.timeout ?? DEFAULT_TIMEOUT_MS });
		return { label, ok: true, output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim() };
	} catch (error) {
		// SAFETY: Node execFile rejections carry stdout/stderr/message strings on the error object.
		const err = error as { stdout?: string; stderr?: string; message?: string };
		return {
			label,
			ok: false,
			output: [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").trim(),
		};
	}
}

function notifyFailure(command: "sync" | "bootstrap", ctx: ExtensionCommandContext, step: SyncStepResult): void {
	ctx.ui.notify(`/sumo:${command} failed at ${step.label}`, "warning");
}

export async function executeSumoSync(ctx: ExtensionCommandContext, deps: SumoSyncDeps = {}): Promise<readonly SyncStepResult[]> {
	const configRepo = resolveConfigRepo(deps);
	const agentDir = resolvePiAgentDir(deps);
	const sumocodeRepo = resolveSumoCodeRepo(deps);
	const steps: SyncStepResult[] = [];

	ctx.ui.notify("syncing SumoCode config + source…", "info");

	if (isGitRepo(configRepo, deps)) {
		steps.push(await runStep("config repo git pull", "git", ["pull", "--ff-only"], { cwd: configRepo }, deps));
	} else {
		steps.push({
			label: "config repo git pull",
			ok: false,
			output: `No git repo at ${configRepo}. Run /sumo:bootstrap first.`,
		});
	}
	if (!steps[steps.length - 1]!.ok) {
		notifyFailure("sync", ctx, steps[steps.length - 1]!);
		return steps;
	}

	steps.push(runConfigLinkStep(configRepo, agentDir, deps));
	if (!steps[steps.length - 1]!.ok) {
		notifyFailure("sync", ctx, steps[steps.length - 1]!);
		return steps;
	}

	steps.push(await runStep("sumocode source git pull", "git", ["pull", "--ff-only"], { cwd: sumocodeRepo }, deps));
	if (!steps[steps.length - 1]!.ok) {
		notifyFailure("sync", ctx, steps[steps.length - 1]!);
		return steps;
	}

	ctx.ui.notify("SumoCode sync complete — run /reload if source changed", "info");
	return steps;
}

export function formatSyncResults(results: readonly SyncStepResult[]): string {
	return `${results
		.map((step) => {
			const status = step.ok ? "ok" : "failed";
			const output = step.output ? `\n${step.output}` : "";
			return `[${status}] ${step.label}${output}`;
		})
		.join("\n\n")}\n`;
}

export async function executeSumoBootstrap(ctx: ExtensionCommandContext, deps: SumoSyncDeps = {}): Promise<readonly SyncStepResult[]> {
	const configRepo = resolveConfigRepo(deps);
	const agentDir = resolvePiAgentDir(deps);
	const steps: SyncStepResult[] = [];

	ctx.ui.notify("bootstrapping SumoCode on this machine…", "info");

	if (!isGitRepo(configRepo, deps)) {
		const exists = deps.exists ?? existsSync;
		if (exists(configRepo)) {
			steps.push({
				label: "clone sumocode-config",
				ok: false,
				output: `${configRepo} already exists but is not a git repo. Move it aside or set SUMOCODE_CONFIG_DIR to a valid sumocode-config checkout.`,
			});
		} else {
			steps.push(await runStep("clone sumocode-config", "git", ["clone", CONFIG_REPO_URL, configRepo], {}, deps));
		}
	} else {
		steps.push({ label: "clone sumocode-config", ok: true, output: `Already exists at ${configRepo}` });
	}
	if (!steps[steps.length - 1]!.ok) {
		notifyFailure("bootstrap", ctx, steps[steps.length - 1]!);
		return steps;
	}

	steps.push(await runStep("pull latest config", "git", ["pull", "--ff-only"], { cwd: configRepo }, deps));
	if (!steps[steps.length - 1]!.ok) {
		notifyFailure("bootstrap", ctx, steps[steps.length - 1]!);
		return steps;
	}

	steps.push(runConfigLinkStep(configRepo, agentDir, deps));
	if (!steps[steps.length - 1]!.ok) {
		notifyFailure("bootstrap", ctx, steps[steps.length - 1]!);
		return steps;
	}

	steps.push({
		label: "next step",
		ok: true,
		output: "Restart SumoCode. Keep PI_CODING_AGENT_DIR unset so Pi sessions and package caches remain under ~/.pi/agent.",
	});

	ctx.ui.notify("SumoCode bootstrap complete — restart; keep PI_CODING_AGENT_DIR unset", "info");
	return steps;
}

export function registerSumoSyncCommand(pi: ExtensionAPI, deps: SumoSyncDeps = {}): void {
	pi.registerCommand("sumo:sync", {
		description: "Pull SumoCode config/source and refresh ~/.pi/agent symlinks",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await executeSumoSync(ctx, deps);
		},
	});

	pi.registerCommand("sumo:bootstrap", {
		description: "First-time SumoCode setup: clone config repo and link it into ~/.pi/agent",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await executeSumoBootstrap(ctx, deps);
		},
	});
}
