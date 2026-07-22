import { randomUUID } from "node:crypto";
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

export interface TerminalTaskStoreOptions {
	readonly rootDir?: string;
	readonly onDiagnostic?: (diagnostic: TerminalTaskStoreDiagnostic) => void;
	readonly lockTimeoutMs?: number;
	readonly lockPollMs?: number;
	/** Test seam for deterministic stale-lock replacement races. */
	readonly beforeAbandonedLockRename?: () => void;
}

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
const KNOWN_ARTIFACT_NAMES = ["output.log", "exit.code", "launch.ready", "run.sh", "run.cmd"] as const;

interface LockOwner {
	readonly token: string;
	readonly pid: number;
	readonly processStartTime?: string;
	readonly verifiable: boolean;
}

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

function isProcessTreeVerification(value: unknown): boolean {
	if (value === undefined) return true;
	if (!value || typeof value !== "object") return false;
	const members = (value as { members?: unknown }).members;
	if (!Array.isArray(members) || members.length === 0 || members.length > 4096) return false;
	const pids = new Set<number>();
	for (const member of members) {
		if (!member || typeof member !== "object") return false;
		const anchor = member as { pid?: unknown; processStartTime?: unknown };
		if (!isPositiveInteger(anchor.pid) || !hasText(anchor.processStartTime) || pids.has(anchor.pid)) return false;
		pids.add(anchor.pid);
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
		return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code !== "ENOENT";
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function sleepSync(milliseconds: number): void {
	Atomics.wait(LOCK_SLEEP, 0, 0, Math.max(1, milliseconds));
}

export function isValidTerminalTaskId(id: string): boolean {
	return TERMINAL_ID_PATTERN.test(id) && !id.includes("..");
}

export function parseTerminalTaskSnapshot(value: unknown): TerminalTaskSnapshot | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Partial<TerminalTaskSnapshot>;
	if (
		record.schemaVersion !== TERMINAL_TASK_SCHEMA_VERSION ||
		!isPositiveInteger(record.revision) ||
		typeof record.id !== "string" || !isValidTerminalTaskId(record.id) ||
		!hasText(record.ownerSessionId) ||
		!hasText(record.command) ||
		!hasText(record.cwd) ||
		!hasText(record.title) ||
		!STATUSES.has(record.status as TerminalTaskStatus) ||
		!POLICIES.has(record.completionPolicy as TerminalCompletionPolicy) ||
		!isPositiveInteger(record.createdAt) ||
		!isPositiveInteger(record.updatedAt) ||
		record.updatedAt < record.createdAt ||
		!isOptionalTimestamp(record.settledAt) ||
		!(record.exitCode === undefined || record.exitCode === null || Number.isSafeInteger(record.exitCode)) ||
		!isOptionalTimestamp(record.observedAt) ||
		!isOptionalTimestamp(record.consumedAt) ||
		!DELIVERY_STATES.has(record.deliveryState as TerminalDeliveryState) ||
		!isOptionalString(record.completionId) ||
		!isOptionalString(record.deliveryClaimToken) ||
		!(record.pid === undefined || isPositiveInteger(record.pid)) ||
		!(record.processGroupId === undefined || isPositiveInteger(record.processGroupId)) ||
		!isOptionalString(record.processStartTime) ||
		!isProcessTreeVerification(record.processTreeVerification) ||
		typeof record.logFile !== "string" || !isAbsolute(record.logFile) || resolve(record.logFile) !== record.logFile
	) {
		return undefined;
	}

	const status = record.status as TerminalTaskStatus;
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

	return record as TerminalTaskSnapshot;
}

function schemaVersionOf(value: unknown): number | undefined {
	if (!value || typeof value !== "object") return undefined;
	const version = (value as { schemaVersion?: unknown }).schemaVersion;
	return typeof version === "number" ? version : undefined;
}

function assertPrivateDirectory(path: string): void {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected private directory: ${path}`);
	if (!hasPrivateMode(stat.mode, true)) throw new Error(`Directory permissions must be 0700: ${path}`);
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

function atomicWriteJson(path: string, value: unknown): void {
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
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
	}
}

function parseLockOwner(path: string): LockOwner | undefined {
	try {
		const value = JSON.parse(readFileNoFollow(path)) as Partial<LockOwner>;
		if (!hasText(value.token) || !isPositiveInteger(value.pid) || typeof value.verifiable !== "boolean") return undefined;
		if (value.verifiable && !hasText(value.processStartTime)) return undefined;
		if (!value.verifiable && value.processStartTime !== undefined) return undefined;
		return value as LockOwner;
	} catch {
		return undefined;
	}
}

function processProvesOwnerGone(owner: LockOwner): boolean {
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		if (errorCode(error) === "ESRCH") return true;
		if (errorCode(error) !== "EPERM") return false;
	}
	if (!owner.verifiable || !owner.processStartTime) return false;
	const actualStartTime = captureProcessStartTime(owner.pid);
	return actualStartTime !== undefined && actualStartTime !== owner.processStartTime;
}

export class TerminalTaskStore {
	public readonly rootDir: string;
	private readonly metaPathById = new Map<string, string>();
	private readonly onDiagnostic?: (diagnostic: TerminalTaskStoreDiagnostic) => void;
	private readonly lockTimeoutMs: number;
	private readonly lockPollMs: number;
	private readonly processStartTime: string | undefined;
	private readonly beforeAbandonedLockRename?: () => void;

	public constructor(options: TerminalTaskStoreOptions = {}) {
		const requestedRoot = resolve(options.rootDir ?? join(process.env.TMPDIR ?? "/tmp", "sumocode-bg"));
		try {
			const existing = lstatSync(requestedRoot);
			if (existing.isSymbolicLink()) throw new Error(`Terminal store root must not be a symlink: ${requestedRoot}`);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
		mkdirSync(requestedRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
		chmodSync(requestedRoot, PRIVATE_DIRECTORY_MODE);
		assertPrivateDirectory(requestedRoot);
		this.rootDir = realpathSync(requestedRoot);
		assertPrivateDirectory(this.rootDir);
		this.onDiagnostic = options.onDiagnostic;
		this.lockTimeoutMs = Math.max(1, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
		this.lockPollMs = Math.max(1, options.lockPollMs ?? DEFAULT_LOCK_POLL_MS);
		this.processStartTime = captureProcessStartTime(process.pid);
		this.beforeAbandonedLockRename = options.beforeAbandonedLockRename;
	}

	public loadAll(): TerminalTaskSnapshot[] {
		this.metaPathById.clear();
		let entries: ReturnType<typeof readdirSync>;
		try {
			entries = readdirSync(this.rootDir, { withFileTypes: true, encoding: "utf8" }) as never;
		} catch (error) {
			this.diagnostic("io", this.rootDir, error);
			return [];
		}
		const snapshots: TerminalTaskSnapshot[] = [];
		for (const entry of entries as unknown as Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>) {
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
			const snapshot = this.readCandidate(metaPath);
			if (!snapshot) continue;
			if (this.metaPathById.has(snapshot.id)) {
				this.diagnostic("duplicate", metaPath, `duplicate terminal id ${snapshot.id}`);
				continue;
			}
			this.metaPathById.set(snapshot.id, metaPath);
			snapshots.push(snapshot);
		}
		return snapshots;
	}

	public listOwned(ownerSessionId: string): TerminalTaskSnapshot[] {
		return this.loadAll()
			.filter((task) => task.ownerSessionId === ownerSessionId)
			.sort((left, right) => right.createdAt - left.createdAt);
	}

	public create(snapshot: TerminalTaskSnapshot, metaPath: string): TerminalTaskSnapshot {
		if (snapshot.schemaVersion !== TERMINAL_TASK_SCHEMA_VERSION || snapshot.revision !== 1) {
			throw new Error("New terminal records must start at the current schema and revision 1");
		}
		const resolvedMetaPath = this.assertStoreMetaPath(metaPath);
		this.assertSnapshotPath(snapshot, resolvedMetaPath);
		return this.withTaskLock(resolvedMetaPath, () => {
			if (pathExists(resolvedMetaPath)) throw new Error(`Terminal metadata already exists: ${resolvedMetaPath}`);
			atomicWriteJson(resolvedMetaPath, snapshot);
			this.metaPathById.set(snapshot.id, resolvedMetaPath);
			return snapshot;
		});
	}

	public get(id: string): TerminalTaskSnapshot | undefined {
		let path = this.metaPathById.get(id);
		if (!path) {
			this.loadAll();
			path = this.metaPathById.get(id);
		}
		if (!path) return undefined;
		return this.readCurrent(path);
	}

	public getOwned(id: string, ownerSessionId: string): TerminalTaskSnapshot | undefined {
		const snapshot = this.get(id);
		return snapshot?.ownerSessionId === ownerSessionId ? snapshot : undefined;
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

	public transition(
		id: string,
		expectedRevision: number,
		update: (current: TerminalTaskSnapshot) => Omit<TerminalTaskSnapshot, "revision">,
	): TerminalTaskSnapshot {
		let path = this.metaPathById.get(id);
		if (!path) {
			this.loadAll();
			path = this.metaPathById.get(id);
		}
		if (!path) throw new Error(`Unknown terminal task ${id}`);
		return this.withTaskLock(path, () => {
			const current = this.readCurrent(path!);
			if (!current) throw new CorruptTerminalTaskRecordError(`Terminal record ${id} is corrupt or unreadable`);
			if (current.revision !== expectedRevision) {
				throw new StaleTerminalTaskRevisionError(id, expectedRevision, current.revision);
			}
			const next = { ...update(current), revision: current.revision + 1 } satisfies TerminalTaskSnapshot;
			if (next.id !== current.id || next.ownerSessionId !== current.ownerSessionId || next.schemaVersion !== current.schemaVersion || next.createdAt !== current.createdAt || next.logFile !== current.logFile) {
				throw new Error("Terminal task identity fields are immutable");
			}
			this.assertSnapshotPath(next, path!);
			atomicWriteJson(path!, next);
			return next;
		});
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

	private readCandidate(path: string): TerminalTaskSnapshot | undefined {
		let value: unknown;
		try {
			value = JSON.parse(readFileNoFollow(path));
		} catch (error) {
			this.diagnostic("corrupt", path, error);
			return undefined;
		}
		const version = schemaVersionOf(value);
		if (version === 2 || version === 3) {
			this.diagnostic("legacy", path, `legacy schema v${version} retained for diagnostics only`);
			return undefined;
		}
		const snapshot = parseTerminalTaskSnapshot(value);
		if (!snapshot) {
			this.diagnostic("corrupt", path, `invalid or unsupported terminal record schema ${String(version)}`);
			return undefined;
		}
		try {
			this.assertSnapshotPath(snapshot, path);
		} catch (error) {
			this.diagnostic("corrupt", path, error);
			return undefined;
		}
		return snapshot;
	}

	private readCurrent(path: string): TerminalTaskSnapshot | undefined {
		return this.readCandidate(path);
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
					if (errorCode(error) !== "EEXIST" && errorCode(error) !== "ENOTEMPTY") throw error;
				}
			} catch (error) {
				try {
					rmSync(candidate, { recursive: true, force: true });
				} catch {
					// Candidate cleanup is best effort; it never owns the canonical lock.
				}
				if (errorCode(error) !== "EEXIST" && errorCode(error) !== "ENOTEMPTY") throw error;
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
			return (readdirSync(dirname(lockPath), { encoding: "utf8" }) as string[])
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
			if (errorCode(error) === "ENOENT") return true;
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
					if (errorCode(error) !== "ENOENT") this.diagnostic("io", path, error);
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
