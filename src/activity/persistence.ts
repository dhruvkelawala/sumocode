import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fsyncSync,
	fstatSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { captureProcessBirthTime } from "../background-tasks/process-tree.js";

export const ACTIVITY_SCHEMA_VERSION = 1;
export const PRIVATE_ACTIVITY_DIRECTORY_MODE = 0o700;
export const PRIVATE_ACTIVITY_FILE_MODE = 0o600;
export const ACTIVITY_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;
/** Feed optional payload targets 4 MiB; identity/status metadata may grow to this private hard limit. */
export const ACTIVITY_FEED_MAX_BYTES = 64 * 1024 * 1024;
export const ACTIVITY_UI_MAX_BYTES = 64 * 1024 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const PRIVATE_FILE_LOCK_SCHEMA_VERSION = 1;
const DEFAULT_PRIVATE_FILE_LOCK_TIMEOUT_MS = 1_000;
const DEFAULT_PRIVATE_FILE_LOCK_POLL_MS = 5;
let currentProcessBirthTime: string | undefined;
let currentProcessBirthTimeCaptured = false;

interface PrivateFileLockOwner {
	readonly schemaVersion: typeof PRIVATE_FILE_LOCK_SCHEMA_VERSION;
	readonly token: string;
	readonly pid: number;
	readonly processStartTime?: string;
}

export interface PrivateFileLockOptions {
	readonly timeoutMs?: number;
	readonly pollMs?: number;
}

export interface ActivityPaths {
	readonly directory: string;
	readonly feedFile: string;
	readonly uiFile: string;
	readonly writerFile: string;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parsePrivateFileLockOwner(value: unknown): PrivateFileLockOwner | undefined {
	const record = recordOf(value);
	if (
		!record || record.schemaVersion !== PRIVATE_FILE_LOCK_SCHEMA_VERSION ||
		typeof record.token !== "string" || !record.token ||
		typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
		!(record.processStartTime === undefined || typeof record.processStartTime === "string")
	) return undefined;
	return {
		schemaVersion: PRIVATE_FILE_LOCK_SCHEMA_VERSION,
		token: record.token,
		pid: record.pid,
		...(record.processStartTime ? { processStartTime: record.processStartTime } : {}),
	};
}

function sleepSync(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function ownProcessBirthTime(): string | undefined {
	if (!currentProcessBirthTimeCaptured) {
		currentProcessBirthTime = captureProcessBirthTime(process.pid);
		currentProcessBirthTimeCaptured = true;
	}
	return currentProcessBirthTime;
}

function assertOwnedDirectory(path: string): void {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Activity state path is not a directory: ${path}`);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new Error(`Activity state path is owned by a different user: ${path}`);
	}
}

function assertPrivateDirectory(path: string): void {
	assertOwnedDirectory(path);
	const stat = lstatSync(path);
	if (process.platform !== "win32" && (stat.mode & 0o777) !== PRIVATE_ACTIVITY_DIRECTORY_MODE) {
		throw new Error(`Activity state directory permissions must be 0700: ${path}`);
	}
}

/** Create one path component at a time so recursive mkdir never follows a planted symlink. */
function ensureCanonicalBaseDirectory(path: string): string {
	let cursor = resolve(path);
	const missing: string[] = [];
	while (true) {
		try {
			const stat = lstatSync(cursor);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Activity state path is not a directory: ${cursor}`);
			break;
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
			missing.unshift(basename(cursor));
			const parent = dirname(cursor);
			if (parent === cursor) throw error;
			cursor = parent;
		}
	}
	let canonical = realpathSync(cursor);
	for (const segment of missing) {
		const candidate = join(canonical, segment);
		try {
			mkdirSync(candidate, { mode: PRIVATE_ACTIVITY_DIRECTORY_MODE });
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
		assertOwnedDirectory(candidate);
		canonical = candidate;
	}
	assertOwnedDirectory(canonical);
	return canonical;
}

