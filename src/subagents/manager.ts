import type { SpawnedChild } from "./backend-pi.js";
import type { LiveToolState, SubagentEvent, SubagentSnapshot } from "./domain.js";

const MAX_RUNNING = 4;
const MAX_TRACKED = 64;
const ERROR_TEXT_MAX = 4096;
const CANCEL_WAIT_MS = 5_500;

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
	readonly model?: string;
	readonly thinking?: string;
	readonly inherited?: { model?: { provider: string; id: string }; thinking?: string };
	readonly builtInTools?: readonly string[];
}

type BackendFactory = (task: SpawnSubagentTask & { id: string; signal: AbortSignal }) => SpawnedChild;
type Listener = () => void;

const isSettled = (snapshot: SubagentSnapshot): boolean => snapshot.status !== "running";

const makeInitialSnapshot = (task: SpawnSubagentTask, id: string, sessionFilePath: string | undefined): SubagentSnapshot => ({
	id,
	title: task.title,
	prompt: task.prompt,
	cwd: task.cwd,
	status: "running",
	createdAt: Date.now(),
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
	private readonly snapshots = new Map<string, SubagentSnapshot>();
	private readonly children = new Map<string, { child: SpawnedChild; controller: AbortController }>();
	private readonly waitInterest = new Map<string, number>();
	private readonly listeners = new Set<Listener>();
	public readonly consumedIds = new Set<string>();

	public constructor(private readonly backendFactory: BackendFactory) {}

	public spawn(task: SpawnSubagentTask): SubagentSnapshot | AtCapacityDetails {
		const running = this.list().filter((snapshot) => snapshot.status === "running");
		if (running.length >= MAX_RUNNING) {
			return {
				status: "at_capacity",
				capacity: MAX_RUNNING,
				runningCount: running.length,
				running: running.map((snapshot) => ({ id: snapshot.id, title: snapshot.title, status: snapshot.status, ageMs: Date.now() - snapshot.createdAt })),
				retryHint: "wait for a running subagent to settle, then retry subagent_spawn",
			};
		}

		const id = `sa-${this.nextId++}`;
		const controller = new AbortController();
		const child = this.backendFactory({ ...task, id, signal: controller.signal });
		const snapshot = makeInitialSnapshot(task, id, child.sessionFilePath);
		this.snapshots.set(id, snapshot);
		this.children.set(id, { child, controller });
		this.consumeEvents(id, child.events);
		this.notify();
		this.prune();
		// A backend can settle synchronously (e.g. invalid model override emits
		// run-settled without spawning); consumeEvents has already folded that
		// into the map, so return the post-fold snapshot rather than the stale
		// "running" one — callers must not report "Started" for a dead child.
		return this.snapshots.get(id) ?? snapshot;
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
				this.fold(id, { kind: "run-settled", outcome: { kind: "interrupted", partialText: this.snapshots.get(id)?.finalText || this.snapshots.get(id)?.liveText } });
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
		const current = this.snapshots.get(id);
		if (!current) return;
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
		else if (event.kind === "run-settled") {
			if (event.outcome.kind === "completed") next = { ...current, status: "done", settledAt: Date.now(), finalText: event.outcome.finalText || current.finalText, liveText: "" };
			else if (event.outcome.kind === "failed") next = { ...current, status: "error", settledAt: Date.now(), errorText: event.outcome.errorText.slice(0, ERROR_TEXT_MAX), finalText: event.outcome.partialText ?? current.finalText, liveText: "" };
			else next = { ...current, status: "error", settledAt: Date.now(), errorText: "interrupted", finalText: event.outcome.partialText ?? current.finalText, liveText: "" };
			this.children.delete(id);
			if ((this.waitInterest.get(id) ?? 0) > 0) this.consumedIds.add(id);
		}
		this.snapshots.set(id, next);
		this.notify();
		this.prune();
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
