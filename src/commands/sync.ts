import { execFile as execFileCallback } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

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

function packageRootFromModule(moduleUrl: string): string {
	// src/commands/sync.ts -> package root
	return resolve(dirname(moduleUrlToPath(moduleUrl)), "..", "..");
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

function packageNameAt(dir: string, deps: SumoSyncDeps): string | undefined {
	const exists = deps.exists ?? existsSync;
	const readFile = deps.readFile ?? ((path, encoding) => readFileSync(path, encoding));
	const packagePath = join(dir, "package.json");
	if (!exists(packagePath)) return undefined;
	try {
		const parsed = JSON.parse(readFile(packagePath, "utf8")) as { name?: unknown };
		return typeof parsed.name === "string" ? parsed.name : undefined;
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
	return packageRootFromModule(deps.moduleUrl ?? import.meta.url);
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

function ensureConfigSymlinks(configRepo: string, agentDir: string): SyncStepResult {
	mkdirSync(agentDir, { recursive: true });
	let backupDir: string | undefined;
	let linked = 0;
	let backedUp = 0;

	for (const item of MANAGED_CONFIG_ITEMS) {
		const source = join(configRepo, item);
		if (!pathExists(source)) continue;

		const target = join(agentDir, item);
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

	ctx.ui.notify("SumoCode sync complete — run /sumo:reload if source changed", "info");
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
