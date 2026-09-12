import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { captureProcessBirthTime, systemProcessTree, type ProcessTreeOperations } from "../background-tasks/process-tree.js";
import { nodeArtifactFs, validatedArtifactStat } from "../private-artifact.js";
import { acquireRetained, reconstructRetained, verifyRetained, sameRetainedEvidence, type RetainedSubagent } from "./retained-adoption.js";
import { RetainedLaunchRefusal } from "./retained-runtime.js";
import type { RegistryWriter, SubagentRecord } from "./registry.js";
import { createWorktree, resolveCreateOptions, slugifyBranch, type CreateWorktreeOptions, type CreateWorktreeResult } from "../git/worktree.js";
import type { AgentPanePlacement, PiExecLike, TerminalHost } from "../terminal-host/types.js";
import type { SpawnedChild } from "./backend-pi.js";
import { SUBAGENT_MAX_QUEUED, SUBAGENT_MAX_RUNNING, type LiveToolState, type RunOutcome, type SubagentEvent, type SubagentLaunchFailure, type SubagentPaneRef, type SubagentRecoveryReason, type SubagentSnapshot, type SubagentWorktreeRef } from "./domain.js";
import { planPlacement } from "./layout.js";
import { addReportedSubagentUsage, evaluateSubagentBudget, validateSubagentBudget, type SubagentBudget } from "./budget-policy.js";
import { buildCompletionManifest, type CompletionManifestEvidence } from "./manifest.js";
import type { DeliveryPayload } from "./delivery.js";

const execFileAsync = promisify(execFile);

const MAX_TRACKED = 64;
const ERROR_TEXT_MAX = 4096;
const CANCEL_WAIT_MS = 5_500;
const CLOSE_WAIT_MS = 15_000;
const GIT_READ_TIMEOUT_MS = 5_000;
const MANIFEST_TIMEOUT_MS = 5_000;
const VISIBLE_PANE_PROVISION_TOTAL_MS = 4_750;

export interface SubagentCapacityTaskSummary {
	readonly id: string;
	readonly title?: string;
	readonly status: SubagentSnapshot["status"];
	readonly ageMs: number;
}

export interface AtCapacityDetails {
	readonly status: "at_capacity";
	readonly capacity: number;
	readonly runningCount: number;
	readonly running: readonly SubagentCapacityTaskSummary[];
	readonly retryHint: string;
}

export interface SpawnSubagentTask {
	readonly budget?: SubagentBudget;
	readonly sourceId?: string;
	readonly prompt: string;
	readonly title: string;
	readonly roleId?: string;
	readonly appendSystemPrompt?: string;
	readonly cwd: string;
	readonly visible?: boolean;
	readonly worktree?: boolean;
	readonly branch?: string;
	readonly baseRef?: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly inherited?: { model?: { provider: string; id: string }; thinking?: string };
	readonly builtInTools?: readonly string[];
}

export type SubagentLaunch = SpawnSubagentTask & {
	readonly id: string;
	readonly signal: AbortSignal;
	readonly baseRef: string;
	readonly worktreeRef?: SubagentWorktreeRef;
	readonly placement?: AgentPanePlacement;
};
type BackendFactory = (task: SubagentLaunch & { provisioningTimeoutMs?: number }) => SpawnedChild | Promise<SpawnedChild>;
type Listener = () => void;

interface VisibleSpawnWaiter {
	readonly expiresAt: number;
	readonly resolve: (release: (() => void) | undefined) => void;
	readonly timeout: ReturnType<typeof setTimeout>;
}
type WorktreeCreator = (options: CreateWorktreeOptions) => Promise<CreateWorktreeResult>;
type WorktreeBaseRefResolver = (worktreePath: string) => Promise<string | undefined>;

interface SpawnGitContext {
	readonly repoRoot?: string;
	readonly baseRef?: string;
}

export interface SubagentManagerDiagnostic {
	readonly kind: "listener" | "interrupt";
	readonly message: string;
}

export interface SubagentManagerDependencies {
	readonly idNamespace?: string;
	readonly controllerIdentity?: RegistryWriter;
	readonly processOperations?: ProcessTreeOperations;
	readonly createWorktree?: WorktreeCreator;
	readonly resolveWorktreeBaseRef?: WorktreeBaseRefResolver;
	readonly captureGitContext?: (cwd: string) => Promise<SpawnGitContext>;
	readonly buildCompletionManifest?: typeof buildCompletionManifest;
	readonly terminalHost?: TerminalHost;
	readonly pi?: PiExecLike;
	/** Parent Herdr tab injected into the RPC child; first visible pane splits here. */
	readonly initialVisibleTabId?: string;
	readonly onDiagnostic?: (diagnostic: SubagentManagerDiagnostic) => void;
}

async function gitRead(cwd: string, args: readonly string[]): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			timeout: GIT_READ_TIMEOUT_MS,
			maxBuffer: 10 * 1024 * 1024,
		});
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

async function captureGitContext(cwd: string): Promise<SpawnGitContext> {
	const [repoRoot, baseRef] = await Promise.all([
		gitRead(cwd, ["rev-parse", "--show-toplevel"]),
		gitRead(cwd, ["rev-parse", "HEAD"]),
	]);
	return { repoRoot, baseRef };
}

const isSettled = (snapshot: SubagentSnapshot): boolean => snapshot.status !== "running" && snapshot.status !== "queued";

const readRetainedTurnResult = (record: SubagentRecord): string | undefined => {
	const path = join(record.taskDir, "response.md");
	return validatedArtifactStat(nodeArtifactFs, path, record.taskDir, "visible-subagent response artifact")
		? readFileSync(path, "utf8") || undefined
		: undefined;
};

const makeInitialSnapshot = (
	task: SpawnSubagentTask,
	id: string,
	createdAt: number,
	baseRef: string,
	cwd = task.cwd,
	worktree?: SubagentWorktreeRef,
	sessionFilePath?: string,
	status: "queued" | "running" = "running",
): SubagentSnapshot => {
	type MutableSnapshot = { -readonly [K in keyof SubagentSnapshot]: SubagentSnapshot[K] };
	const snapshot: MutableSnapshot = {
		id,
		budget: task.budget ? { ...task.budget } : undefined,
		title: task.title,
		prompt: task.prompt,
		cwd,
		baseRef,
		worktree,
		status,
		createdAt,
		modelLabel: task.model ?? (task.inherited?.model ? `${task.inherited.model.provider}/${task.inherited.model.id}` : undefined),
		thinkingLabel: task.thinking ?? task.inherited?.thinking,
		sessionFilePath,
		usage: { turns: 0 },
		transcript: [],
		liveText: "",
		liveTools: [],
		finalText: "",
	};
	if (task.sourceId !== undefined) snapshot.sourceId = task.sourceId;
	if (task.roleId !== undefined) snapshot.roleId = task.roleId;
	if (task.visible) {
		snapshot.visible = true;
		snapshot.turnState = "working";
		snapshot.turnSequence = 0;
		snapshot.lastProgressAt = createdAt;
	}
	return snapshot;
};

const upsertTool = (tools: readonly LiveToolState[], next: LiveToolState): readonly LiveToolState[] => {
	const index = tools.findIndex((tool) => tool.id === next.id);
	if (index === -1) return [...tools, next];
	return tools.map((tool, toolIndex) => toolIndex === index ? { ...tool, ...next } : tool);
};

interface TrackedRetained {
	entry: RetainedSubagent;
	unsubscribe?: () => void;
	blocked: boolean;
}

export class SubagentManager {
	private readonly retained = new Map<string, TrackedRetained>();
	private detached = false;
	private identity?: RegistryWriter;
	private readonly operations: ProcessTreeOperations;
	private nextId = 1;
	private readonly idNamespace?: string;
	private healthTimer?: ReturnType<typeof setInterval>;
	private readonly pendingSpawns = new Map<string, { title: string; createdAt: number }>();
	private readonly launching = new Map<string, { controller: AbortController; done: Promise<void> }>();
	private readonly queuedTasks: Array<{ task: SpawnSubagentTask; id: string; createdAt: number; generation: number }> = [];
	private readonly snapshots = new Map<string, SubagentSnapshot>();
	private readonly children = new Map<string, { child: SpawnedChild; controller: AbortController }>();
	private readonly waitInterest = new Map<string, number>();
	private readonly listeners = new Set<Listener>();
	private readonly createWorktreeImpl: WorktreeCreator;
	private readonly resolveWorktreeBaseRefImpl: WorktreeBaseRefResolver;
	private readonly captureGitContextImpl: (cwd: string) => Promise<SpawnGitContext>;
	private readonly buildCompletionManifestImpl: typeof buildCompletionManifest;
	private readonly terminalHost?: TerminalHost;
	private readonly pi?: PiExecLike;
	private initialVisibleTabId?: string;
	private readonly onDiagnostic?: (diagnostic: SubagentManagerDiagnostic) => void;
	private subagentsTabId?: string;
	private visibleSpawnReserved = false;
	private readonly visibleSpawnWaiters: VisibleSpawnWaiter[] = [];
	/** Serializes worktree creation; see withWorktreeCreation. */
	private worktreeGate: Promise<void> = Promise.resolve();
	private dequeueTail: Promise<void> = Promise.resolve();
	private readonly settlingIds = new Set<string>();
	private readonly settlingPromises = new Map<string, Promise<void>>();
	private readonly settlingOutcomes = new Map<string, RunOutcome>();
	private readonly startedIds = new Set<string>();
	private readonly cancelledSetupIds = new Set<string>();
	private readonly workspacePlacedIds = new Set<string>();
	/** Placement planned for each in-flight visible task, until its run settles. */
	public readonly placementByTask = new Map<string, AgentPanePlacement>();
	private lifecycleGeneration = 0;
	public readonly consumedIds = new Set<string>();

