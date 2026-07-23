import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalTaskManager, type TerminalOutputTail } from "../background-tasks/task-manager.js";
import { TerminalTaskStore } from "../background-tasks/task-store.js";
import { terminalActivitySnapshot, type TerminalTaskSnapshot } from "../background-tasks/task-types.js";
import type { SubagentSnapshot } from "../subagents/domain.js";
import { ACTIVITY_SETTLED_RETENTION_COUNT, ACTIVITY_SETTLED_RETENTION_MS, ActivityFeedPublisher, type ActivityFeedPublisherOptions } from "./feed-publisher.js";
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
				else resolve(JSON.parse(stdout.trim()) as { id: string; status: string; processIdentityVerified: boolean });
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

function subagent(id: string, status: SubagentSnapshot["status"] = "running"): SubagentSnapshot {
	return {
		id,
		title: id,
		prompt: "review the code",
		cwd: "/tmp",
		baseRef: "HEAD",
		status,
		createdAt: 1_000,
		...(status === "running" ? {} : { settledAt: 2_000 }),
		usage: { turns: 0 },
		transcript: [],
		liveText: status === "running" ? "working" : "",
		liveTools: [],
		finalText: status === "done" ? "done" : "",
		...(status === "error" ? { errorText: "failed" } : {}),
	};
}

class FakeTerminalManager {
	public snapshots: TerminalTaskSnapshot[] = [];
	public outputs = new Map<string, string>();
	public outputBytes = new Map<string, Uint8Array>();
	public outputReads = new Map<string, number>();
	private listener: ((snapshots: readonly TerminalTaskSnapshot[]) => void) | undefined;

	public subscribeChanges(listener: (snapshots: readonly TerminalTaskSnapshot[]) => void): () => void {
		this.listener = listener;
		listener(this.snapshots);
		return () => { this.listener = undefined; };
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
			expect(new TerminalTaskStore({ rootDir: terminalRoot }).get(task.id)?.processTreeVerification?.members.length).toBeGreaterThan(0);
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
		const handlers = new Map<string, Array<(event: never, ctx: never) => unknown>>();
		const pi = {
			on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
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
		const handlers = new Map<string, Array<(event: never, ctx: never) => unknown>>();
		const pi = {
			on: (name: string, handler: (event: never, ctx: never) => unknown) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
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
