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
import { fileURLToPath } from "node:url";
import { isNativeRuntime } from "../native/paths.js";
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
	type TerminalTaskIndexRefreshResult,
	type TerminalTaskStoreDiagnostic,
} from "./task-store.js";
import {
	TERMINAL_TASK_SCHEMA_VERSION,
	isTerminalTaskSettled,
	type StartTerminalTaskOptions,
	type TerminalCompletionPolicy,
	type TerminalDeliveryReceipt,
	type TerminalDeliveryState,
	type TerminalStopResult,
	type TerminalTaskObservation,
	type TerminalTaskSnapshot,
	type TerminalTaskStatus,
	type TerminalWaitResult,
} from "./task-types.js";
import { buildVisibleTaskPaths, shellEscape } from "./visible-spawn.js";

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_LOG_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TERM_GRACE_MS = 5_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_CLAIM_LEASE_MS = 30_000;
const DEFAULT_STARTING_RECOVERY_GRACE_MS = 30_000;
const MAX_REPLAYED_SETTLED_TERMINALS = 64;
const BOUNDED_TERMINAL_RUNNER_FILE = fileURLToPath(new URL("./bounded-terminal-runner.mjs", import.meta.url));

/**
 * Plan 117 seam 3: how the generated script launches the bounded terminal
 * runner. Dev keeps `node + bounded-terminal-runner.mjs` byte-for-byte; the
 * native binary embeds the runner behind the `--sumocode-terminal-runner`
 * argv role (handled by src/native/main.ts before anything else).
 */
export function resolveTerminalRunnerInvocation(env: NodeJS.ProcessEnv = process.env): {
	readonly command: string;
	readonly args: readonly string[];
} {
	if (isNativeRuntime(env)) {
		return { command: process.execPath, args: ["--sumocode-terminal-runner"] };
	}
	return { command: process.execPath, args: [BOUNDED_TERMINAL_RUNNER_FILE] };
}

export interface TerminalOutputTail {
	readonly bytes: Uint8Array;
	readonly truncated: boolean;
}
const TREE_VERIFICATION_REFRESH_MS = 5_000;
const CHECK_OUTPUT_BYTES = 16 * 1024;
const WAIT_OUTPUT_BYTES = 16 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_TRANSITION_RETRIES = 16;
/**
 * Base of the escalating injectable-clock backoff between lazy
 * index-initialization retry attempts: the first retry after an unsuccessful
 * attempt waits this long, and each further consecutive failed or incomplete
 * attempt doubles the wait up to INDEX_INIT_RETRY_BACKOFF_MAX_MS, so a
 * chronically unreadable or incomplete store is not rescanned by every
 * query/mutation entry point while the projection stays unseeded.
 */
const INDEX_INIT_RETRY_BACKOFF_MS = 1_000;
/** Upper bound of the escalating init-retry backoff schedule. */
const INDEX_INIT_RETRY_BACKOFF_MAX_MS = 60_000;

interface RuntimeTask {
	child?: ChildProcess;
	pollTimer?: ReturnType<typeof setInterval>;
	reconcilePromise?: Promise<void>;
	treeVerification?: ProcessTreeVerification;
	lastTreeVerificationAt: number;
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
	readonly createClaimToken?: () => string;
	readonly pollIntervalMs?: number;
	readonly logMaxBytes?: number;
	readonly termGraceMs?: number;
	readonly killGraceMs?: number;
	readonly claimLeaseMs?: number;
	readonly startingRecoveryGraceMs?: number;
	readonly onDiagnostic?: (diagnostic: TerminalTaskStoreDiagnostic | { kind: "manager"; message: string; id?: string }) => void;
	/** Test-only spy: invoked once per fresh snapshot `refreshSnapshotsFromStore` adopts. */
	readonly onRefreshAdopt?: (id: string) => void;
	/** Test-only spy: invoked once per snapshot whose recovery work (log cap/launch gate/arm/reconcile) `refreshSnapshotsFromStore` actually runs. */
	readonly onRefreshRecover?: (id: string) => void;
}

export type TerminalTaskChangeListener = (snapshot: TerminalTaskSnapshot) => void;
export type TerminalTaskSnapshotListener = (snapshots: readonly TerminalTaskSnapshot[]) => void;

function normalizePositive(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Compare a Node rejection's errno without unwrapping arbitrary payloads. */
function errnoIs(error: Error, code: string): boolean {
	// SAFETY: the fs helpers here reject with NodeJS.ErrnoException whose optional `code` carries the errno string.
	return (error as NodeJS.ErrnoException).code === code;
}

function taskPaths(store: TerminalTaskStore, id: string, createdAt: number) {
	const visiblePaths = buildVisibleTaskPaths(id, createdAt, store.rootDir);
	const directory = dirname(visiblePaths.logFile);
	return {
		...visiblePaths,
		directory,
		launchFile: join(directory, "launch.ready"),
		commandFile: join(directory, process.platform === "win32" ? "command.cmd" : "command.sh"),
		windowsScriptFile: join(directory, "run.cmd"),
	};
}

function openPrivateFile(store: TerminalTaskStore, path: string, flags: number): number {
	return store.openArtifact(path, flags);
}

function createPrivateFile(store: TerminalTaskStore, path: string, contents: string): void {
	store.assertTaskDirectory(dirname(path));
	const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, PRIVATE_FILE_MODE);
	try {
		fchmodSync(descriptor, PRIVATE_FILE_MODE);
		writeFileSync(descriptor, contents, "utf8");
	} finally {
		closeSync(descriptor);
	}
	const verified = store.openArtifact(path, constants.O_RDONLY);
	closeSync(verified);
}

function createPrivateTaskDirectory(store: TerminalTaskStore, path: string): void {
	mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
	chmodSync(path, PRIVATE_DIRECTORY_MODE);
	store.assertTaskDirectory(path);
}