	public constructor(private readonly backendFactory: BackendFactory, dependencies: SubagentManagerDependencies = {}) {
		this.idNamespace = dependencies.idNamespace;
		this.identity = dependencies.controllerIdentity && { ...dependencies.controllerIdentity };
		this.operations = dependencies.processOperations ?? systemProcessTree;
		this.createWorktreeImpl = dependencies.createWorktree ?? createWorktree;
		this.resolveWorktreeBaseRefImpl = dependencies.resolveWorktreeBaseRef ?? ((path) => gitRead(path, ["rev-parse", "HEAD"]));
		this.captureGitContextImpl = dependencies.captureGitContext ?? captureGitContext;
		this.buildCompletionManifestImpl = dependencies.buildCompletionManifest ?? buildCompletionManifest;
		this.terminalHost = dependencies.terminalHost;
		this.pi = dependencies.pi;
		this.initialVisibleTabId = dependencies.initialVisibleTabId;
		this.onDiagnostic = dependencies.onDiagnostic;
		this.subagentsTabId = this.initialVisibleTabId;
	}

	public get controllerIdentity(): RegistryWriter {
		if (!this.identity) {
			const processStartTime = captureProcessBirthTime(process.pid);
			if (!processStartTime) throw new Error("manager birth identity unavailable");
			this.identity = { token: randomUUID(), pid: process.pid, processStartTime };
		}
		return { ...this.identity };
	}

	/** Register an already launched retained owner; this never spawns or subscribes to its backend. */
	public async trackRetained(entry: RetainedSubagent): Promise<void> {
		if (this.retained.has(entry.snapshot.id)) return;
		if (this.detached || this.snapshots.has(entry.snapshot.id)) throw new Error("manager cannot track retained child");
		const record = entry.registry.get(entry.snapshot.id);
		const identity = this.controllerIdentity;
		if (!record || !entry.supervisor || !sameRetainedEvidence(record, entry.supervisor.record) || !entry.registry.inspectControl(entry.authority)
			|| record.backend !== (entry.snapshot.visible ? "visible" : "headless")
			|| entry.authority.owner.token !== identity.token
			|| entry.authority.owner.pid !== identity.pid
			|| entry.authority.owner.processStartTime !== identity.processStartTime) throw new Error("retained child control unverified");
		// Own the descriptor before asynchronous pane inspection so replacement cannot lose it.
		this.retained.set(record.id, { entry, blocked: true });
		this.snapshots.set(record.id, entry.snapshot);
		let recoveryReason: SubagentRecoveryReason | undefined;
		try {
			const verification = await verifyRetained(record, this.operations, this.terminalHost, this.pi);
			recoveryReason = verification.reason;
			if (verification.classification !== "verified") throw new Error(recoveryReason
				? `retained child identity unverified: ${recoveryReason.code} expected ${recoveryReason.expected} observed ${recoveryReason.observed}`
				: "retained child identity unverified");
			if (this.detached) return;
			this.bindRetained(entry);
		} catch (error) {
			if (this.retained.has(record.id)) this.blockRetained(record.id, "ambiguous", recoveryReason);
			throw error;
		}
	}

	/** Replacement stops this view, not its retained persistence owners. */
	public detachForReplacement(): void {
		if (this.detached) return;
		this.detached = true;
		for (const [id, tracked] of this.retained) {
			tracked.unsubscribe?.();
			tracked.unsubscribe = undefined;
			tracked.entry = { ...tracked.entry, snapshot: this.snapshots.get(id) ?? tracked.entry.snapshot };
			this.children.delete(id);
			this.snapshots.delete(id);
		}
		for (const snapshot of this.snapshots.values()) {
			this.consumedIds.add(snapshot.id);
			if (!isSettled(snapshot)) this.snapshots.set(snapshot.id, { ...snapshot, recovery: "unsupported" });
		}
		this.disposeAll();
		this.notify();
	}

	public get hasRetainedChildren(): boolean { return this.retained.size > 0; }

	/** Claim each outgoing view before asynchronous control transfer; bind only after its grant. */
	public async adoptFrom(previous: SubagentManager, sessionId: string): Promise<void> {
		await Promise.all([...previous.launching.values()].map((launch) => launch.done));
		if (previous === this || this.detached) return;
		previous.detachForReplacement();
		for (const [id, tracked] of previous.retained) {
			if (this.retained.has(id)) continue;
			if (this.snapshots.has(id)) throw new Error("retained subagent id conflicts with successor work");
			previous.retained.delete(id);
			let result: Awaited<ReturnType<typeof acquireRetained>>;
			try {
				result = tracked.blocked ? { entry: tracked.entry, classification: "ambiguous", reason: tracked.entry.snapshot.recoveryReason }
					: await acquireRetained(tracked.entry, this.controllerIdentity, sessionId, this.operations, this.terminalHost, this.pi);
			} catch (error) {
				previous.retained.set(id, tracked);
				throw error;
			}
			if (previous.consumedIds.has(id)) this.consumedIds.add(id);
			this.retained.set(id, { entry: result.entry, blocked: true });
			this.snapshots.set(id, result.entry.snapshot);
			if (result.classification === "adopted" && !this.detached) {
				try { this.bindRetained(result.entry); }
				catch { this.blockRetained(id, "ambiguous"); }
			} else this.blockRetained(id, result.classification === "adopted" ? "ambiguous" : result.classification, result.reason);
		}
		this.notify();
	}

	/** Installation-scoped disk discovery; no prior manager or backend handle is accepted. */
	public async reconstruct(registry: RetainedSubagent["registry"], sessionId: string): Promise<void> {
		for (const result of await reconstructRetained(registry, this.controllerIdentity, sessionId, this.operations, this.terminalHost, this.pi)) {
			const id = result.entry.snapshot.id;
			if (this.detached || this.snapshots.has(id)) continue;
			this.retained.set(id, { entry: result.entry, blocked: true });
			this.snapshots.set(id, result.entry.snapshot);
			if (result.classification === "adopted" || result.classification === "persist-only") {
				try { this.bindRetained(result.entry, result.classification === "persist-only"); } catch { this.blockRetained(id, "ambiguous"); }
			} else this.blockRetained(id, result.classification, result.reason);
		}
		this.notify();
	}

	public canDeliver(id: string): boolean {
		const retained = this.retained.get(id);
		if (this.detached || retained?.blocked) return false;
		try { return !retained || retained.entry.registry.inspectControl(retained.entry.authority); }
		catch { this.blockRetained(id, "ambiguous"); return false; }
	}

	/** No await between durable admission and the single synchronous Pi call. */
	public deliver(payload: DeliveryPayload, send: (payload: DeliveryPayload) => void): void {
		if (!this.canDeliver(payload.id)) return;
		const tracked = this.retained.get(payload.id);
		if (!tracked) {
			if (payload.status === "turn_done" && this.snapshots.get(payload.id)?.status !== "running") return;
			send(payload);
			if (payload.status === "turn_done") this.markTurnDelivered(payload);
			return;
		}
		const { registry, authority } = tracked.entry;
		try {
			let record = registry.get(payload.id)!;
			if (payload.status === "turn_done") {
				if (record.status !== "running") return;
				send(payload);
				this.markTurnDelivered(payload);
				return;
			}
			if (record.status !== "settled") return;
			if (record.delivery.state === "sending") {
				if (record.delivery.controllerGeneration === (record.controllerGeneration ?? 0)) return;
				record = registry.advanceDelivery(record.revision, authority, "uncertain");
			}
			const notice = record.delivery.state === "delivery-uncertain";
			const slot = record.delivery.state === "delivery-uncertain" ? record.delivery.notice : record.delivery;
			if (notice && slot.state === "sending" && slot.controllerGeneration !== (record.controllerGeneration ?? 0)) {
				registry.advanceDelivery(record.revision, authority, "uncertain", true);
				return;
			}
			if (slot.state !== "undelivered") return;
			const outgoing: DeliveryPayload = notice ? { ...payload,
				customType: "subagent-delivery-uncertain",
				content: `delivery of ${payload.id} uncertain; result manifest available at ${join(record.taskDir, "manifest.json")}; use inspect`,
				details: { id: payload.id, completionId: record.completionId, delivery: "delivery-uncertain", manifestPath: join(record.taskDir, "manifest.json") },
			} : payload;
			record = registry.advanceDelivery(record.revision, authority, "send", notice);
			send(outgoing);
			registry.advanceDelivery(record.revision, authority, "sent", notice);
		} catch (error: unknown) {
			// Turn delivery has no durable admission record, so let the deferred
			// queue retain and retry it. Terminal delivery recovers from `sending`.
			if (payload.status === "turn_done") throw error;
			// Publication may have committed even if its return was lost. Preserve
			// successor recovery of sending; only corrupt evidence blocks adoption.
			this.canDeliver(payload.id);
		}
	}

