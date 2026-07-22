import { watch, type FSWatcher } from "node:fs";
import type { ActivitySnapshot } from "./domain.js";
import { parseActivityFeedDocument, type ActivityFeedDiagnostic } from "./feed-publisher.js";
import {
	ACTIVITY_DOCUMENT_MAX_BYTES,
	ACTIVITY_SCHEMA_VERSION,
	activityPaths,
	atomicWritePrivateJson,
	defaultActivityStateRoot,
	readPrivateJson,
	type ActivityPaths,
} from "./persistence.js";

const DEFAULT_DEBOUNCE_MS = 25;
const DEFAULT_POLL_MS = 2_000;
const MAX_EXPANSION_ENTRIES = 4_096;
const MAX_EXPANSION_ID_BYTES = 512;

export interface ActivityStoreSnapshot {
	readonly ownerSessionId?: string;
	readonly revision: number;
	readonly activities: readonly ActivitySnapshot[];
	readonly expansion: Readonly<Record<string, boolean>>;
	readonly defaultExpansion?: boolean;
}

export interface ActivityStore {
	bindSession(ownerSessionId: string | undefined): ActivityStoreSnapshot;
	getSnapshot(): ActivityStoreSnapshot;
	subscribe(listener: (snapshot: ActivityStoreSnapshot) => void): () => void;
	setExpanded(id: string, expanded: boolean): void;
	migrateExpanded(previousId: string, nextId: string, expanded: boolean): void;
	setAllExpanded(expanded: boolean, activityIds?: readonly string[]): void;
	dispose(): void;
}

interface ActivityUiDocument {
	readonly schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
	readonly ownerSessionId: string;
	readonly revision: number;
	readonly updatedAt: number;
	readonly expansion: Readonly<Record<string, boolean>>;
	readonly defaultExpansion?: boolean;
}

export interface FileActivityStoreOptions {
	readonly rootDir?: string;
	readonly debounceMs?: number;
	readonly pollMs?: number;
	readonly watch?: typeof watch;
	readonly now?: () => number;
	readonly onDiagnostic?: (diagnostic: ActivityFeedDiagnostic) => void;
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validExpansionId(id: string): boolean {
	return id.length > 0 && Buffer.byteLength(id, "utf8") <= MAX_EXPANSION_ID_BYTES;
}

function parseUiDocument(value: unknown, ownerSessionId: string): ActivityUiDocument | undefined {
	const record = recordOf(value);
	const expansionRecord = recordOf(record?.expansion);
	if (
		!record || record.schemaVersion !== ACTIVITY_SCHEMA_VERSION || record.ownerSessionId !== ownerSessionId ||
		!positiveInteger(record.revision) || !positiveInteger(record.updatedAt) || !expansionRecord ||
		!(record.defaultExpansion === undefined || typeof record.defaultExpansion === "boolean")
	) return undefined;
	const entries = Object.entries(expansionRecord);
	if (entries.length > MAX_EXPANSION_ENTRIES || entries.some(([id, expanded]) => !validExpansionId(id) || typeof expanded !== "boolean")) return undefined;
	return {
		schemaVersion: ACTIVITY_SCHEMA_VERSION,
		ownerSessionId,
		revision: record.revision,
		updatedAt: record.updatedAt,
		expansion: Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))) as Record<string, boolean>,
		...(typeof record.defaultExpansion === "boolean" ? { defaultExpansion: record.defaultExpansion } : {}),
	};
}

function immutable<T>(value: T): T {
	const seen = new WeakSet<object>();
	const freeze = (candidate: unknown): void => {
		if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
		seen.add(candidate);
		for (const child of Object.values(candidate as Record<string, unknown>)) freeze(child);
		Object.freeze(candidate);
	};
	freeze(value);
	return value;
}

function semanticKey(snapshot: Omit<ActivityStoreSnapshot, "revision">): string {
	return JSON.stringify([
		snapshot.ownerSessionId ?? null,
		snapshot.activities,
		Object.entries(snapshot.expansion).sort(([left], [right]) => left.localeCompare(right)),
		snapshot.defaultExpansion ?? null,
	]);
}

function boundedExpansion(entries: readonly [string, boolean][]): Record<string, boolean> {
	return Object.fromEntries(entries
		.filter(([id]) => validExpansionId(id))
		.slice(-MAX_EXPANSION_ENTRIES)
		.sort(([left], [right]) => left.localeCompare(right)));
}

export class FileActivityStore implements ActivityStore {
	private readonly rootDir: string;
	private readonly debounceMs: number;
	private readonly pollMs: number;
	private readonly watchImpl: typeof watch;
	private readonly now: () => number;
	private readonly onDiagnostic?: (diagnostic: ActivityFeedDiagnostic) => void;
	private readonly listeners = new Set<(snapshot: ActivityStoreSnapshot) => void>();
	private snapshot: ActivityStoreSnapshot = immutable({ revision: 0, activities: [], expansion: {} });
	private paths: ActivityPaths | undefined;
	private watcher: FSWatcher | undefined;
	private debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private generation = 0;
	private feedActivities: readonly ActivitySnapshot[] = [];
	private uiExpansion: Readonly<Record<string, boolean>> = {};
	private defaultExpansion: boolean | undefined;
	private feedKnownGood = false;
	private uiKnownGood = false;
	private uiPublicationBlocked = false;
	private uiRevision = 0;
	private disposed = false;

