import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { captureProcessStartTime } from "./process-tree.js";
import {
	TERMINAL_TASK_SCHEMA_VERSION,
	isTerminalTaskSettled,
	type TerminalCompletionPolicy,
	type TerminalDeliveryState,
	type TerminalTaskSnapshot,
	type TerminalTaskStatus,
} from "./task-types.js";

export type TerminalTaskStoreDiagnosticKind = "corrupt" | "legacy" | "duplicate" | "io";

export interface TerminalTaskStoreDiagnostic {
	readonly kind: TerminalTaskStoreDiagnosticKind;
	readonly path: string;
	readonly message: string;
}

export type TerminalTaskStoreReadKind = "full-scan" | "metadata";

/** Explicit outcome of one full validated index pass. */
export interface TerminalTaskIndexRefreshResult {
	/** false when the store directory could not be read; the last good index generation is preserved. */
	readonly ok: boolean;
	/**
	 * Generation completeness. False when the directory read failed or when any
	 * transient per-file read prevented indexing a candidate the prior index did
	 * not already preserve; a known record's transient read counts as complete
	 * coverage of that id (its prior entry is retained and reported through
	 * `preservedIds`), while corrupt, duplicate, and legacy quarantines are
	 * terminal decisions that never make a generation incomplete. Callers that
	 * must guarantee eventual visibility of every durable record — the manager's
	 * index initialization — keep retrying until a complete scan lands.
	 */
	readonly complete: boolean;
	readonly snapshots: readonly TerminalTaskSnapshot[];
	/**
	 * Ids whose metadata read failed transiently but whose prior path and compact
	 * index entry were retained. Snapshot consumers that prune stale entries (the
	 * manager's retained projection) must keep their retained full snapshot for
	 * these ids in this successful generation instead of pruning them.
	 */
	readonly preservedIds?: readonly string[];
}

export interface TerminalTaskStoreOptions {
	readonly rootDir?: string;
	readonly onDiagnostic?: (diagnostic: TerminalTaskStoreDiagnostic) => void;
	readonly lockTimeoutMs?: number;
	readonly lockPollMs?: number;
	/** Test seam for deterministic projection scan/read assertions. */
	readonly onRead?: (kind: TerminalTaskStoreReadKind) => void;
	/** Test seam for deterministic stale-lock replacement races. */
	readonly beforeAbandonedLockRename?: () => void;
	/** Test seam for deterministic per-file metadata-read faults inside the index scan. */
	readonly metaReadFault?: (path: string) => Error | undefined;
}

/** Compact derived selection state. Durable metadata remains authoritative. */
export interface IndexedTerminalTask {
	readonly id: string;
	readonly ownerSessionId: string;
	readonly revision: number;
	readonly status: TerminalTaskStatus;
	readonly completionPolicy: TerminalCompletionPolicy;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly deliveryState: TerminalDeliveryState;
	readonly completionId?: string;
	readonly deliveryClaimToken?: string;
}

type MutableIndexedTerminalTask = { -readonly [K in keyof IndexedTerminalTask]: IndexedTerminalTask[K] };

export class StaleTerminalTaskRevisionError extends Error {
	public constructor(
		public readonly id: string,
		public readonly expectedRevision: number,
		public readonly actualRevision: number,
	) {
		super(`Stale terminal task transition for ${id}: expected revision ${expectedRevision}, found ${actualRevision}`);
	}
}

export class CorruptTerminalTaskRecordError extends Error {}
export class TerminalTaskLockBusyError extends Error {}

const STATUSES = new Set<TerminalTaskStatus>(["starting", "running", "stopping", "completed", "failed", "cancelled", "lost"]);
const POLICIES = new Set<TerminalCompletionPolicy>(["passive", "wake"]);
const DELIVERY_STATES = new Set<TerminalDeliveryState>(["none", "pending", "claimed", "delivered", "suppressed"]);
const ACTIVE_STATUSES = new Set<TerminalTaskStatus>(["starting", "running", "stopping"]);
const TERMINAL_ID_PATTERN = /^term-[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126})$/;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_POLL_MS = 10;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));
/** Transient per-file read errnos that must never quarantine an indexed record. */
const TRANSIENT_READ_ERRNOS = new Set(["EACCES", "EIO", "EMFILE", "ENFILE", "EAGAIN"]);
const KNOWN_ARTIFACT_NAMES = ["output.log", "exit.code", "launch.ready", "run.sh", "run.cmd"] as const;

interface LockOwner {
	readonly token: string;
	readonly pid: number;
	readonly processStartTime?: string;
	readonly verifiable: boolean;
}

// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- durable store boundary: meta/lock files and snapshots are untrusted JSON,
// so `unknown` inputs and open records are this module's parsing contract.
function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isOptionalTimestamp(value: unknown): value is number | undefined {
	return value === undefined || isSafeInteger(value);
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function isStringValue(value: unknown): value is string {
	return typeof value === "string";
}

function isNumberValue(value: unknown): value is number {
	return typeof value === "number";
}

function isStoredObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProcessTreeVerification(value: unknown): boolean {
	if (value === undefined) return true;
	if (!isStoredObject(value)) return false;
	const { members } = value;
	if (!Array.isArray(members) || members.length === 0 || members.length > 4096) return false;
	const pids = new Set<number>();
	for (const member of members) {
		if (!isStoredObject(member)) return false;
		if (!isPositiveInteger(member.pid) || !hasText(member.processStartTime) || pids.has(member.pid)) return false;
		pids.add(member.pid);
	}
	return true;
}

function hasText(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function hasPrivateMode(mode: number, directory: boolean): boolean {
	if (process.platform === "win32") return true;
	const expected = directory ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE;
	return (mode & 0o777) === expected;
}

function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		// Mirror the original contract exactly: only errno-bearing rejections with a non-ENOENT code count as existing.
		return error instanceof Error && errorHasCode(error) && !errorMatches(error, "ENOENT");
	}
}