function readExitCode(store: TerminalTaskStore, path: string): number | undefined {
	let descriptor: number | undefined;
	try {
		descriptor = openPrivateFile(store, path, constants.O_RDONLY);
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

function immutableTerminalSnapshot(snapshot: TerminalTaskSnapshot): TerminalTaskSnapshot {
	const clone = structuredClone(snapshot);
	const freeze = <T extends object>(value: T): void => {
		if (Object.isFrozen(value)) return;
		for (const child of Object.values(value)) {
			if (child !== null && child instanceof Object) freeze(child);
		}
		Object.freeze(value);
	};
	freeze(clone);
	return clone;
}

function readLogTailBytes(store: TerminalTaskStore, path: string, maxBytes: number): TerminalOutputTail {
	let descriptor: number | undefined;
	try {
		descriptor = openPrivateFile(store, path, constants.O_RDONLY);
		const size = fstatSync(descriptor).size;
		if (size === 0) return { bytes: new Uint8Array(), truncated: false };
		const bytes = Math.min(size, Math.max(0, maxBytes));
		const buffer = Buffer.alloc(bytes);
		const bytesRead = readSync(descriptor, buffer, 0, bytes, size - bytes);
		return { bytes: buffer.subarray(0, bytesRead), truncated: size > bytes };
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function readLogTail(store: TerminalTaskStore, path: string, maxBytes: number): string {
	let descriptor: number | undefined;
	try {
		descriptor = openPrivateFile(store, path, constants.O_RDONLY);
		const size = fstatSync(descriptor).size;
		if (size === 0) return "";
		const bytes = Math.min(size, Math.max(0, maxBytes));
		const offset = size - bytes;
		const buffer = Buffer.alloc(bytes);
		const bytesRead = readSync(descriptor, buffer, 0, bytes, offset);
		let text = buffer.subarray(0, bytesRead).toString("utf8");
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

function capSettledLog(store: TerminalTaskStore, path: string, maxBytes: number): void {
	try {
		let descriptor = openPrivateFile(store, path, constants.O_RDONLY);
		const size = fstatSync(descriptor).size;
		closeSync(descriptor);
		if (size <= maxBytes) return;
		const marker = "[sumocode-terminal] log truncated to bounded tail\n";
		const tail = readLogTail(store, path, Math.max(0, maxBytes - Buffer.byteLength(marker)));
		descriptor = openPrivateFile(store, path, constants.O_WRONLY);
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

function appendPrivateFile(store: TerminalTaskStore, path: string, contents: string): void {
	let descriptor: number | undefined;
	try {
		descriptor = openPrivateFile(store, path, constants.O_WRONLY | constants.O_APPEND);
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

function sameTreeVerification(left: ProcessTreeVerification | undefined, right: ProcessTreeVerification | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	if (left.members.length !== right.members.length) return false;
	return left.members.every((anchor, index) => {
		const candidate = right.members[index];
		return candidate?.pid === anchor.pid && candidate.processStartTime === anchor.processStartTime;
	});
}

/**
 * Shallow content compare of compact snapshot fields: strict equality per
 * field in both directions, with a missing key treated as an `undefined`
 * value (in-memory snapshots can carry explicit-`undefined` keys that a
 * re-parse omits) and the single nested field (`processTreeVerification`)
 * compared by its small member-anchor list. No deep JSON of large payloads —
 * used to report adoption-only stored-state changes at the refresh boundary.
 */
function snapshotContentEquals(left: TerminalTaskSnapshot, right: TerminalTaskSnapshot): boolean {
	for (const pass of [left, right] as const) {
		const other = pass === left ? right : left;
		// SAFETY: Object.keys of a snapshot yields exactly the interface's own property names; the cast only restores the keyof view.
		for (const key of Object.keys(pass) as Array<keyof TerminalTaskSnapshot>) {
			if (key === "processTreeVerification") {
				if (!sameTreeVerification(left.processTreeVerification, right.processTreeVerification)) return false;
				continue;
			}
			if (pass[key] !== other[key]) return false;
		}
	}
	return true;
}

function buildPosixScript(options: {
	readonly cwd: string;
	readonly launchFile: string;
	readonly commandFile: string;
	readonly logFile: string;
	readonly exitFile: string;
	readonly logMaxBytes: number;
}): string {
	// Plan 117 seam 3: dev resolves to node + bounded-terminal-runner.mjs
	// (byte-identical to the pre-seam script); native to <self>
	// --sumocode-terminal-runner.
	const runner = resolveTerminalRunnerInvocation();
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
		"  export SUMOCODE_BG_CHILD=1",
		`  ${shellEscape(runner.command)} ${runner.args.map(shellEscape).join(" ")} posix ${shellEscape(options.commandFile)} ${shellEscape(options.logFile)} ${options.logMaxBytes}`,
		"  code=$?",
		"fi",
		`printf '%s' "$code" > ${shellEscape(options.exitFile)}`,
		// Retain the verified group leader until the manager disposes the complete
		// tree and records the command's already-captured natural exit code.
		"while :; do sleep 1; done",
	].join("\n");
}

function quoteWindows(value: string): string {
	return `"${value.replace(/%/g, "%%").replace(/"/g, '""')}"`;
}

function buildWindowsScript(options: {
	readonly cwd: string;
	readonly launchFile: string;
	readonly commandFile: string;
	readonly logFile: string;
	readonly exitFile: string;
	readonly logMaxBytes: number;
}): string {
	return [
		"@echo off",
		"set launch_wait=0",
		":wait_for_launch",
		`if exist ${quoteWindows(options.launchFile)} goto launch_ready`,
		"set /a launch_wait+=1",
		"if %launch_wait% GEQ 30 goto launch_timeout",
		"ping 127.0.0.1 -n 2 >nul",
		"goto wait_for_launch",
		":launch_timeout",
		`>> ${quoteWindows(options.logFile)} echo [sumocode-terminal] launch gate timed out`,
		`> ${quoteWindows(options.exitFile)} echo 125`,
		"exit /b 125",
		":launch_ready",
		`cd /d ${quoteWindows(options.cwd)}`,
		"if errorlevel 1 (",
		`  >> ${quoteWindows(options.logFile)} echo [sumocode-terminal] working directory unavailable`,
		`  > ${quoteWindows(options.exitFile)} echo 1`,
		"  goto wait_for_tree_reconcile",
		")",
		`${quoteWindows(process.execPath)} ${quoteWindows(BOUNDED_TERMINAL_RUNNER_FILE)} win32 ${quoteWindows(options.commandFile)} ${quoteWindows(options.logFile)} ${options.logMaxBytes}`,
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

/** Eligibility fields shared verbatim by compact index entries and full snapshots. */
interface DeliveryEligibility {
	readonly ownerSessionId: string;
	readonly status: TerminalTaskStatus;
	readonly deliveryState: TerminalDeliveryState;
	readonly completionPolicy: TerminalCompletionPolicy;
	readonly updatedAt: number;
	readonly completionId?: string;
	readonly deliveryClaimToken?: string;
}

/**
 * Single claimability policy. The compact prefilter and the authoritative
 * locked-snapshot closure must agree on owner, settlement, delivery state,
 * claim-lease expiry, and the wake-claim cap without restating any rule.
 */
function isClaimable(
	task: DeliveryEligibility,
	ownerSessionId: string,
	includeWake: boolean,
	wakeClaimsUsed: number,
	maxWake: number,
	now: number,
	claimLeaseMs: number,
): boolean {
	if (task.ownerSessionId !== ownerSessionId) return false;
	if (!isTerminalTaskSettled(task.status)) return false;
	const claimLeaseExpired = task.deliveryState === "claimed" && now - task.updatedAt >= claimLeaseMs;
	if (task.deliveryState !== "pending" && !claimLeaseExpired) return false;
	if (task.completionPolicy === "wake" && (!includeWake || wakeClaimsUsed >= maxWake)) return false;
	return true;
}

/**
 * Single acknowledgement-matching policy: owner plus claimed delivery state
 * plus the exact completionId/claimToken receipt pair.
 */
function isAcknowledgementMatch(task: DeliveryEligibility, ownerSessionId: string, receiptKeys: ReadonlySet<string>): boolean {
	if (task.ownerSessionId !== ownerSessionId) return false;
	if (task.deliveryState !== "claimed") return false;
	if (task.completionId === undefined || task.deliveryClaimToken === undefined) return false;
	return receiptKeys.has(`${task.completionId}\u0000${task.deliveryClaimToken}`);
}

/**
 * True when two snapshots differ in a delivery-eligibility or receipt field the
 * claim/acknowledgement predicates above read that the refresh recovery gate
 * does not already cover: deliveryState, completionPolicy, completionId, and
 * deliveryClaimToken — plus `updatedAt` whenever either side is a claimed
 * record. (Owner, status, and process identity gate recovery directly.) For a
 * claimed record `updatedAt` IS the claim-lease clock both `isClaimable` and
 * `getClaimRetryDelay` read: an external rewrite moving it backward advances
 * lease expiry sooner than the coordinator's armed retry timer, which was
 * computed from the newer timestamp and would otherwise postpone an
 * already-eligible completion for the stale delay remainder, so any
 * `updatedAt` change on a claimed (old or new) record must reach the per-task
 * fan-out and let the coordinator recompute `syncLeaseRetry` from the fresher
 * timestamp. An `updatedAt` move on a non-claimed record shifts no lease
 * decision and stays cosmetic. Such differences change whether a completion is
 * deliverable without changing recovery-relevant identity, so they must reach
 * the per-task fan-out: the `TerminalDeliveryCoordinator` listens for per-task
 * change notifications only.
 */
function deliveryEligibilityChanged(previous: TerminalTaskSnapshot, snapshot: TerminalTaskSnapshot): boolean {
	if (previous.deliveryState !== snapshot.deliveryState
		|| previous.completionPolicy !== snapshot.completionPolicy
		|| previous.completionId !== snapshot.completionId
		|| previous.deliveryClaimToken !== snapshot.deliveryClaimToken) return true;
	return previous.updatedAt !== snapshot.updatedAt
		&& (previous.deliveryState === "claimed" || snapshot.deliveryState === "claimed");
}

/**
 * Recovery-relevant durable identity gate shared by the refresh loops and the
 * locked no-op adoption site: a record new to this projection, or one whose
 * revision, owner, lifecycle status, or process identity changed, pays recovery
 * side effects again (settled log cap, launch-gate release, arm, reconcile
 * scheduling) and is waiter/delivery-relevant. Revision plus owner alone miss
 * an external same-revision, same-owner rewrite that flips status or process
 * identity (e.g. settled retained vs running on disk), which would leave an
 * active terminal unarmed behind a stale projection; a deep full content
 * compare is still avoided, so a pure same-revision, same-owner content rewrite
 * is adopted with no recovery side effects.
 */
function recoveryRelevantAdoption(previous: TerminalTaskSnapshot | undefined, snapshot: TerminalTaskSnapshot): boolean {
	return previous === undefined
		|| previous.revision !== snapshot.revision
		|| previous.ownerSessionId !== snapshot.ownerSessionId
		|| previous.status !== snapshot.status
		|| previous.pid !== snapshot.pid
		|| previous.processGroupId !== snapshot.processGroupId
		|| previous.processStartTime !== snapshot.processStartTime;
}

export class TerminalTaskManager {
	private readonly store: TerminalTaskStore;
	private readonly processTree: ProcessTreeOperations;
	private readonly spawn: typeof spawnChild;
	private readonly now: () => number;
	private readonly createId: () => string;
	private readonly createCompletionId: () => string;
	private readonly createClaimToken: () => string;
	private readonly pollIntervalMs: number;
	private readonly logMaxBytes: number;
	private readonly termGraceMs: number;
	private readonly killGraceMs: number;
	private readonly claimLeaseMs: number;
	private readonly startingRecoveryGraceMs: number;
	private readonly onDiagnostic?: TerminalTaskManagerOptions["onDiagnostic"];
	private readonly onRefreshAdopt?: (id: string) => void;
	private readonly onRefreshRecover?: (id: string) => void;
	private readonly tasks = new Map<string, TerminalTaskSnapshot>();
	private readonly runtime = new Map<string, RuntimeTask>();
	private readonly listeners = new Set<TerminalTaskChangeListener>();
	private readonly snapshotListeners = new Set<TerminalTaskSnapshotListener>();
	/** Open while a refresh batch is running: notifyChanges queues instead of publishing. */
	private refreshBatchDepth = 0;
	/** Per-task changes queued while a refresh batch is open, deduped to the latest snapshot per id. */
	private readonly refreshBatchQueued = new Map<string, TerminalTaskSnapshot>();
	/**
	 * Set when publishProjection is called while a refresh batch is open: the
	 * publication defers to the batch close, whose single fan-out supersedes any
	 * intermediate projection. No current in-batch path publishes directly, so
	 * this is batch-safety future-proofing for sync-in-batch mutation paths.
	 */
	private projectionPublishDeferred = false;
	private detached = false;
	/**
	 * False until one complete successful scan seeds the retained projection
	 * generation. An incomplete successful scan (a candidate unknown to the
	 * prior index hit a transient read) serves its indexed generation
	 * immediately but keeps this false so init retries stay armed until a
	 * complete scan lands.
	 */
	private indexInitialized = false;
	/** True while the lazy seeding scan runs, so a listener fanned out by it cannot re-enter. */
	private indexInitInFlight = false;
	/** Injectable-clock stamp of the last lazy init retry; further attempts back off. */
	private indexInitLastAttemptAt = Number.NEGATIVE_INFINITY;
	/** Consecutive lazy init retries that left the index incomplete or failed; drives the doubling. */
	private indexInitFailedAttempts = 0;
	/** Backoff the next lazy init retry must wait since the last attempt; reset by a complete scan. */
	private indexInitBackoffMs = INDEX_INIT_RETRY_BACKOFF_MS;
	/** Init-scan failures are diagnosed once per episode kind; a failed⇄incomplete transition re-diagnoses once and the first complete scan resets the dedupe. */
	private indexInitDiagnosedKind: "failed" | "incomplete" | undefined;
	/** One idle retry that wakes an uninitialized index at the current backoff boundary. */
	private indexInitRetryTimer: ReturnType<typeof setTimeout> | undefined;
	private indexInitRetryDueAt: number | undefined;

	public constructor(options: TerminalTaskManagerOptions = {}) {
		this.store = options.store ?? new TerminalTaskStore({ onDiagnostic: options.onDiagnostic });
		this.processTree = options.processTree ?? systemProcessTree;
		this.spawn = options.spawn ?? spawnChild;
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? (() => `term-${this.now().toString(36)}-${randomUUID().slice(0, 8)}`);
		this.createCompletionId = options.createCompletionId ?? (() => `completion-${randomUUID()}`);
		this.createClaimToken = options.createClaimToken ?? (() => `claim-${randomUUID()}`);
		this.pollIntervalMs = normalizePositive(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
		this.logMaxBytes = normalizePositive(options.logMaxBytes, DEFAULT_LOG_MAX_BYTES);
		this.termGraceMs = normalizePositive(options.termGraceMs, DEFAULT_TERM_GRACE_MS);
		this.killGraceMs = normalizePositive(options.killGraceMs, DEFAULT_KILL_GRACE_MS);
		this.claimLeaseMs = normalizePositive(options.claimLeaseMs, DEFAULT_CLAIM_LEASE_MS);
		this.startingRecoveryGraceMs = normalizePositive(options.startingRecoveryGraceMs, DEFAULT_STARTING_RECOVERY_GRACE_MS);
		this.onDiagnostic = options.onDiagnostic;
		this.onRefreshAdopt = options.onRefreshAdopt;
		this.onRefreshRecover = options.onRefreshRecover;
		// Plan 080 makes completed snapshots durable and explicitly forbids file
		// deletion/cleanup without human approval. Do not revive the legacy
		// recovery-time artifact pruning here: retention/GC needs its own approved
		// policy that cannot erase pending, claimed, or still-queryable results.
		const initializationAttemptAt = Math.max(1, Math.floor(this.now()));
		const initialization = this.store.refreshIndex();
		if (initialization.ok) {
			// An incomplete successful scan — any candidate hit a transient read or
			// directory-validation failure — seeds and serves the indexed generation
			// immediately but keeps init-retry state armed so a later complete scan
			// freshly reads the skipped/preserved record; only a complete scan starts
			// fully initialized and stops the retries.
			this.indexInitialized = initialization.complete;
			for (const snapshot of initialization.snapshots) {
				this.adopt(snapshot, false);
				this.recover(snapshot);
			}
			if (!initialization.complete) {
				this.diagnoseIndexInitFailure(true);
				this.scheduleIndexInitRetryTimer(initializationAttemptAt);
			}
		} else {
			// A transient scan failure must not permanently seed an empty generation:
			// the projection stays uninitialized and query/mutation entry points
			// retry the scan lazily (ensureIndexInitialized) until the first success
			// seeds it exactly like a successful refresh.
			this.diagnoseIndexInitFailure();
			this.scheduleIndexInitRetryTimer(initializationAttemptAt);
		}
	}

	public async start(options: StartTerminalTaskOptions): Promise<TerminalTaskSnapshot> {
		if (this.detached) throw new Error("Terminal task manager is detached");
		const command = options.command.trim();
		const title = options.title.trim();
		const ownerSessionId = options.ownerSessionId.trim();
		const sourceId = options.sourceId?.trim();
		const cwd = options.cwd.trim();
		if (!command) throw new Error("command is required");
		if (!title) throw new Error("title is required");
		if (!ownerSessionId) throw new Error("owner session id is required");
		if (sourceId && sourceId.length > 512) throw new Error("source id is too long");
		if (!cwd) throw new Error("working directory is required");

		const createdAt = Math.max(1, Math.floor(this.now()));
		let id: string | undefined;
		let paths: ReturnType<typeof taskPaths> | undefined;
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const candidate = this.createId();
			if (!isValidTerminalTaskId(candidate)) throw new Error(`Invalid generated terminal id: ${candidate}`);
			const candidatePaths = taskPaths(this.store, candidate, createdAt);
			try {
				createPrivateTaskDirectory(this.store, candidatePaths.directory);
				id = candidate;
				paths = candidatePaths;
				break;
			} catch (error) {
				if (!(error instanceof Error) || !errnoIs(error, "EEXIST")) throw error;
			}
		}
		if (!id || !paths) throw new Error("Unable to allocate a unique terminal task directory");

		createPrivateFile(this.store, paths.logFile, "");
		createPrivateFile(this.store, paths.exitFile, "");
		createPrivateFile(this.store, paths.commandFile, process.platform === "win32" ? command : `exec 2>&1\nset -o pipefail\n${command}\n`);
		const scriptFile = process.platform === "win32" ? paths.windowsScriptFile : paths.scriptFile;
		const runnerOptions = {
			cwd,
			launchFile: paths.launchFile,
			commandFile: paths.commandFile,
			logFile: paths.logFile,
			exitFile: paths.exitFile,
			logMaxBytes: this.logMaxBytes,
		};
		createPrivateFile(this.store, scriptFile, process.platform === "win32"
			? buildWindowsScript(runnerOptions)
			: buildPosixScript(runnerOptions));

		const initialWithoutSourceId: Omit<TerminalTaskSnapshot, "sourceId"> = {
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
		const initial: TerminalTaskSnapshot = sourceId ? { ...initialWithoutSourceId, sourceId } : initialWithoutSourceId;
		this.store.create(initial, paths.metaFile);
		this.adopt(initial, true);

		let child: ChildProcess;
		const processOwnerToken = `sumocode-owner-${randomUUID()}`;
		try {
			child = this.spawn(
				process.platform === "win32" ? "cmd.exe" : "/bin/bash",
				process.platform === "win32" ? ["/d", "/s", "/c", scriptFile] : [scriptFile, processOwnerToken],
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
			createPrivateFile(this.store, paths.launchFile, "ready\n");
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

	/** Owner-ordered inventory: the store's owner index joins retained full snapshots. */
	public list(ownerSessionId: string): TerminalTaskSnapshot[] {
		this.ensureIndexInitialized();
		return this.store.listOwnedIndexed(ownerSessionId).flatMap((indexed) => {
			const task = this.tasks.get(indexed.id);
			return task ? [task] : [];
		});
	}

	public get(id: string, ownerSessionId: string): TerminalTaskSnapshot | undefined {
		// An uninitialized projection (constructor scan failed transiently) must
		// retry the scan before the compact-index precheck, or pre-existing
		// terminals would read as unknown for the manager lifetime.
		this.ensureIndexInitialized();
		// Retained snapshots stay queryable only while the store's current compact
		// index still recognizes this id for this owner. A successful refresh that
		// quarantined a corrupt/unreadable record drops it from the index; without
		// this no-I/O precheck the stale retained snapshot would keep answering
		// explicit queries and downstream observe/mutate would throw on the missing
		// indexed path instead of reporting a normal unknown terminal. A failed
		// refresh preserves the last good index, so retained tasks remain queryable
		// across transient store unavailability.
		if (!this.store.isIndexedOwner(id, ownerSessionId)) return undefined;
		const retained = this.tasks.get(id);
		const task = retained ?? this.store.getIndexed(id);
		if (!task || task.ownerSessionId !== ownerSessionId) return undefined;
		if (!retained) this.adopt(task, false);
		if (!isTerminalTaskSettled(task.status)) this.arm(id);
		return task;
	}

	public check(id: string, ownerSessionId: string): TerminalTaskObservation | undefined {
		this.ensureIndexInitialized();
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
		this.ensureIndexInitialized();
		const uniqueIds = [...new Set(ids)];
		const known = uniqueIds.filter((id) => this.get(id, ownerSessionId) !== undefined);
		const knownSet = new Set(known);
		const complete = (): boolean => known.every((id) => {
			const task = this.get(id, ownerSessionId);
			// An id collected as known that has become unqueryable was quarantined
			// by a concurrent refresh: it counts as complete so the waiter resolves
			// promptly and the id routes to unknownIds below instead of parking for
			// the full timeout.
			if (task === undefined) return true;
			return isTerminalTaskSettled(task.status);
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
					if (error) reject(error);
					else resolve();
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
		// An id collected as known can become unqueryable while parked: a
		// concurrent successful refresh quarantines it from the compact index.
		// Such ids route to the unknown bucket through the normal result shape
		// instead of the historical non-null assertion throwing on undefined.
		const quarantined = new Set<string>();
		for (const id of known) {
			const current = this.get(id, ownerSessionId);
			if (!current) {
				quarantined.add(id);
				continue;
			}
			if (!isTerminalTaskSettled(current.status)) {
				pendingIds.push(id);
				continue;
			}
			const task = this.observe(id, true);
			settled.push({ task, output: this.getOutput(task, WAIT_OUTPUT_BYTES) });
		}
		return {
			settled,
			pendingIds,
			unknownIds: uniqueIds.filter((id) => !knownSet.has(id) || quarantined.has(id)),
			timedOut: pendingIds.length > 0,
		};
	}

	public async stop(ids: readonly string[], ownerSessionId: string): Promise<TerminalStopResult[]> {
		this.ensureIndexInitialized();
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
			const naturalExitCode = readExitCode(this.store, paths.exitFile);
			if (this.processTree.isTreeEmpty(identity, current.processTreeVerification)) {
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
			const retainedVerification = current.processTreeVerification ?? this.runtime.get(id)?.treeVerification;
			let identityStatus = this.processTree.identityMatches(identity);
			let verifiedByRetainedAnchors = false;
			if (identityStatus === "unknown" && retainedVerification && this.processTree.verificationMatches) {
				identityStatus = this.processTree.verificationMatches(identity, retainedVerification);
				verifiedByRetainedAnchors = identityStatus === "same";
			}
			if (identityStatus === "different") {
				this.settleLost(id, null, false);
				const lost = this.observe(id, false);
				results.set(id, { id, outcome: "failed", task: lost, message: `Terminal ${id} process identity changed; recorded lost without signalling.` });
				continue;
			}
			if (identityStatus === "unknown") {
				results.set(id, { id, outcome: "failed", task: current, message: `Terminal ${id} process identity could not be verified; refusing to signal.` });
				continue;
			}
			const capturedVerification = this.processTree.captureTreeVerification?.(identity);
			if (naturalExitCode !== undefined) {
				const verification = capturedVerification ?? (verifiedByRetainedAnchors ? retainedVerification : current.processTreeVerification);
				if (this.processTree.captureTreeVerification && !verification) {
					results.set(id, { id, outcome: "failed", task: current, message: `Terminal ${id} process-tree anchors could not be persisted; refusing natural-disposition signal.` });
					continue;
				}
				const disposing = verification && !sameTreeVerification(current.processTreeVerification, verification)
					? this.mutate(id, (task) => !isTerminalTaskSettled(task.status) && !sameTreeVerification(task.processTreeVerification, verification)
						? { ...task, processTreeVerification: verification, updatedAt: this.timestamp(task) }
						: undefined).snapshot
					: current;
				if (isTerminalTaskSettled(disposing.status)) {
					const observed = this.observe(id, false);
					results.set(id, { id, outcome: "already-settled", task: observed, message: `Terminal ${id} was already ${observed.status}.` });
					continue;
				}
				this.clearPoll(id);
				targets.push({ task: disposing, identity, verification: disposing.processTreeVerification ?? verification, naturalExitCode });
				continue;
			}
			// A new TERM boundary requires a fresh complete-group snapshot.
			// Runtime-only anchors may predate descendants and are not sufficient for
			// crash recovery once TERM removes the leader.
			const verification = current.status === "stopping"
				? current.processTreeVerification ?? capturedVerification ?? retainedVerification
				: capturedVerification ?? (verifiedByRetainedAnchors ? retainedVerification : undefined);
			if (this.processTree.captureTreeVerification && !verification) {
				results.set(id, { id, outcome: "failed", task: current, message: `Terminal ${id} process-tree anchors could not be persisted; refusing to signal.` });
				continue;
			}
			const stopping = this.mutate(id, (task) => {
				if (isTerminalTaskSettled(task.status)) return undefined;
				const nextVerification = verification ?? task.processTreeVerification;
				if (task.status === "stopping" && sameTreeVerification(task.processTreeVerification, nextVerification)) return undefined;
				return {
					...task,
					status: "stopping",
					updatedAt: this.timestamp(task),
					processTreeVerification: nextVerification,
				};
			}).snapshot;
			if (isTerminalTaskSettled(stopping.status)) {
				const observed = this.observe(id, false);
				results.set(id, { id, outcome: "already-settled", task: observed, message: `Terminal ${id} was already ${observed.status}.` });
				continue;
			}
			// Explicit stop owns disposition until it returns. Prevent the periodic
			// recovery loop from racing TERM/KILL and classifying an in-flight group.
			this.clearPoll(id);
			targets.push({ task: stopping, identity, verification });
		}

		// Verification and TERM/taskkill initiation happen for every target before
		// any grace wait, preserving concurrent batch-stop semantics.
		const termSignals = await Promise.all(targets.map(({ identity, verification, naturalExitCode }) =>
			this.safeVerifiedSignal(identity, naturalExitCode === undefined ? "SIGTERM" : "SIGKILL", verification)));
		await Promise.all(targets.map(async ({ task, identity, verification, naturalExitCode }, index) => {
			results.set(task.id, naturalExitCode === undefined
				? await this.finishStop(task.id, ownerSessionId, identity, termSignals[index]!, true, verification)
				: await this.finishNaturalStop(task.id, ownerSessionId, identity, naturalExitCode, termSignals[index]!, verification));
		}));
		return uniqueIds.map((id) => results.get(id)!);
	}

	public claimPending(ownerSessionId: string, includeWake: boolean, maxWake = 1): TerminalTaskSnapshot[] {
		this.ensureIndexInitialized();
		const claimed: TerminalTaskSnapshot[] = [];
		let claimedWake = 0;
		for (const candidate of this.store.listOwnedIndexed(ownerSessionId)) {
			if (!isClaimable(candidate, ownerSessionId, includeWake, claimedWake, maxWake, this.now(), this.claimLeaseMs)) continue;
			const result = this.mutate(candidate.id, (current) => {
				if (!isClaimable(current, ownerSessionId, includeWake, claimedWake, maxWake, this.now(), this.claimLeaseMs)) return undefined;
				return {
					...current,
					deliveryState: "claimed",
					deliveryClaimToken: this.createClaimToken(),
					updatedAt: this.timestamp(current),
				};
			});
			if (!result.changed) continue;
			claimed.push(result.snapshot);
			if (result.snapshot.completionPolicy === "wake") claimedWake += 1;
		}
		return claimed;
	}

	public acknowledge(ownerSessionId: string, receipts: readonly TerminalDeliveryReceipt[]): TerminalTaskSnapshot[] {
		// A failed-init manager's compact index is empty, so without the lazy retry
		// a non-idle coordinator reconcile would find no candidates and leave a
		// durable claim unacknowledged with no lease timer. Same coalesced guard
		// as every other query/mutation entry point.
		this.ensureIndexInitialized();
		const receiptKeys = new Set(receipts.map(({ completionId, claimToken }) => `${completionId}\u0000${claimToken}`));
		const acknowledged: TerminalTaskSnapshot[] = [];
		for (const candidate of this.store.listOwnedIndexed(ownerSessionId)) {
			if (!isAcknowledgementMatch(candidate, ownerSessionId, receiptKeys)) continue;
			const result = this.mutate(candidate.id, (current) => {
				if (!isAcknowledgementMatch(current, ownerSessionId, receiptKeys)) return undefined;
				return { ...current, deliveryState: "delivered", deliveryClaimToken: undefined, updatedAt: this.timestamp(current) };
			});
			if (result.changed) acknowledged.push(result.snapshot);
		}
		return acknowledged;
	}

	public getClaimRetryDelay(ownerSessionId: string): number | undefined {
		// Same lazy-seeding guard as acknowledge: an uninitialized projection would
		// answer "no claimed records" (undefined) and the coordinator would tear
		// down its lease-retry timer instead of scheduling one.
		this.ensureIndexInitialized();
		const delays = this.store.listOwnedIndexed(ownerSessionId)
			.filter((task) => task.deliveryState === "claimed")
			.map((task) => Math.max(0, this.claimLeaseMs - (this.now() - task.updatedAt)));
		return delays.length > 0 ? Math.min(...delays) : undefined;
	}

	public addChangeListener(listener: TerminalTaskChangeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Replay one complete immutable manager projection, then publish transitions. */
	public subscribeChanges(listener: TerminalTaskSnapshotListener): () => void {
		this.snapshotListeners.add(listener);
		listener(this.getSnapshots());
		return () => this.snapshotListeners.delete(listener);
	}

	/**
	 * Adopt records created or advanced by another process after this manager was
	 * constructed. Recovery re-verifies durable process identity before any
	 * lifecycle transition; callers receive the refreshed immutable projection.
	 * `ok` is false when the store directory could not be read or when this
	 * manager is detached (no scan, therefore no provable freshness): the
	 * previous projection generation stays authoritative and callers must treat
	 * freshness as unproven instead of adopting the returned snapshots, and
	 * takeover callers keep their death proof unconsumed. `complete` is false
	 * when even the successful scan hit a transient per-record metadata read or
	 * directory-validation failure: that scan still replaces the projection with
	 * its indexed generation and preserves last-good snapshots for `preservedIds`,
	 * but this manager keeps its lazy index-init retry armed (one deduped episode
	 * diagnostic) until a later complete scan freshly reads every candidate. On
	 * success every fresh valid snapshot is adopted — including one whose revision equals the
	 * retained entry, so an external same-revision owner or content divergence
	 * at this proven freshness boundary updates the full projection and owner
	 * lists — and the retained projection is replaced to match exactly the
	 * refreshed index generation: ids the scan quarantined or no longer reports are dropped from
	 * `tasks` and `getSnapshots()` so stale retained snapshots cannot be
	 * republished, and their poll timers are cleared while the separate runtime
	 * child/process bookkeeping stays preserved. Ids whose metadata read failed
	 * transiently keep their compact index entry and their retained full
	 * snapshot: only a genuinely quarantined id is pruned. Recovery side effects
	 * (settled log cap, launch-gate release, arm, reconcile scheduling) are
	 * gated: only a record new to this projection or one whose
	 * recovery-relevant durable identity changed — revision, owner, lifecycle
	 * status, or process identity (pid/processGroupId/processStartTime) — pays
	 * them again, so unchanged records are never log-capped or rescheduled per
	 * refresh, a same-revision owner divergence still recovers, and an external
	 * same-revision same-owner rewrite that flips status or process identity
	 * recovers instead of leaving an active terminal unarmed behind a stale
	 * projection. Quarantine stays logical — durable records are preserved.
	 * Waiter- and delivery-relevant changes — each genuinely pruned id and each
	 * recovery-gated adopted record (one new to the projection, or a retained
	 * record whose recovery-relevant identity changed, e.g. an external rewrite
	 * flipping running→settled at this boundary) — are collected during the
	 * loops and fanned out once after adoption and pruning complete: per-task
	 * listeners receive each change so parked waiters that collected an id as
	 * known resolve promptly instead of waiting out the clock and a takeover
	 * retry that discovers an already-settled pending completion wakes the
	 * delivery coordinator, and projection listeners receive exactly one
	 * publication of the final projection, so no intermediate projection that
	 * still contains a not-yet-pruned quarantined id is ever adopted or
	 * published. The whole fan-out runs inside a notification batch: recovery
	 * work below can synchronously reach mutate()→adopt(…, true) — reconcile's
	 * async body runs to its first await when scheduled here, including its
	 * tree-verification mutation and starting/lost settlement — so any
	 * notification fired mid-batch queues its per-task changes and publishes
	 * nothing; the batch flag is cleared in finally and one merged fan-out
	 * emits the final per-task payload per id — the latest retained snapshot at
	 * fan-out time, so a fresh-then-stale v2→v1 sequence can never be observed —
	 * plus exactly one final projection. That drain is transactional: it runs in
	 * the same finally even when the loops throw, so whatever was collected or
	 * queued mid-batch still reaches its listeners (a parked waiter wakes
	 * promptly) and queue state never carries across refresh calls, while the
	 * throw keeps propagating to the caller and any publication reflects the
	 * current retained projection. A same-revision, same-owner content-only
	 * rewrite is adopted with no recovery side effects. When its differing
	 * content touches no delivery-eligibility or receipt field (deliveryState,
	 * completionPolicy, completionId, deliveryClaimToken — and, for a claimed
	 * record, updatedAt, whose move can advance lease expiry ahead of the
	 * coordinator's armed retry timer) it is purely cosmetic:
	 * it joins no per-task change but still marks the refresh's stored state as
	 * changed, so a successful refresh emits exactly one final projection
	 * publication even when the per-task changed list is empty. When any of
	 * those delivery fields differs — e.g. a delivered/suppressed settled record
	 * rewritten back to pending-eligible at the same revision, or a claimed
	 * record whose updatedAt moved — the rewrite
	 * instead joins the per-task fan-out so the TerminalDeliveryCoordinator,
	 * which listens for per-task notifications only, wakes and schedules its
	 * flush; no recovery side effect runs for such a delivery-only change
	 * because status and process identity are unchanged. A refresh whose records
	 * are all unchanged (and which prunes nothing) publishes nothing.
	 */
	public refreshSnapshotsFromStore(): TerminalTaskIndexRefreshResult {
		if (this.detached) return { ok: false, complete: false, snapshots: this.getSnapshots() };
		const refresh = this.store.refreshIndex();
		if (!refresh.ok) return { ok: false, complete: false, snapshots: this.getSnapshots() };
		// A successful scan seeds the generation a failed constructor scan could
		// not. A complete scan ends the init-failure episode (the next failure is
		// diagnosed again) and stops lazy init retries; an incomplete scan still
		// serves the indexed generation immediately but keeps init-retry state
		// armed — one deduped episode diagnostic per incomplete episode — so the
		// next entry-point retry can freshly read a record a transient read or
		// directory-validation failure skipped or preserved, including after a
		// mid-life takeover refresh.
		this.indexInitialized = refresh.complete;
		if (refresh.complete) {
			// A complete scan ends the failure episode (the next failure is
			// diagnosed again) and resets the escalating retry schedule, so a
			// later episode starts from the base delay.
			this.resetIndexInitEpisode();
		} else this.diagnoseIndexInitFailure(true);
		// Waiter- and delivery-relevant changes are collected across both loops and
		// fanned out once after adoption and pruning complete, so projection
		// listeners can never observe — or re-enter a nested refresh against — an
		// intermediate generation that still contains a not-yet-pruned quarantined
		// id. The batch flag routes any notification a synchronous recovery path
		// fires mid-loop into that same merged fan-out instead of publishing it.
		this.refreshBatchDepth += 1;
		const changed: TerminalTaskSnapshot[] = [];
		let adoptionChangedStoredState = false;
		try {
			adoptionChangedStoredState = this.runRefreshLoops(refresh, changed);
		} finally {
			this.refreshBatchDepth -= 1;
			// Single merged fan-out — transactional across both the success and
			// the throw path (see drainRefreshBatch).
			this.drainRefreshBatch(changed, adoptionChangedStoredState);
		}
		return { ok: true, complete: refresh.complete, snapshots: this.getSnapshots() };
	}

	/**
	 * Coalesced lazy retry of the constructor's failed or incomplete
	 * initialization scan. The first complete retry seeds the generation exactly
	 * like a successful refresh (adopt, recover, single batched fan-out, no
	 * intermediate projections) and the zero-scan query guarantee resumes; an
	 * incomplete retry still serves its indexed generation but keeps the backoff
	 * armed. Until initialization completes, every query/mutation entry point
	 * pays at most one scan attempt per entry. A minimal in-flight guard keeps a
	 * listener fanned out by the seeding scan from re-entering it, and an
	 * escalating injectable-clock backoff keeps a persistently unreadable or
	 * incomplete store from being rescanned by every following entry.
	 */
	private ensureIndexInitialized(): void {
		if (this.indexInitialized || this.detached) {
			this.clearIndexInitRetryTimer();
			return;
		}
		if (this.indexInitInFlight) return;
		const attemptAt = Math.max(1, Math.floor(this.now()));
		if (attemptAt - this.indexInitLastAttemptAt < this.indexInitBackoffMs) {
			this.scheduleIndexInitRetryTimer();
			return;
		}
		// A direct entry point reached the retry boundary first. Let it own this
		// attempt and replace the timer with the next window only if the scan still
		// cannot prove a complete generation.
		this.clearIndexInitRetryTimer();
		this.indexInitLastAttemptAt = attemptAt;
		this.indexInitInFlight = true;
		try {
			if (!this.refreshSnapshotsFromStore().ok) this.diagnoseIndexInitFailure();
			// A failed or incomplete attempt leaves initialization open: escalate
			// the next gap — the base delay doubled per consecutive attempt, capped
			// at INDEX_INIT_RETRY_BACKOFF_MAX_MS — so a chronically incomplete or
			// unreadable generation is no longer rescanned on every entry point. A
			// complete scan resets the schedule inside refreshSnapshotsFromStore.
			if (!this.indexInitialized) {
				this.indexInitFailedAttempts += 1;
				this.indexInitBackoffMs = Math.min(
					INDEX_INIT_RETRY_BACKOFF_MS * 2 ** Math.min(this.indexInitFailedAttempts - 1, 32),
					INDEX_INIT_RETRY_BACKOFF_MAX_MS,
				);
				this.scheduleIndexInitRetryTimer(attemptAt);
			}
		} finally {
			this.indexInitInFlight = false;
		}
	}

	/**
	 * Init-scan failures and incomplete generations are diagnosed once per
	 * episode kind — a failed⇄incomplete transition re-diagnoses once so the
	 * message matches the store state — and the first complete successful scan
	 * resets the dedupe.
	 */
	private diagnoseIndexInitFailure(incomplete = false): void {
		const kind = incomplete ? "incomplete" as const : "failed" as const;
		if (this.indexInitDiagnosedKind === kind) return;
		this.indexInitDiagnosedKind = kind;
		this.onDiagnostic?.({ kind: "manager", message: incomplete
			? "terminal store scan indexed an incomplete generation; entry points retry lazily until a complete scan"
			: "terminal store scan failed before the projection was seeded; entry points retry lazily until the first successful scan" });
	}

	/** A complete scan ends the episode: the diagnostic dedupe and the escalating retry schedule both reset. */
	private resetIndexInitEpisode(): void {
		this.indexInitDiagnosedKind = undefined;
		this.indexInitFailedAttempts = 0;
		this.indexInitBackoffMs = INDEX_INIT_RETRY_BACKOFF_MS;
		this.clearIndexInitRetryTimer();
	}

	private scheduleIndexInitRetryTimer(baseAt = Number.isFinite(this.indexInitLastAttemptAt) ? this.indexInitLastAttemptAt : Math.max(1, Math.floor(this.now()))): void {
		if (this.indexInitialized || this.detached || this.hasActiveTasks()) {
			this.clearIndexInitRetryTimer();
			return;
		}
		const dueAt = baseAt + this.indexInitBackoffMs;
		if (this.indexInitRetryTimer && this.indexInitRetryDueAt === dueAt) return;
		this.clearIndexInitRetryTimer();
		this.indexInitRetryDueAt = dueAt;
		this.indexInitRetryTimer = setTimeout(() => {
			this.indexInitRetryTimer = undefined;
			this.indexInitRetryDueAt = undefined;
			this.ensureIndexInitialized();
		}, Math.max(0, dueAt - this.now()));
		this.indexInitRetryTimer.unref?.();
	}

	private clearIndexInitRetryTimer(): void {
		if (this.indexInitRetryTimer) clearTimeout(this.indexInitRetryTimer);
		this.indexInitRetryTimer = undefined;
		this.indexInitRetryDueAt = undefined;
	}

	private hasActiveTasks(): boolean {
		for (const task of this.tasks.values()) {
			if (!isTerminalTaskSettled(task.status)) return true;
		}
		return false;
	}

	/**
	 * The refresh adoption and prune loops; every notification stays inside the
	 * caller's batch. Returns whether any adoption replaced a retained snapshot
	 * with differing content without joining the per-task fan-out (a cosmetic
	 * same-revision, same-owner content-only rewrite), so the caller can publish
	 * the projection even with an empty changed list.
	 */
	private runRefreshLoops(refresh: TerminalTaskIndexRefreshResult, changed: TerminalTaskSnapshot[]): boolean {
		let adoptionChangedStoredState = false;
		for (const snapshot of refresh.snapshots) {
			// Adoption is unconditional: revision equality alone must never skip a
			// refreshed snapshot, or an external same-revision owner/content rewrite
			// would leave the retained projection answering for the previous owner.
			const previous = this.tasks.get(snapshot.id);
			this.adopt(snapshot, false);
			this.onRefreshAdopt?.(snapshot.id);
			// A same-revision, same-owner content-only rewrite replaced the stored
			// snapshot object with differing content but fires no recovery gate and
			// joins no per-task change unless it flipped a delivery-eligibility or
			// receipt field (handled below): report it with a cheap shallow field
			// compare (no deep JSON of large payloads) so the refresh still publishes
			// the updated projection exactly once.
			if (previous !== undefined && !snapshotContentEquals(previous, snapshot)) adoptionChangedStoredState = true;
			// Recovery work is gated on the shared recovery-relevant durable identity
			// gate (see recoveryRelevantAdoption); every recovery-gated adoption is
			// waiter- and delivery-relevant and joins the batched fan-out below.
			if (recoveryRelevantAdoption(previous, snapshot)) {
				this.recover(snapshot);
				this.onRefreshRecover?.(snapshot.id);
				// Every recovery-gated adoption is waiter- and delivery-relevant: a
				// retained record advanced externally must re-evaluate parked waits
				// (e.g. running→settled), and a record new to this projection — such
				// as a takeover retry discovering an already-settled pending
				// completion — must wake the delivery coordinator, which listens for
				// per-task notifications only.
				changed.push(snapshot);
			} else if (previous !== undefined && deliveryEligibilityChanged(previous, snapshot)) {
				// A same-revision, same-owner rewrite that flipped only delivery
				// eligibility/receipt fields (e.g. a delivered/suppressed settled
				// record rewritten back to pending) is delivery-relevant without being
				// recovery-relevant: it joins the batched fan-out so the delivery
				// coordinator wakes and schedules its flush, while recovery side
				// effects (cap/arm/reconcile) stay gated on status and process
				// identity and never run for a delivery-only change. A rewrite whose
				// differing content touches none of those fields stays projection-only
				// via the content compare above.
				changed.push(snapshot);
			}
		}
		const refreshed = new Set(refresh.snapshots.map((snapshot) => snapshot.id));
		const preserved = refresh.preservedIds === undefined ? undefined : new Set(refresh.preservedIds);
		// Copy before deleting: the projection map mutates while pruning.
		for (const id of Array.from(this.tasks.keys())) {
			if (refreshed.has(id)) continue;
			// A transient per-file metadata read failure retained the record's
			// compact index entry, so its retained full snapshot stays authoritative
			// for this generation instead of being pruned like a quarantined id.
			if (preserved?.has(id)) continue;
			// A genuinely quarantined id stops polling: no further reconciles are
			// scheduled for a projection entry the refreshed index no longer reports.
			this.clearPoll(id);
			const pruned = this.tasks.get(id);
			this.tasks.delete(id);
			// A pruned id is waiter-relevant: a known id that became unqueryable
			// mid-wait is complete for wait purposes (it routes to unknownIds), so
			// silence here would park the waiter for the full timeout.
			if (pruned) changed.push(pruned);
		}
		return adoptionChangedStoredState;
	}

	/**
	 * Authoritative single indexed read of one record, bypassing the retained
	 * projection. Owner-isolated: another session's record reads as `undefined`.
	 * The owner precheck runs against the compact index with no I/O, so a foreign
	 * or unknown id costs zero metadata reads and a matching id costs exactly
	 * one. The owner check is re-verified against the freshly read snapshot at no
	 * extra cost, so a compact entry gone stale relative to disk cannot leak
	 * another session's record. Narrow surface for pre-send/pre-publication
	 * freshness checks; never scans the store and only resolves indexed ids.
	 */
	public readIndexed(id: string, ownerSessionId: string): TerminalTaskSnapshot | undefined {
		if (!this.store.isIndexedOwner(id, ownerSessionId)) return undefined;
		const snapshot = this.store.getIndexed(id);
		if (snapshot && snapshot.ownerSessionId !== ownerSessionId) return undefined;
		return snapshot;
	}

	public getSnapshots(): readonly TerminalTaskSnapshot[] {
		const snapshots = [...this.tasks.values()];
		const replayed = snapshots.filter((snapshot) => !isTerminalTaskSettled(snapshot.status));
		const settledByOwner = new Map<string, TerminalTaskSnapshot[]>();
		for (const snapshot of snapshots) {
			if (!isTerminalTaskSettled(snapshot.status)) continue;
			const owned = settledByOwner.get(snapshot.ownerSessionId) ?? [];
			owned.push(snapshot);
			settledByOwner.set(snapshot.ownerSessionId, owned);
		}
		for (const owned of settledByOwner.values()) {
			replayed.push(...owned
				.sort((left, right) => (right.settledAt ?? right.updatedAt) - (left.settledAt ?? left.updatedAt))
				.slice(0, MAX_REPLAYED_SETTLED_TERMINALS));
		}
		return replayed
			.sort((left, right) => left.createdAt - right.createdAt)
			.map(immutableTerminalSnapshot);
	}

	public getOutput(task: Pick<TerminalTaskSnapshot, "logFile">, maxBytes = CHECK_OUTPUT_BYTES): string {
		return readLogTail(this.store, task.logFile, maxBytes);
	}

	/** Raw tail for UTF-8-safe durable Activity projection during concurrent appends. */
	public getOutputTailBytes(task: Pick<TerminalTaskSnapshot, "logFile">, maxBytes = CHECK_OUTPUT_BYTES): TerminalOutputTail {
		return readLogTailBytes(this.store, task.logFile, maxBytes);
	}

	public getOutputBytes(task: Pick<TerminalTaskSnapshot, "logFile">, maxBytes = CHECK_OUTPUT_BYTES): Uint8Array {
		return this.getOutputTailBytes(task, maxBytes).bytes;
	}

	public async stopOwned(ownerSessionId: string): Promise<TerminalStopResult[]> {
		const running = this.list(ownerSessionId).filter((task) => !isTerminalTaskSettled(task.status));
		return this.stop(running.map((task) => task.id), ownerSessionId);
	}

	public detach(): void {
		if (this.detached) return;
		this.detached = true;
		this.clearIndexInitRetryTimer();
		for (const runtime of this.runtime.values()) {
			if (runtime.pollTimer) clearInterval(runtime.pollTimer);
			runtime.pollTimer = undefined;
		}
		this.listeners.clear();
		this.snapshotListeners.clear();
	}

	private recover(snapshot: TerminalTaskSnapshot): void {
		if (isTerminalTaskSettled(snapshot.status)) {
			capSettledLog(this.store, snapshot.logFile, this.logMaxBytes);
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
				createPrivateFile(this.store, paths.launchFile, "recovered\n");
			} catch (error) {
				if (!(error instanceof Error) || !errnoIs(error, "EEXIST")) {
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
			runtime = { lastTreeVerificationAt: Number.NEGATIVE_INFINITY };
			this.runtime.set(task.id, runtime);
		}
		return runtime;
	}

	private arm(id: string): void {
		if (this.detached) return;
		const task = this.tasks.get(id) ?? this.store.getIndexed(id);
		if (!task || isTerminalTaskSettled(task.status)) return;
		const runtime = this.ensureRuntime(task);
		if (runtime.pollTimer) {
			if (!this.indexInitialized) this.clearIndexInitRetryTimer();
			return;
		}
		runtime.pollTimer = setInterval(() => this.handlePollTick(id), this.pollIntervalMs);
		runtime.pollTimer.unref?.();
		if (!this.indexInitialized) this.clearIndexInitRetryTimer();
	}

	private handlePollTick(id: string): void {
		if (!this.indexInitialized) this.ensureIndexInitialized();
		this.scheduleReconcile(id);
	}

	private scheduleReconcile(id: string): void {
		if (this.detached) return;
		const task = this.tasks.get(id) ?? this.store.getIndexed(id);
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
		const current = this.store.getIndexed(id);
		if (!current) return;
		this.adopt(current, true);
		if (isTerminalTaskSettled(current.status)) {
			this.clearPoll(id);
			return;
		}
		const runtime = this.ensureRuntime(current);
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
		// Check the cheap durable exit marker before any process-table probe. Long-
		// running terminals otherwise spawned several synchronous `ps` commands on
		// every 250ms poll, blocking the interactive event loop per active task.
		const paths = taskPaths(this.store, current.id, current.createdAt);
		const exitCode = readExitCode(this.store, paths.exitFile);
		if (exitCode !== undefined) {
			await this.finishNaturalCompletion(id, identity, exitCode);
			return;
		}
		if (this.now() - runtime.lastTreeVerificationAt < TREE_VERIFICATION_REFRESH_MS) return;
		runtime.lastTreeVerificationAt = this.now();
		const verification = this.processTree.captureTreeVerification?.(identity);
		if (verification) {
			runtime.treeVerification = verification;
			if (!sameTreeVerification(current.processTreeVerification, verification)) {
				this.mutate(id, (task) => task.status === "running" && !sameTreeVerification(task.processTreeVerification, verification)
					? { ...task, processTreeVerification: verification, updatedAt: this.timestamp(task) }
					: undefined);
			}
			return;
		}
		const identityStatus = this.processTree.identityMatches(identity);
		if (identityStatus === "different" && this.store.getIndexed(id)?.status === "running") this.settleLost(id, null, false);
	}

	private async finishNaturalCompletion(id: string, identity: ProcessTreeIdentity, exitCode: number): Promise<void> {
		let current = this.store.getIndexed(id);
		if (current?.status !== "running") return;
		if (this.processTree.isTreeEmpty(identity, current.processTreeVerification)) {
			// Crash recovery after tree disposal but before the final metadata CAS:
			// exit.code plus persisted-anchor absence is complete evidence.
			this.settleNatural(id, exitCode);
			return;
		}
		// Both wrappers deliberately retain the verified leader after writing the
		// command's exit code. Capture and persist the complete member set before
		// disposal so Windows recovery retains authority after the leader exits.
		const retainedVerification = current.processTreeVerification ?? this.runtime.get(id)?.treeVerification;
		let verification: ProcessTreeVerification | undefined;
		let identityStatus = this.processTree.identityMatches(identity);
		if (identityStatus === "same") {
			verification = this.processTree.captureTreeVerification?.(identity) ?? retainedVerification;
		} else if (identityStatus === "unknown" && retainedVerification && this.processTree.verificationMatches) {
			identityStatus = this.processTree.verificationMatches(identity, retainedVerification);
			if (identityStatus === "same") verification = retainedVerification;
		}
		if (identityStatus === "different") {
			if (this.processTree.isTreeEmpty(identity, retainedVerification)) this.settleNatural(id, exitCode);
			else this.settleLost(id, exitCode, false);
			return;
		}
		if (identityStatus === "unknown" || (this.processTree.captureTreeVerification && !verification)) {
			this.diagnostic(id, "natural completion process-tree identity or member anchors are unverified; refusing tree signal");
			return;
		}
		if (verification && !sameTreeVerification(current.processTreeVerification, verification)) {
			current = this.mutate(id, (task) => task.status === "running" && !sameTreeVerification(task.processTreeVerification, verification)
				? { ...task, processTreeVerification: verification, updatedAt: this.timestamp(task) }
				: undefined).snapshot;
			verification = current.processTreeVerification;
		}
		if (this.processTree.isTreeEmpty(identity, verification)) {
			this.settleNatural(id, exitCode);
			return;
		}
		const killed = await this.safeVerifiedSignal(identity, "SIGKILL", verification);
		const gone = killed.gone || (killed.ok && await this.processTree.waitForTreeEmpty(identity, this.killGraceMs, verification));
		if (killed.ok && gone) {
			if (this.store.getIndexed(id)?.status === "running") this.settleNatural(id, exitCode);
			return;
		}
		if (killed.identityStatus === "different" && this.processTree.isTreeEmpty(identity, verification)) {
			this.settleNatural(id, exitCode);
			return;
		}
		this.diagnostic(id, `natural completion tree disposition unproven; refusing settlement: ${killed.error ?? "tree did not become empty"}`);
	}

	private async recoverStopping(id: string, identity: ProcessTreeIdentity): Promise<void> {
		const current = this.store.getIndexed(id);
		const ownerSessionId = current?.ownerSessionId;
		if (this.processTree.isTreeEmpty(identity, current?.processTreeVerification)) {
			this.settleDisposedStop(id);
			return;
		}
		let verification = current?.processTreeVerification;
		let identityStatus = this.processTree.identityMatches(identity);
		if (identityStatus === "unknown" && verification && this.processTree.verificationMatches) {
			identityStatus = this.processTree.verificationMatches(identity, verification);
		}
		if (identityStatus === "different") {
			// Another stop/recovery contender may have emptied the group after the
			// initial check. Disposition evidence wins over a stale mismatch result.
			if (this.processTree.isTreeEmpty(identity, verification)) this.settleDisposedStop(id);
			else this.settleLost(id, null, false);
			return;
		}
		if (identityStatus === "unknown") {
			this.diagnostic(id, "persisted stopping task identity and descendant anchors are unknown; refusing recovery signal");
			return;
		}
		if (!verification) {
			verification = this.processTree.captureTreeVerification?.(identity);
			if (this.processTree.captureTreeVerification && !verification) {
				this.diagnostic(id, "persisted stopping task has no verifiable process-tree anchors; refusing recovery signal");
				return;
			}
			if (verification) {
				const persisted = this.mutate(id, (task) => task.status === "stopping" && !task.processTreeVerification
					? { ...task, processTreeVerification: verification, updatedAt: this.timestamp(task) }
					: undefined).snapshot;
				verification = persisted.processTreeVerification;
			}
		}
		const term = await this.safeVerifiedSignal(identity, "SIGTERM", verification);
		await this.finishStop(id, ownerSessionId, identity, term, false, verification);
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
			capSettledLog(this.store, result.snapshot.logFile, this.logMaxBytes);
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
			capSettledLog(this.store, result.snapshot.logFile, this.logMaxBytes);
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
				deliveryClaimToken: undefined,
			};
		}).snapshot;
	}

	/** True when a concurrent successful refresh quarantined this id out of the compact index. */
	private isQuarantined(id: string, ownerSessionId: string | undefined): boolean {
		return ownerSessionId === undefined || !this.store.isIndexedOwner(id, ownerSessionId);
	}

	private async finishNaturalStop(
		id: string,
		ownerSessionId: string,
		identity: ProcessTreeIdentity,
		exitCode: number,
		signal: ProcessTreeSignalResult,
		verification?: ProcessTreeVerification,
	): Promise<TerminalStopResult> {
		const gone = signal.gone || (signal.ok && await this.processTree.waitForTreeEmpty(identity, this.killGraceMs, verification));
		// The record may have been quarantined out of the index during the async
		// process window; settle mutations must then report the normal unknown
		// outcome instead of throwing on the missing indexed path.
		if (this.isQuarantined(id, ownerSessionId)) return { id, outcome: "unknown", message: `Unknown terminal ${id}.` };
		if (!signal.ok || !gone) {
			if (!this.processTree.isTreeEmpty(identity, verification)) return this.handleStopSignalFailure(id, ownerSessionId, signal, false, true);
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

	private settleDisposedStop(id: string): TerminalStopResult {
		const current = this.store.getIndexed(id);
		if (!current) return { id, outcome: "failed", message: `Failed to settle terminal ${id}: durable record unavailable.` };
		const exitCode = readExitCode(this.store, taskPaths(this.store, current.id, current.createdAt).exitFile);
		if (exitCode !== undefined) {
			const settled = this.settleNatural(id, exitCode);
			const observed = this.observe(id, false);
			return {
				id,
				outcome: "already-settled",
				task: observed,
				output: this.getOutput(observed, WAIT_OUTPUT_BYTES),
				message: `Terminal ${id} completed before stop disposition with exit ${settled.exitCode ?? "unknown"}.`,
			};
		}
		const cancelled = this.settleCancelled(id);
		return {
			id,
			outcome: "cancelled",
			task: cancelled,
			output: this.getOutput(cancelled, WAIT_OUTPUT_BYTES),
			message: `Cancelled terminal ${id}.`,
		};
	}

	private async finishStop(
		id: string,
		ownerSessionId: string | undefined,
		identity: ProcessTreeIdentity,
		termSignal: ProcessTreeSignalResult,
		restoreOnFailure: boolean,
		verification?: ProcessTreeVerification,
	): Promise<TerminalStopResult> {
		if (!termSignal.ok && !termSignal.forceRequired) return this.handleStopSignalFailure(id, ownerSessionId, termSignal, restoreOnFailure);
		let empty = termSignal.ok && (termSignal.gone || await this.processTree.waitForTreeEmpty(identity, this.termGraceMs, verification));
		if (!empty) {
			const kill = await this.safeVerifiedSignal(identity, "SIGKILL", verification);
			// The record may have been quarantined out of the index during the async
			// process window; settlement must then report the normal unknown outcome
			// instead of throwing on the missing indexed path.
			if (this.isQuarantined(id, ownerSessionId)) return { id, outcome: "unknown", message: `Unknown terminal ${id}.` };
			// TERM (or a failed soft taskkill) may already have removed the leader.
			// From this point onward the persisted anchors are the only safe retry
			// authority, so retain `stopping` on failure for recovery to resume.
			if (!kill.ok) return this.handleStopSignalFailure(id, ownerSessionId, kill, false);
			empty = kill.gone || await this.processTree.waitForTreeEmpty(identity, this.killGraceMs, verification);
		}
		if (!empty) return this.failedStop(id, ownerSessionId, "process tree remains alive after SIGKILL", false);
		// The command may have written exit.code after target collection but before
		// TERM crossed the boundary. Durable natural evidence wins this race. A
		// quarantine during the wait leaves no queryable record: report the normal
		// unknown outcome instead of settleDisposedStop's failed result.
		if (this.isQuarantined(id, ownerSessionId)) return { id, outcome: "unknown", message: `Unknown terminal ${id}.` };
		return this.settleDisposedStop(id);
	}

	private handleStopSignalFailure(
		id: string,
		ownerSessionId: string | undefined,
		signal: ProcessTreeSignalResult,
		restoreOnFailure: boolean,
		suppressOnSettlement = restoreOnFailure,
	): TerminalStopResult {
		// A quarantine during the async stop window leaves no queryable record;
		// report the normal unknown outcome instead of letting the settlement
		// mutation throw on the missing indexed path.
		if (this.isQuarantined(id, ownerSessionId)) return { id, outcome: "unknown", message: `Unknown terminal ${id}.` };
		const current = this.store.getIndexed(id);
		const identity = current ? identityOf(current) : undefined;
		if (identity && this.processTree.isTreeEmpty(identity, current?.processTreeVerification)) {
			return this.settleDisposedStop(id);
		}
		if (signal.identityStatus === "different") {
			this.settleLost(id, null, false);
			const lost = suppressOnSettlement ? this.observe(id, false) : this.store.getIndexed(id)!;
			return { id, outcome: "failed", task: lost, message: `Terminal ${id} process identity changed; recorded lost without signalling.` };
		}
		const reason = signal.identityStatus === "unknown"
			? "process identity could not be verified; refusing to signal"
			: signal.error ?? "process-tree signal failed";
		return this.failedStop(id, ownerSessionId, reason, restoreOnFailure);
	}

	private failedStop(id: string, ownerSessionId: string | undefined, reason: string, restore: boolean): TerminalStopResult {
		if (this.isQuarantined(id, ownerSessionId)) return { id, outcome: "unknown", message: `Unknown terminal ${id}.` };
		const result = restore
			? this.mutate(id, (task) => task.status === "stopping" ? { ...task, status: "running", updatedAt: this.timestamp(task) } : undefined).snapshot
			: this.store.getIndexed(id);
		if (result && !isTerminalTaskSettled(result.status)) this.arm(id);
		if (!restore) this.diagnostic(id, `persisted stop remains pending: ${reason}`);
		return { id, outcome: "failed", task: result, message: `Failed to stop terminal ${id}: ${reason}.` };
	}

	private failUnlaunched(id: string, cause: unknown): void {
		this.settleFailedLaunch(id);
		const current = this.store.getIndexed(id);
		if (current) appendPrivateFile(this.store, current.logFile, `\n[spawn error] ${cause instanceof Error ? cause.message : String(cause)}\n`);
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
		const current = this.store.getIndexed(id);
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

	/**
	 * One authoritative decision per mutation: the update closure runs inside
	 * the store's task lock against the just-read durable snapshot, so claim/ack
	 * predicates can never fire on retained state that disk has already moved
	 * past (including a same-revision content change the revision CAS alone
	 * would accept). A stale expected revision is retried against freshly
	 * loaded state up to MAX_TRANSITION_RETRIES times.
	 */
	private mutate(
		id: string,
		update: (current: TerminalTaskSnapshot) => Omit<TerminalTaskSnapshot, "revision"> | undefined,
	): MutationResult {
		// Classification baseline for the locked no-op adoption site: the retained
		// snapshot this mutation started from. Stale-revision retries below adopt
		// each reloaded authoritative snapshot silently (this.adopt(latest, false)),
		// so reading the map at adoption time would classify the reloaded snapshot
		// against itself and miss the divergence entirely — a retained settled v1
		// vs durable running v2 no-op would return running with no recovery,
		// notification, or publication.
		const retainedBeforeMutation = this.tasks.get(id);
		let latest = retainedBeforeMutation ?? this.store.getIndexed(id);
		if (!latest) throw new Error(`Unknown terminal task ${id}`);
		for (let attempt = 0; attempt < MAX_TRANSITION_RETRIES; attempt += 1) {
			this.adopt(latest, false);
			let changed = false;
			try {
				const transitioned = this.store.transition(id, latest.revision, (current) => {
					const next = update(current);
					if (!next) return undefined;
					changed = true;
					return next;
				});
				if (!changed) {
					// The locked snapshot is authoritative even for a no-op decision;
					// adopt it so retained state stops lagging disk truth — classified
					// against the pre-mutation retained baseline exactly like a refresh
					// adoption so a divergent durable snapshot recovers, notifies, or
					// publishes instead of being adopted silently (a now-running task
					// must not stay unarmed with a stale settled projection and Activity
					// must not go stale).
					this.adoptLockedNoOpSnapshot(transitioned, retainedBeforeMutation);
					return { snapshot: transitioned, changed: false };
				}
				this.adopt(transitioned, true);
				return { snapshot: transitioned, changed: true };
			} catch (error) {
				if (!(error instanceof StaleTerminalTaskRevisionError)) throw error;
				const reloaded = this.store.getIndexed(id);
				if (!reloaded) throw new Error(`Terminal task ${id} disappeared during transition`);
				latest = reloaded;
			}
		}
		this.diagnostic(id, "abandoned transition after repeated stale revisions");
		const current = this.store.getIndexed(id) ?? latest;
		this.adopt(current, false);
		return { snapshot: current, changed: false };
	}

	private adopt(snapshot: TerminalTaskSnapshot, notify: boolean): void {
		const previous = this.tasks.get(snapshot.id);
		this.tasks.set(snapshot.id, snapshot);
		this.ensureRuntime(snapshot);
		if (!notify || previous?.revision === snapshot.revision) return;
		this.notifyChanges([snapshot]);
	}

	/**
	 * Classification for the locked no-op adoption site, applying the same gates
	 * the refresh loops apply at their proven freshness boundary to the
	 * authoritative locked snapshot. The classification baseline is the snapshot
	 * retained when the enclosing mutation started, not the map state at adoption
	 * time: stale-revision retries adopt each reloaded authoritative snapshot
	 * silently on the way to a no-op, so the map would hold the reloaded snapshot
	 * itself and a revision-bumped divergence (retained settled v1 vs running v2
	 * on disk) would classify against itself and recover, notify, and publish
	 * nothing. A recovery-relevant divergence (record new to the projection, or
	 * changed revision/owner/lifecycle status/process identity) triggers the
	 * recover-equivalent side effects (settled log cap, launch-gate release,
	 * arm, reconcile scheduling) and joins a per-task notification; a
	 * delivery-eligibility/receipt change raises only the per-task notification
	 * that wakes the TerminalDeliveryCoordinator; a content-only divergence
	 * publishes the projection once. A cosmetic no-op adoption (identical
	 * content) stays quiet as before. The recovery branch fans out through the
	 * refresh's notification batch and its dedupe-to-latest close: recovery can
	 * synchronously mutate and publish a newer revision (reconcile's
	 * tree-verification mutation, settlement), and notifying the original locked
	 * snapshot after it would reintroduce a newer-then-stale per-task sequence
	 * and duplicate projection fan-out — the batch folds everything into one
	 * final per-task payload per id and exactly one final publication.
	 */
	private adoptLockedNoOpSnapshot(snapshot: TerminalTaskSnapshot, classificationBaseline: TerminalTaskSnapshot | undefined): void {
		this.adopt(snapshot, false);
		if (recoveryRelevantAdoption(classificationBaseline, snapshot)) {
			this.refreshBatchDepth += 1;
			try {
				this.recover(snapshot);
				this.notifyChanges([snapshot]);
			} finally {
				this.refreshBatchDepth -= 1;
				this.drainRefreshBatch([snapshot], false);
			}
			return;
		}
		if (classificationBaseline !== undefined && deliveryEligibilityChanged(classificationBaseline, snapshot)) {
			this.notifyChanges([snapshot]);
			return;
		}
		if (classificationBaseline !== undefined && !snapshotContentEquals(classificationBaseline, snapshot)) this.publishProjection();
	}

	/**
	 * Fan a batch of changed snapshots out: per-task listeners receive each
	 * change, projection listeners receive exactly one publication of the final
	 * projection. Observer errors cannot break lifecycle transitions.
	 */
	private notifyChanges(changed: readonly TerminalTaskSnapshot[]): void {
		if (changed.length === 0) return;
		if (this.refreshBatchDepth > 0) {
			// A refresh batch is open: queue the per-task changes (deduped to the
			// latest snapshot per id) and publish nothing — an intermediate
			// projection must never reach a listener mid-refresh. The refresh's
			// single merged fan-out publishes once adopt and prune are complete.
			for (const snapshot of changed) this.refreshBatchQueued.set(snapshot.id, snapshot);
			return;
		}
		for (const snapshot of changed) {
			for (const listener of this.listeners) {
				try {
					listener(snapshot);
				} catch {
					// Observers cannot break durable lifecycle transitions.
				}
			}
		}
		if (this.snapshotListeners.size === 0) return;
		this.publishProjection();
	}

	/**
	 * One merged fan-out that closes a notification batch — transactional across
	 * the success and the throw path: fold in whatever a synchronous recovery
	 * path queued mid-batch plus everything the caller collected, then resolve
	 * each id to the latest retained snapshot at fan-out time (a fresh-then-stale
	 * v2→v1 per-task sequence can never be observed). Per-task listeners receive
	 * each final payload (waiters re-evaluate completion, the delivery
	 * coordinator re-runs its claim pass), and projection listeners receive
	 * exactly one publication of the current retained projection — a publication
	 * a sync-in-batch path deferred through publishProjection's batch guard is
	 * superseded by it. The queue is drained unconditionally, so batch state
	 * never carries across refresh calls.
	 */
	private drainRefreshBatch(changed: readonly TerminalTaskSnapshot[], adoptionChangedStoredState: boolean): void {
		const fanout = new Map<string, TerminalTaskSnapshot>();
		for (const snapshot of changed) fanout.set(snapshot.id, snapshot);
		for (const [id, snapshot] of this.refreshBatchQueued) fanout.set(id, snapshot);
		this.refreshBatchQueued.clear();
		for (const id of fanout.keys()) {
			const retained = this.tasks.get(id);
			if (retained) fanout.set(id, retained);
		}
		const deferredProjection = this.projectionPublishDeferred;
		this.projectionPublishDeferred = false;
		if (fanout.size > 0) {
			this.notifyChanges([...fanout.values()]);
		} else if (adoptionChangedStoredState || deferredProjection) {
			// A content-only rewrite replaced stored snapshots with differing
			// content without any per-task change — or a sync-in-batch path deferred
			// a projection publication to this close: publish the updated projection
			// exactly once so subscribers do not stay stale.
			this.publishProjection();
		}
	}

	/** Publish the current retained projection once to snapshot listeners; observer errors cannot break lifecycle transitions. */
	private publishProjection(): void {
		if (this.refreshBatchDepth > 0) {
			// A refresh batch is open: defer to the batch close — its single merged
			// fan-out (or adoption-only publication) supersedes the intermediate
			// projection publishing here would expose.
			this.projectionPublishDeferred = true;
			return;
		}
		if (this.snapshotListeners.size === 0) return;
		const snapshots = this.getSnapshots();
		for (const listener of this.snapshotListeners) {
			try {
				listener(snapshots);
			} catch {
				// Projection observers cannot break durable lifecycle transitions.
			}
		}
	}

	private clearPoll(id: string): void {
		const runtime = this.runtime.get(id);
		if (!this.indexInitialized) this.scheduleIndexInitRetryTimer();
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
