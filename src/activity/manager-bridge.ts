import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TerminalOutputTail, TerminalTaskManager } from "../background-tasks/task-manager.js";
import { isTerminalTaskSettled, terminalActivitySnapshot, type TerminalTaskSnapshot } from "../background-tasks/task-types.js";
import type { SubagentSnapshot } from "../subagents/domain.js";
import type { SubagentManager } from "../subagents/manager.js";
import { logDiagnostic } from "../sumo-tui/runtime/diagnostics.js";
import { isSettledActivityStatus, mergeActivitySnapshot, type ActivitySnapshot } from "./domain.js";
import {
	ACTIVITY_SETTLED_RETENTION_COUNT,
	ACTIVITY_SETTLED_RETENTION_MS,
	ActivityFeedPublisher,
	discoverActivityFeedOwners,
	redactActivitySecrets,
	type ActivityFeedDiagnostic,
	type ActivityFeedPublisherOptions,
} from "./feed-publisher.js";
import { boundedOutputTail } from "./output-tail.js";
import { activityFromSubagentSnapshot } from "./subagent-adapter.js";

const DEFAULT_SUBAGENT_DEBOUNCE_MS = 50;
const DEFAULT_TERMINAL_OUTPUT_POLL_MS = 250;
const DEFAULT_RETENTION_POLL_MS = 60 * 60 * 1_000;
const TERMINAL_REDACTION_CONTEXT_BYTES = 64 * 1024;

interface TerminalProjectionSource {
	subscribeChanges(listener: (snapshots: readonly TerminalTaskSnapshot[]) => void): () => void;
	getOutput(task: Pick<TerminalTaskSnapshot, "logFile">, maxBytes?: number): string;
	getOutputTailBytes?(task: Pick<TerminalTaskSnapshot, "logFile">, maxBytes?: number): TerminalOutputTail;
	getOutputBytes?(task: Pick<TerminalTaskSnapshot, "logFile">, maxBytes?: number): Uint8Array;
}

interface SubagentProjectionSource {
	list(): SubagentSnapshot[];
	addChangeListener(listener: () => void): () => void;
}

export interface ActivityManagerBridgeOptions extends ActivityFeedPublisherOptions {
	readonly subagentDebounceMs?: number;
	readonly terminalOutputPollMs?: number;
	readonly retentionPollMs?: number;
	readonly publisherFactory?: (ownerSessionId: string) => ActivityFeedPublisher;
	readonly discoverOwners?: () => readonly string[];
}

function ownerSessionId(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager.getSessionId() || undefined;
}

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
	private readonly publishers = new Map<string, ActivityFeedPublisher>();
	private readonly knownOwners = new Set<string>();
	private terminalSnapshots: readonly TerminalTaskSnapshot[] = [];
	private readonly terminalOutputCache = new Map<string, { revision: number; output: string }>();
	private subagentOwnerSessionId: string | undefined;
	private terminalUnsubscribe: (() => void) | undefined;
	private subagentUnsubscribe: (() => void) | undefined;
	private subagentTimer: ReturnType<typeof setTimeout> | undefined;
	private terminalOutputTimer: ReturnType<typeof setInterval> | undefined;
	private retentionTimer: ReturnType<typeof setInterval> | undefined;
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
		const publisherOptions: ActivityFeedPublisherOptions = {
			rootDir: options.rootDir,
			now: this.now,
			onDiagnostic: options.onDiagnostic,
		};
		this.publisherFactory = options.publisherFactory ?? ((owner) => new ActivityFeedPublisher(owner, publisherOptions));
		const discoverOwners = options.discoverOwners ?? (() => discoverActivityFeedOwners(publisherOptions));
		for (const owner of discoverOwners()) this.knownOwners.add(owner);
		this.terminalUnsubscribe = terminalManager.subscribeChanges((snapshots) => {
			if (this.disposed) return;
			this.terminalSnapshots = snapshots;
			const retainedKeys = new Set(snapshots.map((task) => this.terminalCacheKey(task)));
			for (const key of this.terminalOutputCache.keys()) {
				if (!retainedKeys.has(key)) this.terminalOutputCache.delete(key);
			}
			for (const task of snapshots) this.knownOwners.add(task.ownerSessionId);
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
		if (owner) this.knownOwners.add(owner);
		this.publishAll();
	}

	/** Publish final non-reattachable subagent truth before this factory dies. */
	public shutdownSession(owner: string | undefined): void {
		if (this.disposed) return;
		if (owner) {
			this.subagentOwnerSessionId = owner;
			this.knownOwners.add(owner);
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
		this.terminalOutputCache.clear();
	}

	private publisher(owner: string): ActivityFeedPublisher {
		let publisher = this.publishers.get(owner);
		if (!publisher) {
			publisher = this.publisherFactory(owner);
			this.publishers.set(owner, publisher);
		}
		return publisher;
	}

	private publishAll(): void {
		if (this.disposed) return;
		for (const owner of this.knownOwners) this.publishOwner(owner, false);
	}

	private publishRunningTerminalOwners(): void {
		if (this.disposed) return;
		const owners = new Set(this.terminalSnapshots
			.filter((task) => !isTerminalTaskSettled(task.status))
			.map((task) => task.ownerSessionId));
		for (const owner of owners) this.publishOwner(owner, false);
	}

	private publishOwner(owner: string, shuttingDownSubagents: boolean): void {
		const publisher = this.publisher(owner);
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
						let raw = boundedOutputTail(bytes, {
							maxBytes: TERMINAL_REDACTION_CONTEXT_BYTES,
							maxLines: Number.MAX_SAFE_INTEGER,
						});
						if (tail?.truncated) {
							// The first retained row may have lost a credential label. Discard
							// that partial row rather than persist an unclassifiable value.
							const newline = raw.indexOf("\n");
							raw = newline === -1 ? "" : raw.slice(newline + 1);
						}
						output = boundedOutputTail(redactActivitySecrets(raw));
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
		const merged: ActivitySnapshot[] = [];
		for (const activity of retained) {
			const update = current.find((candidate) => candidate.id === activity.id);
			if (update) merged.push(mergeActivitySnapshot(activity, update));
			else if (!isSettledActivityStatus(activity.status)) {
				merged.push(lostActivity(activity, `${activity.kind} producer is no longer recoverable`, this.now()));
			} else merged.push(activity);
		}
		for (const activity of current) {
			if (!retained.some((candidate) => candidate.id === activity.id)) merged.push(activity);
		}
		try {
			publisher.publish(merged);
		} catch (error) {
			this.diagnostic({ kind: "io", path: owner, message: error instanceof Error ? error.message : String(error) });
		}
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
	const bridge = new ActivityManagerBridge(terminalManager, subagentManager, { ...options, onDiagnostic: diagnostic });
	pi.on("session_start", (_event, ctx) => bridge.bindSession(ownerSessionId(ctx)));
	pi.on("session_shutdown", (_event, ctx) => bridge.shutdownSession(ownerSessionId(ctx)));
	return bridge;
}