	public constructor(options: FileActivityStoreOptions = {}) {
		this.rootDir = options.rootDir ?? defaultActivityStateRoot();
		this.debounceMs = Math.max(1, Math.floor(options.debounceMs ?? DEFAULT_DEBOUNCE_MS));
		this.pollMs = Math.max(10, Math.floor(options.pollMs ?? DEFAULT_POLL_MS));
		this.watchImpl = options.watch ?? watch;
		this.now = options.now ?? Date.now;
		this.onDiagnostic = options.onDiagnostic;
	}

	public bindSession(ownerSessionId: string | undefined): ActivityStoreSnapshot {
		if (this.disposed) return this.snapshot;
		this.generation += 1;
		const generation = this.generation;
		this.stopObservation();
		this.paths = undefined;
		this.feedActivities = [];
		this.uiExpansion = {};
		this.defaultExpansion = undefined;
		this.feedKnownGood = false;
		this.uiKnownGood = false;
		this.uiPublicationBlocked = false;
		this.uiRevision = 0;
		if (ownerSessionId) {
			this.paths = activityPaths(ownerSessionId, this.rootDir);
			this.reload(generation, ownerSessionId);
		}
		this.apply({
			...(ownerSessionId ? { ownerSessionId } : {}),
			activities: this.feedActivities,
			expansion: this.uiExpansion,
			...(this.defaultExpansion === undefined ? {} : { defaultExpansion: this.defaultExpansion }),
		});
		if (ownerSessionId) this.startObservation(generation, ownerSessionId);
		return this.snapshot;
	}

	public getSnapshot(): ActivityStoreSnapshot {
		return this.snapshot;
	}

	public subscribe(listener: (snapshot: ActivityStoreSnapshot) => void): () => void {
		if (this.disposed) {
			listener(this.snapshot);
			return () => undefined;
		}
		this.listeners.add(listener);
		listener(this.snapshot);
		return () => this.listeners.delete(listener);
	}

	public setExpanded(id: string, expanded: boolean): void {
		if (!this.paths || !this.snapshot.ownerSessionId || !validExpansionId(id)) return;
		const entries = Object.entries(this.uiExpansion).filter(([candidate]) => candidate !== id);
		entries.push([id, expanded]);
		this.writeUi(boundedExpansion(entries), this.defaultExpansion);
	}

	public migrateExpanded(previousId: string, nextId: string, expanded: boolean): void {
		if (!this.paths || !this.snapshot.ownerSessionId || !validExpansionId(previousId) || !validExpansionId(nextId)) return;
		const entries = Object.entries(this.uiExpansion).filter(([id]) => id !== previousId && id !== nextId);
		entries.push([nextId, expanded]);
		this.writeUi(boundedExpansion(entries), this.defaultExpansion);
	}

	public setAllExpanded(expanded: boolean, activityIds?: readonly string[]): void {
		if (!this.paths || !this.snapshot.ownerSessionId) return;
		const ids = activityIds ?? this.feedActivities.map((activity) => activity.id);
		const entries = Object.entries(this.uiExpansion).filter(([id]) => !ids.includes(id));
		for (const id of ids) {
			if (validExpansionId(id)) entries.push([id, expanded]);
		}
		this.writeUi(boundedExpansion(entries), expanded);
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.generation += 1;
		this.stopObservation();
		this.listeners.clear();
	}

