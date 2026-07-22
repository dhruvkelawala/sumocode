import { readdirSync } from "node:fs";
import { join } from "node:path";
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
	ACTIVITY_SCHEMA_VERSION,
	activityPaths,
	atomicWritePrivateJson,
	defaultActivityStateRoot,
	ensureActivityRoot,
	readPrivateJson,
} from "./persistence.js";

export const ACTIVITY_SETTLED_RETENTION_COUNT = 64;
export const ACTIVITY_FEED_MAX_RECORDS = 16_384;
export const ACTIVITY_SETTLED_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
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

export interface ActivityFeedPublisherOptions {
	readonly rootDir?: string;
	readonly now?: () => number;
	readonly onDiagnostic?: (diagnostic: ActivityFeedDiagnostic) => void;
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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
		// strings. The durable read model does not need them; omit rather than
		// attempt incomplete shell-language secret redaction.
		...(activity.subject === undefined ? {} : { subject: boundedSafeHead(activity.subject, MAX_SUBJECT_CHARS) }),
		...(activity.currentStep === undefined ? {} : { currentStep: boundedSafeHead(activity.currentStep, MAX_SUBJECT_CHARS) }),
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
		!Array.isArray(record.activities) || record.activities.length > ACTIVITY_FEED_MAX_RECORDS
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
	// Production producers are explicitly capacity-bounded (terminal manager +
	// subagent manager), so this is an invalid direct-publisher input rather than
	// a reason to discard any running record.
	throw new Error(`Activity feed metadata exceeds ${ACTIVITY_DOCUMENT_MAX_BYTES} bytes`);
}

export class ActivityFeedPublisher {
	private readonly rootDir: string;
	private readonly now: () => number;
	private readonly onDiagnostic?: (diagnostic: ActivityFeedDiagnostic) => void;
	private readonly path: string;
	private revision = 0;
	private activities: readonly ActivitySnapshot[] = [];
	private publicationBlocked = false;

	public constructor(
		public readonly ownerSessionId: string,
		options: ActivityFeedPublisherOptions = {},
	) {
		this.rootDir = options.rootDir ?? defaultActivityStateRoot();
		this.now = options.now ?? Date.now;
		this.onDiagnostic = options.onDiagnostic;
		this.path = activityPaths(ownerSessionId, this.rootDir).feedFile;
		this.load();
	}

	public getSnapshot(): readonly ActivitySnapshot[] {
		return this.activities.map((activity) => activity);
	}

	public publish(activities: readonly ActivitySnapshot[]): boolean {
		if (this.publicationBlocked) {
			throw new Error("Activity feed publication blocked by an unreadable persisted document");
		}
		const now = this.now();
		const retained = retainFeedActivities(
			activities.map((activity) => sanitizeActivityForFeed(activity, this.ownerSessionId)),
			now,
		);
		if (retained.length > ACTIVITY_FEED_MAX_RECORDS) {
			throw new Error(`Activity feed exceeds ${ACTIVITY_FEED_MAX_RECORDS} records`);
		}
		const revision = this.revision + 1;
		const updatedAt = Math.max(1, Math.floor(now));
		const projected = fitFeedBudget(retained, this.ownerSessionId, revision, updatedAt);
		if (semanticActivities(projected) === semanticActivities(this.activities)) return false;
		const document: ActivityFeedDocument = {
			schemaVersion: ACTIVITY_SCHEMA_VERSION,
			ownerSessionId: this.ownerSessionId,
			revision,
			updatedAt,
			activities: projected,
		};
		atomicWritePrivateJson(this.path, document);
		this.revision = revision;
		this.activities = projected;
		return true;
	}

	private load(): void {
		try {
			const value = readPrivateJson(this.path);
			if (value === undefined) return;
			const record = recordOf(value);
			if (record?.schemaVersion !== ACTIVITY_SCHEMA_VERSION) {
				this.publicationBlocked = true;
				this.diagnostic("schema", `unknown activity feed schema ${String(record?.schemaVersion)}`);
				return;
			}
			const document = parseActivityFeedDocument(value, this.ownerSessionId);
			if (!document) {
				this.publicationBlocked = true;
				this.diagnostic("corrupt", "invalid activity feed document");
				return;
			}
			this.revision = document.revision;
			this.activities = document.activities;
		} catch (error) {
			this.publicationBlocked = true;
			this.diagnostic("io", error instanceof Error ? error.message : String(error));
		}
	}

	private diagnostic(kind: ActivityFeedDiagnostic["kind"], message: string): void {
		this.onDiagnostic?.({ kind, path: this.path, message });
	}
}

/** Discover feed owners without relying on raw session IDs in path names. */
export function discoverActivityFeedOwners(options: ActivityFeedPublisherOptions = {}): string[] {
	const rootDir = options.rootDir ?? defaultActivityStateRoot();
	const root = ensureActivityRoot(rootDir);
	const owners = new Set<string>();
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		const path = join(root, entry.name, "feed.json");
		try {
			const value = readPrivateJson(path);
			if (value === undefined) continue;
			const document = parseActivityFeedDocument(value);
			if (document) owners.add(document.ownerSessionId);
		} catch (error) {
			options.onDiagnostic?.({ kind: "io", path, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return [...owners];
}
