import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type {
	AgentPanePlacement,
	PaneRef,
	PiExecLike,
	TerminalHost,
} from "../terminal-host/types.js";
import {
	buildVisibleAgentCommand,
	readExitCodeFromFile,
	shellEscape,
	visibleTaskPathsInDir,
} from "../background-tasks/visible-spawn.js";
import {
	assertPrivateArtifact,
	assertPrivateDir,
	isErrnoCode,
	type PrivateArtifactFs,
	nodeArtifactFs,
	validatedArtifactStat,
	PRIVATE_DIR_MODE,
	PRIVATE_FILE_MODE,
} from "../private-artifact.js";
import type { SpawnedChild } from "./backend-pi.js";
import type { SubagentEvent } from "./domain.js";

const RESPONSE_POLL_INTERVAL_MS = 750;
const SEND_ACK_POLL_MS = 250;
// Generous on purpose: consumption cannot be observed until the child's
// extension runtime has finished loading, which on a cold child takes seconds.
// A tight budget reports an ambiguous pending control as a failure.
const SEND_ACK_TIMEOUT_MS = 30_000;
/** Task and control dirs hold prompt/steer text; keep them owner-only. */
const CLOSE_REQUEST_FILE = "close.request";
const ERROR_TEXT_MAX = 4096;

interface PaneBackendFs extends PrivateArtifactFs {
	existsSync(path: string): boolean;
	mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void;
	readFileSync(path: string, encoding: "utf8"): string;
	renameSync(source: string, target: string): void;
	writeFileSync(path: string, contents: string, options?: { mode?: number; flag?: string }): void;
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
	/** Steer-consumption poll interval (design contract: 250ms). */
	sendAckPollMs?: number;
	/** Steer-consumption acknowledgement budget. */
	sendAckTimeoutMs?: number;
}

const nodeFs: PaneBackendFs = {
	...nodeArtifactFs,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
};

const errorText = <T>(error: T): string => error instanceof Error ? error.message : String(error);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- boundary predicate: fs rejections arrive as `unknown` from catch clauses; isRecord is the sanctioned parse before the errno check.
const isEexist = (error: unknown): boolean => isErrnoCode(error, "EEXIST");

/** Exclusive, no-follow creation for a new owner-only artifact. */
const writeNewPrivateFile = (fs: PaneBackendFs, path: string, contents: string): void => {
	fs.writeFileSync(path, contents, { mode: PRIVATE_FILE_MODE, flag: "wx" });
};

/**
 * Allocate this child's private task directory and return its canonical
 * spelling. Creation is exclusive, so a pre-existing entry at the predicted
 * `id-timestamp` path — including an adversarial symlink — fails closed
 * instead of sharing or redirecting the task directory.
 */
const allocatePrivateTaskDir = (fs: PaneBackendFs, root: string, name: string): string => {
	const dir = resolve(join(root, name));
	fs.mkdirSync(root, { recursive: true, mode: PRIVATE_DIR_MODE });
	assertPrivateDir(fs, root, "visible-subagent task root directory");
	try {
		fs.mkdirSync(dir, { mode: PRIVATE_DIR_MODE });
	} catch (error) {
		if (isEexist(error)) {
			throw new Error(`refusing to reuse an existing visible-subagent task directory: ${dir}`);
		}
		throw error;
	}
	assertPrivateDir(fs, dir, "visible-subagent task directory");
	return dir;
};

