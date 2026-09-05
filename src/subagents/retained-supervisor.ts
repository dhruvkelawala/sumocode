import { randomUUID } from "node:crypto";
import { systemProcessTree, type ProcessTreeOperations } from "../background-tasks/process-tree.js";
import { spawnPiChild, type HeadlessLaunchGate, type SpawnedChild } from "./backend-pi.js";
import type { RunOutcome, SubagentEvent } from "./domain.js";
import { buildCompletionManifest, type CompletionManifestEvidence } from "./manifest.js";
import { RetainedResults } from "./retained-results.js";
import { SubagentRegistry, type RegistryProcess, type SubagentRecord } from "./registry.js";

/** Launch admission only. Callers must retain their backend even when ready rejects. */
export function createRetainedHeadlessLaunchGate(
	registry: SubagentRegistry,
	initial: SubagentRecord,
	supervisorEvidence: RegistryProcess,
	operations: ProcessTreeOperations = systemProcessTree,
): HeadlessLaunchGate {
	return prepareLaunch(registry, initial, supervisorEvidence, operations).gate;
}

function prepareLaunch(
	registry: SubagentRegistry,
	initial: SubagentRecord,
	supervisorEvidence: RegistryProcess,
	operations: ProcessTreeOperations,
) {
	const supervisor = structuredClone(supervisorEvidence);
	if (initial.backend !== "headless" || initial.status !== "starting" || supervisor.identity.pid !== process.pid
		|| supervisor.identity.processGroupId !== process.pid) {
		throw new Error("retained launch requires a starting headless record and this supervisor");
	}
	const assertLive = (tree: RegistryProcess): void => {
		if (operations.identityMatches(tree.identity) !== "same"
			|| operations.verificationMatches?.(tree.identity, tree.verification) !== "same") {
			throw new Error("retained launch identity is ambiguous");
		}
	};
	assertLive(supervisor);
	let current = registry.create(initial);
	current = registry.acquireWriter(current.id, current.revision, 60_000);
	let lease = current.writerLease!;
	if (lease.owner.pid !== supervisor.identity.pid || !supervisor.verification.members.some((member) =>
		member.pid === lease.owner.pid && member.processStartTime === lease.owner.processStartTime)) {
		throw new Error("retained writer does not identify this supervisor");
	}
	const transition = (update: (record: SubagentRecord) => SubagentRecord): void => {
		current = registry.transition(current.id, current.revision, lease.generation, update);
	};
	transition((record) => ({ ...record, supervisor }));
	let phase: "prepared" | "admitted" | "blocked" | "released" = "prepared";

	const fence = (): void => {
		assertLive(supervisor);
		// A no-op metadata CAS checks revision, generation, token, birth and live
		// lease after potentially slow OS inspection, immediately before return.
		transition((record) => record);
	};

	const gate: HeadlessLaunchGate = {
		beforeSpawn(): void {
			if (phase !== "prepared") throw new Error("retained spawn gate already used");
			phase = "blocked";
			fence();
			phase = "admitted";
		},
		beforePrompt(pid: number): void {
			if (phase !== "admitted") throw new Error("retained prompt gate unavailable");
			phase = "blocked";
			fence();
			if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid retained child pid");
			const processStartTime = operations.captureStartTime(pid);
			if (!processStartTime) throw new Error("retained child birth unavailable");
			const identity = { pid, processGroupId: pid, processStartTime };
			const verification = operations.captureTreeVerification?.(identity);
			if (!verification) throw new Error("retained child anchors unavailable");
			const child = { identity, verification };
			transition((record) => ({ ...record, child }));
			assertLive(child);
			assertLive(supervisor);
			transition((record) => ({ ...record, status: "running" }));
			phase = "released";
		},
	};
	return {
		gate, fence, transition,
		record: () => structuredClone(current),
		released: () => phase === "released",
		renew: (): void => {
			fence();
			current = registry.acquireWriter(current.id, current.revision, 60_000);
			lease = current.writerLease!;
		},
	};
}

interface RetainedHeadlessOptions {
	readonly registry: SubagentRegistry;
	readonly initial: SubagentRecord;
	readonly supervisor: RegistryProcess;
	readonly launch: Omit<Parameters<typeof spawnPiChild>[0], "launchGate" | "signal">;
	readonly baseRef: string;
}

interface RetainedHeadlessDependencies {
	readonly operations?: ProcessTreeOperations;
	readonly spawn?: typeof spawnPiChild;
	readonly buildManifest?: typeof buildCompletionManifest;
}

type Settlement = "settled" | "lost" | "ambiguous";

/**
 * One backend/parser owner, with read-only observers and durable settlement.
 * No controls, delivery, disposal or adoption: the process entry must heartbeat
 * this owner and account for its death before enabling production retention.
 */
export class RetainedHeadlessSupervisor {
	private readonly authority: ReturnType<typeof prepareLaunch>;
	private readonly artifacts: RetainedResults;
	private readonly child: SpawnedChild;
	private readonly cwd: string;
	private readonly baseRef: string;
	private readonly listeners = new Set<(record: SubagentRecord) => void>();
	private terminal = false;
	private stopped = false;
	private finish!: (state: Settlement) => void;
	/** Local verdict; disk/lease failure can leave the last durable record unchanged. */
	public readonly settlement = new Promise<Settlement>((resolve) => { this.finish = resolve; });
	private acceptReady!: () => void;
	private refuseReady!: (error: Error) => void;
	public readonly ready = new Promise<void>((resolve, reject) => { this.acceptReady = resolve; this.refuseReady = reject; });

