// oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening -- this harness intentionally casts partial test doubles with `as never` instead of restating full runtime contracts.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalTaskManager, type TerminalOutputTail } from "../background-tasks/task-manager.js";
import { TerminalTaskStore, type TerminalTaskIndexRefreshResult } from "../background-tasks/task-store.js";
import { terminalActivitySnapshot, type TerminalTaskSnapshot } from "../background-tasks/task-types.js";
import type { SubagentSnapshot } from "../subagents/domain.js";
import { ACTIVITY_SETTLED_RETENTION_COUNT, ACTIVITY_SETTLED_RETENTION_MS, ActivityFeedPublisher, type ActivityFeedDiagnostic, type ActivityFeedPublisherOptions } from "./feed-publisher.js";
import { activityPaths } from "./persistence.js";
import { ActivityManagerBridge, installActivityManagerBridge } from "./manager-bridge.js";

const roots: string[] = [];

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "sumocode-manager-bridge-"));
	roots.push(path);
	return path;
}

function fixturePublisher(ownerSessionId: string, options: ActivityFeedPublisherOptions = {}): ActivityFeedPublisher {
	return new ActivityFeedPublisher(ownerSessionId, { ...options, allowUnleasedWritesForTests: true });
}

/** A process-global-shaped ownership stub shared across bridges in one test. */
function sharedSessionOwnership(owned: () => readonly string[]) {
	const claims = new Map<string, string>();
	return {
		claims,
		ownership: {
			ownedSessionIds: owned,
			claim: (owner: string, token: string): boolean => {
				const current = claims.get(owner);
				if (current !== undefined && current !== token) return false;
				claims.set(owner, token);
				return true;
			},
			release: (owner: string, token: string): void => {
				if (claims.get(owner) === token) claims.delete(owner);
			},
		},
	};
}

function runBridgeContender(
	stateRoot: string,
	terminalRoot: string,
	owner: string,
	ready: string,
	deathGate: string,
	takeoverGate: string,
): Promise<{ id: string; status: string; processIdentityVerified: boolean }> {
	const fixture = fileURLToPath(new URL("../../test/fixtures/activity-bridge-contender.ts", import.meta.url));
	return new Promise((resolve, reject) => {
		execFile(
			join(process.cwd(), "node_modules", ".bin", "jiti"),
			[fixture, stateRoot, terminalRoot, owner, ready, deathGate, takeoverGate],
			{ timeout: 15_000 },
			(error, stdout, stderr) => {
				if (error) reject(new Error(`Activity bridge contender failed: ${stderr || error.message}`));
				else {
					// SAFETY: the contender script prints exactly this JSON envelope on success.
					const parsed = JSON.parse(stdout.trim()) as { id: string; status: string; processIdentityVerified: boolean };
					resolve(parsed);
				}
			},
		);
	});
}

function terminal(id: string, ownerSessionId: string, status: "running" | "completed" = "running"): TerminalTaskSnapshot {
	const base = {
		schemaVersion: 4,
		revision: 1,
		id,
		ownerSessionId,
		command: "printf hello",
		cwd: "/tmp",
		title: id,
		completionPolicy: "passive" as const,
		createdAt: 1_000,
		logFile: `/tmp/${id}.log`,
	};
	if (status === "running") {
		return { ...base, status, updatedAt: 1_000, deliveryState: "none", pid: 1, processGroupId: 1, processStartTime: "start" };
	}
	return {
		...base,
		status,
		updatedAt: 2_000,
		settledAt: 2_000,
		exitCode: 0,
		deliveryState: "suppressed",
		completionId: `completion-${id}`,
		observedAt: 2_000,
	};
}

