import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { systemProcessTree, type ProcessTreeOperations } from "../background-tasks/process-tree.js";
import { spawnPiChild, type HeadlessLaunchGate, type SpawnedChild } from "./backend-pi.js";
import type { RunOutcome, SubagentEvent } from "./domain.js";
import { buildCompletionManifest, type CompletionManifestEvidence } from "./manifest.js";
import { RetainedResults } from "./retained-results.js";
import { addReportedSubagentUsage } from "./budget-policy.js";
import { SubagentRegistry, SubagentRevisionConflict, type RegistryControlAuthority, type RegistryControlSuccessor, type RegistryProcess, type SubagentRecord } from "./registry.js";

/** Persistence-owner gate only, not user control authorization. Retain refused handles. */
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
	attach = false,
) {
	const id = initial.id;
	const supervisor = structuredClone(supervisorEvidence);
	if (initial.backend !== "headless" || initial.status !== "starting" || supervisor.identity.pid !== process.pid
		|| supervisor.identity.processGroupId !== process.pid) {
		throw new Error("retained launch requires a starting headless record and this supervisor");
	}
	const assertLive = (tree: RegistryProcess): void => {
		// A descendant cannot vouch for a replaced or moved live group leader.
		const root = tree.verification.members.find((member) => member.pid === tree.identity.pid);
		if (!root || operations.identityMatches(tree.identity) !== "same"
			|| operations.verificationMatches?.(tree.identity, { members: [root] }) !== "same") {
			throw new Error("retained launch identity is ambiguous");
		}
	};
	assertLive(supervisor);
	const candidate = attach ? registry.get(id) : registry.create(initial);
	if (!candidate || !isDeepStrictEqual(candidate, initial) || candidate.status !== "starting"
		|| candidate.writerLease !== null || candidate.supervisor !== null || candidate.child !== null) {
		throw new Error("retained attach requires the matching unowned starting record");
	}
	let current = registry.acquireWriter(candidate.id, candidate.revision, 60_000);
	let lease = current.writerLease!;
	if (lease.owner.pid !== supervisor.identity.pid || !supervisor.verification.members.some((member) =>
		member.pid === lease.owner.pid && member.processStartTime === lease.owner.processStartTime)) {
		throw new Error("retained writer does not identify this supervisor");
	}
	const transition = (update: (record: SubagentRecord) => SubagentRecord): void => {
		// Retry only metadata conflicts, never OS inspection or child effects. Keep
		// our generation pinned: another acquisition is not our heartbeat.
		for (let attempt = 0; ; attempt++) {
			const fresh = registry.get(id);
			if (!fresh) throw new Error("missing retained record");
			try {
				current = registry.transition(fresh.id, fresh.revision, lease.generation, update);
				return;
			} catch (error) {
				if (!(error instanceof SubagentRevisionConflict) || attempt >= 2) throw error;
			}
		}
	};
	transition((record) => ({ ...record, supervisor }));
	let phase: "prepared" | "admitted" | "blocked" | "released" = "prepared";

	const fence = (): void => {
		assertLive(supervisor);
		// A no-op metadata CAS checks revision, generation, token, birth and live
		// lease after potentially slow OS inspection, immediately before return.
		transition((record) => record);
	};

	const childFence = (pid: number): RegistryProcess => {
		if (phase !== "released" || current.child?.identity.pid !== pid) throw new Error("retained child authority unavailable");
		const child = structuredClone(current.child);
		assertLive(child);
		fence();
		return child;
	};
	const gate: HeadlessLaunchGate = {
		beforeStdin: (pid) => { childFence(pid); },
		beforeSignal: childFence,
		onRefused: () => { phase = "blocked"; },
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
			const captured = operations.captureTreeVerification?.(identity);
			const root = captured?.members.find((member) => member.pid === pid);
			if (!root) throw new Error("retained child anchors unavailable");
			// child identifies the execution group anchor; the backend binds the
			// actual Pi PID/birth separately to its private factory receipt.
			const child = { identity, verification: { members: [root] } };
			transition((record) => ({ ...record, child }));
			assertLive(child);
			assertLive(supervisor);
			transition((record) => ({ ...record, status: "running", telemetry: { ...record.telemetry, startedAt: record.updatedAt, lastProgressAt: record.telemetry?.lastProgressAt ?? null } }));
			phase = "released";
		},
	};
	return {
		gate, fence, transition, verifyChild: childFence,
		record: () => structuredClone(current),
		released: () => phase === "released",
		renew: (): void => {
			fence();
			for (let attempt = 0; ; attempt++) {
				try {
					current = registry.acquireWriter(current.id, current.revision, 60_000);
					if (current.writerLease!.renewedAt >= lease.expiresAt) throw new Error("retained renewal missed deadline");
					lease = current.writerLease!;
					return;
				} catch (error) {
					if (!(error instanceof SubagentRevisionConflict) || attempt >= 2) throw error;
					transition((record) => record);
				}
			}
		},
	};
}

