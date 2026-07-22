import { randomUUID } from "node:crypto";
import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	systemProcessTree,
	type ProcessTreeIdentity,
	type ProcessTreeOperations,
	type ProcessTreeSignalResult,
	terminateProcessTree,
} from "./process-tree.js";
import { TerminalTaskStore, type TerminalTaskStoreDiagnostic } from "./task-store.js";
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
const CHECK_OUTPUT_BYTES = 16 * 1024;
const WAIT_OUTPUT_BYTES = 16 * 1024;

interface RuntimeTask {
	child?: ChildProcess;
	pollTimer?: ReturnType<typeof setInterval>;
	lastLogCapAt: number;
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
		launchFile: join(directory, "launch.ready"),
		windowsScriptFile: join(directory, "run.cmd"),
	};
}

function readExitCode(path: string): number | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const text = readFileSync(path, "utf8").trim();
		if (!/^-?\d+$/.test(text)) return undefined;
		return Number.parseInt(text, 10);
	} catch {
		return undefined;
	}
}

function readLogTail(path: string, maxBytes: number): string {
	if (!existsSync(path)) return "";
	let descriptor: number | undefined;
	try {
		const size = statSync(path).size;
		if (size === 0) return "";
		const bytes = Math.min(size, Math.max(0, maxBytes));
		const offset = size - bytes;
		descriptor = openSync(path, "r");
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
	try {
		if (existsSync(path) && statSync(path).size > maxBytes) truncateSync(path, 0);
	} catch {
		// Output bounding is best-effort and must not perturb process state.
	}
}

function capSettledLog(path: string, maxBytes: number): void {
	try {
		if (!existsSync(path) || statSync(path).size <= maxBytes) return;
		const marker = "[sumocode-terminal] log truncated to bounded tail\n";
		const tail = readLogTail(path, Math.max(0, maxBytes - Buffer.byteLength(marker)));
		writeFileSync(path, `${marker}${tail}`.slice(-maxBytes));
	} catch {
		// Output bounding is best-effort and must not perturb durable status.
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
		"set +e",
		`while [ ! -f ${shellEscape(options.launchFile)} ]; do sleep 0.01; done`,
		`cd ${shellEscape(options.cwd)} || { printf '%s\\n' ${shellEscape(`[sumocode-terminal] working directory unavailable: ${options.cwd}`)} >> ${shellEscape(options.logFile)}; printf '%s' 1 > ${shellEscape(options.exitFile)}; exit 1; }`,
		"set -o pipefail",
		"export SUMOCODE_BG_CHILD=1",
		"(",
		`  ${options.command}`,
		`) >> ${shellEscape(options.logFile)} 2>&1`,
		"code=$?",
		`printf '%s' "$code" > ${shellEscape(options.exitFile)}`,
		"exit \"$code\"",
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
		":wait_for_launch",
		`if not exist ${quoteWindows(options.launchFile)} (`,
		"  ping 127.0.0.1 -n 2 >nul",
		"  goto wait_for_launch",
		")",
		`cd /d ${quoteWindows(options.cwd)}`,
		`(${options.command}) >> ${quoteWindows(options.logFile)} 2>&1`,
		"set terminal_exit=%errorlevel%",
		`> ${quoteWindows(options.exitFile)} echo %terminal_exit%`,
		"exit /b %terminal_exit%",
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
		this.onDiagnostic = options.onDiagnostic;
		for (const snapshot of this.store.loadAll()) {
			this.tasks.set(snapshot.id, snapshot);
			this.runtime.set(snapshot.id, { lastLogCapAt: 0 });
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

		let id = this.createId();
		while (this.tasks.has(id)) id = this.createId();
		const createdAt = this.now();
		const paths = taskPaths(this.store, id, createdAt);
		mkdirSync(dirname(paths.logFile), { recursive: true });
		writeFileSync(paths.logFile, "");
		const scriptFile = process.platform === "win32" ? paths.windowsScriptFile : paths.scriptFile;
		writeFileSync(scriptFile, process.platform === "win32"
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
		this.tasks.set(id, initial);
		this.runtime.set(id, { lastLogCapAt: createdAt });

		let child: ChildProcess;
		try {
			child = this.spawn(
				process.platform === "win32" ? "cmd.exe" : "/bin/bash",
				process.platform === "win32" ? ["/d", "/s", "/c", scriptFile] : [scriptFile],
				{ cwd, detached: true, stdio: "ignore", env: { ...process.env, SUMOCODE_BG_CHILD: "1" } },
			);
		} catch (error) {
			this.failUnlaunched(initial, error);
			throw error;
		}
		this.runtime.get(id)!.child = child;
		child.on("error", (error) => { void this.handleChildError(id, error); });
		child.on("close", () => { void this.reconcile(id); });
		const pid = child.pid;
		if (pid === undefined) {
			this.failUnlaunched(this.tasks.get(id)!, new Error("spawn returned no process id"));
			throw new Error("Unable to start terminal: spawn returned no process id");
		}
		const processStartTime = this.processTree.captureStartTime(pid);
		const identity: ProcessTreeIdentity = { pid, processGroupId: pid, processStartTime: processStartTime ?? "" };
		if (!processStartTime) {
			const terminated = await terminateProcessTree(this.processTree, identity, { termGraceMs: this.termGraceMs, killGraceMs: this.killGraceMs });
			if (!terminated) throw new Error(`Unable to capture terminal process identity and unable to prove process group ${pid} terminated`);
			this.failUnlaunched(this.tasks.get(id)!, new Error("unable to capture process start time"));
			throw new Error("Unable to start terminal: process identity could not be captured");
		}

		let running: TerminalTaskSnapshot;
		try {
			running = this.transition(id, (current) => ({
				...current,
				status: "running",
				updatedAt: this.now(),
				pid,
				processGroupId: pid,
				processStartTime,
			}));
		} catch (error) {
			const terminated = await terminateProcessTree(this.processTree, identity, { termGraceMs: this.termGraceMs, killGraceMs: this.killGraceMs });
			if (!terminated) throw new Error(`Spawn identity persistence failed and process group ${pid} could not be proven terminated`);
			throw error;
		}

		try {
			writeFileSync(paths.launchFile, "ready\n", { flag: "wx" });
		} catch (error) {
			const terminated = await terminateProcessTree(this.processTree, identity, { termGraceMs: this.termGraceMs, killGraceMs: this.killGraceMs });
			if (!terminated) throw new Error(`Terminal launch release failed and process group ${pid} could not be proven terminated`);
			this.transition(id, (current) => ({
				...current,
				status: "failed",
				updatedAt: this.now(),
				settledAt: this.now(),
				exitCode: null,
				observedAt: this.now(),
				consumedAt: this.now(),
				deliveryState: "suppressed",
				completionId: current.completionId ?? this.createCompletionId(),
			}));
			throw error;
		}
		child.unref();
		this.arm(running.id);
		return running;
	}

	public list(ownerSessionId: string): TerminalTaskSnapshot[] {
		return [...this.tasks.values()]
			.filter((task) => task.ownerSessionId === ownerSessionId)
			.sort((left, right) => right.createdAt - left.createdAt);
	}

	public get(id: string, ownerSessionId: string): TerminalTaskSnapshot | undefined {
		const task = this.tasks.get(id);
		return task?.ownerSessionId === ownerSessionId ? task : undefined;
	}

	public check(id: string, ownerSessionId: string): TerminalTaskObservation | undefined {
		const current = this.get(id, ownerSessionId);
		if (!current) return undefined;
		const task = isTerminalTaskSettled(current.status) ? this.observe(current, false) : current;
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
		const unknownIds = uniqueIds.filter((id) => !known.includes(id));
		const complete = (): boolean => known.every((id) => {
			const task = this.get(id, ownerSessionId);
			return task !== undefined && isTerminalTaskSettled(task.status);
		});
		if (!complete() && timeoutMs > 0) {
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const finish = (error?: Error): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					unsubscribe();
					signal?.removeEventListener("abort", onAbort);
					error ? reject(error) : resolve();
				};
				const onAbort = (): void => finish(abortError());
				const unsubscribe = this.addChangeListener(() => { if (complete()) finish(); });
				const timer = setTimeout(() => finish(), timeoutMs);
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
			const task = this.observe(current, true);
			settled.push({ task, output: this.getOutput(task, WAIT_OUTPUT_BYTES) });
		}
		return { settled, pendingIds, unknownIds, timedOut: pendingIds.length > 0 };
	}

	public async stop(ids: readonly string[], ownerSessionId: string): Promise<TerminalStopResult[]> {
		const uniqueIds = [...new Set(ids)];
		const results = new Map<string, TerminalStopResult>();
		const targets: Array<{ task: TerminalTaskSnapshot; identity: ProcessTreeIdentity }> = [];
		for (const id of uniqueIds) {
			const current = this.get(id, ownerSessionId);
			if (!current) {
				results.set(id, { id, outcome: "unknown", message: `Unknown terminal ${id}.` });
				continue;
			}
			if (isTerminalTaskSettled(current.status)) {
				const observed = this.observe(current, false);
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
			const stopping = current.status === "stopping" ? current : this.transition(id, (task) => ({ ...task, status: "stopping", updatedAt: this.now() }));
			targets.push({ task: stopping, identity });
		}

		// Start every SIGTERM/taskkill operation before awaiting any target's
		// grace period. This keeps batch stop from serially delaying later tasks.
		const termSignals = await Promise.all(targets.map(({ identity }) => this.processTree.signalTree(identity, "SIGTERM")));
		await Promise.all(targets.map(async ({ task, identity }, index) => {
			const result = await this.finishStop(task, identity, termSignals[index]!);
			results.set(task.id, result);
		}));
		return uniqueIds.map((id) => results.get(id)!);
	}

	public claimPending(ownerSessionId: string, includeWake: boolean, maxWake = 1): TerminalTaskSnapshot[] {
		const claimed: TerminalTaskSnapshot[] = [];
		let claimedWake = 0;
		for (const candidate of this.list(ownerSessionId)) {
			if (!isTerminalTaskSettled(candidate.status)) continue;
			let current = candidate;
			if (current.deliveryState === "claimed" && this.now() - current.updatedAt >= this.claimLeaseMs) {
				current = this.transition(current.id, (task) => ({ ...task, deliveryState: "pending", updatedAt: this.now() }));
			}
			if (current.deliveryState !== "pending") continue;
			if (current.completionPolicy === "wake") {
				if (!includeWake || claimedWake >= maxWake) continue;
				claimedWake += 1;
			}
			claimed.push(this.transition(current.id, (task) => ({ ...task, deliveryState: "claimed", updatedAt: this.now() })));
		}
		return claimed;
	}

	public acknowledge(ownerSessionId: string, completionIds: ReadonlySet<string>): TerminalTaskSnapshot[] {
		const acknowledged: TerminalTaskSnapshot[] = [];
		for (const current of this.list(ownerSessionId)) {
			if (!current.completionId || !completionIds.has(current.completionId)) continue;
			if (current.deliveryState === "delivered" || current.deliveryState === "suppressed") continue;
			acknowledged.push(this.transition(current.id, (task) => ({ ...task, deliveryState: "delivered", updatedAt: this.now() })));
		}
		return acknowledged;
	}

	public getClaimLeaseMs(): number {
		return this.claimLeaseMs;
	}

	public addChangeListener(listener: TerminalTaskChangeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	public getOutput(task: Pick<TerminalTaskSnapshot, "logFile">, maxBytes = CHECK_OUTPUT_BYTES): string {
		return readLogTail(task.logFile, maxBytes);
	}

	public async stopOwned(ownerSessionId: string): Promise<TerminalStopResult[]> {
		const running = this.list(ownerSessionId).filter((task) => !isTerminalTaskSettled(task.status));
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
		const identity = identityOf(snapshot);
		if (!identity) {
			this.settle(snapshot.id, "lost", null, true);
			return;
		}
		const paths = taskPaths(this.store, snapshot.id, snapshot.createdAt);
		if (snapshot.status === "running" && !existsSync(paths.launchFile)) {
			try {
				writeFileSync(paths.launchFile, "recovered\n", { flag: "wx" });
			} catch (error) {
				this.onDiagnostic?.({ kind: "manager", id: snapshot.id, message: `unable to release recovered launch gate: ${error instanceof Error ? error.message : String(error)}` });
			}
		}
		this.arm(snapshot.id);
		void this.reconcile(snapshot.id);
	}

	private arm(id: string): void {
		const runtime = this.runtime.get(id);
		if (!runtime || runtime.pollTimer || this.detached) return;
		runtime.pollTimer = setInterval(() => { void this.reconcile(id); }, this.pollIntervalMs);
		runtime.pollTimer.unref?.();
	}

	private async reconcile(id: string): Promise<void> {
		const current = this.tasks.get(id);
		if (!current || isTerminalTaskSettled(current.status)) return;
		const runtime = this.runtime.get(id);
		if (runtime && this.now() - runtime.lastLogCapAt >= 5_000) {
			capRunningLog(current.logFile, this.logMaxBytes);
			runtime.lastLogCapAt = this.now();
		}
		const identity = identityOf(current);
		if (!identity) {
			this.settle(id, "lost", null, true);
			return;
		}
		if (current.status === "stopping") return;
		const paths = taskPaths(this.store, current.id, current.createdAt);
		const exitCode = readExitCode(paths.exitFile);
		if (exitCode !== undefined && this.processTree.isTreeEmpty(identity)) {
			this.settle(id, exitCode === 0 ? "completed" : "failed", exitCode, false);
			return;
		}
		const identityStatus = this.processTree.identityMatches(identity);
		if (identityStatus === "different" && this.processTree.isTreeEmpty(identity)) {
			this.settle(id, "lost", exitCode ?? null, false);
		}
	}

	private settle(id: string, status: "completed" | "failed" | "lost", exitCode: number | null, suppress: boolean): TerminalTaskSnapshot {
		const current = this.tasks.get(id);
		if (!current || isTerminalTaskSettled(current.status)) return current!;
		this.clearPoll(id);
		capSettledLog(current.logFile, this.logMaxBytes);
		const now = this.now();
		return this.transition(id, (task) => ({
			...task,
			status,
			updatedAt: now,
			settledAt: now,
			exitCode,
			observedAt: suppress ? now : task.observedAt,
			consumedAt: suppress ? now : task.consumedAt,
			deliveryState: suppress ? "suppressed" : "pending",
			completionId: task.completionId ?? this.createCompletionId(),
		}));
	}

	private observe(current: TerminalTaskSnapshot, consume: boolean): TerminalTaskSnapshot {
		if (!isTerminalTaskSettled(current.status)) return current;
		const now = this.now();
		return this.transition(current.id, (task) => ({
			...task,
			updatedAt: now,
			observedAt: task.observedAt ?? now,
			consumedAt: consume ? task.consumedAt ?? now : task.consumedAt,
			deliveryState: task.deliveryState === "pending" || task.deliveryState === "claimed" ? "suppressed" : task.deliveryState,
		}));
	}

	private async finishStop(
		stopping: TerminalTaskSnapshot,
		identity: ProcessTreeIdentity,
		termSignal: ProcessTreeSignalResult,
	): Promise<TerminalStopResult> {
		if (!termSignal.ok) return this.failedStop(stopping, termSignal.error ?? "SIGTERM failed");
		let empty = termSignal.gone || await this.processTree.waitForTreeEmpty(identity, this.termGraceMs);
		if (!empty) {
			const kill = await this.processTree.signalTree(identity, "SIGKILL");
			if (!kill.ok) return this.failedStop(stopping, kill.error ?? "SIGKILL failed");
			empty = kill.gone || await this.processTree.waitForTreeEmpty(identity, this.killGraceMs);
		}
		if (!empty || !this.processTree.isTreeEmpty(identity)) {
			return this.failedStop(stopping, "process group remains alive after SIGKILL");
		}
		this.clearPoll(stopping.id);
		capSettledLog(stopping.logFile, this.logMaxBytes);
		const now = this.now();
		const cancelled = this.transition(stopping.id, (task) => ({
			...task,
			status: "cancelled",
			updatedAt: now,
			settledAt: now,
			exitCode: null,
			observedAt: task.observedAt ?? now,
			consumedAt: task.consumedAt ?? now,
			deliveryState: "suppressed",
			completionId: task.completionId ?? this.createCompletionId(),
		}));
		return {
			id: stopping.id,
			outcome: "cancelled",
			task: cancelled,
			output: this.getOutput(cancelled, WAIT_OUTPUT_BYTES),
			message: `Cancelled terminal ${stopping.id}.`,
		};
	}

	private failedStop(stopping: TerminalTaskSnapshot, reason: string): TerminalStopResult {
		const current = this.tasks.get(stopping.id);
		const task = current?.status === "stopping"
			? this.transition(stopping.id, (value) => ({ ...value, status: "running", updatedAt: this.now() }))
			: current ?? stopping;
		this.arm(stopping.id);
		return { id: stopping.id, outcome: "failed", task, message: `Failed to stop terminal ${stopping.id}: ${reason}.` };
	}

	private failUnlaunched(current: TerminalTaskSnapshot, error: unknown): void {
		const now = this.now();
		this.transition(current.id, (task) => ({
			...task,
			status: "failed",
			updatedAt: now,
			settledAt: now,
			exitCode: null,
			observedAt: now,
			consumedAt: now,
			deliveryState: "suppressed",
			completionId: task.completionId ?? this.createCompletionId(),
		}));
		try {
			writeFileSync(current.logFile, `\n[spawn error] ${error instanceof Error ? error.message : String(error)}\n`, { flag: "a" });
		} catch {
			// The durable failed record remains the source of truth.
		}
	}

	private async handleChildError(id: string, error: Error): Promise<void> {
		const current = this.tasks.get(id);
		if (!current || isTerminalTaskSettled(current.status)) return;
		const identity = identityOf(current);
		if (identity) {
			const terminated = await terminateProcessTree(this.processTree, identity, { termGraceMs: this.termGraceMs, killGraceMs: this.killGraceMs });
			if (!terminated) {
				this.onDiagnostic?.({ kind: "manager", id, message: `child error left process tree unverified: ${error.message}` });
				return;
			}
		}
		this.failUnlaunched(current, error);
	}

	private transition(
		id: string,
		update: (current: TerminalTaskSnapshot) => Omit<TerminalTaskSnapshot, "revision">,
	): TerminalTaskSnapshot {
		const current = this.tasks.get(id);
		if (!current) throw new Error(`Unknown terminal task ${id}`);
		const next = this.store.transition(id, current.revision, update);
		this.tasks.set(id, next);
		for (const listener of this.listeners) {
			try {
				listener(next);
			} catch {
				// Observers cannot break durable lifecycle transitions.
			}
		}
		return next;
	}

	private clearPoll(id: string): void {
		const runtime = this.runtime.get(id);
		if (!runtime?.pollTimer) return;
		clearInterval(runtime.pollTimer);
		runtime.pollTimer = undefined;
	}
}

/** Historical internal name retained for source imports; callable bg tools are not retained. */
export { TerminalTaskManager as BackgroundTaskManager };
export type BackgroundTaskManagerOptions = TerminalTaskManagerOptions;