function persistSettledTerminal(store: TerminalTaskStore, id: string, ownerSessionId: string, createdAt: number): TerminalTaskSnapshot {
	const directory = join(store.rootDir, `${id}-${createdAt}`);
	mkdirSync(directory, { mode: 0o700 });
	chmodSync(directory, 0o700);
	const logFile = join(directory, "output.log");
	writeFileSync(logFile, "", { mode: 0o600 });
	chmodSync(logFile, 0o600);
	const snapshot: TerminalTaskSnapshot = {
		schemaVersion: 4,
		revision: 1,
		id,
		ownerSessionId,
		command: "printf hello",
		cwd: "/tmp",
		title: id,
		status: "completed",
		completionPolicy: "passive",
		createdAt,
		updatedAt: createdAt,
		settledAt: createdAt,
		exitCode: 0,
		observedAt: createdAt,
		deliveryState: "suppressed",
		completionId: `completion-${id}`,
		logFile,
	};
	const metaFile = join(directory, "meta.json");
	writeFileSync(metaFile, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
	chmodSync(metaFile, 0o600);
	return snapshot;
}

function subagent(id: string, status: SubagentSnapshot["status"] = "running"): SubagentSnapshot {
	const snapshot = {
		id,
		title: id,
		prompt: "review the code",
		cwd: "/tmp",
		baseRef: "HEAD",
		status,
		createdAt: 1_000,
		usage: { turns: 0 },
		transcript: [] as SubagentSnapshot["transcript"],
		liveText: status === "running" ? "working" : "",
		liveTools: [],
		finalText: status === "done" ? "done" : "",
	} as SubagentSnapshot;
	// SAFETY: the fixture is a complete SubagentSnapshot literal; the cast only widens the mutable-literal type.
	if (status !== "running") (snapshot as { settledAt?: number }).settledAt = 2_000;
	if (status === "error") (snapshot as { errorText?: string }).errorText = "failed";
	return snapshot;
}

class FakeTerminalManager {
	public snapshots: TerminalTaskSnapshot[] = [];
	public refreshedSnapshots: TerminalTaskSnapshot[] | undefined;
	public refreshCount = 0;
	/** Programmed refresh outcome: false models a transient store-read failure. */
	public refreshOk = true;
	public outputs = new Map<string, string>();
	public outputBytes = new Map<string, Uint8Array>();
	public outputReads = new Map<string, number>();
	private listener: ((snapshots: readonly TerminalTaskSnapshot[]) => void) | undefined;

	public subscribeChanges(listener: (snapshots: readonly TerminalTaskSnapshot[]) => void): () => void {
		this.listener = listener;
		listener(this.snapshots);
		return () => { this.listener = undefined; };
	}

	public refreshSnapshotsFromStore(): TerminalTaskIndexRefreshResult {
		this.refreshCount += 1;
		if (!this.refreshOk) return { ok: false, snapshots: [] };
		this.snapshots = this.refreshedSnapshots ?? this.snapshots;
		// Mirror the real manager's single post-loop fan-out: the stored projection
		// listener is invoked during refresh, so the bridge's re-entrancy guard is
		// actually exercised instead of the coalesced-refresh assertions passing
		// vacuously.
		this.emit();
		return { ok: true, snapshots: this.snapshots };
	}

	public getOutput(task: Pick<TerminalTaskSnapshot, "logFile">): string {
		this.noteOutputRead(task.logFile);
		return this.outputs.get(task.logFile) ?? "";
	}

	public getOutputTailBytes(task: Pick<TerminalTaskSnapshot, "logFile">, maxBytes = Number.MAX_SAFE_INTEGER): TerminalOutputTail {
		this.noteOutputRead(task.logFile);
		const full = this.outputBytes.get(task.logFile) ?? Buffer.from(this.outputs.get(task.logFile) ?? "", "utf8");
		const start = Math.max(0, full.byteLength - maxBytes);
		return { bytes: full.subarray(start), truncated: start > 0 };
	}

	public getOutputBytes(task: Pick<TerminalTaskSnapshot, "logFile">): Uint8Array {
		return this.getOutputTailBytes(task).bytes;
	}

	private noteOutputRead(path: string): void {
		this.outputReads.set(path, (this.outputReads.get(path) ?? 0) + 1);
	}

	public emit(): void {
		this.listener?.(this.snapshots);
	}
}

class FakeSubagentManager {
	public snapshots: SubagentSnapshot[] = [];
	private listener: (() => void) | undefined;
	public list(): SubagentSnapshot[] { return [...this.snapshots]; }
	public addChangeListener(listener: () => void): () => void {
		this.listener = listener;
		return () => { this.listener = undefined; };
	}
	public emit(): void { this.listener?.(); }
}

afterEach(() => {
	vi.useRealTimers();
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("ActivityManagerBridge", () => {
	it("preserves unproven retained work and projects only an explicitly owned session", () => {
		const stateRoot = root();
		fixturePublisher("session-a", { rootDir: stateRoot, now: () => 1_500 }).publish([
			{ id: "subagent:stale", kind: "subagent", title: "stale", status: "running", ownerSessionId: "session-a", createdAt: 500 },
			{ id: "settled-old", kind: "subagent", title: "old", status: "succeeded", ownerSessionId: "session-a", createdAt: 400, settledAt: 600 },
		]);
		const terminals = new FakeTerminalManager();
		terminals.snapshots = [{ ...terminal("term-a", "session-a"), sourceId: "terminal-start-call" }];
		terminals.outputs.set("/tmp/term-a.log", "hello");
		const bridge = new ActivityManagerBridge(terminals, new FakeSubagentManager(), { rootDir: stateRoot, now: () => 2_000 });
		bridge.bindSession("session-a");
		const feed = fixturePublisher("session-a", { rootDir: stateRoot }).getSnapshot();
		expect(feed).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "subagent:stale", status: "running" }),
			expect.objectContaining({ id: "settled-old", status: "succeeded" }),
			expect.objectContaining({ id: "term-a", sourceId: "terminal-start-call", status: "running", outputTail: "hello" }),
		]));
		bridge.dispose();
	});

	it("never marks another live process's subagent lost and reconciles only after writer death", () => {
		const stateRoot = root();
		const originalWriter = { token: "writer-a", pid: 101, processStartTime: "start-a" };
		const original = fixturePublisher("session-a", {
			rootDir: stateRoot,
			writerIdentity: originalWriter,
			inspectWriter: () => "alive",
		});
		original.publish([{ id: "subagent:remote", kind: "subagent", title: "remote", status: "running", createdAt: 1_000 }]);

		let originalWriterAlive = true;
		const contenderTerminals = new FakeTerminalManager();
		const liveContender = new ActivityManagerBridge(contenderTerminals, new FakeSubagentManager(), {
			rootDir: stateRoot,
			writerIdentity: { token: "writer-b", pid: 202, processStartTime: "start-b" },
			inspectWriter: () => originalWriterAlive ? "alive" : "dead",
			now: () => 2_000,
		});
		liveContender.bindSession("session-a");
		expect(fixturePublisher("session-a", { rootDir: stateRoot }).getSnapshot()).toMatchObject([
			{ id: "subagent:remote", status: "running" },
		]);

		originalWriterAlive = false;
		liveContender.bindSession("session-a");
		expect(contenderTerminals.refreshCount).toBe(1);
		expect(fixturePublisher("session-a", { rootDir: stateRoot }).getSnapshot()).toMatchObject([
			{ id: "subagent:remote", status: "lost", settledAt: 2_000 },
		]);

		contenderTerminals.snapshots = [terminal("replacement-owned", "session-a")];
		contenderTerminals.emit();
		contenderTerminals.snapshots = [];
		contenderTerminals.emit();
		expect(fixturePublisher("session-a", { rootDir: stateRoot }).getSnapshot()).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "replacement-owned", status: "running" }),
		]));
		liveContender.dispose();
	});

	it("refreshes exactly once after a proven empty-feed writer takeover", () => {
		const stateRoot = root();
		const incumbent = new ActivityFeedPublisher("session-empty-takeover", {
			rootDir: stateRoot,
			writerIdentity: { token: "incumbent", pid: 101, processStartTime: "incumbent-start" },
			inspectWriter: () => "alive",
		});
		incumbent.publish([]);
		let incumbentAlive = true;
		const terminals = new FakeTerminalManager();
		terminals.refreshedSnapshots = [terminal("term-after-empty-feed", "session-empty-takeover")];
		terminals.outputs.set("/tmp/term-after-empty-feed.log", "late output");
		const proofAtClaim: boolean[] = [];
		const created: ActivityFeedPublisher[] = [];
		const bridge = new ActivityManagerBridge(terminals, new FakeSubagentManager(), {
			rootDir: stateRoot,
			writerIdentity: { token: "contender", pid: 202, processStartTime: "contender-start" },
			inspectWriter: () => incumbentAlive ? "alive" : "dead",
			publisherFactory: (owner) => {
				const publisher = new ActivityFeedPublisher(owner, {
					rootDir: stateRoot,
					writerIdentity: { token: "contender", pid: 202, processStartTime: "contender-start" },
					inspectWriter: () => incumbentAlive ? "alive" : "dead",
				});
				proofAtClaim.push(publisher.writerDeathProven);
				created.push(publisher);
				return publisher;
			},
		});

		bridge.bindSession("session-empty-takeover");
		expect(terminals.refreshCount).toBe(0);
		incumbentAlive = false;
		bridge.bindSession("session-empty-takeover");

		expect(terminals.refreshCount).toBe(1);
		expect(fixturePublisher("session-empty-takeover", { rootDir: stateRoot }).getSnapshot()).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "term-after-empty-feed", status: "running" }),
		]));
		// The takeover proof was real and is consumed by the first successful
		// publication even though the feed had no abandoned running producers.
		expect(proofAtClaim).toEqual([false, false, true]);
		expect(created.at(-1)!.writerDeathProven).toBe(false);
		bridge.bindSession("session-empty-takeover");
		expect(terminals.refreshCount).toBe(1);
		bridge.dispose();
	});

	it("coalesces a multi-owner death-proven takeover into exactly one store refresh", () => {
		const stateRoot = root();
		const incumbentA = new ActivityFeedPublisher("session-multi-a", {
			rootDir: stateRoot,
			writerIdentity: { token: "writer-a", pid: 101, processStartTime: "start-a" },
			inspectWriter: () => "alive",
		});
		incumbentA.publish([{ id: "held-a", kind: "subagent", title: "held-a", status: "running", createdAt: 1_000 }]);
		const incumbentB = new ActivityFeedPublisher("session-multi-b", {
			rootDir: stateRoot,
			writerIdentity: { token: "writer-b", pid: 102, processStartTime: "start-b" },
			inspectWriter: () => "alive",
		});
		incumbentB.publish([]);
		let incumbentsAlive = true;
		const terminals = new FakeTerminalManager();
		terminals.refreshedSnapshots = [terminal("term-multi-a", "session-multi-a"), terminal("term-multi-b", "session-multi-b")];
		terminals.outputs.set("/tmp/term-multi-a.log", "a output");
		terminals.outputs.set("/tmp/term-multi-b.log", "b output");
		const bridge = new ActivityManagerBridge(terminals, new FakeSubagentManager(), {
			rootDir: stateRoot,
			writerIdentity: { token: "contender", pid: 202, processStartTime: "contender-start" },
			inspectWriter: () => incumbentsAlive ? "alive" : "dead",
		});

		// Live incumbents and unproven claims authorize no refresh.
		bridge.bindSession("session-multi-a");
		bridge.bindSession("session-multi-b");
		expect(terminals.refreshCount).toBe(0);

		// Both writers die; one sync pass claims both owners and refreshes once.
		incumbentsAlive = false;
		bridge.bindSession("session-multi-a");
		expect(terminals.refreshCount).toBe(1);
		bridge.bindSession("session-multi-b");
		expect(terminals.refreshCount).toBe(1);

		// Every owner published from the same refreshed projection.
		expect(fixturePublisher("session-multi-a", { rootDir: stateRoot }).getSnapshot()).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "term-multi-a", status: "running" }),
			expect.objectContaining({ id: "held-a", status: "lost" }),
		]));
		expect(fixturePublisher("session-multi-b", { rootDir: stateRoot }).getSnapshot()).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "term-multi-b", status: "running" }),
		]));

		// Repeat syncs never trigger a second refresh.
		bridge.bindSession("session-multi-a");
		bridge.bindSession("session-multi-b");
		expect(terminals.refreshCount).toBe(1);
		bridge.dispose();
	});

	it("retries a failed takeover refresh without claiming, publishing, or consuming the proof", () => {
		const stateRoot = root();
		const incumbent = new ActivityFeedPublisher("session-refresh-retry", {
			rootDir: stateRoot,
			writerIdentity: { token: "incumbent", pid: 101, processStartTime: "incumbent-start" },
			inspectWriter: () => "alive",
		});
		incumbent.publish([]);
		let incumbentAlive = true;
		const terminals = new FakeTerminalManager();
		// Transient store-read failure; the retry discovers a terminal created
		// between the incumbent's death and the successful refresh.
		terminals.refreshOk = false;
		terminals.refreshedSnapshots = [terminal("term-late-takeover", "session-refresh-retry")];
		terminals.outputs.set("/tmp/term-late-takeover.log", "late output");
		const created: ActivityFeedPublisher[] = [];
		let successfulPublishes = 0;
		const bridge = new ActivityManagerBridge(terminals, new FakeSubagentManager(), {
			rootDir: stateRoot,
			writerIdentity: { token: "contender", pid: 202, processStartTime: "contender-start" },
			inspectWriter: () => incumbentAlive ? "alive" : "dead",
			publisherFactory: (owner) => {
				const publisher = new ActivityFeedPublisher(owner, {
					rootDir: stateRoot,
					writerIdentity: { token: "contender", pid: 202, processStartTime: "contender-start" },
					inspectWriter: () => incumbentAlive ? "alive" : "dead",
				});
				const publish = publisher.publish.bind(publisher);
				publisher.publish = (activities) => {
					const wrote = publish(activities);
					if (wrote) successfulPublishes += 1;
					return wrote;
				};
				created.push(publisher);
				return publisher;
			},
		});

		// The bridge first sees the session while the incumbent is alive: the
		// owner is noted but its blocked publisher is discarded unclaimed.
		bridge.bindSession("session-refresh-retry");

		// Pass 1: the death-proven takeover's one global refresh fails. The owner
		// stays unclaimed and unpublished while the publisher keeps its writer
		// lease and proof so the next sync retries.
		incumbentAlive = false;
		expect(bridge.canProduceActivity("session-refresh-retry")).toBe(false);
		expect(terminals.refreshCount).toBe(1);
		const takeoverPublisher = created.at(-1)!;
		expect(takeoverPublisher.writerDeathProven).toBe(true);
		expect(successfulPublishes).toBe(0);
		expect(fixturePublisher("session-refresh-retry", { rootDir: stateRoot }).getSnapshot()).toEqual([]);

		// Pass 2: the retry succeeds, discovers the late terminal, and only then
		// claims the owner; publication consumes the proof exactly once.
		terminals.refreshOk = true;
		expect(bridge.canProduceActivity("session-refresh-retry")).toBe(true);
		expect(terminals.refreshCount).toBe(2);
		bridge.bindSession("session-refresh-retry");
		expect(terminals.refreshCount).toBe(2);
		expect(takeoverPublisher.writerDeathProven).toBe(false);
		expect(successfulPublishes).toBe(1);
		expect(fixturePublisher("session-refresh-retry", { rootDir: stateRoot }).getSnapshot()).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "term-late-takeover", status: "running", outputTail: "late output" }),
		]));

		// Settled ownership neither re-refreshes nor re-publishes.
		bridge.bindSession("session-refresh-retry");
		expect(terminals.refreshCount).toBe(2);
		expect(successfulPublishes).toBe(1);
		bridge.dispose();
	});

	it("contains an unexpected takeover-refresh throw and retries with the proof intact", () => {
		const stateRoot = root();
		const incumbent = new ActivityFeedPublisher("session-refresh-throw", {
			rootDir: stateRoot,
			writerIdentity: { token: "incumbent", pid: 101, processStartTime: "incumbent-start" },
			inspectWriter: () => "alive",
		});
		incumbent.publish([]);
		let incumbentAlive = true;
		const terminals = new FakeTerminalManager();
		terminals.refreshedSnapshots = [terminal("term-after-throw", "session-refresh-throw")];
		terminals.outputs.set("/tmp/term-after-throw.log", "late output");
		const diagnostics: ActivityFeedDiagnostic[] = [];
		const realRefresh = terminals.refreshSnapshotsFromStore.bind(terminals);
		let refreshCalls = 0;
		terminals.refreshSnapshotsFromStore = () => {
			refreshCalls += 1;
			if (refreshCalls === 1) throw new Error("injected refresh failure");
			return realRefresh();
		};
		const created: ActivityFeedPublisher[] = [];
		const bridge = new ActivityManagerBridge(terminals, new FakeSubagentManager(), {
			rootDir: stateRoot,
			writerIdentity: { token: "contender", pid: 202, processStartTime: "contender-start" },
			inspectWriter: () => incumbentAlive ? "alive" : "dead",
			onDiagnostic: (entry) => diagnostics.push(entry),
			publisherFactory: (owner) => {
				const publisher = new ActivityFeedPublisher(owner, {
					rootDir: stateRoot,
					writerIdentity: { token: "contender", pid: 202, processStartTime: "contender-start" },
					inspectWriter: () => incumbentAlive ? "alive" : "dead",
				});
				created.push(publisher);
				return publisher;
			},
		});

		// The bridge first sees the session while the incumbent is alive: the
		// owner is noted but its blocked publisher is discarded unclaimed.
		bridge.bindSession("session-refresh-throw");

		// Pass 1: the death-proven takeover's refresh throws unexpectedly. The
		// throw is contained like the explicit {ok:false} path: the owner stays
		// unclaimed and unpublished while the publisher keeps its writer lease
		// and proof so the next sync retries.
		incumbentAlive = false;
		expect(bridge.canProduceActivity("session-refresh-throw")).toBe(false);
		expect(refreshCalls).toBe(1);
		const takeoverPublisher = created.at(-1)!;
		expect(takeoverPublisher.writerDeathProven).toBe(true);
		expect(fixturePublisher("session-refresh-throw", { rootDir: stateRoot }).getSnapshot()).toEqual([]);
		expect(diagnostics.at(-1)).toMatchObject({ kind: "io", path: "session-refresh-throw" });

		// Pass 2: the retry succeeds, discovers the late terminal, claims the
		// owner, and publication consumes the proof exactly once.
		expect(bridge.canProduceActivity("session-refresh-throw")).toBe(true);
		expect(refreshCalls).toBe(2);
		bridge.bindSession("session-refresh-throw");
		expect(refreshCalls).toBe(2);
		expect(takeoverPublisher.writerDeathProven).toBe(false);
		expect(fixturePublisher("session-refresh-throw", { rootDir: stateRoot }).getSnapshot()).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "term-after-throw", status: "running", outputTail: "late output" }),
		]));
		bridge.dispose();
	});

	it("releases a pending takeover claim on dispose so a replacement bridge can claim and publish", () => {
		const stateRoot = root();
		const owner = "session-dispose-claim";
		const incumbent = new ActivityFeedPublisher(owner, {
			rootDir: stateRoot,
			writerIdentity: { token: "incumbent", pid: 101, processStartTime: "incumbent-start" },
			inspectWriter: () => "alive",
		});
		incumbent.publish([]);
		let incumbentAlive = true;
		const terminals = new FakeTerminalManager();
		terminals.refreshOk = false;
		const { claims, ownership } = sharedSessionOwnership(() => [owner]);
		const bridge = new ActivityManagerBridge(terminals, new FakeSubagentManager(), {
			rootDir: stateRoot,
			writerIdentity: { token: "contender-1", pid: 202, processStartTime: "contender-start" },
			inspectWriter: () => incumbentAlive ? "alive" : "dead",
			sessionOwnership: ownership,
		});
		// The bridge first sees the session while the incumbent is alive: its
		// blocked publisher is discarded unclaimed.
		bridge.bindSession(owner);

		// The death-proven takeover's refresh fails: the session claim stays with
		// this bridge for retry while the owner remains unclaimed and unpublished.
		incumbentAlive = false;
		expect(bridge.canProduceActivity(owner)).toBe(false);
		expect(claims.has(owner)).toBe(true);

		// dispose() releases the pending claim along with any published ones, so
		// a replacement bridge in this same process can claim and publish.
		bridge.dispose();
		expect(claims.has(owner)).toBe(false);

		// Same-process handoff of the writer lease (same pid/start, new token);
		// the replacement publishes the manager projection it replayed.
		terminals.refreshOk = true;
		terminals.snapshots = [terminal("term-after-dispose", owner)];
		const replacement = new ActivityManagerBridge(terminals, new FakeSubagentManager(), {
			rootDir: stateRoot,
			writerIdentity: { token: "contender-2", pid: 202, processStartTime: "contender-start" },
			inspectWriter: () => "dead",
			sessionOwnership: ownership,
		});
		replacement.bindSession(owner);
		expect(claims.has(owner)).toBe(true);
		expect(fixturePublisher(owner, { rootDir: stateRoot }).getSnapshot()).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "term-after-dispose", status: "running" }),
		]));
		replacement.dispose();
	});

	it("logs an expected takeover-refresh failure once until a success resets it", () => {
		const stateRoot = root();
		const owners = ["session-dedupe-a", "session-dedupe-b"];
		const alive = new Map<string, boolean>();
		const spawnIncumbent = (owner: string): void => {
			const token = `incumbent-${owner}`;
			alive.set(token, true);
			const incumbent = new ActivityFeedPublisher(owner, {
				rootDir: stateRoot,
				writerIdentity: { token, pid: 101, processStartTime: `incumbent-start-${owner}` },
				inspectWriter: (writer) => alive.get(writer.token) ? "alive" : "dead",
			});
			incumbent.publish([]);
		};
		for (const owner of owners) spawnIncumbent(owner);
		const terminals = new FakeTerminalManager();
		terminals.refreshOk = false;
		const diagnostics: ActivityFeedDiagnostic[] = [];
		const { ownership } = sharedSessionOwnership(() => [...owners]);
		const takeoverFailures = (): number => diagnostics.filter((entry) => entry.message.includes("takeover refresh failed")).length;
		const bridge = new ActivityManagerBridge(terminals, new FakeSubagentManager(), {
			rootDir: stateRoot,
			writerIdentity: { token: "contender", pid: 202, processStartTime: "contender-start" },
			inspectWriter: (writer) => alive.get(writer.token) ? "alive" : "dead",
			onDiagnostic: (entry) => diagnostics.push(entry),
			sessionOwnership: ownership,
		});

		// Pass 1: both owners' death-proven takeover refresh fails — exactly one
		// diagnostic for the failure episode, not one per owner or per sync.
		for (const owner of owners) alive.set(`incumbent-${owner}`, false);
		bridge.bindSession(owners[0]!);
		expect(takeoverFailures()).toBe(1);

		// Repeated failed syncs stay silent until a refresh succeeds.
		bridge.bindSession(owners[0]!);
		bridge.bindSession(owners[1]!);
		expect(takeoverFailures()).toBe(1);

		// The successful coalesced refresh claims, publishes, and resets the
		// failure dedupe.
		terminals.refreshOk = true;
		bridge.bindSession(owners[0]!);
		expect(takeoverFailures()).toBe(1);

		// A later owner's takeover hits a fresh transient failure: the reset
		// dedupe emits once more, and repeats stay silent.
		const lateOwner = "session-dedupe-c";
		spawnIncumbent(lateOwner);
		alive.set(`incumbent-${lateOwner}`, false);
		owners.push(lateOwner);
		terminals.refreshOk = false;
		bridge.bindSession(lateOwner);
		expect(takeoverFailures()).toBe(2);
		bridge.bindSession(lateOwner);
		expect(takeoverFailures()).toBe(2);

		// A pass with zero pending takeover owners runs no refresh at all — it
		// also re-arms the dedupe, so the next failure episode logs again even
		// though no refresh succeeded in between.
		const pending = owners.splice(0);
		bridge.bindSession(pending[0]!);
		expect(takeoverFailures()).toBe(2);
		owners.push(...pending);
		bridge.bindSession(lateOwner);
		expect(takeoverFailures()).toBe(3);
		bridge.bindSession(lateOwner);
		expect(takeoverFailures()).toBe(3);
		bridge.dispose();
	});

	it("a projection listener fanned out during the takeover refresh cannot rescan or double-publish", () => {
		const stateRoot = root();
		const owners = ["session-fanout-a", "session-fanout-b"];
		for (const [index, owner] of owners.entries()) {
			const incumbent = new ActivityFeedPublisher(owner, {
				rootDir: stateRoot,
				writerIdentity: { token: `incumbent-${index}`, pid: 101 + index, processStartTime: `incumbent-start-${index}` },
				inspectWriter: () => "alive",
			});
			incumbent.publish([]);
		}
		let incumbentsAlive = true;
		const terminals = new FakeTerminalManager();
		terminals.refreshedSnapshots = [terminal("term-fanout-a", owners[0]!), terminal("term-fanout-b", owners[1]!)];
		terminals.outputs.set("/tmp/term-fanout-a.log", "a output");
		terminals.outputs.set("/tmp/term-fanout-b.log", "b output");
		const publishes = new Map<string, number>();
		const bridge = new ActivityManagerBridge(terminals, new FakeSubagentManager(), {
			rootDir: stateRoot,
			writerIdentity: { token: "contender", pid: 202, processStartTime: "contender-start" },
			inspectWriter: () => incumbentsAlive ? "alive" : "dead",
			publisherFactory: (owner) => {
				const publisher = new ActivityFeedPublisher(owner, {
					rootDir: stateRoot,
					writerIdentity: { token: "contender", pid: 202, processStartTime: "contender-start" },
					inspectWriter: () => incumbentsAlive ? "alive" : "dead",
				});
				const publish = publisher.publish.bind(publisher);
				publisher.publish = (activities) => {
					const wrote = publish(activities);
					if (wrote) publishes.set(owner, (publishes.get(owner) ?? 0) + 1);
					return wrote;
				};
				return publisher;
			},
		});

		// Live incumbents authorize no refresh and no publication.
		for (const owner of owners) bridge.bindSession(owner);
		expect(terminals.refreshCount).toBe(0);
		expect([...publishes.values()]).toEqual([]);

		// Both writers die; the takeover refresh fans the projection listener out
		// during refresh. The bridge must not rescan the store through that
		// re-entrant listener, and each owner must be published exactly once from
		// the refreshed projection.
		incumbentsAlive = false;
		bridge.bindSession(owners[0]!);
		expect(terminals.refreshCount).toBe(1);
		expect(publishes).toEqual(new Map(owners.map((owner) => [owner, 1])));
		expect(fixturePublisher(owners[0]!, { rootDir: stateRoot }).getSnapshot()).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "term-fanout-a", status: "running" }),
		]));
		expect(fixturePublisher(owners[1]!, { rootDir: stateRoot }).getSnapshot()).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "term-fanout-b", status: "running" }),
		]));
		bridge.dispose();
	});

	it("takeover publication omits terminals the refresh quarantined, published once from the final projection", () => {
		const stateRoot = root();
		const terminalRoot = root();
		const reads = { scans: 0 };
		const store = new TerminalTaskStore({
			rootDir: terminalRoot,
			onRead: (kind) => { if (kind === "full-scan") reads.scans += 1; },
		});
		persistSettledTerminal(store, "term-keep", "session-quarantine", 1_000);
		persistSettledTerminal(store, "term-drop-1", "session-quarantine", 1_100);
		persistSettledTerminal(store, "term-drop-2", "session-quarantine", 1_200);
		const terminals = new TerminalTaskManager({ store });
		// The durable records become corrupt/unreadable after manager adoption;
		// the takeover refresh must quarantine both, prune the retained projection,
		// and never republish them into the durable feed.
		writeFileSync(join(terminalRoot, "term-drop-1-1100", "meta.json"), "{not json", { mode: 0o600 });
		writeFileSync(join(terminalRoot, "term-drop-2-1200", "meta.json"), "{not json", { mode: 0o600 });
		const incumbent = new ActivityFeedPublisher("session-quarantine", {
			rootDir: stateRoot,
			writerIdentity: { token: "incumbent", pid: 101, processStartTime: "incumbent-start" },
			inspectWriter: () => "alive",
		});
		incumbent.publish([]);
		let incumbentAlive = true;
		let publications = 0;
		const bridge = new ActivityManagerBridge(terminals, new FakeSubagentManager(), {
			rootDir: stateRoot,
			now: () => 2_000,
			writerIdentity: { token: "contender", pid: 202, processStartTime: "contender-start" },
			inspectWriter: () => incumbentAlive ? "alive" : "dead",
			publisherFactory: (owner) => {
				const publisher = new ActivityFeedPublisher(owner, {
					rootDir: stateRoot,
					now: () => 2_000,
					writerIdentity: { token: "contender", pid: 202, processStartTime: "contender-start" },
					inspectWriter: () => incumbentAlive ? "alive" : "dead",
				});
				const publish = publisher.publish.bind(publisher);
				publisher.publish = (activities) => {
					const wrote = publish(activities);
					if (wrote) publications += 1;
					return wrote;
				};
				return publisher;
			},
		});

		bridge.bindSession("session-quarantine");
		const scansBeforeTakeover = reads.scans;
		incumbentAlive = false;
		bridge.bindSession("session-quarantine");

		// One coalesced refresh: no listener-triggered nested rescan while the
		// takeover refresh prunes, and exactly one publication — of the final
		// projection, which excludes every quarantined id.
		expect(reads.scans - scansBeforeTakeover).toBe(1);
		expect(publications).toBe(1);
		expect(terminals.getSnapshots().map((task) => task.id)).toEqual(["term-keep"]);
		expect(fixturePublisher("session-quarantine", { rootDir: stateRoot }).getSnapshot().map((activity) => activity.id)).toEqual(["term-keep"]);
		bridge.dispose();
		terminals.detach();
	});


	it.skipIf(process.platform === "win32")("refreshes a late durable terminal before a two-process writer takeover", async () => {
		const stateRoot = root();
		const terminalRoot = root();
		const owner = "session-late-terminal";
		const ready = join(stateRoot, "contender-ready");
		const deathGate = join(stateRoot, "incumbent-dead");
		const takeoverGate = join(stateRoot, "takeover-now");
		const incumbent = new ActivityFeedPublisher(owner, {
			rootDir: stateRoot,
			writerIdentity: { token: "incumbent", pid: 444, processStartTime: "incumbent-start" },
			inspectWriter: () => "alive",
		});
		incumbent.publish([]);

		// Process B constructs its TerminalTaskManager while the durable store is
		// still empty and is held off by process A's live writer lease.
		const contender = runBridgeContender(stateRoot, terminalRoot, owner, ready, deathGate, takeoverGate);
		await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10_000 });

		// Only after B has cached the empty projection does process A start and
		// publish a terminal. B must reload TerminalTaskStore during takeover.
		const terminalManager = new TerminalTaskManager({
			store: new TerminalTaskStore({ rootDir: terminalRoot }),
			createId: () => "term-started-after-contender",
			pollIntervalMs: 60_000,
		});
		let task: TerminalTaskSnapshot | undefined;
		try {
			task = await terminalManager.start({
				ownerSessionId: owner,
				command: "sleep 30",
				cwd: stateRoot,
				title: "late terminal",
			});
			incumbent.publish([terminalActivitySnapshot(task, "late output")]);
			writeFileSync(deathGate, "dead\n", { mode: 0o600 });
			writeFileSync(takeoverGate, "go\n", { mode: 0o600 });

			expect(await contender).toEqual({
				id: "term-started-after-contender",
				status: "running",
				processIdentityVerified: true,
			});
			const verifyingStore = new TerminalTaskStore({ rootDir: terminalRoot });
			verifyingStore.refreshIndex();
			expect(verifyingStore.getIndexed(task.id)?.processTreeVerification?.members.length).toBeGreaterThan(0);
		} finally {
			if (task) await terminalManager.stop([task.id], owner);
			terminalManager.detach();
		}
	}, 20_000);

	it("blocks activity-producing tools until this process owns the session writer lease", () => {
		const stateRoot = root();
		const incumbent = new ActivityFeedPublisher("session-gated", {
			rootDir: stateRoot,
			writerIdentity: { token: "incumbent", pid: 111, processStartTime: "incumbent-start" },
			inspectWriter: () => "alive",
		});
		incumbent.publish([]);
		let incumbentAlive = true;
		const owners = new Set<string>();
		const claims = new Map<string, string>();
		const handlers = new Map<string, Array<(event: never, ctx: never) => object | void>>();
		const pi = {
			on: (name: string, handler: (event: never, ctx: never) => object | void) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
		} as never;
		const bridge = installActivityManagerBridge(pi, new FakeTerminalManager() as never, new FakeSubagentManager() as never, {
			rootDir: stateRoot,
			writerIdentity: { token: "contender", pid: 222, processStartTime: "contender-start" },
			inspectWriter: () => incumbentAlive ? "alive" : "dead",
			sessionOwnership: {
				ownedSessionIds: () => [...owners],
				noteOwnedSession: (owner) => { owners.add(owner); },
				claim: (owner, token) => {
					const current = claims.get(owner);
					if (current && current !== token) return false;
					claims.set(owner, token);
					return true;
				},
				release: (owner, token) => { if (claims.get(owner) === token) claims.delete(owner); },
			},
		});
		const ctx = { sessionManager: { getSessionId: () => "session-gated" } } as never;
		for (const handler of handlers.get("session_start") ?? []) handler({} as never, ctx);
		const toolGate = handlers.get("tool_call")?.[0];
		expect(toolGate?.({ toolName: "terminal_start" } as never, ctx)).toMatchObject({ block: true });
		expect(toolGate?.({ toolName: "subagent_spawn" } as never, ctx)).toMatchObject({ block: true });

		incumbentAlive = false;
		expect(toolGate?.({ toolName: "terminal_start" } as never, ctx)).toBeUndefined();
		bridge.dispose();
	});

	it.skipIf(process.platform === "win32")("allows tools through feed corruption/outage and repairs the presentation feed", () => {
		const stateRoot = root();
		const paths = activityPaths("session-repair", stateRoot);
		writeFileSync(paths.feedFile, "{not-json", { mode: 0o600 });
		chmodSync(paths.feedFile, 0o600);
		const diagnostics: string[] = [];
		const terminals = new FakeTerminalManager();
		const handlers = new Map<string, Array<(event: never, ctx: never) => object | void>>();
		const pi = {
			on: (name: string, handler: (event: never, ctx: never) => object | void) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
		} as never;
		const claims = new Map<string, string>();
		const bridge = installActivityManagerBridge(pi, terminals as never, new FakeSubagentManager() as never, {
			rootDir: stateRoot,
			writerIdentity: { token: "repair-owner", pid: 333, processStartTime: "repair-start" },
			inspectWriter: () => "alive",
			onDiagnostic: (entry) => diagnostics.push(`${entry.kind}:${entry.message}`),
			sessionOwnership: {
				ownedSessionIds: () => ["session-repair"],
				claim: (owner, token) => {
					const current = claims.get(owner);
					if (current && current !== token) return false;
					claims.set(owner, token);
					return true;
				},
				release: (owner, token) => { if (claims.get(owner) === token) claims.delete(owner); },
			},
		});
		const ctx = { sessionManager: { getSessionId: () => "session-repair" } } as never;
		for (const handler of handlers.get("session_start") ?? []) handler({} as never, ctx);
		const toolGate = handlers.get("tool_call")?.[0];
		expect(toolGate?.({ toolName: "terminal_start" } as never, ctx)).toBeUndefined();
		expect(toolGate?.({ toolName: "subagent_spawn" } as never, ctx)).toBeUndefined();
		expect(diagnostics.some((entry) => entry.startsWith("io:"))).toBe(true);

		chmodSync(paths.directory, 0o500);
		terminals.snapshots = [terminal("term-during-outage", "session-repair")];
		terminals.emit();
		expect(toolGate?.({ toolName: "terminal_start" } as never, ctx)).toBeUndefined();
		expect(toolGate?.({ toolName: "subagent_spawn" } as never, ctx)).toBeUndefined();
		expect(diagnostics.some((entry) => entry.includes("permissions must be 0700"))).toBe(true);

		chmodSync(paths.directory, 0o700);
		terminals.emit();
		expect(fixturePublisher("session-repair", { rootDir: stateRoot }).getSnapshot()).toEqual([
			expect.objectContaining({ id: "term-during-outage", status: "running" }),
		]);
		bridge.dispose();
	});

	it("decodes raw terminal tails without persisting split UTF-8 code points", () => {
		const stateRoot = root();
		const terminals = new FakeTerminalManager();
		terminals.snapshots = [terminal("term-utf8", "session-a")];
		terminals.outputBytes.set("/tmp/term-utf8.log", Uint8Array.from([0xa7, 0x8a, 0x6f, 0x6b]));
		const bridge = new ActivityManagerBridge(terminals, new FakeSubagentManager(), { rootDir: stateRoot, now: () => 2_000 });
		bridge.bindSession("session-a");
		const [stored] = fixturePublisher("session-a", { rootDir: stateRoot }).getSnapshot();
		expect(stored?.outputTail).toBe("ok");
		expect(stored?.outputTail).not.toContain("�");
		bridge.dispose();
	});

	it("discards a partial oversized row whose credential prefix is outside the raw tail", () => {
		const stateRoot = root();
		const terminals = new FakeTerminalManager();
		terminals.snapshots = [terminal("term-secret", "session-a")];
		terminals.outputBytes.set("/tmp/term-secret.log", Buffer.from(`API_KEY=${"s".repeat(70 * 1024)}`, "utf8"));
		const bridge = new ActivityManagerBridge(terminals, new FakeSubagentManager(), { rootDir: stateRoot, now: () => 2_000 });
		bridge.bindSession("session-a");
		const [stored] = fixturePublisher("session-a", { rootDir: stateRoot }).getSnapshot();
		expect(stored?.outputTail).toBe("");
		bridge.dispose();
	});

	it("disambiguates a process-local subagent ID reused after bridge reload", () => {
		const stateRoot = root();
		fixturePublisher("session-a", { rootDir: stateRoot, now: () => 1_000 }).publish([{
			id: "subagent:sa-1",
			sourceId: "spawn-old",
			kind: "subagent",
			title: "old worker",
			status: "succeeded",
			ownerSessionId: "session-a",
			createdAt: 500,
			updatedAt: 600,
			settledAt: 600,
			result: { summary: "old result" },
		}]);
		const subagents = new FakeSubagentManager();
		subagents.snapshots = [{ ...subagent("sa-1"), sourceId: "spawn-new", createdAt: 2_000 }];
		let now = 2_100;
		const bridge = new ActivityManagerBridge(new FakeTerminalManager(), subagents, { rootDir: stateRoot, now: () => now });
		bridge.bindSession("session-a");
		let feed = fixturePublisher("session-a", { rootDir: stateRoot }).getSnapshot();
		expect(feed).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "subagent:sa-1", sourceId: "spawn-old", status: "succeeded", result: { summary: "old result" } }),
			expect.objectContaining({ sourceId: "spawn-new", status: "running", createdAt: 2_000 }),
		]));
		const current = feed.find((activity) => activity.sourceId === "spawn-new");
		expect(current?.id).toMatch(/^subagent:sa-1:/);
		expect(current?.result).toBeUndefined();

		now = ACTIVITY_SETTLED_RETENTION_MS + 2_100;
		bridge.bindSession("session-a");
		bridge.bindSession("session-a");
		feed = fixturePublisher("session-a", { rootDir: stateRoot }).getSnapshot();
		expect(feed.filter((activity) => activity.sourceId === "spawn-new")).toEqual([
			expect.objectContaining({ id: current?.id, status: "running" }),
		]);
		expect(feed.some((activity) => activity.id === "subagent:sa-1")).toBe(false);
		bridge.dispose();
	});

	it("debounces subagent deltas and binds them to the extension session owner", async () => {
		vi.useFakeTimers();
		const stateRoot = root();
		const terminals = new FakeTerminalManager();
		const subagents = new FakeSubagentManager();
		subagents.snapshots = [subagent("sa-1")];
		const bridge = new ActivityManagerBridge(terminals, subagents, { rootDir: stateRoot, now: () => 2_000, subagentDebounceMs: 50 });
		bridge.bindSession("session-a");
		subagents.snapshots = [{ ...subagent("sa-1"), liveText: "first" }];
		subagents.emit();
		subagents.snapshots = [{ ...subagent("sa-1"), liveText: "second" }];
		subagents.emit();
		await vi.advanceTimersByTimeAsync(49);
		expect(fixturePublisher("session-a", { rootDir: stateRoot }).getSnapshot()[0]?.outputTail).toBe("working");
		await vi.advanceTimersByTimeAsync(1);
		expect(fixturePublisher("session-a", { rootDir: stateRoot }).getSnapshot()[0]).toMatchObject({
			id: "subagent:sa-1",
			ownerSessionId: "session-a",
			outputTail: "second",
		});
		bridge.dispose();
	});

	it("publishes old-session terminal output while another session owns subagents", async () => {
		vi.useFakeTimers();
		const stateRoot = root();
		const terminals = new FakeTerminalManager();
		terminals.snapshots = [terminal("term-a", "session-a")];
		terminals.outputs.set("/tmp/term-a.log", "before");
		const bridge = new ActivityManagerBridge(terminals, new FakeSubagentManager(), {
			rootDir: stateRoot,
			now: () => 2_000,
			terminalOutputPollMs: 100,
		});
		bridge.bindSession("session-a");
		bridge.bindSession("session-b");
		terminals.outputs.set("/tmp/term-a.log", "after");
		await vi.advanceTimersByTimeAsync(100);
		expect(fixturePublisher("session-a", { rootDir: stateRoot }).getSnapshot()[0]).toMatchObject({ id: "term-a", outputTail: "after" });
		expect(fixturePublisher("session-b", { rootDir: stateRoot }).getSnapshot()).toEqual([]);
		bridge.dispose();
	});

	it("forwards bridge-owned output failures to the configured diagnostic callback", () => {
		const terminals = new FakeTerminalManager();
		terminals.snapshots = [terminal("term-error", "session-a")];
		terminals.getOutputTailBytes = () => { throw new Error("tail failed"); };
		const onDiagnostic = vi.fn();
		const bridge = new ActivityManagerBridge(terminals, new FakeSubagentManager(), {
			rootDir: root(),
			now: () => 2_000,
			onDiagnostic,
		});
		bridge.bindSession("session-a");
		expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ kind: "io", path: "/tmp/term-error.log", message: "tail failed" }));
		bridge.dispose();
	});

	it("polls only running terminal logs while settled projections stay cached", async () => {
		vi.useFakeTimers();
		const stateRoot = root();
		const terminals = new FakeTerminalManager();
		terminals.snapshots = [
			...Array.from({ length: 100 }, (_, index) => terminal(`settled-${index}`, "session-a", "completed")),
			terminal("running", "session-a"),
		];
		const bridge = new ActivityManagerBridge(terminals, new FakeSubagentManager(), {
			rootDir: stateRoot,
			now: () => 3_000,
			terminalOutputPollMs: 50,
		});
		bridge.bindSession("session-a");
		expect([...terminals.outputReads.entries()].filter(([path]) => path.includes("settled"))).toHaveLength(ACTIVITY_SETTLED_RETENTION_COUNT);
		await vi.advanceTimersByTimeAsync(150);
		for (const [path, reads] of terminals.outputReads) {
			if (path.includes("settled")) expect(reads).toBe(1);
		}
		expect(terminals.outputReads.get("/tmp/running.log")).toBe(4);
		bridge.dispose();
	});

	it("prunes settled retention while idle with no running terminal", async () => {
		vi.useFakeTimers();
		const stateRoot = root();
		let now = 1_000;
		fixturePublisher("session-a", { rootDir: stateRoot, now: () => now }).publish([{
			id: "settled",
			kind: "terminal",
			title: "settled",
			status: "succeeded",
			ownerSessionId: "session-a",
			createdAt: now,
			updatedAt: now,
			settledAt: now,
		}]);
		const bridge = new ActivityManagerBridge(new FakeTerminalManager(), new FakeSubagentManager(), {
			rootDir: stateRoot,
			now: () => now,
			retentionPollMs: 50,
		});
		bridge.bindSession("session-a");
		now += ACTIVITY_SETTLED_RETENTION_MS + 1;
		await vi.advanceTimersByTimeAsync(50);
		expect(fixturePublisher("session-a", { rootDir: stateRoot }).getSnapshot()).toEqual([]);
		bridge.dispose();
	});

	it("marks non-reattachable shutdown subagents lost and clears every timer", () => {
		vi.useFakeTimers();
		const stateRoot = root();
		const terminals = new FakeTerminalManager();
		terminals.snapshots = [terminal("term-a", "session-a")];
		const subagents = new FakeSubagentManager();
		subagents.snapshots = [subagent("sa-1")];
		const bridge = new ActivityManagerBridge(terminals, subagents, { rootDir: stateRoot });
		bridge.bindSession("session-a");
		subagents.emit();
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		bridge.shutdownSession("session-a");
		expect(fixturePublisher("session-a", { rootDir: stateRoot }).getSnapshot()).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "subagent:sa-1", status: "lost" }),
		]));
		expect(vi.getTimerCount()).toBe(0);
	});
});