	private blockRetained(id: string, classification: "lost" | "ambiguous", reason?: SubagentRecoveryReason): void {
		const tracked = this.retained.get(id)!;
		tracked.blocked = true;
		tracked.unsubscribe?.();
		tracked.unsubscribe = undefined;
		this.children.delete(id);
		this.consumedIds.add(id);
		const snapshot = { ...this.snapshots.get(id)!, status: "error" as const, recovery: classification };
		this.snapshots.set(id, reason ? { ...snapshot, recoveryReason: reason } : snapshot);
		try {
			const record = tracked.entry.registry.get(id)!;
			tracked.entry.registry.recordRecovery(id, record.revision, classification, reason);
		} catch {
			// Failed storage cannot grant effects or justify overwriting old evidence.
			try { this.onDiagnostic?.({ kind: "listener", message: "retained recovery observation could not be persisted" }); }
			catch { /* Diagnostics cannot restore refused control. */ }
		}
	}

	private bindRetained(entry: RetainedSubagent, mirror = false): void {
		if (!entry.supervisor || (!mirror && !entry.registry.inspectControl(entry.authority))) throw new Error("retained control changed before observation");
		const id = entry.snapshot.id;
		const tracked: TrackedRetained = { entry, blocked: mirror };
		this.retained.set(id, tracked);
		this.snapshots.set(id, { ...entry.snapshot, recovery: mirror ? "persist-only" : "adopted" });
		if (!mirror) this.children.set(id, { child: entry.supervisor.controllerChild(entry.authority), controller: new AbortController() });
		const observe = (record: SubagentRecord): void => {
			if (this.detached || (!mirror && !this.canDeliver(id))) return;
			const observed = this.snapshots.get(id);
			if (!observed) return;
			// A retained owner persists pane attachment in the registry instead of
			// emitting `pane-attached`. Apply the same snapshot + generated-tab cache
			// update the non-retained reducer applies, so placement counts
			// retained-visible launches and reclamation sees their tab.
			const current = this.attachPane(id, observed, record.pane);
			const telemetry = record.telemetry;
			let turnState = telemetry?.turnState ?? current.turnState;
			let finalText = current.finalText;
			if (record.backend === "visible" && turnState === "idle") {
				try { finalText = readRetainedTurnResult(record) ?? finalText; }
				catch { turnState = current.turnState; }
			}
			let next: SubagentSnapshot = { ...current, startedAt: telemetry?.startedAt ?? current.startedAt,
				lastProgressAt: telemetry?.lastProgressAt ?? current.lastProgressAt,
				lastHeartbeatAt: telemetry?.lastHeartbeatAt ?? current.lastHeartbeatAt,
				turnState, turnSequence: telemetry?.turnSequence ?? current.turnSequence, finalText,
				usage: { ...current.usage, reportedTokens: telemetry?.reportedTokens ?? current.usage.reportedTokens, reportedCostUsd: telemetry?.reportedCostUsd ?? current.usage.reportedCostUsd } };
			const completion = record.status === "settled" ? entry.supervisor?.completion : undefined;
			const failedPlacement = this.placementByTask.get(id);
			if (record.status === "settled" || record.status === "lost" || record.status === "ambiguous") {
				// The child left its running lifetime without folding `run-settled`
				// through the non-retained reducer, so clear the same placement
				// tracking here or it leaks for the manager's lifetime.
				this.workspacePlacedIds.delete(id);
				this.placementByTask.delete(id);
			}
			if (record.status === "settled" && completion) {
				const outcome = completion.outcome;
				if (!isSettled(current)) next = { ...next, status: outcome.kind === "completed" ? "done" : "error", settledAt: record.settledAt!, manifest: completion.manifest,
					finalText: outcome.kind === "completed" ? outcome.finalText : outcome.partialText ?? "", liveText: "",
					errorText: outcome.kind === "failed" ? outcome.errorText : outcome.kind === "interrupted" ? "interrupted" : undefined };
				this.children.delete(id);
				if ((this.waitInterest.get(id) ?? 0) > 0) this.consumedIds.add(id);
				tracked.unsubscribe?.();
				tracked.unsubscribe = undefined;
				if (outcome.kind === "failed") this.invalidatePreAttachTabCache(current, failedPlacement);
				// A settled record only exists after the owner's verified cleanup, so
				// its pane no longer occupies a slot: release the shared tab cache.
				this.releaseVisibleTab(id, next);
			} else if (record.status === "lost" || record.status === "ambiguous") {
				tracked.blocked = true;
				this.consumedIds.add(id);
				this.children.delete(id);
				// Cleanup was never confirmed, so a persisted pane may still occupy
				// its slot. Mirror the non-retained failed-close evidence so placement
				// keeps counting it instead of reclaiming a pane that still exists.
				next = { ...next, status: "error", recovery: record.status };
				if (current.visible && current.pane) next = { ...next, paneStillOpen: true };
				if (!current.pane) this.invalidatePreAttachTabCache(current, failedPlacement);
			}
			this.snapshots.set(id, this.withBudget(next));
			if (isSettled(next)) void this.scheduleDequeue();
			this.stopHealthTimerIfIdle();
			this.notify();
			this.prune();
		};
		tracked.unsubscribe = entry.supervisor.subscribe(observe);
		this.startHealthTimer();
		observe(entry.supervisor.record);
	}

	/** Readable, host-safe subagent id: `sa-<slugified title>-<n>`, plus a literal 4-char namespace suffix under retention. */
	private allocateId(title: string): string {
		const slug = slugifyBranch(title);
		let id: string;
		do { id = `sa-${slug}-${this.nextId++}${this.idNamespace ? `-${this.idNamespace}` : ""}`; } while (this.snapshots.has(id) || this.retained.has(id));
		return id;
	}

	public async spawn(task: SpawnSubagentTask): Promise<SubagentSnapshot | AtCapacityDetails> {
		if (this.detached) throw new Error("subagent manager was replaced");
		if (task.budget !== undefined) validateSubagentBudget(task.budget);
		task = { ...task, budget: task.budget ? { ...task.budget } : undefined };
		const generation = this.lifecycleGeneration;
		const runningSummaries = this.runningSummaries();
		if (runningSummaries.length >= SUBAGENT_MAX_RUNNING || this.queuedTasks.length > 0) {
			if (this.queuedTasks.length >= SUBAGENT_MAX_QUEUED) {
				return {
					status: "at_capacity",
					capacity: SUBAGENT_MAX_RUNNING,
					runningCount: runningSummaries.length,
					running: runningSummaries,
					retryHint: "queue is full — do NOT retry in a loop; cancel something or end your turn and respawn later",
				};
			}
			const id = this.allocateId(task.title);
			const createdAt = Date.now();
			const snapshot = makeInitialSnapshot(task, id, createdAt, "HEAD", task.cwd, undefined, undefined, "queued");
			this.queuedTasks.push({ task, id, createdAt, generation });
			this.snapshots.set(id, snapshot);
			this.notify();
			this.prune();
			return snapshot;
		}

		const id = this.allocateId(task.title);
		const snapshot = await this.startTask(task, id, Date.now(), generation);
		// A direct spawn can fail setup after later calls have filled the queue.
		// Drain immediately instead of leaving accepted work parked until an
		// unrelated running child settles.
		if (snapshot.status !== "running" && generation === this.lifecycleGeneration) void this.scheduleDequeue();
		return snapshot;
	}

	private runningSummaries(): SubagentCapacityTaskSummary[] {
		// A run-settled child is removed from `children` before its bounded
		// manifest read begins, so evidence collection does not occupy a worker
		// slot for up to five seconds.
		const running = this.list().filter((snapshot) => snapshot.status === "running" && this.children.has(snapshot.id));
		const pending = [...this.pendingSpawns].map(([id, spawn]) => ({ id, title: spawn.title, status: "running" as const, ageMs: Date.now() - spawn.createdAt }));
		return [
			...running.map((snapshot) => ({ id: snapshot.id, title: snapshot.title, status: snapshot.status, ageMs: Date.now() - snapshot.createdAt })),
			...pending,
		];
	}