interface RetainedHeadlessOptions {
	readonly registry: SubagentRegistry;
	readonly initial: SubagentRecord;
	readonly supervisor: RegistryProcess;
	/** Explicit attach only; cwd must come from the validated private bootstrap,
	 * not request payloads. Registry metadata has no non-worktree cwd field. */
	readonly attach?: { readonly cwd: string };
	readonly launch: Omit<Parameters<typeof spawnPiChild>[0], "launchGate" | "signal">;
	readonly baseRef: string;
	/** Source process entry must stay alive through asynchronous settlement. */
	readonly keepAlive?: boolean;
}

interface RetainedHeadlessDependencies {
	readonly operations?: ProcessTreeOperations;
	readonly spawn?: typeof spawnPiChild;
	readonly buildManifest?: typeof buildCompletionManifest;
}

type Settlement = "settled" | "lost" | "ambiguous";

/**
 * One backend/parser owner, with read-only observers and durable settlement.
 * Owns the backend and heartbeat; managers own control leases and delivery.
 * The process entry must account for its death before enabling retention.
 */
export class RetainedHeadlessSupervisor {
	private readonly authority: ReturnType<typeof prepareLaunch>;
	private readonly registry: SubagentRegistry;
	private readonly artifacts: RetainedResults;
	private readonly child: SpawnedChild;
	private readonly cwd: string;
	private readonly baseRef: string;
	private readonly listeners = new Set<(record: SubagentRecord) => void>();
	private completed?: { outcome: RunOutcome; manifest: CompletionManifestEvidence };
	private terminal = false;
	private stopped = false;
	private heartbeat?: ReturnType<typeof setInterval>;
	private finish!: (state: Settlement) => void;
	/** Local verdict; disk/lease failure can leave the last durable record unchanged. */
	public readonly settlement = new Promise<Settlement>((resolve) => { this.finish = resolve; });
	private acceptReady!: () => void;
	private refuseReady!: (error: Error) => void;
	public readonly ready = new Promise<void>((resolve, reject) => { this.acceptReady = resolve; this.refuseReady = reject; });

