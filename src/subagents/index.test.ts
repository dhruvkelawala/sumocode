import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredResultDelivery, type DeferredResultDelivery } from "./delivery.js";
import type { SubagentEvent } from "./domain.js";
import { flushDeferredResultDelivery, installSubagents } from "./index.js";

const backend = vi.hoisted(() => ({
	emitters: [] as Array<(event: SubagentEvent) => void>,
}));

vi.mock("./manifest.js", () => ({
	buildCompletionManifest: vi.fn(async (options: { baseRef: string; outcome: { kind: "completed" | "failed" | "interrupted" }; worktree?: { path: string; branch: string } }) => ({
		baseRef: options.baseRef,
		headRef: "host-head",
		branch: options.worktree?.branch,
		worktreePath: options.worktree?.path,
		changedPaths: options.worktree ? ["src/a.ts"] : [],
		dirty: false,
		commits: options.worktree ? 1 : 0,
		exit: options.outcome.kind,
		durationMs: 10,
	})),
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
				else emit({ kind: "run-started" });
			},
			interrupt: vi.fn(() => emitEvent?.({ kind: "run-settled", outcome: { kind: "interrupted" } })),
			sessionFilePath: "/tmp/child-session.jsonl",
		};
	}),
}));

type Handler = (event: unknown, ctx: unknown) => void;
type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };

const createHarness = (delivery?: DeferredResultDelivery) => {
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
	const manager = installSubagents(pi as never, delivery);
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
	it("flushes a shared typed terminal payload exactly once across a session switch", () => {
		const delivery = createDeferredResultDelivery();
		const harness = createHarness(delivery);
		harness.fire("session_start");
		harness.setIdle(false);
		harness.fire("agent_start");
		const details = { id: "bg-7", title: "server", status: "completed", exitCode: 0 };
		delivery.defer("bg-7", () => ({
			id: "bg-7",
			customType: "terminal-result",
			title: "server",
			status: "completed",
			content: "Background terminal bg-7 exited (0).",
			details,
		}));
		flushDeferredResultDelivery(delivery);
		expect(harness.sendMessage).not.toHaveBeenCalled();

		harness.fire("session_shutdown");
		harness.setIdle(true);
		harness.fire("session_start");

		expect(harness.sendMessage).toHaveBeenCalledOnce();
		expect(harness.sendMessage).toHaveBeenCalledWith(
			{
				customType: "terminal-result",
				content: "Background terminal bg-7 exited (0).",
				display: true,
				details,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		harness.fire("agent_end");
		expect(harness.sendMessage).toHaveBeenCalledOnce();
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
				details: {
					id: "sa-1",
					title: "research",
					status: "done",
					manifest: expect.objectContaining({ changedPaths: [] }),
				},
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		const delivered = (harness.sendMessage.mock.calls[0] as unknown[])[0] as { content: string };
		expect(delivered.content).toContain("```text\nshared checkout · base HEAD · +0 checkout commits · changed paths suppressed · checkout clean\n```");

		harness.setIdle(true);
		harness.fire("agent_end");
		expect(harness.sendMessage).toHaveBeenCalledOnce();
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
		// In-process switch: shutdown fires but the extension instance survives.
		harness.fire("session_shutdown");
		harness.fire("session_start");
		harness.setIdle(false);
		await spawn(harness.manager, "post-switch");
		backend.emitters.at(-1)?.({ kind: "message-end", role: "assistant", text: "after switch" });
		backend.emitters.at(-1)?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "after switch" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-1")?.status).toBe("done"));
		harness.fire("agent_end");
		expect(harness.sendMessage).toHaveBeenCalledTimes(1);
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
		const result = await spawnTool.execute("tc", { prompt: "p", name: "doomed", model: "sync-fail" }, undefined, undefined, harness.ctx as never);
		const text = ((result as { content: Array<{ text: string }> }).content[0]).text;
		expect(text).toContain("failed to start");
		harness.fire("agent_end");
		expect(harness.sendMessage).not.toHaveBeenCalled();
	});

	it("cancelling an unknown id does not poison a later real child with that id", async () => {
		const harness = createHarness();
		harness.setIdle(false);
		// Cancel sa-1 before it exists — manager reports unknown, and the
		// delivery buffer must NOT record sa-1 as consumed.
		await harness.tool("subagent_cancel").execute("tc", { ids: ["sa-1"] }, undefined, undefined, harness.ctx as never);
		// Now the real sa-1 spawns, settles, and must still auto-deliver.
		await spawn(harness.manager, "real-sa-1");
		backend.emitters.at(-1)?.({ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } });
		await vi.waitFor(() => expect(harness.manager.get("sa-1")?.status).toBe("done"));
		harness.fire("agent_end");
		expect(harness.sendMessage).toHaveBeenCalledTimes(1);
		expect((harness.sendMessage.mock.calls[0] as unknown[])[0]).toMatchObject({ customType: "subagent-result" });
	});
});
