import { randomUUID } from "node:crypto";
import { existsSync, linkSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	isSettledActivityStatus,
	mergeActivitySnapshot,
	parseActivitySnapshot,
	sanitizeActivityText,
	type ActivityBody,
	type ActivitySnapshot,
} from "./domain.js";
import { boundedOutputTail } from "./output-tail.js";
import {
	ACTIVITY_DOCUMENT_MAX_BYTES,
	ACTIVITY_FEED_MAX_BYTES,
	ACTIVITY_SCHEMA_VERSION,
	activityPaths,
	atomicWritePrivateJson,
	defaultActivityStateRoot,
	readPrivateJson,
	writePrivateJsonExclusive,
} from "./persistence.js";

export const ACTIVITY_SETTLED_RETENTION_COUNT = 64;
export const ACTIVITY_SETTLED_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const ACTIVITY_WRITER_SCHEMA_VERSION = 1;
const MAX_ACTIVE_TOOLS = 16;
const MAX_TITLE_CHARS = 512;
const MAX_ID_CHARS = 512;
const MAX_SUBJECT_CHARS = 2 * 1024;

export interface ActivityFeedDocument {
	readonly schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
	readonly ownerSessionId: string;
	readonly revision: number;
	readonly updatedAt: number;
	readonly activities: readonly ActivitySnapshot[];
}

export interface ActivityFeedDiagnostic {
	readonly kind: "corrupt" | "schema" | "io";
	readonly path: string;
	readonly message: string;
}

export interface ActivityFeedWriterIdentity {
	readonly token: string;
	readonly pid: number;
	readonly processStartTime: string;
}

export type ActivityFeedWriterState = "alive" | "dead" | "unknown";

