import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installInputHints } from "./cathedral/input-hints.js";
import { installAnswerTool } from "./answer-tool.js";
import { installApprovalGate } from "./approval-modal.js";
import { installQuestionTool } from "./question-tool.js";
import { taskTool } from "./native-task-tool.js";

import { applyStartupTheme } from "./themes/index.js";
import { installAltscreen } from "./cathedral/altscreen.js";
import { installCathedralEditor } from "./cathedral/cathedral-editor.js";
import { registerSumoReloadCommand } from "./commands/reload.js";
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
import { installBackgroundTasks } from "./background-tasks/index.js";
import { installTaskModeAutoExit } from "./task-mode.js";
import { logDiagnostic } from "./sumo-tui/runtime/diagnostics.js";

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
		const parsed = JSON.parse(readFile(packagePath, "utf8")) as { name?: unknown };
		return typeof parsed.name === "string" ? parsed.name : undefined;
	} catch {
		return undefined;
	}
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
		// NOT noop (an unconditional noop here would skip the RPC child's
		// `installApprovalGate`, silently disabling the approval gate). Compare
		// realpath-canonicalized paths on both sides so symlinks can't fool
		// either direction of this check.
		const realpath = options.realpath ?? ((path: string) => realpathSync(path));
		const modulePath = canonicalize(moduleUrlToPath(moduleUrl), realpath);
		const moduleDir = dirname(modulePath); // strip /src/extension.ts to compare tree roots
		const grandparent = dirname(moduleDir); // .../sumocode/src -> .../sumocode
		const canonicalLauncherRoot = canonicalize(launcherRoot, realpath);
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
 * Bail out of SumoCode installation when we are running inside a Pi helper
 * subprocess. Mirrors `pi-cmux`'s `PI_CMUX_CHILD` pattern — helper spawns
 * (session naming, turn summaries, etc.) launch Pi with `--no-extensions`
 * conceptually but can still inherit our extension via `-e`. Loading the
 * full Cathedral UI inside them wastes startup time and risks recursive
 * tool registration.
 *
 * The same env var is also set by SumoCode's own `bg_task` shell-task
 * wrapper so a user command that invokes `pi`/`sumocode` does not
 * recursively install another SumoCode runtime layer.
 */
export function shouldNoopHelperSubprocess(options: HelperSubprocessGuardOptions = {}): boolean {
	const env = options.env ?? process.env;
	return env.PI_CMUX_CHILD === "1" || env.SUMOCODE_BG_CHILD === "1";
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

function installRpcChildProfile(pi: ExtensionAPI): void {
	installMemoryExtraction(pi);
	installFastMode(pi);
	installApprovalGate(pi);
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
					replace: "\n- task: never run this tool unless it's a skill run or I explictly ask you to",
				},
			],
		})(pi);
	}
	installQuestionTool(pi);
	installAnswerTool(pi);
	const backgroundTaskManager = installBackgroundTasks(pi);
	installTaskModeAutoExit(pi);
	registerSumoReloadCommand(pi);
	installSumoInteractions(pi, { backgroundTaskManager, includeUiSurfaces: false });
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
		// Helper subprocesses (pi-cmux session naming, SumoCode bg_task shell
		// wrappers, etc.) signal themselves via PI_CMUX_CHILD / SUMOCODE_BG_CHILD.
		// Bail before installing anything so they stay lightweight and we don't
		// recursively spawn another SumoCode UI layer.
		return;
	}
	if (shouldNoopDuplicateInstalledExtension()) {
		console.warn("[sumocode] Skipping installed SumoCode extension because this session is already inside an active SumoCode dev checkout.");
		return;
	}

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
	installApprovalGate(pi);
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
					replace: "\n- task: never run this tool unless it's a skill run or I explictly ask you to",
				},
			],
		})(pi);
	}
	installQuestionTool(pi);
	installAnswerTool(pi);
	const backgroundTaskManager = installBackgroundTasks(pi);
	installTaskModeAutoExit(pi);

	installWorkingIndicator(pi);
	installCompactionIndicator(pi);
	registerSumoReloadCommand(pi);
	installSumoInteractions(pi, { backgroundTaskManager });
	logDiagnostic("extension_activate_end", {
		taskMode: isTaskMode(),
		nativeTaskInstalled: shouldInstallNativeTaskTool({ force: process.env.SUMOCODE_NATIVE_TASK }),
		hasBackgroundTasks: backgroundTaskManager !== undefined,
	});
}
