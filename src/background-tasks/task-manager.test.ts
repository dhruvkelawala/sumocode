import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskManager } from "./task-manager.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

function buildPiStub() {
	return {
		sendUserMessage: vi.fn(),
		exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "", killed: false })),
	};
}

function mockChild(exitCode = 0) {
	const child = new EventEmitter() as EventEmitter & {
		pid: number;
		stdout: EventEmitter;
		stderr: EventEmitter;
		unref: () => void;
	};
	child.pid = 4242;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.unref = vi.fn();
	queueMicrotask(() => {
		child.stdout.emit("data", Buffer.from("hello\n"));
		child.emit("close", exitCode);
	});
	return child;
}

describe("BackgroundTaskManager", () => {
	let baseDir: string;
	let originalCmuxSurface: string | undefined;

	beforeEach(() => {
		spawnMock.mockReset();
		baseDir = mkdtempSync(join(tmpdir(), "sumocode-bg-test-"));
		originalCmuxSurface = process.env.CMUX_SURFACE_ID;
		delete process.env.CMUX_WORKSPACE_ID;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(baseDir, { recursive: true, force: true });
		if (originalCmuxSurface === undefined) {
			delete process.env.CMUX_SURFACE_ID;
		} else {
			process.env.CMUX_SURFACE_ID = originalCmuxSurface;
		}
	});

	it("spawns invisible tasks and records output", async () => {
		spawnMock.mockReturnValue(mockChild(0));
		const pi = buildPiStub();
		const manager = new BackgroundTaskManager(pi as never);

		const task = manager.spawnTask({
			command: "echo hello",
			cwd: "/tmp/project",
		});

		await vi.waitFor(() => {
			expect(task.status).toBe("completed");
		});

		expect(spawnMock).toHaveBeenCalledOnce();
		expect(readFileSync(task.logFile, "utf8")).toContain("hello");
		expect(pi.sendUserMessage).toHaveBeenCalled();
	});

	it("rejects visible spawn outside cmux", () => {
		delete process.env.CMUX_SURFACE_ID;
		const manager = new BackgroundTaskManager(buildPiStub() as never);
		expect(() =>
			manager.spawnTask({
				command: "pnpm test",
				cwd: "/tmp/project",
				visible: true,
			}),
		).toThrow(/cmux surface/i);
	});

	it("polls visible task exit marker files", async () => {
		process.env.CMUX_SURFACE_ID = "surface:1";
		const pi = buildPiStub();
		vi.spyOn(await import("../commands/cmux-split.js"), "openCommandInNewSplitWithRefs").mockResolvedValue({
			ok: true,
			workspaceRef: "workspace:1",
			surfaceRef: "surface:2",
		});

		const manager = new BackgroundTaskManager(pi as never);
		const task = manager.spawnTask({
			command: "pnpm test",
			cwd: "/tmp/project",
			visible: true,
			notifyOnExit: false,
		});

		await vi.waitFor(() => {
			expect(task.cmux).toEqual({ workspaceRef: "workspace:1", surfaceRef: "surface:2" });
		});
		expect(task.exitFile).toBeDefined();
		const scriptFile = task.exitFile!.replace("exit.code", "run.sh");
		expect(existsSync(scriptFile)).toBe(true);
		expect(readFileSync(scriptFile, "utf8")).toContain("pnpm test");
		writeFileSync(task.exitFile!, "0");

		await vi.waitFor(() => {
			expect(task.status).toBe("completed");
		});
	});

	it("launches visible sumocode tasks directly without writing run.sh", async () => {
		process.env.CMUX_SURFACE_ID = "surface:1";
		const pi = buildPiStub();
		const cmuxSplit = await import("../commands/cmux-split.js");
		const openSplit = vi.spyOn(cmuxSplit, "openCommandInNewSplitWithRefs").mockResolvedValue({
			ok: true,
			workspaceRef: "workspace:1",
			surfaceRef: "surface:2",
		});

		const manager = new BackgroundTaskManager(pi as never);
		const task = manager.spawnTask({
			command: "Review the diff",
			cwd: "/repo with spaces",
			visible: true,
			runner: "sumocode",
			notifyOnExit: false,
		});

		await vi.waitFor(() => {
			expect(task.cmux).toEqual({ workspaceRef: "workspace:1", surfaceRef: "surface:2" });
		});

		expect(openSplit).toHaveBeenCalledWith(
			pi,
			"right",
			"cd '/repo with spaces' && exec sumocode 'Review the diff'",
		);
		expect(task.exitFile).toBeDefined();
		expect(existsSync(task.exitFile!.replace("exit.code", "run.sh"))).toBe(false);
	});

	it("lists and clears finished tasks", async () => {
		spawnMock.mockReturnValue(mockChild(0));
		const manager = new BackgroundTaskManager(buildPiStub() as never);
		manager.spawnTask({ command: "echo one", cwd: "/tmp" });
		await vi.waitFor(() => expect(manager.listTasks()[0]?.status).toBe("completed"));

		expect(manager.listTasks()).toHaveLength(1);
		expect(manager.clearFinishedTasks()).toBe(1);
		expect(manager.listTasks()).toHaveLength(0);
	});
});