export const createPaneChildSpawner = (dependencies: PaneBackendDependencies = {}) => (options: PaneChildOptions): SpawnedChild => {
	const fs = dependencies.fs ?? nodeFs;
	const now = dependencies.now ?? Date.now;
	const baseDir = resolve(dependencies.baseDir ?? join(process.env.TMPDIR ?? "/tmp", "sumocode-subagents"));
	// Owner-only allocation with an exclusive create: the task dir carries the
	// prompt and every steering message, and a pre-existing or symlinked path
	// must fail closed rather than be reused.
	const taskDir = allocatePrivateTaskDir(fs, baseDir, `${options.id}-${now()}`);
	const paths = visibleTaskPathsInDir(taskDir);
	// Owner-only: these directories carry the prompt and every steering message,
	// which routinely contain source snippets. Default /tmp modes (0755) would
	// expose them to other local users, and a timed-out send deliberately leaves
	// its steer file behind.
	fs.mkdirSync(paths.controlDir, { recursive: true, mode: PRIVATE_DIR_MODE });
	assertPrivateDir(fs, paths.controlDir, "visible-subagent control directory");
	// The control dir is the steering/close channel shared with the child's
	// task-mode watcher; it must exist before the orchestrator writes to it.
	// Headless children receive a true appended system prompt. The visible task
	// wrapper has no equivalent flag yet, so preserve the role contract as a
	// prompt-file preamble until that wrapper seam is added.
	const prompt = options.appendSystemPrompt
		? `role instructions (follow these for this entire session):\n${options.appendSystemPrompt}\n---\n${options.prompt}`
		: options.prompt;
	// Exclusive, no-follow creation (`wx`): an entry planted at an artifact path
	// fails closed instead of being followed or clobbered.
	writeNewPrivateFile(fs, paths.promptFile, prompt);
	writeNewPrivateFile(fs, paths.logFile, "");
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
		// The marker subshell writes owner-only so the parent's private-artifact
		// validation accepts it; the agent process itself keeps the user's umask.
		`__sumo_finish() { [ -f "$__sumo_exit_file" ] || ( umask 077; printf '%s' "$1" > "$__sumo_exit_file" ); }`,
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
	fs.writeFileSync(paths.scriptFile, script, { mode: 0o700, flag: "wx" });
	const shellCommand = `exec ${shellEscape(paths.scriptFile)}`;

	let emitEvent: ((event: SubagentEvent) => void) | undefined;
	let pane: PaneRef | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let interrupted = false;
	let settled = false;
	let steerSeq = 0;
	let markReady = (): void => undefined;
	const ready = new Promise<void>((resolve) => { markReady = resolve; });
	const pendingSteeringAcks = new Map<string, {
		readonly timer: ReturnType<typeof setInterval>;
		readonly resolve: () => void;
		readonly reject: (error: Error) => void;
	}>();

	const clearWatcher = (): void => {
		if (!pollTimer) return;
		clearInterval(pollTimer);
		pollTimer = undefined;
	};

	const steeringSettlementError = (): Error => new Error(
		`visible subagent ${options.id} has settled before steering consumption was acknowledged`,
	);

	const finishPendingSteeringAck = (path: string, error?: Error): void => {
		const pending = pendingSteeringAcks.get(path);
		if (!pending) return;
		pendingSteeringAcks.delete(path);
		clearInterval(pending.timer);
		if (error) pending.reject(error);
		else pending.resolve();
	};

	// Settlement and interrupt honor the consumption boundary: an absent control
	// file proves the child watcher consumed it and synchronously submitted to
	// Pi, so that waiter resolves even when settlement wins the race against the
	// next ack tick. Only controls still on disk are ambiguous and rejected with
	// the settled error shape. finishPendingSteeringAck keeps exactly-once
	// timer/map cleanup for both outcomes.
	const settlePendingSteeringAcks = (): void => {
		for (const path of pendingSteeringAcks.keys()) {
			finishPendingSteeringAck(path, fs.existsSync(path) ? steeringSettlementError() : undefined);
		}
	};

	const settle = (event: Extract<SubagentEvent, { kind: "run-settled" }>): void => {
		if (settled) return;
		settled = true;
		clearWatcher();
		settlePendingSteeringAcks();
		options.signal?.removeEventListener("abort", interrupt);
		emitEvent?.(event);
	};

	const readText = (path: string, label: string): string => {
		try {
			if (!fs.existsSync(path)) return "";
			// Child-produced evidence (exit marker, response, log) is only trusted
			// when it is still a private regular artifact of this task dir; a
			// replaced or redirected path fails closed into the error marker below.
			assertPrivateArtifact(fs, path, taskDir, label);
			return fs.readFileSync(path, "utf8");
		} catch (error) {
			return `[unable to read ${path}: ${errorText(error)}]`;
		}
	};

	const poll = (): void => {
		if (settled || interrupted || !fs.existsSync(paths.exitFile)) return;
		const marker = readText(paths.exitFile, "exit marker");
		// The producer opens with truncate-before-write. An observed empty file is
		// a transient not-ready state, not evidence of a failed child.
		if (!marker.trim()) return;
		const exitCode = readExitCodeFromFile(marker);
		if (exitCode === null) {
			settle({ kind: "run-settled", outcome: { kind: "failed", errorText: `invalid visible child exit marker: ${marker.trim() || "<empty>"}` } });
			return;
		}
		if (exitCode === 0) {
			// An absent response is a legitimate empty completion; a replaced
			// (non-private) response artifact must not pass as a normal result.
			try {
				const stat = validatedArtifactStat(fs, paths.responseFile, taskDir, "visible-subagent response artifact");
				const finalText = stat ? fs.readFileSync(paths.responseFile, "utf8") : "";
				settle({ kind: "run-settled", outcome: { kind: "completed", finalText } });
			} catch (error) {
				settle({ kind: "run-settled", outcome: { kind: "failed", errorText: `visible-subagent response artifact refused: ${errorText(error)}` } });
			}
			return;
		}
		const logTail = readText(paths.logFile, "output log").slice(-ERROR_TEXT_MAX).trim();
		// A replaced response artifact is not the child's partial answer: only a
		// still-private response is surfaced as partial text.
		let partialText: string | undefined;
		try {
			const stat = validatedArtifactStat(fs, paths.responseFile, taskDir, "visible-subagent response artifact");
			partialText = stat ? fs.readFileSync(paths.responseFile, "utf8") || undefined : undefined;
		} catch {
			partialText = undefined;
		}
		settle({
			kind: "run-settled",
			outcome: {
				kind: "failed",
				errorText: logTail || `visible child exited with code ${exitCode}`,
				partialText,
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
		// Cancellation starts settlement asynchronously through pane close. Parent
		// senders must stop waiting now rather than lingering until their timeout:
		// consumed controls resolve, controls still on disk reject.
		settlePendingSteeringAcks();
		void closeInterruptedPane();
	}

	/**
	 * Publish steering text through the task-dir control channel, then wait for
	 * the child watcher to remove the file. Removal proves only that the watcher
	 * consumed the control and synchronously called Pi's void sendUserMessage API;
	 * Pi exposes no post-acceptance acknowledgement to extensions.
	 *
	 * A timeout preserves the file because ownership is ambiguous and retrying
	 * could duplicate steering that Pi already owns.
	 */
	const send = (text: string): Promise<void> => {
		if (settled || interrupted) return Promise.reject(steeringSettlementError());
		const seq = ++steerSeq;
		const finalPath = join(paths.controlDir, `steer-${seq}.txt`);
		// 0600 on the temp file: rename preserves the mode, so the published file
		// is never briefly world-readable. Exclusive create keeps a planted entry
		// from being followed or overwritten.
		writeNewPrivateFile(fs, `${finalPath}.tmp`, text);
		fs.renameSync(`${finalPath}.tmp`, finalPath);
		const ackPollMs = dependencies.sendAckPollMs ?? SEND_ACK_POLL_MS;
		const ackTimeoutMs = dependencies.sendAckTimeoutMs ?? SEND_ACK_TIMEOUT_MS;
		return new Promise<void>((resolve, reject) => {
			let elapsed = 0;
			const ackTimer = setInterval(() => {
				if (!fs.existsSync(finalPath)) {
					finishPendingSteeringAck(finalPath);
					return;
				}
				// The budget advances on EVERY tick, before any branch: poll() can hit
				// the producer's truncate-before-write window and re-read the exit
				// marker as empty, returning without settling. A budget that only grew
				// on the fallback branch would then never fire and the waiter would
				// hang past its acknowledgement timeout.
				elapsed += ackPollMs;
				if (fs.existsSync(paths.exitFile) && readText(paths.exitFile, "exit marker").trim()) {
					// Reuse the normal settlement path so every concurrent waiter and the
					// response watcher are cleaned up exactly once.
					poll();
				}
				// Guard on map presence: if poll() settled, this waiter was already
				// finished exactly once with the child-settled error.
				if (elapsed >= ackTimeoutMs && pendingSteeringAcks.has(finalPath)) {
					finishPendingSteeringAck(
						finalPath,
						new Error(`steering consumption was not acknowledged within ${ackTimeoutMs}ms for ${options.id} — the file remains and the child may still consume it`),
					);
				}
			}, ackPollMs);
			pendingSteeringAcks.set(finalPath, { timer: ackTimer, resolve, reject });
			ackTimer.unref?.();
		});
	};

	/** Ask the child's task-mode watcher to persist its response and exit. */
	const requestClose = (): void => {
		try {
			writeNewPrivateFile(fs, join(paths.controlDir, CLOSE_REQUEST_FILE), "1");
		} catch (error) {
			// A repeat close request for an unconsumed control is idempotent, not an
			// error: the request is already published. Anything else propagates.
			if (!isEexist(error)) throw error;
		}
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
