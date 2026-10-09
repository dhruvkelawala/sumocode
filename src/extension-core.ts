import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withAbortResponsiveTools } from "./abort-responsive-tools.js";
import { installActivityManagerBridge } from "./activity/manager-bridge.js";
import { installAnswerTool } from "./answer-tool.js";
import { buildT3RoleGuidance, hasT3Orchestration } from "./app-host.js";
import { installBackgroundTasks, installTerminalTools } from "./background-tasks/index.js";
import type { TerminalTaskManagerOptions } from "./background-tasks/task-manager.js";
import { loadClaudeSubscriptions, registerAccountsCommand } from "./commands/accounts.js";
import { installClaudeAccountStatus, loginRuntimeWithAccountRefresh, publishClaudeAccountStatus } from "./claude-account-status-publication.js";
import { claudeAccountProviderId } from "./config/claude-providers.js";
import { registerSumoReloadCommand } from "./commands/reload.js";
import { registerRolesCommand } from "./commands/roles.js";
import { installFastMode } from "./fast-mode.js";
import { installHerdrRpcBridge } from "./herdr-rpc-bridge.js";
import { installAppHostInteractions, installSumoInteractions } from "./interaction-registry.js";
import { installMemoryExtraction } from "./memory-extraction.js";
import { installQuestionTool } from "./question-tool.js";
import { installSkillInlineExpansion } from "./skill-inline.js";
import { installSubagents } from "./subagents/index.js";
import { loadRoles } from "./subagents/roles.js";
import { logDiagnostic } from "./sumo-tui/runtime/diagnostics.js";
import { getRpcLoginRuntime, registerRpcLoginCommand } from "./sumo-tui/pi-compat/login-command.js";
import { registerRpcTreeNavigationCommand } from "./sumo-tui/pi-compat/tree-navigation-command.js";
import { installTaskModeAutoExit } from "./task-mode.js";

const PROCESS_INSTALL_LATCH = Symbol.for("sumocode.extension.processInstallLatch");

type LatchScope = { [PROCESS_INSTALL_LATCH]?: WeakSet<object> };

export interface HelperSubprocessGuardOptions {
	readonly env?: NodeJS.ProcessEnv;
}

/** Keep background-terminal helpers from recursively installing SumoCode. */
export function shouldNoopHelperSubprocess(options: HelperSubprocessGuardOptions = {}): boolean {
	return (options.env ?? process.env).SUMOCODE_BG_CHILD === "1";
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

export function installOrchestrationTools(pi: ExtensionAPI, rpcChild = false) {
	// The store owns the scan boundary and measures it with performance.now();
	// the marks are emitted from its index-scan diagnostic so the targeted
	// metric isolates the scan itself (not manager construction or extension
	// wiring) and keeps sub-millisecond resolution.
	const managerOptions: TerminalTaskManagerOptions | undefined = rpcChild
		? {
				// Pi constructs extensions before entering its RPC input loop, so a
				// generic next turn still blocks child readiness. The host creates this
				// private gate only after command readiness; wrappers inherit its path.
				scheduleIndexInitialization: (initialize) => {
					const gate = process.env.SUMOCODE_TERMINAL_INDEX_GATE;
					if (!gate) {
						setImmediate(initialize);
						return;
					}
					const fallbackAt = Date.now() + 30_000;
					const waitForGate = (): void => {
						// A failed host write may delay startup delivery, but it cannot leave
						// the durable index unopened for the process lifetime.
						if (existsSync(gate) || Date.now() >= fallbackAt) {
							initialize();
							return;
						}
						const timer = setTimeout(waitForGate, 10);
						timer.unref?.();
					};
					setImmediate(waitForGate);
				},
				onIndexInitializationStart: () => logDiagnostic("terminal_index_start", {}),
				onDiagnostic: (diagnostic) => {
					// An incomplete scan (transient read failure) is a degraded index:
					// emit no ready mark so the harness fails the sample explicitly.
					if (diagnostic.kind !== "index-scan" || diagnostic.complete !== true) return;
					// snapshotCount lets the harness verify every fixture record was
					// accepted (complete scans still skip corrupt/duplicate records).
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

/**
 * Subscription labels for the Claude account chrome, owned by the accounts
 * config so `/accounts` and the footer cannot disagree. Read once per
 * resolution, never per render.
 */
export function claudeAccountSubscriptionLabel(providerId: string): string | undefined {
	return loadClaudeSubscriptions().find((entry) => claudeAccountProviderId(entry.index) === providerId)?.label;
}

export function installRpcChildProfile(pi: ExtensionAPI): void {
	// Every SumoCode tool registers through this view so an interrupt ends the
	// turn even while a tool is still waiting. See abort-responsive-tools.ts.
	const toolPi = withAbortResponsiveTools(pi);
	installHerdrRpcBridge(pi);
	// The retained host draws the footer, so the resolved account travels as an
	// extension status instead of through installFooter.
	installClaudeAccountStatus(pi, { subscriptionLabel: claudeAccountSubscriptionLabel });
	installSkillInlineExpansion(pi);
	// Pi's built-in /login exists only in InteractiveMode and is intentionally
	// absent from RPC get_commands. Register the compatibility command in the
	// child so the retained host can discover and dispatch it normally.
	// `/login` is its own command with no agent turn behind it either, so the
	// runtime seam repaints the chip as soon as a credential lands.
	registerRpcLoginCommand(pi, {
		getRuntime: (ctx) => loginRuntimeWithAccountRefresh(ctx, getRpcLoginRuntime(ctx), { subscriptionLabel: claudeAccountSubscriptionLabel }),
	});
	registerRpcTreeNavigationCommand(pi);
	installMemoryExtraction(pi);
	installFastMode(pi);
	installQuestionTool(toolPi);
	installAnswerTool(toolPi);
	const { subagentManager } = installOrchestrationTools(toolPi, true);
	installTaskModeAutoExit(pi);
	registerSumoReloadCommand(pi);
	registerRolesCommand(pi);
	// `/accounts` renames a label and returns without an agent turn, so the host
	// footer would keep painting the old one; repaint from the command itself.
	registerAccountsCommand(pi, {
		refreshAccountStatus: (ctx) => publishClaudeAccountStatus(ctx, { subscriptionLabel: claudeAccountSubscriptionLabel }),
	});
	installSumoInteractions(toolPi, {
		subagentManager,
		installUiSurfaces: false,
		refreshAccountStatus: (ctx) => publishClaudeAccountStatus(ctx, { subscriptionLabel: claudeAccountSubscriptionLabel }),
	});
}

/**
 * Profile for apps that drive Pi themselves, such as T3 Code (see
 * app-host.ts). The app owns the screen, so nothing here draws chrome or talks
 * to Herdr. Inside T3 Code, T3's `delegate_task` replaces the `subagent_*`
 * tools, and the role presets travel as delegation guidance instead.
 */
export function installAppHostProfile(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	const toolPi = withAbortResponsiveTools(pi);
	installSkillInlineExpansion(pi);
	installMemoryExtraction(pi);
	installFastMode(pi);
	installQuestionTool(toolPi);
	installAnswerTool(toolPi);
	installTerminalTools(toolPi, installBackgroundTasks(toolPi));
	if (hasT3Orchestration(env)) {
		pi.on("before_agent_start", (event) => ({
			systemPrompt: `${event.systemPrompt}\n\n${buildT3RoleGuidance(loadRoles({ env }).roles)}`,
		}));
	} else {
		installSubagents(toolPi);
	}
	installAppHostInteractions(toolPi);
}
