import { randomUUID } from "node:crypto";
import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	signalVerifiedProcessTree,
	systemProcessTree,
	terminateFreshProcessTree,
	terminateProcessTree,
	type ProcessTreeIdentity,
	type ProcessTreeOperations,
	type ProcessTreeSignalResult,
	type ProcessTreeVerification,
} from "./process-tree.js";
import {
	StaleTerminalTaskRevisionError,
	TerminalTaskStore,
	isValidTerminalTaskId,
	type TerminalTaskStoreDiagnostic,
} from "./task-store.js";
import {
	TERMINAL_TASK_SCHEMA_VERSION,
	isTerminalTaskSettled,
	type StartTerminalTaskOptions,
	type TerminalStopResult,
	type TerminalTaskObservation,
	type TerminalTaskSnapshot,
	type TerminalWaitResult,
} from "./task-types.js";
import { buildVisibleTaskPaths, shellEscape } from "./visible-spawn.js";

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_LOG_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TERM_GRACE_MS = 5_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_CLAIM_LEASE_MS = 30_000;
const DEFAULT_STARTING_RECOVERY_GRACE_MS = 30_000;
const CHECK_OUTPUT_BYTES = 16 * 1024;
const WAIT_OUTPUT_BYTES = 16 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_TRANSITION_RETRIES = 16;

interface RuntimeTask {
	child?: ChildProcess;
	pollTimer?: ReturnType<typeof setInterval>;
	reconcilePromise?: Promise<void>;
	treeVerification?: ProcessTreeVerification;
	lastLogCapAt: number;
}

interface MutationResult {
	readonly snapshot: TerminalTaskSnapshot;
	readonly changed: boolean;
}

interface StopTarget {
	readonly task: TerminalTaskSnapshot;
	readonly identity: ProcessTreeIdentity;
	readonly verification?: ProcessTreeVerification;
	readonly naturalExitCode?: number;
}

export interface TerminalTaskManagerOptions {
	readonly store?: TerminalTaskStore;
	readonly processTree?: ProcessTreeOperations;
	readonly spawn?: typeof spawnChild;
	readonly now?: () => number;
	readonly createId?: () => string;
	readonly createCompletionId?: () => string;
	readonly pollIntervalMs?: number;
	readonly logMaxBytes?: number;
	readonly termGraceMs?: number;
	readonly killGraceMs?: number;
	readonly claimLeaseMs?: number;
	readonly startingRecoveryGraceMs?: number;
	readonly onDiagnostic?: (diagnostic: TerminalTaskStoreDiagnostic | { kind: "manager"; message: string; id?: string }) => void;
}

export type TerminalTaskChangeListener = (snapshot: TerminalTaskSnapshot) => void;

function normalizePositive(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function taskPaths(store: TerminalTaskStore, id: string, createdAt: number) {
	const visiblePaths = buildVisibleTaskPaths(id, createdAt, store.rootDir);
	const directory = dirname(visiblePaths.logFile);
	return {
		...visiblePaths,
		directory,
		launchFile: join(directory, "launch.ready"),
		windowsScriptFile: join(directory, "run.cmd"),
	};
}

function isPrivateFileMode(mode: number): boolean {
	return process.platform === "win32" || (mode & 0o777) === PRIVATE_FILE_MODE;
}

function openPrivateFile(path: string, flags: number): number {
	const descriptor = openSync(path, flags | NO_FOLLOW);
	const stat = fstatSync(descriptor);
	if (!stat.isFile() || !isPrivateFileMode(stat.mode)) {
		closeSync(descriptor);
		throw new Error(`Unsafe terminal artifact: ${path}`);
	}
	return descriptor;
}

function createPrivateFile(path: string, contents: string): void {
	const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, PRIVATE_FILE_MODE);
	try {
		fchmodSync(descriptor, PRIVATE_FILE_MODE);
		writeFileSync(descriptor, contents, "utf8");
	} finally {
		closeSync(descriptor);
	}
}

