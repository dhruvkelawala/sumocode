import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	buildVisibleAgentCommand,
	buildVisibleTaskPaths,
	readExitCodeFromFile,
	shellEscape,
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
const SEND_ACK_POLL_MS = 250;
const SEND_ACK_TIMEOUT_MS = 5_000;
const CLOSE_REQUEST_FILE = "close.request";
const ERROR_TEXT_MAX = 4096;

interface PaneBackendFs {
	existsSync(path: string): boolean;
	mkdirSync(path: string, options: { recursive: true }): void;
	readFileSync(path: string, encoding: "utf8"): string;
	renameSync(source: string, target: string): void;
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
	readonly tools?: readonly string[];
	readonly appendSystemPrompt?: string;
}

export interface PaneBackendDependencies {
	fs?: PaneBackendFs;
	now?: () => number;
	baseDir?: string;
	pollIntervalMs?: number;
	/** Steer-ack poll interval (design contract: 250ms). */
	sendAckPollMs?: number;
	/** Steer-ack total budget (design contract: 5s). */
	sendAckTimeoutMs?: number;
}

const nodeFs: PaneBackendFs = {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
};

const errorText = <T>(error: T): string => error instanceof Error ? error.message : String(error);

export const createPaneChildSpawner = (dependencies: PaneBackendDependencies = {}) => (options: PaneChildOptions): SpawnedChild => {
	const fs = dependencies.fs ?? nodeFs;
	const now = dependencies.now ?? Date.now;
	const baseDir = dependencies.baseDir ?? join(process.env.TMPDIR ?? "/tmp", "sumocode-subagents");
	const paths = buildVisibleTaskPaths(options.id, now(), baseDir);
	fs.mkdirSync(dirname(paths.promptFile), { recursive: true });
	// The control dir is the steering/close channel shared with the child's
	// task-mode watcher; it must exist before the orchestrator writes to it.
	fs.mkdirSync(paths.controlDir, { recursive: true });
	// Headless children receive a true appended system prompt. The visible task
	// wrapper has no equivalent flag yet, so preserve the role contract as a
	// prompt-file preamble until that wrapper seam is added.
	const prompt = options.appendSystemPrompt
		? `role instructions (follow these for this entire session):\n${options.appendSystemPrompt}\n---\n${options.prompt}`
		: options.prompt;
	fs.writeFileSync(paths.promptFile, prompt, { mode: 0o600 });
	fs.writeFileSync(paths.logFile, "");
	const commandOptions = {
		cwd: options.cwd,
		paths,
		model: options.model,
		thinking: options.thinking,
		tools: options.tools,
	};
	const agentCommand = buildVisibleAgentCommand(commandOptions);
	// Keep stdout attached directly to the pane PTY. Piping combined output
	// through `tee` makes `sumocode` observe non-TTY stdout and select its direct,
	// non-interactive Pi path, leaving the visible herdr pane blank. Redirect
	// stderr directly to the log so startup/crash diagnostics are flushed before
	// the wrapper can publish its exit marker. Task-mode response and exit files
	// remain the authoritative completion evidence.
	//
	// The exit marker is guaranteed by the OUTER wrapper, not just the sumocode
	// child: a cd failure, a hard crash (no marker written), or the user closing
	// the pane (SIGHUP to the pane process group) would otherwise leave the
	// subagent "running" forever while pinning a capacity slot. The traps are
	// first-writer-wins ([ -f ] guard), so the child's own marker — written with
	// its real exit code — always takes precedence; signal traps record
	// conventional 128+N codes, and the EXIT trap records the subshell status.
	// A child process that is alive but stuck is deliberately NOT timed out
	// here: it is legitimately running and subagent_cancel owns that decision.
	const exitGuard = [
		`__sumo_exit_file=${shellEscape(paths.exitFile)}`,
		`__sumo_finish() { [ -f "$__sumo_exit_file" ] || printf '%s' "$1" > "$__sumo_exit_file"; }`,
		`trap '__sumo_finish "$?"' EXIT`,
		`trap '__sumo_finish 129' HUP`,
		`trap '__sumo_finish 143' TERM`,
		`trap '__sumo_finish 130' INT`,
	].join("; ");
	// Keep the supervisor out of terminal input. Long `pane run` payloads can be
	// clipped by the host or shell editor, and they expose task internals in the
	// visible pane. Herdr only receives this short script path.
	const script = [
		"#!/usr/bin/env bash",
		"set -u",
		exitGuard,
		`( ${agentCommand} ) 2>> ${shellEscape(paths.logFile)}`,
	].join("\n");
	fs.writeFileSync(paths.scriptFile, script, { mode: 0o700 });
	const shellCommand = `exec ${shellEscape(paths.scriptFile)}`;

	let emitEvent: ((event: SubagentEvent) => void) | undefined;
	let pane: PaneRef | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let interrupted = false;
	let settled = false;
	let markReady = (): void => undefined;
	const ready = new Promise<void>((resolve) => { markReady = resolve; });

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
		// The producer opens with truncate-before-write. An observed empty file is
		// a transient not-ready state, not evidence of a failed child.
		if (!marker.trim()) return;
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

	let steerSeq = 0;

	/**
	 * Deliver steering text via the task-dir control channel: write
	 * `steer-<seq>.txt.tmp`, rename into place (atomic publish), then wait for
	 * the child's watcher to unlink it — unlink is the ack. Rejects when the
	 * child exits before consuming the file or the ack poll times out (the
	 * file remains and a later-booting child may still consume it).
	 */
	const send = (text: string): Promise<void> => {
		if (settled || interrupted) {
			return Promise.reject(new Error(`visible subagent ${options.id} has settled; input was not delivered`));
		}
		const seq = ++steerSeq;
		const finalPath = join(paths.controlDir, `steer-${seq}.txt`);
		fs.writeFileSync(`${finalPath}.tmp`, text);
		fs.renameSync(`${finalPath}.tmp`, finalPath);
		const ackPollMs = dependencies.sendAckPollMs ?? SEND_ACK_POLL_MS;
		const ackTimeoutMs = dependencies.sendAckTimeoutMs ?? SEND_ACK_TIMEOUT_MS;
		return new Promise<void>((resolve, reject) => {
			let elapsed = 0;
			const ackTimer = setInterval(() => {
				if (!fs.existsSync(finalPath)) {
					clearInterval(ackTimer);
					resolve();
					return;
				}
				if (fs.existsSync(paths.exitFile) && readText(paths.exitFile).trim()) {
					clearInterval(ackTimer);
					reject(new Error(`${options.id} exited before receiving input`));
					return;
				}
				elapsed += ackPollMs;
				if (elapsed >= ackTimeoutMs) {
					clearInterval(ackTimer);
					reject(new Error(`steer input to ${options.id} was not acknowledged within ${ackTimeoutMs}ms — the file remains and the child may still consume it`));
				}
			}, ackPollMs);
			ackTimer.unref?.();
		});
	};

	/** Ask the child's task-mode watcher to persist its response and exit. */
	const requestClose = (): void => {
		fs.writeFileSync(join(paths.controlDir, CLOSE_REQUEST_FILE), "1");
	};

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
		})().finally(markReady);
	};

	if (options.signal?.aborted) interrupted = true;
	else options.signal?.addEventListener("abort", interrupt, { once: true });

	return { events, interrupt, ready, send, requestClose };
};

export const spawnPaneChild = createPaneChildSpawner();