	private writeUi(expansion: Readonly<Record<string, boolean>>, defaultExpansion: boolean | undefined): void {
		const ownerSessionId = this.snapshot.ownerSessionId;
		if (!ownerSessionId || !this.paths) return;
		if (this.uiPublicationBlocked) {
			this.diagnostic("schema", this.paths.uiFile, "Activity UI publication blocked by an unreadable persisted document");
			return;
		}
		this.uiRevision += 1;
		const document: ActivityUiDocument = {
			schemaVersion: ACTIVITY_SCHEMA_VERSION,
			ownerSessionId,
			revision: this.uiRevision,
			updatedAt: Math.max(1, Math.floor(this.now())),
			expansion,
			...(defaultExpansion === undefined ? {} : { defaultExpansion }),
		};
		try {
			if (Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`, "utf8") > ACTIVITY_DOCUMENT_MAX_BYTES) {
				throw new Error(`Activity UI document exceeds ${ACTIVITY_DOCUMENT_MAX_BYTES} bytes`);
			}
			atomicWritePrivateJson(this.paths.uiFile, document);
			this.uiKnownGood = true;
			this.uiExpansion = expansion;
			this.defaultExpansion = defaultExpansion;
			this.apply({ ownerSessionId, activities: this.feedActivities, expansion, ...(defaultExpansion === undefined ? {} : { defaultExpansion }) });
		} catch (error) {
			this.diagnostic("io", this.paths.uiFile, error);
		}
	}

	private startObservation(generation: number, ownerSessionId: string): void {
		this.ensureWatcher(generation, ownerSessionId);
		this.pollTimer = setInterval(() => {
			if (this.disposed || generation !== this.generation) return;
			this.ensureWatcher(generation, ownerSessionId);
			this.reloadAndApply(generation, ownerSessionId);
		}, this.pollMs);
		this.pollTimer.unref?.();
	}

	private ensureWatcher(generation: number, ownerSessionId: string): void {
		if (this.watcher || !this.paths || generation !== this.generation) return;
		try {
			const watcher = this.watchImpl(this.paths.directory, () => this.scheduleReload(generation, ownerSessionId));
			watcher.on("error", (error) => {
				if (generation !== this.generation) return;
				this.diagnostic("io", this.paths?.directory ?? "activity", error);
				watcher.close();
				if (this.watcher === watcher) this.watcher = undefined;
			});
			this.watcher = watcher;
		} catch (error) {
			this.diagnostic("io", this.paths.directory, error);
		}
	}

	private scheduleReload(generation: number, ownerSessionId: string): void {
		if (this.disposed || generation !== this.generation) return;
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = undefined;
			this.reloadAndApply(generation, ownerSessionId);
		}, this.debounceMs);
		this.debounceTimer.unref?.();
	}

	private reloadAndApply(generation: number, ownerSessionId: string): void {
		if (this.disposed || generation !== this.generation || this.snapshot.ownerSessionId !== ownerSessionId) return;
		this.reload(generation, ownerSessionId);
		this.apply({
			ownerSessionId,
			activities: this.feedActivities,
			expansion: this.uiExpansion,
			...(this.defaultExpansion === undefined ? {} : { defaultExpansion: this.defaultExpansion }),
		});
	}

	private reload(generation: number, ownerSessionId: string): void {
		if (!this.paths || generation !== this.generation) return;
		try {
			const value = readPrivateJson(this.paths.feedFile);
			if (value !== undefined) {
				const record = recordOf(value);
				if (record?.schemaVersion !== ACTIVITY_SCHEMA_VERSION) {
					this.diagnostic("schema", this.paths.feedFile, `unknown activity feed schema ${String(record?.schemaVersion)}`);
				} else {
					const feed = parseActivityFeedDocument(value, ownerSessionId);
					if (feed) {
						this.feedKnownGood = true;
						this.feedActivities = feed.activities;
					} else {
						this.diagnostic("corrupt", this.paths.feedFile, "invalid activity feed document");
					}
				}
			} else if (!this.feedKnownGood) {
				this.feedActivities = [];
			}
		} catch (error) {
			this.diagnostic("io", this.paths.feedFile, error);
		}
		try {
			const value = readPrivateJson(this.paths.uiFile);
			if (value !== undefined) {
				const record = recordOf(value);
				if (record?.schemaVersion !== ACTIVITY_SCHEMA_VERSION) {
					this.uiPublicationBlocked = true;
					this.diagnostic("schema", this.paths.uiFile, `unknown activity UI schema ${String(record?.schemaVersion)}`);
				} else {
					const ui = parseUiDocument(value, ownerSessionId);
					if (ui) {
						this.uiKnownGood = true;
						this.uiPublicationBlocked = false;
						this.uiRevision = ui.revision;
						this.uiExpansion = ui.expansion;
						this.defaultExpansion = ui.defaultExpansion;
					} else {
						this.uiPublicationBlocked = true;
						this.diagnostic("corrupt", this.paths.uiFile, "invalid activity UI document");
					}
				}
			} else if (!this.uiKnownGood) {
				this.uiExpansion = {};
				this.defaultExpansion = undefined;
			}
		} catch (error) {
			this.uiPublicationBlocked = true;
			this.diagnostic("io", this.paths.uiFile, error);
		}
	}

	private apply(next: Omit<ActivityStoreSnapshot, "revision">): void {
		const currentWithoutRevision = {
			...(this.snapshot.ownerSessionId ? { ownerSessionId: this.snapshot.ownerSessionId } : {}),
			activities: this.snapshot.activities,
			expansion: this.snapshot.expansion,
			...(this.snapshot.defaultExpansion === undefined ? {} : { defaultExpansion: this.snapshot.defaultExpansion }),
		};
		if (semanticKey(currentWithoutRevision) === semanticKey(next)) return;
		this.snapshot = immutable({ ...next, revision: this.snapshot.revision + 1 });
		for (const listener of this.listeners) {
			try {
				listener(this.snapshot);
			} catch {
				// Store observers cannot break file-watcher ownership.
			}
		}
	}

	private stopObservation(): void {
		this.watcher?.close();
		this.watcher = undefined;
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = undefined;
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = undefined;
	}

	private diagnostic(kind: ActivityFeedDiagnostic["kind"], path: string, error: unknown): void {
		this.onDiagnostic?.({ kind, path, message: error instanceof Error ? error.message : String(error) });
	}
}
