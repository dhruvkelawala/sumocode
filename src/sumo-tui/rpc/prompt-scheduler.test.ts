import { describe, expect, it, vi } from "vitest";
import { createRpcPromptScheduler, RpcPromptPreflightRejection, type RpcPromptDeliveryMode } from "./prompt-scheduler.js";

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("RpcPromptScheduler", () => {
	it("sends ordinary active-turn prompts directly to Pi with their selected delivery", async () => {
		const sendPrompt = vi.fn(async () => undefined);
		const scheduler = createRpcPromptScheduler({ sendPrompt, getBusy: () => true, getCompacting: () => false });

		await expect(scheduler.submit("steer now", { delivery: "steer" })).resolves.toBe("sent");
		await expect(scheduler.submit("later", { delivery: "followUp" })).resolves.toBe("sent");
		await flush();

		expect(sendPrompt.mock.calls).toEqual([
			["steer now", { streamingBehavior: "steer" }],
			["later", { streamingBehavior: "followUp" }],
		]);
		expect(scheduler.getSnapshot().queuedMessages).toEqual([]);
	});

	it("rejects attachments visibly instead of placing them in a lossy busy queue", async () => {
		const rejected = vi.fn();
		const sendPrompt = vi.fn(async () => undefined);
		const scheduler = createRpcPromptScheduler({
			getBusy: () => true,
			getCompacting: () => false,
			sendPrompt,
			onPreflightRejected: rejected,
		});

		await expect(scheduler.submit("inspect /tmp/pi-clipboard-image.png", { delivery: "steer" })).resolves.toBe("ignored");
		expect(sendPrompt).not.toHaveBeenCalled();
		expect(rejected).toHaveBeenCalledWith("inspect /tmp/pi-clipboard-image.png", expect.objectContaining({
			message: "attachments cannot be queued safely",
		}));
	});

	it("holds only compaction submissions and flushes their original delivery modes in order", async () => {
		let compacting = true;
		const sent: unknown[][] = [];
		const scheduler = createRpcPromptScheduler({
			getCompacting: () => compacting,
			sendPrompt: async (...args) => { sent.push(args); },
		});

		await scheduler.submit("first", { delivery: "followUp" });
		await scheduler.submit("second", { delivery: "steer" });
		expect(scheduler.getSnapshot().localQueue).toEqual([
			{ text: "first", delivery: "followUp" },
			{ text: "second", delivery: "steer" },
		]);
		expect(sent).toEqual([]);

		compacting = false;
		scheduler.handleAgentEvent({ type: "compaction_end" });
		await flush();
		expect(sent).toEqual([
			["first", { streamingBehavior: "followUp" }],
			["second", { streamingBehavior: "steer" }],
		]);
		expect(scheduler.getSnapshot().localQueue).toEqual([]);
	});

	it("restores a failed compaction dispatch and resumes when new input arrives", async () => {
		let compacting = true;
		let fail = true;
		const sent: string[] = [];
		const scheduler = createRpcPromptScheduler({
			getCompacting: () => compacting,
			sendPrompt: async (message) => {
				sent.push(message);
				if (fail) throw new Error("transport lost");
			},
		});
		await scheduler.submit("keep me", { delivery: "steer" });
		compacting = false;
		scheduler.handleAgentEvent({ type: "compaction_end" });
		await flush();

		expect(scheduler.getSnapshot()).toMatchObject({ pausedAfterFailure: true, queuedMessages: ["keep me"] });
		fail = false;
		await scheduler.submit("resume", { delivery: "followUp" });
		await flush();
		expect(sent).toEqual(["keep me", "keep me", "resume"]);
		expect(scheduler.getSnapshot()).toMatchObject({ pausedAfterFailure: false, queuedMessages: [] });
	});

	it("reports an in-flight compaction failure invalidated by queue restore", async () => {
		let compacting = true;
		let rejectSend: ((error: Error) => void) | undefined;
		const unknown = vi.fn();
		const scheduler = createRpcPromptScheduler({
			getCompacting: () => compacting,
			sendPrompt: () => new Promise<void>((_resolve, reject) => { rejectSend = reject; }),
			onDispatchFailure: unknown,
		});
		await scheduler.submit("keep visible", { delivery: "steer" });
		compacting = false;
		scheduler.handleAgentEvent({ type: "compaction_end" });
		await flush();

		scheduler.restoreAll("");
		rejectSend?.(new Error("transport lost"));
		await flush();

		expect(unknown).toHaveBeenCalledWith("keep visible", expect.any(Error));
	});

	it("reports correlated rejection separately from ambiguous transport failure", async () => {
		const rejected = vi.fn();
		const unknown = vi.fn();
		const scheduler = createRpcPromptScheduler({
			sendPrompt: async (message) => {
				if (message === "bad") throw new RpcPromptPreflightRejection("rejected");
				throw new Error("timeout");
			},
			onPreflightRejected: rejected,
			onDispatchFailure: unknown,
		});
		await scheduler.submit("bad", { delivery: "steer" });
		await scheduler.submit("maybe", { delivery: "steer" });
		await flush();
		expect(rejected).toHaveBeenCalledWith("bad", expect.any(RpcPromptPreflightRejection));
		expect(unknown).toHaveBeenCalledWith("maybe", expect.any(Error));
	});

	it("sends child-owned slash commands during compaction before held prompts", async () => {
		const sendPrompt = vi.fn(async () => undefined);
		const scheduler = createRpcPromptScheduler({ getCompacting: () => true, sendPrompt });

		await expect(scheduler.submit("ordinary", { delivery: "steer" })).resolves.toBe("queued");
		await expect(scheduler.submit("/extension-command", { delivery: "followUp" })).resolves.toBe("sent");
		await flush();

		expect(sendPrompt).toHaveBeenCalledWith("/extension-command", { streamingBehavior: "followUp" });
		expect(scheduler.getSnapshot().queuedMessages).toEqual(["ordinary"]);
	});

	it("runs host commands before compaction holding", async () => {
		const sendPrompt = vi.fn(async () => undefined);
		const scheduler = createRpcPromptScheduler({
			getCompacting: () => true,
			handleHostCommand: (message) => message === "/theme",
			sendPrompt,
		});
		await expect(scheduler.submit("/theme", { delivery: "steer" })).resolves.toBe("handled");
		expect(sendPrompt).not.toHaveBeenCalled();
		expect(scheduler.getSnapshot().localQueue).toEqual([]);
	});
});

