import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWorktree, resolveCreateOptions, type CreateWorktreeOptions, type CreateWorktreeResult } from "../git/worktree.js";
import type { SpawnedChild } from "./backend-pi.js";
import type { LiveToolState, RunOutcome, SubagentEvent, SubagentSnapshot, SubagentWorktreeRef } from "./domain.js";
import { buildCompletionManifest, type CompletionManifestEvidence } from "./manifest.js";

const execFileAsync = promisify(execFile);

const MAX_RUNNING = 4;
const MAX_TRACKED = 64;
const ERROR_TEXT_MAX = 4096;
const CANCEL_WAIT_MS = 5_500;
const GIT_READ_TIMEOUT_MS = 5_000;
const MANIFEST_TIMEOUT_MS = 5_000;

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
	readonly prompt: string;
	readonly title: string;
	readonly cwd: string;
	readonly worktree?: boolean;
	readonly branch?: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly inherited?: { model?: { provider: string; id: string }; thinking?: string };
	readonly builtInTools?: readonly string[];
}

type BackendFactory = (task: SpawnSubagentTask & { id: string; signal: AbortSignal }) => SpawnedChild;
type Listener = () => void;
type WorktreeCreator = (options: CreateWorktreeOptions) => Promise<CreateWorktreeResult>;

interface SpawnGitContext {
	readonly repoRoot?: string;
	readonly baseRef?: string;
}

export interface SubagentManagerDependencies {
	readonly createWorktree?: WorktreeCreator;
	readonly captureGitContext?: (cwd: string) => Promise<SpawnGitContext>;
	readonly buildCompletionManifest?: typeof buildCompletionManifest;
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

const isSettled = (snapshot: SubagentSnapshot): boolean => snapshot.status !== "running";

const makeInitialSnapshot = (
	task: SpawnSubagentTask,
	id: string,
	createdAt: number,
	baseRef: string,
	cwd = task.cwd,
	worktree?: SubagentWorktreeRef,
	sessionFilePath?: string,
): SubagentSnapshot => ({
	id,
	title: task.title,
	prompt: task.prompt,
	cwd,
	baseRef,
	worktree,
	status: "running",
	createdAt,
	modelLabel: task.model,
	sessionFilePath,
	usage: { turns: 0 },
	transcript: [],
	liveText: "",
	liveTools: [],
	finalText: "",
});

const upsertTool = (tools: readonly LiveToolState[], next: LiveToolState): readonly LiveToolState[] => {
	const index = tools.findIndex((tool) => tool.id === next.id);
	if (index === -1) return [...tools, next];
	return tools.map((tool, toolIndex) => toolIndex === index ? { ...tool, ...next } : tool);
};

export class SubagentManager {
	private nextId = 1;
	private readonly pendingSpawns = new Map<string, { title: string; createdAt: number }>();
	private readonly snapshots = new Map<string, SubagentSnapshot>();
	private readonly children = new Map<string, { child: SpawnedChild; controller: AbortController }>();
	private readonly waitInterest = new Map<string, number>();
	private readonly listeners = new Set<Listener>();
	private readonly createWorktreeImpl: WorktreeCreator;
	private readonly captureGitContextImpl: (cwd: string) => Promise<SpawnGitContext>;
	private readonly buildCompletionManifestImpl: typeof buildCompletionManifest;
	private readonly settlingIds = new Set<string>();
	private readonly settlingPromises = new Map<string, Promise<void>>();
	private readonly settlingOutcomes = new Map<string, RunOutcome>();
	private readonly startedIds = new Set<string>();
	public readonly consumedIds = new Set<string>();

	public constructor(private readonly backendFactory: BackendFactory, dependencies: SubagentManagerDependencies = {}) {
		this.createWorktreeImpl = dependencies.createWorktree ?? createWorktree;
		this.captureGitContextImpl = dependencies.captureGitContext ?? captureGitContext;
		this.buildCompletionManifestImpl = dependencies.buildCompletionManifest ?? buildCompletionManifest;
	}

