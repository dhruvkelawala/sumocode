import { describe, expect, it, vi } from "vitest";
import type { TerminalTaskManager } from "./task-manager.js";
import { installTerminalTools, TerminalDeliveryCoordinator } from "./terminal-tools.js";
import { TERMINAL_TASK_SCHEMA_VERSION, type TerminalTaskSnapshot } from "./task-types.js";

type RegisteredTool = {
	name: string;
	parameters: unknown;
	execute: (...args: any[]) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
};

type Handler = (event: any, ctx: any) => void | Promise<void>;

function task(overrides: Partial<TerminalTaskSnapshot> = {}): TerminalTaskSnapshot {
	return {
		schemaVersion: TERMINAL_TASK_SCHEMA_VERSION,
		revision: 3,
		id: "term-a",
		ownerSessionId: "session-a",
		command: "pnpm test",
		cwd: "/repo",
		title: "tests",
		status: "running",
		completionPolicy: "passive",
		createdAt: 1_000,
		updatedAt: 2_000,
		deliveryState: "none",
		pid: 42,
		processGroupId: 42,
		processStartTime: "start",
		logFile: "/tmp/term-a/output.log",
		...overrides,
	};
}

function createHarness(initial: TerminalTaskSnapshot[] = []) {
	const tasks = new Map(initial.map((entry) => [entry.id, entry]));
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, Handler[]>();
	const listeners = new Set<(snapshot: TerminalTaskSnapshot) => void>();
	let activeSessionId = "session-a";
	let idle = true;
	const branch: Array<Record<string, unknown>> = [];
	let recordSentMessage = true;
	let onSend: (() => void) | undefined;
	let claimSequence = 0;
	const manager = {
		start: vi.fn(async (options: { ownerSessionId: string; sourceId?: string; completionPolicy: "passive" | "wake" }) => {
			const started = task({ ownerSessionId: options.ownerSessionId, sourceId: options.sourceId, completionPolicy: options.completionPolicy });
			tasks.set(started.id, started);
			return started;
		}),
		check: vi.fn((id: string, owner: string) => {
			const entry = tasks.get(id);
			if (entry?.ownerSessionId !== owner) return undefined;
			const observed = entry.status === "completed" && (entry.deliveryState === "pending" || entry.deliveryState === "claimed")
				? { ...entry, deliveryState: "suppressed" as const, deliveryClaimToken: undefined, observedAt: 3_000 }
				: entry;
			tasks.set(id, observed);
			return { task: observed, output: "current output" };
		}),
		wait: vi.fn(async (ids: string[], owner: string) => ({
			settled: ids.flatMap((id) => {
				const entry = tasks.get(id);
				if (entry?.ownerSessionId !== owner || entry.status !== "completed") return [];
				const observed = {
					...entry,
					deliveryState: entry.deliveryState === "pending" || entry.deliveryState === "claimed" ? "suppressed" as const : entry.deliveryState,
					deliveryClaimToken: undefined,
					observedAt: entry.observedAt ?? 3_000,
					consumedAt: entry.consumedAt ?? 3_000,
				};
				tasks.set(id, observed);
				return [{ task: observed, output: "final output" }];
			}),
			pendingIds: ids.filter((id) => tasks.get(id)?.status === "running"),
			unknownIds: ids.filter((id) => !tasks.has(id)),
			timedOut: ids.some((id) => tasks.get(id)?.status === "running"),
		})),
		stop: vi.fn(async (ids: string[], owner: string) => ids.map((id) => {
			const entry = tasks.get(id);
			return entry?.ownerSessionId === owner
				? { id, outcome: "cancelled", task: { ...entry, status: "cancelled" }, message: `Cancelled terminal ${id}.` }
				: { id, outcome: "unknown", message: `Unknown terminal ${id}.` };
		})),
		list: vi.fn((owner: string) => [...tasks.values()].filter((entry) => entry.ownerSessionId === owner)),
		get: vi.fn((id: string, owner: string) => {
			const entry = tasks.get(id);
			return entry?.ownerSessionId === owner ? entry : undefined;
		}),
		getOutput: vi.fn(() => "bounded output"),
		claimPending: vi.fn((owner: string, includeWake: boolean) => {
			const claimed: TerminalTaskSnapshot[] = [];
			for (const [id, entry] of tasks) {
				if (entry.ownerSessionId !== owner || entry.deliveryState !== "pending") continue;
				if (entry.completionPolicy === "wake" && !includeWake) continue;
				const next = { ...entry, deliveryState: "claimed" as const, deliveryClaimToken: `claim-${++claimSequence}` };
				tasks.set(id, next);
				claimed.push(next);
			}
			return claimed;
		}),
		acknowledge: vi.fn((owner: string, receipts: Array<{ completionId: string; claimToken: string }>) => {
			const receiptKeys = new Set(receipts.map(({ completionId, claimToken }) => `${completionId}\u0000${claimToken}`));
			const values: TerminalTaskSnapshot[] = [];
			for (const [id, entry] of tasks) {
				if (
					entry.ownerSessionId !== owner || entry.deliveryState !== "claimed" ||
					!entry.completionId || !entry.deliveryClaimToken ||
					!receiptKeys.has(`${entry.completionId}\u0000${entry.deliveryClaimToken}`)
				) continue;
				const next = { ...entry, deliveryState: "delivered" as const, deliveryClaimToken: undefined };
				tasks.set(id, next);
				values.push(next);
			}
			return values;
		}),
		getClaimRetryDelay: vi.fn((owner: string) => [...tasks.values()].some((entry) => entry.ownerSessionId === owner && entry.deliveryState === "claimed") ? 10 : undefined),
		addChangeListener: vi.fn((listener: (snapshot: TerminalTaskSnapshot) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
	};
	const sendMessage = vi.fn((message: { details?: unknown }) => {
		if (recordSentMessage) branch.push({ type: "custom_message", details: message.details });
		onSend?.();
	});
	const pi = {
		registerTool: vi.fn((definition: RegisteredTool) => tools.set(definition.name, definition)),
		on: vi.fn((event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler])),
		sendMessage,
	};
	const coordinator = installTerminalTools(pi as never, manager as unknown as TerminalTaskManager);
	const ctx = () => ({
		cwd: "/default",
		isIdle: () => idle,
		sessionManager: {
			getSessionId: () => activeSessionId,
			getBranch: () => branch,
		},
	});
	const fire = async (event: string, value: any = { type: event }) => {
		for (const handler of handlers.get(event) ?? []) await handler(value, ctx());
		await Promise.resolve();
		await Promise.resolve();
	};
	return {
		manager,
		pi,
		sendMessage,
		tool: (name: string) => tools.get(name)!,
		ctx,
		fire,
		tasks,
		branch,
		coordinator,
		setRecordSentMessage: (value: boolean) => { recordSentMessage = value; },
		setOnSend: (value: (() => void) | undefined) => { onSend = value; },
		setIdle: (value: boolean) => { idle = value; },
		setSession: (value: string) => { activeSessionId = value; },
		emit: (snapshot: TerminalTaskSnapshot) => { for (const listener of listeners) listener(snapshot); },
	};
}

async function execute(tool: RegisteredTool, params: unknown, ctx: unknown, signal?: AbortSignal) {
	return tool.execute("call-1", params, signal, undefined, ctx);
}

describe("installTerminalTools", () => {
	it("registers exactly the five terminal v2 verbs and no bg aliases", () => {
		const harness = createHarness();
		const names = harness.pi.registerTool.mock.calls.map(([definition]) => definition.name);
		expect(names).toEqual(["terminal_start", "terminal_check", "terminal_wait", "terminal_stop", "terminal_list"]);
		expect(names.some((name) => name.startsWith("bg_"))).toBe(false);
	});

	it("starts a current-session hidden terminal with passive completion by default", async () => {
		const harness = createHarness();
		const result = await execute(harness.tool("terminal_start"), { command: "pnpm dev", title: "dev", working_dir: "/workspace" }, harness.ctx());

		expect(harness.manager.start).toHaveBeenCalledWith({
			ownerSessionId: "session-a",
			sourceId: "call-1",
			command: "pnpm dev",
			cwd: "/workspace",
			title: "dev",
			completionPolicy: "passive",
		});
		expect(result.content[0]?.text).toContain("Started terminal term-a");
		expect(result.content[0]?.text).toContain("stdin: unavailable");
		expect(result.details).toMatchObject({ activity: { id: "term-a", sourceId: "call-1" } });
	});

	it("uses current session ownership at every check, wait, stop, and list boundary", async () => {
		const settled = task({ status: "completed", settledAt: 2_000, exitCode: 0, deliveryState: "suppressed", completionId: "completion-a" });
		const harness = createHarness([settled]);
		await execute(harness.tool("terminal_check"), { id: settled.id }, harness.ctx());
		await execute(harness.tool("terminal_wait"), { ids: [settled.id], timeout_ms: 5 }, harness.ctx());
		await execute(harness.tool("terminal_stop"), { ids: [settled.id] }, harness.ctx());
		await execute(harness.tool("terminal_list"), {}, harness.ctx());

		expect(harness.manager.check).toHaveBeenCalledWith(settled.id, "session-a");
		expect(harness.manager.wait).toHaveBeenCalledWith([settled.id], "session-a", 5, undefined);
		expect(harness.manager.stop).toHaveBeenCalledWith([settled.id], "session-a");
		expect(harness.manager.list).toHaveBeenCalledWith("session-a");
	});

	it("keeps terminal_list side-effect free from delivery reconciliation and context touch", async () => {
		const settled = task({ status: "completed", settledAt: 2_000, exitCode: 0, deliveryState: "claimed", completionId: "completion-a", deliveryClaimToken: "claim-existing" });
		const harness = createHarness([settled]);
		await harness.fire("session_start");
		harness.manager.acknowledge.mockClear();
		harness.manager.getClaimRetryDelay.mockClear();

		await execute(harness.tool("terminal_list"), {}, harness.ctx());

		expect(harness.manager.list).toHaveBeenCalledWith("session-a");
		expect(harness.manager.acknowledge).not.toHaveBeenCalled();
		expect(harness.manager.getClaimRetryDelay).not.toHaveBeenCalled();
	});

	it("does not arm lease retries when no completion was claimed", async () => {
		const harness = createHarness();
		const timeout = vi.spyOn(globalThis, "setTimeout");
		try {
			await harness.fire("session_start");
			expect(timeout).not.toHaveBeenCalled();
		} finally {
			timeout.mockRestore();
		}
	});

	it("retries a still-leased claim recovered at a session boundary", async () => {
		const claimed = task({ status: "completed", settledAt: 2_000, exitCode: 0, deliveryState: "claimed", completionId: "completion-a", deliveryClaimToken: "claim-existing" });
		const harness = createHarness([claimed]);
		const timeout = vi.spyOn(globalThis, "setTimeout");
		try {
			await harness.fire("session_start");
			expect(harness.sendMessage).not.toHaveBeenCalled();
			expect(timeout).toHaveBeenCalledWith(expect.any(Function), 20);
		} finally {
			timeout.mockRestore();
		}
	});

	it("check wins a completion-vs-idle-flush race with one observable result", async () => {
		const settled = task({ status: "completed", settledAt: 2_000, exitCode: 0, deliveryState: "pending", completionId: "completion-race" });
		const harness = createHarness([settled]);
		harness.setIdle(false);
		await harness.fire("session_start");
		harness.setIdle(true);
		harness.emit(settled);
		const result = await execute(harness.tool("terminal_check"), { id: settled.id }, harness.ctx());
		await Promise.resolve();

		expect(result.content[0]?.text).toContain("term-a");
		expect(harness.sendMessage).not.toHaveBeenCalled();
		expect(harness.tasks.get(settled.id)?.deliveryState).toBe("suppressed");
	});

	it("wait wins a completion race and leaves no notification claim", async () => {
		const settled = task({ status: "completed", settledAt: 2_000, exitCode: 0, deliveryState: "pending", completionId: "completion-wait" });
		const harness = createHarness([settled]);
		harness.setIdle(false);
		await harness.fire("session_start");
		harness.emit(settled);

		const result = await execute(harness.tool("terminal_wait"), { ids: [settled.id], timeout_ms: 10 }, harness.ctx());
		harness.setIdle(true);
		await harness.fire("agent_settled");

		expect(result.content[0]?.text).toContain("term-a");
		expect(harness.sendMessage).not.toHaveBeenCalled();
		expect(harness.tasks.get(settled.id)?.deliveryState).toBe("suppressed");
	});

	it("delivers passive completion visibly without triggering a turn", async () => {
		const settled = task({ status: "completed", settledAt: 2_000, exitCode: 0, deliveryState: "pending", completionId: "completion-a" });
		const harness = createHarness([settled]);
		await harness.fire("session_start");

		expect(harness.sendMessage).toHaveBeenCalledOnce();
		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "terminal-result",
				display: true,
				details: {
					completionId: "completion-a",
					deliveryClaimToken: "claim-1",
					ownerSessionId: "session-a",
					activity: expect.objectContaining({ id: "term-a", kind: "terminal", ownerSessionId: "session-a" }),
				},
			}),
			{ deliverAs: "followUp", triggerTurn: false },
		);
	});

	it("keeps wake pending while busy and wakes only the active owning idle session", async () => {
		const wake = task({ status: "completed", settledAt: 2_000, exitCode: 0, completionPolicy: "wake", deliveryState: "pending", completionId: "completion-wake" });
		const harness = createHarness([wake]);
		harness.setIdle(false);
		await harness.fire("session_start");
		expect(harness.sendMessage).not.toHaveBeenCalled();

		harness.setIdle(true);
		await harness.fire("agent_settled");
		expect(harness.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "terminal-result" }), { deliverAs: "followUp", triggerTurn: true });
	});

	it("does not inject session A completion into B and surfaces it when A resumes", async () => {
		const settled = task({ status: "completed", settledAt: 2_000, exitCode: 0, deliveryState: "pending", completionId: "completion-a" });
		const harness = createHarness([settled]);
		harness.setSession("session-b");
		await harness.fire("session_start");
		expect(harness.sendMessage).not.toHaveBeenCalled();

		await harness.fire("session_shutdown", { reason: "resume" });
		harness.setSession("session-a");
		await harness.fire("session_start");
		expect(harness.sendMessage).toHaveBeenCalledOnce();
	});

	it("retries a claimed notification after coordinator crash and acknowledges only the observable retry", async () => {
		const settled = task({ status: "completed", settledAt: 2_000, exitCode: 0, deliveryState: "pending", completionId: "completion-crash" });
		const harness = createHarness([settled]);
		harness.setRecordSentMessage(false);
		harness.setOnSend(() => harness.coordinator.dispose());
		await harness.fire("session_start");
		expect(harness.tasks.get(settled.id)?.deliveryState).toBe("claimed");
		expect(harness.branch).toEqual([]);

		// Model bounded lease expiry after the crashed sender. A replacement
		// coordinator then reclaims, sends, and acknowledges the visible ID.
		harness.tasks.set(settled.id, { ...harness.tasks.get(settled.id)!, deliveryState: "pending", deliveryClaimToken: undefined });
		harness.setRecordSentMessage(true);
		harness.setOnSend(undefined);
		const replacement = new TerminalDeliveryCoordinator(harness.pi as never, harness.manager as unknown as TerminalTaskManager);
		replacement.bind(harness.ctx() as never);
		await Promise.resolve();
		await Promise.resolve();
		expect(harness.sendMessage).toHaveBeenCalledTimes(2);
		expect(harness.tasks.get(settled.id)?.deliveryState).toBe("delivered");
		replacement.dispose();
	});

	it("uses the stable completion id as an insertion idempotency key after reclaim", async () => {
		const settled = task({ status: "completed", settledAt: 2_000, exitCode: 0, deliveryState: "pending", completionId: "completion-existing" });
		const harness = createHarness([settled]);
		harness.branch.push({
			type: "custom_message",
			details: { completionId: "completion-existing", deliveryClaimToken: "claim-crashed" },
		});

		await harness.fire("session_start");

		expect(harness.sendMessage).not.toHaveBeenCalled();
		expect(harness.tasks.get(settled.id)).toMatchObject({ deliveryState: "delivered", deliveryClaimToken: undefined });
		expect(harness.manager.acknowledge).toHaveBeenCalledWith("session-a", [{
			completionId: "completion-existing",
			claimToken: "claim-1",
		}]);
	});

	it("catches a deferred acknowledgement reconciliation failure", async () => {
		const settled = task({ status: "completed", settledAt: 2_000, exitCode: 0, deliveryState: "pending", completionId: "completion-error" });
		const harness = createHarness([settled]);
		const acknowledge = harness.manager.acknowledge.getMockImplementation()!;
		let calls = 0;
		harness.manager.acknowledge.mockImplementation((owner: string, receipts: Array<{ completionId: string; claimToken: string }>) => {
			calls += 1;
			if (calls === 3) throw new Error("store temporarily unavailable");
			return acknowledge(owner, receipts);
		});

		await expect(harness.fire("session_start")).resolves.toBeUndefined();
		expect(harness.sendMessage).toHaveBeenCalledOnce();
		expect(harness.manager.getClaimRetryDelay).toHaveBeenCalled();
		harness.coordinator.dispose();
	});

	it("acknowledges only after the matching completion id is observable and never sends twice", async () => {
		const settled = task({ status: "completed", settledAt: 2_000, exitCode: 0, deliveryState: "pending", completionId: "completion-a" });
		const harness = createHarness([settled]);
		await harness.fire("session_start");
		await Promise.resolve();

		expect(harness.tasks.get(settled.id)?.deliveryState).toBe("delivered");
		expect(harness.manager.acknowledge).toHaveBeenCalledWith("session-a", [{
			completionId: "completion-a",
			claimToken: "claim-1",
		}]);
		await harness.fire("agent_settled");
		expect(harness.sendMessage).toHaveBeenCalledOnce();
	});
});
