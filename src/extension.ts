import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadSumoCodeConfig } from "./config/sumocode-config.js";
import { getTheme, setActiveTheme } from "./themes/index.js";
import { installLifecycle } from "./sumo-tui/runtime/lifecycle.js";
import { registerSumoReloadCommand } from "./commands/reload.js";
import { installRenderDiagnostics } from "./render-diagnostics.js";
import { installSessionCache } from "./session-cache.js";

const SUMOCODE_PACKAGE_NAME = "@dhruvkelawala/sumocode";
const LEGACY_TASK_TOOL_EXTENSION_PATH = join(".pi", "agent", "extensions", "task-tool", "index.ts");

type ExistsFn = (path: string) => boolean;
type ReadFileFn = (path: string, encoding: BufferEncoding) => string;

export interface DuplicateInstalledExtensionOptions {
	readonly moduleUrl?: string;
	readonly cwd?: string;
	readonly homeDir?: string;
	readonly exists?: ExistsFn;
	readonly readFile?: ReadFileFn;
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

function replaySessionStartPi(pi: ExtensionAPI, event: unknown, ctx: unknown): ExtensionAPI {
	const originalOn = pi.on.bind(pi) as (name: unknown, handler: (...args: unknown[]) => unknown, ...args: unknown[]) => unknown;
	return {
		...pi,
		on(name: string, handler: (...args: unknown[]) => unknown, ...args: unknown[]): unknown {
			const result = originalOn(name, handler, ...args);
			if (name === "session_start") handler(event, ctx);
			return result;
		},
	} as ExtensionAPI;
}

function installDeferredFeatures(pi: ExtensionAPI): void {
	let installed = false;
	pi.on("session_start", (event, ctx) => {
		if (installed) return;
		installed = true;
		setTimeout(() => installDeferredFeaturesNow(replaySessionStartPi(pi, event, ctx)), 0).unref?.();
	});
}

function installDeferredFeaturesNow(pi: ExtensionAPI): void {
		void import("./memory-extraction.js").then(({ installMemoryExtraction }) => installMemoryExtraction(pi));
		void import("./top-chrome.js").then(({ installTopChrome }) => installTopChrome(pi));
		void import("./splash.js").then(({ installSplash }) => installSplash(pi));
		void import("./footer.js").then(({ installFooter }) => installFooter(pi));
		void import("./cathedral/cathedral-editor.js").then(({ installCathedralEditor }) => installCathedralEditor(pi));
		void import("./cathedral/input-hints.js").then(({ installInputHints }) => installInputHints(pi));
		void import("./working-indicator.js").then(({ installWorkingIndicator }) => installWorkingIndicator(pi));
		void import("./compaction-indicator.js").then(({ installCompactionIndicator }) => installCompactionIndicator(pi));
		void import("./approval-modal.js").then(({ installApprovalGate }) => installApprovalGate(pi));
		void import("./question-tool.js").then(({ installQuestionTool }) => installQuestionTool(pi));
		void import("./answer-tool.js").then(({ installAnswerTool }) => installAnswerTool(pi));
		void import("./interaction-registry.js").then(({ installSumoInteractions }) => installSumoInteractions(pi));
		// The old global `~/.pi/agent/extensions/task-tool` extension registers the
		// same `task` tool name and Pi treats duplicate tools as fatal. Until the
		// user removes/disables that legacy extension, defer to it instead of
		// crashing SumoCode startup. Native task takes over automatically once the
		// legacy wrapper is gone.
		if (shouldInstallNativeTaskTool({ force: process.env.SUMOCODE_NATIVE_TASK })) {
			void import("./native-task-tool.js").then(({ taskTool }) => {
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
			});
		}
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
	if (shouldNoopDuplicateInstalledExtension()) {
		console.warn("[sumocode] Skipping installed SumoCode extension because this session is already inside an active SumoCode dev checkout.");
		return;
	}

	// Restore the persisted runtime theme before installing any UI surfaces so
	// first paint uses the chosen palette. Registry default stays Cathedral for
	// tests and non-runtime module imports; runtime fallback stays Obsidian.
	const configuredThemeName = loadSumoCodeConfig().config.themeName;
	setActiveTheme(configuredThemeName && getTheme(configuredThemeName) ? configuredThemeName : "obsidian");

	// Render diagnostics must install BEFORE any consumer so its `setFooter` /
	// `setHeader` / `setEditorComponent` / `setWidget` wrappers are in place
	// when those modules wire their components. No-op unless `SUMO_TUI_DIAG_FILE`
	// is set (i.e. `sumocode -d`).
	installRenderDiagnostics(pi);
	// Cache must install before any consumer (footer/sidebar/top-chrome) so its
	// invalidation handlers run alongside their state updates on lifecycle events.
	installSessionCache(pi);
	installLifecycle(pi);
	registerSumoReloadCommand(pi);
	installDeferredFeatures(pi);
}