	private async startTask(task: SpawnSubagentTask, id: string, createdAt: number, generation: number): Promise<SubagentSnapshot> {
		let finishLaunch: (() => void) | undefined;
		this.pendingSpawns.set(id, { title: task.title, createdAt });
		let pending = true;
		let releaseVisibleSpawn: (() => void) | undefined;
		let provisioningTimeoutMs: number | undefined;
		const releasePending = () => {
			if (!pending) return;
			pending = false;
			this.pendingSpawns.delete(id);
		};
		try {
			const gitContext = await this.captureGitContextImpl(task.cwd);
			const baseRef = gitContext.baseRef ?? "HEAD";
			if (this.setupInterrupted(id, generation)) {
				releasePending();
				return this.recordSetupInterruption(task, id, createdAt, baseRef, "interrupted during setup");
			}
			let manifestBaseRef = baseRef;
			if (task.branch && !task.worktree) {
				releasePending();
				return this.recordSpawnFailure(task, id, createdAt, baseRef, "branch requires worktree: true; refusing to ignore the isolation request");
			}
			let childCwd = task.cwd;
			let worktree: SubagentWorktreeRef | undefined;

			if (task.worktree) {
				if (!gitContext.repoRoot || !gitContext.baseRef) {
					releasePending();
					return this.recordSpawnFailure(task, id, createdAt, baseRef, "unable to create worktree: the spawn cwd is not a readable git checkout");
				}
				// Captured before the closure so the narrowed non-undefined repo root
				// survives into withWorktreeCreation's callback.
				const repoRoot = gitContext.repoRoot;
				const resolved = resolveCreateOptions({
					repoRoot,
					branch: task.branch,
					baseRef: task.baseRef ?? "HEAD",
					task: task.title,
				});
				const created = await this.withWorktreeCreation(async () => {
					// The gate can queue a spawn behind another creation. A setup that
					// was interrupted while waiting must not create (and preserve) a
					// worktree it will never run.
					if (this.setupInterrupted(id, generation)) return undefined;
					return this.createWorktreeImpl({
						repoRoot,
						branch: resolved.branch,
						baseRef: resolved.baseRef,
						path: resolved.path,
						task: task.title,
					});
				});
				if (!created) {
					releasePending();
					return this.recordSetupInterruption(task, id, createdAt, baseRef, "interrupted during setup");
				}
				if (!created.ok) {
					releasePending();
					return this.recordSpawnFailure(task, id, createdAt, baseRef, `unable to create worktree: ${created.message}`);
				}
				// Preserve the caller's subdirectory inside the worktree so a spawn
				// from /repo/packages/api lands in <worktree>/packages/api, matching
				// the non-isolated path's cwd semantics instead of jumping to root.
				const subPath = relative(gitContext.repoRoot, task.cwd);
				childCwd = subPath && !subPath.startsWith("..") && !isAbsolute(subPath)
					? join(created.path, subPath)
					: created.path;
				// Persist a stable commit for evidence and completion diffing. A
				// symbolic ref would move as the child commits or fetches and could
				// corrupt the manifest range.
				const resolvedBaseRef = await this.resolveWorktreeBaseRefImpl(created.path);
				if (!resolvedBaseRef) {
					worktree = {
						path: created.path,
						branch: created.branch,
						baseRef: created.baseRef,
						repoRoot: gitContext.repoRoot,
					};
					releasePending();
					return this.recordSpawnFailure(task, id, createdAt, baseRef, `unable to resolve worktree base commit. Worktree created at ${created.path} is preserved.`, created.path, worktree);
				}
				manifestBaseRef = resolvedBaseRef;
				worktree = {
					path: created.path,
					branch: created.branch,
					baseRef: manifestBaseRef,
					repoRoot: gitContext.repoRoot,
				};
				if (this.setupInterrupted(id, generation)) {
					releasePending();
					return this.recordSetupInterruption(task, id, createdAt, manifestBaseRef, `interrupted during setup. Worktree created at ${created.path} is preserved.`, childCwd, worktree);
				}
			}

			let placement: AgentPanePlacement | undefined;
			if (task.visible) {
				// Git/worktree preparation is a separate preflight. The user-facing
				// terminal-provisioning budget begins immediately before placement
				// serialization and follows the spawn through the host backend.
				const provisioningExpiresAt = Date.now() + VISIBLE_PANE_PROVISION_TOTAL_MS;
				releaseVisibleSpawn = await this.reserveVisibleSpawn(provisioningExpiresAt);
				provisioningTimeoutMs = Math.floor(provisioningExpiresAt - Date.now());
				if (!releaseVisibleSpawn || provisioningTimeoutMs <= 0) {
					releasePending();
					const preservationNote = worktree ? ` Worktree created at ${worktree.path} is preserved.` : "";
					return this.recordSpawnFailure(
						task,
						id,
						createdAt,
						manifestBaseRef,
						`visible pane provisioning queue timed out before a terminal host slot became available${preservationNote}`,
						childCwd,
						worktree,
						{ errorCode: "pane_unavailable" },
					);
				}
				if (this.setupInterrupted(id, generation)) {
					releasePending();
					return this.recordSetupInterruption(task, id, createdAt, manifestBaseRef, "interrupted during setup", childCwd, worktree);
				}
				const host = this.terminalHost;
				if (!host || !this.pi || host.kind === "none") {
					releasePending();
					return this.recordSpawnFailure(task, id, createdAt, manifestBaseRef, "visible subagents require a running terminal host", childCwd, worktree);
				}
				const planned = planPlacement({
					hostKind: host.kind,
					isolated: worktree !== undefined,
					// Task panes exit with their child process, so historical pane refs are
					// evidence only. Count live children or closed panes permanently consume
					// layout slots and force later spawns into phantom tabs.
					// Settling children have already left `children` (settle removes
					// them synchronously) but their snapshots keep status "running"
					// while the manifest collects async. Counting those freed panes
					// would overflow the caller tab into a phantom overflow tab. A
					// failed close, however, leaves the pane genuinely open, so keep
					// panes whose close was never confirmed occupying their slot.
					visiblePanes: this.list().flatMap((snapshot) => snapshot.visible && (this.children.has(snapshot.id) || snapshot.paneStillOpen === true) && snapshot.pane ? [snapshot.pane] : []),
					sessionTabId: this.subagentsTabId,
					// Isolated workspace tabs are isolation destinations, never shared
					// spillover targets for the vacancy scan.
					excludedTabIds: this.list().flatMap((snapshot) => this.workspacePlacedIds.has(snapshot.id) && snapshot.pane?.tabId ? [snapshot.pane.tabId] : []),
					callerTabId: this.initialVisibleTabId,
				});
				if (planned.kind === "workspace") {
					if (!worktree || !gitContext.repoRoot) {
						releasePending();
						return this.recordSpawnFailure(task, id, createdAt, manifestBaseRef, "unable to plan isolated workspace without a created worktree", childCwd, worktree);
					}
					// Herdr owns workspace open, pane discovery, split, and run under one
					// provisioning deadline. Preparing here would stack independent host
					// timeouts before the backend can report pane_unavailable.
					placement = {
						kind: "worktree-workspace",
						path: worktree.path,
						label: worktree.branch.replace(/^sumo\//, ""),
						sourceCwd: gitContext.repoRoot,
					};
				} else if (planned.kind === "tab") placement = planned;
				else placement = { kind: "new-tab", label: planned.kind === "new-tab" ? planned.label : "subagents" };
			}

			if (this.setupInterrupted(id, generation)) {
				releasePending();
				return this.recordSetupInterruption(task, id, createdAt, manifestBaseRef, "interrupted during setup", childCwd, worktree);
			}
			const controller = new AbortController();
			const done = new Promise<void>((resolve) => { finishLaunch = resolve; });
			this.launching.set(id, { controller, done });
			if (placement?.kind === "workspace" || placement?.kind === "worktree-workspace") this.workspacePlacedIds.add(id);
			if (placement !== undefined) this.placementByTask.set(id, placement);
			let child: SpawnedChild;
			try {
				child = await this.backendFactory({ ...task, cwd: childCwd, id, signal: controller.signal, placement,
					baseRef: manifestBaseRef, worktreeRef: worktree, provisioningTimeoutMs });
			} catch (error) {
				this.workspacePlacedIds.delete(id);
				// The construction never emits run-settled, so the placement would
				// otherwise leak in the tracking map forever.
				this.placementByTask.delete(id);
				releasePending();
				// A retained owner that refused before admission persists the same
				// structured failure the disposable backend folds via run-settled;
				// surface its taxonomy and orphan occupancy instead of text-only.
				const refusal = error instanceof RetainedLaunchRefusal ? error : undefined;
				const message = error instanceof Error ? error.message : String(error);
				const preservationNote = worktree ? ` Worktree created at ${worktree.path} is preserved.` : "";
				return this.recordSpawnFailure(task, id, createdAt, manifestBaseRef, `unable to spawn child: ${message}.${preservationNote}`, childCwd, worktree, refusal?.failure);
			}
			let snapshot = this.withBudget({ ...makeInitialSnapshot(task, id, createdAt, manifestBaseRef, childCwd, worktree, child.sessionFilePath), startedAt: Date.now() });
			if (child.retentionUnsupported) snapshot = { ...snapshot, recovery: "unsupported" };
			releasePending();
			if (child.retained) {
				const entry = { ...child.retained, snapshot };
				try { await this.trackRetained(entry); }
				catch {
					this.retained.set(id, { entry, blocked: true });
					this.snapshots.set(id, snapshot);
					this.blockRetained(id, "ambiguous");
				}
			} else {
				this.snapshots.set(id, snapshot);
				this.children.set(id, { child, controller });
				this.startHealthTimer();
				this.consumeEvents(id, child.events);
			}
			if (controller.signal.aborted || (!child.retained && this.setupInterrupted(id, generation))) {
				await this.children.get(id)?.child.interrupt();
			}
			if (child.ready) await child.ready;
			this.notify();
			this.prune();
			// A backend can settle synchronously (e.g. invalid model override emits
			// run-settled without spawning). Await that in-flight manifest build so
			// callers do not report "Started" for a dead child.
			const synchronousSettle = this.settlingPromises.get(id);
			if (synchronousSettle) await synchronousSettle;
			return this.snapshots.get(id) ?? snapshot;
		} finally {
			this.launching.delete(id);
			finishLaunch?.();
			this.cancelledSetupIds.delete(id);
			releaseVisibleSpawn?.();
			releasePending();
		}
	}

	public get(id: string): SubagentSnapshot | undefined {
		return this.snapshots.get(id);
	}

	public list(): SubagentSnapshot[] {
		return [...this.snapshots.values()];
	}

	public addChangeListener(fn: Listener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	public nextChange(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(new Error("Aborted"));
		return new Promise((resolve, reject) => {
			let cleanup = () => undefined;
			const onAbort = () => {
				cleanup();
				reject(new Error("Aborted"));
			};
			const unsubscribe = this.addChangeListener(() => {
				cleanup();
				resolve();
			});
			cleanup = () => {
				unsubscribe();
				signal?.removeEventListener("abort", onAbort);
			};
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	public async waitFor(ids: readonly string[], signal?: AbortSignal, onPending?: (snapshots: readonly SubagentSnapshot[]) => void): Promise<SubagentSnapshot[]> {
		const unknown = ids.filter((id) => !this.snapshots.has(id));
		if (unknown.length > 0) throw new Error(`Unknown subagent id(s): ${unknown.join(", ")}. Known ids: ${this.list().map((snapshot) => snapshot.id).join(", ") || "(none)"}`);
		for (const id of ids) this.waitInterest.set(id, (this.waitInterest.get(id) ?? 0) + 1);
		try {
			while (true) {
				const snapshots = ids.map((id) => this.snapshots.get(id)).filter((snapshot): snapshot is SubagentSnapshot => snapshot !== undefined);
				const pending = snapshots.filter((snapshot) => !isSettled(snapshot));
				if (pending.length === 0) {
					for (const snapshot of snapshots) this.consumedIds.add(snapshot.id);
					return snapshots;
				}
				onPending?.(pending);
				await this.nextChange(signal);
			}
		} finally {
			for (const id of ids) {
				const next = (this.waitInterest.get(id) ?? 1) - 1;
				if (next <= 0) this.waitInterest.delete(id);
				else this.waitInterest.set(id, next);
			}
			this.prune();
		}
	}

	public async cancel(ids: readonly string[]): Promise<string[]> {
		// Fire every interrupt synchronously FIRST, then await settles in
		// parallel. Awaiting each child before signalling the next would let a
		// SIGTERM-ignoring child delay the rest of the batch by up to
		// CANCEL_WAIT_MS each — cancel means "stop everything promptly".
		const lines = new Map<string, string>();
		const targets: string[] = [];
		const admissions = new Map<string, Promise<void>>();
		for (const id of ids) {
			const snapshot = this.snapshots.get(id);
			if (!snapshot) {
				lines.set(id, `${id} is unknown`);
				continue;
			}
			const settlingOutcome = this.settlingOutcomes.get(id);
			if (settlingOutcome) {
				lines.set(id, `${id} was already ${settlingOutcome.kind === "completed" ? "done" : "settled"}`);
				continue;
			}
			if (this.retained.get(id)?.blocked) {
				lines.set(id, `${id} control unavailable; inspect retained evidence`);
				continue;
			}
			this.consumedIds.add(id);
			if (isSettled(snapshot)) {
				lines.set(id, `${id} was already ${snapshot.status === "done" ? "done" : "settled"}`);
				continue;
			}
			if (snapshot.status === "queued") {
				const queueIndex = this.queuedTasks.findIndex((queued) => queued.id === id);
				if (queueIndex >= 0) this.queuedTasks.splice(queueIndex, 1);
				else if (this.pendingSpawns.has(id)) this.cancelledSetupIds.add(id);
				void this.startSettle(id, { kind: "interrupted" });
			} else {
				admissions.set(id, Promise.resolve(this.children.get(id)?.child.interrupt()));
			}
			targets.push(id);
		}
		await Promise.allSettled(targets.map(async (id) => {
			const retained = this.retained.has(id);
			try {
				await admissions.get(id);
			} catch {
				if (retained) {
					this.blockRetained(id, "ambiguous");
					lines.set(id, `${id} control unavailable; inspect retained evidence`);
					return;
				}
			}
			try {
				await this.waitForSettle(id, CANCEL_WAIT_MS);
			} catch {
				if (retained) {
					this.consumedIds.delete(id);
					lines.set(id, `cancel requested for ${id}; still running — inspect or retry`);
					return;
				}
				await this.startSettle(id, { kind: "interrupted", partialText: this.snapshots.get(id)?.finalText || this.snapshots.get(id)?.liveText });
			}
			lines.set(id, `Cancelled ${id}`);
		}));
		void this.scheduleDequeue();
		return ids.map((id) => lines.get(id) ?? `${id} is unknown`);
	}

	/**
	 * Wait until a running child's watcher consumes the steering control and
	 * synchronously submits it to Pi. This is not a model-turn delivery ACK.
	 * Throws with the same shapes the subagent tools surface directly.
	 */
	public async sendTo(id: string, text: string): Promise<SubagentSnapshot | { capability: "unsupported: headless steering" }> {
		const snapshot = this.snapshots.get(id);
		if (!snapshot) {
			throw new Error(`Unknown subagent id: ${id}. Known ids: ${this.list().map((known) => known.id).join(", ") || "(none)"}`);
		}
		if (snapshot.status === "queued") {
			throw new Error(`Subagent ${id} is queued and cannot receive input until it starts`);
		}
		if (isSettled(snapshot)) {
			throw new Error(`Subagent ${id} is already settled (${snapshot.status}) and cannot receive input`);
		}
		const retained = this.retained.get(id);
		if (this.detached || retained && (retained.blocked || !retained.entry.registry.inspectControl(retained.entry.authority))) {
			throw new Error(`Subagent ${id} control refused; inspect retained evidence`);
		}
		// Headless stdin carries a one-shot prompt, not a steering channel.
		if (!snapshot.visible) return { capability: "unsupported: headless steering" };
		const child = this.children.get(id)?.child;
		if (!child?.send) {
			throw new Error(`Subagent ${id} visible steering channel unavailable`);
		}
		await child.send(text);
		const current = this.snapshots.get(id) ?? snapshot;
		const next = this.withBudget({ ...current, turnState: "working", lastProgressAt: Date.now() });
		this.snapshots.set(id, next);
		this.notify();
		return next;
	}

	/**
	 * Gracefully close visible children: each child persists its response and
	 * exits, settling with a normal completion manifest. Unlike cancel, a
	 * close timeout never force-settles — the pane stays genuinely running
	 * and the orchestrator can fall back to subagent_cancel.
	 */
	public async close(ids: readonly string[]): Promise<string[]> {
		// Fire every close request synchronously FIRST, then await settles in
		// parallel, mirroring cancel() so one slow child cannot delay the batch.
		const lines = new Map<string, string>();
		const targets: string[] = [];
		for (const id of ids) {
			const snapshot = this.snapshots.get(id);
			if (!snapshot) {
				lines.set(id, `${id} is unknown`);
				continue;
			}
			const settlingOutcome = this.settlingOutcomes.get(id);
			if (settlingOutcome) {
				lines.set(id, `${id} was already ${settlingOutcome.kind === "completed" ? "done" : "settled"}`);
				continue;
			}
			if (this.retained.get(id)?.blocked) {
				lines.set(id, `${id} control unavailable; inspect retained evidence`);
				continue;
			}
			if (isSettled(snapshot)) {
				this.consumedIds.add(id);
				lines.set(id, `${id} was already ${snapshot.status === "done" ? "done" : "settled"}`);
				continue;
			}
			if (snapshot.status === "queued") {
				const queueIndex = this.queuedTasks.findIndex((queued) => queued.id === id);
				if (queueIndex >= 0) this.queuedTasks.splice(queueIndex, 1);
				else if (this.pendingSpawns.has(id)) this.cancelledSetupIds.add(id);
				void this.startSettle(id, { kind: "interrupted" });
				lines.set(id, `Cancelled queued ${id}`);
				continue;
			}
			const child = this.children.get(id)?.child;
			if (!child?.requestClose) {
				lines.set(id, `${id} is headless — it settles on its own; use subagent_cancel to stop it`);
				continue;
			}
			try {
				child.requestClose();
			} catch (error) {
				// The pane backend writes a file here, so this can throw when the task
				// dir was removed or became unwritable. Isolate it: an uncaught throw
				// would abort the whole batch, so later ids would never receive their
				// close request and the caller would get an error instead of per-id
				// results.
				lines.set(id, `unable to request close for ${id}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			targets.push(id);
		}
		await Promise.allSettled(targets.map(async (id) => {
			try {
				await this.waitForSettle(id, CLOSE_WAIT_MS);
				// The tool returns this child's result inline, so mark it consumed
				// here — only when the close actually settled.
				this.consumedIds.add(id);
				lines.set(id, `Closed ${id}`);
			} catch {
				// Do NOT force a synthetic settle — that is cancel's job. The real
				// child is still running and its pane stays open.
				lines.set(id, `close requested for ${id}; still running — check the pane or use subagent_cancel`);
			}
		}));
		void this.scheduleDequeue();
		return ids.map((id) => lines.get(id) ?? `${id} is unknown`);
	}

	/** Stop legacy work while leaving retained children live until session_start identifies the successor manager. */
	public prepareForReplacement(): void {
		this.lifecycleGeneration += 1;
		const queuedIds = this.queuedTasks.map((queued) => queued.id);
		this.queuedTasks.length = 0;
		for (const id of queuedIds) void this.startSettle(id, { kind: "interrupted" });
		for (const [id, snapshot] of this.snapshots) {
			if (this.retained.has(id)) continue;
			this.consumedIds.add(id);
			if (!isSettled(snapshot)) this.snapshots.set(id, { ...snapshot, recovery: "unsupported" });
		}
		for (const [id, entry] of this.children) {
			if (!this.retained.has(id) && this.snapshots.get(id)?.status === "running") entry.child.interrupt();
		}
	}

	public disposeAll(): void {
		for (const launch of this.launching.values()) launch.controller.abort();
		clearInterval(this.healthTimer);
		this.healthTimer = undefined;
		// In-flight setup cannot be synchronously interrupted, so advance the
		// generation first. Every awaited setup path checks this token before it
		// may construct a backend, preventing post-shutdown orphan children while
		// still allowing this manager to serve a later session.
		this.lifecycleGeneration += 1;
		const queuedIds = this.queuedTasks.map((queued) => queued.id);
		this.queuedTasks.length = 0;
		for (const id of queuedIds) void this.startSettle(id, { kind: "interrupted" });
		for (const [id, entry] of this.children) {
			const snapshot = this.snapshots.get(id);
			if (snapshot?.status === "running") entry.child.interrupt();
		}
	}

	private scheduleDequeue(): Promise<void> {
		const next = this.dequeueTail.then(() => this.drainQueue());
		this.dequeueTail = next.catch(() => undefined);
		return next;
	}

	private async drainQueue(): Promise<void> {
		while (this.queuedTasks.length > 0 && this.runningSummaries().length < SUBAGENT_MAX_RUNNING) {
			const queued = this.queuedTasks.shift();
			if (!queued) return;
			try {
				await this.startTask(queued.task, queued.id, queued.createdAt, queued.generation);
			} catch (error) {
				const current = this.snapshots.get(queued.id);
				if (current?.status === "queued") {
					this.recordSpawnFailure(
						queued.task,
						queued.id,
						queued.createdAt,
						"HEAD",
						`unable to start queued child: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		}
	}

	private setupInterrupted(id: string, generation: number): boolean {
		return generation !== this.lifecycleGeneration || this.cancelledSetupIds.has(id);
	}

	private recordSetupInterruption(
		task: SpawnSubagentTask,
		id: string,
		createdAt: number,
		baseRef: string,
		errorText: string,
		cwd = task.cwd,
		worktree?: SubagentWorktreeRef,
	): SubagentSnapshot {
		const current = this.snapshots.get(id);
		// Cancellation settles a dequeued task before its blocked setup resumes.
		// Never overwrite that terminal snapshot with a second failure record.
		if (current && isSettled(current)) return current;
		return this.recordSpawnFailure(task, id, createdAt, baseRef, errorText, cwd, worktree);
	}

	/**
	 * `git worktree add` writes the shared repository config, so concurrent
	 * isolated spawns can reject with `could not lock config file .git/config`
	 * and fail a spawn that would otherwise succeed. One in-process queue
	 * serializes creation; every holder releases in `finally`, so a failed add
	 * cannot wedge the queue.
	 */
	private async withWorktreeCreation<T>(run: () => Promise<T>): Promise<T> {
		const waitForTurn = this.worktreeGate;
		let release: () => void = () => undefined;
		this.worktreeGate = new Promise<void>((resolve) => { release = resolve; });
		await waitForTurn;
		try {
			return await run();
		} finally {
			release();
		}
	}

	private reserveVisibleSpawn(expiresAt: number): Promise<(() => void) | undefined> {
		if (!this.visibleSpawnReserved) {
			this.visibleSpawnReserved = true;
			return Promise.resolve(this.makeVisibleSpawnRelease());
		}
		const waitMs = Math.floor(expiresAt - Date.now());
		if (waitMs <= 0) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			const waiter: VisibleSpawnWaiter = {
				expiresAt,
				resolve,
				timeout: setTimeout(() => {
					const index = this.visibleSpawnWaiters.indexOf(waiter);
					if (index === -1) return;
					this.visibleSpawnWaiters.splice(index, 1);
					resolve(undefined);
				}, waitMs),
			};
			this.visibleSpawnWaiters.push(waiter);
		});
	}

	private makeVisibleSpawnRelease(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			for (;;) {
				const waiter = this.visibleSpawnWaiters.shift();
				if (!waiter) {
					this.visibleSpawnReserved = false;
					return;
				}
				clearTimeout(waiter.timeout);
				// Host completion and this waiter's timer can become ready in the same
				// turn. Never hand an expired waiter the lock: its spawn already failed.
				if (waiter.expiresAt <= Date.now()) {
					waiter.resolve(undefined);
					continue;
				}
				waiter.resolve(this.makeVisibleSpawnRelease());
				return;
			}
		};
	}

	private recordSpawnFailure(
		task: SpawnSubagentTask,
		id: string,
		createdAt: number,
		baseRef: string,
		errorText: string,
		cwd = task.cwd,
		worktree?: SubagentWorktreeRef,
		failure?: SubagentLaunchFailure,
	): SubagentSnapshot {
		const snapshot: SubagentSnapshot = {
			...makeInitialSnapshot(task, id, createdAt, baseRef, cwd, worktree),
			status: "error",
			settledAt: Date.now(),
			errorText: errorText.slice(0, ERROR_TEXT_MAX),
			errorCode: failure?.errorCode,
			errorReason: failure?.errorReason?.slice(0, ERROR_TEXT_MAX),
			// A refused launch whose cleanup was unconfirmed still occupies a
			// layout slot; keep it counted exactly like the disposable backend's
			// failed RunOutcome so placement cannot over-tile the tab.
			pane: failure?.orphanPane,
			paneStillOpen: failure?.paneStillOpen,
		};
		this.snapshots.set(id, snapshot);
		this.notify();
		this.prune();
		return snapshot;
	}

	private consumeEvents(id: string, events: SpawnedChild["events"]): void {
		const emit = (event: SubagentEvent) => this.fold(id, event);
		if (!(Symbol.asyncIterator in events)) {
			events(emit);
			return;
		}
		const consume = async (): Promise<void> => {
			for await (const event of events) emit(event);
		};
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejection boundary: backend async iterators may reject with any JavaScript value.
		void consume().catch((error: unknown) => {
			const current = this.snapshots.get(id);
			if (!current || isSettled(current)) return;
			const message = error instanceof Error ? error.message : String(error);
			const child = this.children.get(id)?.child;
			void this.startSettle(id, {
				kind: "failed",
				errorText: `subagent event stream failed: ${message}`,
				partialText: current.finalText || current.liveText || undefined,
			});
			try {
				child?.interrupt();
			} catch (interruptError) {
				const interruptMessage = (interruptError instanceof Error ? interruptError.message : String(interruptError)).slice(0, ERROR_TEXT_MAX);
				try {
					this.onDiagnostic?.({ kind: "interrupt", message: interruptMessage });
				} catch {
					// Diagnostics must not reopen a contained backend failure.
				}
			}
		});
	}

	/**
	 * Attach pane evidence to a snapshot and point the generated-tab cache at it
	 * unless the child is workspace-isolated. Shared by the non-retained event
	 * reducer and the retained record observer: a retained owner persists the
	 * same pane reference in the registry instead of emitting `pane-attached`.
	 */
	private attachPane(id: string, current: SubagentSnapshot, pane: SubagentPaneRef | null | undefined): SubagentSnapshot {
		if (!pane || (current.pane && current.pane.agentName === pane.agentName && current.pane.workspaceId === pane.workspaceId
			&& current.pane.tabId === pane.tabId && current.pane.paneId === pane.paneId)) return current;
		const attached: SubagentSnapshot = { ...current, pane };
		// A worktree workspace is an isolation fallback, not a shared caller
		// destination. Caching its tab would collapse later isolated children
		// into the first workspace whenever HERDR_TAB_ID is unavailable.
		if (pane.tabId && !this.workspacePlacedIds.has(id)) this.subagentsTabId = pane.tabId;
		return attached;
	}

	/**
	 * Drop the generated-tab cache as soon as its final live or failed-close pane
	 * settles. Herdr removes a task pane when its wrapper exits and removes an
	 * empty tab with it; when another generated tab still holds live panes the
	 * cache stays so the next spawn reclaims its free capacity instead of
	 * provisioning a duplicate overflow tab, falling back to the initial visible
	 * tab only when no live, non-isolated pane tab remains.
	 */
	private releaseVisibleTab(id: string, settled: SubagentSnapshot | undefined): void {
		if (
			!settled?.visible ||
			settled.pane?.tabId === undefined ||
			settled.pane.tabId !== this.subagentsTabId ||
			// A still-open pane (failed close or failed provisioning cleanup)
			// keeps the tab alive, so the cache must not be dropped.
			settled.paneStillOpen === true ||
			// Liveness must come from `children`, not the snapshot: settle()
			// removes a child from `children` synchronously, but the snapshot
			// keeps status "running" while its manifest collects async. Two
			// siblings settling close together would otherwise each see the
			// other as still live and neither would drop the generated-tab cache.
			// A settled child whose close failed keeps its pane open and counts
			// the same way.
			this.list().some((snapshot) => snapshot.id !== id && (this.children.has(snapshot.id) || snapshot.paneStillOpen === true) && snapshot.pane?.tabId === this.subagentsTabId)
		) return;
		const surviving = this.list().find((snapshot) => {
			// Isolated workspace children are not shared caller destinations;
			// caching their tab would collapse later children into the first
			// workspace (same guard as pane-attach). Failed-close panes keep
			// their tab alive, so a settled paneStillOpen snapshot is as valid
			// a surviving cache anchor as a live child.
			if (snapshot.id === id || (!this.children.has(snapshot.id) && snapshot.paneStillOpen !== true) || this.workspacePlacedIds.has(snapshot.id)) return false;
			const tabId = snapshot.pane?.tabId;
			return tabId !== undefined && tabId !== this.subagentsTabId && tabId.split(":")[0] === this.subagentsTabId?.split(":")[0];
		});
		this.subagentsTabId = surviving?.pane?.tabId ?? this.initialVisibleTabId;
	}

	/**
	 * A visible child that FAILED before any pane attached is evidence the
	 * cached subagents tab may be gone (e.g. the human closed it — splitting a
	 * closed cached tab fails, and no pane event ever fired). Invalidate the
	 * cache so the next spawn re-plans a fresh tab instead of failing forever.
	 * Evidence-based, not error-text sniffing; the worst case for a transient
	 * failure is one extra tab (cosmetic). When the cache was the initial caller
	 * tab itself, unseed instead so the next spawn re-plans a fresh tab and
	 * re-caches on pane-attach. Shared by both backends.
	 */
	private invalidatePreAttachTabCache(settled: SubagentSnapshot | undefined, placement: AgentPanePlacement | undefined): void {
		if (!settled?.visible || settled.pane || placement?.kind !== "tab" || this.subagentsTabId === undefined) return;
		this.subagentsTabId = this.subagentsTabId === this.initialVisibleTabId ? undefined : this.initialVisibleTabId;
	}

	private fold(id: string, event: SubagentEvent): void {
		if (event.kind === "run-settled") {
			const workspacePlaced = this.workspacePlacedIds.has(id);
			this.workspacePlacedIds.delete(id);
			const failedPlacement = this.placementByTask.get(id);
			this.placementByTask.delete(id);
			const settling = this.snapshots.get(id);
			let settledNow = settling;
			const outcome = event.outcome.kind === "failed" && settling?.worktree && !settling.pane
				? { ...event.outcome, errorText: `${event.outcome.errorText}. Worktree created at ${settling.worktree.path} is preserved.` }
				: event.outcome;
			if (outcome.kind === "failed" && outcome.orphanPane && settledNow && !settledNow.pane) {
				// Provisioning cleanup failed after allocating a pane. Record the
				// orphan synchronously so placement keeps counting the slot and the
				// tab-liveness checks below treat the tab as still occupied.
				settledNow = { ...settledNow, pane: outcome.orphanPane, paneStillOpen: true };
				this.snapshots.set(id, settledNow);
				// A generated orphan tab cannot be inferred from the placement:
				// the host reports it only when cleanup of a new-tab spawn failed.
				// Point the reclaim cache at it so the next spawn splits into the
				// surviving tab instead of provisioning a duplicate. Isolated
				// workspace children must never capture the shared cache, the same
				// guard as pane-attach.
				if (outcome.orphanPane.tabId && !workspacePlaced) {
					this.subagentsTabId = outcome.orphanPane.tabId;
				}
			}
			if (outcome.kind === "failed" && outcome.paneStillOpen === true && settledNow && settledNow.paneStillOpen !== true) {
				// A close failure can be reported late: after cancel() already
				// force-settled the snapshot, or while a synthetic interrupted
				// settlement is still collecting its manifest (provisioning plus
				// the close timeout can outlive CANCEL_WAIT_MS). The pane is still
				// open, so record the occupancy immediately — the cache-drop guard
				// below and concurrent placement both read it, and the interrupted
				// settle path preserves it on completion.
				settledNow = { ...settledNow, paneStillOpen: true };
				this.snapshots.set(id, settledNow);
			}
			this.releaseVisibleTab(id, settledNow);
			if (outcome.kind === "failed" && !settledNow?.pane && failedPlacement?.kind === "tab" && outcome.paneTabGone === true) {
				// The host confirmed the target tab has no live pane, so it is
				// gone. Retire still-open records anchored on it so the vacancy
				// scan cannot keep selecting the dead tab and fail forever. A
				// pre-attach failure without this signal (e.g. a run failure on a
				// live tab) must not retire records.
				for (const snapshot of this.list()) {
					if (snapshot.paneStillOpen === true && snapshot.pane?.tabId === failedPlacement.tabId) {
						this.snapshots.set(snapshot.id, { ...snapshot, paneStillOpen: undefined });
					}
				}
				if (failedPlacement.tabId === this.initialVisibleTabId) {
					// The caller tab itself is proven gone (the operator moved the
					// parent pane elsewhere). Stop supplying the stale id to the
					// cache fallback and the vacancy seed; closed Herdr ids are
					// never reused.
					this.initialVisibleTabId = undefined;
				}
			}
			if (outcome.kind === "failed") this.invalidatePreAttachTabCache(settledNow, failedPlacement);
			void this.startSettle(id, outcome);
			return;
		}
		const current = this.snapshots.get(id);
		if (!current) return;
		if (event.kind === "pane-attached") {
			this.snapshots.set(id, this.attachPane(id, current, event.pane));
			this.notify();
			return;
		}
		if (event.kind === "run-started") this.startedIds.add(id);
		// Terminal state is sticky. After a cancel timeout we fold a synthetic
		// interrupted settle while the OS process is still dying (SIGTERM sent,
		// SIGKILL 5s later); its eventual real close would otherwise re-fold a
		// run-settled and flip an explicitly cancelled subagent back to "done".
		if (isSettled(current)) return;
		let next = current;
		if (event.kind === "turn-started") next = { ...current, turnState: "working" };
		else if (event.kind === "turn-finished") next = { ...current, turnState: "idle", turnSequence: (current.turnSequence ?? 0) + 1, finalText: event.finalText, liveText: "" };
		else if (event.kind === "assistant-delta") next = { ...current, liveText: `${current.liveText}${event.delta}` };
		else if (event.kind === "tool-start") next = { ...current, liveTools: upsertTool(current.liveTools, { id: event.toolId, name: event.name, argsPreview: event.argsPreview, done: false, isError: false, startedAt: Date.now() }) };
		else if (event.kind === "tool-update") next = { ...current, liveTools: upsertTool(current.liveTools, { id: event.toolId, name: current.liveTools.find((tool) => tool.id === event.toolId)?.name ?? "tool", outputPreview: event.outputPreview, done: false, isError: false }) };
		else if (event.kind === "tool-end") next = { ...current, liveTools: upsertTool(current.liveTools, { id: event.toolId, name: event.name, outputPreview: event.outputPreview, done: true, isError: event.isError }) };
		else if (event.kind === "message-end") next = {
			...current,
			transcript: [...(event.replacesRetainedText ? [] : current.transcript), { role: event.role, text: event.text, createdAt: Date.now() }],
			liveText: event.role === "assistant" ? "" : current.liveText,
			finalText: event.role === "assistant" ? event.text : current.finalText,
			usage: event.role === "assistant" ? { ...current.usage, turns: current.usage.turns + 1 } : current.usage,
		};
		else if (event.kind === "usage") next = {
			...current,
			// Preserve prior values when an event omits a field — an assistant
			// message without usage accounting must not clobber real numbers.
			usage: {
				...current.usage,
				tokens: event.tokens ?? current.usage.tokens,
				contextWindow: event.contextWindow ?? current.usage.contextWindow,
				costUsd: event.costUsd ?? current.usage.costUsd,
				reportedTokens: addReportedSubagentUsage(current.usage.reportedTokens, event.tokens),
				reportedCostUsd: addReportedSubagentUsage(current.usage.reportedCostUsd, event.costUsd),
			},
		};
		if (event.kind === "turn-started" || event.kind === "turn-finished") {
			next = { ...next, lastProgressAt: event.at };
		} else if (event.kind === "heartbeat") {
			if (!current.visible || !Number.isSafeInteger(event.at) || event.at <= (current.lastHeartbeatAt ?? 0) || event.at > Date.now() || Date.now() - event.at > 2000) return;
			next = { ...next, lastHeartbeatAt: event.at };
		} else if (!current.visible && event.kind !== "run-started") next = { ...next, lastProgressAt: Date.now() };
		this.snapshots.set(id, this.withBudget(next));
		this.notify();
		this.prune();
	}

	private markTurnDelivered(payload: DeliveryPayload): void {
		const current = this.snapshots.get(payload.id);
		if (!current || !payload.turnSequence || payload.turnText === undefined || payload.turnSequence <= (current.deliveredTurnSequence ?? 0)) return;
		this.snapshots.set(payload.id, { ...current, deliveredTurnSequence: payload.turnSequence, deliveredTurnText: payload.turnText });
	}

	private startSettle(id: string, outcome: RunOutcome): Promise<void> {
		const existing = this.settlingPromises.get(id);
		if (existing) return existing;
		this.settlingOutcomes.set(id, outcome);
		const promise = this.settle(id, outcome).finally(() => {
			if (this.settlingPromises.get(id) === promise) {
				this.settlingPromises.delete(id);
				this.settlingOutcomes.delete(id);
			}
		});
		this.settlingPromises.set(id, promise);
		return promise;
	}

	private async settle(id: string, outcome: RunOutcome): Promise<void> {
		const current = this.snapshots.get(id);
		if (!current || isSettled(current) || this.settlingIds.has(id)) return;
		this.settlingIds.add(id);
		this.children.delete(id);
		this.stopHealthTimerIfIdle();
		// A failed close leaves the pane open while `children` no longer tracks
		// it. Record that occupancy synchronously so a concurrent spawn's
		// capacity check counts the pane during the asynchronous manifest
		// collection below, not only after it finishes.
		if (outcome.kind === "failed" && outcome.paneStillOpen) {
			this.snapshots.set(id, { ...current, paneStillOpen: true });
		}
		const settledAt = Date.now();
		try {
			if (current.status === "queued") {
				this.snapshots.set(id, {
					...current,
					status: "error",
					settledAt,
					errorText: "interrupted",
					manifest: { exit: "interrupted", durationMs: Math.max(0, settledAt - current.createdAt) },
				});
				if ((this.waitInterest.get(id) ?? 0) > 0) this.consumedIds.add(id);
				this.notify();
				this.prune();
				return;
			}
			// Configuration failures can settle synchronously before the backend
			// emits run-started. No child ran, so avoid blocking spawn on checkout
			// git reads and attach only the truthful process facts.
			const manifest = outcome.kind === "failed" && !this.startedIds.has(id)
				? { exit: outcome.kind, durationMs: Math.max(0, settledAt - current.createdAt) } as const
				: await this.collectManifest(current, outcome);
			const latest = this.snapshots.get(id);
			if (!latest || isSettled(latest)) return;
			let next: SubagentSnapshot;
			if (outcome.kind === "completed") next = { ...latest, status: "done", settledAt, finalText: outcome.finalText || latest.finalText, liveText: "", manifest };
			else if (outcome.kind === "failed") next = {
				...latest,
				status: "error",
				settledAt,
				errorText: outcome.errorText.slice(0, ERROR_TEXT_MAX),
				errorCode: outcome.errorCode,
				errorReason: outcome.errorReason?.slice(0, ERROR_TEXT_MAX),
				// A late close-failure flag recorded while this settlement was in
				// flight is real evidence this outcome lacks; keep it.
				paneStillOpen: outcome.paneStillOpen ?? latest.paneStillOpen,
				finalText: outcome.partialText ?? latest.finalText,
				liveText: "",
				manifest,
			};
			else next = { ...latest, status: "error", settledAt, errorText: "interrupted", finalText: outcome.partialText ?? latest.finalText, liveText: "", manifest };
			this.snapshots.set(id, this.withBudget(next));
			if ((this.waitInterest.get(id) ?? 0) > 0) this.consumedIds.add(id);
			// Completion listeners (including deferred delivery) must observe the
			// manifest on the same immutable terminal snapshot.
			this.notify();
			this.prune();
		} finally {
			this.settlingIds.delete(id);
			this.startedIds.delete(id);
			void this.scheduleDequeue();
		}
	}

	private async collectManifest(snapshot: SubagentSnapshot, outcome: RunOutcome): Promise<CompletionManifestEvidence> {
		const fallback: CompletionManifestEvidence = {
			exit: outcome.kind,
			durationMs: Math.max(0, Date.now() - snapshot.createdAt),
		};
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				this.buildCompletionManifestImpl({
					cwd: snapshot.cwd,
					baseRef: snapshot.baseRef,
					outcome,
					startedAt: snapshot.createdAt,
					worktree: snapshot.worktree,
				}).catch(() => fallback),
				new Promise<CompletionManifestEvidence>((resolve) => {
					timeout = setTimeout(() => resolve(fallback), MANIFEST_TIMEOUT_MS);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	private waitForSettle(id: string, timeoutMs: number): Promise<void> {
		// SAFETY: settled snapshots are always stored complete; only transient maps can miss the id.
		if (isSettled(this.snapshots.get(id) as SubagentSnapshot)) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				unsubscribe();
				reject(new Error("cancel timeout"));
			}, timeoutMs);
			const unsubscribe = this.addChangeListener(() => {
				const snapshot = this.snapshots.get(id);
				if (snapshot && isSettled(snapshot)) {
					clearTimeout(timeout);
					unsubscribe();
					resolve();
				}
			});
		});
	}

	private withBudget(snapshot: SubagentSnapshot): SubagentSnapshot {
		const tools = snapshot.liveTools.filter((tool) => !tool.done && tool.startedAt !== undefined);
		return { ...snapshot, ...evaluateSubagentBudget({
			now: snapshot.settledAt ?? Date.now(), status: snapshot.status,
			startedAt: snapshot.startedAt ?? null, lastProgressAt: snapshot.lastProgressAt ?? null, lastHeartbeatAt: snapshot.lastHeartbeatAt,
			budget: snapshot.budget, progress: snapshot.visible ? "liveness-only" : "events",
			// A running handle or an attached pane is not an OS liveness observation.
			liveness: "unknown", toolStartedAt: tools.length ? Math.min(...tools.map((tool) => tool.startedAt!)) : undefined,
			usage: { tokens: snapshot.usage.reportedTokens, costUsd: snapshot.usage.reportedCostUsd },
		}) };
	}

	/** A settled-but-undelivered retained completion still needs control-lease renewal, so the timer outlives its child handle. */
	private stopHealthTimerIfIdle(): void {
		if (this.children.size > 0) return;
		for (const [id, tracked] of this.retained) {
			if (tracked.blocked) continue;
			let record: SubagentRecord | undefined;
			try {
				record = tracked.entry.registry.get(id);
			} catch {
				continue;
			}
			if (record && record.delivery.state !== "none" && record.delivery.state !== "sent") return;
		}
		clearInterval(this.healthTimer);
		this.healthTimer = undefined;
	}

	private startHealthTimer(): void {
		if (this.healthTimer) return;
		this.healthTimer = setInterval(() => {
			let changed = false;
			for (const id of this.children.keys()) {
				const retained = this.retained.get(id);
				if (retained && !retained.blocked) {
					try {
						const lease = retained.entry.registry.get(id)?.controlLease;
						if (!lease || lease.expiresAt - Date.now() < 30_000) retained.entry.registry.renewControl(retained.entry.authority);
					} catch {
						this.blockRetained(id, "ambiguous");
						changed = true;
					}
				}
				const current = this.snapshots.get(id);
				if (!current || current.status !== "running") continue;
				const next = this.withBudget(current);
				changed ||= next.health !== current.health || next.warnings?.join() !== current.warnings?.join();
				this.snapshots.set(id, next);
			}
			let pendingDelivery = false;
			for (const [id, tracked] of this.retained) {
				if (tracked.blocked || this.children.has(id)) continue;
				let record: SubagentRecord | undefined;
				try {
					record = tracked.entry.registry.get(id);
				} catch {
					this.blockRetained(id, "ambiguous");
					changed = true;
					continue;
				}
				if (!record || record.delivery.state === "none" || record.delivery.state === "sent") continue;
				pendingDelivery = true;
				try {
					const lease = record.controlLease;
					if (!lease || lease.expiresAt - Date.now() < 30_000) tracked.entry.registry.renewControl(tracked.entry.authority);
				} catch {
					this.blockRetained(id, "ambiguous");
					changed = true;
				}
			}
			if (this.children.size === 0 && !pendingDelivery) { clearInterval(this.healthTimer); this.healthTimer = undefined; }
			if (changed) this.notify();
		}, 1000);
		this.healthTimer.unref();
	}

	private notify(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch (error) {
				const message = (error instanceof Error ? error.message : String(error)).slice(0, ERROR_TEXT_MAX);
				try {
					this.onDiagnostic?.({ kind: "listener", message });
				} catch {
					// Diagnostics must not break later listeners.
				}
			}
		}
	}

	private prune(): void {
		// A failed-close (or failed provisioning-cleanup) pane keeps occupying
		// layout capacity, so its snapshot must survive history pruning: the
		// placement predicate reads occupancy only from this.list(), and losing
		// the record after MAX_TRACKED newer tasks would undercount the tab and
		// allow an over-capacity split. The number of such records is bounded by
		// real open panes, so the exemption cannot grow history unboundedly.
		const pruneable = this.list().filter((snapshot) => isSettled(snapshot) && snapshot.paneStillOpen !== true && !this.waitInterest.has(snapshot.id));
		while (this.snapshots.size > MAX_TRACKED && pruneable.length > 0) {
			const oldest = pruneable.shift();
			if (!oldest) break;
			this.snapshots.delete(oldest.id);
			this.consumedIds.delete(oldest.id);
		}
	}
}
