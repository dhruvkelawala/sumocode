import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import type { ProcessTreeOperations } from "../background-tasks/process-tree.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_MAX_RUNNING, type SubagentEvent } from "./domain.js";
import type { SpawnedChild } from "./backend-pi.js";
import type { TerminalHost } from "../terminal-host/types.js";
import { installSubagents } from "./index.js";
import { BUILT_IN_TOOLS } from "./task-config.js";
import { SubagentRegistry, type SubagentRecord } from "./registry.js";
import { controlAuthority, type RetainedSubagent } from "./retained-adoption.js";
import type { SubagentManagerDependencies } from "./manager.js";

type ChildEmitter = (event: SubagentEvent) => void;

/** Recorded interactions with the child-backend doubles. */
interface BackendLog {
	emitters: ChildEmitter[];
	paneEmitters: ChildEmitter[];
	piCalls: number;
	/** SAFETY-free: placement is forwarded opaquely and never read here. */
	paneCalls: Array<{ cwd: string; placement: unknown; model?: string; thinking?: string; tools?: readonly string[] }>;
}

const backend: BackendLog = {
	emitters: [],
	paneEmitters: [],
	piCalls: 0,
	paneCalls: [],
};

/** Faithful stand-in for the herdr terminal host the manager talks through. */
const fakeTerminalHost = (): TerminalHost => ({
	kind: "herdr",
	startAgentPane: vi.fn(),
	sendPaneText: vi.fn(),
	openCommandInSplit: vi.fn(),
	openExistingWorktreeWorkspace: vi.fn(),
	closePane: vi.fn(),
	notify: vi.fn(),
});

