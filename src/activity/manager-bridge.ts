import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	claimProcessActivitySession,
	processOwnedTerminalSessionIds,
	releaseProcessActivitySession,
} from "../background-tasks/background-task-tool.js";
import { captureProcessBirthTime } from "../background-tasks/process-tree.js";
import type { TerminalOutputTail, TerminalTaskManager } from "../background-tasks/task-manager.js";
import type { TerminalTaskIndexRefreshResult } from "../background-tasks/task-store.js";
import { isTerminalTaskSettled, terminalActivitySnapshot, type TerminalTaskSnapshot } from "../background-tasks/task-types.js";
import type { SubagentSnapshot } from "../subagents/domain.js";
import type { SubagentManager } from "../subagents/manager.js";
import { logDiagnostic } from "../sumo-tui/runtime/diagnostics.js";
import { isSettledActivityStatus, mergeActivitySnapshot, type ActivitySnapshot } from "./domain.js";
import {
	ACTIVITY_SETTLED_RETENTION_COUNT,
	ACTIVITY_SETTLED_RETENTION_MS,
	ActivityFeedPublisher,
	redactActivityOutputTail,
	redactActivitySecrets,
	type ActivityFeedDiagnostic,
	type ActivityFeedPublisherOptions,
	type ActivityFeedWriterIdentity,
	type ActivityFeedWriterState,
} from "./feed-publisher.js";
import { ACTIVITY_OUTPUT_MAX_BYTES, boundedOutputTail } from "./output-tail.js";
import { activityFromSubagentSnapshot } from "./subagent-adapter.js";

const DEFAULT_SUBAGENT_DEBOUNCE_MS = 50;
const DEFAULT_TERMINAL_OUTPUT_POLL_MS = 250;
const DEFAULT_RETENTION_POLL_MS = 60 * 60 * 1_000;
const TERMINAL_REDACTION_CONTEXT_BYTES = 64 * 1024;
/** Base of the escalating injectable-clock backoff between deferred takeover refresh attempts. */
const TAKEOVER_REFRESH_BACKOFF_BASE_MS = 1_000;
/** Upper bound of the escalating takeover-refresh backoff schedule. */
const TAKEOVER_REFRESH_BACKOFF_MAX_MS = 60_000;
/** Transient block: the takeover refresh is deferred, not defeated by a live writer. */
const ACTIVITY_BLOCK_TAKEOVER_RETRYING = "activity unavailable: terminal store temporarily unreadable; takeover retrying";
/** Durable block: a genuine competing live writer owns the feed. */
const ACTIVITY_BLOCK_LIVE_WRITER = "activity unavailable: another live Pi process owns this session's durable Activity feed";
/** Structural block: no session identity or the bridge is already shut down. */
const ACTIVITY_BLOCK_NO_WRITER = "activity unavailable: this session has no active durable Activity feed writer";

interface TerminalProjectionSource {
	subscribeChanges(listener: (snapshots: readonly TerminalTaskSnapshot[]) => void): () => void;
	/** Reload records created/advanced by another process after manager construction. */
	refreshSnapshotsFromStore?(): TerminalTaskIndexRefreshResult;
	getOutput(task: Pick<TerminalTaskSnapshot, "logFile">, maxBytes?: number): string;
	getOutputTailBytes?(task: Pick<TerminalTaskSnapshot, "logFile">, maxBytes?: number): TerminalOutputTail;
	getOutputBytes?(task: Pick<TerminalTaskSnapshot, "logFile">, maxBytes?: number): Uint8Array;
}

interface SubagentProjectionSource {
	list(): SubagentSnapshot[];
	addChangeListener(listener: () => void): () => void;
}

export interface ActivitySessionOwnership {
	ownedSessionIds(): readonly string[];
	claim(ownerSessionId: string, token: string): boolean;
	release(ownerSessionId: string, token: string): void;
	/** Test/local ownership records the same session_start fact through this hook. */
	noteOwnedSession?(ownerSessionId: string): void;
}