	public async spawn(task: SpawnSubagentTask): Promise<SubagentSnapshot | AtCapacityDetails> {
		// A run-settled child is removed from `children` before its bounded
		// manifest read begins, so evidence collection does not occupy a worker
		// slot for up to five seconds.
		const running = this.list().filter((snapshot) => snapshot.status === "running" && this.children.has(snapshot.id));
		const pendingSummaries = [...this.pendingSpawns].map(([id, spawn]) => ({ id, title: spawn.title, status: "running" as const, ageMs: Date.now() - spawn.createdAt }));
		const runningSummaries = [
			...running.map((snapshot) => ({ id: snapshot.id, title: snapshot.title, status: snapshot.status, ageMs: Date.now() - snapshot.createdAt })),
			...pendingSummaries,
		];
		if (runningSummaries.length >= MAX_RUNNING) {
			return {
				status: "at_capacity",
				capacity: MAX_RUNNING,
				runningCount: runningSummaries.length,
				running: runningSummaries,
				retryHint: "wait for a running subagent to settle, then retry subagent_spawn",
			};
		}

		const id = `sa-${this.nextId++}`;
		const createdAt = Date.now();
		this.pendingSpawns.set(id, { title: task.title, createdAt });
		let pending = true;
		const releasePending = () => {
			if (!pending) return;
			pending = false;
			this.pendingSpawns.delete(id);
		};
		try {
			const gitContext = await this.captureGitContextImpl(task.cwd);
			const baseRef = gitContext.baseRef ?? "HEAD";
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
				const resolved = resolveCreateOptions({
					repoRoot: gitContext.repoRoot,
					branch: task.branch,
					baseRef: gitContext.baseRef,
					task: task.title,
				});
				const created = await this.createWorktreeImpl({
					repoRoot: gitContext.repoRoot,
					branch: resolved.branch,
					baseRef: resolved.baseRef,
					path: resolved.path,
					task: task.title,
				});
				if (!created.ok) {
					releasePending();
					return this.recordSpawnFailure(task, id, createdAt, baseRef, `unable to create worktree: ${created.message}`);
				}
				childCwd = created.path;
				worktree = {
					path: created.path,
					branch: created.branch,
					baseRef: gitContext.baseRef,
					repoRoot: gitContext.repoRoot,
				};
			}

			const controller = new AbortController();
			let child: SpawnedChild;
			try {
				child = this.backendFactory({ ...task, cwd: childCwd, id, signal: controller.signal });
			} catch (error) {
				releasePending();
				const message = error instanceof Error ? error.message : String(error);
				const preservationNote = worktree ? ` Worktree created at ${worktree.path} is preserved.` : "";
				return this.recordSpawnFailure(task, id, createdAt, baseRef, `unable to spawn child: ${message}.${preservationNote}`, childCwd, worktree);
			}
			const snapshot = makeInitialSnapshot(task, id, createdAt, baseRef, childCwd, worktree, child.sessionFilePath);
			this.snapshots.set(id, snapshot);
			this.children.set(id, { child, controller });
			releasePending();
			this.consumeEvents(id, child.events);
			this.notify();
			this.prune();
			// A backend can settle synchronously (e.g. invalid model override emits
			// run-settled without spawning). Await that in-flight manifest build so
			// callers do not report "Started" for a dead child.
			const synchronousSettle = this.settlingPromises.get(id);
			if (synchronousSettle) await synchronousSettle;
			return this.snapshots.get(id) ?? snapshot;
		} finally {
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
			this.consumedIds.add(id);
			if (isSettled(snapshot)) {
				lines.set(id, `${id} was already ${snapshot.status === "done" ? "done" : "settled"}`);
				continue;
			}
			this.children.get(id)?.child.interrupt();
			targets.push(id);
		}
		await Promise.allSettled(targets.map(async (id) => {
			try {
				await this.waitForSettle(id, CANCEL_WAIT_MS);
			} catch {
				await this.startSettle(id, { kind: "interrupted", partialText: this.snapshots.get(id)?.finalText || this.snapshots.get(id)?.liveText });
			}
			lines.set(id, `Cancelled ${id}`);
		}));
		return ids.map((id) => lines.get(id) ?? `${id} is unknown`);
	}

