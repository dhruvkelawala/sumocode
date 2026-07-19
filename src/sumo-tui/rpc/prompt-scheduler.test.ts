import { describe, expect, it, vi } from "vitest";
import { createRpcPromptScheduler } from "./prompt-scheduler.js";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("RpcPromptScheduler", () => {
	it("sends idle submits immediately and marks dispatch busy before awaiting preflight", async () => {
		const gate = deferred();
		const snapshots: boolean[] = [];
		const sendPrompt = vi.fn(async () => gate.promise);
		const scheduler = createRpcPromptScheduler({
			sendPrompt,
			onDispatchStart: () => snapshots.push(scheduler.getSnapshot().busy),
		});

		await expect(scheduler.submit("hello")).resolves.toBe("sent");
		expect(sendPrompt).toHaveBeenCalledWith("hello");
		expect(snapshots).toEqual([true]);
		expect(scheduler.getSnapshot().busy).toBe(true);

		gate.resolve();
		await flush();
		expect(scheduler.getSnapshot().busy).toBe(true);
	});

	it("queues busy submits without sending and drains one FIFO entry per agent_settled", async () => {
		const sent: string[] = [];
		const queues: string[][] = [];
		const scheduler = createRpcPromptScheduler({
			sendPrompt: async (message) => { sent.push(message); },
			onQueueChange: (messages) => queues.push([...messages]),
		});

		scheduler.handleAgentEvent({ type: "agent_start" });
		await expect(scheduler.submit("B")).resolves.toBe("queued");
		await expect(scheduler.submit("C")).resolves.toBe("queued");

		expect(sent).toEqual([]);
		expect(scheduler.getSnapshot().queuedMessages).toEqual(["B", "C"]);
		scheduler.handleAgentEvent({ type: "agent_end" });
		scheduler.handleAgentEvent({ type: "compaction_end" });
		await flush();
		expect(sent).toEqual([]);

		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();
		expect(sent).toEqual(["B"]);
		expect(scheduler.getSnapshot().queuedMessages).toEqual(["C"]);

		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();
		expect(sent).toEqual(["B", "C"]);
		expect(scheduler.getSnapshot().queuedMessages).toEqual([]);
		expect(queues).toEqual([["B"], ["B", "C"], ["C"], []]);
	});

	it("restores queued entries before the current draft and excludes an entry already in dispatch", async () => {
		const gate = deferred();
		const scheduler = createRpcPromptScheduler({ sendPrompt: async () => gate.promise });

		scheduler.handleAgentEvent({ type: "agent_start" });
		await scheduler.submit("B");
		await scheduler.submit("C");
		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();

		const restored = scheduler.restoreAll("draft");
		expect(restored).toEqual({ count: 1, text: "C\n\ndraft" });
		expect(scheduler.getSnapshot().queuedMessages).toEqual([]);

		gate.resolve();
		await flush();
	});

	it("leaves drafts unchanged when restore is empty", () => {
		const scheduler = createRpcPromptScheduler({ sendPrompt: async () => undefined });
		expect(scheduler.restoreAll("draft")).toEqual({ count: 0, text: "draft" });
	});

	it("requeues failed dispatches at the head and pauses automatic drain until an explicit trigger", async () => {
		const error = new Error("preflight failed");
		const failures: unknown[] = [];
		let fail = true;
		const sent: string[] = [];
		const scheduler = createRpcPromptScheduler({
			sendPrompt: async (message) => {
				sent.push(message);
				if (fail) throw error;
			},
			onDispatchFailure: (failure) => failures.push(failure),
		});

		scheduler.handleAgentEvent({ type: "agent_start" });
		await scheduler.submit("B");
		await scheduler.submit("C");
		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();

		expect(sent).toEqual(["B"]);
		expect(failures).toEqual([error]);
		expect(scheduler.getSnapshot()).toMatchObject({ queuedMessages: ["B", "C"], pausedAfterFailure: true });

		fail = false;
		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();
		expect(sent).toEqual(["B"]);

		await expect(scheduler.submit("D", { forceQueue: true })).resolves.toBe("queued");
		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();
		expect(sent).toEqual(["B", "B"]);
	});

	it("restores old generation entries on rebind so a later settle has nothing stale to deliver", async () => {
		const sent: string[] = [];
		const scheduler = createRpcPromptScheduler({ sessionId: "old", sendPrompt: async (message) => { sent.push(message); } });

		scheduler.handleAgentEvent({ type: "agent_start" });
		await scheduler.submit("old queued");
		const restored = scheduler.rebindSession("new", "new draft");

		expect(restored).toEqual({ count: 1, text: "old queued\n\nnew draft" });
		expect(scheduler.getSnapshot()).toMatchObject({ sessionId: "new", queuedMessages: [] });

		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();
		expect(sent).toEqual([]);
	});

	it("ignores stale in-flight dispatch failures after a session rebind", async () => {
		const gate = deferred();
		const failures: unknown[] = [];
		const scheduler = createRpcPromptScheduler({
			sessionId: "old",
			sendPrompt: async () => gate.promise,
			onDispatchFailure: (error) => failures.push(error),
		});

		await scheduler.submit("old dispatch");
		scheduler.rebindSession("new", "");
		scheduler.handleAgentEvent({ type: "agent_start" });
		gate.reject(new Error("stale failure"));
		await flush();

		expect(failures).toEqual([]);
		expect(scheduler.getSnapshot()).toMatchObject({ busy: true, queuedMessages: [] });
	});

	it("lets host commands take first refusal before queueing", async () => {
		const sendPrompt = vi.fn(async () => undefined);
		const handleHostCommand = vi.fn(async (message: string) => message === "/model");
		const scheduler = createRpcPromptScheduler({ sendPrompt, handleHostCommand });

		await expect(scheduler.submit("/model", { forceQueue: true })).resolves.toBe("ignored");
		expect(sendPrompt).not.toHaveBeenCalled();
		expect(scheduler.getSnapshot().queuedMessages).toEqual([]);
	});
});