	public constructor(options: RetainedHeadlessOptions, private readonly dependencies: RetainedHeadlessDependencies = {}) {
		if (options.attach && (options.attach.cwd !== options.launch.cwd
			|| realpathSync(options.attach.cwd) !== options.attach.cwd || !statSync(options.attach.cwd).isDirectory()
			|| (options.initial.worktree !== null && options.initial.worktree.path !== options.attach.cwd))) {
			throw new Error("retained cwd binding mismatch");
		}
		this.registry = options.registry;
		this.cwd = options.launch.cwd;
		this.baseRef = options.baseRef;
		this.authority = prepareLaunch(options.registry, options.initial, options.supervisor, dependencies.operations ?? systemProcessTree, options.attach !== undefined);
		this.artifacts = new RetainedResults(options.initial.taskDir);
		this.child = (dependencies.spawn ?? spawnPiChild)({
			...options.launch, signal: undefined,
			launchGate: {
				beforeStdin: (pid) => {
					if (this.stopped) throw new Error("retained owner stopped before stdin");
					this.authority.gate.beforeStdin(pid);
				},
				beforeSignal: (pid) => {
					if (this.stopped) throw new Error("retained owner stopped before signal");
					return this.authority.gate.beforeSignal(pid);
				},
				onRefused: () => { this.authority.gate.onRefused(); this.fail("ambiguous"); },
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
		this.heartbeat = setInterval(() => {
			try { this.renew(); } catch { /* renew records authority loss locally. */ }
		}, 20_000);
		if (!options.keepAlive) this.heartbeat.unref();
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
			if (this.stopped || !this.authority.released()) throw new Error("child not ready for prompt release");
			this.acceptReady();
		}).catch((error: Error) => {
			// Ready refusal is not child exit. Retain the handle for accounting,
			// but a stopped owner cannot publish a later outcome.
			if (!this.terminal && !this.stopped) this.fail("ambiguous");
			this.refuseReady(error);
		});
		void this.ready.catch(() => undefined);
	}

	public get record(): SubagentRecord { return this.registry.get(this.authority.record().id)!; }
	public get completion(): { outcome: RunOutcome; manifest: CompletionManifestEvidence } | undefined {
		return this.completed && structuredClone(this.completed);
	}

	/** Manager views share this handle; only the supervisor subscribes to its parser. */
	public controllerChild(authority: RegistryControlAuthority): SpawnedChild {
		const fence = (): void => {
			if (!this.registry.inspectControl(authority)) throw new Error("retained control refused");
			const record = this.record;
			if (!record.child || this.stopped) throw new Error("retained child unavailable");
			this.authority.verifyChild(record.child.identity.pid);
			if (!this.registry.inspectControl(authority)) throw new Error("retained control changed");
		};
		return {
			retained: { registry: this.registry.forController(authority.owner), supervisor: this, authority },
			ready: this.ready,
			events: () => undefined,
			interrupt: () => { fence(); this.child.interrupt(); },
			send: this.child.send ? async (text) => { fence(); await this.child.send!(text); } : undefined,
			requestClose: this.child.requestClose ? () => { fence(); this.child.requestClose!(); } : undefined,
		};
	}

	/** Cooperative outgoing-controller request. Persistence ownership never moves. */
	public reserveControl(authority: RegistryControlAuthority, successor: RegistryControlSuccessor): SubagentRecord {
		if ((this.stopped || this.terminal) && !this.completed) throw new Error("retained owner unavailable for transfer");
		const record = this.authority.record();
		if (!record.child) throw new Error("retained child unavailable for transfer");
		try { this.authority.verifyChild(record.child.identity.pid); }
		catch (error) { this.fail("ambiguous"); throw error; }
		const fresh = this.authority.record();
		return this.registry.reserveControl(fresh.revision, authority, `${record.id}:${authority.head + 1}`, {
			...successor, writerGeneration: fresh.writerLease!.generation,
		});
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
			if (!["run-started", "run-settled", "pane-attached", "heartbeat"].includes(event.kind)) {
				this.authority.transition((record) => {
					const telemetry = { ...record.telemetry, startedAt: record.telemetry?.startedAt ?? null, lastProgressAt: record.updatedAt };
					return { ...record, telemetry: event.kind === "usage" ? {
						...telemetry,
						reportedTokens: addReportedSubagentUsage(telemetry.reportedTokens, event.tokens),
						reportedCostUsd: addReportedSubagentUsage(telemetry.reportedCostUsd, event.costUsd),
					} : telemetry };
				});
			}
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
				result: result.pointer, manifest: manifestPointer, delivery: { state: "undelivered" },
			}));
			this.completed = structuredClone({ outcome: result.outcome, manifest: { ...manifest, exit: outcome.kind } });
			this.stopped = true;
			clearInterval(this.heartbeat);
			this.finish("settled");
			this.notify();
			this.listeners.clear();
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
		clearInterval(this.heartbeat);
		this.markUncertain(status);
		this.finish(status);
		this.listeners.clear();
	}

	private notify(): void {
		for (const listener of this.listeners) {
			try { void Promise.resolve(listener(this.authority.record())).catch(() => undefined); }
			catch { /* Observers cannot break the parser or durable settlement. */ }
		}
	}
}
