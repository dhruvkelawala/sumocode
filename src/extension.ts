import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installInputHints } from "./cathedral/input-hints.js";
import { installAnswerTool } from "./answer-tool.js";
import { installQuestionTool } from "./question-tool.js";
import { taskTool } from "./native-task-tool.js";
import { installSkillInlineExpansion } from "./skill-inline.js";

import { applyStartupTheme } from "./themes/index.js";
import { installAltscreen } from "./cathedral/altscreen.js";
import { installCathedralEditor } from "./cathedral/cathedral-editor.js";
import { registerSumoReloadCommand } from "./commands/reload.js";
import { registerRolesCommand } from "./commands/roles.js";
import { installSumoInteractions } from "./interaction-registry.js";
import { installFooter } from "./footer.js";
import { installMemoryExtraction } from "./memory-extraction.js";
import { installRenderDiagnostics } from "./render-diagnostics.js";
import { installSessionCache } from "./session-cache.js";
import { installSplash } from "./splash.js";
import { installTopChrome } from "./top-chrome.js";
import { installWorkingIndicator } from "./working-indicator.js";
import { installCompactionIndicator } from "./compaction-indicator.js";
import { installFastMode } from "./fast-mode.js";
import { installBackgroundTasks, installTerminalTools } from "./background-tasks/index.js";
import { installActivityManagerBridge } from "./activity/manager-bridge.js";
import { installSubagents } from "./subagents/index.js";
import { installTaskModeAutoExit } from "./task-mode.js";
import { logDiagnostic } from "./sumo-tui/runtime/diagnostics.js";
import { registerRpcLoginCommand } from "./sumo-tui/pi-compat/login-command.js";
import { registerAccountsCommand } from "./commands/accounts.js";
import { installHerdrRpcBridge } from "./herdr-rpc-bridge.js";
import { registerRpcTreeNavigationCommand } from "./sumo-tui/pi-compat/tree-navigation-command.js";

const SUMOCODE_PACKAGE_NAME = "@dhruvkelawala/sumocode";
const LEGACY_TASK_TOOL_EXTENSION_PATH = join(".pi", "agent", "extensions", "task-tool", "index.ts");

type ExistsFn = (path: string) => boolean;
type ReadFileFn = (path: string, encoding: BufferEncoding) => string;
type RealpathFn = (path: string) => string;

export interface DuplicateInstalledExtensionOptions {
	readonly moduleUrl?: string;
	readonly cwd?: string;
	readonly homeDir?: string;
	readonly exists?: ExistsFn;
	readonly readFile?: ReadFileFn;
	readonly env?: NodeJS.ProcessEnv;
	readonly realpath?: RealpathFn;
}

/**
 * Resolves a path to its canonical form, following symlinks, so two
 * differently-spelled paths to the same file (e.g. a `~/.pi/agent/git/...`
 * path that is actually a symlink straight back into a dev checkout) compare
 * equal. Falls back to plain `resolve()` when the path does not exist on disk
 * (e.g. in unit tests against a fake filesystem) instead of throwing.
 */
function canonicalize(path: string, realpath: RealpathFn): string {
	try {
		return realpath(path);
	} catch {
		return resolve(path);
	}
}

function moduleUrlToPath(moduleUrl: string): string {
	try {
		return moduleUrl.startsWith("file:") ? fileURLToPath(moduleUrl) : moduleUrl;
	} catch {
		return moduleUrl;
	}
}

export function isInstalledPiAgentGitModule(moduleUrl: string, homeDir = homedir()): boolean {
	const modulePath = resolve(moduleUrlToPath(moduleUrl));
	const agentGitRoot = `${resolve(homeDir, ".pi", "agent", "git")}${sep}`;
	return modulePath.startsWith(agentGitRoot);
}

function packageNameAt(dir: string, exists: ExistsFn, readFile: ReadFileFn): string | undefined {
	const packagePath = join(dir, "package.json");
	if (!exists(packagePath)) return undefined;
	try {
		// SAFETY: JSON.parse boundary decode; only the optional package name is read.
		const parsed = JSON.parse(readFile(packagePath, "utf8")) as { name?: string };
		// SAFETY: name may be any JSON value despite the asserted shape, so it must
		// still prove stringness before use.
		return asOptionalString(parsed.name) ? parsed.name : undefined;
	} catch {
		return undefined;
	}
}

