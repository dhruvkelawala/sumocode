import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { systemProcessTree, type ProcessTreeOperations, type ProcessTreeIdentity, type ProcessTreeVerification } from "../background-tasks/process-tree.js";
import type {
	AgentPanePlacement,
	PaneRef,
	PiExecLike,
	TerminalHost,
	StartedAgentPane,
} from "../terminal-host/types.js";
import {
	buildVisibleAgentCommand,
	readExitCodeFromFile,
	shellEscape,
	visibleTaskPathsInDir,
} from "../background-tasks/visible-spawn.js";
import { resolveExecutableProvenance } from "../executable-provenance.js";
import {
	assertPrivateArtifact,
	assertPrivateDir,
	isErrnoCode,
	isOwnedByUs,
	type PrivateArtifactFs,
	nodeArtifactFs,
	validatedArtifactStat,
	PRIVATE_DIR_MODE,
	PRIVATE_FILE_MODE,
	PRIVATE_RESPONSE_MAX_BYTES,
} from "../private-artifact.js";
import type { SpawnedChild } from "./backend-pi.js";
import type { SubagentEvent, SubagentLaunchFailure } from "./domain.js";

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
	chmodSync(path: string, mode: number): void;
	mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void;
	readFileSync(path: string, encoding: "utf8"): string;
	realpathSync(path: string): string;
	renameSync(source: string, target: string): void;
	writeFileSync(path: string, contents: string, options?: { mode?: number; flag?: string }): void;
}

export interface VisibleLaunchEvidence {
	readonly taskDir: string;
	readonly nonce: string;
	readonly process: { readonly identity: ProcessTreeIdentity; readonly verification: ProcessTreeVerification };
	readonly pane: StartedAgentPane;
}

/** Durable launch/effect fences; the owner keeps the handle even if ready rejects. */
export interface VisibleLaunchGate {
	/** Persist starting, task path and supervisor/lease authority before pane creation. */
	beforeSpawn(launch: { readonly taskDir: string; readonly nonce: string }): void;
	/** Persist wrapper tree + pane references while the launcher is still held. */
	wrapperBorn(evidence: VisibleLaunchEvidence): void | Promise<void>;
	/** Complete original-tree cleanup before publishing settlement. */
	cleanup?(beforeEffect?: () => void): Promise<void>;
	/** Recheck durable authority after OS inspection, immediately before release. */
	beforeRelease(): void;
	/** Recheck persistence-owner authority at each effect/ack boundary, not user authorization. */
	beforeEffect(): void;
	/** Record lost/ambiguous ownership without claiming child death or retrying. */
	onRefused(failure?: SubagentLaunchFailure): void;
	/** Retained owner owns verified cancellation; pane IDs never authorize a signal. */
	interrupt(): void;
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
	/** Remaining shared manager budget after visible-placement reservation. */
	provisioningTimeoutMs?: number;
	readonly tools?: readonly string[];
	readonly appendSystemPrompt?: string;
	readonly launchGate?: VisibleLaunchGate;
	/** Existing private directory bound to the retained starting record. */
	readonly retainedTaskDir?: string;
}

export interface PaneBackendDependencies {
	fs?: PaneBackendFs;
	now?: () => number;
	env?: NodeJS.ProcessEnv;
	baseDir?: string;
	pollIntervalMs?: number;
	/** Steer-consumption poll interval (design contract: 250ms). */
	sendAckPollMs?: number;
	/** Steer-consumption acknowledgement budget. */
	sendAckTimeoutMs?: number;
	resolveLauncher?: () => string;
	processTree?: ProcessTreeOperations;
}

const nodeFs: PaneBackendFs = {
	...nodeArtifactFs,
	existsSync,
	chmodSync: chmodSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync,
};

const errorText = <T>(error: T): string => error instanceof Error ? error.message : String(error);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- boundary predicate: fs rejections arrive as `unknown` from catch clauses; isErrnoCode is the sanctioned parse before the errno check.
const isEexist = (error: unknown): boolean => isErrnoCode(error, "EEXIST");

/** Exclusive, no-follow creation for a new owner-only artifact. */
const writeNewPrivateFile = (fs: PaneBackendFs, path: string, contents: string): void => {
	fs.writeFileSync(path, contents, { mode: PRIVATE_FILE_MODE, flag: "wx" });
};

