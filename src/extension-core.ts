import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installActivityManagerBridge } from "./activity/manager-bridge.js";
import { installAnswerTool } from "./answer-tool.js";
import { installBackgroundTasks, installTerminalTools } from "./background-tasks/index.js";
import type { TerminalTaskManagerOptions } from "./background-tasks/task-manager.js";
import { registerAccountsCommand } from "./commands/accounts.js";
import { registerSumoReloadCommand } from "./commands/reload.js";
import { registerRolesCommand } from "./commands/roles.js";
import { installFastMode } from "./fast-mode.js";
import { installHerdrRpcBridge } from "./herdr-rpc-bridge.js";
import { installSumoInteractions } from "./interaction-registry.js";
import { installMemoryExtraction } from "./memory-extraction.js";
import { taskTool } from "./native-task-tool.js";
import { installQuestionTool } from "./question-tool.js";
import { installSkillInlineExpansion } from "./skill-inline.js";
import { installSubagents } from "./subagents/index.js";
import { logDiagnostic } from "./sumo-tui/runtime/diagnostics.js";
import { registerRpcLoginCommand } from "./sumo-tui/pi-compat/login-command.js";
import { registerRpcTreeNavigationCommand } from "./sumo-tui/pi-compat/tree-navigation-command.js";
import { installTaskModeAutoExit } from "./task-mode.js";

const LEGACY_TASK_TOOL_EXTENSION_PATH = join(".pi", "agent", "extensions", "task-tool", "index.ts");
const PROCESS_INSTALL_LATCH = Symbol.for("sumocode.extension.processInstallLatch");

type ExistsFn = (path: string) => boolean;
type LatchScope = { [PROCESS_INSTALL_LATCH]?: WeakSet<object> };

export interface HelperSubprocessGuardOptions {
	readonly env?: NodeJS.ProcessEnv;
}

/** Keep background-terminal helpers from recursively installing SumoCode. */
export function shouldNoopHelperSubprocess(options: HelperSubprocessGuardOptions = {}): boolean {
	return (options.env ?? process.env).SUMOCODE_BG_CHILD === "1";
}

export function hasLegacyTaskToolExtension(options: { readonly homeDir?: string; readonly exists?: ExistsFn } = {}): boolean {
	const exists = options.exists ?? existsSync;
	return exists(join(options.homeDir ?? homedir(), LEGACY_TASK_TOOL_EXTENSION_PATH));
}

export function shouldInstallNativeTaskTool(options: { readonly homeDir?: string; readonly exists?: ExistsFn; readonly force?: string } = {}): boolean {
	if (options.force === "1" || options.force === "true") return true;
	return !hasLegacyTaskToolExtension(options);
}

function globalLatchScope(): LatchScope {
	// SAFETY: LatchScope only adds an optional module-private symbol key to globalThis,
	// which no other module reads or writes under that symbol.
	return globalThis as LatchScope;
}

function processInstallLatch(scope: LatchScope): WeakSet<object> {
	return scope[PROCESS_INSTALL_LATCH] ??= new WeakSet<object>();
}

export function isSumocodeAlreadyInstalledInProcess<T extends object>(runtime: T, scope: LatchScope = globalLatchScope()): boolean {
	return processInstallLatch(scope).has(runtime);
}

export function markSumocodeInstalledInProcess<T extends object>(runtime: T, scope: LatchScope = globalLatchScope()): void {
	processInstallLatch(scope).add(runtime);
}

export function claimSumocodeRuntime<T extends object>(runtime: T): boolean {
	if (!isSumocodeAlreadyInstalledInProcess(runtime)) {
		markSumocodeInstalledInProcess(runtime);
		return true;
	}
	console.warn("[sumocode] Skipping duplicate SumoCode entry: this Pi runtime already installed SumoCode via another entry path.");
	logDiagnostic("extension_activate_skipped_duplicate_process_entry", {});
	return false;
}

/** Test-only: clear the process latch so installation paths can be re-exercised. */
export function resetSumocodeProcessInstallLatchForTests(scope: LatchScope = globalLatchScope()): void {
	delete scope[PROCESS_INSTALL_LATCH];
}

export function installConfiguredNativeTaskTool(pi: ExtensionAPI): void {
	if (!shouldInstallNativeTaskTool({ force: process.env.SUMOCODE_NATIVE_TASK })) return;
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

export function installOrchestrationTools(pi: ExtensionAPI, rpcChild = false) {
	// The store owns the scan boundary and measures it with performance.now();
	// the marks are emitted from its index-scan diagnostic so the targeted
	// metric isolates the scan itself (not manager construction or extension
	// wiring) and keeps sub-millisecond resolution.
	const managerOptions: TerminalTaskManagerOptions | undefined = rpcChild
		? {
				onDiagnostic: (diagnostic) => {
					// An incomplete scan (transient read failure) is a degraded index:
					// emit nothing so the harness observes missing events and fails the
					// sample explicitly instead of timing a partial scan as ready.
					if (diagnostic.kind !== "index-scan" || diagnostic.complete !== true) return;
					// snapshotCount lets the harness verify every fixture record was
					// accepted (complete scans still skip corrupt/duplicate records).
					logDiagnostic("terminal_index_start", {});
					logDiagnostic("terminal_index_ready", { durationMs: diagnostic.durationMs, snapshotCount: diagnostic.snapshotCount });
				},
			}
		: undefined;
	const terminalTaskManager = installBackgroundTasks(pi, managerOptions);
	installTerminalTools(pi, terminalTaskManager);
	const subagentManager = installSubagents(pi);
	const activityBridge = installActivityManagerBridge(pi, terminalTaskManager, subagentManager);
	return { terminalTaskManager, subagentManager, activityBridge };
}

export function installRpcChildProfile(pi: ExtensionAPI): void {
	installHerdrRpcBridge(pi);
	installSkillInlineExpansion(pi);
	// Pi's built-in /login exists only in InteractiveMode and is intentionally
	// absent from RPC get_commands. Register the compatibility command in the
	// child so the retained host can discover and dispatch it normally.
	registerRpcLoginCommand(pi);
	registerRpcTreeNavigationCommand(pi);
	installMemoryExtraction(pi);
	installFastMode(pi);
	installConfiguredNativeTaskTool(pi);
	installQuestionTool(pi);
	installAnswerTool(pi);
	const { subagentManager } = installOrchestrationTools(pi, true);
	installTaskModeAutoExit(pi);
	registerSumoReloadCommand(pi);
	registerRolesCommand(pi);
	registerAccountsCommand(pi);
	installSumoInteractions(pi, { subagentManager });
}