export interface ActivityManagerBridgeOptions extends ActivityFeedPublisherOptions {
	readonly subagentDebounceMs?: number;
	readonly terminalOutputPollMs?: number;
	readonly retentionPollMs?: number;
	readonly publisherFactory?: (ownerSessionId: string) => ActivityFeedPublisher;
	readonly sessionOwnership?: ActivitySessionOwnership;
	readonly writerIdentity?: ActivityFeedWriterIdentity;
	readonly inspectWriter?: (writer: ActivityFeedWriterIdentity) => ActivityFeedWriterState;
}

function ownerSessionId(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager.getSessionId() || undefined;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- unwraps an arbitrary caught rejection; the instanceof check at each call site is the parse.
function errorCode(error: Error): string | undefined {
	// SAFETY: process.kill rejections are NodeJS.ErrnoException whose optional `code` carries the errno string.
	const code = (error as NodeJS.ErrnoException).code;
	return code === undefined || code === null ? undefined : String(code);
}

function errorMatches(cause: unknown, code: string): boolean {
	return cause instanceof Error && errorCode(cause) === code;
}

function inspectProcessWriter(writer: ActivityFeedWriterIdentity): ActivityFeedWriterState {
	try {
		process.kill(writer.pid, 0);
	} catch (error) {
		if (errorMatches(error, "ESRCH")) return "dead";
		if (!errorMatches(error, "EPERM")) return "unknown";
	}
	const actualStartTime = captureProcessBirthTime(writer.pid);
	if (actualStartTime === writer.processStartTime) return "alive";
	return actualStartTime === undefined ? "unknown" : "dead";
}

function localSessionOwnership(): ActivitySessionOwnership {
	const owned = new Set<string>();
	const claims = new Map<string, string>();
	return {
		ownedSessionIds: () => [...owned],
		claim(owner, token) {
			const current = claims.get(owner);
			if (current !== undefined && current !== token) return false;
			claims.set(owner, token);
			return true;
		},
		release(owner, token) {
			if (claims.get(owner) === token) claims.delete(owner);
		},
		noteOwnedSession: (owner) => owned.add(owner),
	};
}

const PROCESS_SESSION_OWNERSHIP: ActivitySessionOwnership = {
	ownedSessionIds: processOwnedTerminalSessionIds,
	claim: claimProcessActivitySession,
	release: releaseProcessActivitySession,
};

function durableSubagentActivity(snapshot: SubagentSnapshot, retained: readonly ActivitySnapshot[]): ActivitySnapshot {
	const activity = activityFromSubagentSnapshot(snapshot);
	const established = retained.find((candidate) => candidate.kind === "subagent" && (
		activity.sourceId !== undefined
			? candidate.sourceId === activity.sourceId
			: candidate.sourceId === undefined && activity.createdAt !== undefined && candidate.createdAt === activity.createdAt
	));
	if (established) return { ...activity, id: established.id };
	const reused = retained.find((candidate) => candidate.id === activity.id && (
		(candidate.createdAt !== undefined && candidate.createdAt !== activity.createdAt) ||
		(candidate.sourceId !== undefined && activity.sourceId !== undefined && candidate.sourceId !== activity.sourceId)
	));
	if (!reused) return activity;
	// Plan 082 keeps the human-facing manager ID (`sa-N`) process-local. The
	// durable feed disambiguates a later reuse while sourceId still correlates
	// the new card with its initiating transcript tool call/completion.
	const durableSuffix = activity.sourceId
		? createHash("sha256").update(activity.sourceId, "utf8").digest("hex").slice(0, 12)
		: Math.max(1, Math.floor(snapshot.createdAt)).toString(36);
	return { ...activity, id: `${activity.id}:${durableSuffix}` };
}

function lostActivity(activity: ActivitySnapshot, message: string, now: number): ActivitySnapshot {
	return {
		...activity,
		status: "lost",
		updatedAt: Math.max(activity.updatedAt ?? 0, now),
		settledAt: activity.settledAt ?? now,
		result: { ...activity.result, error: activity.result?.error ?? message },
	};
}

export class ActivityManagerBridge {
	private readonly terminalManager: TerminalProjectionSource;
	private readonly subagentManager: SubagentProjectionSource;
	private readonly now: () => number;
	private readonly subagentDebounceMs: number;
	private readonly terminalOutputPollMs: number;
	private readonly retentionPollMs: number;
	private readonly onDiagnostic: ((diagnostic: ActivityFeedDiagnostic) => void) | undefined;
	private readonly publisherFactory: (ownerSessionId: string) => ActivityFeedPublisher;
	private readonly sessionOwnership: ActivitySessionOwnership;
	private readonly writerVerifiable: boolean;
	private readonly bridgeToken = randomUUID();
	private readonly claimedOwners = new Set<string>();
	/** Every owner whose process-global session claim currently belongs to this bridge token. */
	private readonly claimedSessionOwners = new Set<string>();
	private readonly publishers = new Map<string, ActivityFeedPublisher>();
	private terminalSnapshots: readonly TerminalTaskSnapshot[] = [];
	private readonly terminalOutputCache = new Map<string, { revision: number; output: string }>();
	private subagentOwnerSessionId: string | undefined;
	private terminalUnsubscribe: (() => void) | undefined;
	private subagentUnsubscribe: (() => void) | undefined;
	private subagentTimer: ReturnType<typeof setTimeout> | undefined;
	private terminalOutputTimer: ReturnType<typeof setInterval> | undefined;
	private retentionTimer: ReturnType<typeof setInterval> | undefined;
	private takeoverRefreshRetryTimer: ReturnType<typeof setTimeout> | undefined;
	private takeoverRefreshRetryDueAt: number | undefined;
	private takeoverRefreshFailureDiagnosed = false;
	/** True only while the takeover refresh call itself is on the stack. */
	private takeoverRefreshInFlight = false;
	/** Consecutive deferred takeover refreshes; sizes the escalating backoff window. */
	private takeoverRefreshFailedAttempts = 0;
	/** Current escalating gap before the next deferred takeover refresh attempt. */
	private takeoverRefreshBackoffMs = TAKEOVER_REFRESH_BACKOFF_BASE_MS;
	/** Last wall-clock refresh attempt; Date.now can move, so this is only a throttle, not a monotonic timer. */
	private takeoverRefreshLastAttemptAt: number | undefined;
	private disposed = false;

	public constructor(
		terminalManager: TerminalProjectionSource,
		subagentManager: SubagentProjectionSource,
		options: ActivityManagerBridgeOptions = {},
	) {
		this.terminalManager = terminalManager;
		this.subagentManager = subagentManager;
		this.now = options.now ?? Date.now;
		this.subagentDebounceMs = Math.max(1, Math.floor(options.subagentDebounceMs ?? DEFAULT_SUBAGENT_DEBOUNCE_MS));
		this.terminalOutputPollMs = Math.max(10, Math.floor(options.terminalOutputPollMs ?? DEFAULT_TERMINAL_OUTPUT_POLL_MS));
		this.retentionPollMs = Math.max(10, Math.floor(options.retentionPollMs ?? DEFAULT_RETENTION_POLL_MS));
		this.onDiagnostic = options.onDiagnostic;
		this.sessionOwnership = options.sessionOwnership ?? localSessionOwnership();
		const processStartTime = captureProcessBirthTime(process.pid);
		// Absence means derive this process identity; explicit undefined preserves
		// the fail-closed unverifiable-writer state.
		const writerIdentity = "writerIdentity" in options ? options.writerIdentity : (processStartTime ? {
			token: this.bridgeToken,
			pid: process.pid,
			processStartTime,
		} : undefined);
		this.writerVerifiable = writerIdentity !== undefined || options.publisherFactory !== undefined;
		const inspectWriter = options.inspectWriter ?? inspectProcessWriter;
		const publisherOptions: ActivityFeedPublisherOptions = {
			rootDir: options.rootDir,
			now: this.now,
			onDiagnostic: options.onDiagnostic,
			writerIdentity,
			inspectWriter,
		};
		this.publisherFactory = options.publisherFactory ?? ((owner) => new ActivityFeedPublisher(owner, publisherOptions));
		if (!writerIdentity && !options.publisherFactory) {
			this.diagnostic({ kind: "io", path: "activity-writer", message: "current process start identity is not verifiable; feed publication disabled" });
		}
		this.terminalUnsubscribe = terminalManager.subscribeChanges((snapshots) => {
			if (this.disposed) return;
			this.adoptTerminalSnapshots(snapshots);
			// The manager fans projection listeners out once at the end of its own
			// refresh. While this bridge's takeover refresh is in flight, that
			// re-entrant listener must only adopt (and keep the output poll in
			// step): publishing here would run syncOwnedSessions again and trigger
			// a nested store refresh before the in-flight generation is even
			// claimed. The sync that started the refresh claims and publishes each
			// owner exactly once after the refresh completes.
			if (this.takeoverRefreshInFlight) {
				this.syncTerminalOutputPoll();
				return;
			}
			this.publishAll();
			this.syncTerminalOutputPoll();
		});
		this.subagentUnsubscribe = subagentManager.addChangeListener(() => this.scheduleSubagentPublish());
		this.retentionTimer = setInterval(() => this.publishAll(), this.retentionPollMs);
		this.retentionTimer.unref?.();
	}

	public bindSession(owner: string | undefined): void {
		if (this.disposed) return;
		this.subagentOwnerSessionId = owner;
		if (owner) this.sessionOwnership.noteOwnedSession?.(owner);
		// publishAll opens with the same syncOwnedSessions pass; calling it here
		// too would rescan a pending deferred takeover twice per bind.
		this.publishAll();
		logDiagnostic("activity_bridge_bound", { ownerSessionId: owner ?? null, claimedOwnerSessionIds: [...this.claimedOwners] });
	}

	/** True when this session may currently produce durable activity; activityBlockReason says why when false. */
	public canProduceActivity(owner: string | undefined): boolean {
		return this.activityBlockReason(owner) === undefined;
	}

	/** Why activity production is blocked for owner, or undefined when it may proceed. A deferred takeover refresh (retryable failure or incomplete generation) is a transient store-read episode, not a competing live writer, so it reports its own reason instead of the live-writer block. */
	public activityBlockReason(owner: string | undefined): string | undefined {
		if (!owner || this.disposed) return ACTIVITY_BLOCK_NO_WRITER;
		if (!this.writerVerifiable) return ACTIVITY_BLOCK_NO_WRITER;
		this.syncOwnedSessions();
		const publisher = this.publishers.get(owner);
		// feed.json is a repairable presentation read model. Once this process owns
		// the lease, corruption or transient I/O may hide cards but must not disable
		// terminal/subagent execution; subsequent manager changes retry publication.
		if (this.claimedOwners.has(owner) && publisher?.hasWriterOwnership === true) return undefined;
		// A session claim parked in claimedSessionOwners while the owner is not yet
		// published is exactly a deferred takeover episode: the refresh failed or
		// produced an incomplete generation, so the honest block reason is the
		// transient retry, not a live competing writer.
		if (this.claimedSessionOwners.has(owner)) return ACTIVITY_BLOCK_TAKEOVER_RETRYING;
		return ACTIVITY_BLOCK_LIVE_WRITER;
	}

	/** Publish final non-reattachable subagent truth before this factory dies. */
	public shutdownSession(owner: string | undefined): void {
		if (this.disposed) return;
		if (owner) {
			this.subagentOwnerSessionId = owner;
			this.publishOwner(owner, true);
		}
		this.dispose();
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.terminalUnsubscribe?.();
		this.terminalUnsubscribe = undefined;
		this.subagentUnsubscribe?.();
		this.subagentUnsubscribe = undefined;
		if (this.subagentTimer) clearTimeout(this.subagentTimer);
		this.subagentTimer = undefined;
		if (this.terminalOutputTimer) clearInterval(this.terminalOutputTimer);
		this.terminalOutputTimer = undefined;
		if (this.retentionTimer) clearInterval(this.retentionTimer);
		this.retentionTimer = undefined;
		this.clearTakeoverRefreshRetryTimer();
		this.terminalOutputCache.clear();
		// Release every session claim this bridge holds — published owners and
		// owners still pending a failed takeover-refresh retry — so a replacement
		// bridge in this process can claim and publish. Iterating the claim set
		// alone avoids a double release of owners present in both sets.
		for (const owner of this.claimedSessionOwners) this.sessionOwnership.release(owner, this.bridgeToken);
		this.claimedSessionOwners.clear();
		this.claimedOwners.clear();
	}

	private publisher(owner: string): ActivityFeedPublisher {
		let publisher = this.publishers.get(owner);
		if (!publisher) {
			publisher = this.publisherFactory(owner);
			this.publishers.set(owner, publisher);
		}
		return publisher;
	}

	private syncOwnedSessions(): void {
		if (!this.writerVerifiable) return;
		const takeoverOwners: string[] = [];
		for (const owner of this.sessionOwnership.ownedSessionIds()) {
			if (this.claimedOwners.has(owner)) continue;
			if (!this.sessionOwnership.claim(owner, this.bridgeToken)) continue;
			// Track the successful claim even before publication: a failed takeover
			// refresh must keep it for retry, and dispose() must release it so a
			// replacement bridge in this process can claim the session.
			this.claimedSessionOwners.add(owner);
			const publisher = this.publisher(owner);
			if (publisher.hasWriterOwnership) {
				// A same-process claim consumes the manager generation already built at
				// startup. Only the publisher's own claim-time proof that a previous
				// writer died (publisher.hasWriterOwnership && publisher.writerDeathProven)
				// authorizes one extra terminal-index refresh, including takeover of an
				// empty feed. Same-process handoffs and blocked claims authorize nothing.
				// Every owner newly claimed in this pass shares ONE global refresh so a
				// multi-owner takeover still scans the store exactly once; death-proven
				// owners are claimed only after that refresh succeeds.
				if (publisher.writerDeathProven) takeoverOwners.push(owner);
				else this.claimedOwners.add(owner);
			} else {
				// A live incumbent may die while this process remains open. Failed
				// publishers hold no resources; discard them so the next poll can run
				// a fresh PID/start-token claim and safely take over.
				this.publishers.delete(owner);
				this.sessionOwnership.release(owner, this.bridgeToken);
				this.claimedSessionOwners.delete(owner);
			}
		}
		if (takeoverOwners.length === 0) {
			// This pass ran no refresh, so it cannot end the failure episode itself:
			// re-arm the once-per-episode diagnostic so a future failure episode is
			// logged again instead of staying silent behind a stale dedupe.
			this.takeoverRefreshFailureDiagnosed = false;
			this.resetTakeoverRefreshBackoff();
			return;
		}
		const attemptAt = this.now();
		if (this.takeoverRefreshLastAttemptAt !== undefined && attemptAt - this.takeoverRefreshLastAttemptAt < this.takeoverRefreshBackoffMs) {
			// Inside the escalating backoff window opened by the previous deferred
			// refresh: skip the rescan entirely instead of re-scanning the store on
			// every sync pass — with running terminals the 250ms output poll otherwise
			// made a pending takeover cost ~4 full scans/second, the exact pathology
			// Plan 093 removes. Pending owners stay claimed-but-unpublished and
			// ordinary owners' claim/publication cadence in this pass is unaffected.
			this.scheduleTakeoverRefreshRetry();
			return;
		}
		this.takeoverRefreshLastAttemptAt = attemptAt;
		let refresh: TerminalTaskIndexRefreshResult | undefined;
		// Mark the window so a projection listener fanned out during this refresh
		// adopts without rescanning the store or publishing mid-generation.
		this.takeoverRefreshInFlight = true;
		try {
			refresh = this.terminalManager.refreshSnapshotsFromStore?.();
		} catch (error) {
			// An unexpected refresh throw is contained exactly like the explicit
			// {ok:false} non-throw path: the death-proven owners stay unclaimed,
			// unpublished, and their proof intact, and the session claim stays with
			// this token so the next sync past the backoff window retries the one
			// global refresh.
			this.deferTakeoverRefresh(takeoverOwners[0]!, `terminal takeover refresh failed safely; takeover retries after a backoff window: ${error instanceof Error ? error.message : String(error)}`);
			return;
		} finally {
			this.takeoverRefreshInFlight = false;
		}
		if (refresh && !refresh.ok) {
			// A failed takeover refresh must not publish the death-proven owners,
			// claim them, or consume their proof. Their publishers keep the writer
			// lease and the death proof, and the session claim stays with this token,
			// so the next sync past the backoff window retries the one global refresh
			// and discovers whatever the store holds at that proven freshness boundary.
			this.deferTakeoverRefresh(takeoverOwners[0]!, "terminal takeover refresh failed; takeover retries after a backoff window");
			return;
		}
		if (refresh && !refresh.complete) {
			// An incomplete generation on the death-proven takeover path is exactly
			// as retryable as the {ok:false} failure above: the partial snapshots are
			// adopted for projection freshness, but claiming, publication, and proof
			// consumption all defer to the next sync. Claiming here would make a
			// transiently skipped durable record invisible indefinitely — later polls
			// skip the claimed owner and nothing else re-scans this projection. The
			// session claim stays pending in claimedSessionOwners, reconciliation
			// stays unconsumed, and the next sync retries the one global refresh
			// until a complete scan lands (the manager's lazy-retry backoff still
			// applies via its entry points; this sync provides its own cadence under
			// the escalating window below).
			this.adoptTerminalSnapshots(refresh.snapshots);
			this.deferTakeoverRefresh(takeoverOwners[0]!, "terminal takeover refresh produced an incomplete generation; takeover retries after a backoff window");
			return;
		}
		// A successful complete refresh ends this failure episode: re-arm the
		// once-per-episode diagnostic for the next one and reset the backoff.
		this.takeoverRefreshFailureDiagnosed = false;
		this.resetTakeoverRefreshBackoff();
		if (refresh) this.adoptTerminalSnapshots(refresh.snapshots);
		for (const owner of takeoverOwners) this.claimedOwners.add(owner);
	}

	/** Emit the expected takeover-refresh failure once per failure episode — explicit {ok:false}, an unexpected throw, or an incomplete generation; a complete refresh resets it. */
	private diagnoseTakeoverRefreshFailure(path: string, message: string): void {
		if (this.takeoverRefreshFailureDiagnosed) return;
		this.takeoverRefreshFailureDiagnosed = true;
		this.diagnostic({ kind: "io", path, message });
	}

	/** Diagnose the deferred refresh once per episode and escalate the next backoff window — 1s base doubling to the 60s cap on the injectable clock, mirroring the manager's lazy init-retry schedule. */
	private deferTakeoverRefresh(path: string, message: string): void {
		this.diagnoseTakeoverRefreshFailure(path, message);
		// One window covers all pending takeover owners because each retry is one
		// global store refresh, not per-owner work.
		this.takeoverRefreshFailedAttempts += 1;
		this.takeoverRefreshBackoffMs = Math.min(
			TAKEOVER_REFRESH_BACKOFF_BASE_MS * 2 ** Math.min(this.takeoverRefreshFailedAttempts - 1, 32),
			TAKEOVER_REFRESH_BACKOFF_MAX_MS,
		);
		this.scheduleTakeoverRefreshRetry();
		// An unconsumed death proof parked here lives only in this bridge's
		// publisher: dispose() drops the publishers, so the proof does not survive
		// a dispose() → replacement-bridge handoff in this process (mitigated: a
		// replacement bridge is created with a recreated manager, which rescans
		// the store at construction).
	}

	/** Wake an otherwise idle deferred takeover at the end of its current backoff window; running-terminal output polling already provides that retry cadence. */
	private scheduleTakeoverRefreshRetry(): void {
		if (this.disposed) return;
		if (this.terminalSnapshots.some((task) => !isTerminalTaskSettled(task.status))) {
			this.clearTakeoverRefreshRetryTimer();
			return;
		}
		if (this.takeoverRefreshLastAttemptAt === undefined) return;
		const dueAt = this.takeoverRefreshLastAttemptAt + this.takeoverRefreshBackoffMs;
		if (this.takeoverRefreshRetryTimer && this.takeoverRefreshRetryDueAt === dueAt) return;
		this.clearTakeoverRefreshRetryTimer();
		this.takeoverRefreshRetryDueAt = dueAt;
		this.takeoverRefreshRetryTimer = setTimeout(() => {
			this.takeoverRefreshRetryTimer = undefined;
			this.takeoverRefreshRetryDueAt = undefined;
			this.publishAll();
		}, Math.max(0, dueAt - this.now()));
		this.takeoverRefreshRetryTimer.unref?.();
	}

	private clearTakeoverRefreshRetryTimer(): void {
		if (this.takeoverRefreshRetryTimer) clearTimeout(this.takeoverRefreshRetryTimer);
		this.takeoverRefreshRetryTimer = undefined;
		this.takeoverRefreshRetryDueAt = undefined;
	}

	/** A complete successful scan — or a pass with zero pending takeover owners — ends the episode: the escalating retry schedule resets so a later episode starts from the base again. */
	private resetTakeoverRefreshBackoff(): void {
		this.takeoverRefreshFailedAttempts = 0;
		this.takeoverRefreshBackoffMs = TAKEOVER_REFRESH_BACKOFF_BASE_MS;
		this.takeoverRefreshLastAttemptAt = undefined;
		this.clearTakeoverRefreshRetryTimer();
	}

	private publishAll(): void {
		if (this.disposed) return;
		this.syncOwnedSessions();
		for (const owner of this.claimedOwners) this.publishOwner(owner, false);
	}

	private publishRunningTerminalOwners(): void {
		if (this.disposed) return;
		this.syncOwnedSessions();
		const owners = new Set(this.terminalSnapshots
			.filter((task) => !isTerminalTaskSettled(task.status))
			.map((task) => task.ownerSessionId));
		for (const owner of owners) this.publishOwner(owner, false);
	}

	private publishOwner(owner: string, shuttingDownSubagents: boolean): void {
		if (!this.claimedOwners.has(owner)) return;
		const publisher = this.publisher(owner);
		if (!publisher.hasWriterOwnership) {
			this.claimedOwners.delete(owner);
			this.publishers.delete(owner);
			this.sessionOwnership.release(owner, this.bridgeToken);
			this.claimedSessionOwners.delete(owner);
			return;
		}
		const retained = publisher.getSnapshot();
		const current: ActivitySnapshot[] = [];
		const ownerTasks = this.terminalSnapshots.filter((task) => task.ownerSessionId === owner);
		const terminalTasks = [
			...ownerTasks.filter((task) => !isTerminalTaskSettled(task.status)),
			...ownerTasks
				.filter((task) => isTerminalTaskSettled(task.status) && this.now() - (task.settledAt ?? task.updatedAt ?? task.createdAt) <= ACTIVITY_SETTLED_RETENTION_MS)
				.sort((left, right) => (right.settledAt ?? right.updatedAt) - (left.settledAt ?? left.updatedAt))
				.slice(0, ACTIVITY_SETTLED_RETENTION_COUNT),
		];
		for (const task of terminalTasks) {
			const cacheKey = this.terminalCacheKey(task);
			const cached = this.terminalOutputCache.get(cacheKey);
			let output = cached?.output ?? "";
			if (!isTerminalTaskSettled(task.status) || cached?.revision !== task.revision) {
				try {
					if (this.terminalManager.getOutputTailBytes || this.terminalManager.getOutputBytes) {
						const tail = this.terminalManager.getOutputTailBytes?.(task, TERMINAL_REDACTION_CONTEXT_BYTES);
						const bytes = tail?.bytes ?? this.terminalManager.getOutputBytes!(task, TERMINAL_REDACTION_CONTEXT_BYTES);
						output = redactActivityOutputTail(bytes, {
							maxBytes: ACTIVITY_OUTPUT_MAX_BYTES,
							contextBytes: TERMINAL_REDACTION_CONTEXT_BYTES,
							truncated: tail?.truncated,
						});
					} else {
						output = boundedOutputTail(redactActivitySecrets(this.terminalManager.getOutput(task)));
					}
					this.terminalOutputCache.set(cacheKey, { revision: task.revision, output });
				} catch (error) {
					this.diagnostic({ kind: "io", path: task.logFile, message: error instanceof Error ? error.message : String(error) });
				}
			}
			current.push(terminalActivitySnapshot(task, output));
		}
		if (this.subagentOwnerSessionId === owner) {
			for (const snapshot of this.subagentManager.list()) {
				let activity: ActivitySnapshot = { ...durableSubagentActivity(snapshot, retained), ownerSessionId: owner };
				if (shuttingDownSubagents && !isSettledActivityStatus(activity.status)) {
					activity = lostActivity(activity, "subagent stopped with its owning session", this.now());
				}
				current.push(activity);
			}
		}
		const abandonedRunningIds = publisher.getAbandonedRunningIds();
		const merged: ActivitySnapshot[] = [];
		const currentById = new Map(current.map((activity) => [activity.id, activity]));
		const retainedById = new Map(retained.map((activity) => [activity.id, activity]));
		for (const activity of retained) {
			const update = currentById.get(activity.id);
			if (update) merged.push(mergeActivitySnapshot(activity, update));
			else if (
				!isSettledActivityStatus(activity.status) && activity.kind !== "terminal" &&
				(abandonedRunningIds.has(activity.id) || (shuttingDownSubagents && activity.kind === "subagent"))
			) {
				// A missing producer is not evidence of loss. Subagents become
				// unrecoverable after explicit shutdown or prior-writer death. Terminals
				// are different: only refreshed TerminalTaskStore truth may mark them
				// lost after process PID/start/tree verification.
				merged.push(lostActivity(activity, `${activity.kind} producer is no longer recoverable`, this.now()));
			} else merged.push(activity);
		}
		for (const activity of current) {
			if (!retainedById.has(activity.id)) merged.push(activity);
		}
		try {
			publisher.publish(merged);
			// Consume the takeover proof after every successful publication — even
			// when the feed had no abandoned running producers (empty feed), so the
			// refresh authorization cannot outlive its one-shot purpose.
			publisher.completeAbandonedReconciliation();
		} catch (error) {
			if (!publisher.hasWriterOwnership) {
				this.claimedOwners.delete(owner);
				this.publishers.delete(owner);
				this.sessionOwnership.release(owner, this.bridgeToken);
				this.claimedSessionOwners.delete(owner);
			}
			this.diagnostic({ kind: "io", path: owner, message: error instanceof Error ? error.message : String(error) });
		}
	}

	private adoptTerminalSnapshots(snapshots: readonly TerminalTaskSnapshot[]): void {
		this.terminalSnapshots = snapshots;
		const retainedKeys = new Set(snapshots.map((task) => this.terminalCacheKey(task)));
		for (const key of this.terminalOutputCache.keys()) {
			if (!retainedKeys.has(key)) this.terminalOutputCache.delete(key);
		}
		this.syncTerminalOutputPoll();
	}

	private terminalCacheKey(task: Pick<TerminalTaskSnapshot, "id" | "ownerSessionId">): string {
		return `${task.ownerSessionId}\u0000${task.id}`;
	}

	private scheduleSubagentPublish(): void {
		if (this.disposed || this.subagentTimer) return;
		this.subagentTimer = setTimeout(() => {
			this.subagentTimer = undefined;
			this.publishAll();
		}, this.subagentDebounceMs);
		this.subagentTimer.unref?.();
	}

	private syncTerminalOutputPoll(): void {
		const hasRunning = this.terminalSnapshots.some((task) => !isTerminalTaskSettled(task.status));
		if (!hasRunning) {
			if (this.terminalOutputTimer) clearInterval(this.terminalOutputTimer);
			this.terminalOutputTimer = undefined;
			return;
		}
		if (this.terminalOutputTimer) return;
		this.terminalOutputTimer = setInterval(() => this.publishRunningTerminalOwners(), this.terminalOutputPollMs);
		this.terminalOutputTimer.unref?.();
	}

	private diagnostic(diagnostic: ActivityFeedDiagnostic): void {
		this.onDiagnostic?.(diagnostic);
		logDiagnostic("activity_feed_diagnostic", { ...diagnostic });
	}
}

/** Install the process-local sole feed writer after both managers exist. */
export function installActivityManagerBridge(
	pi: ExtensionAPI,
	terminalManager: TerminalTaskManager,
	subagentManager: SubagentManager,
	options: ActivityManagerBridgeOptions = {},
): ActivityManagerBridge {
	const diagnostic = options.onDiagnostic ?? ((entry: ActivityFeedDiagnostic) => logDiagnostic("activity_feed_diagnostic", { ...entry }));
	const bridge = new ActivityManagerBridge(terminalManager, subagentManager, {
		...options,
		onDiagnostic: diagnostic,
		sessionOwnership: options.sessionOwnership ?? PROCESS_SESSION_OWNERSHIP,
	});
	pi.on("session_start", (_event, ctx) => bridge.bindSession(ownerSessionId(ctx)));
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "terminal_start" && event.toolName !== "subagent_spawn") return;
		const reason = bridge.activityBlockReason(ownerSessionId(ctx));
		if (reason === undefined) return;
		return { block: true, reason };
	});
	pi.on("session_shutdown", (_event, ctx) => bridge.shutdownSession(ownerSessionId(ctx)));
	return bridge;
}
