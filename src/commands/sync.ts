import { execFile as execFileCallback } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const execFile = promisify(execFileCallback);
const DEFAULT_TIMEOUT_MS = 120_000;

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
	readonly realpath?: (path: string) => string;
	readonly exec?: (file: string, args: readonly string[], options: { cwd?: string; timeout: number }) => Promise<{ stdout: string; stderr: string }>;
}

function moduleUrlToPath(moduleUrl: string): string {
	return moduleUrl.startsWith("file:") ? fileURLToPath(moduleUrl) : moduleUrl;
}

function packageRootFromModule(moduleUrl: string): string {
	// src/commands/sync.ts -> package root
	return resolve(dirname(moduleUrlToPath(moduleUrl)), "..", "..");
}

function resolveConfigRepo(deps: SumoSyncDeps): string {
	const env = deps.env ?? process.env;
	const homeDir = deps.homeDir ?? homedir();
	const exists = deps.exists ?? existsSync;
	const realpath = deps.realpath ?? realpathSync;
	if (env.SUMOCODE_CONFIG_DIR) return resolve(env.SUMOCODE_CONFIG_DIR);

	const linkedSettings = join(homeDir, ".pi", "agent", "settings.json");
	if (exists(linkedSettings)) {
		try {
			const resolvedSettings = realpath(linkedSettings);
			return resolve(dirname(resolvedSettings), "..");
		} catch {
			// Fall through to conventional locations.
		}
	}

	const candidates = [join(homeDir, "sumocode-config"), join(homeDir, "development", "sumocode-config")];
	return candidates.find((candidate) => exists(join(candidate, "bootstrap.sh"))) ?? candidates[0];
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

export async function executeSumoSync(ctx: ExtensionCommandContext, deps: SumoSyncDeps = {}): Promise<readonly SyncStepResult[]> {
	const configRepo = resolveConfigRepo(deps);
	const sumocodeRepo = resolveSumoCodeRepo(deps);
	const steps: SyncStepResult[] = [];

	ctx.ui.notify("syncing SumoCode config + extensions…", "info");

	const plannedSteps = [
		{ label: "sumocode-config git pull", file: "git", args: ["pull", "--ff-only"] as const, cwd: configRepo },
		{ label: "sumocode source git pull", file: "git", args: ["pull", "--ff-only"] as const, cwd: sumocodeRepo },
		{
			label: "sumocode-config bootstrap",
			file: join(configRepo, "bootstrap.sh"),
			args: [] as const,
			cwd: configRepo,
			timeout: 240_000,
		},
	];

	for (const step of plannedSteps) {
		const result = await runStep(step.label, step.file, step.args, { cwd: step.cwd, timeout: step.timeout }, deps);
		steps.push(result);
		if (!result.ok) break;
	}

	const failed = steps.filter((step) => !step.ok);
	if (failed.length > 0) {
		ctx.ui.notify(`/sumo:sync failed at ${failed[0]?.label}; inspect terminal output`, "warning");
		process.stdout.write(formatSyncResults(steps));
		return steps;
	}

	ctx.ui.notify("SumoCode sync complete — run /sumo:reload if source changed", "info");
	process.stdout.write(formatSyncResults(steps));
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

export function registerSumoSyncCommand(pi: ExtensionAPI, deps: SumoSyncDeps = {}): void {
	pi.registerCommand("sumo:sync", {
		description: "Pull SumoCode config/source, hydrate extensions, and update Pi packages",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await executeSumoSync(ctx, deps);
		},
	});
}
