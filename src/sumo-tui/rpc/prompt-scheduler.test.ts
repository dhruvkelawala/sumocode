import { describe, expect, it, vi } from "vitest";
import { createRpcPromptScheduler, RpcPromptPreflightRejection } from "./prompt-scheduler.js";

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
	reject: (cause: unknown) => void;
}

function deferred(): Deferred {
	let resolve!: () => void;
	let reject!: (cause: unknown) => void;
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

	it("drains exactly one manual-compaction queued prompt on compaction_end after external busy clears", async () => {
		let externalBusy = true;
		const sent: string[] = [];
		const scheduler = createRpcPromptScheduler({
			getBusy: () => externalBusy,
			sendPrompt: async (message) => { sent.push(message); },
		});

		await expect(scheduler.submit("B")).resolves.toBe("queued");
		await expect(scheduler.submit("C")).resolves.toBe("queued");
		expect(sent).toEqual([]);
		expect(scheduler.getSnapshot().queuedMessages).toEqual(["B", "C"]);

		externalBusy = false;
		scheduler.handleAgentEvent({ type: "compaction_end" });
		await flush();

		expect(sent).toEqual(["B"]);
		expect(scheduler.getSnapshot().queuedMessages).toEqual(["C"]);
		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();
		expect(sent).toEqual(["B", "C"]);
	});

	it("does not drain active-run auto-compaction queues on compaction_end before agent_settled", async () => {
		let externalBusy = false;
		const sent: string[] = [];
		const scheduler = createRpcPromptScheduler({
			getBusy: () => externalBusy,
			sendPrompt: async (message) => { sent.push(message); },
		});

		scheduler.handleAgentEvent({ type: "agent_start" });
		externalBusy = true;
		await expect(scheduler.submit("B")).resolves.toBe("queued");

		externalBusy = false;
		scheduler.handleAgentEvent({ type: "compaction_end" });
		await flush();
		expect(sent).toEqual([]);
		expect(scheduler.getSnapshot().queuedMessages).toEqual(["B"]);

		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();
		expect(sent).toEqual(["B"]);
		expect(scheduler.getSnapshot().queuedMessages).toEqual([]);
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

	it("keeps the active dispatch owned when queued drafts are restored manually", async () => {
		const gate = deferred();
		const sent: string[] = [];
		const scheduler = createRpcPromptScheduler({
			sendPrompt: async (message) => {
				sent.push(message);
				await gate.promise;
			},
		});

		await expect(scheduler.submit("A")).resolves.toBe("sent");
		await expect(scheduler.submit("B")).resolves.toBe("queued");

		const restored = scheduler.restoreAll("");
		expect(restored).toEqual({ count: 1, text: "B" });
		expect(scheduler.getSnapshot()).toMatchObject({ busy: true, queuedMessages: [] });

		await expect(scheduler.submit("B edited")).resolves.toBe("queued");
		expect(sent).toEqual(["A"]);
		expect(scheduler.getSnapshot()).toMatchObject({ busy: true, queuedMessages: ["B edited"] });

		gate.resolve();
		await flush();
		expect(sent).toEqual(["A"]);

		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();
		expect(sent).toEqual(["A", "B edited"]);
		expect(scheduler.getSnapshot().queuedMessages).toEqual([]);
	});

	it("drains queued entries when agent_settled arrives before dispatch ack resolves", async () => {
		const gate = deferred();
		const sent: string[] = [];
		const scheduler = createRpcPromptScheduler({
			sendPrompt: async (message) => {
				sent.push(message);
				await gate.promise;
			},
		});

		await expect(scheduler.submit("A")).resolves.toBe("sent");
		await expect(scheduler.submit("B")).resolves.toBe("queued");
		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();
		expect(sent).toEqual(["A"]);
		expect(scheduler.getSnapshot().queuedMessages).toEqual(["B"]);

		gate.resolve();
		await flush();
		expect(sent).toEqual(["A", "B"]);
		expect(scheduler.getSnapshot().queuedMessages).toEqual([]);
	});

	it("leaves drafts unchanged when restore is empty", () => {
		const scheduler = createRpcPromptScheduler({ sendPrompt: async () => undefined });
		expect(scheduler.restoreAll("draft")).toEqual({ count: 0, text: "draft" });
	});

	it("requeues failed dispatches at the head and ignores idle forced follow-ups while paused", async () => {
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

		await expect(scheduler.submit("D", { forceQueue: true })).resolves.toBe("ignored");
		expect(scheduler.getSnapshot()).toMatchObject({ queuedMessages: ["B", "C"], pausedAfterFailure: true });

		await expect(scheduler.submit("D")).resolves.toBe("queued");
		await flush();
		expect(sent).toEqual(["B", "B"]);
		expect(scheduler.getSnapshot().queuedMessages).toEqual(["C", "D"]);

		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();
		expect(sent).toEqual(["B", "B", "C"]);
		expect(scheduler.getSnapshot().queuedMessages).toEqual(["D"]);
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

	it("ignores forced follow-ups while paused even when external state is busy", async () => {
		let externalBusy = false;
		const sent: string[] = [];
		const scheduler = createRpcPromptScheduler({
			getBusy: () => externalBusy,
			sendPrompt: async (message) => {
				sent.push(message);
				throw new Error("preflight failed");
			},
		});

		scheduler.handleAgentEvent({ type: "agent_start" });
		await scheduler.submit("B");
		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();
		expect(scheduler.getSnapshot()).toMatchObject({ queuedMessages: ["B"], pausedAfterFailure: true });

		externalBusy = true;
		await expect(scheduler.submit("D", { forceQueue: true })).resolves.toBe("ignored");
		expect(sent).toEqual(["B"]);
		expect(scheduler.getSnapshot()).toMatchObject({ busy: true, queuedMessages: ["B"], pausedAfterFailure: true });
	});

	it("keeps busy true when agent_start arrives before dispatch failure", async () => {
		const gate = deferred();
		const scheduler = createRpcPromptScheduler({ sendPrompt: async () => gate.promise });

		await expect(scheduler.submit("A")).resolves.toBe("sent");
		scheduler.handleAgentEvent({ type: "agent_start" });
		gate.reject(new Error("late failure"));
		await flush();

		expect(scheduler.getSnapshot()).toMatchObject({ busy: true, queuedMessages: ["A"], pausedAfterFailure: true });
		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();
		expect(scheduler.getSnapshot()).toMatchObject({ busy: false, queuedMessages: ["A"], pausedAfterFailure: true });
	});

	it("can discard stale in-flight dispatch failures when restoring queued drafts during abort", async () => {
		const gate = deferred();
		const failures: unknown[] = [];
		const scheduler = createRpcPromptScheduler({
			sendPrompt: async () => gate.promise,
			onDispatchFailure: (error) => failures.push(error),
		});

		scheduler.handleAgentEvent({ type: "agent_start" });
		await scheduler.submit("B");
		await scheduler.submit("C");
		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();

		const restored = scheduler.restoreAll("draft", { discardInFlight: true });
		expect(restored).toEqual({ count: 1, text: "C\n\ndraft" });
		expect(scheduler.getSnapshot()).toMatchObject({ busy: false, queuedMessages: [] });

		gate.reject(new Error("abort failure"));
		await flush();
		expect(failures).toEqual([]);
		expect(scheduler.getSnapshot()).toMatchObject({ busy: false, queuedMessages: [] });
	});

	it("returns handled when a host command matches instead of queueing or sending", async () => {
		const sendPrompt = vi.fn(async () => undefined);
		const handleHostCommand = vi.fn(async (message: string) => message === "/model");
		const scheduler = createRpcPromptScheduler({ sendPrompt, handleHostCommand });

		await expect(scheduler.submit("/model", { forceQueue: true })).resolves.toBe("handled");
		expect(sendPrompt).not.toHaveBeenCalled();
		expect(scheduler.getSnapshot().queuedMessages).toEqual([]);
	});

	it("ignores a forced follow-up that becomes idle while async host command classification is pending", async () => {
		let resolveHostCommand!: (handled: boolean) => void;
		const hostCommand = new Promise<boolean>((resolve) => {
			resolveHostCommand = resolve;
		});
		const sendPrompt = vi.fn(async () => undefined);
		const handleHostCommand = vi.fn(() => hostCommand);
		const scheduler = createRpcPromptScheduler({ sendPrompt, handleHostCommand });

		scheduler.handleAgentEvent({ type: "agent_start" });
		const result = scheduler.submit("race follow-up", { forceQueue: true });
		await flush();
		expect(handleHostCommand).toHaveBeenCalledWith("race follow-up");

		scheduler.handleAgentEvent({ type: "agent_settled" });
		resolveHostCommand(false);
		await expect(result).resolves.toBe("ignored");
		await flush();

		expect(sendPrompt).not.toHaveBeenCalled();
		expect(scheduler.getSnapshot()).toMatchObject({ busy: false, queuedMessages: [] });
	});

	it("returns handled via forceQueue when a host command matches during a busy window", async () => {
		const sendPrompt = vi.fn(async () => undefined);
		const handleHostCommand = vi.fn(async (message: string) => message === "/theme");
		const scheduler = createRpcPromptScheduler({ sendPrompt, handleHostCommand });

		scheduler.handleAgentEvent({ type: "agent_start" });
		await expect(scheduler.submit("/theme", { forceQueue: true })).resolves.toBe("handled");
		expect(sendPrompt).not.toHaveBeenCalled();
		expect(scheduler.getSnapshot().queuedMessages).toEqual([]);
	});

	it("returns handled for a host command submitted without forceQueue when idle", async () => {
		const sendPrompt = vi.fn(async () => undefined);
		const handleHostCommand = vi.fn(async (message: string) => message === "/compact");
		const scheduler = createRpcPromptScheduler({ sendPrompt, handleHostCommand });

		await expect(scheduler.submit("/compact")).resolves.toBe("handled");
		expect(sendPrompt).not.toHaveBeenCalled();
		expect(scheduler.getSnapshot().queuedMessages).toEqual([]);
	});

	it("force-sends the FIFO head with steer and holds later entries until the steered lifecycle settles", async () => {
		const ack = deferred();
		const calls: Array<{ message: string; delivery?: unknown }> = [];
		const scheduler = createRpcPromptScheduler({
			canForceSteer: () => true,
			sendPrompt: async (message, delivery) => {
				calls.push({ message, delivery });
				if (delivery?.streamingBehavior === "steer") await ack.promise;
			},
		});

		scheduler.handleAgentEvent({ type: "agent_start" });
		await expect(scheduler.submit("B")).resolves.toBe("queued");
		await expect(scheduler.submit("C")).resolves.toBe("queued");

		const force = scheduler.forceSendNext();
		await flush();
		expect(calls).toEqual([{ message: "B", delivery: { streamingBehavior: "steer" } }]);
		expect(scheduler.getSnapshot().queuedMessages).toEqual(["C"]);

		// Pi's queue_update is the ownership transition for a real steer.
		scheduler.handleAgentEvent({ type: "queue_update", steering: ["expanded B"], followUp: [] });
		scheduler.handleAgentEvent({ type: "agent_settled" });
		ack.resolve();
		await expect(force).resolves.toBe("accepted");
		expect(calls).toHaveLength(1);
		expect(scheduler.getSnapshot().queuedMessages).toEqual(["C"]);

		// Pi may transform B before emitting its authoritative user lifecycle.
		scheduler.handleAgentEvent({ type: "turn_end" });
		scheduler.handleAgentEvent({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "expanded B" }] } });
		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();
		expect(calls).toEqual([
			{ message: "B", delivery: { streamingBehavior: "steer" } },
			{ message: "C" },
		]);
	});

	it("restores an explicitly rejected steered head and pauses the FIFO", async () => {
		const stateSync = vi.fn();
		const scheduler = createRpcPromptScheduler({
			canForceSteer: () => true,
			sendPrompt: async () => { throw new RpcPromptPreflightRejection("steering rejected"); },
			onDispatchStateSync: stateSync,
		});

		scheduler.handleAgentEvent({ type: "agent_start" });
		await scheduler.submit("B");
		await scheduler.submit("C");
		await expect(scheduler.forceSendNext()).rejects.toThrow("steering rejected");

		expect(scheduler.getSnapshot()).toMatchObject({
			queuedMessages: ["B", "C"],
			pausedAfterFailure: true,
		});
		expect(stateSync).toHaveBeenCalledOnce();
		await expect(scheduler.forceSendNext()).resolves.toBe("ignored");
	});

	it("keeps an ambiguous steered head removed, pauses draining, and reports unknown acceptance", async () => {
		const unknown: Array<{ message: string; error: unknown }> = [];
		const stateSync = vi.fn();
		const scheduler = createRpcPromptScheduler({
			canForceSteer: () => true,
			sendPrompt: async () => { throw new Error("prompt timeout"); },
			onDispatchStateSync: stateSync,
			onSteerAcceptanceUnknown: (message, error) => unknown.push({ message, error }),
		});

		scheduler.handleAgentEvent({ type: "agent_start" });
		await scheduler.submit("B");
		await scheduler.submit("C");
		await expect(scheduler.forceSendNext()).resolves.toBe("unknown");

		expect(scheduler.getSnapshot()).toMatchObject({
			queuedMessages: ["C"],
			pausedAfterFailure: true,
		});
		expect(unknown).toHaveLength(1);
		expect(unknown[0]).toMatchObject({ message: "B", error: expect.any(Error) });
		expect(stateSync).toHaveBeenCalledOnce();

		// A later ordinary submit clears the pause, but not the unknown ownership
		// barrier. The next host FIFO entry must remain held.
		await expect(scheduler.submit("D")).resolves.toBe("queued");
		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();
		expect(scheduler.getSnapshot()).toMatchObject({
			queuedMessages: ["C", "D"],
			pausedAfterFailure: false,
		});
	});

	it("does not drain the next entry when the current turn settles before steering acknowledgement", async () => {
		const ack = deferred();
		const sent: Array<{ message: string; delivery?: unknown }> = [];
		const scheduler = createRpcPromptScheduler({
			canForceSteer: () => true,
			sendPrompt: async (message, delivery) => {
				sent.push({ message, delivery });
				if (delivery?.streamingBehavior === "steer") await ack.promise;
			},
		});

		scheduler.handleAgentEvent({ type: "agent_start" });
		await scheduler.submit("B");
		await scheduler.submit("C");
		const force = scheduler.forceSendNext();
		await flush();
		// The current run settling before the RPC acknowledgement must not
		// release C: the acknowledgement still decides whether B entered Pi.
		scheduler.handleAgentEvent({ type: "queue_update", steering: ["expanded B"], followUp: [] });
		scheduler.handleAgentEvent({ type: "agent_settled" });
		ack.resolve();
		await expect(force).resolves.toBe("accepted");
		await flush();

		expect(sent).toHaveLength(1);
		expect(scheduler.getSnapshot().queuedMessages).toEqual(["C"]);

		// Lifecycle ordering, rather than text identity, releases the next entry.
		scheduler.handleAgentEvent({ type: "turn_end" });
		scheduler.handleAgentEvent({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "expanded B" }] } });
		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();
		expect(sent).toEqual([
			{ message: "B", delivery: { streamingBehavior: "steer" } },
			{ message: "C" },
		]);
	});

	it("holds the remaining FIFO when acceptance has no authoritative Pi disposition", async () => {
		const ack = deferred();
		let steerable = true;
		const sent: Array<{ message: string; delivery?: unknown }> = [];
		const scheduler = createRpcPromptScheduler({
			canForceSteer: () => steerable,
			sendPrompt: async (message, delivery) => {
				sent.push({ message, delivery });
				if (delivery?.streamingBehavior === "steer") await ack.promise;
			},
		});

		scheduler.handleAgentEvent({ type: "agent_start" });
		await scheduler.submit("B");
		await scheduler.submit("C");
		const force = scheduler.forceSendNext();
		await flush();

		// No queue_update or B lifecycle can mean either handled input or the
		// active-to-idle normal-start race. A's settlement must not release C.
		scheduler.handleAgentEvent({ type: "agent_settled" });
		ack.resolve();
		await expect(force).resolves.toBe("held");
		await flush();
		expect(sent).toEqual([{ message: "B", delivery: { streamingBehavior: "steer" } }]);
		expect(scheduler.getSnapshot().queuedMessages).toEqual(["C"]);

		// New ordinary input remains held. Command+Enter may still advance C:
		// Pi will atomically start it if idle or queue it if a run has started.
		await expect(scheduler.submit("D")).resolves.toBe("queued");
		steerable = false;
		await expect(scheduler.forceSendNext()).resolves.toBe("held");
		expect(sent).toEqual([
			{ message: "B", delivery: { streamingBehavior: "steer" } },
			{ message: "C", delivery: { streamingBehavior: "steer" } },
		]);
		expect(scheduler.getSnapshot().queuedMessages).toEqual(["D"]);
	});

	it("ignores user lifecycle events from the active turn before the steer boundary", async () => {
		const ack = deferred();
		const sent: Array<{ message: string; delivery?: unknown }> = [];
		const scheduler = createRpcPromptScheduler({
			canForceSteer: () => true,
			sendPrompt: async (message, delivery) => {
				sent.push({ message, delivery });
				if (delivery?.streamingBehavior === "steer") await ack.promise;
			},
		});

		scheduler.handleAgentEvent({ type: "agent_start" });
		await scheduler.submit("B");
		await scheduler.submit("C");
		const force = scheduler.forceSendNext();
		await flush();

		// A's delayed user message_start is before any post-dispatch turn_end, so
		// it must not become B's lifecycle boundary.
		scheduler.handleAgentEvent({ type: "message_start", message: { role: "user", content: "A" } });
		scheduler.handleAgentEvent({ type: "queue_update", steering: ["B"], followUp: [] });
		scheduler.handleAgentEvent({ type: "agent_settled" });
		ack.resolve();
		await expect(force).resolves.toBe("accepted");
		await flush();
		expect(sent).toEqual([{ message: "B", delivery: { streamingBehavior: "steer" } }]);
		expect(scheduler.getSnapshot().queuedMessages).toEqual(["C"]);

		scheduler.handleAgentEvent({ type: "turn_end" });
		scheduler.handleAgentEvent({ type: "message_start", message: { role: "user", content: "B" } });
		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();
		expect(sent).toEqual([
			{ message: "B", delivery: { streamingBehavior: "steer" } },
			{ message: "C" },
		]);
	});

	it("keeps the prior hold when a later manual force-send is rejected", async () => {
		let calls = 0;
		const scheduler = createRpcPromptScheduler({
			canForceSteer: () => calls === 0,
			sendPrompt: async (_message, delivery) => {
				if (delivery?.streamingBehavior !== "steer") return;
				calls += 1;
				if (calls === 2) throw new RpcPromptPreflightRejection("rejected");
			},
		});

		scheduler.handleAgentEvent({ type: "agent_start" });
		await scheduler.submit("B");
		await scheduler.submit("C");
		await scheduler.submit("D");
		await expect(scheduler.forceSendNext()).resolves.toBe("held");
		await expect(scheduler.forceSendNext()).rejects.toThrow("rejected");
		expect(scheduler.getSnapshot()).toMatchObject({
			queuedMessages: ["C", "D"],
			pausedAfterFailure: true,
		});

		// Adding input clears the rejection pause, but the older uncertain
		// disposition still prevents automatic drain.
		await expect(scheduler.submit("E")).resolves.toBe("queued");
		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();
		expect(scheduler.getSnapshot().queuedMessages).toEqual(["C", "D", "E"]);
	});

	it("records a normal-start force-send lifecycle even when agent_start arrives before acknowledgement", async () => {
		const ack = deferred();
		const sent: Array<{ message: string; delivery?: unknown }> = [];
		const scheduler = createRpcPromptScheduler({
			canForceSteer: () => true,
			sendPrompt: async (message, delivery) => {
				sent.push({ message, delivery });
				if (delivery?.streamingBehavior === "steer") await ack.promise;
			},
		});

		scheduler.handleAgentEvent({ type: "agent_start" });
		await scheduler.submit("B");
		await scheduler.submit("C");
		const force = scheduler.forceSendNext();
		await flush();

		// Pi became idle and started B normally before the prompt response reached
		// the host. The new agent_start still belongs to B, not A.
		scheduler.handleAgentEvent({ type: "agent_start" });
		scheduler.handleAgentEvent({ type: "message_start", message: { role: "user", content: "B" } });
		ack.resolve();
		await expect(force).resolves.toBe("held");
		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();
		expect(sent).toEqual([
			{ message: "B", delivery: { streamingBehavior: "steer" } },
			{ message: "C" },
		]);
	});

	it("resumes the FIFO after an unqueued force-send starts and settles a normal lifecycle", async () => {
		const sent: Array<{ message: string; delivery?: unknown }> = [];
		const scheduler = createRpcPromptScheduler({
			canForceSteer: () => true,
			sendPrompt: async (message, delivery) => { sent.push({ message, delivery }); },
		});

		scheduler.handleAgentEvent({ type: "agent_start" });
		await scheduler.submit("B");
		await scheduler.submit("C");
		await expect(scheduler.forceSendNext()).resolves.toBe("held");
		scheduler.handleAgentEvent({ type: "agent_settled" });
		expect(sent).toHaveLength(1);

		// Pi became idle and started B normally. Its lifecycle is authoritative,
		// so C can drain only after that lifecycle settles.
		scheduler.handleAgentEvent({ type: "agent_start" });
		scheduler.handleAgentEvent({ type: "message_start", message: { role: "user", content: "B" } });
		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();
		expect(sent).toEqual([
			{ message: "B", delivery: { streamingBehavior: "steer" } },
			{ message: "C" },
		]);
	});

	it("ignores force-send when empty, idle, paused, non-steerable, or already dispatching", async () => {
		const ack = deferred();
		let steerable = false;
		const sendPrompt = vi.fn(async (_message: string, delivery?: { streamingBehavior?: "steer" }) => {
			if (delivery?.streamingBehavior === "steer") await ack.promise;
		});
		const scheduler = createRpcPromptScheduler({ canForceSteer: () => steerable, sendPrompt });

		await expect(scheduler.forceSendNext()).resolves.toBe("ignored");
		await scheduler.submit("B");
		await expect(scheduler.forceSendNext()).resolves.toBe("ignored");
		scheduler.handleAgentEvent({ type: "agent_start" });
		await expect(scheduler.submit("C")).resolves.toBe("queued");
		await expect(scheduler.forceSendNext()).resolves.toBe("ignored");
		steerable = true;
		const first = scheduler.forceSendNext();
		await expect(scheduler.forceSendNext()).resolves.toBe("ignored");
		scheduler.handleAgentEvent({ type: "queue_update", steering: ["C"], followUp: [] });
		ack.resolve();
		await expect(first).resolves.toBe("accepted");
		expect(sendPrompt).toHaveBeenCalledTimes(2);
	});

	it("treats successful force-send acknowledgement after generation invalidation as unknown", async () => {
		const outcome = deferred();
		const unknown: string[] = [];
		const scheduler = createRpcPromptScheduler({
			canForceSteer: () => true,
			sendPrompt: async () => outcome.promise,
			onSteerAcceptanceUnknown: (message) => unknown.push(message),
		});

		scheduler.handleAgentEvent({ type: "agent_start" });
		await scheduler.submit("B");
		await scheduler.submit("C");
		const force = scheduler.forceSendNext();
		await flush();
		const restored = scheduler.restoreAll("draft", { discardInFlight: true });
		expect(restored).toEqual({ count: 1, text: "C\n\ndraft" });

		outcome.resolve();
		await expect(force).resolves.toBe("unknown");
		expect(scheduler.getSnapshot().queuedMessages).toEqual([]);
		expect(unknown).toEqual(["B"]);
	});

	it("does not claim a force-send entry was restored when generation invalidation races its outcome", async () => {
		const outcome = deferred();
		const unknown: string[] = [];
		const scheduler = createRpcPromptScheduler({
			canForceSteer: () => true,
			sendPrompt: async () => outcome.promise,
			onSteerAcceptanceUnknown: (message) => unknown.push(message),
		});

		scheduler.handleAgentEvent({ type: "agent_start" });
		await scheduler.submit("B");
		await scheduler.submit("C");
		const force = scheduler.forceSendNext();
		await flush();
		const restored = scheduler.restoreAll("draft", { discardInFlight: true });
		expect(restored).toEqual({ count: 1, text: "C\n\ndraft" });

		outcome.reject(new Error("stale timeout"));
		await expect(force).resolves.toBe("unknown");
		expect(scheduler.getSnapshot().queuedMessages).toEqual([]);
		expect(unknown).toEqual(["B"]);
	});
});
