import { beforeEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_MAX_RUNNING, type SubagentEvent } from "./domain.js";
import type { SpawnedChild } from "./backend-pi.js";
import type { TerminalHost } from "../terminal-host/types.js";
import { installSubagents } from "./index.js";

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
type HandlerCtx = { cwd: string; model?: { provider: string; id: string }; isIdle?: () => boolean };
type Handler = (event: { type: string }, ctx: HandlerCtx) => void;

/** Tool result shape the tests inspect. */
interface ToolResult {
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
}

/** Minimal tool-definition shape captured from registerTool. */
type Tool = { name: string; execute: (...args: unknown[]) => Promise<ToolResult> };

const createHarness = (hasUI = false, mode: "tui" | "rpc" = "tui") => {
	let idle = true;
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, Tool>();
	const sendMessage = vi.fn(() => { idle = false; });
	const setWidget = vi.fn();
	const pi = {
		on: vi.fn((event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler])),
		registerTool: vi.fn((tool: Tool) => tools.set(tool.name, tool)),
		sendMessage,
		getActiveTools: vi.fn((): string[] => ["read", "bash"]),
		getThinkingLevel: vi.fn((): string => "medium"),
	};
	// SAFETY: the double implements every ExtensionAPI member installSubagents touches.
	const manager = installSubagents(pi as never, {
		terminalHost: fakeTerminalHost(),
		spawnPaneChild: fakeSpawnPaneChild,
		spawnPiChild: fakeSpawnPiChild,
		managerDependencies: { buildCompletionManifest: fakeBuildCompletionManifest },
	});
	const ctx = {
		cwd: "/tmp/project",
		mode,
		model: { provider: "openai", id: "gpt-5" },
		isIdle: () => idle,
		hasUI,
		ui: { setWidget },
	};
	const fire = (event: string) => {
		for (const handler of handlers.get(event) ?? []) handler({ type: event }, ctx);
	};
	return {
		manager,
		sendMessage,
		setWidget,
		tool: (name: string) => tools.get(name)!,
		ctx,
		fire,
		setIdle: (value: boolean) => { idle = value; },
	};
};

const spawn = (manager: ReturnType<typeof installSubagents>, title = "worker") => manager.spawn({
	prompt: "do the work",
	title,
	cwd: "/tmp/project",
});

beforeEach(() => {
	backend.emitters.length = 0;
	backend.paneEmitters.length = 0;
	backend.piCalls = 0;
	backend.paneCalls.length = 0;
	fakeSpawnPaneChild.mockClear();
	fakeSpawnPiChild.mockClear();
});