function createPrivateTaskDirectory(path: string): void {
	mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
	chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

function readExitCode(path: string): number | undefined {
	let descriptor: number | undefined;
	try {
		descriptor = openPrivateFile(path, constants.O_RDONLY);
		const text = readFileSync(descriptor, "utf8").trim();
		if (!/^-?\d+$/.test(text)) return undefined;
		const exitCode = Number.parseInt(text, 10);
		return Number.isSafeInteger(exitCode) ? exitCode : undefined;
	} catch {
		return undefined;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function readLogTail(path: string, maxBytes: number): string {
	let descriptor: number | undefined;
	try {
		descriptor = openPrivateFile(path, constants.O_RDONLY);
		const size = fstatSync(descriptor).size;
		if (size === 0) return "";
		const bytes = Math.min(size, Math.max(0, maxBytes));
		const offset = size - bytes;
		const buffer = Buffer.allocUnsafe(bytes);
		readSync(descriptor, buffer, 0, bytes, offset);
		let text = buffer.toString("utf8");
		if (offset > 0) {
			const newline = text.indexOf("\n");
			if (newline >= 0) text = text.slice(newline + 1);
		}
		return text;
	} catch {
		return "";
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function capRunningLog(path: string, maxBytes: number): void {
	let descriptor: number | undefined;
	try {
		descriptor = openPrivateFile(path, constants.O_WRONLY);
		if (fstatSync(descriptor).size > maxBytes) ftruncateSync(descriptor, 0);
	} catch {
		// Output bounding is best effort and cannot perturb process state.
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function capSettledLog(path: string, maxBytes: number): void {
	try {
		let descriptor = openPrivateFile(path, constants.O_RDONLY);
		const size = fstatSync(descriptor).size;
		closeSync(descriptor);
		if (size <= maxBytes) return;
		const marker = "[sumocode-terminal] log truncated to bounded tail\n";
		const tail = readLogTail(path, Math.max(0, maxBytes - Buffer.byteLength(marker)));
		descriptor = openPrivateFile(path, constants.O_WRONLY);
		try {
			ftruncateSync(descriptor, 0);
			writeFileSync(descriptor, `${marker}${tail}`.slice(-maxBytes), "utf8");
		} finally {
			closeSync(descriptor);
		}
	} catch {
		// Output bounding is best effort and cannot perturb durable status.
	}
}

function appendPrivateFile(path: string, contents: string): void {
	let descriptor: number | undefined;
	try {
		descriptor = openPrivateFile(path, constants.O_WRONLY | constants.O_APPEND);
		writeFileSync(descriptor, contents, "utf8");
	} catch {
		// The durable record remains the source of truth.
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function identityOf(task: TerminalTaskSnapshot): ProcessTreeIdentity | undefined {
	if (task.pid === undefined || task.processGroupId === undefined || task.processStartTime === undefined) return undefined;
	return { pid: task.pid, processGroupId: task.processGroupId, processStartTime: task.processStartTime };
}

function buildPosixScript(options: {
	readonly command: string;
	readonly cwd: string;
	readonly launchFile: string;
	readonly logFile: string;
	readonly exitFile: string;
}): string {
	return [
		"#!/usr/bin/env bash",
		"umask 077",
		"set +e",
		"launch_wait=0",
		`while [ ! -f ${shellEscape(options.launchFile)} ]; do`,
		"  if [ \"$launch_wait\" -ge 3000 ]; then",
		`    printf '%s\\n' '[sumocode-terminal] launch gate timed out' >> ${shellEscape(options.logFile)}`,
		`    printf '%s' 125 > ${shellEscape(options.exitFile)}`,
		"    exit 125",
		"  fi",
		"  sleep 0.01",
		"  launch_wait=$((launch_wait + 1))",
		"done",
		`if ! cd ${shellEscape(options.cwd)}; then`,
		`  printf '%s\\n' ${shellEscape(`[sumocode-terminal] working directory unavailable: ${options.cwd}`)} >> ${shellEscape(options.logFile)}`,
		"  code=1",
		"else",
		"  set -o pipefail",
		"  export SUMOCODE_BG_CHILD=1",
		"  (",
		`    ${options.command}`,
		`) >> ${shellEscape(options.logFile)} 2>&1`,
		"  code=$?",
		"fi",
		`printf '%s' "$code" > ${shellEscape(options.exitFile)}`,
		// Retain the verified group leader until the manager disposes the complete
		// tree and records the command's already-captured natural exit code.
		"while :; do sleep 1; done",
	].join("\n");
}

function quoteWindows(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

function buildWindowsScript(options: {
	readonly command: string;
	readonly cwd: string;
	readonly launchFile: string;
	readonly logFile: string;
	readonly exitFile: string;
}): string {
	return [
		"@echo off",
		"setlocal EnableDelayedExpansion",
		"set launch_wait=0",
		":wait_for_launch",
		`if not exist ${quoteWindows(options.launchFile)} (`,
		"  set /a launch_wait+=1",
		"  if !launch_wait! GEQ 30 (",
		`    >> ${quoteWindows(options.logFile)} echo [sumocode-terminal] launch gate timed out`,
		`    > ${quoteWindows(options.exitFile)} echo 125`,
		"    exit /b 125",
		"  )",
		"  ping 127.0.0.1 -n 2 >nul",
		"  goto wait_for_launch",
		")",
		`cd /d ${quoteWindows(options.cwd)}`,
		"if errorlevel 1 (",
		`  >> ${quoteWindows(options.logFile)} echo [sumocode-terminal] working directory unavailable`,
		`  > ${quoteWindows(options.exitFile)} echo 1`,
		"  goto wait_for_tree_reconcile",
		")",
		`(${options.command}) >> ${quoteWindows(options.logFile)} 2>&1`,
		"set terminal_exit=%errorlevel%",
		`> ${quoteWindows(options.exitFile)} echo %terminal_exit%`,
		// Keep the verified leader alive until the manager performs taskkill /T.
		// This prevents a short-lived shell from orphaning background descendants.
		":wait_for_tree_reconcile",
		"ping 127.0.0.1 -n 2 >nul",
		"goto wait_for_tree_reconcile",
	].join("\r\n");
}

function abortError(): Error {
	const error = new Error("Terminal wait aborted");
	error.name = "AbortError";
	return error;
}

export class TerminalTaskManager {
	private readonly store: TerminalTaskStore;
	private readonly processTree: ProcessTreeOperations;
	private readonly spawn: typeof spawnChild;
	private readonly now: () => number;
	private readonly createId: () => string;
	private readonly createCompletionId: () => string;
	private readonly pollIntervalMs: number;
	private readonly logMaxBytes: number;
	private readonly termGraceMs: number;
	private readonly killGraceMs: number;
	private readonly claimLeaseMs: number;
	private readonly startingRecoveryGraceMs: number;
	private readonly onDiagnostic?: TerminalTaskManagerOptions["onDiagnostic"];
	private readonly tasks = new Map<string, TerminalTaskSnapshot>();
	private readonly runtime = new Map<string, RuntimeTask>();
	private readonly listeners = new Set<TerminalTaskChangeListener>();
	private detached = false;

	public constructor(options: TerminalTaskManagerOptions = {}) {
		this.store = options.store ?? new TerminalTaskStore({ onDiagnostic: options.onDiagnostic });
		this.processTree = options.processTree ?? systemProcessTree;
		this.spawn = options.spawn ?? spawnChild;
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? (() => `term-${this.now().toString(36)}-${randomUUID().slice(0, 8)}`);
		this.createCompletionId = options.createCompletionId ?? (() => `completion-${randomUUID()}`);
		this.pollIntervalMs = normalizePositive(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
		this.logMaxBytes = normalizePositive(options.logMaxBytes, DEFAULT_LOG_MAX_BYTES);
		this.termGraceMs = normalizePositive(options.termGraceMs, DEFAULT_TERM_GRACE_MS);
		this.killGraceMs = normalizePositive(options.killGraceMs, DEFAULT_KILL_GRACE_MS);
		this.claimLeaseMs = normalizePositive(options.claimLeaseMs, DEFAULT_CLAIM_LEASE_MS);
		this.startingRecoveryGraceMs = normalizePositive(options.startingRecoveryGraceMs, DEFAULT_STARTING_RECOVERY_GRACE_MS);
		this.onDiagnostic = options.onDiagnostic;
		for (const snapshot of this.store.loadAll()) {
			this.adopt(snapshot, false);
			this.recover(snapshot);
		}
	}

	public async start(options: StartTerminalTaskOptions): Promise<TerminalTaskSnapshot> {
		if (this.detached) throw new Error("Terminal task manager is detached");
		const command = options.command.trim();
		const title = options.title.trim();
		const ownerSessionId = options.ownerSessionId.trim();
		const cwd = options.cwd.trim();
		if (!command) throw new Error("command is required");
		if (!title) throw new Error("title is required");
		if (!ownerSessionId) throw new Error("owner session id is required");
		if (!cwd) throw new Error("working directory is required");

		const createdAt = Math.max(1, Math.floor(this.now()));
		let id: string | undefined;
		let paths: ReturnType<typeof taskPaths> | undefined;
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const candidate = this.createId();
			if (!isValidTerminalTaskId(candidate)) throw new Error(`Invalid generated terminal id: ${candidate}`);
			const candidatePaths = taskPaths(this.store, candidate, createdAt);
			try {
				createPrivateTaskDirectory(candidatePaths.directory);
				id = candidate;
				paths = candidatePaths;
				break;
			} catch (error) {
				if (!(typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST")) throw error;
			}
		}
		if (!id || !paths) throw new Error("Unable to allocate a unique terminal task directory");

		createPrivateFile(paths.logFile, "");
		createPrivateFile(paths.exitFile, "");
		const scriptFile = process.platform === "win32" ? paths.windowsScriptFile : paths.scriptFile;
		createPrivateFile(scriptFile, process.platform === "win32"
			? buildWindowsScript({ command, cwd, launchFile: paths.launchFile, logFile: paths.logFile, exitFile: paths.exitFile })
			: buildPosixScript({ command, cwd, launchFile: paths.launchFile, logFile: paths.logFile, exitFile: paths.exitFile }));

		const initial: TerminalTaskSnapshot = {
			schemaVersion: TERMINAL_TASK_SCHEMA_VERSION,
			revision: 1,
			id,
			ownerSessionId,
			command,
			cwd,
			title,
			status: "starting",
			completionPolicy: options.completionPolicy ?? "passive",
			createdAt,
			updatedAt: createdAt,
			deliveryState: "none",
			logFile: paths.logFile,
		};
		this.store.create(initial, paths.metaFile);
		this.adopt(initial, true);

		let child: ChildProcess;
		try {
			child = this.spawn(
				process.platform === "win32" ? "cmd.exe" : "/bin/bash",
				process.platform === "win32" ? ["/d", "/s", "/c", scriptFile] : [scriptFile],
				{ cwd, detached: true, stdio: "ignore", env: { ...process.env, SUMOCODE_BG_CHILD: "1" } },
			);
		} catch (error) {
			this.failUnlaunched(id, error);
			throw error;
		}
		this.ensureRuntime(initial).child = child;
		child.on("error", (error) => this.runGuarded(id, "child error reconciliation", () => this.handleChildError(id, error)));
		child.on("close", () => this.scheduleReconcile(id));
		const pid = child.pid;
		if (pid === undefined) {
			this.failUnlaunched(id, new Error("spawn returned no process id"));
			throw new Error("Unable to start terminal: spawn returned no process id");
		}
		const processStartTime = this.processTree.captureStartTime(pid);
		const identity: ProcessTreeIdentity = { pid, processGroupId: pid, processStartTime: processStartTime ?? "" };
		if (!processStartTime) {
			const terminated = await terminateFreshProcessTree(this.processTree, identity, { termGraceMs: this.termGraceMs, killGraceMs: this.killGraceMs });
			if (!terminated) throw new Error(`Unable to capture terminal process identity and unable to prove fresh process group ${pid} terminated`);
			this.failUnlaunched(id, new Error("unable to capture process start time"));
			throw new Error("Unable to start terminal: process identity could not be captured");
		}

		let running: MutationResult;
		try {
			running = this.mutate(id, (current) => current.status === "starting" ? {
				...current,
				status: "running",
				updatedAt: this.timestamp(current),
				pid,
				processGroupId: pid,
				processStartTime,
			} : undefined);
		} catch (error) {
			const terminated = await terminateFreshProcessTree(this.processTree, identity, { termGraceMs: this.termGraceMs, killGraceMs: this.killGraceMs });
			if (!terminated) throw new Error(`Spawn identity persistence failed and fresh process group ${pid} could not be proven terminated`);
			throw error;
		}
		if (!running.changed || running.snapshot.status !== "running") {
			const terminated = await terminateFreshProcessTree(this.processTree, identity, { termGraceMs: this.termGraceMs, killGraceMs: this.killGraceMs });
			if (!terminated) throw new Error(`Spawn identity persistence failed and fresh process group ${pid} could not be proven terminated`);
			throw new Error("Spawn identity persistence failed");
		}

		this.ensureRuntime(running.snapshot).treeVerification = this.processTree.captureTreeVerification?.(identity);
		try {
			createPrivateFile(paths.launchFile, "ready\n");
		} catch (error) {
			const terminated = await terminateProcessTree(this.processTree, identity, { termGraceMs: this.termGraceMs, killGraceMs: this.killGraceMs });
			if (!terminated) throw new Error(`Terminal launch release failed and process group ${pid} could not be proven terminated`);
			this.settleFailedLaunch(id);
			throw error;
		}
		child.unref();
		this.arm(id);
		return running.snapshot;
	}

	/** Pure inventory read: no recovery, delivery reconciliation, observation, or listener notification. */
	public list(ownerSessionId: string): TerminalTaskSnapshot[] {
		return this.store.listOwned(ownerSessionId);
	}

	public get(id: string, ownerSessionId: string): TerminalTaskSnapshot | undefined {
		const task = this.store.getOwned(id, ownerSessionId);
		if (!task) return undefined;
		this.adopt(task, false);
		if (!isTerminalTaskSettled(task.status)) this.arm(id);
		return task;
	}

	public check(id: string, ownerSessionId: string): TerminalTaskObservation | undefined {
		const current = this.get(id, ownerSessionId);
		if (!current) return undefined;
		const task = isTerminalTaskSettled(current.status) ? this.observe(current.id, false) : current;
		return { task, output: this.getOutput(task, CHECK_OUTPUT_BYTES) };
	}

	public async wait(
		ids: readonly string[],
		ownerSessionId: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<TerminalWaitResult> {
		const uniqueIds = [...new Set(ids)];
		const known = uniqueIds.filter((id) => this.get(id, ownerSessionId) !== undefined);
		const knownSet = new Set(known);
		const unknownIds = uniqueIds.filter((id) => !knownSet.has(id));
		const complete = (): boolean => known.every((id) => {
			const task = this.get(id, ownerSessionId);
			return task !== undefined && isTerminalTaskSettled(task.status);
		});
		if (!complete() && timeoutMs > 0) {
			await new Promise<void>((resolve, reject) => {
				let finished = false;
				let timer: ReturnType<typeof setTimeout> | undefined;
				let unsubscribe = (): void => {};
				const finish = (error?: Error): void => {
					if (finished) return;
					finished = true;
					if (timer) clearTimeout(timer);
					unsubscribe();
					signal?.removeEventListener("abort", onAbort);
					error ? reject(error) : resolve();
				};
				const onAbort = (): void => finish(abortError());
				unsubscribe = this.addChangeListener(() => { if (complete()) finish(); });
				// Close the inspection/subscription lost-wakeup window: settlement may
				// have committed after the first complete() and before listener install.
				if (complete()) {
					finish();
					return;
				}
				timer = setTimeout(() => finish(), timeoutMs);
				timer.unref?.();
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			});
		}
		const settled: TerminalTaskObservation[] = [];
		const pendingIds: string[] = [];
		for (const id of known) {
			const current = this.get(id, ownerSessionId)!;
			if (!isTerminalTaskSettled(current.status)) {
				pendingIds.push(id);
				continue;
			}
			const task = this.observe(id, true);
			settled.push({ task, output: this.getOutput(task, WAIT_OUTPUT_BYTES) });
		}
		return { settled, pendingIds, unknownIds, timedOut: pendingIds.length > 0 };
	}

	public async stop(ids: readonly string[], ownerSessionId: string): Promise<TerminalStopResult[]> {
		const uniqueIds = [...new Set(ids)];
		const results = new Map<string, TerminalStopResult>();
		const targets: StopTarget[] = [];
		for (const id of uniqueIds) {
			const current = this.get(id, ownerSessionId);
			if (!current) {
				results.set(id, { id, outcome: "unknown", message: `Unknown terminal ${id}.` });
				continue;
			}
			if (isTerminalTaskSettled(current.status)) {
				const observed = this.observe(id, false);
				results.set(id, {
					id,
					outcome: "already-settled",
					task: observed,
					output: this.getOutput(observed, WAIT_OUTPUT_BYTES),
					message: `Terminal ${id} was already ${observed.status}.`,
				});
				continue;
			}
			const identity = identityOf(current);
			if (!identity) {
				results.set(id, { id, outcome: "failed", task: current, message: `Terminal ${id} has no verified process-group identity.` });
				continue;
			}
			const paths = taskPaths(this.store, current.id, current.createdAt);
			const naturalExitCode = readExitCode(paths.exitFile);
			if (this.processTree.isTreeEmpty(identity)) {
				if (naturalExitCode !== undefined) {
					const settled = this.settleNatural(id, naturalExitCode);
					const observed = this.observe(id, false);
					results.set(id, {
						id,
						outcome: "already-settled",
						task: observed,
						output: this.getOutput(observed, WAIT_OUTPUT_BYTES),
						message: `Terminal ${id} completed before its stop signal with exit ${settled.exitCode ?? "unknown"}.`,
					});
				} else {
					this.settleLost(id, null, false);
					const observed = this.observe(id, true);
					results.set(id, {
						id,
						outcome: "failed",
						task: observed,
						output: this.getOutput(observed, WAIT_OUTPUT_BYTES),
						message: `Terminal ${id} process tree was already empty without exit evidence; recorded lost.`,
					});
				}
				continue;
			}
			const retainedVerification = this.runtime.get(id)?.treeVerification;
			let identityStatus = this.processTree.identityMatches(identity);
			if (identityStatus !== "same" && retainedVerification && this.processTree.verificationMatches) {
				identityStatus = this.processTree.verificationMatches(identity, retainedVerification);
			}
			if (identityStatus === "different") {
				const lost = this.settleLost(id, null, false);
				results.set(id, { id, outcome: "failed", task: lost, message: `Terminal ${id} process identity changed; recorded lost without signalling.` });
				continue;
			}
			if (identityStatus === "unknown") {
				results.set(id, { id, outcome: "failed", task: current, message: `Terminal ${id} process identity could not be verified; refusing to signal.` });
				continue;
			}
			const verification = this.processTree.captureTreeVerification?.(identity) ?? retainedVerification;
			if (naturalExitCode !== undefined) {
				targets.push({ task: current, identity, verification, naturalExitCode });
				continue;
			}
			const stopping = this.mutate(id, (task) => !isTerminalTaskSettled(task.status) && task.status !== "stopping"
				? { ...task, status: "stopping", updatedAt: this.timestamp(task) }
				: undefined).snapshot;
			if (isTerminalTaskSettled(stopping.status)) {
				results.set(id, { id, outcome: "already-settled", task: stopping, message: `Terminal ${id} was already ${stopping.status}.` });
				continue;
			}
			targets.push({ task: stopping, identity, verification });
		}

		// Verification and TERM/taskkill initiation happen for every target before
		// any grace wait, preserving concurrent batch-stop semantics.
		const termSignals = await Promise.all(targets.map(({ identity, verification, naturalExitCode }) =>
			this.safeVerifiedSignal(identity, naturalExitCode === undefined ? "SIGTERM" : "SIGKILL", verification)));
		await Promise.all(targets.map(async ({ task, identity, verification, naturalExitCode }, index) => {
			results.set(task.id, naturalExitCode === undefined
				? await this.finishStop(task.id, identity, termSignals[index]!, true, verification)
				: await this.finishNaturalStop(task.id, identity, naturalExitCode, termSignals[index]!));
		}));
		return uniqueIds.map((id) => results.get(id)!);
	}

	public claimPending(ownerSessionId: string, includeWake: boolean, maxWake = 1): TerminalTaskSnapshot[] {
		const claimed: TerminalTaskSnapshot[] = [];
		let claimedWake = 0;
		for (const candidate of this.store.listOwned(ownerSessionId)) {
			if (!isTerminalTaskSettled(candidate.status)) continue;
			if (candidate.completionPolicy === "wake" && (!includeWake || claimedWake >= maxWake)) continue;
			const result = this.mutate(candidate.id, (current) => {
				if (current.ownerSessionId !== ownerSessionId || !isTerminalTaskSettled(current.status)) return undefined;
				const expiredClaim = current.deliveryState === "claimed" && this.now() - current.updatedAt >= this.claimLeaseMs;
				if (current.deliveryState !== "pending" && !expiredClaim) return undefined;
				if (current.completionPolicy === "wake" && (!includeWake || claimedWake >= maxWake)) return undefined;
				return { ...current, deliveryState: "claimed", updatedAt: this.timestamp(current) };
			});
			if (!result.changed) continue;
			claimed.push(result.snapshot);
			if (result.snapshot.completionPolicy === "wake") claimedWake += 1;
		}
		return claimed;
	}

	public acknowledge(ownerSessionId: string, completionIds: ReadonlySet<string>): TerminalTaskSnapshot[] {
		const acknowledged: TerminalTaskSnapshot[] = [];
		for (const candidate of this.store.listOwned(ownerSessionId)) {
			if (!candidate.completionId || !completionIds.has(candidate.completionId)) continue;
			const result = this.mutate(candidate.id, (current) => {
				if (current.ownerSessionId !== ownerSessionId || current.deliveryState !== "claimed" || !current.completionId || !completionIds.has(current.completionId)) return undefined;
				return { ...current, deliveryState: "delivered", updatedAt: this.timestamp(current) };
			});
			if (result.changed) acknowledged.push(result.snapshot);
		}
		return acknowledged;
	}

	public getClaimRetryDelay(ownerSessionId: string): number | undefined {
		const delays = this.store.listOwned(ownerSessionId)
			.filter((task) => task.deliveryState === "claimed")
			.map((task) => Math.max(0, this.claimLeaseMs - (this.now() - task.updatedAt)));
		return delays.length > 0 ? Math.min(...delays) : undefined;
	}

	public addChangeListener(listener: TerminalTaskChangeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	public getOutput(task: Pick<TerminalTaskSnapshot, "logFile">, maxBytes = CHECK_OUTPUT_BYTES): string {
		return readLogTail(task.logFile, maxBytes);
	}

	public async stopOwned(ownerSessionId: string): Promise<TerminalStopResult[]> {
		const running = this.store.listOwned(ownerSessionId).filter((task) => !isTerminalTaskSettled(task.status));
		return this.stop(running.map((task) => task.id), ownerSessionId);
	}

	public detach(): void {
		if (this.detached) return;
		this.detached = true;
		for (const runtime of this.runtime.values()) {
			if (runtime.pollTimer) clearInterval(runtime.pollTimer);
			runtime.pollTimer = undefined;
		}
		this.listeners.clear();
	}

	private recover(snapshot: TerminalTaskSnapshot): void {
		if (isTerminalTaskSettled(snapshot.status)) {
			capSettledLog(snapshot.logFile, this.logMaxBytes);
			return;
		}
		if (snapshot.status === "starting") {
			// Another process may be between durable create and spawn-identity CAS.
			// Poll it through a bounded lease before classifying it abandoned.
			this.arm(snapshot.id);
			this.scheduleReconcile(snapshot.id);
			return;
		}
		const paths = taskPaths(this.store, snapshot.id, snapshot.createdAt);
		if (snapshot.status === "running") {
			try {
				createPrivateFile(paths.launchFile, "recovered\n");
			} catch (error) {
				if (!(typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST")) {
					this.diagnostic(snapshot.id, `unable to release recovered launch gate: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
		this.arm(snapshot.id);
		this.scheduleReconcile(snapshot.id);
	}

	private ensureRuntime(task: TerminalTaskSnapshot): RuntimeTask {
		let runtime = this.runtime.get(task.id);
		if (!runtime) {
			runtime = { lastLogCapAt: 0 };
			this.runtime.set(task.id, runtime);
		}
		return runtime;
	}

	private arm(id: string): void {
		if (this.detached) return;
		const task = this.tasks.get(id) ?? this.store.get(id);
		if (!task || isTerminalTaskSettled(task.status)) return;
		const runtime = this.ensureRuntime(task);
		if (runtime.pollTimer) return;
		runtime.pollTimer = setInterval(() => this.scheduleReconcile(id), this.pollIntervalMs);
		runtime.pollTimer.unref?.();
	}

	private scheduleReconcile(id: string): void {
		if (this.detached) return;
		const task = this.tasks.get(id) ?? this.store.get(id);
		if (!task) return;
		const runtime = this.ensureRuntime(task);
		if (runtime.reconcilePromise) return;
		runtime.reconcilePromise = this.reconcile(id)
			.catch((error) => this.diagnostic(id, `reconciliation failed safely: ${error instanceof Error ? error.message : String(error)}`))
			.finally(() => {
				runtime.reconcilePromise = undefined;
			});
	}

	private async reconcile(id: string): Promise<void> {
		if (this.detached) return;
		const current = this.store.get(id);
		if (!current) return;
		this.adopt(current, true);
		if (isTerminalTaskSettled(current.status)) {
			this.clearPoll(id);
			return;
		}
		const runtime = this.ensureRuntime(current);
		if (this.now() - runtime.lastLogCapAt >= 5_000) {
			capRunningLog(current.logFile, this.logMaxBytes);
			runtime.lastLogCapAt = this.now();
		}
		if (current.status === "starting") {
			if (this.now() - current.updatedAt >= this.startingRecoveryGraceMs) this.settleLost(id, null, true);
			return;
		}
		const identity = identityOf(current);
		if (!identity) {
			this.settleLost(id, null, true);
			return;
		}
		if (current.status === "stopping") {
			await this.recoverStopping(id, identity);
			return;
		}
		if (this.processTree.identityMatches(identity) === "same") {
			this.ensureRuntime(current).treeVerification = this.processTree.captureTreeVerification?.(identity)
				?? this.ensureRuntime(current).treeVerification;
		}
		const paths = taskPaths(this.store, current.id, current.createdAt);
		const exitCode = readExitCode(paths.exitFile);
		if (exitCode !== undefined) {
			await this.finishNaturalCompletion(id, identity, exitCode);
			return;
		}
		const identityStatus = this.processTree.identityMatches(identity);
		if (identityStatus === "different" && this.store.get(id)?.status === "running") this.settleLost(id, exitCode ?? null, false);
	}

	private async finishNaturalCompletion(id: string, identity: ProcessTreeIdentity, exitCode: number): Promise<void> {
		if (this.store.get(id)?.status !== "running") return;
		if (this.processTree.isTreeEmpty(identity)) {
			// Crash recovery after the manager disposed the wrapper but before the
			// metadata CAS: exit.code plus proven emptiness is complete evidence.
			this.settleNatural(id, exitCode);
			return;
		}
		// Both wrappers deliberately retain the verified leader after writing the
		// command's exit code. Never derive an ownership anchor from an unverified
		// reused PGID: capture only after the persisted leader matches, otherwise
		// require an anchor retained from an earlier verified observation.
		const retainedVerification = this.runtime.get(id)?.treeVerification;
		let verification: ProcessTreeVerification | undefined;
		let identityStatus = this.processTree.identityMatches(identity);
		if (identityStatus === "same") {
			verification = this.processTree.captureTreeVerification?.(identity) ?? retainedVerification;
		} else if (retainedVerification && this.processTree.verificationMatches) {
			identityStatus = this.processTree.verificationMatches(identity, retainedVerification);
			if (identityStatus === "same") verification = retainedVerification;
		}
		if (identityStatus === "different") {
			this.settleLost(id, exitCode, false);
			return;
		}
		if (identityStatus === "unknown") {
			this.diagnostic(id, "natural completion identity is unverified; refusing tree signal");
			return;
		}
		const killed = await this.safeVerifiedSignal(identity, "SIGKILL", verification);
		const gone = killed.gone || (killed.ok && await this.processTree.waitForTreeEmpty(identity, this.killGraceMs));
		if (killed.ok && gone) {
			if (this.store.get(id)?.status === "running") this.settleNatural(id, exitCode);
			return;
		}
		if (killed.identityStatus === "different" && this.processTree.isTreeEmpty(identity)) {
			this.settleNatural(id, exitCode);
			return;
		}
		this.diagnostic(id, `natural completion tree disposition unproven; refusing settlement: ${killed.error ?? "tree did not become empty"}`);
	}

	private async recoverStopping(id: string, identity: ProcessTreeIdentity): Promise<void> {
		if (this.processTree.isTreeEmpty(identity)) {
			this.settleCancelled(id);
			return;
		}
		const identityStatus = this.processTree.identityMatches(identity);
		if (identityStatus === "different") {
			this.settleLost(id, null, false);
			return;
		}
		if (identityStatus === "unknown") {
			this.diagnostic(id, "persisted stopping task identity is unknown; refusing recovery signal");
			return;
		}
		const verification = this.processTree.captureTreeVerification?.(identity);
		const term = await this.safeVerifiedSignal(identity, "SIGTERM", verification);
		await this.finishStop(id, identity, term, false, verification);
	}

	private settleNatural(id: string, exitCode: number): TerminalTaskSnapshot {
		return this.settle(id, exitCode === 0 ? "completed" : "failed", exitCode, false);
	}

	private settleLost(id: string, exitCode: number | null, suppress: boolean): TerminalTaskSnapshot {
		return this.settle(id, "lost", exitCode, suppress);
	}

	private settle(
		id: string,
		status: "completed" | "failed" | "lost",
		exitCode: number | null,
		suppress: boolean,
	): TerminalTaskSnapshot {
		const result = this.mutate(id, (task) => {
			if (isTerminalTaskSettled(task.status)) return undefined;
			const now = this.timestamp(task);
			return {
				...task,
				status,
				updatedAt: now,
				settledAt: now,
				exitCode,
				observedAt: suppress ? now : undefined,
				consumedAt: suppress ? now : undefined,
				deliveryState: suppress ? "suppressed" : "pending",
				completionId: task.completionId ?? this.createCompletionId(),
			};
		});
		if (isTerminalTaskSettled(result.snapshot.status)) {
			this.clearPoll(id);
			capSettledLog(result.snapshot.logFile, this.logMaxBytes);
		}
		return result.snapshot;
	}

	private settleCancelled(id: string): TerminalTaskSnapshot {
		const result = this.mutate(id, (task) => {
			if (isTerminalTaskSettled(task.status)) return undefined;
			const now = this.timestamp(task);
			return {
				...task,
				status: "cancelled",
				updatedAt: now,
				settledAt: now,
				exitCode: null,
				observedAt: task.observedAt ?? now,
				consumedAt: task.consumedAt ?? now,
				deliveryState: "suppressed",
				completionId: task.completionId ?? this.createCompletionId(),
			};
		});
		if (result.snapshot.status === "cancelled") {
			this.clearPoll(id);
			capSettledLog(result.snapshot.logFile, this.logMaxBytes);
		}
		return result.snapshot;
	}

	private observe(id: string, consume: boolean): TerminalTaskSnapshot {
		return this.mutate(id, (task) => {
			if (!isTerminalTaskSettled(task.status)) return undefined;
			const deliveryState = task.deliveryState === "pending" || task.deliveryState === "claimed" ? "suppressed" : task.deliveryState;
			const needsObservation = task.observedAt === undefined;
			const needsConsumption = consume && task.consumedAt === undefined;
			const needsSuppression = deliveryState !== task.deliveryState;
			if (!needsObservation && !needsConsumption && !needsSuppression) return undefined;
			const now = this.timestamp(task);
			return {
				...task,
				updatedAt: now,
				observedAt: task.observedAt ?? now,
				consumedAt: consume ? task.consumedAt ?? now : task.consumedAt,
				deliveryState,
			};
		}).snapshot;
	}

	private async finishNaturalStop(
		id: string,
		identity: ProcessTreeIdentity,
		exitCode: number,
		signal: ProcessTreeSignalResult,
	): Promise<TerminalStopResult> {
		const gone = signal.gone || (signal.ok && await this.processTree.waitForTreeEmpty(identity, this.killGraceMs));
		if (!signal.ok || !gone) {
			if (!this.processTree.isTreeEmpty(identity)) return this.handleStopSignalFailure(id, signal, false);
		}
		const settled = this.settleNatural(id, exitCode);
		const observed = this.observe(id, false);
		return {
			id,
			outcome: "already-settled",
			task: observed,
			output: this.getOutput(observed, WAIT_OUTPUT_BYTES),
			message: `Terminal ${id} completed before its stop signal with exit ${settled.exitCode ?? "unknown"}.`,
		};
	}

	private async finishStop(
		id: string,
		identity: ProcessTreeIdentity,
		termSignal: ProcessTreeSignalResult,
		restoreOnFailure: boolean,
		verification?: ProcessTreeVerification,
	): Promise<TerminalStopResult> {
		if (!termSignal.ok) return this.handleStopSignalFailure(id, termSignal, restoreOnFailure);
		let empty = termSignal.gone || await this.processTree.waitForTreeEmpty(identity, this.termGraceMs);
		if (!empty) {
			const kill = await this.safeVerifiedSignal(identity, "SIGKILL", verification);
			if (!kill.ok) return this.handleStopSignalFailure(id, kill, restoreOnFailure);
			empty = kill.gone || await this.processTree.waitForTreeEmpty(identity, this.killGraceMs);
		}
		if (!empty) return this.failedStop(id, "process tree remains alive after SIGKILL", restoreOnFailure);
		const cancelled = this.settleCancelled(id);
		return {
			id,
			outcome: "cancelled",
			task: cancelled,
			output: this.getOutput(cancelled, WAIT_OUTPUT_BYTES),
			message: `Cancelled terminal ${id}.`,
		};
	}

	private handleStopSignalFailure(
		id: string,
		signal: ProcessTreeSignalResult,
		restoreOnFailure: boolean,
	): TerminalStopResult {
		const current = this.store.get(id);
		const identity = current ? identityOf(current) : undefined;
		if (identity && this.processTree.isTreeEmpty(identity)) {
			const cancelled = this.settleCancelled(id);
			return { id, outcome: "cancelled", task: cancelled, message: `Cancelled terminal ${id}.` };
		}
		if (signal.identityStatus === "different") {
			const lost = this.settleLost(id, null, false);
			return { id, outcome: "failed", task: lost, message: `Terminal ${id} process identity changed; recorded lost without signalling.` };
		}
		const reason = signal.identityStatus === "unknown"
			? "process identity could not be verified; refusing to signal"
			: signal.error ?? "process-tree signal failed";
		return this.failedStop(id, reason, restoreOnFailure);
	}

	private failedStop(id: string, reason: string, restore: boolean): TerminalStopResult {
		const result = restore
			? this.mutate(id, (task) => task.status === "stopping" ? { ...task, status: "running", updatedAt: this.timestamp(task) } : undefined).snapshot
			: this.store.get(id);
		if (restore && result && !isTerminalTaskSettled(result.status)) this.arm(id);
		if (!restore) this.diagnostic(id, `persisted stop remains pending: ${reason}`);
		return { id, outcome: "failed", task: result, message: `Failed to stop terminal ${id}: ${reason}.` };
	}

	private failUnlaunched(id: string, error: unknown): void {
		this.settleFailedLaunch(id);
		const current = this.store.get(id);
		if (current) appendPrivateFile(current.logFile, `\n[spawn error] ${error instanceof Error ? error.message : String(error)}\n`);
	}

	private settleFailedLaunch(id: string): TerminalTaskSnapshot {
		const result = this.mutate(id, (task) => {
			if (isTerminalTaskSettled(task.status)) return undefined;
			const now = this.timestamp(task);
			return {
				...task,
				status: "failed",
				updatedAt: now,
				settledAt: now,
				exitCode: null,
				observedAt: now,
				consumedAt: now,
				deliveryState: "suppressed",
				completionId: task.completionId ?? this.createCompletionId(),
			};
		});
		this.clearPoll(id);
		return result.snapshot;
	}

	private async handleChildError(id: string, error: Error): Promise<void> {
		if (this.detached) return;
		const current = this.store.get(id);
		if (!current || isTerminalTaskSettled(current.status)) return;
		this.adopt(current, false);
		const identity = identityOf(current);
		if (identity) {
			const identityStatus = this.processTree.identityMatches(identity);
			if (identityStatus === "different") {
				this.settleLost(id, null, false);
				return;
			}
			if (identityStatus === "unknown") {
				this.diagnostic(id, `child error left process tree unverifiable; refusing signal: ${error.message}`);
				return;
			}
			const terminated = await terminateProcessTree(this.processTree, identity, { termGraceMs: this.termGraceMs, killGraceMs: this.killGraceMs });
			if (!terminated) {
				this.diagnostic(id, `child error left process tree unverified: ${error.message}`);
				return;
			}
		}
		this.failUnlaunched(id, error);
	}

	private mutate(
		id: string,
		update: (current: TerminalTaskSnapshot) => Omit<TerminalTaskSnapshot, "revision"> | undefined,
	): MutationResult {
		let latest = this.store.get(id);
		if (!latest) throw new Error(`Unknown terminal task ${id}`);
		for (let attempt = 0; attempt < MAX_TRANSITION_RETRIES; attempt += 1) {
			this.adopt(latest, false);
			const next = update(latest);
			if (!next) return { snapshot: latest, changed: false };
			try {
				const transitioned = this.store.transition(id, latest.revision, () => next);
				this.adopt(transitioned, true);
				return { snapshot: transitioned, changed: true };
			} catch (error) {
				if (!(error instanceof StaleTerminalTaskRevisionError)) throw error;
				const reloaded = this.store.get(id);
				if (!reloaded) throw new Error(`Terminal task ${id} disappeared during transition`);
				latest = reloaded;
			}
		}
		this.diagnostic(id, "abandoned transition after repeated stale revisions");
		const current = this.store.get(id) ?? latest;
		this.adopt(current, false);
		return { snapshot: current, changed: false };
	}

	private adopt(snapshot: TerminalTaskSnapshot, notify: boolean): void {
		const previous = this.tasks.get(snapshot.id);
		this.tasks.set(snapshot.id, snapshot);
		this.ensureRuntime(snapshot);
		if (!notify || previous?.revision === snapshot.revision) return;
		for (const listener of this.listeners) {
			try {
				listener(snapshot);
			} catch {
				// Observers cannot break durable lifecycle transitions.
			}
		}
	}

	private clearPoll(id: string): void {
		const runtime = this.runtime.get(id);
		if (!runtime?.pollTimer) return;
		clearInterval(runtime.pollTimer);
		runtime.pollTimer = undefined;
	}

	private timestamp(task: TerminalTaskSnapshot): number {
		return Math.max(task.updatedAt, Math.max(1, Math.floor(this.now())));
	}

	private async safeVerifiedSignal(
		identity: ProcessTreeIdentity,
		signal: "SIGTERM" | "SIGKILL",
		verification?: ProcessTreeVerification,
	): Promise<ProcessTreeSignalResult> {
		try {
			return await signalVerifiedProcessTree(this.processTree, identity, signal, verification);
		} catch (error) {
			return { ok: false, gone: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private runGuarded(id: string, operation: string, run: () => Promise<void>): void {
		run().catch((error) => this.diagnostic(id, `${operation} failed safely: ${error instanceof Error ? error.message : String(error)}`));
	}

	private diagnostic(id: string, message: string): void {
		this.onDiagnostic?.({ kind: "manager", id, message });
	}
}

/** Historical internal name retained for source imports; callable bg tools are not retained. */
export { TerminalTaskManager as BackgroundTaskManager };
export type BackgroundTaskManagerOptions = TerminalTaskManagerOptions;