function ensurePrivateChildDirectory(parent: string, name: string): string {
	assertPrivateDirectory(parent);
	const candidate = join(parent, name);
	try {
		mkdirSync(candidate, { mode: PRIVATE_ACTIVITY_DIRECTORY_MODE });
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
	}
	// Validate type and ownership before chmod: chmod follows symlinks.
	assertOwnedDirectory(candidate);
	chmodSync(candidate, PRIVATE_ACTIVITY_DIRECTORY_MODE);
	assertPrivateDirectory(candidate);
	return candidate;
}

export function defaultActivityStateRoot(env: NodeJS.ProcessEnv = process.env): string {
	if (env.SUMOCODE_STATE_DIR) return resolve(env.SUMOCODE_STATE_DIR);
	const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return resolve(agentDir, "state");
}

export function activityRoot(rootDir = defaultActivityStateRoot()): string {
	return join(resolve(rootDir), "sumocode", "activity", "v1");
}

export function hashedSessionId(ownerSessionId: string): string {
	return createHash("sha256").update(ownerSessionId, "utf8").digest("hex");
}

export function ensureActivityRoot(rootDir = defaultActivityStateRoot()): string {
	const base = ensureCanonicalBaseDirectory(rootDir);
	// The caller-owned state root may use a broader mode; only SumoCode's
	// managed descendants are chmod'd after no-symlink/ownership validation.
	let root = base;
	for (const segment of ["sumocode", "activity", "v1"]) {
		try {
			mkdirSync(join(root, segment), { mode: PRIVATE_ACTIVITY_DIRECTORY_MODE });
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
		const candidate = join(root, segment);
		assertOwnedDirectory(candidate);
		chmodSync(candidate, PRIVATE_ACTIVITY_DIRECTORY_MODE);
		assertPrivateDirectory(candidate);
		root = candidate;
	}
	return root;
}

export function activityPaths(ownerSessionId: string, rootDir = defaultActivityStateRoot()): ActivityPaths {
	if (!ownerSessionId.trim()) throw new Error("Activity state requires a non-empty owner session id");
	const root = ensureActivityRoot(rootDir);
	const directory = ensurePrivateChildDirectory(root, hashedSessionId(ownerSessionId));
	return {
		directory,
		feedFile: join(directory, "feed.json"),
		uiFile: join(directory, "ui.json"),
		writerFile: join(directory, "writer.json"),
	};
}

export function readPrivateJson(path: string, maxBytes = ACTIVITY_DOCUMENT_MAX_BYTES): unknown | undefined {
	let descriptor: number | undefined;
	try {
		const before = lstatSync(path);
		if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Activity state file is not a regular file: ${path}`);
		if (process.platform !== "win32" && (before.mode & 0o777) !== PRIVATE_ACTIVITY_FILE_MODE) {
			throw new Error(`Activity state file permissions must be 0600: ${path}`);
		}
		descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
		const opened = fstatSync(descriptor);
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
			throw new Error(`Activity state file changed during read: ${path}`);
		}
		if (opened.size > maxBytes) throw new Error(`Activity state file exceeds ${maxBytes} bytes: ${path}`);
		return JSON.parse(readFileSync(descriptor, "utf8")) as unknown;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

/**
 * Create a private JSON document only when no path already owns the name.
 * The canonical pathname appears via an atomic no-replace hard link only after
 * the temporary inode is complete and fsynced, so a creator crash can leave an
 * unreferenced temp file but never a truncated canonical lease.
 */
export function writePrivateJsonExclusive(path: string, value: unknown): void {
	const directory = dirname(path);
	assertPrivateDirectory(directory);
	const temporary = join(directory, `.${randomUUID()}.claim`);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, PRIVATE_ACTIVITY_FILE_MODE);
		fchmodSync(descriptor, PRIVATE_ACTIVITY_FILE_MODE);
		writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		linkSync(temporary, path);
		try {
			const directoryDescriptor = openSync(directory, constants.O_RDONLY | NO_FOLLOW);
			try {
				fsyncSync(directoryDescriptor);
			} finally {
				closeSync(directoryDescriptor);
			}
		} catch {
			// Some filesystems do not support directory fsync. The linked inode is
			// already complete and file-fsynced.
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

function readPrivateFileLockOwner(path: string): PrivateFileLockOwner | undefined {
	try {
		return parsePrivateFileLockOwner(readPrivateJson(path, 16 * 1024));
	} catch {
		return undefined;
	}
}

function privateFileLockOwnerGone(owner: PrivateFileLockOwner): boolean {
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		if (errorCode(error) === "ESRCH") return true;
		if (errorCode(error) !== "EPERM") return false;
	}
	if (!owner.processStartTime) return false;
	const actualStartTime = captureProcessBirthTime(owner.pid);
	return actualStartTime !== undefined && actualStartTime !== owner.processStartTime;
}

function restoreDisplacedPrivateFileLock(path: string, lockPath: string): void {
	try {
		linkSync(path, lockPath);
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
	}
	if (readPrivateFileLockOwner(lockPath)) unlinkSync(path);
}

function breakAbandonedPrivateFileLock(lockPath: string): boolean {
	const owner = readPrivateFileLockOwner(lockPath);
	if (!owner || !privateFileLockOwnerGone(owner)) return false;
	const takeoverPath = `${lockPath}.takeover-${randomUUID()}`;
	try {
		renameSync(lockPath, takeoverPath);
	} catch (error) {
		return errorCode(error) === "ENOENT";
	}
	const displaced = readPrivateFileLockOwner(takeoverPath);
	if (!displaced || displaced.token !== owner.token) {
		restoreDisplacedPrivateFileLock(takeoverPath, lockPath);
		return false;
	}
	unlinkSync(takeoverPath);
	return true;
}

function releasePrivateFileLock(lockPath: string, token: string): void {
	const owner = readPrivateFileLockOwner(lockPath);
	if (owner?.token !== token) return;
	const releasePath = `${lockPath}.release-${token}-${randomUUID()}`;
	try {
		renameSync(lockPath, releasePath);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
		return;
	}
	const displaced = readPrivateFileLockOwner(releasePath);
	if (displaced?.token === token) {
		unlinkSync(releasePath);
		return;
	}
	restoreDisplacedPrivateFileLock(releasePath, lockPath);
}

/**
 * Serialize a short cross-process read/merge/write transaction with a complete,
 * private no-replace lease. A stale lease is displaced only after PID + birth
 * identity proves its owner dead; malformed or unverifiable leases fail closed.
 */
export function withPrivateFileLock<T>(
	lockPath: string,
	operation: () => T,
	options: PrivateFileLockOptions = {},
): T {
	const token = randomUUID();
	const processStartTime = ownProcessBirthTime();
	const owner: PrivateFileLockOwner = {
		schemaVersion: PRIVATE_FILE_LOCK_SCHEMA_VERSION,
		token,
		pid: process.pid,
		...(processStartTime ? { processStartTime } : {}),
	};
	const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_PRIVATE_FILE_LOCK_TIMEOUT_MS));
	const pollMs = Math.max(1, Math.floor(options.pollMs ?? DEFAULT_PRIVATE_FILE_LOCK_POLL_MS));
	const deadline = Date.now() + timeoutMs;
	while (true) {
		try {
			writePrivateJsonExclusive(lockPath, owner);
			break;
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
		if (breakAbandonedPrivateFileLock(lockPath)) continue;
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for private file lock: ${lockPath}`);
		sleepSync(pollMs);
	}
	try {
		return operation();
	} finally {
		releasePrivateFileLock(lockPath, token);
	}
}

/** Flush, close, and atomically replace a private JSON document in-place. */
export function atomicWritePrivateJson(path: string, value: unknown): void {
	const directory = dirname(path);
	assertPrivateDirectory(directory);
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, PRIVATE_ACTIVITY_FILE_MODE);
		fchmodSync(descriptor, PRIVATE_ACTIVITY_FILE_MODE);
		writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
		// The temporary inode was already fchmod'd before fsync/close. Avoid a
		// post-rename path chmod, which could follow a same-user symlink swap.
		try {
			const directoryDescriptor = openSync(directory, constants.O_RDONLY | NO_FOLLOW);
			try {
				fsyncSync(directoryDescriptor);
			} finally {
				closeSync(directoryDescriptor);
			}
		} catch {
			// Some filesystems do not support directory fsync. File fsync and the
			// same-directory rename have already completed.
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
