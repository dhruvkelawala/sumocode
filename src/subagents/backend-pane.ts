import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	buildVisibleAgentCommand,
	buildVisibleTaskPaths,
	readExitCodeFromFile,
} from "../background-tasks/visible-spawn.js";
import type {
	AgentPanePlacement,
	PaneRef,
	PiExecLike,
	TerminalHost,
} from "../terminal-host/types.js";
import type { SpawnedChild } from "./backend-pi.js";
import type { SubagentEvent } from "./domain.js";

const RESPONSE_POLL_INTERVAL_MS = 750;
const ERROR_TEXT_MAX = 4096;

interface PaneBackendFs {
	existsSync(path: string): boolean;
	mkdirSync(path: string, options: { recursive: true }): void;
	readFileSync(path: string, encoding: "utf8"): string;
	writeFileSync(path: string, contents: string, options?: { mode?: number }): void;
}

export interface PaneChildOptions {
	prompt: string;
	name: string;
	cwd: string;
	id: string;
	model?: string;
	thinking?: string;
	signal?: AbortSignal;
	host: TerminalHost;
	pi: PiExecLike;
	placement: AgentPanePlacement;
}

export interface PaneBackendDependencies {
	fs?: PaneBackendFs;
	now?: () => number;
	baseDir?: string;
	pollIntervalMs?: number;
}

const nodeFs: PaneBackendFs = {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
};

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const createPaneChildSpawner = (dependencies: PaneBackendDependencies = {}) => (options: PaneChildOptions): SpawnedChild => {
	const fs = dependencies.fs ?? nodeFs;
	const now = dependencies.now ?? Date.now;
	const baseDir = dependencies.baseDir ?? join(process.env.TMPDIR ?? "/tmp", "sumocode-subagents");
	const paths = buildVisibleTaskPaths(options.id, now(), baseDir);
	fs.mkdirSync(dirname(paths.promptFile), { recursive: true });
	fs.writeFileSync(paths.promptFile, options.prompt, { mode: 0o600 });
	fs.writeFileSync(paths.logFile, "");
	const shellCommand = buildVisibleAgentCommand({
		cwd: options.cwd,
		runner: "sumocode",
		paths,
		model: options.model,
		thinking: options.thinking,
	});

	let emitEvent: ((event: SubagentEvent) => void) | undefined;
	let pane: PaneRef | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let interrupted = false;
	let settled = false;

	const clearWatcher = (): void => {
		if (!pollTimer) return;
		clearInterval(pollTimer);
		pollTimer = undefined;
	};

	const settle = (event: Extract<SubagentEvent, { kind: "run-settled" }>): void => {
		if (settled) return;
		settled = true;
		clearWatcher();
		options.signal?.removeEventListener("abort", interrupt);
		emitEvent?.(event);
	};

	const readText = (path: string): string => {
		try {
			return fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
		} catch (error) {
			return `[unable to read ${path}: ${errorText(error)}]`;
		}
	};

	const poll = (): void => {
		if (settled || interrupted || !fs.existsSync(paths.exitFile)) return;
		const marker = readText(paths.exitFile);
		const exitCode = readExitCodeFromFile(marker);
		if (exitCode === null) {
			settle({ kind: "run-settled", outcome: { kind: "failed", errorText: `invalid visible child exit marker: ${marker.trim() || "<empty>"}` } });
			return;
		}
		if (exitCode === 0) {
			settle({ kind: "run-settled", outcome: { kind: "completed", finalText: readText(paths.responseFile) } });
			return;
		}
		const logTail = readText(paths.logFile).slice(-ERROR_TEXT_MAX).trim();
		settle({
			kind: "run-settled",
			outcome: {
				kind: "failed",
				errorText: logTail || `visible child exited with code ${exitCode}`,
				partialText: readText(paths.responseFile) || undefined,
			},
		});
	};

	const closeInterruptedPane = async (): Promise<void> => {
		if (!pane) return;
		try {
			const result = await options.host.closePane(options.pi, pane);
			if (!result.ok) {
				settle({ kind: "run-settled", outcome: { kind: "failed", errorText: `failed to close visible child pane: ${result.error}` } });
				return;
			}
			settle({ kind: "run-settled", outcome: { kind: "interrupted" } });
		} catch (error) {
			settle({ kind: "run-settled", outcome: { kind: "failed", errorText: `failed to close visible child pane: ${errorText(error)}` } });
		}
	};

	function interrupt(): void {
		if (settled || interrupted) return;
		interrupted = true;
		clearWatcher();
		void closeInterruptedPane();
	}

	const events = (emit: (event: SubagentEvent) => void): void => {
		emitEvent = emit;
		emit({ kind: "run-started" });
		void (async () => {
			const startAgentPane = options.host.startAgentPane;
			if (!startAgentPane) {
				settle({ kind: "run-settled", outcome: { kind: "failed", errorText: `terminal host ${options.host.kind} does not support visible agent panes` } });
				return;
			}
			try {
				const result = await startAgentPane.call(options.host, options.pi, {
					name: options.name,
					cwd: options.cwd,
					shellCommand,
					placement: options.placement,
				});
				if (!result.ok) {
					settle({ kind: "run-settled", outcome: { kind: "failed", errorText: result.error } });
					return;
				}
				pane = result.pane;
				emit({
					kind: "pane-attached",
					pane: {
						agentName: result.agentName,
						workspaceId: result.workspaceId,
						tabId: result.tabId,
						paneId: result.paneId,
					},
				});
				if (interrupted) {
					await closeInterruptedPane();
					return;
				}
				pollTimer = setInterval(poll, dependencies.pollIntervalMs ?? RESPONSE_POLL_INTERVAL_MS);
				pollTimer.unref?.();
				poll();
			} catch (error) {
				settle({ kind: "run-settled", outcome: { kind: "failed", errorText: errorText(error) } });
			}
		})();
	};

	if (options.signal?.aborted) interrupted = true;
	else options.signal?.addEventListener("abort", interrupt, { once: true });

	return { events, interrupt };
};

export const spawnPaneChild = createPaneChildSpawner();