/** Extract the errno string from a Node rejection. */
function errorCode(error: Error): string | undefined {
	// SAFETY: lstat/rename/unlink reject with NodeJS.ErrnoException whose optional `code` carries the errno string.
	const code = (error as NodeJS.ErrnoException).code;
	return code === undefined || code === null ? undefined : String(code);
}

function isTransientReadError(error: unknown): boolean {
	return causeIsError(error) && TRANSIENT_READ_ERRNOS.has(errorCode(error) ?? "");
}

function errorMatches(cause: unknown, code: string): boolean {
	return causeIsError(cause) && errorCode(cause) === code;
}

function causeIsError(cause: unknown): cause is NodeJS.ErrnoException {
	return cause instanceof Error;
}

function errorHasCode(error: NodeJS.ErrnoException): boolean {
	return error.code !== undefined && error.code !== null;
}

function sleepSync(milliseconds: number): void {
	Atomics.wait(LOCK_SLEEP, 0, 0, Math.max(1, milliseconds));
}

export function isValidTerminalTaskId(id: string): boolean {
	return TERMINAL_ID_PATTERN.test(id) && !id.includes("..");
}

/** Single canonical terminal ordering: newest createdAt first. */
function terminalCreatedAtDesc(left: Readonly<{ createdAt: number }>, right: Readonly<{ createdAt: number }>): number {
	return right.createdAt - left.createdAt;
}

function isStatusValue(value: unknown): value is TerminalTaskStatus {
	// SAFETY: membership in STATUSES proves this string is a TerminalTaskStatus.
	return typeof value === "string" && STATUSES.has(value as TerminalTaskStatus);
}

function isPolicyValue(value: unknown): value is TerminalCompletionPolicy {
	// SAFETY: membership in POLICIES proves this string is a TerminalCompletionPolicy.
	return typeof value === "string" && POLICIES.has(value as TerminalCompletionPolicy);
}

function isDeliveryStateValue(value: unknown): value is TerminalDeliveryState {
	// SAFETY: membership in DELIVERY_STATES proves this string is a TerminalDeliveryState.
	return typeof value === "string" && DELIVERY_STATES.has(value as TerminalDeliveryState);
}

export function parseTerminalTaskSnapshot(value: unknown): TerminalTaskSnapshot | undefined {
	if (!isStoredObject(value)) return undefined;
	// SAFETY: the record's fields are untrusted JSON; each one is individually validated below before use.
	const record = value as Partial<TerminalTaskSnapshot>;
	if (
		record.schemaVersion !== TERMINAL_TASK_SCHEMA_VERSION ||
		!isPositiveInteger(record.revision) ||
		!isStringValue(record.id) || !isValidTerminalTaskId(record.id) ||
		!(record.sourceId === undefined || (hasText(record.sourceId) && record.sourceId.length <= 512)) ||
		!hasText(record.ownerSessionId) ||
		!hasText(record.command) ||
		!hasText(record.cwd) ||
		!hasText(record.title) ||
		!isStatusValue(record.status) ||
		!isPolicyValue(record.completionPolicy) ||
		!isPositiveInteger(record.createdAt) ||
		!isPositiveInteger(record.updatedAt) ||
		record.updatedAt < record.createdAt ||
		!isOptionalTimestamp(record.settledAt) ||
		!(record.exitCode === undefined || record.exitCode === null || Number.isSafeInteger(record.exitCode)) ||
		!isOptionalTimestamp(record.observedAt) ||
		!isOptionalTimestamp(record.consumedAt) ||
		!isDeliveryStateValue(record.deliveryState) ||
		!isOptionalString(record.completionId) ||
		!isOptionalString(record.deliveryClaimToken) ||
		!(record.pid === undefined || isPositiveInteger(record.pid)) ||
		!(record.processGroupId === undefined || isPositiveInteger(record.processGroupId)) ||
		!isOptionalString(record.processStartTime) ||
		!isProcessTreeVerification(record.processTreeVerification) ||
		!hasText(record.logFile) || !isAbsolute(record.logFile) || resolve(record.logFile) !== record.logFile
	) {
		return undefined;
	}

	const status = isStatusValue(record.status) ? record.status : undefined;
	if (status === undefined) return undefined;
	const settled = isTerminalTaskSettled(status);
	const hasIdentity = record.pid !== undefined || record.processGroupId !== undefined || record.processStartTime !== undefined;
	const completeIdentity = isPositiveInteger(record.pid) && isPositiveInteger(record.processGroupId) && hasText(record.processStartTime);
	if (hasIdentity && !completeIdentity) return undefined;
	if ((status === "running" || status === "stopping") && !completeIdentity) return undefined;
	if (status === "starting" && (hasIdentity || record.processTreeVerification !== undefined)) return undefined;
	if (record.processTreeVerification !== undefined && !completeIdentity) return undefined;

	if (ACTIVE_STATUSES.has(status)) {
		if (
			record.settledAt !== undefined || record.exitCode !== undefined || record.observedAt !== undefined ||
			record.consumedAt !== undefined || record.completionId !== undefined || record.deliveryState !== "none"
		) return undefined;
	} else {
		if (
			!isPositiveInteger(record.settledAt) || record.settledAt < record.createdAt || record.settledAt > record.updatedAt ||
			!hasText(record.completionId) || record.deliveryState === "none"
		) return undefined;
		if (status === "completed" && record.exitCode !== 0) return undefined;
		if (status === "failed" && !(record.exitCode === null || (Number.isSafeInteger(record.exitCode) && record.exitCode !== 0))) return undefined;
		if (status === "cancelled" && record.exitCode !== null) return undefined;
		if (status === "lost" && !(record.exitCode === null || Number.isSafeInteger(record.exitCode))) return undefined;
	}

	for (const timestamp of [record.observedAt, record.consumedAt]) {
		if (timestamp !== undefined && (timestamp < record.createdAt || timestamp > record.updatedAt)) return undefined;
	}
	if (record.consumedAt !== undefined && record.observedAt === undefined) return undefined;
	if (record.deliveryState === "suppressed" && record.observedAt === undefined) return undefined;
	if ((record.deliveryState === "pending" || record.deliveryState === "claimed") && (record.observedAt !== undefined || record.consumedAt !== undefined)) return undefined;
	if (record.deliveryState === "claimed" ? !hasText(record.deliveryClaimToken) : record.deliveryClaimToken !== undefined) return undefined;
	if (!settled && record.deliveryState !== "none") return undefined;

	// SAFETY: every field above was validated against TerminalTaskSnapshot's invariants before this point.
	return record as TerminalTaskSnapshot;
}

