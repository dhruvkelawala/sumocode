import { describe, expect, it, vi } from "vitest";
import type { TerminalTaskManager } from "./task-manager.js";
import { installTerminalTools } from "./terminal-tools.js";
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
	const manager = {
		start: vi.fn(async (options: { ownerSessionId: string; completionPolicy: "passive" | "wake" }) => {
			const started = task({ ownerSessionId: options.ownerSessionId, completionPolicy: options.completionPolicy });
			tasks.set(started.id, started);
			return started;
		}),
		check: vi.fn((id: string, owner: string) => {
			const entry = tasks.get(id);
			return entry?.ownerSessionId === owner ? { task: entry, output: "current output" } : undefined;
		}),
		wait: vi.fn(async (ids: string[], owner: string) => ({
			settled: ids.flatMap((id) => {
				const entry = tasks.get(id);
				return entry?.ownerSessionId === owner && entry.status === "completed" ? [{ task: entry, output: "final output" }] : [];
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
		getOutput: vi.fn(() => "bounded output"),
		claimPending: vi.fn((owner: string, includeWake: boolean) => {
			const claimed: TerminalTaskSnapshot[] = [];
			for (const [id, entry] of tasks) {
				if (entry.ownerSessionId !== owner || entry.deliveryState !== "pending") continue;
				if (entry.completionPolicy === "wake" && !includeWake) continue;
				const next = { ...entry, deliveryState: "claimed" as const };
				tasks.set(id, next);
				claimed.push(next);
			}
			return claimed;
		}),
		acknowledge: vi.fn((owner: string, completionIds: Set<string>) => {
			const values: TerminalTaskSnapshot[] = [];
			for (const [id, entry] of tasks) {
				if (entry.ownerSessionId !== owner || !entry.completionId || !completionIds.has(entry.completionId)) continue;
				if (entry.deliveryState === "delivered") continue;
				const next = { ...entry, deliveryState: "delivered" as const };
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
		branch.push({ type: "custom_message", details: message.details });
	});
	const pi = {
		registerTool: vi.fn((definition: RegisteredTool) => tools.set(definition.name, definition)),
		on: vi.fn((event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler])),
		sendMessage,
	};
	installTerminalTools(pi as never, manager as unknown as TerminalTaskManager);
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
			command: "pnpm dev",
			cwd: "/workspace",
			title: "dev",
			completionPolicy: "passive",
		});
		expect(result.content[0]?.text).toContain("Started terminal term-a");
		expect(result.content[0]?.text).toContain("stdin: unavailable");
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
		const claimed = task({ status: "completed", settledAt: 2_000, exitCode: 0, deliveryState: "claimed", completionId: "completion-a" });
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

	it("acknowledges only after the matching completion id is observable and never sends twice", async () => {
		const settled = task({ status: "completed", settledAt: 2_000, exitCode: 0, deliveryState: "pending", completionId: "completion-a" });
		const harness = createHarness([settled]);
		await harness.fire("session_start");
		await Promise.resolve();

		expect(harness.tasks.get(settled.id)?.deliveryState).toBe("delivered");
		expect(harness.manager.acknowledge).toHaveBeenCalledWith("session-a", new Set(["completion-a"]));
		await harness.fire("agent_settled");
		expect(harness.sendMessage).toHaveBeenCalledOnce();
	});
});