export interface ActivityFeedPublisherOptions {
	readonly rootDir?: string;
	readonly now?: () => number;
	readonly onDiagnostic?: (diagnostic: ActivityFeedDiagnostic) => void;
	/** Production bridges provide a verifiable PID/start/token identity. */
	readonly writerIdentity?: ActivityFeedWriterIdentity;
	readonly inspectWriter?: (writer: ActivityFeedWriterIdentity) => ActivityFeedWriterState;
	/** @internal Explicit fixture writer; refuses to bypass any existing lease file. */
	readonly allowUnleasedWritesForTests?: boolean;
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function parseWriterIdentity(value: unknown): ActivityFeedWriterIdentity | undefined {
	const record = recordOf(value);
	if (
		!record || record.schemaVersion !== ACTIVITY_WRITER_SCHEMA_VERSION ||
		typeof record.token !== "string" || !record.token ||
		!positiveInteger(record.pid) || typeof record.processStartTime !== "string" || !record.processStartTime
	) return undefined;
	return { token: record.token, pid: record.pid, processStartTime: record.processStartTime };
}

function writerDocument(writer: ActivityFeedWriterIdentity): Record<string, unknown> {
	return { schemaVersion: ACTIVITY_WRITER_SCHEMA_VERSION, ...writer };
}

function sameWriter(left: ActivityFeedWriterIdentity, right: ActivityFeedWriterIdentity): boolean {
	return left.token === right.token && left.pid === right.pid && left.processStartTime === right.processStartTime;
}

function sameWriterProcess(left: ActivityFeedWriterIdentity, right: ActivityFeedWriterIdentity): boolean {
	return left.pid === right.pid && left.processStartTime === right.processStartTime;
}

function writerTakeoverPaths(writerFile: string): string[] {
	const prefix = `${basename(writerFile)}.takeover-`;
	try {
		return readdirSync(dirname(writerFile), { encoding: "utf8" })
			.filter((name) => name.startsWith(prefix))
			.map((name) => join(dirname(writerFile), name));
	} catch {
		return [];
	}
}

function readWriter(path: string): ActivityFeedWriterIdentity | undefined {
	const value = readPrivateJson(path, 16 * 1024);
	return value === undefined ? undefined : parseWriterIdentity(value);
}

/** Restore a displaced complete lease without overwriting any newer winner. */
function restoreTakeoverLease(path: string, writerFile: string): ActivityFeedWriterIdentity | undefined {
	try {
		linkSync(path, writerFile);
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
	}
	const canonical = readWriter(writerFile);
	if (canonical) rmSync(path, { force: true });
	return canonical;
}

function recoverOwnTakeover(writerFile: string, writer: ActivityFeedWriterIdentity): void {
	for (const path of writerTakeoverPaths(writerFile)) {
		const displaced = readWriter(path);
		if (!displaced || !sameWriter(displaced, writer)) continue;
		restoreTakeoverLease(path, writerFile);
		return;
	}
}

interface WriterClaim {
	readonly owned: boolean;
	readonly writerDeathProven: boolean;
}

/**
 * Claim the per-session durable writer name. The canonical writer file is an
 * atomic compare-and-swap token: a contender may displace it only after the
 * recorded PID/start identity is proven dead. Same-process factory handoff is
 * separately serialized by Plan 080's process-global session ownership.
 */
function claimWriter(
	writerFile: string,
	candidate: ActivityFeedWriterIdentity,
	inspectWriter: (writer: ActivityFeedWriterIdentity) => ActivityFeedWriterState,
): WriterClaim {
	let abandonedWriterDeathProven = false;
	for (let attempt = 0; attempt < 16; attempt += 1) {
		let blockedByTakeover = false;
		for (const path of writerTakeoverPaths(writerFile)) {
			const writer = readWriter(path);
			if (!writer) {
				blockedByTakeover = true;
				continue;
			}
			if (sameWriterProcess(writer, candidate)) {
				restoreTakeoverLease(path, writerFile);
				continue;
			}
			if (inspectWriter(writer) !== "dead") {
				blockedByTakeover = true;
				continue;
			}
			// Takeover names are immutable and never reused, so removing one whose
			// process is proven dead cannot unlink an ABA replacement.
			abandonedWriterDeathProven = true;
			rmSync(path, { force: true });
		}
		if (blockedByTakeover) return { owned: false, writerDeathProven: false };

		let current: ActivityFeedWriterIdentity | undefined;
		try {
			current = readWriter(writerFile);
		} catch {
			return { owned: false, writerDeathProven: false };
		}
		if (!current) {
			try {
				writePrivateJsonExclusive(writerFile, writerDocument(candidate));
				return { owned: true, writerDeathProven: abandonedWriterDeathProven };
			} catch (error) {
				if (errorCode(error) === "EEXIST") continue;
				throw error;
			}
		}
		if (sameWriter(current, candidate)) return { owned: true, writerDeathProven: false };
		const sameProcessHandoff = sameWriterProcess(current, candidate);
		const previousWriterDead = !sameProcessHandoff && inspectWriter(current) === "dead";
		if (!sameProcessHandoff && !previousWriterDead) return { owned: false, writerDeathProven: false };

		const takeover = `${writerFile}.takeover-${randomUUID()}`;
		try {
			renameSync(writerFile, takeover);
		} catch (error) {
			if (errorCode(error) === "ENOENT") continue;
			throw error;
		}
		const moved = readWriter(takeover);
		if (!moved || !sameWriter(moved, current)) {
			// We displaced a newer generation after an ABA race. Restore its
			// complete inode with an atomic no-replace link before retrying; if an
			// even newer canonical winner exists, that writer stays authoritative.
			restoreTakeoverLease(takeover, writerFile);
			continue;
		}
		try {
			writePrivateJsonExclusive(writerFile, writerDocument(candidate));
			rmSync(takeover, { force: true });
			return { owned: true, writerDeathProven: previousWriterDead || abandonedWriterDeathProven };
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
	}
	return { owned: false, writerDeathProven: false };
}

export function redactActivitySecrets(text: string): string {
	return sanitizeActivityText(text)
		.replace(/-----BEGIN [^-\n]+PRIVATE KEY-----[\s\S]*?-----END [^-\n]+PRIVATE KEY-----/giu, "[REDACTED PRIVATE KEY]")
		.replace(/(?:^|\n)(?:(?:[A-Za-z0-9+/]{40,}={0,2})\n?){2,}/gu, "\n[REDACTED KEY MATERIAL]\n")
		.replace(/\b((?:proxy-)?authorization\s*:)[^\n\r]*/giu, "$1 [REDACTED]")
		.replace(/\b((?:set-cookie|cookie|[A-Za-z0-9-]*(?:api-key|token|secret|credential)[A-Za-z0-9-]*)\s*:)[^\n\r]*/giu, "$1 [REDACTED]")
		.replace(/\b(?:bearer|basic)\s+[^\s"',;]+/giu, "[REDACTED AUTH]")
		.replace(/\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key[_-]?id|access[_-]?token|auth[_-]?token|token|password|passwd|passphrase|credential|secret|private[_-]?key|client[_-]?secret|database[_-]?url|aws[_-]?secret[_-]?access[_-]?key)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/giu, "$1[REDACTED]")
		.replace(/(\bcurl\b[^\n]*?(?:\s-u|\s--user))(?:\s+|=)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/giu, "$1 [REDACTED]")
		.replace(/(--(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|password|passphrase|secret|credential|client[-_]?secret|private[-_]?key))(?:\s+|=)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/giu, "$1 [REDACTED]")
		.replace(/\b((?:(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|passphrase|credential|secret|private[_-]?key|client[_-]?secret)|api\s+key|access\s+token|auth\s+token|client\s+secret|private\s+key))\s+(?:is\s+)?(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/giu, "$1 [REDACTED]")
		.replace(/\b([A-Z][A-Z0-9_]{2,}\s*=\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gu, "$1[REDACTED]")
		.replace(/\b(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/gu, "[REDACTED]")
		.replace(/(?<![A-Za-z0-9/+=])(?=[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=]))(?=[A-Za-z0-9/+=]*[a-z])(?=[A-Za-z0-9/+=]*[A-Z])(?=[A-Za-z0-9/+=]*[0-9])[A-Za-z0-9/+=]{40}/gu, "[REDACTED POSSIBLE SECRET]")
		.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@");
}

function boundedHead(text: string, maxChars: number): string {
	return Array.from(sanitizeActivityText(text)).slice(0, maxChars).join("");
}

function boundedSafeHead(text: string, maxChars: number): string {
	return Array.from(redactActivitySecrets(text)).slice(0, maxChars).join("");
}

function sanitizeBody(body: ActivityBody | undefined): ActivityBody | undefined {
	if (!body) return undefined;
	const text = boundedOutputTail(redactActivitySecrets(body.text));
	if (body.kind === "terminal") return { kind: "terminal", text };
	if (body.kind === "source") {
		return {
			kind: "source",
			text,
			...(body.startLine === undefined ? {} : { startLine: body.startLine }),
			...(body.totalLines === undefined ? {} : { totalLines: body.totalLines }),
		};
	}
	return { kind: body.kind, text };
}

/** Project any producer snapshot into the bounded durable feed contract. */
export function sanitizeActivityForFeed(
	activity: ActivitySnapshot,
	ownerSessionId: string,
	depth = 0,
): ActivitySnapshot {
	const activeTools = depth >= 4
		? undefined
		: activity.activeTools?.slice(0, MAX_ACTIVE_TOOLS).map((child) => sanitizeActivityForFeed(child, ownerSessionId, depth + 1));
	const outputTail = activity.outputTail === undefined ? undefined : boundedOutputTail(redactActivitySecrets(activity.outputTail));
	const body = sanitizeBody(activity.body);
	const summary = activity.result?.summary === undefined ? undefined : boundedOutputTail(redactActivitySecrets(activity.result.summary));
	const error = activity.result?.error === undefined ? undefined : boundedOutputTail(redactActivitySecrets(activity.result.error));
	return {
		id: boundedHead(activity.id, MAX_ID_CHARS),
		...(activity.sourceId ? { sourceId: boundedHead(activity.sourceId, MAX_ID_CHARS) } : {}),
		kind: activity.kind,
		title: boundedSafeHead(activity.title, MAX_TITLE_CHARS) || "activity",
		status: activity.status,
		// Invocation/command payloads can embed credentials in otherwise ordinary
		// strings. Terminal subjects are working directories, so omit them too;
		// other Activity kinds use product-owned labels rather than shell context.
		...(activity.kind === "terminal" || activity.subject === undefined ? {} : { subject: boundedSafeHead(activity.subject, MAX_SUBJECT_CHARS) }),
		...(activity.currentStep === undefined ? {} : { currentStep: boundedSafeHead(redactActivitySecrets(activity.currentStep), MAX_SUBJECT_CHARS) }),
		...(outputTail === undefined ? {} : { outputTail }),
		...(body === undefined ? {} : { body }),
		...(activeTools && activeTools.length > 0 ? { activeTools } : {}),
		...(summary !== undefined || error !== undefined ? { result: { ...(summary === undefined ? {} : { summary }), ...(error === undefined ? {} : { error }) } } : {}),
		ownerSessionId,
		...(activity.createdAt === undefined ? {} : { createdAt: activity.createdAt }),
		...(activity.updatedAt === undefined ? {} : { updatedAt: activity.updatedAt }),
		...(activity.settledAt === undefined ? {} : { settledAt: activity.settledAt }),
		...(activity.model === undefined ? {} : { model: boundedSafeHead(activity.model, 256) }),
		...(activity.thinking === undefined ? {} : { thinking: boundedSafeHead(activity.thinking, 64) }),
		...(activity.metrics === undefined ? {} : { metrics: { ...activity.metrics } }),
	};
}

export function parseActivityFeedDocument(value: unknown, expectedOwnerSessionId?: string): ActivityFeedDocument | undefined {
	const record = recordOf(value);
	if (
		!record || record.schemaVersion !== ACTIVITY_SCHEMA_VERSION ||
		typeof record.ownerSessionId !== "string" || !record.ownerSessionId ||
		(expectedOwnerSessionId !== undefined && record.ownerSessionId !== expectedOwnerSessionId) ||
		!positiveInteger(record.revision) || !positiveInteger(record.updatedAt) ||
		!Array.isArray(record.activities)
	) return undefined;
	const activities: ActivitySnapshot[] = [];
	for (const candidate of record.activities) {
		const activity = parseActivitySnapshot(candidate);
		if (!activity || activity.ownerSessionId !== record.ownerSessionId) return undefined;
		// The feed file is private but still untrusted persistence. Re-project on
		// read so arbitrary/deep invocation JSON and oversized producer fields
		// cannot reach store comparison/freezing or retained rendering.
		activities.push(sanitizeActivityForFeed(activity, record.ownerSessionId));
	}
	return {
		schemaVersion: ACTIVITY_SCHEMA_VERSION,
		ownerSessionId: record.ownerSessionId,
		revision: record.revision,
		updatedAt: record.updatedAt,
		activities,
	};
}

function activityTime(activity: ActivitySnapshot): number {
	return activity.settledAt ?? activity.updatedAt ?? activity.createdAt ?? 0;
}

export function retainFeedActivities(activities: readonly ActivitySnapshot[], now = Date.now()): ActivitySnapshot[] {
	const merged = new Map<string, ActivitySnapshot>();
	for (const activity of activities) {
		const existing = merged.get(activity.id);
		merged.set(activity.id, existing ? mergeActivitySnapshot(existing, activity) : activity);
	}
	const running = [...merged.values()].filter((activity) => !isSettledActivityStatus(activity.status));
	const settled = [...merged.values()]
		.filter((activity) => isSettledActivityStatus(activity.status) && now - activityTime(activity) <= ACTIVITY_SETTLED_RETENTION_MS)
		.sort((left, right) => activityTime(right) - activityTime(left))
		.slice(0, ACTIVITY_SETTLED_RETENTION_COUNT);
	return [...running, ...settled].sort((left, right) => {
		const time = (left.createdAt ?? 0) - (right.createdAt ?? 0);
		return time !== 0 ? time : left.id.localeCompare(right.id);
	});
}

function semanticActivities(activities: readonly ActivitySnapshot[]): string {
	return JSON.stringify(activities);
}

function feedDocumentBytes(document: ActivityFeedDocument): number {
	return Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`, "utf8");
}

function budgetActivity(
	activity: ActivitySnapshot,
	maxOutputBytes: number,
	maxChildren: number,
	minimal = false,
): ActivitySnapshot {
	const outputTail = maxOutputBytes > 0 && activity.outputTail
		? boundedOutputTail(activity.outputTail, { maxBytes: maxOutputBytes })
		: undefined;
	const activeTools = maxChildren > 0
		? activity.activeTools?.slice(0, maxChildren).map((child) => budgetActivity(child, maxOutputBytes, maxChildren, minimal))
		: undefined;
	return {
		id: activity.id,
		kind: activity.kind,
		title: minimal ? boundedHead(activity.title, 128) : activity.title,
		status: activity.status,
		...(activity.sourceId ? { sourceId: activity.sourceId } : {}),
		...(!minimal && activity.subject !== undefined ? { subject: activity.subject } : {}),
		...(!minimal && activity.currentStep !== undefined ? { currentStep: activity.currentStep } : {}),
		...(outputTail === undefined ? {} : { outputTail }),
		...(activeTools && activeTools.length > 0 ? { activeTools } : {}),
		...(!minimal && activity.result !== undefined ? { result: activity.result } : {}),
		...(activity.ownerSessionId === undefined ? {} : { ownerSessionId: activity.ownerSessionId }),
		...(activity.createdAt === undefined ? {} : { createdAt: activity.createdAt }),
		...(activity.updatedAt === undefined ? {} : { updatedAt: activity.updatedAt }),
		...(activity.settledAt === undefined ? {} : { settledAt: activity.settledAt }),
		...(!minimal && activity.model !== undefined ? { model: activity.model } : {}),
		...(!minimal && activity.thinking !== undefined ? { thinking: activity.thinking } : {}),
		...(!minimal && activity.metrics !== undefined ? { metrics: activity.metrics } : {}),
	};
}

/** Keep every retained record while shrinking optional presentation payloads to the reader's hard cap. */
function fitFeedBudget(
	activities: readonly ActivitySnapshot[],
	ownerSessionId: string,
	revision: number,
	updatedAt: number,
): readonly ActivitySnapshot[] {
	const fits = (candidate: readonly ActivitySnapshot[]): boolean => feedDocumentBytes({
		schemaVersion: ACTIVITY_SCHEMA_VERSION,
		ownerSessionId,
		revision,
		updatedAt,
		activities: candidate,
	}) <= ACTIVITY_DOCUMENT_MAX_BYTES;
	if (fits(activities)) return activities;
	for (const round of [
		{ output: 8 * 1024, children: 8 },
		{ output: 4 * 1024, children: 4 },
		{ output: 2 * 1024, children: 2 },
		{ output: 1 * 1024, children: 1 },
		{ output: 256, children: 0 },
	] as const) {
		const compacted = activities.map((activity) => budgetActivity(activity, round.output, round.children));
		if (fits(compacted)) return compacted;
	}
	const minimal = activities.map((activity) => budgetActivity(activity, 0, 0, true));
	if (fits(minimal)) return minimal;
	// The 4 MiB target is an optional-presentation budget, not an execution
	// ceiling. Identity/status metadata for every running record survives even
	// when that metadata alone is larger; the private reader still enforces the
	// separate 64 MiB hard safety envelope.
	return minimal;
}

export class ActivityFeedPublisher {
	private readonly rootDir: string;
	private readonly now: () => number;
	private readonly onDiagnostic?: (diagnostic: ActivityFeedDiagnostic) => void;
	private readonly path: string;
	private readonly writerFile: string;
	private readonly writerIdentity: ActivityFeedWriterIdentity | undefined;
	private readonly unleasedWriterForTests: boolean;
	private writerOwned: boolean;
	private writerDeathProven = false;
	private readonly abandonedRunningIds = new Set<string>();
	private revision = 0;
	private activities: readonly ActivitySnapshot[] = [];
	private publicationNeedsRepair = false;

	public constructor(
		public readonly ownerSessionId: string,
		options: ActivityFeedPublisherOptions = {},
	) {
		this.rootDir = options.rootDir ?? defaultActivityStateRoot();
		this.now = options.now ?? Date.now;
		this.onDiagnostic = options.onDiagnostic;
		const paths = activityPaths(ownerSessionId, this.rootDir);
		this.path = paths.feedFile;
		this.writerFile = paths.writerFile;
		this.writerIdentity = options.writerIdentity;
		this.unleasedWriterForTests = !this.writerIdentity && options.allowUnleasedWritesForTests === true;
		if (this.writerIdentity) {
			const claim = claimWriter(this.writerFile, this.writerIdentity, options.inspectWriter ?? (() => "unknown"));
			this.writerOwned = claim.owned;
			this.writerDeathProven = claim.writerDeathProven;
		} else {
			// Unidentified publishers are read-only by default. Tests may opt into
			// fixture writes only while no real writer lease exists.
			this.writerOwned = this.unleasedWriterForTests && !existsSync(this.writerFile);
		}
		// Claim first, then hydrate. A successful death-proven takeover now owns
		// the writer token, so no incumbent can publish between this load and our
		// first write and have that final update overwritten from stale memory.
		this.load();
		if (this.writerOwned && this.writerDeathProven) {
			for (const activity of this.activities) {
				if (activity.status === "queued" || activity.status === "running") this.abandonedRunningIds.add(activity.id);
			}
		}
	}

	public get hasWriterOwnership(): boolean {
		return this.writerOwned;
	}

	public get canPublish(): boolean {
		return this.writerOwned;
	}

	/** Missing running records may be reconciled only after the former writer is proven dead. */
	public get canReconcileAbandonedActivities(): boolean {
		return this.writerOwned && this.abandonedRunningIds.size > 0;
	}

	public getAbandonedRunningIds(): ReadonlySet<string> {
		return new Set(this.abandonedRunningIds);
	}

	/** Consume former-writer death proof only after replacement publication succeeds. */
	public completeAbandonedReconciliation(): void {
		this.abandonedRunningIds.clear();
		this.writerDeathProven = false;
	}

	public getSnapshot(): readonly ActivitySnapshot[] {
		return this.activities.map((activity) => activity);
	}

	public publish(activities: readonly ActivitySnapshot[]): boolean {
		if (this.writerIdentity && !existsSync(this.writerFile)) recoverOwnTakeover(this.writerFile, this.writerIdentity);
		const currentWriter = this.writerIdentity ? readWriter(this.writerFile) : undefined;
		const fixtureLeaseWasClaimed = this.unleasedWriterForTests && existsSync(this.writerFile);
		if (!this.writerOwned || fixtureLeaseWasClaimed || (this.writerIdentity && (!currentWriter || !sameWriter(currentWriter, this.writerIdentity)))) {
			this.writerOwned = false;
			throw new Error("Activity feed is owned by another live session writer");
		}
		const now = this.now();
		const retained = retainFeedActivities(
			activities.map((activity) => sanitizeActivityForFeed(activity, this.ownerSessionId)),
			now,
		);
		const revision = this.revision + 1;
		const updatedAt = Math.max(1, Math.floor(now));
		const projected = fitFeedBudget(retained, this.ownerSessionId, revision, updatedAt);
		if (!this.publicationNeedsRepair && semanticActivities(projected) === semanticActivities(this.activities)) return false;
		const document: ActivityFeedDocument = {
			schemaVersion: ACTIVITY_SCHEMA_VERSION,
			ownerSessionId: this.ownerSessionId,
			revision,
			updatedAt,
			activities: projected,
		};
		if (feedDocumentBytes(document) > ACTIVITY_FEED_MAX_BYTES) {
			throw new Error(`Activity feed identity metadata exceeds ${ACTIVITY_FEED_MAX_BYTES} bytes`);
		}
		atomicWritePrivateJson(this.path, document);
		this.revision = revision;
		this.activities = projected;
		this.publicationNeedsRepair = false;
		return true;
	}

	private load(): void {
		try {
			const value = readPrivateJson(this.path, ACTIVITY_FEED_MAX_BYTES);
			if (value === undefined) return;
			const record = recordOf(value);
			if (record?.schemaVersion !== ACTIVITY_SCHEMA_VERSION) {
				this.publicationNeedsRepair = true;
				this.diagnostic("schema", `unknown activity feed schema ${String(record?.schemaVersion)}`);
				return;
			}
			const document = parseActivityFeedDocument(value, this.ownerSessionId);
			if (!document) {
				this.publicationNeedsRepair = true;
				this.diagnostic("corrupt", "invalid activity feed document");
				return;
			}
			this.revision = document.revision;
			this.activities = document.activities;
		} catch (error) {
			this.publicationNeedsRepair = true;
			this.diagnostic("io", error instanceof Error ? error.message : String(error));
		}
	}

	private diagnostic(kind: ActivityFeedDiagnostic["kind"], message: string): void {
		this.onDiagnostic?.({ kind, path: this.path, message });
	}
}