interface DeferredDelivery {
	readonly promise: Promise<RpcPromptDeliveryMode>;
	readonly resolve: (mode: RpcPromptDeliveryMode) => void;
}

describe("RpcPromptScheduler auto delivery", () => {
	function deferredDelivery(): DeferredDelivery {
		let resolve: (mode: RpcPromptDeliveryMode) => void = () => undefined;
		const promise = new Promise<RpcPromptDeliveryMode>((settle) => { resolve = settle; });
		return { promise, resolve };
	}

	it("lets the decider pick a busy submission's delivery, with the run's prompt as context", async () => {
		let busy = false;
		const decision = deferredDelivery();
		const decideDelivery = vi.fn(() => decision.promise);
		const sendPrompt = vi.fn(async () => undefined);
		const scheduler = createRpcPromptScheduler({ getBusy: () => busy, decideDelivery, sendPrompt });

		await scheduler.submit("refactor the scheduler", { delivery: "auto" });
		busy = true;
		await expect(scheduler.submit("after that, look at issue 412", { delivery: "auto" })).resolves.toBe("queued");
		expect(scheduler.getSnapshot().queuedMessages).toEqual(["after that, look at issue 412"]);

		decision.resolve("followUp");
		await flush();
		await flush();

		expect(decideDelivery).toHaveBeenCalledWith("after that, look at issue 412", "refactor the scheduler");
		expect(sendPrompt.mock.calls).toEqual([
			["refactor the scheduler", { streamingBehavior: "steer" }],
			["after that, look at issue 412", { streamingBehavior: "followUp" }],
		]);
		expect(scheduler.getSnapshot().queuedMessages).toEqual([]);
	});

	it("keeps later submissions behind a message whose delivery is still being decided", async () => {
		const decision = deferredDelivery();
		const sent: string[] = [];
		const scheduler = createRpcPromptScheduler({
			getBusy: () => true,
			decideDelivery: () => decision.promise,
			sendPrompt: async (message) => { sent.push(message); },
		});

		await scheduler.submit("first", { delivery: "auto" });
		await expect(scheduler.submit("second", { delivery: "steer" })).resolves.toBe("queued");
		expect(sent).toEqual([]);

		decision.resolve("steer");
		await flush();
		await flush();
		expect(sent).toEqual(["first", "second"]);
	});

	it("skips the decider when idle, for commands, and when no decider is wired", async () => {
		let busy = false;
		const decideDelivery = vi.fn(async (): Promise<RpcPromptDeliveryMode> => "followUp");
		const sendPrompt = vi.fn(async () => undefined);
		const scheduler = createRpcPromptScheduler({ getBusy: () => busy, decideDelivery, sendPrompt });
		const undecided = createRpcPromptScheduler({ getBusy: () => true, sendPrompt });

		await expect(scheduler.submit("start", { delivery: "auto" })).resolves.toBe("sent");
		busy = true;
		await expect(scheduler.submit("/skill:review", { delivery: "auto" })).resolves.toBe("sent");
		await undecided.submit("no key", { delivery: "auto" });
		await flush();
		await flush();

		expect(decideDelivery).not.toHaveBeenCalled();
		expect(sendPrompt.mock.calls).toEqual([
			["start", { streamingBehavior: "steer" }],
			["/skill:review", { streamingBehavior: "steer" }],
			["no key", { streamingBehavior: "steer" }],
		]);
	});

	it("steers when the decider rejects", async () => {
		const sendPrompt = vi.fn(async () => undefined);
		const scheduler = createRpcPromptScheduler({
			getBusy: () => true,
			decideDelivery: async () => { throw new Error("boom"); },
			sendPrompt,
		});

		await scheduler.submit("fix it", { delivery: "auto" });
		await flush();
		await flush();
		expect(sendPrompt.mock.calls).toEqual([["fix it", { streamingBehavior: "steer" }]]);
	});

	it("drops the send when the queue is restored to the editor while Jev decides", async () => {
		const decision = deferredDelivery();
		const sendPrompt = vi.fn(async () => undefined);
		const scheduler = createRpcPromptScheduler({ getBusy: () => true, decideDelivery: () => decision.promise, sendPrompt });

		await scheduler.submit("maybe later", { delivery: "auto" });
		expect(scheduler.restoreAll("").text).toBe("maybe later");
		decision.resolve("followUp");
		await flush();
		await flush();
		expect(sendPrompt).not.toHaveBeenCalled();
	});
});