	public constructor(options: RetainedHeadlessOptions, private readonly dependencies: RetainedHeadlessDependencies = {}) {
		this.cwd = options.launch.cwd;
		this.baseRef = options.baseRef;
		this.authority = prepareLaunch(options.registry, options.initial, options.supervisor, dependencies.operations ?? systemProcessTree);
		this.artifacts = new RetainedResults(options.initial.taskDir);
		this.child = (dependencies.spawn ?? spawnPiChild)({
			...options.launch, signal: undefined,
			launchGate: {
				beforeSpawn: () => {
					if (this.stopped) throw new Error("retained owner stopped before spawn");
					this.authority.gate.beforeSpawn();
				},
				beforePrompt: (pid) => {
					if (this.stopped) throw new Error("retained owner stopped before release");
					this.authority.gate.beforePrompt(pid);
				},
			},
		});
		// Own the handle before subscription (which can synchronously settle).
		let subscriptionError: Error | undefined;
		try {
			const events = this.child.events;
			if (Symbol.asyncIterator in events) {
				void this.consume(events);
			} else events((event) => this.observe(event));
		} catch {
			subscriptionError = new Error("retained event subscription failed");
			this.fail("ambiguous");
		}
		void (subscriptionError ? Promise.reject(subscriptionError) : Promise.resolve(this.child.ready)).then(() => {
			if (!this.authority.released()) throw new Error("child not ready for prompt release");
			this.acceptReady();
		}).catch((error: Error) => {
			// Ready refusal is not child exit. Keep the parser for its later outcome.
			if (!this.terminal && !this.stopped) this.markUncertain("ambiguous");
			this.refuseReady(error);
		});
		void this.ready.catch(() => undefined);
	}

	public subscribe(listener: (record: SubagentRecord) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	/** Renewal cannot revive a locally failed owner or retry an expired operation. */
	public renew(): void {
		if (this.stopped) throw new Error("retained owner stopped");
		try { this.authority.renew(); }
		catch (error) { this.fail("ambiguous"); throw error; }
	}

	private async consume(events: AsyncIterable<SubagentEvent>): Promise<void> {
		try {
			for await (const event of events) this.observe(event);
			if (!this.terminal) this.fail("lost");
		} catch { this.fail("lost"); }
	}

	private observe(event: SubagentEvent): void {
		if (this.terminal || this.stopped) return;
		try {
			this.authority.fence();
			this.artifacts.append(event);
			if (event.kind === "run-settled") {
				this.terminal = true;
				void this.settle(event.outcome);
			} else this.notify();
		} catch { this.fail("ambiguous"); }
	}

	private async settle(outcome: RunOutcome): Promise<void> {
		try {
			if (outcome.kind === "completed") {
				await this.ready;
				if (!this.authority.released()) throw new Error("completion before release");
			}
			if (this.stopped) return;
			const record = this.authority.record();
			this.authority.transition((r) => ({ ...r, status: r.child ? "settling" : "ambiguous", outcome: outcome.kind }));
			const result = this.artifacts.writeResult(outcome);
			const fallback: CompletionManifestEvidence = { exit: outcome.kind, durationMs: Math.max(0, Date.now() - record.createdAt) };
			let manifest = fallback;
			if (record.child) {
				try {
					manifest = await (this.dependencies.buildManifest ?? buildCompletionManifest)({
						cwd: this.cwd,
						baseRef: record.worktree?.baseRef ?? this.baseRef,
						worktree: record.worktree ?? undefined,
						outcome: result.outcome, startedAt: record.createdAt,
					});
				} catch { /* Missing host git evidence is partial, not a different outcome. */ }
			}
			if (this.stopped) return;
			this.authority.fence();
			const manifestPointer = this.artifacts.writeManifest({ ...manifest, exit: outcome.kind });
			this.artifacts.verify();
			// The registry validates both private artifacts before publishing pointers.
			this.authority.fence();
			const completed = this.authority.record();
			const completionId = randomUUID();
			this.authority.transition((r) => ({
				...r, status: "settled", settledAt: completed.updatedAt, completionId,
				result: result.pointer, manifest: manifestPointer, delivery: { state: "pending", claim: null },
			}));
			this.stopped = true;
			this.finish("settled");
			this.notify();
		} catch { this.fail("ambiguous"); }
	}

	private markUncertain(status: "lost" | "ambiguous"): void {
		try {
			this.authority.fence();
			this.authority.transition((record) => ({ ...record, status }));
			this.notify();
		} catch {
			// Lost lease/corrupt disk cannot be repaired by this writer. Preserve the
			// last record and all artifacts for later explicit reconciliation.
		}
	}

	private fail(status: "lost" | "ambiguous"): void {
		if (this.stopped) return;
		this.stopped = true;
		this.markUncertain(status);
		this.finish(status);
	}

	private notify(): void {
		for (const listener of this.listeners) {
			try { void Promise.resolve(listener(this.authority.record())).catch(() => undefined); }
			catch { /* Observers cannot break the parser or durable settlement. */ }
		}
	}
}
