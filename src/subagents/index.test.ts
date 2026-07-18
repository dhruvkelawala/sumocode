import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentEvent } from "./domain.js";
import { installSubagents } from "./index.js";

const backend = vi.hoisted(() => ({
	emitters: [] as Array<(event: SubagentEvent) => void>,
}));

vi.mock("./backend-pi.js", () => ({
	spawnPiChild: vi.fn((options: { model?: string }) => {
		let emitEvent: ((event: SubagentEvent) => void) | undefined;
		return {
			events: (emit: (event: SubagentEvent) => void) => {
				emitEvent = emit;
				backend.emitters.push(emit);
				// Mirror the real backend's synchronous settle-as-failed path
				// (invalid model override) for tests that need it.
				if (options.model === "sync-fail") emit({ kind: "run-settled", outcome: { kind: "failed", errorText: "invalid model" } });
			},
			interrupt: vi.fn(() => emitEvent?.({ kind: "run-settled", outcome: { kind: "interrupted" } })),
			sessionFilePath: "/tmp/child-session.jsonl",
		};
	}),
}));

type Handler = (event: unknown, ctx: unknown) => void;
type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };

const createHarness = () => {
	let idle = true;
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, Tool>();
	const sendMessage = vi.fn(() => { idle = false; });
	const pi = {
		on: vi.fn((event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler])),
		registerTool: vi.fn((tool: Tool) => tools.set(tool.name, tool)),
		sendMessage,
		getActiveTools: vi.fn(() => ["read", "bash"]),
		getThinkingLevel: vi.fn(() => "medium"),
	};
	const manager = installSubagents(pi as never);
	const ctx = {
		cwd: "/tmp/project",
		model: { provider: "openai", id: "gpt-5" },
		isIdle: () => idle,
	};
	const fire = (event: string) => {
		for (const handler of handlers.get(event) ?? []) handler({ type: event }, ctx);
	};
	return {
		manager,
		sendMessage,
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
});

describe("subagent result delivery", () => {
	it("defers while the parent is busy and flushes exactly once on agent_end", () => {
		const harness = createHarness();
		harness.setIdle(false);
		harness.fire("agent_start");
		spawn(harness.manager, "research");

		backend.emitters[0]?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "findings" } });
		expect(harness.sendMessage).not.toHaveBeenCalled();

		harness.setIdle(true);
		harness.fire("agent_end");
		expect(harness.sendMessage).toHaveBeenCalledOnce();
		expect(harness.sendMessage).toHaveBeenCalledWith(
			{
				customType: "subagent-result",
				content: expect.stringContaining('Subagent sa-1 "research" finished.'),
				display: true,
				details: { id: "sa-1", title: "research", status: "done" },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);

		harness.setIdle(true);
		harness.fire("agent_end");
		expect(harness.sendMessage).toHaveBeenCalledOnce();
	});

	it("flushes immediately when a reliable context reports the parent idle", () => {
		const harness = createHarness();
		harness.fire("session_start");
		spawn(harness.manager);

		backend.emitters[0]?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });

		expect(harness.sendMessage).toHaveBeenCalledOnce();
	});

	it("does not deliver a settled result consumed through subagent_wait", async () => {
		const harness = createHarness();
		harness.setIdle(false);
		harness.fire("agent_start");
		spawn(harness.manager);
		backend.emitters[0]?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "inline result" } });

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
		spawn(harness.manager);

		await harness.tool("subagent_cancel").execute("tc", { ids: ["sa-1"] });
		harness.setIdle(true);
		harness.fire("agent_end");

		expect(harness.manager.consumedIds.has("sa-1")).toBe(true);
		expect(harness.sendMessage).not.toHaveBeenCalled();
	});

	it("delivers failed children with their reason and partial output", () => {
		const harness = createHarness();
		harness.setIdle(false);
		harness.fire("agent_start");
		spawn(harness.manager, "failing worker");
		backend.emitters[0]?.({
			kind: "run-settled",
			outcome: { kind: "failed", errorText: "pi killed by SIGKILL", partialText: "partial progress" },
		});

		harness.setIdle(true);
		harness.fire("agent_end");

		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "subagent-result",
				content: expect.stringMatching(/failed[.]\n\nError: pi killed by SIGKILL\n\npartial progress/),
				details: { id: "sa-1", title: "failing worker", status: "error" },
			}),
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});

	it("keeps auto-delivery working across an in-process session switch", () => {
		const harness = createHarness();
		harness.fire("session_start");
		// In-process switch: shutdown fires but the extension instance survives.
		harness.fire("session_shutdown");
		harness.fire("session_start");
		harness.setIdle(false);
		spawn(harness.manager, "post-switch");
		backend.emitters.at(-1)?.({ kind: "message-end", role: "assistant", text: "after switch" });
		backend.emitters.at(-1)?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "after switch" } });
		harness.fire("agent_end");
		expect(harness.sendMessage).toHaveBeenCalledTimes(1);
		expect((harness.sendMessage.mock.calls[0] as unknown[])[0]).toMatchObject({ customType: "subagent-result" });
	});

	it("does not deliver stale pre-switch settlements into the new session", () => {
		const harness = createHarness();
		harness.setIdle(false);
		spawn(harness.manager, "pre-switch");
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
		const result = await spawnTool.execute("tc", { prompt: "p", name: "doomed", model: "sync-fail" }, undefined, undefined, harness.ctx as never);
		const text = ((result as { content: Array<{ text: string }> }).content[0]).text;
		expect(text).toContain("failed to start");
		harness.fire("agent_end");
		expect(harness.sendMessage).not.toHaveBeenCalled();
	});
});