// SAFETY: placement is forwarded opaquely to the pane backend and never read here.
const fakeSpawnPaneChild = vi.fn((options: { cwd: string; placement: unknown; model?: string; thinking?: string; tools?: readonly string[] }): SpawnedChild => {
	backend.paneCalls.push(options);
	return {
		events: (emit: (event: SubagentEvent) => void) => {
			backend.paneEmitters.push(emit);
			emit({ kind: "run-started" });
			emit({ kind: "pane-attached", pane: { agentName: "visible-worker-abc", workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p3" } });
		},
		ready: Promise.resolve(),
		interrupt: vi.fn(),
	};
});

const fakeSpawnPiChild = vi.fn((options: { model?: string }): SpawnedChild => {
	backend.piCalls += 1;
	let emitEvent: ((event: SubagentEvent) => void) | undefined;
	return {
		events: (emit: (event: SubagentEvent) => void) => {
			emitEvent = emit;
			backend.emitters.push(emit);
			// Mirror the real backend's synchronous settle-as-failed path
			// (invalid model override) for tests that need it.
			if (options.model === "sync-fail") emit({ kind: "run-settled", outcome: { kind: "failed", errorText: "invalid model" } });
			else emit({ kind: "run-started" });
		},
		interrupt: () => emitEvent?.({ kind: "run-settled", outcome: { kind: "interrupted" } }),
		sessionFilePath: "/tmp/child-session.jsonl",
	};
});

/** Deterministic completion-manifest double mirroring the real builder's shape. */
const fakeBuildCompletionManifest = async (options: { baseRef: string; outcome: { kind: "completed" | "failed" | "interrupted" }; worktree?: { path: string; branch: string } }) => ({
	baseRef: options.baseRef,
	headRef: "host-head",
	branch: options.worktree?.branch,
	worktreePath: options.worktree?.path,
	changedPaths: options.worktree ? ["src/a.ts"] : [],
	dirty: false,
	commits: options.worktree ? 1 : 0,
	exit: options.outcome.kind,
	durationMs: 10,
});

/** Minimal command-handler context shape exercised by these tests. */
type HandlerCtx = { cwd: string; model?: { provider: string; id: string }; isIdle?: () => boolean; sessionManager: { getSessionId(): string; getSessionFile(): string | undefined } };
type Handler = (event: { type: string; reason?: string; targetSessionFile?: string }, ctx: HandlerCtx) => void;

/** Tool result shape the tests inspect. */
interface ToolResult {
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
}

/** Minimal tool-definition shape captured from registerTool. */
type Tool = { name: string; execute: (...args: unknown[]) => Promise<ToolResult> };

const createHarness = (hasUI = false, mode: "tui" | "rpc" = "tui", options: { retainedRegistry?: SubagentRegistry; retention?: false; activeTools?: readonly string[]; managerDependencies?: SubagentManagerDependencies } = {}) => {
	let idle = true;
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, Tool>();
	const sendMessage = vi.fn((_message: { content?: string }) => { idle = false; });
	const setWidget = vi.fn();
	const pi = {
		on: vi.fn((event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler])),
		registerTool: vi.fn((tool: Tool) => tools.set(tool.name, tool)),
		sendMessage,
		getActiveTools: vi.fn((): string[] => [...(options.activeTools ?? ["read", "bash"])]),
		getThinkingLevel: vi.fn((): string => "medium"),
	};
	// SAFETY: the double implements every ExtensionAPI member installSubagents touches.
	const manager = installSubagents(pi as never, {
		retention: false,
		terminalHost: fakeTerminalHost(),
		spawnPaneChild: fakeSpawnPaneChild,
		spawnPiChild: fakeSpawnPiChild,
		managerDependencies: { buildCompletionManifest: fakeBuildCompletionManifest },
		...options,
	});
	const ctx = {
		cwd: "/tmp/project",
		mode,
		model: { provider: "openai", id: "gpt-5" },
		isIdle: () => idle,
		hasUI,
		ui: { setWidget },
		sessionManager: { getSessionId: () => "test-session", getSessionFile: () => "/tmp/test-session.jsonl" },
	};
	const fire = (event: string, reason?: string, targetSessionFile?: string) => {
		for (const handler of handlers.get(event) ?? []) handler({ type: event, reason, targetSessionFile }, ctx);
	};
	const fireSessionStart = async (sessionId = "test-session", sessionFile = `/tmp/${sessionId}.jsonl`) => {
		ctx.sessionManager = { getSessionId: () => sessionId, getSessionFile: () => sessionFile };
		for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
	};
	return {
		manager,
		sendMessage,
		setWidget,
		tool: (name: string) => tools.get(name)!,
		ctx,
		fire,
		fireSessionStart,
		setIdle: (value: boolean) => { idle = value; },
	};
};

const spawn = (manager: ReturnType<typeof installSubagents>, title = "worker") => manager.spawn({
	prompt: "do the work",
	title,
	cwd: "/tmp/project",
});

async function retainedHarness() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sumocode-installer-retained-")));
	const taskDir = join(root, "task");
	mkdirSync(taskDir, { mode: 0o700 });
	const operations: ProcessTreeOperations = {
		captureStartTime: vi.fn(() => "child-command"), identityMatches: vi.fn(() => "same" as const),
		captureTreeVerification: vi.fn(() => ({ members: [{ pid: 42, processStartTime: "child-birth" }] })),
		verificationMatches: vi.fn(() => "same" as const), isTreeEmpty: vi.fn(() => false),
		signalTree: vi.fn(async () => ({ ok: true, gone: true })), waitForTreeEmpty: vi.fn(async () => false),
	};
	const origin = createHarness(false, "rpc", { managerDependencies: { processOperations: operations } });
	await origin.fireSessionStart("origin");
	const writer = { token: "writer", pid: process.pid, processStartTime: "writer-birth" };
	const registry = new SubagentRegistry(join(root, "registry"), "origin", { writerIdentity: writer, inspectWriter: () => "alive" });
	const initial: SubagentRecord = {
		schemaVersion: 2, revision: 1, id: "sa-retained-1", ownerSessionId: "origin", backend: "headless", status: "starting", taskDir,
		child: null, supervisor: null, pane: null, worktree: null, sessionFilePath: null, modelLabel: null, roleId: null,
		createdAt: Date.now(), updatedAt: Date.now(), settledAt: null, completionId: null, outcome: null,
		delivery: { state: "none", claim: null }, result: null, manifest: null, writerLease: null, controlLease: null, controlHead: 0,
	};
	registry.create(initial);
	let record = registry.acquireWriter(initial.id, 1, 60_000);
	record = registry.transition(record.id, record.revision, record.writerLease!.generation, (current) => ({ ...current, status: "running",
		child: { identity: { pid: 42, processGroupId: 42, processStartTime: "child-command" }, verification: { members: [{ pid: 42, processStartTime: "child-birth" }] } },
		supervisor: { identity: { pid: process.pid, processGroupId: process.pid, processStartTime: "supervisor-command" }, verification: { members: [{ pid: process.pid, processStartTime: "supervisor-birth" }] } },
	}));
	record = registry.acquireControl(record.id, record.revision, record.writerLease!.generation, 0, origin.manager.controllerIdentity, 60_000);
	const listeners = new Set<(record: SubagentRecord) => void>();
	const interrupt = vi.fn();
	const entry: RetainedSubagent = {
		registry: registry.forController(origin.manager.controllerIdentity), authority: controlAuthority(record),
		snapshot: { id: initial.id, title: "retained", prompt: "task", cwd: taskDir, baseRef: "HEAD", status: "running", createdAt: initial.createdAt,
			usage: { turns: 0 }, transcript: [], liveText: "", liveTools: [], finalText: "" },
		supervisor: {
			get record() { return registry.get(initial.id)!; }, completion: undefined,
			controllerChild: () => ({ events: () => undefined, interrupt }),
			subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
			reserveControl: (authority, successor) => {
				const current = registry.get(initial.id)!;
				return registry.reserveControl(current.revision, authority, `${initial.id}:${authority.head + 1}`, { ...successor, writerGeneration: current.writerLease!.generation });
			},
		},
	};
	await origin.manager.trackRetained(entry);
	return { root, origin, registry, record, listeners, interrupt, operations };
}

beforeEach(() => {
	backend.emitters.length = 0;
	backend.paneEmitters.length = 0;
	backend.piCalls = 0;
	backend.paneCalls.length = 0;
	fakeSpawnPaneChild.mockClear();
	fakeSpawnPiChild.mockClear();
});

describe("subagent result delivery", () => {
	it("opens the production retained registry on session start by default", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "sumocode-production-registry-")));
		vi.stubEnv("SUMOCODE_STATE_DIR", root);
		const harness = createHarness(false, "rpc", { retention: undefined });
		try {
			expect(existsSync(join(root, "sumocode", "subagents", "v2", "registry"))).toBe(false);
			await harness.fireSessionStart("production-session");
			expect(existsSync(join(root, "sumocode", "subagents", "v2", "registry"))).toBe(true);
		} finally { harness.manager.disposeAll(); vi.unstubAllEnvs(); }
	});
	it("delivers a settled headless reply through the existing follow-up path", async () => {
		const harness = createHarness();
		harness.fire("session_start");
		harness.setIdle(false);
		await spawn(harness.manager, "conversation");
		backend.emitters[0]?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "first" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-conversation-1")?.status).toBe("done"));

		await harness.tool("subagent_reply").execute("reply", { id: "sa-conversation-1", text: "follow up" }, undefined, undefined, harness.ctx);
		backend.emitters[1]?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "second" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-re-conversation-2")?.status).toBe("done"));
		harness.setIdle(true);
		harness.fire("agent_end");

		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("second"), details: expect.objectContaining({ id: "sa-re-conversation-2" }) }),
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});

	it("sets the status widget while active and clears it after the last settlement", async () => {
		const harness = createHarness(true);
		harness.fire("session_start");
		expect(harness.setWidget).not.toHaveBeenCalled();
		await spawn(harness.manager, "research");
		expect(harness.setWidget).toHaveBeenCalledWith("sumocode-subagents", expect.any(Function), { placement: "aboveEditor" });

		backend.emitters[0]?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-research-1")?.status).toBe("done"));
		expect(harness.setWidget).toHaveBeenLastCalledWith("sumocode-subagents", undefined, { placement: "aboveEditor" });
	});

	it("publishes pre-rendered lines in RPC because component factories are unsupported", async () => {
		const harness = createHarness(true, "rpc");
		harness.fire("session_start");
		await spawn(harness.manager, "research");

		const widget = harness.setWidget.mock.calls.at(-1)?.[1];
		expect(Array.isArray(widget)).toBe(true);
		// SAFETY: Array.isArray(widget) is asserted above, so the string[] cast is checked.
		expect((widget as string[]).join("\n")).toContain("1 running");
		// SAFETY: Array.isArray(widget) is asserted above, so the string[] cast is checked.
		expect((widget as string[]).join("\n")).toContain("research sa-1");
		// SAFETY: Array.isArray(widget) is asserted above, so the string[] cast is checked.
		expect((widget as string[]).join("\n")).not.toContain("sa-research-1");
	});

	it("renders queued count and clears the widget on shutdown", async () => {
		const harness = createHarness(true);
		harness.fire("session_start");
		for (let index = 0; index < SUBAGENT_MAX_RUNNING; index += 1) await spawn(harness.manager, `running-${index}`);
		await spawn(harness.manager, "queued");
		// SAFETY: the RPC setWidget contract delivers a component factory with a render method.
		const factory = harness.setWidget.mock.calls.at(-1)?.[1] as (() => { render(width: number): string[] });
		expect(factory().render(140).join("\n")).toContain("1 queued");

		harness.fire("session_shutdown", "reload");
		expect(harness.setWidget).toHaveBeenLastCalledWith("sumocode-subagents", undefined, { placement: "aboveEditor" });
		await vi.waitFor(() => expect(harness.manager.list().slice(0, SUBAGENT_MAX_RUNNING + 1).every((snapshot) => snapshot.status === "error")).toBe(true));
		expect(backend.piCalls).toBe(SUBAGENT_MAX_RUNNING);

		harness.fire("session_start");
		await expect(spawn(harness.manager, "next session")).resolves.toMatchObject({ id: "sa-next-session-12", status: "running" });
		harness.fire("session_shutdown", "quit");
	});

	it("releases legacy unscoped replacements instead of adopting them", async () => {
		const key = Symbol.for("@dhruvkelawala/sumocode/subagent-replacements");
		// SAFETY: the test owns this namespaced symbol and restores it by exercising cleanup.
		const state = globalThis as typeof globalThis & { [key]?: Set<unknown> };
		const legacy = new Set<unknown>([{}]);
		state[key] = legacy;

		const harness = createHarness();
		await harness.fireSessionStart();

		expect(legacy.size).toBe(0);
		expect(state[key]).toBeUndefined();
	});

	it("detaches legacy retained views without adopting or terminating their children", async () => {
		const f = await retainedHarness();
		const key = Symbol.for("@dhruvkelawala/sumocode/subagent-replacements");
		// SAFETY: this test owns the legacy symbol, including deliberately malformed entries.
		const state = globalThis as typeof globalThis & { [key]?: Set<unknown> };
		const throwing = vi.fn(() => { throw new Error("legacy detach failed"); });
		const legacy = new Set<unknown>([{}, null, { detachForReplacement: throwing }, f.origin.manager]);
		state[key] = legacy;
		const detach = vi.spyOn(f.origin.manager, "detachForReplacement");
		const successor = createHarness();
		const adopt = vi.spyOn(successor.manager, "adoptFrom");
		try {
			expect(f.listeners.size).toBe(1);
			await successor.fireSessionStart("successor");
			expect(throwing).toHaveBeenCalledOnce();
			expect(detach).toHaveBeenCalledOnce();
			expect(legacy.size).toBe(0);
			expect(state[key]).toBeUndefined();
			expect(adopt).not.toHaveBeenCalled();
			expect(f.listeners.size).toBe(0);
			expect(f.origin.manager.list()).toEqual([]);
			expect(f.origin.manager.canDeliver(f.record.id)).toBe(false);
			expect(f.registry.get(f.record.id)).toEqual(f.record);
			expect(f.interrupt).not.toHaveBeenCalled();
			expect(f.operations.signalTree).not.toHaveBeenCalled();
		} finally {
			f.origin.manager.detachForReplacement();
			successor.manager.disposeAll();
			delete state[key];
		}
	});

	it("uses the shutdown context for targetless reload before session start", async () => {
		const harness = createHarness();
		const detach = vi.spyOn(harness.manager, "detachForReplacement");

		harness.fire("session_shutdown", "reload");
		expect(detach).not.toHaveBeenCalled();
		await harness.fireSessionStart();
	});

	it("never calls setWidget without UI", async () => {
		const harness = createHarness(false);
		harness.fire("session_start");
		await spawn(harness.manager);
		backend.emitters[0]?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-worker-1")?.status).toBe("done"));
		harness.fire("session_shutdown");
		expect(harness.setWidget).not.toHaveBeenCalled();
	});

	it("keeps settlement working when setWidget throws", async () => {
		const harness = createHarness(true);
		harness.setWidget.mockImplementation(() => { throw new Error("ui gone"); });
		harness.fire("session_start");
		await expect(spawn(harness.manager)).resolves.toMatchObject({ status: "running" });
		backend.emitters[0]?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-worker-1")?.status).toBe("done"));
	});

	it("does not deliver a queued snapshot as a settled result", async () => {
		const harness = createHarness();
		harness.setIdle(false);
		for (let index = 0; index < SUBAGENT_MAX_RUNNING; index += 1) await spawn(harness.manager, `running-${index}`);
		const queued = await spawn(harness.manager, "queued");
		expect(queued).toMatchObject({ id: "sa-queued-11", status: "queued" });
		harness.setIdle(true);
		harness.fire("agent_end");
		expect(harness.sendMessage).not.toHaveBeenCalled();
	});

	it("defers while the parent is busy and flushes exactly once on agent_end", async () => {
		const harness = createHarness();
		harness.setIdle(false);
		harness.fire("agent_start");
		await spawn(harness.manager, "research");

		backend.emitters[0]?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "findings" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-research-1")?.status).toBe("done"));
		expect(harness.sendMessage).not.toHaveBeenCalled();

		harness.setIdle(true);
		harness.fire("agent_end");
		expect(harness.sendMessage).toHaveBeenCalledOnce();
		expect(harness.sendMessage).toHaveBeenCalledWith(
			{
				customType: "subagent-result",
				content: expect.stringContaining('Subagent sa-research-1 "research" finished.'),
				display: true,
				details: expect.objectContaining({
					id: "sa-research-1",
					title: "research",
					status: "done",
					activity: expect.objectContaining({ id: "subagent:sa-research-1", kind: "subagent", status: "succeeded", result: { summary: "findings" } }),
					manifest: expect.objectContaining({ changedPaths: [] }),
				}),
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		// SAFETY: sendMessage is always called with a single message payload argument.
		const delivered = (harness.sendMessage.mock.calls[0] as unknown[])[0] as { content: string };
		expect(delivered.content).toContain("```text\nshared checkout · base HEAD · +0 checkout commits · changed paths suppressed · checkout clean\n```");

		harness.setIdle(true);
		harness.fire("agent_end");
		expect(harness.sendMessage).toHaveBeenCalledOnce();
	});

	it("retries deferred delivery without duplicating successful earlier results", async () => {
		const harness = createHarness();
		harness.setIdle(false);
		harness.fire("agent_start");
		for (const title of ["first", "second", "third"]) await spawn(harness.manager, title);
		for (let index = 0; index < 3; index += 1) {
			backend.emitters[index]?.({ kind: "run-settled", outcome: { kind: "completed", finalText: `result-${index + 1}` } });
		}
		await vi.waitFor(() => expect(harness.manager.list().every((snapshot) => snapshot.status === "done")).toBe(true));
		harness.sendMessage
			.mockImplementationOnce(() => undefined)
			.mockImplementationOnce(() => { throw new Error("send failed"); })
			.mockImplementation(() => undefined);
		harness.setIdle(true);

		expect(() => harness.fire("agent_end")).not.toThrow();
		await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(4));

		const deliveredIds = harness.sendMessage.mock.calls.map((call) => {
			// SAFETY: subagent delivery always sends a message with settled-subagent details.
			return ((call as unknown[])[0] as { details: { id: string } }).details.id;
		});
		expect(deliveredIds).toEqual(["sa-first-1", "sa-second-2", "sa-second-2", "sa-third-3"]);
	});

	it("delivers each visible idle-turn result once, then a terminal envelope without repeated output", async () => {
		const harness = createHarness();
		harness.fire("session_start");
		harness.setIdle(false);
		harness.fire("agent_start");
		await harness.manager.spawn({ prompt: "watch me", title: "visible idle", cwd: "/tmp/project", visible: true });

		backend.paneEmitters[0]?.({ kind: "turn-finished", finalText: "visible report", at: 1_234 });
		expect(harness.sendMessage).not.toHaveBeenCalled();
		harness.setIdle(true);
		harness.fire("agent_end");

		await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledOnce());
		expect(harness.manager.get("sa-visible-idle-1")).toMatchObject({ status: "running", turnState: "idle", finalText: "visible report" });
		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "subagent-result",
				content: expect.stringContaining("completed a turn and remains available for steering"),
				details: expect.objectContaining({ id: "sa-visible-idle-1", status: "running" }),
			}),
			{ deliverAs: "followUp", triggerTurn: true },
		);

		backend.paneEmitters[0]?.({ kind: "turn-started", at: 2_000 });
		backend.paneEmitters[0]?.({ kind: "turn-finished", finalText: "revised report", at: 3_000 });
		harness.setIdle(true);
		harness.fire("agent_end");
		expect(harness.sendMessage).toHaveBeenCalledTimes(2);
		expect(harness.sendMessage.mock.calls[1]?.[0]).toMatchObject({ content: expect.stringContaining("revised report") });

		backend.paneEmitters[0]?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "revised report" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-visible-idle-1")?.status).toBe("done"));
		harness.fire("agent_end");
		expect(harness.sendMessage).toHaveBeenCalledTimes(3);
		expect(harness.sendMessage.mock.calls[2]?.[0]).toMatchObject({
			content: expect.stringContaining("finished"),
		});
		expect(harness.sendMessage.mock.calls[2]?.[0]).not.toMatchObject({ content: expect.stringContaining("revised report") });
	});

	it("retries an idle turn after retained delivery eligibility recovers", async () => {
		const harness = createHarness();
		harness.fire("session_start");
		await harness.manager.spawn({ prompt: "watch me", title: "visible eligibility", cwd: "/tmp/project", visible: true });
		const canDeliver = vi.spyOn(harness.manager, "canDeliver").mockReturnValue(false);
		backend.paneEmitters[0]?.({ kind: "turn-finished", finalText: "eventual report", at: 1_234 });
		expect(harness.sendMessage).not.toHaveBeenCalled();

		canDeliver.mockRestore();
		backend.paneEmitters[0]?.({ kind: "heartbeat", at: Date.now() });
		await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledOnce());
		expect(harness.sendMessage.mock.calls[0]?.[0]).toMatchObject({ content: expect.stringContaining("eventual report") });
	});

	it("surfaces a terminal failure after an earlier visible turn result", async () => {
		const harness = createHarness();
		harness.fire("session_start");
		await harness.manager.spawn({ prompt: "watch me", title: "visible failure", cwd: "/tmp/project", visible: true });
		backend.paneEmitters[0]?.({ kind: "turn-finished", finalText: "report before failure", at: 1_234 });
		await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledOnce());

		backend.paneEmitters[0]?.({ kind: "run-settled", outcome: { kind: "failed", errorText: "pane wrapper failed", partialText: "report before failure" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-visible-failure-1")?.status).toBe("error"));
		harness.setIdle(true);
		harness.fire("agent_end");

		expect(harness.sendMessage).toHaveBeenCalledTimes(2);
		expect(harness.sendMessage.mock.calls[1]?.[0]).toMatchObject({ content: expect.stringContaining("pane wrapper failed") });
	});

	it("drops a stale queued turn card when terminal failure wins the busy-parent race", async () => {
		const harness = createHarness();
		harness.fire("session_start");
		harness.setIdle(false);
		harness.fire("agent_start");
		await harness.manager.spawn({ prompt: "watch me", title: "visible race", cwd: "/tmp/project", visible: true });
		backend.paneEmitters[0]?.({ kind: "turn-finished", finalText: "stale report", at: 1_234 });
		backend.paneEmitters[0]?.({ kind: "run-settled", outcome: { kind: "failed", errorText: "late failure", partialText: "stale report" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-visible-race-1")?.status).toBe("error"));

		harness.setIdle(true);
		harness.fire("agent_end");

		expect(harness.sendMessage).toHaveBeenCalledOnce();
		expect(harness.sendMessage.mock.calls[0]?.[0]).toMatchObject({ content: expect.stringContaining("late failure") });
	});

	it("delivers a changed final response that exits before another idle poll", async () => {
		const harness = createHarness();
		harness.fire("session_start");
		await harness.manager.spawn({ prompt: "watch me", title: "visible final", cwd: "/tmp/project", visible: true });
		backend.paneEmitters[0]?.({ kind: "turn-finished", finalText: "first report", at: 1_234 });
		await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledOnce());

		backend.paneEmitters[0]?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "final report" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-visible-final-1")?.status).toBe("done"));
		harness.setIdle(true);
		harness.fire("agent_end");

		expect(harness.sendMessage).toHaveBeenCalledTimes(2);
		expect(harness.sendMessage.mock.calls[1]?.[0]).toMatchObject({ content: expect.stringContaining("final report") });
	});

	it("routes visible children through the pane backend and delivers one pane-referenced card", async () => {
		const harness = createHarness();
		harness.setIdle(false);
		harness.fire("agent_start");
		await harness.manager.spawn({ prompt: "watch me", title: "visible worker", cwd: "/tmp/project", visible: true });
		expect(backend.paneCalls).toHaveLength(1);
		expect(backend.piCalls).toBe(0);
		expect(harness.manager.get("sa-visible-worker-1")?.pane).toEqual({ agentName: "visible-worker-abc", workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p3" });
		// Full-toolset parent: no --tools narrowing (pi --tools would strip the
		// child's extension tools), and no model/thinking was set or inherited.
		expect(backend.paneCalls[0]?.tools).toBeUndefined();

		backend.paneEmitters[0]?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "visible result" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-visible-worker-1")?.status).toBe("done"));
		harness.setIdle(true);
		harness.fire("agent_end");
		harness.fire("agent_end");

		expect(harness.sendMessage).toHaveBeenCalledOnce();
		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "subagent-result",
				content: expect.stringContaining("Pane: w1:p3 · agent visible-worker-abc"),
				details: expect.objectContaining({ pane: { agentName: "visible-worker-abc", workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p3" } }),
			}),
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});

	it("visible children inherit parent model/thinking and narrow with a narrowed parent", async () => {
		const harness = createHarness();
		await harness.manager.spawn({
			prompt: "restricted work",
			title: "narrow child",
			cwd: "/tmp/project",
			visible: true,
			inherited: { model: { provider: "openai-codex", id: "gpt-5.6-sol" }, thinking: "high" },
			tools: ["read", "grep"],
		});
		expect(backend.paneCalls).toHaveLength(1);
		expect(backend.paneCalls[0]?.model).toBe("openai-codex/gpt-5.6-sol");
		expect(backend.paneCalls[0]?.thinking).toBe("high");
		// Narrowed parent (--tools read,grep) => narrowed child allowlist.
		expect(backend.paneCalls[0]?.tools).toEqual(["read", "grep"]);
	});

	it("flushes immediately when a reliable context reports the parent idle", async () => {
		const harness = createHarness();
		harness.fire("session_start");
		await spawn(harness.manager);

		backend.emitters[0]?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });

		await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledOnce());
	});

	it("does not deliver a settled result consumed through subagent_wait", async () => {
		const harness = createHarness();
		harness.setIdle(false);
		harness.fire("agent_start");
		await spawn(harness.manager);
		backend.emitters[0]?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "inline result" } });

		// SAFETY: the ctx double carries only the members subagent_wait reads.
		await harness.tool("subagent_wait").execute("tc", { ids: ["sa-worker-1"] }, undefined, undefined, harness.ctx as never);
		harness.setIdle(true);
		harness.fire("agent_end");

		expect(harness.manager.consumedIds.has("sa-worker-1")).toBe(true);
		expect(harness.sendMessage).not.toHaveBeenCalled();
	});

	it("does not deliver a result consumed through subagent_cancel", async () => {
		const harness = createHarness();
		harness.setIdle(false);
		harness.fire("agent_start");
		await spawn(harness.manager);

		await harness.tool("subagent_cancel").execute("tc", { ids: ["sa-worker-1"] });
		harness.setIdle(true);
		harness.fire("agent_end");

		expect(harness.manager.consumedIds.has("sa-worker-1")).toBe(true);
		expect(harness.sendMessage).not.toHaveBeenCalled();
	});

	it("delivers failed children with their reason and partial output", async () => {
		const harness = createHarness();
		harness.setIdle(false);
		harness.fire("agent_start");
		await spawn(harness.manager, "failing worker");
		backend.emitters[0]?.({
			kind: "run-settled",
			outcome: { kind: "failed", errorText: "pi killed by SIGKILL", partialText: "partial progress" },
		});
		await vi.waitFor(() => expect(harness.manager.get("sa-failing-worker-1")?.status).toBe("error"));

		harness.setIdle(true);
		harness.fire("agent_end");

		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "subagent-result",
				content: expect.stringMatching(/failed[.]\n\nError: pi killed by SIGKILL\n\npartial progress/),
				details: expect.objectContaining({ id: "sa-failing-worker-1", title: "failing worker", status: "error", manifest: expect.objectContaining({ exit: "failed" }) }),
			}),
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});

	it("keeps auto-delivery working across an in-process session switch", async () => {
		const harness = createHarness();
		await harness.fireSessionStart("test-session", "/tmp/test-session.jsonl");
		// Simulate repeated binding defensively; real Pi 0.80.6 recreates the
		// factory on replacement and RPC mode may bind the new instance twice.
		harness.fire("session_shutdown", "new", "/tmp/next-session.jsonl");
		await harness.fireSessionStart("next-session", "/tmp/next-session.jsonl");
		harness.setIdle(false);
		await spawn(harness.manager, "post-switch");
		backend.emitters.at(-1)?.({ kind: "message-end", role: "assistant", text: "after switch" });
		backend.emitters.at(-1)?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "after switch" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-post-switch-1")?.status).toBe("done"));
		harness.fire("agent_end");
		expect(harness.sendMessage).toHaveBeenCalledTimes(1);
		// SAFETY: sendMessage is always called with a single message payload argument.
		expect((harness.sendMessage.mock.calls[0] as unknown[])[0]).toMatchObject({ customType: "subagent-result" });
	});

	it("does not deliver stale pre-switch settlements into the new session", async () => {
		const harness = createHarness();
		harness.setIdle(false);
		await spawn(harness.manager, "pre-switch");
		// Child is still running when the session switches; disposeAll interrupts
		// it and the fold lands AFTER shutdown (real SIGTERM timing).
		const dispose = vi.spyOn(harness.manager, "disposeAll");
		harness.fire("session_shutdown");
		expect(dispose).toHaveBeenCalledOnce();
		backend.emitters.at(-1)?.({ kind: "run-settled", outcome: { kind: "interrupted" } });
		harness.fire("session_start");
		harness.fire("agent_end");
		expect(harness.sendMessage).not.toHaveBeenCalled();
	});

	it("does not auto-deliver a synchronously failed spawn already reported inline", async () => {
		const harness = createHarness();
		harness.setIdle(false);
		const spawnTool = harness.tool("subagent_spawn");
		// Force a synchronous settle-as-failed through an invalid model override.
			// SAFETY: the ctx double carries only the members subagent_spawn reads.
			const result = await spawnTool.execute("tc", { prompt: "p", name: "doomed", model: "sync-fail" }, undefined, undefined, harness.ctx as never);
			const text = result.content[0]!.text;
		expect(text).toContain("failed to start");
		harness.fire("agent_end");
		expect(harness.sendMessage).not.toHaveBeenCalled();
	});

	it("cancelling an unknown id does not poison a later real child with that id", async () => {
		const harness = createHarness();
		harness.setIdle(false);
		// Cancel sa-real-sa-1-1 before it exists — manager reports unknown, and the
		// delivery buffer must NOT record sa-real-sa-1-1 as consumed.
			// SAFETY: the ctx double carries only the members subagent_cancel reads.
			await harness.tool("subagent_cancel").execute("tc", { ids: ["sa-real-sa-1-1"] }, undefined, undefined, harness.ctx as never);
		// Now the real sa-real-sa-1-1 spawns, settles, and must still auto-deliver.
		await spawn(harness.manager, "real-sa-1");
		backend.emitters.at(-1)?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-real-sa-1-1")?.status).toBe("done"));
		harness.fire("agent_end");
		expect(harness.sendMessage).toHaveBeenCalledTimes(1);
		// SAFETY: sendMessage is always called with a single message payload argument.
		expect((harness.sendMessage.mock.calls[0] as unknown[])[0]).toMatchObject({ customType: "subagent-result" });
	});

	it("offers a pending replacement only to Pi's target session file", async () => {
		const origin = createHarness();
		const unrelated = createHarness();
		const successor = createHarness();
		await origin.fireSessionStart("origin", "/tmp/origin.jsonl");
		const unrelatedAdopt = vi.spyOn(unrelated.manager, "adoptFrom");
		const successorAdopt = vi.spyOn(successor.manager, "adoptFrom");

		origin.fire("session_shutdown", "new", "/tmp/successor.jsonl");
		await unrelated.fireSessionStart("unrelated", "/tmp/unrelated.jsonl");
		expect(unrelatedAdopt).not.toHaveBeenCalled();

		await successor.fireSessionStart("successor", "/tmp/successor.jsonl");
		expect(successorAdopt).toHaveBeenCalledExactlyOnceWith(origin.manager, "successor");
	});

	it.each(["symlink", "relative"])("adopts Pi's exact shutdown target once for a %s resume path across cwd changes", async (pathKind) => {
		const f = await retainedHarness();
		const successor = createHarness(false, "rpc", { managerDependencies: { processOperations: f.operations } });
		const successorAdopt = vi.spyOn(successor.manager, "adoptFrom");
		const sessions = join(f.root, "sessions");
		const nextCwd = join(f.root, "next-project");
		mkdirSync(sessions);
		mkdirSync(nextCwd);
		symlinkSync(sessions, join(f.root, "alias"), "dir");
		const id = "11111111-2222-4333-8444-555555555555";
		writeFileSync(join(sessions, "next.jsonl"), `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: nextCwd })}\n`);
		const inputPath = pathKind === "symlink" ? join(f.root, "alias", "next.jsonl") : relative(process.cwd(), join(sessions, "next.jsonl"));
		f.origin.ctx.cwd = f.root;
		let shutdownTarget: string | undefined;
		// SAFETY: the Pi double implements only switchSession's outgoing session/services boundary; the actual path and replacement orchestration are Pi-owned.
		const runtime = new AgentSessionRuntime({
			sessionFile: f.origin.ctx.sessionManager.getSessionFile(), abort: async () => undefined, dispose: () => undefined,
			extensionRunner: {
				hasHandlers: (event: string) => event === "session_shutdown",
				emit: async (event: SessionShutdownEvent) => {
					shutdownTarget = event.targetSessionFile;
					f.origin.fire("session_shutdown", event.reason, event.targetSessionFile);
				},
			},
		} as never,
		// SAFETY: switchSession reads only cwd and agentDir from these outgoing services.
		{ cwd: f.root, agentDir: join(f.root, "agent") } as never,
		async ({ sessionManager }) => {
			const file = sessionManager.getSessionFile()!;
			expect(shutdownTarget).toBe(file);
			expect(sessionManager.getCwd()).toBe(nextCwd);
			if (pathKind === "symlink") expect(file).not.toBe(realpathSync(file));
			successor.ctx.cwd = sessionManager.getCwd();
			await successor.fireSessionStart(sessionManager.getSessionId(), file);
			// SAFETY: without rebind/withSession, Pi apply needs only session and services; path identity came from the real SessionManager.
			return { session: { sessionManager, sessionFile: file }, services: { cwd: nextCwd, agentDir: join(f.root, "agent") }, diagnostics: [] } as never;
		});
		try {
			await runtime.switchSession(inputPath);
			await successor.fireSessionStart(id, shutdownTarget!);
			expect(successorAdopt).toHaveBeenCalledExactlyOnceWith(f.origin.manager, id);
			expect(f.origin.manager.list()).toEqual([]);
			expect(successor.manager.get(f.record.id)).toMatchObject({ status: "running", recovery: "adopted" });
			expect(f.registry.get(f.record.id)?.controllerSessionId).toBe(id);
			expect(f.interrupt).not.toHaveBeenCalled();
			expect(f.operations.signalTree).not.toHaveBeenCalled();
		} finally { f.origin.manager.detachForReplacement(); successor.manager.detachForReplacement(); }
	});

	it("parks a different target without mutating retained records and diagnoses without path dumps", async () => {
		const f = await retainedHarness();
		const unrelated = createHarness();
		const successor = createHarness(false, "rpc", { managerDependencies: { processOperations: f.operations } });
		const target = join(f.root, "not-created-yet.jsonl");
		const diagnosticFile = join(f.root, "diagnostics.jsonl");
		const detach = vi.spyOn(f.origin.manager, "detachForReplacement");
		const unrelatedAdopt = vi.spyOn(unrelated.manager, "adoptFrom");
		const successorAdopt = vi.spyOn(successor.manager, "adoptFrom");
		f.origin.fire("session_shutdown", "new", target);
		vi.stubEnv("SUMO_TUI_DIAG_FILE", diagnosticFile);
		try {
			await unrelated.fireSessionStart("unrelated", join(f.root, "different.jsonl"));
			expect(unrelatedAdopt).not.toHaveBeenCalled();
			expect(detach).not.toHaveBeenCalled();
			expect(f.registry.get(f.record.id)).toEqual(f.record);
			expect(f.origin.manager.get(f.record.id)?.status).toBe("running");
			expect(f.listeners.size).toBe(1);
			const diagnostic = readFileSync(diagnosticFile, "utf8");
			expect(diagnostic).toContain('"event":"subagent_replacement_parked"');
			expect(diagnostic).toContain('"target":"session-file"');
			expect(diagnostic).not.toMatch(/not-created-yet|different\.jsonl|origin|writer-birth/u);
			expect(diagnostic).not.toContain(f.root);
			// A new Pi session may not have a file yet. Exact target identity still
			// suffices; do not guess a future realpath or expire the parked handoff.
			await successor.fireSessionStart("successor", target);
			await successor.fireSessionStart("successor", target);
			expect(successorAdopt).toHaveBeenCalledExactlyOnceWith(f.origin.manager, "successor");
			expect(f.interrupt).not.toHaveBeenCalled();
			expect(f.operations.signalTree).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllEnvs();
			f.origin.manager.detachForReplacement();
			successor.manager.detachForReplacement();
			unrelated.manager.disposeAll();
		}
	});

	it("limits a targetless reload fallback to the same session id", async () => {
		const origin = createHarness();
		const unrelated = createHarness();
		const successor = createHarness();
		await origin.fireSessionStart("origin", "/tmp/origin.jsonl");
		const unrelatedAdopt = vi.spyOn(unrelated.manager, "adoptFrom");
		const successorAdopt = vi.spyOn(successor.manager, "adoptFrom");

		origin.fire("session_shutdown", "reload");
		await unrelated.fireSessionStart("unrelated", "/tmp/origin.jsonl");
		expect(unrelatedAdopt).not.toHaveBeenCalled();

		await successor.fireSessionStart("origin", "/tmp/reloaded-origin.jsonl");
		expect(successorAdopt).toHaveBeenCalledExactlyOnceWith(origin.manager, "origin");
	});

	it("drops a failed replacement instead of retrying it on every session start", async () => {
		const origin = createHarness();
		const successor = createHarness();
		await origin.fireSessionStart("origin", "/tmp/origin.jsonl");
		origin.fire("session_shutdown", "new", "/tmp/replacement.jsonl");
		const adopt = vi.spyOn(successor.manager, "adoptFrom").mockRejectedValueOnce(new Error("retained subagent id conflicts with successor work"));

		await successor.fireSessionStart("replacement");
		await successor.fireSessionStart("replacement");

		expect(adopt).toHaveBeenCalledTimes(1);
	});

	it("contains corrupt retained recovery during session start and still flushes delivery", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "corrupt-recovery-")));
		chmodSync(root, 0o700);
		const retained = new SubagentRegistry(join(root, "registry"), "origin");
		writeFileSync(join(root, "registry", "sa-bad.json"), "{bad", { mode: 0o600 });
		const harness = createHarness(true, "tui", { retainedRegistry: retained });
		harness.setIdle(false);
		await spawn(harness.manager, "deferred worker");
		backend.emitters.at(-1)?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "deferred findings" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-deferred-worker-1")?.status).toBe("done"));
		harness.setIdle(true);
		await harness.fireSessionStart("replacement");
		expect(harness.sendMessage).toHaveBeenCalledTimes(1);
	});
});