/**
 * Allocate this child's private task directory and return its absolute
 * spelling. Creation is exclusive, so a pre-existing entry at the predicted
 * `id-timestamp` path — including an adversarial symlink — fails closed
 * instead of sharing or redirecting the task directory.
 */
const allocatePrivateTaskDir = (fs: PaneBackendFs, root: string, name: string): string => {
	const dir = resolve(join(root, name));
	fs.mkdirSync(root, { recursive: true, mode: PRIVATE_DIR_MODE });
	// Older builds could leave the shared root at a wider mode (recursive mkdir
	// never re-modes an existing directory). Tighten an owned real directory so
	// the upgrade does not brick every spawn; symlinked or foreign roots are
	// left untouched and still fail closed in the validation below. Ownership is
	// checked first: running as root must never chmod another user's directory.
	const rootStat = fs.lstatSync(root);
	if (rootStat.isDirectory() && isOwnedByUs(rootStat)) {
		fs.chmodSync(root, PRIVATE_DIR_MODE);
	}
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
	const provisioningExpiresAt = options.provisioningTimeoutMs === undefined
		? undefined
		: Date.now() + Math.max(0, options.provisioningTimeoutMs);
	const fs = dependencies.fs ?? nodeFs;
	const now = dependencies.now ?? Date.now;
	const baseDir = resolve(dependencies.baseDir ?? join(process.env.TMPDIR ?? "/tmp", "sumocode-subagents"));
	// Owner-only allocation with an exclusive create: the task dir carries the
	// prompt and every steering message, and a pre-existing or symlinked path
	// must fail closed rather than be reused.
	if (options.retainedTaskDir && !options.launchGate) throw new Error("retained task directory requires an owner");
	const allocatedDir = options.retainedTaskDir ?? allocatePrivateTaskDir(fs, baseDir, `${options.id}-${now()}`);
	assertPrivateDir(fs, allocatedDir, "visible-subagent task directory");
	// Registry paths must have their real spelling (not macOS's /tmp alias).
	const taskDir = options.launchGate ? fs.realpathSync(allocatedDir) : allocatedDir;
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
	const provenance = resolveExecutableProvenance({ env: dependencies.env });
	const commandOptions = {
		cwd: options.cwd,
		paths,
		launcher: (dependencies.resolveLauncher ?? (() => provenance.sumocode))(),
		piBin: (dependencies.env ?? process.env).PI_BIN?.trim() ? provenance.pi : undefined,
		model: options.model,
		thinking: options.thinking,
		tools: options.tools,
	};
	const gate = options.launchGate;
	if (gate && (!isAbsolute(commandOptions.launcher) || !["darwin", "linux"].includes(process.platform))) {
		throw new Error("visible launch gate requires absolute SumoCode provenance and a POSIX wrapper");
	}
	const nonce = gate ? randomUUID() : "";
	const bornFile = join(taskDir, "launch.born");
	const releaseFile = join(taskDir, "launch.release");
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
		// noclobber makes the redirection exclusive (O_EXCL), so a dangling
		// symlink planted at the marker path is never followed.
		`__sumo_finish() { [ -f "$__sumo_exit_file" ] || ( umask 077; set -C; printf '%s' "$1" > "$__sumo_exit_file" ) 2> /dev/null || :; }`,
		`trap '__sumo_finish "$?"' EXIT`,
		`trap '__sumo_finish 129' HUP`,
		`trap '__sumo_finish 143' TERM`,
		`trap '__sumo_finish 130' INT`,
	].join("; ");
	// Keep the supervisor out of terminal input. Long `pane run` payloads can be
	// clipped by the host or shell editor, and they expose task internals in the
	// visible pane. Herdr only receives this short script path.
	const script = [
		gate ? "#!/bin/bash" : "#!/usr/bin/env bash",
		"set -u",
		...(gate ? visibleWrapperGate(taskDir, nonce, bornFile, releaseFile) : []),
		exitGuard,
		`( ${agentCommand} ) 2>> ${shellEscape(paths.logFile)}`,
		// Keep the original wrapper alive for verified post-result tree cleanup.
		...(gate?.cleanup ? ['__sumo_finish "$?"', 'while :; do /bin/sleep 1; done'] : []),
	].join("\n");
	fs.writeFileSync(paths.scriptFile, script, { mode: 0o700, flag: "wx" });
	const shellCommand = `exec ${shellEscape(paths.scriptFile)}${gate ? ` ${shellEscape(nonce)}` : ""}`;

	let emitEvent: ((event: SubagentEvent) => void) | undefined;
	let pane: PaneRef | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let lastHeartbeatAt = 0;
	let observedResponseSignature: string | undefined;
	let interrupted = false;
	let settled = false;
	let steerSeq = 0;
	let markReady = (): void => undefined;
	let refuseReady = (_error: Error): void => undefined;
	const ready = new Promise<void>((resolve, reject) => { markReady = resolve; refuseReady = reject; });
	void ready.catch(() => undefined);
	let subscribed = false;
	let released = !gate;
	let launchBlocked = false;
	let launchTimer: ReturnType<typeof setInterval> | undefined;
	let startedPane: StartedAgentPane | undefined;
	const operations = dependencies.processTree ?? systemProcessTree;
	const blockLaunch = (error: Error): void => {
		launchBlocked = true;
		if (launchTimer) clearInterval(launchTimer);
		launchTimer = undefined;
		refuseReady(error);
	};
	const pendingSteeringAcks = new Map<string, {
		readonly timer: ReturnType<typeof setInterval>;
		readonly resolve: () => void;
		readonly reject: (error: Error) => void;
		readonly beforeEffect?: () => void;
	}>();

	const clearWatcher = (): void => {
		if (!pollTimer) return;
		clearInterval(pollTimer);
		pollTimer = undefined;
	};

	let authorityLost = false;
	const authorityError = (): Error => new Error("visible authority lost; control outcome unconfirmed, files retained");
	const refuseEffect = (error: Error): void => {
		if (authorityLost) return;
		authorityLost = true;
		blockLaunch(error);
		clearWatcher();
		for (const path of pendingSteeringAcks.keys()) finishPendingSteeringAck(path, authorityError());
		options.signal?.removeEventListener("abort", onAbort);
		try { gate?.onRefused(); }
		catch { /* Local effects remain stopped even if the owner cannot persist loss. */ }
	};
	const callGate = (check: () => void): void => {
		if (authorityLost) throw authorityError();
		try { check(); }
		catch (error) {
			refuseEffect(new Error(errorText(error)));
			throw authorityError();
		}
	};
	const assertAuthority = (): void => { if (gate) callGate(() => gate.beforeEffect()); };
	// Host implementations may await several execs and swallow failures. Fence
	// each invocation, but return issued results intact so pane identity survives.
	const hostPi: PiExecLike = gate ? {
		exec: async (command, args, execOptions) => {
			if (launchBlocked) throw new Error("visible launch blocked; issued effects remain unconfirmed");
			// Herdr's failed-start cleanup knows only a pane ID. Retained cleanup
			// must instead go through the owner's persisted, verified tree authority.
			if (command === "herdr" && args[0] === "pane" && args[1] === "close") {
				const error = new Error("visible host cleanup lacks verified process authority");
				refuseEffect(error);
				throw error;
			}
			assertAuthority();
			return options.pi.exec(command, args, execOptions);
		},
	} : options.pi;

	const steeringSettlementError = (): Error => new Error(
		`visible subagent ${options.id} has settled before steering consumption was acknowledged`,
	);

	const finishPendingSteeringAck = (path: string, error?: Error): void => {
		const pending = pendingSteeringAcks.get(path);
		if (!pending) return;
		if (!authorityLost) {
			try { assertAuthority(); pending.beforeEffect?.(); }
			catch { refuseEffect(authorityError()); return; }
		}
		pendingSteeringAcks.delete(path);
		clearInterval(pending.timer);
		if (error) pending.reject(error);
		else pending.resolve();
	};

	// While authority holds, settlement and interrupt honor consumption: an absent control
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

	const settle = (event: Extract<SubagentEvent, { kind: "run-settled" }>, beforeEffect?: () => void): void => {
		if (settled || authorityLost) return;
		try { assertAuthority(); }
		catch { return; }
		settled = true;
		clearWatcher();
		settlePendingSteeringAcks();
		options.signal?.removeEventListener("abort", onAbort);
		try { assertAuthority(); }
		catch { return; }
		if (gate?.cleanup) {
			void gate.cleanup(beforeEffect).then(() => {
				assertAuthority();
				emitEvent?.(event);
			}).catch(() => refuseEffect(authorityError()));
		} else emitEvent?.(event);
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

	const observeCompletedTurn = (): void => {
		try {
			const stat = validatedArtifactStat(fs, paths.responseFile, taskDir, "visible-subagent response artifact");
			if (!stat || stat.size !== undefined && stat.size > PRIVATE_RESPONSE_MAX_BYTES) return;
			const finalText = fs.readFileSync(paths.responseFile, "utf8");
			const signature = `${stat.mtimeMs ?? ""}:${finalText}`;
			if (!finalText || signature === observedResponseSignature) return;
			observedResponseSignature = signature;
			const observedAt = stat.mtimeMs === undefined || !Number.isFinite(stat.mtimeMs)
				? now()
				: Math.min(now(), Math.max(0, Math.floor(stat.mtimeMs)));
			emitEvent?.({ kind: "turn-finished", finalText, at: observedAt });
		} catch { /* A refused response cannot prove a completed turn. Exit settlement reports the tamper. */ }
	};

	const poll = (): void => {
		if (settled || interrupted || authorityLost) return;
		try { assertAuthority(); }
		catch { return; }
		try {
			const file = join(paths.controlDir, "heartbeat");
			assertPrivateArtifact(fs, file, paths.controlDir, "task heartbeat");
			const text = fs.readFileSync(file, "utf8");
			const at = /^\d{1,16}\n$/u.test(text) ? Number(text.trim()) : NaN;
			if (Number.isSafeInteger(at) && at > lastHeartbeatAt && at <= now() && now() - at <= 2000) {
				lastHeartbeatAt = at;
				emitEvent?.({ kind: "heartbeat", at });
			}
		} catch { /* Missing, stale or untrusted heartbeat is not proof of death. */ }
		// lstat, not existsSync: existsSync follows symlinks, so a dangling
		// symlink swapped in for the exit marker would read as "not yet written"
		// and pin the child running forever. A non-regular entry is tamper and
		// settles failed; a truly absent entry is the normal not-ready state.
		let exitStat: ReturnType<PaneBackendFs["lstatSync"]> | undefined;
		try {
			exitStat = fs.lstatSync(paths.exitFile);
		} catch {
			exitStat = undefined;
		}
		if (!exitStat) {
			observeCompletedTurn();
			return;
		}
		if (!exitStat.isFile()) {
			settle({ kind: "run-settled", outcome: { kind: "failed", errorText: "visible child exit marker replaced by a non-regular entry" } });
			return;
		}
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
				settle({ kind: "run-settled", outcome: { kind: "failed", errorText: `failed to close visible child pane: ${result.error}`, paneStillOpen: true } });
				return;
			}
			settle({ kind: "run-settled", outcome: { kind: "interrupted" } });
		} catch (error) {
			settle({ kind: "run-settled", outcome: { kind: "failed", errorText: `failed to close visible child pane: ${errorText(error)}`, paneStillOpen: true } });
		}
	};

	function interrupt(beforeEffect?: () => void): void {
		beforeEffect?.();
		if (gate) {
			if (authorityLost) return;
			try {
				assertAuthority();
				if (!released) blockLaunch(new Error("visible launch interrupted before release"));
				callGate(() => gate.interrupt());
				if (gate.cleanup) settle({ kind: "run-settled", outcome: { kind: "interrupted" } }, beforeEffect);
			} catch { /* Refusal stops local actions; it is not cancellation proof. */ }
			return;
		}
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
	const send = (text: string, beforeEffect?: () => void): Promise<void> => {
		if (authorityLost) return Promise.reject(authorityError());
		if (settled || interrupted) return Promise.reject(steeringSettlementError());
		if (!released) return Promise.reject(new Error("visible launch has not been released"));
		try { assertAuthority(); }
		catch { return Promise.reject(authorityError()); }
		beforeEffect?.();
		const seq = ++steerSeq;
		const finalPath = join(paths.controlDir, `steer-${seq}.txt`);
		// 0600 on the temp file: rename preserves the mode, so the published file
		// is never briefly world-readable. Exclusive create keeps a planted entry
		// from being followed or overwritten.
		writeNewPrivateFile(fs, `${finalPath}.tmp`, text);
		try { assertAuthority(); }
		catch { return Promise.reject(authorityError()); }
		beforeEffect?.();
		fs.renameSync(`${finalPath}.tmp`, finalPath);
		emitEvent?.({ kind: "turn-started", at: now() });
		try { assertAuthority(); }
		catch { return Promise.reject(authorityError()); }
		const ackPollMs = dependencies.sendAckPollMs ?? SEND_ACK_POLL_MS;
		const ackTimeoutMs = dependencies.sendAckTimeoutMs ?? SEND_ACK_TIMEOUT_MS;
		return new Promise<void>((resolve, reject) => {
			let elapsed = 0;
			const ackTimer = setInterval(() => {
				try { assertAuthority(); }
				catch { return; }
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
			pendingSteeringAcks.set(finalPath, { timer: ackTimer, resolve, reject, beforeEffect });
			ackTimer.unref?.();
		});
	};

	/** Ask the child's task-mode watcher to persist its response and exit. */
	const requestClose = (beforeEffect?: () => void): void => {
		beforeEffect?.();
		if (settled) throw steeringSettlementError();
		if (authorityLost) throw authorityError();
		if (!released) throw new Error("visible launch has not been released");
		assertAuthority();
		beforeEffect?.();
		try {
			writeNewPrivateFile(fs, join(paths.controlDir, CLOSE_REQUEST_FILE), "1");
		} catch (error) {
			// A repeat close request for an unconsumed control is idempotent, not an
			// error: the request is already published. A planted entry raising the
			// same EEXIST is not: it must still pass the private-artifact check or
			// the error propagates (the manager surfaces it per id) instead of the
			// close being reported as requested through an untrusted path.
			if (!isEexist(error)) throw error;
			assertPrivateArtifact(fs, join(paths.controlDir, CLOSE_REQUEST_FILE), paths.controlDir, "close control");
		}
		assertAuthority();
		beforeEffect?.();
	};

	const watchLaunchGate = (launchGate: VisibleLaunchGate): void => {
		let elapsed = 0;
		let inspecting = false;
		launchTimer = setInterval(async () => {
			elapsed += 50;
			if (inspecting) {
				if (elapsed >= 30_000) blockLaunch(new Error("visible pane inspection timed out; tracking evidence retained"));
				return;
			}
			inspecting = true;
			try {
				assertAuthority();
				if (elapsed >= 30_000) throw new Error("visible wrapper birth/release timed out; tracking evidence retained");
				if (!startedPane) return;
				const stat = validatedArtifactStat(fs, bornFile, taskDir, "wrapper birth");
				if (!stat) return;
				assertPrivateDir(fs, taskDir, "visible launch directory");
				const birth = fs.readFileSync(bornFile, "utf8");
				if (!birth) return;
				const fields = birth.split("\n");
				const [token, pidText, groupText, birthTime, end] = fields;
				const pid = Number(pidText);
				if (birth.length > 4096 || token !== nonce || !/^[1-9]\d*$/.test(pidText ?? "")
					|| !Number.isSafeInteger(pid) || groupText?.trim() !== pidText || !birthTime?.trim() || end !== ""
					|| fields.length !== 5) throw new Error("invalid visible wrapper birth/nonce");
				const processStartTime = operations.captureStartTime(pid);
				if (!processStartTime?.includes(paths.scriptFile) || !processStartTime.includes(nonce)) throw new Error("visible wrapper command identity refused");
				const identity = { pid, processGroupId: pid, processStartTime };
				const verification = operations.captureTreeVerification?.(identity);
				if (!verification?.members.some((member) => member.pid === pid && member.processStartTime === birthTime.trim())) throw new Error("visible wrapper birth identity refused");
				const assertLive = (): void => {
					if (operations.identityMatches(identity) !== "same" || operations.verificationMatches?.(identity, verification) !== "same") throw new Error("visible wrapper identity is ambiguous");
				};
				assertLive();
				if (validatedArtifactStat(fs, releaseFile, taskDir, "wrapper release")) throw new Error("visible wrapper release already exists");
				assertAuthority();
				try {
					await launchGate.wrapperBorn({ taskDir, nonce, process: { identity, verification }, pane: structuredClone(startedPane!) });
				} catch (error) {
					refuseEffect(new Error(errorText(error)));
					throw error;
				}
				if (launchBlocked || options.signal?.aborted) throw new Error("visible launch interrupted before release");
				assertLive();
				assertPrivateDir(fs, taskDir, "visible launch directory");
				assertPrivateArtifact(fs, bornFile, taskDir, "wrapper birth");
				if (fs.readFileSync(bornFile, "utf8") !== birth) throw new Error("visible wrapper birth changed before release");
				callGate(() => launchGate.beforeRelease());
				if (launchBlocked || options.signal?.aborted) throw new Error("visible launch interrupted before release");
				assertAuthority();
				writeNewPrivateFile(fs, releaseFile, nonce);
				released = true;
				assertAuthority();
				clearInterval(launchTimer);
				launchTimer = undefined;
				markReady();
				pollTimer = setInterval(poll, dependencies.pollIntervalMs ?? RESPONSE_POLL_INTERVAL_MS);
				pollTimer.unref?.();
				poll();
			} catch (error) { blockLaunch(new Error(errorText(error))); }
			finally { inspecting = false; }
		}, 50);
		launchTimer.unref?.();
	};

	const events = (emit: (event: SubagentEvent) => void): void => {
		if (gate && subscribed) throw new Error("retained backend already subscribed");
		subscribed = true;
		emitEvent = emit;
		void (async () => {
			const startAgentPane = options.host.startAgentPane;
			if (!startAgentPane) {
				if (gate) { blockLaunch(new Error("terminal host does not support visible agent panes")); return; }
				settle({ kind: "run-settled", outcome: { kind: "failed", errorText: `terminal host ${options.host.kind} does not support visible agent panes` } });
				return;
			}
			try {
				if (gate) {
					if (launchBlocked || options.signal?.aborted) throw new Error("visible launch interrupted before spawn");
					callGate(() => gate.beforeSpawn({ taskDir, nonce }));
					if (launchBlocked || options.signal?.aborted) throw new Error("visible launch interrupted before spawn");
					watchLaunchGate(gate);
				}
				assertAuthority();
				const result = await startAgentPane.call(options.host, hostPi, {
					name: options.name,
					agentName: options.id,
					cwd: options.cwd,
					shellCommand,
					placement: options.placement,
					provisioningTimeoutMs: provisioningExpiresAt === undefined
						? undefined
						: Math.max(0, Math.floor(provisioningExpiresAt - Date.now())),
					beforeRun: gate ? async () => {
						if (launchBlocked || options.signal?.aborted) throw new Error("visible launch interrupted before command");
						assertAuthority();
					} : undefined,
				});
				if (!result.ok) {
					if (gate) {
						assertAuthority();
						// Mirror the disposable branch below: the owner must persist the same
						// host taxonomy and orphan occupancy, or the retained failure record
						// only carries an unstructured text error.
						const orphanTabId = result.orphanTabId ?? (options.placement.kind === "tab" ? options.placement.tabId : undefined);
						const paneStillOpen = result.orphanPaneId !== undefined || result.orphanTabId !== undefined;
						type MutableFailure = { -readonly [K in keyof SubagentLaunchFailure]: SubagentLaunchFailure[K] };
						const failure: MutableFailure = {
							errorText: result.error,
							errorCode: result.code,
							errorReason: result.reason,
							paneTabGone: result.tabGone,
							paneStillOpen,
						};
						if (paneStillOpen) failure.orphanPane = {
							agentName: options.id,
							paneId: result.orphanPaneId,
							tabId: orphanTabId,
							workspaceId: orphanTabId?.split(":")[0],
						};
						gate.onRefused(failure);
						blockLaunch(new Error(result.error));
						return;
					}
					const orphanTabId = result.orphanTabId ?? (options.placement.kind === "tab" ? options.placement.tabId : undefined);
					const outcome: Extract<SubagentEvent, { kind: "run-settled" }>["outcome"] = {
						kind: "failed",
						errorText: result.error,
						errorCode: result.code,
						errorReason: result.reason,
						// The host's definitive "target tab has no live pane" signal;
						// the manager retires stale still-open records only on this.
						paneTabGone: result.tabGone,
					};
					if (result.orphanPaneId !== undefined || result.orphanTabId !== undefined) {
						// Cleanup failed or was skipped, so the allocated pane/tab still
						// occupies a layout slot the manager must keep counting.
						outcome.paneStillOpen = true;
						outcome.orphanPane = {
							agentName: options.id,
							paneId: result.orphanPaneId,
							tabId: orphanTabId,
							workspaceId: orphanTabId?.split(":")[0],
						};
					}
					settle({ kind: "run-settled", outcome });
					return;
				}
				pane = result.pane;
				startedPane = result;
				// A visible child starts only when Herdr accepts the pane command. Host
				// preparation failures happen before a process exists and must not trigger
				// child completion-manifest collection in the manager.
				emit({ kind: "run-started" });
				emit({
					kind: "pane-attached",
					pane: {
						agentName: result.agentName,
						workspaceId: result.workspaceId,
						tabId: result.tabId,
						paneId: result.paneId,
					},
				});
				if (gate) { assertAuthority(); return; }
				if (interrupted) {
					await closeInterruptedPane();
					return;
				}
				pollTimer = setInterval(poll, dependencies.pollIntervalMs ?? RESPONSE_POLL_INTERVAL_MS);
				pollTimer.unref?.();
				poll();
			} catch (error) {
				if (gate) { blockLaunch(new Error(errorText(error))); return; }
				settle({ kind: "run-settled", outcome: { kind: "failed", errorText: errorText(error) } });
			}
		})().finally(() => { if (!gate) markReady(); });
	};

	function onAbort(): void { interrupt(); }
	if (options.signal?.aborted) interrupted = true;
	else options.signal?.addEventListener("abort", onAbort, { once: true });

	return { events, interrupt, ready, send, requestClose };
};

// The wrapper, not Pi/provider initialization, is the first born process. Its
// dedicated group stays anchored in bash while the launcher runs as a child.
// Gate failure precedes exit traps: timeout is NOT a task result or death proof.
function visibleWrapperGate(taskDir: string, nonce: string, bornFile: string, releaseFile: string): string[] {
	const statArgs = process.platform === "darwin" ? "-f '%Lp'" : "-c '%a'";
	return [
		`[ "\${1-}" = ${shellEscape(nonce)} ] || exit 125`,
		`__sumo_private() { [ ! -L "$1" ] && [ -O "$1" ] && [ "$(/usr/bin/stat ${statArgs} "$1")" = "$2" ]; }`,
		`[ -d ${shellEscape(taskDir)} ] && __sumo_private ${shellEscape(taskDir)} 700 || exit 125`,
		`__sumo_birth=$(/bin/ps -p "$$" -o lstart=) || exit 125`,
		`__sumo_group=$(/bin/ps -p "$$" -o pgid=) || exit 125`,
		`( umask 077; set -C; printf '%s\\n' "$1" "$$" "$__sumo_group" "$__sumo_birth" > ${shellEscape(bornFile)} ) || exit 125`,
		`__sumo_released=0`,
		`for ((__sumo_wait=0; __sumo_wait<300; __sumo_wait++)); do`,
		`  [ -d ${shellEscape(taskDir)} ] && __sumo_private ${shellEscape(taskDir)} 700 || exit 125`,
		`  if [ -e ${shellEscape(releaseFile)} ] || [ -L ${shellEscape(releaseFile)} ]; then`,
		`    [ -f ${shellEscape(releaseFile)} ] && __sumo_private ${shellEscape(releaseFile)} 600 || exit 125`,
		`    __sumo_release=$(< ${shellEscape(releaseFile)})`,
		`    if [ -n "$__sumo_release" ]; then`,
		`      [ "$__sumo_release" = "$1" ] || exit 125`,
		`      __sumo_released=1; break`,
		`    fi`,
		`  fi`,
		`  /bin/sleep 0.1`,
		`done`,
		`[ "$__sumo_released" = 1 ] || exit 125`,
	];
}

export const spawnPaneChild = createPaneChildSpawner();
