import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
	TERMINAL_TASK_SCHEMA_VERSION,
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

const STATUSES = new Set<TerminalTaskStatus>(["starting", "running", "stopping", "completed", "failed", "cancelled", "lost"]);
const POLICIES = new Set<TerminalCompletionPolicy>(["passive", "wake"]);
const DELIVERY_STATES = new Set<TerminalDeliveryState>(["none", "pending", "claimed", "delivered", "suppressed"]);

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
	return value === undefined || isFiniteNumber(value);
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

export function parseTerminalTaskSnapshot(value: unknown): TerminalTaskSnapshot | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Partial<TerminalTaskSnapshot>;
	if (
		record.schemaVersion !== TERMINAL_TASK_SCHEMA_VERSION ||
		!Number.isInteger(record.revision) || (record.revision ?? 0) < 1 ||
		typeof record.id !== "string" || !record.id.startsWith("term-") ||
		typeof record.ownerSessionId !== "string" || record.ownerSessionId.length === 0 ||
		typeof record.command !== "string" ||
		typeof record.cwd !== "string" ||
		typeof record.title !== "string" ||
		!STATUSES.has(record.status as TerminalTaskStatus) ||
		!POLICIES.has(record.completionPolicy as TerminalCompletionPolicy) ||
		!isFiniteNumber(record.createdAt) ||
		!isFiniteNumber(record.updatedAt) ||
		!isOptionalFiniteNumber(record.settledAt) ||
		!(record.exitCode === undefined || record.exitCode === null || isFiniteNumber(record.exitCode)) ||
		!isOptionalFiniteNumber(record.observedAt) ||
		!isOptionalFiniteNumber(record.consumedAt) ||
		!DELIVERY_STATES.has(record.deliveryState as TerminalDeliveryState) ||
		!isOptionalString(record.completionId) ||
		!isOptionalFiniteNumber(record.pid) ||
		!isOptionalFiniteNumber(record.processGroupId) ||
		!isOptionalString(record.processStartTime) ||
		typeof record.logFile !== "string"
	) {
		return undefined;
	}
	return record as TerminalTaskSnapshot;
}

function schemaVersionOf(value: unknown): number | undefined {
	if (!value || typeof value !== "object") return undefined;
	const version = (value as { schemaVersion?: unknown }).schemaVersion;
	return typeof version === "number" ? version : undefined;
}

function atomicWriteJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, "wx", 0o600);
		writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
		try {
			const directoryDescriptor = openSync(dirname(path), "r");
			try {
				fsyncSync(directoryDescriptor);
			} finally {
				closeSync(directoryDescriptor);
			}
		} catch {
			// Some filesystems do not permit directory fsync. The required file
			// flush/close and same-directory atomic rename already completed.
		}
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

export class TerminalTaskStore {
	public readonly rootDir: string;
	private readonly metaPathById = new Map<string, string>();
	private readonly onDiagnostic?: (diagnostic: TerminalTaskStoreDiagnostic) => void;

	public constructor(options: TerminalTaskStoreOptions = {}) {
		this.rootDir = resolve(options.rootDir ?? join(process.env.TMPDIR ?? "/tmp", "sumocode-bg"));
		this.onDiagnostic = options.onDiagnostic;
	}

	public loadAll(): TerminalTaskSnapshot[] {
		this.metaPathById.clear();
		if (!existsSync(this.rootDir)) return [];
		let directories: string[];
		try {
			directories = readdirSync(this.rootDir);
		} catch (error) {
			this.diagnostic("io", this.rootDir, error);
			return [];
		}
		const snapshots: TerminalTaskSnapshot[] = [];
		for (const directory of directories) {
			const metaPath = join(this.rootDir, directory, "meta.json");
			if (!existsSync(metaPath)) continue;
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
		if (!parseTerminalTaskSnapshot(snapshot)) throw new Error("Invalid terminal task snapshot");
		const resolvedMetaPath = resolve(metaPath);
		const relativeMetaPath = relative(this.rootDir, resolvedMetaPath);
		if (relativeMetaPath.startsWith("..") || isAbsolute(relativeMetaPath)) throw new Error("Terminal metadata must live under the task store root");
		if (existsSync(resolvedMetaPath)) throw new Error(`Terminal metadata already exists: ${resolvedMetaPath}`);
		atomicWriteJson(resolvedMetaPath, snapshot);
		this.metaPathById.set(snapshot.id, resolvedMetaPath);
		return snapshot;
	}

	public get(id: string): TerminalTaskSnapshot | undefined {
		const path = this.metaPathById.get(id);
		if (!path) return undefined;
		return this.readCurrent(path);
	}

	public getOwned(id: string, ownerSessionId: string): TerminalTaskSnapshot | undefined {
		const snapshot = this.get(id);
		return snapshot?.ownerSessionId === ownerSessionId ? snapshot : undefined;
	}

	public transition(
		id: string,
		expectedRevision: number,
		update: (current: TerminalTaskSnapshot) => Omit<TerminalTaskSnapshot, "revision">,
	): TerminalTaskSnapshot {
		const path = this.metaPathById.get(id);
		if (!path) throw new Error(`Unknown terminal task ${id}`);
		const current = this.readCurrent(path);
		if (!current) throw new CorruptTerminalTaskRecordError(`Terminal record ${id} is corrupt or unreadable`);
		if (current.revision !== expectedRevision) {
			throw new StaleTerminalTaskRevisionError(id, expectedRevision, current.revision);
		}
		const next = { ...update(current), revision: current.revision + 1 } satisfies TerminalTaskSnapshot;
		if (next.id !== current.id || next.ownerSessionId !== current.ownerSessionId || next.schemaVersion !== current.schemaVersion) {
			throw new Error("Terminal task identity fields are immutable");
		}
		if (!parseTerminalTaskSnapshot(next)) throw new Error(`Invalid transition for terminal task ${id}`);
		atomicWriteJson(path, next);
		return next;
	}

	private readCandidate(path: string): TerminalTaskSnapshot | undefined {
		let value: unknown;
		try {
			value = JSON.parse(readFileSync(path, "utf8"));
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
		return snapshot;
	}

	private readCurrent(path: string): TerminalTaskSnapshot | undefined {
		try {
			return parseTerminalTaskSnapshot(JSON.parse(readFileSync(path, "utf8")));
		} catch (error) {
			this.diagnostic("corrupt", path, error);
			return undefined;
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