function packageRootFromModulePath(modulePath: string, exists: ExistsFn, readFile: ReadFileFn): string | undefined {
	let current = dirname(modulePath);
	for (let level = 0; level < 5; level += 1) {
		if (packageNameAt(current, exists, readFile) === SUMOCODE_PACKAGE_NAME) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return undefined;
}

export function findActiveSumoDevTree(cwd: string, options: Pick<DuplicateInstalledExtensionOptions, "exists" | "readFile"> = {}): string | undefined {
	const exists = options.exists ?? existsSync;
	const readFile = options.readFile ?? ((path, encoding) => readFileSync(path, encoding));
	let current = resolve(cwd);
	while (true) {
		const isSumocodePackage = packageNameAt(current, exists, readFile) === SUMOCODE_PACKAGE_NAME;
		const hasExtensionSource = exists(join(current, "src", "extension.ts"));
		const hasGitMetadata = exists(join(current, ".git"));
		if (isSumocodePackage && hasExtensionSource && hasGitMetadata) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function shouldNoopDuplicateInstalledExtension(options: DuplicateInstalledExtensionOptions = {}): boolean {
	const moduleUrl = options.moduleUrl ?? import.meta.url;
	if (!isInstalledPiAgentGitModule(moduleUrl, options.homeDir ?? homedir())) return false;
	const env = options.env ?? process.env;
	const launcherRoot = env.SUMOCODE_ROOT_DIR;
	if (launcherRoot) {
		// The sumocode launcher (`bin/sumocode.sh`) always loads its own dev-tree
		// extension via `-e ${ROOT_DIR}/src/extension.ts` and exports
		// SUMOCODE_ROOT_DIR alongside SUMOCODE_LAUNCHER for exactly this check.
		// `~/.pi/agent/git/.../sumocode` can itself be a symlink straight back
		// into that same dev tree (a common local setup), in which case the
		// module path both matches the `.pi/agent/git` prefix test above AND
		// canonicalizes to the launcher's own root — that is the launcher
		// loading itself, not a genuinely separate installed copy, so it must
		// NOT noop (an unconditional noop here would skip the launcher's own RPC
		// child profile). Compare realpath-canonicalized paths on both sides so
		// symlinks can't fool either direction of this check.
		const realpath = options.realpath ?? ((path: string) => realpathSync(path));
		const exists = options.exists ?? existsSync;
		const readFile = options.readFile ?? ((path, encoding) => readFileSync(path, encoding));
		const modulePath = canonicalize(moduleUrlToPath(moduleUrl), realpath);
		const packageRoot = packageRootFromModulePath(modulePath, exists, readFile);
		const canonicalLauncherRoot = canonicalize(launcherRoot, realpath);
		if (packageRoot !== undefined && canonicalize(packageRoot, realpath) === canonicalLauncherRoot) return false;

		// Defensive fallback for an entry whose package metadata cannot be read.
		// Preserve the old <root>/src/extension.ts derivation if the walk above
		// finds nothing.
		const moduleDir = dirname(modulePath);
		const grandparent = dirname(moduleDir);
		if (grandparent === canonicalLauncherRoot) return false;
		return true;
	}
	if (env.SUMOCODE_LAUNCHER) return true;
	return findActiveSumoDevTree(options.cwd ?? process.cwd(), options) !== undefined;
}

export function hasLegacyTaskToolExtension(options: Pick<DuplicateInstalledExtensionOptions, "homeDir" | "exists"> = {}): boolean {
	const exists = options.exists ?? existsSync;
	return exists(join(options.homeDir ?? homedir(), LEGACY_TASK_TOOL_EXTENSION_PATH));
}

export function shouldInstallNativeTaskTool(options: Pick<DuplicateInstalledExtensionOptions, "homeDir" | "exists"> & { force?: string } = {}): boolean {
	if (options.force === "1" || options.force === "true") return true;
	return !hasLegacyTaskToolExtension(options);
}

export interface HelperSubprocessGuardOptions {
	readonly env?: NodeJS.ProcessEnv;
}

/**
 * Bail out of SumoCode installation when a background-terminal shell wrapper
 * launches a helper process that could otherwise inherit the extension via
 * `-e`. Loading the full Cathedral UI inside it wastes startup time and risks
 * recursive tool registration.
 */
export function shouldNoopHelperSubprocess(options: HelperSubprocessGuardOptions = {}): boolean {
	const env = options.env ?? process.env;
	return env.SUMOCODE_BG_CHILD === "1";
}

export interface TaskModeOptions {
	readonly env?: NodeJS.ProcessEnv;
}

/**
 * SumoCode runs in "task mode" when launched as `sumocode task "<prompt>"`.
 *
 * In that mode the session is a hand-off from an orchestrator: Pi receives
 * the prompt as a kickoff user message and starts the agent turn immediately.
 * We skip the splash screen and any other UI that would either delay or
 * intercept that kickoff (e.g. splash captures stdin briefly, which queues
 * the kickoff into a steering buffer instead of firing the first turn).
 *
 * The wrapper script `bin/sumocode.sh` sets `SUMOCODE_TASK_MODE=1` for the
 * task subcommand. Everything else (footer, top chrome, working indicator,
 * editor) stays installed — task panes are still full SumoCode sessions,
 * just without the welcome surface.
 */
export function isTaskMode(options: TaskModeOptions = {}): boolean {
	const env = options.env ?? process.env;
	return env.SUMOCODE_TASK_MODE === "1";
}

export function isRpcChildProfile(options: TaskModeOptions = {}): boolean {
	const env = options.env ?? process.env;
	return env.SUMOCODE_RPC_CHILD === "1";
}

function installOrchestrationTools(pi: ExtensionAPI) {
	logDiagnostic("terminal_index_start", { surface: "rpc_child" });
	const terminalTaskManager = installBackgroundTasks(pi);
	logDiagnostic("terminal_index_ready", { surface: "rpc_child" });
	installTerminalTools(pi, terminalTaskManager);
	const subagentManager = installSubagents(pi);
	const activityBridge = installActivityManagerBridge(pi, terminalTaskManager, subagentManager);
	return { terminalTaskManager, subagentManager, activityBridge };
}

function installRpcChildProfile(pi: ExtensionAPI): void {
	installHerdrRpcBridge(pi);
	installSkillInlineExpansion(pi);
	// Pi's built-in /login exists only in InteractiveMode and is intentionally
	// absent from RPC get_commands. Register the compatibility command in the
	// child so the retained host can discover and dispatch it normally.
	registerRpcLoginCommand(pi);
	registerRpcTreeNavigationCommand(pi);
	installMemoryExtraction(pi);
	installFastMode(pi);
	if (shouldInstallNativeTaskTool({ force: process.env.SUMOCODE_NATIVE_TASK })) {
		taskTool({
			name: "task",
			label: "Task",
			description: [
				"Run isolated pi subprocess tasks (single, chain, or parallel).",
				"Optional model override (provider/modelId).",
			].join(" "),
			maxParallelTasks: 8,
			maxConcurrency: 4,
			collapsedItemCount: 10,
			skillListLimit: 30,
			systemPromptPatches: [
				{
					match: /\n\s*\n\s*in addition to the tools above, you may have access to other custom tools depending on the project\./i,
					replace: "\n- task: only for skill runs. For delegation use subagent_spawn; for background commands use terminal_start.",
				},
			],
		})(pi);
	}
	installQuestionTool(pi);
	installAnswerTool(pi);
	const { subagentManager } = installOrchestrationTools(pi);
	installTaskModeAutoExit(pi);
	registerSumoReloadCommand(pi);
	registerRolesCommand(pi);
	registerAccountsCommand(pi);
	installSumoInteractions(pi, { subagentManager, includeUiSurfaces: false });
}

const PROCESS_INSTALL_LATCH = Symbol.for("sumocode.extension.processInstallLatch");

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON boundary decode helper; the predicate itself is the parse
const asOptionalString = (value: unknown): value is string => typeof value === "string";

type LatchScope = { [PROCESS_INSTALL_LATCH]?: WeakSet<object> };

function globalLatchScope(): LatchScope {
	// SAFETY: LatchScope only adds an optional module-private symbol key to globalThis,
	// which no other module reads or writes under that symbol.
	return globalThis as LatchScope;
}

function processInstallLatch(scope: LatchScope): WeakSet<object> {
	return scope[PROCESS_INSTALL_LATCH] ??= new WeakSet<object>();
}

/** See the duplicate-process-entry comment in `sumocode()` for why this exists. */
export function isSumocodeAlreadyInstalledInProcess<T extends object>(runtime: T, scope: LatchScope = globalLatchScope()): boolean {
	return processInstallLatch(scope).has(runtime);
}

export function markSumocodeInstalledInProcess<T extends object>(runtime: T, scope: LatchScope = globalLatchScope()): void {
	processInstallLatch(scope).add(runtime);
}

/** Test-only: clear the process latch so installation paths can be re-exercised. */
export function resetSumocodeProcessInstallLatchForTests(scope: LatchScope = globalLatchScope()): void {
	delete scope[PROCESS_INSTALL_LATCH];
}

/**
 * SumoCode — cathedral-themed Pi extension entry point.
 *
 * Element 2 (top chrome) replaces the previous tab-bar. The splash and
 * subsequent elements continue to install as separate modules.
 *
 * Slash commands and shortcuts are installed through `installSumoInteractions`
 * so ownership and startup conflict diagnostics have one registry seam.
 */
export default function sumocode(pi: ExtensionAPI): void {
	logDiagnostic("extension_activate_begin", {
		taskMode: isTaskMode(),
		sumoTui: process.env.SUMO_TUI ?? null,
		launcher: process.env.SUMOCODE_LAUNCHER ?? null,
	});
	if (shouldNoopHelperSubprocess()) {
		// Background-terminal shell wrappers signal helper subprocesses via
		// SUMOCODE_BG_CHILD. Bail before installing anything so they stay
		// lightweight and do not recursively spawn another SumoCode UI layer.
		return;
	}
	if (shouldNoopDuplicateInstalledExtension()) {
		console.warn("[sumocode] Skipping installed SumoCode extension because this session is already inside an active SumoCode dev checkout.");
		return;
	}
	if (isSumocodeAlreadyInstalledInProcess(pi)) {
		// The same SumoCode tree can reach one Pi runtime through several entry
		// paths at once — launcher shim, installed package, and npm-link global.
		// Distinct bundle/source modules share this Symbol.for-backed WeakSet, so
		// the first entry wins for one ExtensionAPI object. Pi intentionally
		// creates a NEW ExtensionAPI when /new, /resume, or /fork recreates
		// extension factories; that identity must install again rather than being
		// blocked by a permanent process boolean.
		console.warn("[sumocode] Skipping duplicate SumoCode entry: this Pi runtime already installed SumoCode via another entry path.");
		logDiagnostic("extension_activate_skipped_duplicate_process_entry", {});
		return;
	}
	markSumocodeInstalledInProcess(pi);

	// Restore the persisted runtime theme before installing any UI surfaces so
	// first paint uses the chosen palette. Registry default stays Cathedral for
	// tests and non-runtime module imports; runtime fallback stays Obsidian.
	// Shared with the RPC host boot path (sumo-tui/rpc/host.ts) via
	// applyStartupTheme so both processes resolve the same theme the same way.
	applyStartupTheme();

	if (isRpcChildProfile()) {
		installRpcChildProfile(pi);
		logDiagnostic("extension_activate_end", {
			profile: "rpc-child",
			nativeTaskInstalled: shouldInstallNativeTaskTool({ force: process.env.SUMOCODE_NATIVE_TASK }),
		});
		return;
	}

	// Render diagnostics must install BEFORE any consumer so its `setFooter` /
	// `setHeader` / `setEditorComponent` / `setWidget` wrappers are in place
	// when those modules wire their components. No-op unless `SUMO_TUI_DIAG_FILE`
	// is set (i.e. `sumocode -d`).
	installRenderDiagnostics(pi);
	// Cache must install before any consumer (footer/sidebar/top-chrome) so its
	// invalidation handlers run alongside their state updates on lifecycle events.
	installSessionCache(pi);
	installAltscreen(pi);
	installTopChrome(pi);
	if (!isTaskMode()) {
		// Splash intercepts the boot sequence and can queue Pi's kickoff prompt
		// into a steering buffer instead of firing the first turn. In task mode
		// we're explicitly handing off a prompt, so skip the splash so the
		// agent turn starts immediately.
		installSplash(pi);
	}
	let requestFooterRender: (() => void) | undefined;
	const fastModeState = installFastMode(pi, { onChange: () => requestFooterRender?.() });
	requestFooterRender = installFooter(pi, { fastModeState });
	installMemoryExtraction(pi);
	installCathedralEditor(pi);
	installInputHints(pi);
	installSkillInlineExpansion(pi);
	// The old global `~/.pi/agent/extensions/task-tool` extension registers the
	// same `task` tool name and Pi treats duplicate tools as fatal. Until the
	// user removes/disables that legacy extension, defer to it instead of
	// crashing SumoCode startup. Native task takes over automatically once the
	// legacy wrapper is gone.
	if (shouldInstallNativeTaskTool({ force: process.env.SUMOCODE_NATIVE_TASK })) {
		taskTool({
			name: "task",
			label: "Task",
			description: [
				"Run isolated pi subprocess tasks (single, chain, or parallel).",
				"Optional model override (provider/modelId).",
			].join(" "),
			maxParallelTasks: 8,
			maxConcurrency: 4,
			collapsedItemCount: 10,
			skillListLimit: 30,
			systemPromptPatches: [
				{
					match: /\n\s*\n\s*in addition to the tools above, you may have access to other custom tools depending on the project\./i,
					replace: "\n- task: only for skill runs. For delegation use subagent_spawn; for background commands use terminal_start.",
				},
			],
		})(pi);
	}
	installQuestionTool(pi);
	installAnswerTool(pi);
	const { terminalTaskManager, subagentManager } = installOrchestrationTools(pi);
	installTaskModeAutoExit(pi);

	installWorkingIndicator(pi);
	installCompactionIndicator(pi);
	registerSumoReloadCommand(pi);
	registerRolesCommand(pi);
	registerAccountsCommand(pi);
	installSumoInteractions(pi, { subagentManager });
	logDiagnostic("extension_activate_end", {
		taskMode: isTaskMode(),
		nativeTaskInstalled: shouldInstallNativeTaskTool({ force: process.env.SUMOCODE_NATIVE_TASK }),
		hasBackgroundTasks: terminalTaskManager !== undefined,
		hasSubagents: subagentManager !== undefined,
	});
}