function schemaVersionOf(value: unknown): number | undefined {
	if (!isStoredObject(value)) return undefined;
	return isNumberValue(value.schemaVersion) ? value.schemaVersion : undefined;
}

function assertOwnedByCurrentUser(path: string, uid: number): void {
	const stat = lstatSync(path);
	if (stat.uid !== uid) throw new Error(`Terminal store path is owned by a different user: ${path}`);
}

function assertPrivateDirectory(path: string): void {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected private directory: ${path}`);
	if (!hasPrivateMode(stat.mode, true)) throw new Error(`Directory permissions must be 0700: ${path}`);
}

function defaultTerminalStoreRoot(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "state", "sumocode-terminals");
}

function sameFileIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function openPrivateExistingFile(path: string, flags: number): number {
	const resolvedPath = resolve(path);
	const before = lstatSync(resolvedPath);
	if (before.isSymbolicLink() || !before.isFile()) throw new Error(`Expected regular non-reparse file: ${resolvedPath}`);
	if (!hasPrivateMode(before.mode, false)) throw new Error(`File permissions must be 0600: ${resolvedPath}`);
	if (realpathSync(resolvedPath) !== resolvedPath) throw new Error(`Terminal artifact path must be canonical: ${resolvedPath}`);
	const descriptor = openSync(resolvedPath, flags | NO_FOLLOW);
	try {
		const opened = fstatSync(descriptor);
		const after = lstatSync(resolvedPath);
		if (!opened.isFile() || after.isSymbolicLink() || !after.isFile()) throw new Error(`Expected regular non-reparse file: ${resolvedPath}`);
		if (!sameFileIdentity(before, opened) || !sameFileIdentity(opened, after)) throw new Error(`Terminal artifact changed during safe open: ${resolvedPath}`);
		if (!hasPrivateMode(opened.mode, false) || !hasPrivateMode(after.mode, false)) throw new Error(`File permissions must be 0600: ${resolvedPath}`);
		if (realpathSync(resolvedPath) !== resolvedPath) throw new Error(`Terminal artifact path must be canonical: ${resolvedPath}`);
		return descriptor;
	} catch (error) {
		closeSync(descriptor);
		throw error;
	}
}

function assertPrivateFile(path: string): void {
	const descriptor = openPrivateExistingFile(path, constants.O_RDONLY);
	closeSync(descriptor);
}

function readFileNoFollow(path: string): string {
	const descriptor = openPrivateExistingFile(path, constants.O_RDONLY);
	try {
		return readFileSync(descriptor, "utf8");
	} finally {
		closeSync(descriptor);
	}
}

function writeExclusivePrivateFile(path: string, contents: string): void {
	const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, PRIVATE_FILE_MODE);
	try {
		fchmodSync(descriptor, PRIVATE_FILE_MODE);
		writeFileSync(descriptor, contents, "utf8");
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function atomicWriteJson(path: string, value: TerminalTaskSnapshot): void {
	const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, PRIVATE_FILE_MODE);
		fchmodSync(descriptor, PRIVATE_FILE_MODE);
		writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
		try {
			const directoryDescriptor = openSync(dirname(path), constants.O_RDONLY | NO_FOLLOW);
			try {
				fsyncSync(directoryDescriptor);
			} finally {
				closeSync(directoryDescriptor);
			}
		} catch {
			// Some filesystems do not permit directory fsync. File fsync plus the
			// same-directory atomic rename has already completed.
		}
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		try {
			unlinkSync(temporary);
		} catch {
			// Swallowed: either the rename consumed the temporary name or the write
			// is already failing — an unlink error must never mask the primary
			// result or exception.
		}
	}
}

function isBooleanValue(value: unknown): value is boolean {
	return typeof value === "boolean";
}

function parseLockOwner(path: string): LockOwner | undefined {
	try {
		// SAFETY: owner.json is written by this store; malformed content is rejected field-by-field below.
		const value = JSON.parse(readFileNoFollow(path)) as Partial<LockOwner>;
		if (!hasText(value.token) || !isPositiveInteger(value.pid) || !isBooleanValue(value.verifiable)) return undefined;
		if (value.verifiable && !hasText(value.processStartTime)) return undefined;
		if (!value.verifiable && value.processStartTime !== undefined) return undefined;
		// SAFETY: token/pid/verifiable/processStartTime were each validated above.
		return value as LockOwner;
	} catch {
		return undefined;
	}
}

function processProvesOwnerGone(owner: LockOwner): boolean {
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		if (errorMatches(error, "ESRCH")) return true;
		if (!errorMatches(error, "EPERM")) return false;
	}
	if (!owner.verifiable || !owner.processStartTime) return false;
	const actualStartTime = captureProcessStartTime(owner.pid);
	return actualStartTime !== undefined && actualStartTime !== owner.processStartTime;
}

export class TerminalTaskStore {
	public readonly rootDir: string;
	private readonly metaPathById = new Map<string, string>();
	private readonly indexedById = new Map<string, IndexedTerminalTask>();
	private readonly indexedIdsByOwner = new Map<string, Set<string>>();
	/**
	 * Store-instance-lifetime identity reservation: id → canonical metadata
	 * path, kept separate from the active query index above. One validated
	 * adoption or create reserves the id; refresh quarantine may drop the id
	 * from the active index but never releases or migrates this binding, so no
	 * other path can adopt the id and create cannot resurrect it in this
	 * process. Bounded security state by design: compact canonical paths only,
	 * never full snapshots, so a Plan 106 bound on retained manager snapshots
	 * leaves this reservation as O(ids) paths without becoming a second durable
	 * authority.
	 */
	private readonly reservedPathById = new Map<string, string>();
	private readonly onDiagnostic?: (diagnostic: TerminalTaskStoreDiagnostic) => void;
	private readonly onRead?: (kind: TerminalTaskStoreReadKind) => void;
	private readonly lockTimeoutMs: number;
	private readonly lockPollMs: number;
	private readonly processStartTime: string | undefined;
	private readonly beforeAbandonedLockRename?: () => void;
	private readonly metaReadFault?: (path: string) => Error | undefined;
	/** Consecutive refreshIndex scan failures are diagnosed once per episode; the first successful scan resets the dedupe. */
	private refreshFailureDiagnosed = false;

	public constructor(options: TerminalTaskStoreOptions = {}) {
		const requestedRoot = resolve(options.rootDir ?? defaultTerminalStoreRoot());
		// process.getuid is POSIX-only and may be absent at runtime on Windows builds.
		const uid = process.getuid?.();
		try {
			const existing = lstatSync(requestedRoot);
			if (existing.isSymbolicLink()) throw new Error(`Terminal store root must not be a symlink: ${requestedRoot}`);
			if (uid !== undefined) assertOwnedByCurrentUser(requestedRoot, uid);
		} catch (error) {
			if (!errorMatches(error, "ENOENT")) throw error;
		}
		mkdirSync(requestedRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
		if (uid !== undefined) assertOwnedByCurrentUser(requestedRoot, uid);
		chmodSync(requestedRoot, PRIVATE_DIRECTORY_MODE);
		assertPrivateDirectory(requestedRoot);
		this.rootDir = realpathSync(requestedRoot);
		assertPrivateDirectory(this.rootDir);
		this.onDiagnostic = options.onDiagnostic;
		this.onRead = options.onRead;
		this.lockTimeoutMs = Math.max(1, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
		this.lockPollMs = Math.max(1, options.lockPollMs ?? DEFAULT_LOCK_POLL_MS);
		this.processStartTime = captureProcessStartTime(process.pid);
		this.beforeAbandonedLockRename = options.beforeAbandonedLockRename;
		this.metaReadFault = options.metaReadFault;
	}

	/** Rebuild every derived path/selection bucket from one validated disk pass. */
	public refreshIndex(): TerminalTaskIndexRefreshResult {
		this.onRead?.("full-scan");
		let entries: Dirent[];
		try {
			entries = readdirSync(this.rootDir, { withFileTypes: true });
		} catch (error) {
			// A transient scan failure (EACCES, EMFILE, ...) must never replace the
			// last good generation with an empty index. The failure is reported
			// explicitly so freshness-boundary callers can distinguish an unreadable
			// store from a successfully refreshed empty one. An initial failure
			// naturally leaves the fresh empty index in place.
			// Consecutive scan failures are diagnosed once per episode: a manager's
			// lazy initialization retries share one episode with the constructor
			// scan, so a persistently unreadable store does not repeat the
			// store-level I/O diagnostic behind the caller's own deduped episode
			// diagnostic. The first successful scan resets the dedupe.
			if (!this.refreshFailureDiagnosed) {
				this.refreshFailureDiagnosed = true;
				this.diagnostic("io", this.rootDir, error);
			}
			return { ok: false, complete: false, snapshots: [] };
		}
		// The prior path→id reverse index is built lazily on the first transient
		// read: a scan without transient failures never pays the O(index) build,
		// and duplicate identity never depends on it because the persistent
		// reservation map answers those decisions with one O(1) lookup.
		let priorIdByPath: Map<string, string> | undefined;
		const priorIdForPath = (path: string): string | undefined => {
			let reverse = priorIdByPath;
			if (!reverse) {
				reverse = new Map();
				for (const [id, priorPath] of this.metaPathById) reverse.set(priorPath, id);
				priorIdByPath = reverse;
			}
			return reverse.get(path);
		};
		const snapshots: TerminalTaskSnapshot[] = [];
		const paths = new Map<string, string>();
		// Whether this successful scan indexed every candidate it could have: a
		// transient read of a record unknown to the prior index skips it, so the
		// generation is reported incomplete and freshness-boundary callers keep
		// retrying until a scan reads it.
		let generationComplete = true;
		// Prior compact entries must be captured during the scan: replaceIndex
		// clears the derived maps before the retained entries are re-applied.
		const preservedEntries: IndexedTerminalTask[] = [];
		for (const entry of entries) {
			const taskDirectory = join(this.rootDir, entry.name);
			if (entry.isSymbolicLink()) {
				this.diagnostic("corrupt", taskDirectory, "symlink/reparse task directories are not allowed");
				continue;
			}
			if (!entry.isDirectory()) continue;
			try {
				this.assertTaskDirectory(taskDirectory);
			} catch (error) {
				this.diagnostic("corrupt", taskDirectory, error);
				continue;
			}
			const metaPath = join(taskDirectory, "meta.json");
			if (!pathExists(metaPath)) continue;
			const read = this.readCandidate(metaPath);
			if (read.kind === "transient") {
				// A transient per-file read failure must not quarantine a record the
				// last good index already knows. Retain its prior path and compact
				// entry, and report the id so the manager preserves its retained full
				// snapshot in this successful generation instead of pruning it.
				const priorId = priorIdForPath(metaPath);
				const priorEntry = priorId === undefined ? undefined : this.indexedById.get(priorId);
				if (priorEntry && !paths.has(priorEntry.id)) {
					preservedEntries.push(priorEntry);
					paths.set(priorEntry.id, metaPath);
				}
				// A preserved known record keeps this generation's coverage of its id
				// complete; a candidate the prior index does not know is skipped
				// unindexed, so the generation is incomplete.
				if (!priorEntry) generationComplete = false;
				continue;
			}
			if (read.kind === "invalid") continue;
			// Known-path reservation: a parsed id whose reserved path differs is a
			// duplicate of that prior record no matter where it sorts in this scan —
			// and even if the prior path later fails transiently, is corrupt, has
			// disappeared by the time it is visited, or was already quarantined out
			// of the active index by a previous refresh. The reservation is
			// store-instance lifetime: the known path owns the identity; a duplicate
			// never takes it over.
			const reservedPath = this.reservedPathById.get(read.snapshot.id);
			if (reservedPath !== undefined && reservedPath !== metaPath) {
				this.diagnostic("duplicate", metaPath, `duplicate terminal id ${read.snapshot.id}`);
				continue;
			}
			if (paths.has(read.snapshot.id)) {
				this.diagnostic("duplicate", metaPath, `duplicate terminal id ${read.snapshot.id}`);
				continue;
			}
			paths.set(read.snapshot.id, metaPath);
			snapshots.push(read.snapshot);
		}
		this.replaceIndex(snapshots, paths);
		for (const priorEntry of preservedEntries) {
			this.metaPathById.set(priorEntry.id, paths.get(priorEntry.id)!);
			this.indexedById.set(priorEntry.id, priorEntry);
			this.ownerMembership(priorEntry).add(priorEntry.id);
		}
		// A successful scan ends the failure episode: the next failure is
		// diagnosed again.
		this.refreshFailureDiagnosed = false;
		return { ok: true, complete: generationComplete, snapshots, preservedIds: preservedEntries.map((entry) => entry.id) };
	}

	/** O(1) no-I/O owner membership check against the compact index. */
	public isIndexedOwner(id: string, ownerSessionId: string): boolean {
		return this.indexedById.get(id)?.ownerSessionId === ownerSessionId;
	}

	public listOwnedIndexed(ownerSessionId: string): readonly IndexedTerminalTask[] {
		const ids = this.indexedIdsByOwner.get(ownerSessionId);
		if (!ids || ids.size === 0) return [];
		return [...ids]
			.flatMap((id) => {
				const indexed = this.indexedById.get(id);
				return indexed ? [indexed] : [];
			})
			.sort(terminalCreatedAtDesc);
	}

	public create(snapshot: TerminalTaskSnapshot, metaPath: string): TerminalTaskSnapshot {
		if (snapshot.schemaVersion !== TERMINAL_TASK_SCHEMA_VERSION || snapshot.revision !== 1) {
			throw new Error("New terminal records must start at the current schema and revision 1");
		}
		const resolvedMetaPath = this.assertStoreMetaPath(metaPath);
		this.assertSnapshotPath(snapshot, resolvedMetaPath);
		return this.withTaskLock(resolvedMetaPath, () => {
			if (pathExists(resolvedMetaPath)) throw new Error(`Terminal metadata already exists: ${resolvedMetaPath}`);
			// A reserved id must be rejected before the durable write or index
			// replacement — even when an earlier refresh already quarantined the
			// reserved record out of the active index — or a new record could hijack
			// the reserved identity and leak across owner buckets. The reservation
			// check is one O(1) map lookup: no scan, no metadata read.
			const reservedPath = this.reservedPathById.get(snapshot.id);
			if (reservedPath !== undefined) {
				throw new Error(`Terminal id ${snapshot.id} is already reserved at ${reservedPath}`);
			}
			atomicWriteJson(resolvedMetaPath, snapshot);
			this.reservedPathById.set(snapshot.id, resolvedMetaPath);
			this.metaPathById.set(snapshot.id, resolvedMetaPath);
			this.replaceIndexedEntry(snapshot);
			return snapshot;
		});
	}

	/** Read one known indexed record without falling back to a directory scan. */
	public getIndexed(id: string): TerminalTaskSnapshot | undefined {
		const path = this.metaPathById.get(id);
		if (!path) return undefined;
		return this.readCurrent(path);
	}

	/** Verify a direct child directory before creating or opening task artifacts. */
	public assertTaskDirectory(path: string): string {
		const resolvedPath = resolve(path);
		const relativePath = relative(this.rootDir, resolvedPath);
		if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath) || dirname(relativePath) !== ".") {
			throw new Error("Terminal task directory must be a direct child of the store root");
		}
		assertPrivateDirectory(this.rootDir);
		if (realpathSync(this.rootDir) !== this.rootDir) throw new Error(`Terminal store root must be canonical: ${this.rootDir}`);
		assertPrivateDirectory(resolvedPath);
		if (realpathSync(resolvedPath) !== resolvedPath) throw new Error(`Terminal task directory must be canonical and non-reparse: ${resolvedPath}`);
		return resolvedPath;
	}

	/** Safely open an existing regular artifact confined to a verified task directory. */
	public openArtifact(path: string, flags: number): number {
		const resolvedPath = resolve(path);
		const taskDirectory = this.assertTaskDirectory(dirname(resolvedPath));
		if (dirname(resolvedPath) !== taskDirectory || basename(resolvedPath) !== basename(path)) {
			throw new Error("Terminal artifact must be a direct child of its task directory");
		}
		return openPrivateExistingFile(resolvedPath, flags);
	}

	/**
	 * CAS one durable transition under the record's task lock. `update` runs
	 * against the authoritative snapshot just read under that lock — never a
	 * retained projection — so eligibility predicates decide on disk truth.
	 * Returning `undefined` records a no-op: the lock is honored, nothing is
	 * written, and the current snapshot is returned unchanged. A revision
	 * mismatch still fails with StaleTerminalTaskRevisionError before `update`
	 * runs, so a changed record is retried against freshly loaded state.
	 */
	public transition(
		id: string,
		expectedRevision: number,
		update: (current: TerminalTaskSnapshot) => Omit<TerminalTaskSnapshot, "revision"> | undefined,
	): TerminalTaskSnapshot {
		const path = this.metaPathById.get(id);
		if (!path) throw new Error(`Unknown terminal task ${id}`);
		return this.withTaskLock(path, () => {
			const current = this.readCurrent(path);
			if (!current) throw new CorruptTerminalTaskRecordError(`Terminal record ${id} is corrupt or unreadable`);
			if (current.revision !== expectedRevision) {
				throw new StaleTerminalTaskRevisionError(id, expectedRevision, current.revision);
			}
			const decided = update(current);
			if (!decided) {
				// The locked snapshot is authoritative even for a no-op decision:
				// refresh this record's compact entry from it so later candidate
				// selection (claim/acknowledgement/retry-delay) sees state an external
				// writer already advanced, instead of looping on reread/retry until the
				// next explicit refreshIndex boundary.
				this.replaceIndexedEntry(current);
				return current;
			}
			const next = { ...decided, revision: current.revision + 1 } satisfies TerminalTaskSnapshot;
			if (next.id !== current.id || next.ownerSessionId !== current.ownerSessionId || next.schemaVersion !== current.schemaVersion || next.createdAt !== current.createdAt || next.logFile !== current.logFile) {
				throw new Error("Terminal task identity fields are immutable");
			}
			this.assertSnapshotPath(next, path);
			atomicWriteJson(path, next);
			this.replaceIndexedEntry(next);
			return next;
		});
	}

	private replaceIndex(snapshots: readonly TerminalTaskSnapshot[], paths: ReadonlyMap<string, string>): void {
		this.metaPathById.clear();
		this.indexedById.clear();
		this.indexedIdsByOwner.clear();
		for (const snapshot of snapshots) {
			const path = paths.get(snapshot.id);
			if (!path) continue;
			this.reservedPathById.set(snapshot.id, path);
			this.metaPathById.set(snapshot.id, path);
			this.indexedById.set(snapshot.id, this.compact(snapshot));
			this.ownerMembership(snapshot).add(snapshot.id);
		}
	}

	private replaceIndexedEntry(snapshot: TerminalTaskSnapshot): void {
		const previous = this.indexedById.get(snapshot.id);
		if (previous && previous.ownerSessionId !== snapshot.ownerSessionId) {
			// A locked no-op against an externally rewritten record must migrate the
			// id out of the stale owner bucket before adding the new one, so the id
			// never answers in two owners' lists; emptied buckets are removed.
			const staleIds = this.indexedIdsByOwner.get(previous.ownerSessionId);
			if (staleIds) {
				staleIds.delete(snapshot.id);
				if (staleIds.size === 0) this.indexedIdsByOwner.delete(previous.ownerSessionId);
			}
		}
		this.indexedById.set(snapshot.id, this.compact(snapshot));
		this.ownerMembership(snapshot).add(snapshot.id);
	}

	/** O(1) owner membership; createdAt-desc ordering is applied lazily by listOwnedIndexed. */
	private ownerMembership(record: Readonly<{ ownerSessionId: string }>): Set<string> {
		let ids = this.indexedIdsByOwner.get(record.ownerSessionId);
		if (!ids) {
			ids = new Set<string>();
			this.indexedIdsByOwner.set(record.ownerSessionId, ids);
		}
		return ids;
	}

	private compact(snapshot: TerminalTaskSnapshot): IndexedTerminalTask {
		const indexed: MutableIndexedTerminalTask = {
			id: snapshot.id,
			ownerSessionId: snapshot.ownerSessionId,
			revision: snapshot.revision,
			status: snapshot.status,
			completionPolicy: snapshot.completionPolicy,
			createdAt: snapshot.createdAt,
			updatedAt: snapshot.updatedAt,
			deliveryState: snapshot.deliveryState,
		};
		if (snapshot.completionId !== undefined) indexed.completionId = snapshot.completionId;
		if (snapshot.deliveryClaimToken !== undefined) indexed.deliveryClaimToken = snapshot.deliveryClaimToken;
		return Object.freeze(indexed);
	}

	private assertStoreMetaPath(path: string): string {
		const resolvedPath = resolve(path);
		const relativePath = relative(this.rootDir, resolvedPath);
		if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath) || basename(resolvedPath) !== "meta.json") {
			throw new Error("Terminal metadata must live in a task directory under the store root");
		}
		const taskDirectory = dirname(resolvedPath);
		this.assertTaskDirectory(taskDirectory);
		return resolvedPath;
	}

	private assertSnapshotPath(snapshot: TerminalTaskSnapshot, metaPath: string): void {
		if (!parseTerminalTaskSnapshot(snapshot)) throw new Error("Invalid terminal task snapshot");
		const resolvedMetaPath = this.assertStoreMetaPath(metaPath);
		const taskDirectory = dirname(resolvedMetaPath);
		if (basename(taskDirectory) !== `${snapshot.id}-${snapshot.createdAt}`) throw new Error("Terminal task directory does not match id and creation time");
		const expectedLogFile = join(taskDirectory, "output.log");
		if (snapshot.logFile !== expectedLogFile) throw new Error("Terminal log path must be canonical and store-confined");
		for (const name of KNOWN_ARTIFACT_NAMES) {
			const artifact = join(taskDirectory, name);
			if (!pathExists(artifact)) continue;
			assertPrivateFile(artifact);
			if (realpathSync(artifact) !== artifact) throw new Error(`Terminal artifact must not escape its task directory: ${artifact}`);
		}
		assertPrivateFile(snapshot.logFile);
	}

	/** One indexed candidate read outcome: a validated snapshot, a transient I/O failure, or an invalid record. */
	private readCandidate(path: string): { kind: "ok"; snapshot: TerminalTaskSnapshot } | { kind: "transient" } | { kind: "invalid" } {
		let value: unknown;
		try {
			this.onRead?.("metadata");
			const fault = this.metaReadFault?.(path);
			if (fault) throw fault;
			value = JSON.parse(readFileNoFollow(path));
		} catch (error) {
			if (isTransientReadError(error)) {
				this.diagnostic("io", path, error);
				return { kind: "transient" };
			}
			this.diagnostic("corrupt", path, error);
			return { kind: "invalid" };
		}
		const version = schemaVersionOf(value);
		if (version === 2 || version === 3) {
			this.diagnostic("legacy", path, `legacy schema v${version} retained for diagnostics only`);
			return { kind: "invalid" };
		}
		const snapshot = parseTerminalTaskSnapshot(value);
		if (!snapshot) {
			this.diagnostic("corrupt", path, `invalid or unsupported terminal record schema ${String(version)}`);
			return { kind: "invalid" };
		}
		try {
			this.assertSnapshotPath(snapshot, path);
		} catch (error) {
			if (isTransientReadError(error)) {
				this.diagnostic("io", path, error);
				return { kind: "transient" };
			}
			this.diagnostic("corrupt", path, error);
			return { kind: "invalid" };
		}
		return { kind: "ok", snapshot };
	}

	private readCurrent(path: string): TerminalTaskSnapshot | undefined {
		const read = this.readCandidate(path);
		return read.kind === "ok" ? read.snapshot : undefined;
	}

	private withTaskLock<T>(metaPath: string, operation: () => T): T {
		const lockPath = join(dirname(metaPath), ".meta.lock");
		const token = randomUUID();
		const owner: LockOwner = this.processStartTime
			? { token, pid: process.pid, processStartTime: this.processStartTime, verifiable: true }
			: { token, pid: process.pid, verifiable: false };
		const deadline = Date.now() + this.lockTimeoutMs;
		while (true) {
			if (this.hasBlockingTakeover(lockPath, token)) {
				if (Date.now() >= deadline) throw new TerminalTaskLockBusyError(`Timed out waiting for terminal task lock: ${lockPath}`);
				sleepSync(this.lockPollMs);
				continue;
			}
			const candidate = join(dirname(metaPath), `.meta.lock-candidate-${token}`);
			try {
				mkdirSync(candidate, { mode: PRIVATE_DIRECTORY_MODE });
				chmodSync(candidate, PRIVATE_DIRECTORY_MODE);
				writeExclusivePrivateFile(join(candidate, "owner.json"), `${JSON.stringify(owner)}\n`);
				try {
					renameSync(candidate, lockPath);
					// A stale-lock contender may have displaced this exact owner after
					// rename. Its immutable takeover path still grants exclusive ownership;
					// unrelated takeovers block operation until their owner releases.
					if (this.ownsLock(lockPath, token) && !this.hasBlockingTakeover(lockPath, token)) break;
					this.releaseLock(lockPath, owner);
				} catch (error) {
					rmSync(candidate, { recursive: true, force: true });
					if (!errorMatches(error, "EEXIST") && !errorMatches(error, "ENOTEMPTY")) throw error;
				}
			} catch (error) {
				try {
					rmSync(candidate, { recursive: true, force: true });
				} catch {
					// Candidate cleanup is best effort; it never owns the canonical lock.
				}
				if (!errorMatches(error, "EEXIST") && !errorMatches(error, "ENOTEMPTY")) throw error;
			}
			if (this.breakAbandonedLock(lockPath)) continue;
			if (Date.now() >= deadline) throw new TerminalTaskLockBusyError(`Timed out waiting for terminal task lock: ${lockPath}`);
			sleepSync(this.lockPollMs);
		}

		try {
			return operation();
		} finally {
			this.releaseLock(lockPath, owner);
		}
	}

	private takeoverPaths(lockPath: string): string[] {
		const prefix = `${basename(lockPath)}.takeover-`;
		try {
			return readdirSync(dirname(lockPath), { encoding: "utf8" })
				.filter((name) => name.startsWith(prefix))
				.map((name) => join(dirname(lockPath), name));
		} catch {
			return [];
		}
	}

	private hasBlockingTakeover(lockPath: string, ownToken: string): boolean {
		let blocked = false;
		for (const path of this.takeoverPaths(lockPath)) {
			const owner = parseLockOwner(join(path, "owner.json"));
			if (owner?.token === ownToken) continue;
			if (owner && processProvesOwnerGone(owner)) {
				// Takeover paths are immutable and never reused for acquisition, so a
				// proven-dead owner can be removed without an ABA replacement race.
				rmSync(path, { recursive: true, force: true });
				continue;
			}
			blocked = true;
		}
		return blocked;
	}

	private ownsLock(lockPath: string, token: string): boolean {
		const canonicalOwner = parseLockOwner(join(lockPath, "owner.json"));
		if (canonicalOwner?.token === token) return true;
		return this.takeoverPaths(lockPath).some((path) => parseLockOwner(join(path, "owner.json"))?.token === token);
	}

	private breakAbandonedLock(lockPath: string): boolean {
		const owner = parseLockOwner(join(lockPath, "owner.json"));
		if (!owner || !processProvesOwnerGone(owner)) return false;
		this.beforeAbandonedLockRename?.();
		const takeoverPath = `${lockPath}.takeover-${randomUUID()}`;
		try {
			renameSync(lockPath, takeoverPath);
		} catch (error) {
			if (errorMatches(error, "ENOENT")) return true;
			return false;
		}
		const movedOwner = parseLockOwner(join(takeoverPath, "owner.json"));
		if (!movedOwner || movedOwner.token !== owner.token) {
			// Never restore or delete a replacement owner. The immutable takeover
			// path blocks third-party acquisition until that live owner releases it.
			return false;
		}
		rmSync(takeoverPath, { recursive: true, force: true });
		return true;
	}

	private releaseLock(lockPath: string, owner: LockOwner): void {
		// A stale-lock contender can move this owner from the canonical path after
		// acquisition. Search twice so a concurrent move between scans is still
		// found and released from its immutable takeover path.
		for (let pass = 0; pass < 2; pass += 1) {
			for (const path of [lockPath, ...this.takeoverPaths(lockPath)]) {
				const currentOwner = parseLockOwner(join(path, "owner.json"));
				if (!currentOwner || currentOwner.token !== owner.token) continue;
				const releasePath = `${path}.release-${owner.token}-${randomUUID()}`;
				try {
					renameSync(path, releasePath);
					rmSync(releasePath, { recursive: true, force: true });
				} catch (error) {
					if (!errorMatches(error, "ENOENT")) this.diagnostic("io", path, error);
				}
			}
		}
	}

	private diagnostic(kind: TerminalTaskStoreDiagnosticKind, path: string, error: unknown): void {
		this.onDiagnostic?.({
			kind,
			path,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}