	public disposeAll(): void {
		for (const [id, entry] of this.children) {
			const snapshot = this.snapshots.get(id);
			if (snapshot?.status === "running") entry.child.interrupt();
		}
	}

	private recordSpawnFailure(
		task: SpawnSubagentTask,
		id: string,
		createdAt: number,
		baseRef: string,
		errorText: string,
		cwd = task.cwd,
		worktree?: SubagentWorktreeRef,
	): SubagentSnapshot {
		const snapshot: SubagentSnapshot = {
			...makeInitialSnapshot(task, id, createdAt, baseRef, cwd, worktree),
			status: "error",
			settledAt: Date.now(),
			errorText: errorText.slice(0, ERROR_TEXT_MAX),
		};
		this.snapshots.set(id, snapshot);
		this.notify();
		this.prune();
		return snapshot;
	}

	private consumeEvents(id: string, events: SpawnedChild["events"]): void {
		const emit = (event: SubagentEvent) => this.fold(id, event);
		if (typeof events === "function") {
			events(emit);
			return;
		}
		void (async () => {
			for await (const event of events) emit(event);
		})();
	}

	private fold(id: string, event: SubagentEvent): void {
		if (event.kind === "run-settled") {
			void this.startSettle(id, event.outcome);
			return;
		}
		const current = this.snapshots.get(id);
		if (!current) return;
		if (event.kind === "run-started") this.startedIds.add(id);
		// Terminal state is sticky. After a cancel timeout we fold a synthetic
		// interrupted settle while the OS process is still dying (SIGTERM sent,
		// SIGKILL 5s later); its eventual real close would otherwise re-fold a
		// run-settled and flip an explicitly cancelled subagent back to "done".
		if (isSettled(current)) return;
		let next = current;
		if (event.kind === "assistant-delta") next = { ...current, liveText: `${current.liveText}${event.delta}` };
		else if (event.kind === "tool-start") next = { ...current, liveTools: upsertTool(current.liveTools, { id: event.toolId, name: event.name, argsPreview: event.argsPreview, done: false, isError: false }) };
		else if (event.kind === "tool-update") next = { ...current, liveTools: upsertTool(current.liveTools, { id: event.toolId, name: current.liveTools.find((tool) => tool.id === event.toolId)?.name ?? "tool", outputPreview: event.outputPreview, done: false, isError: false }) };
		else if (event.kind === "tool-end") next = { ...current, liveTools: upsertTool(current.liveTools, { id: event.toolId, name: event.name, outputPreview: event.outputPreview, done: true, isError: event.isError }) };
		else if (event.kind === "message-end") next = {
			...current,
			transcript: [...current.transcript, { role: event.role, text: event.text, createdAt: Date.now() }],
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
			},
		};
		this.snapshots.set(id, next);
		this.notify();
		this.prune();
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
		const settledAt = Date.now();
		try {
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
			else if (outcome.kind === "failed") next = { ...latest, status: "error", settledAt, errorText: outcome.errorText.slice(0, ERROR_TEXT_MAX), finalText: outcome.partialText ?? latest.finalText, liveText: "", manifest };
			else next = { ...latest, status: "error", settledAt, errorText: "interrupted", finalText: outcome.partialText ?? latest.finalText, liveText: "", manifest };
			this.snapshots.set(id, next);
			if ((this.waitInterest.get(id) ?? 0) > 0) this.consumedIds.add(id);
			// Completion listeners (including deferred delivery) must observe the
			// manifest on the same immutable terminal snapshot.
			this.notify();
			this.prune();
		} finally {
			this.settlingIds.delete(id);
			this.startedIds.delete(id);
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

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	private prune(): void {
		const pruneable = this.list().filter((snapshot) => isSettled(snapshot) && !this.waitInterest.has(snapshot.id));
		while (this.snapshots.size > MAX_TRACKED && pruneable.length > 0) {
			const oldest = pruneable.shift();
			if (!oldest) break;
			this.snapshots.delete(oldest.id);
			this.consumedIds.delete(oldest.id);
		}
	}
}