it("forwards the surface to a visible child only when it must bound it", async () => {
	// Hermetic: no adapter is discoverable, so this test cannot flip on whether
	// the host machine happens to have pi-mcp-adapter installed.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sumocode-index-mcp-")));
	vi.stubEnv("HOME", root);
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
	vi.stubEnv("SUMOCODE_STATE_DIR", join(root, "state"));
	vi.stubEnv("SUMOCODE_MCP_ADAPTER", "");
	try {
		// Full built-in surface, no gateway anywhere: the child keeps its own
		// extension tools, so no allowlist is forwarded.
		const plain = createHarness(false, "tui", { activeTools: [...BUILT_IN_TOOLS] });
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const plainCtx = plain.ctx as never;
		await plain.tool("subagent_spawn").execute("tc", { prompt: "p", name: "plain", visible: true }, undefined, undefined, plainCtx);
		expect(backend.paneCalls.at(-1)?.tools).toBeUndefined();

		// A narrowed parent must still bound its child.
		const narrowed = createHarness(false, "tui", { activeTools: ["read"] });
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const narrowedCtx = narrowed.ctx as never;
		await narrowed.tool("subagent_spawn").execute("tc", { prompt: "p", name: "narrow", visible: true }, undefined, undefined, narrowedCtx);
		expect(backend.paneCalls.at(-1)?.tools).toEqual(["read"]);

		// A role that opted out must be bounded too, or the child's own extension
		// discovery would hand back the gateway its role refused.
		// The default role loader reads roles.json from the stubbed agent dir.
		mkdirSync(join(root, "agent", "sumocode"), { recursive: true, mode: 0o700 });
		writeFileSync(join(root, "agent", "sumocode", "roles.json"), JSON.stringify({ roles: [
			{ id: "off", label: "Off", description: "no mcp", systemPrompt: "off", tools: [...BUILT_IN_TOOLS], mcpServers: [] },
		] }), { mode: 0o600 });
		const optedOut = createHarness(false, "tui", { activeTools: [...BUILT_IN_TOOLS, "mcp"] });
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const optedOutCtx = optedOut.ctx as never;
		await optedOut.tool("subagent_spawn").execute("tc", { prompt: "p", name: "off", role: "off", visible: true }, undefined, undefined, optedOutCtx);
		expect(backend.paneCalls.at(-1)?.tools).toEqual([...BUILT_IN_TOOLS]);

		// A grant the resolver could not mount is NOT a refusal: this session has
		// the gateway, so the child's own discovery is no wider than its parent,
		// and fencing here would strip its extensions for nothing.
		const degraded = createHarness(false, "tui", { activeTools: [...BUILT_IN_TOOLS, "mcp"] });
		// SAFETY: the ctx double carries only the fields the tool handlers read.
		const degradedCtx = degraded.ctx as never;
		await degraded.tool("subagent_spawn").execute("tc", { prompt: "p", name: "degraded", visible: true }, undefined, undefined, degradedCtx);
		expect(backend.paneCalls.at(-1)?.tools).toBeUndefined();
	} finally {
		vi.unstubAllEnvs();
	}
});