describe("subagent result delivery", () => {
	it("sets the status widget while active and clears it after the last settlement", async () => {
		const harness = createHarness(true);
		harness.fire("session_start");
		expect(harness.setWidget).not.toHaveBeenCalled();
		await spawn(harness.manager, "research");
		expect(harness.setWidget).toHaveBeenCalledWith("sumocode-subagents", expect.any(Function), { placement: "aboveEditor" });

		backend.emitters[0]?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-1")?.status).toBe("done"));
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
		expect((widget as string[]).join("\n")).toContain("sa-1 research");
	});

	it("renders queued count and clears the widget on shutdown", async () => {
		const harness = createHarness(true);
		harness.fire("session_start");
		for (let index = 0; index < SUBAGENT_MAX_RUNNING; index += 1) await spawn(harness.manager, `running-${index}`);
		await spawn(harness.manager, "queued");
		// SAFETY: the RPC setWidget contract delivers a component factory with a render method.
		const factory = harness.setWidget.mock.calls.at(-1)?.[1] as (() => { render(width: number): string[] });
		expect(factory().render(140).join("\n")).toContain("1 queued");

		harness.fire("session_shutdown");
		expect(harness.setWidget).toHaveBeenLastCalledWith("sumocode-subagents", undefined, { placement: "aboveEditor" });
		await vi.waitFor(() => expect(harness.manager.list().slice(0, SUBAGENT_MAX_RUNNING + 1).every((snapshot) => snapshot.status === "error")).toBe(true));
		expect(backend.piCalls).toBe(SUBAGENT_MAX_RUNNING);

		harness.fire("session_start");
		await expect(spawn(harness.manager, "next session")).resolves.toMatchObject({ id: `sa-${SUBAGENT_MAX_RUNNING + 2}`, status: "running" });
		harness.fire("session_shutdown");
	});

	it("never calls setWidget without UI", async () => {
		const harness = createHarness(false);
		harness.fire("session_start");
		await spawn(harness.manager);
		backend.emitters[0]?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-1")?.status).toBe("done"));
		harness.fire("session_shutdown");
		expect(harness.setWidget).not.toHaveBeenCalled();
	});

	it("keeps settlement working when setWidget throws", async () => {
		const harness = createHarness(true);
		harness.setWidget.mockImplementation(() => { throw new Error("ui gone"); });
		harness.fire("session_start");
		await expect(spawn(harness.manager)).resolves.toMatchObject({ status: "running" });
		backend.emitters[0]?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-1")?.status).toBe("done"));
	});

	it("does not deliver a queued snapshot as a settled result", async () => {
		const harness = createHarness();
		harness.setIdle(false);
		for (let index = 0; index < SUBAGENT_MAX_RUNNING; index += 1) await spawn(harness.manager, `running-${index}`);
		const queued = await spawn(harness.manager, "queued");
		expect(queued).toMatchObject({ id: `sa-${SUBAGENT_MAX_RUNNING + 1}`, status: "queued" });
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
		await vi.waitFor(() => expect(harness.manager.get("sa-1")?.status).toBe("done"));
		expect(harness.sendMessage).not.toHaveBeenCalled();

		harness.setIdle(true);
		harness.fire("agent_end");
		expect(harness.sendMessage).toHaveBeenCalledOnce();
		expect(harness.sendMessage).toHaveBeenCalledWith(
			{
				customType: "subagent-result",
				content: expect.stringContaining('Subagent sa-1 "research" finished.'),
				display: true,
				details: expect.objectContaining({
					id: "sa-1",
					title: "research",
					status: "done",
					activity: expect.objectContaining({ id: "subagent:sa-1", kind: "subagent", status: "succeeded", result: { summary: "findings" } }),
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

	it("routes visible children through the pane backend and delivers one pane-referenced card", async () => {
		const harness = createHarness();
		harness.setIdle(false);
		harness.fire("agent_start");
		await harness.manager.spawn({ prompt: "watch me", title: "visible worker", cwd: "/tmp/project", visible: true });
		expect(backend.paneCalls).toHaveLength(1);
		expect(backend.piCalls).toBe(0);
		expect(harness.manager.get("sa-1")?.pane).toEqual({ agentName: "visible-worker-abc", workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p3" });
		// Full-toolset parent: no --tools narrowing (pi --tools would strip the
		// child's extension tools), and no model/thinking was set or inherited.
		expect(backend.paneCalls[0]?.tools).toBeUndefined();

		backend.paneEmitters[0]?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "visible result" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-1")?.status).toBe("done"));
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
			builtInTools: ["read", "grep"],
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
		await harness.tool("subagent_wait").execute("tc", { ids: ["sa-1"] }, undefined, undefined, harness.ctx as never);
		harness.setIdle(true);
		harness.fire("agent_end");

		expect(harness.manager.consumedIds.has("sa-1")).toBe(true);
		expect(harness.sendMessage).not.toHaveBeenCalled();
	});

	it("does not deliver a result consumed through subagent_cancel", async () => {
		const harness = createHarness();
		harness.setIdle(false);
		harness.fire("agent_start");
		await spawn(harness.manager);

		await harness.tool("subagent_cancel").execute("tc", { ids: ["sa-1"] });
		harness.setIdle(true);
		harness.fire("agent_end");

		expect(harness.manager.consumedIds.has("sa-1")).toBe(true);
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
		await vi.waitFor(() => expect(harness.manager.get("sa-1")?.status).toBe("error"));

		harness.setIdle(true);
		harness.fire("agent_end");

		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "subagent-result",
				content: expect.stringMatching(/failed[.]\n\nError: pi killed by SIGKILL\n\npartial progress/),
				details: expect.objectContaining({ id: "sa-1", title: "failing worker", status: "error", manifest: expect.objectContaining({ exit: "failed" }) }),
			}),
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});

	it("keeps auto-delivery working across an in-process session switch", async () => {
		const harness = createHarness();
		harness.fire("session_start");
		// Simulate repeated binding defensively; real Pi 0.80.6 recreates the
		// factory on replacement and RPC mode may bind the new instance twice.
		harness.fire("session_shutdown");
		harness.fire("session_start");
		harness.setIdle(false);
		await spawn(harness.manager, "post-switch");
		backend.emitters.at(-1)?.({ kind: "message-end", role: "assistant", text: "after switch" });
		backend.emitters.at(-1)?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "after switch" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-1")?.status).toBe("done"));
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
		harness.fire("session_shutdown");
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
		// Cancel sa-1 before it exists — manager reports unknown, and the
		// delivery buffer must NOT record sa-1 as consumed.
			// SAFETY: the ctx double carries only the members subagent_cancel reads.
			await harness.tool("subagent_cancel").execute("tc", { ids: ["sa-1"] }, undefined, undefined, harness.ctx as never);
		// Now the real sa-1 spawns, settles, and must still auto-deliver.
		await spawn(harness.manager, "real-sa-1");
		backend.emitters.at(-1)?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-1")?.status).toBe("done"));
		harness.fire("agent_end");
		expect(harness.sendMessage).toHaveBeenCalledTimes(1);
		// SAFETY: sendMessage is always called with a single message payload argument.
		expect((harness.sendMessage.mock.calls[0] as unknown[])[0]).toMatchObject({ customType: "subagent-result" });
	});
});
