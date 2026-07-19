import { describe, expect, it, vi } from "vitest";
import type { DeferredResultDelivery } from "../subagents/delivery.js";
import type { BackgroundTaskManager } from "./task-manager.js";
import { installTerminalTools } from "./terminal-tools.js";
import type { BackgroundTask } from "./task-types.js";

type RegisteredTool = {
	name: string;
	execute: (...args: unknown[]) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
};

function task(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
	return {
		id: "bg-1",
		pid: 321,
		command: "pnpm test",
		cwd: "/repo",
		title: "tests",
		status: "running",
		startedAt: 1_000,
		updatedAt: 1_000,
		logFile: "/tmp/bg-1/output.log",
		visible: false,
		runner: "shell",
		notifyOnExit: false,
		...overrides,
	};
}

function createHarness(initialTasks: BackgroundTask[] = []) {
	const tasks = new Map(initialTasks.map((entry) => [entry.id, entry]));
	const tools = new Map<string, RegisteredTool>();
	const spawned = task();
	const manager = {
		spawnTask: vi.fn(() => {
			tasks.set(spawned.id, spawned);
			return spawned;
		}),
		findTask: vi.fn((id: string) => tasks.get(id)),
		listTasks: vi.fn(() => [...tasks.values()]),
		getTaskOutput: vi.fn(() => "line one\nline two\n"),
		stopTask: vi.fn(async (entry: BackgroundTask) => {
			entry.status = "stopped";
			return { ok: true as const, message: `Stopped ${entry.id}` };
		}),
	};
	const delivery = {
		defer: vi.fn(),
		consume: vi.fn(),
		forget: vi.fn(),
		drain: vi.fn(() => []),
		clear: vi.fn(),
		size: 0,
	} satisfies DeferredResultDelivery;
	const registerTool = vi.fn((definition: RegisteredTool) => tools.set(definition.name, definition));
	const onTaskFinalized = installTerminalTools(
		{ registerTool } as never,
		manager as unknown as BackgroundTaskManager,
		delivery,
	);
	return {
		delivery,
		onTaskFinalized,
		manager,
		registerTool,
		tool: (name: string) => tools.get(name)!,
		ctx: { cwd: "/default" },
	};
}

async function execute(tool: RegisteredTool, params: unknown, ctx: unknown = { cwd: "/default" }) {
	return tool.execute("call-1", params, undefined, undefined, ctx);
}

describe("installTerminalTools", () => {
	it("registers exactly the four verb tools", () => {
		const harness = createHarness();

		expect(harness.registerTool).toHaveBeenCalledTimes(4);
		expect(harness.registerTool.mock.calls.map(([definition]) => definition.name)).toEqual([
			"bg_start",
			"bg_status",
			"bg_kill",
			"bg_list",
		]);
	});

	it("starts a hidden shell terminal with typed wake ownership", async () => {
		const harness = createHarness();
		const result = await execute(
			harness.tool("bg_start"),
			{ command: "pnpm dev", title: "dev server", working_dir: "/workspace" },
			harness.ctx,
		);

		expect(harness.manager.spawnTask).toHaveBeenCalledWith({
			command: "pnpm dev",
			cwd: "/workspace",
			title: "dev server",
			runner: "shell",
			visible: false,
			notifyOnExit: false,
		});
		expect(result.content[0]?.text).toContain("Started background terminal bg-1");
		expect(result.content[0]?.text).toContain("stdin: unavailable");
	});

	it("defers one typed completion only for tasks started by bg_start", async () => {
		const harness = createHarness();
		await execute(harness.tool("bg_start"), { command: "pnpm dev", title: "dev server" });
		const started = harness.manager.listTasks()[0]!;
		started.status = "completed";
		started.exitCode = 0;

		harness.onTaskFinalized({ ...started, schemaVersion: 3 });
		harness.onTaskFinalized({ ...started, schemaVersion: 3 });
		harness.onTaskFinalized({ ...task({ id: "bg-legacy", status: "completed" }), schemaVersion: 3 });

		expect(harness.delivery.defer).toHaveBeenCalledOnce();
		const build = harness.delivery.defer.mock.calls[0]?.[1];
		expect(build?.()).toMatchObject({
			id: "bg-1",
			customType: "terminal-result",
			status: "completed",
			details: expect.objectContaining({ id: "bg-1", exitCode: 0 }),
		});
	});

	it("does not poison delivery when a started id is absent from the manager", async () => {
		const harness = createHarness();
		await execute(harness.tool("bg_start"), { command: "pnpm dev", title: "dev server" });
		const started = harness.manager.listTasks()[0]!;
		harness.manager.findTask.mockReturnValueOnce(undefined);

		harness.onTaskFinalized({ ...started, status: "completed", exitCode: 0, schemaVersion: 3 });

		expect(harness.delivery.defer).not.toHaveBeenCalled();
		expect(harness.delivery.consume).not.toHaveBeenCalled();
	});

	it("peeks at status and output without consuming delivery", async () => {
		const running = task();
		const harness = createHarness([running]);
		const result = await execute(harness.tool("bg_status"), { id: "bg-1" });

		expect(harness.manager.getTaskOutput).toHaveBeenCalledWith(running, 16 * 1024);
		expect(result.content[0]?.text).toContain("line one\nline two");
		expect(harness.delivery.consume).not.toHaveBeenCalled();
	});

	it("reports an unknown id with known terminal ids without poisoning delivery", async () => {
		const harness = createHarness([task({ id: "bg-known" })]);
		const result = await execute(harness.tool("bg_status"), { id: "bg-missing" });

		expect(result.content[0]?.text).toContain("Unknown background terminal bg-missing");
		expect(result.content[0]?.text).toContain("bg-known");
		expect(harness.delivery.consume).not.toHaveBeenCalled();
		expect(harness.delivery.defer).not.toHaveBeenCalled();
	});

	it("kills running terminals and distinguishes settled and unknown ids", async () => {
		const running = task({ id: "bg-running" });
		const completed = task({ id: "bg-done", status: "completed", exitCode: 0 });
		const harness = createHarness([running, completed]);
		const result = await execute(harness.tool("bg_kill"), { ids: ["bg-running", "bg-done", "bg-missing"] });

		expect(harness.manager.stopTask).toHaveBeenCalledOnce();
		expect(harness.manager.stopTask).toHaveBeenCalledWith(running);
		expect(result.content[0]?.text).toContain("Killed background terminal bg-running.");
		expect(result.content[0]?.text).toContain("bg-done was already completed.");
		expect(result.content[0]?.text).toContain("Unknown background terminal bg-missing.");
	});

	it("forgets typed-delivery ownership after bg_kill", async () => {
		const harness = createHarness();
		await execute(harness.tool("bg_start"), { command: "pnpm dev", title: "dev server" });
		const started = harness.manager.listTasks()[0]!;

		await execute(harness.tool("bg_kill"), { ids: [started.id] });
		started.status = "completed";
		started.exitCode = 0;
		harness.onTaskFinalized({ ...started, schemaVersion: 3 });

		expect(harness.delivery.defer).not.toHaveBeenCalled();
	});

	it("lists only shell terminals", async () => {
		const shell = task({ id: "bg-shell" });
		const agent = task({ id: "bg-agent", runner: "sumocode", visible: true });
		const harness = createHarness([shell, agent]);
		const result = await execute(harness.tool("bg_list"), {});

		expect(result.content[0]?.text).toContain("bg-shell");
		expect(result.content[0]?.text).not.toContain("bg-agent");
		expect((result.details as { tasks: BackgroundTask[] }).tasks).toEqual([shell]);
	});
});
