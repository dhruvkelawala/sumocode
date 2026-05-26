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
		exec: vi.fn(async (_cmd: string, _args: string[], _opts?: unknown) => ({
			code: 0,
			stdout: "",
			stderr: "",
			killed: false,
		})),
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

	it("propagates SUMOCODE_BG_CHILD=1 to invisible task children", () => {
		spawnMock.mockReturnValue(mockChild(0));
		const manager = new BackgroundTaskManager(buildPiStub() as never);
		manager.spawnTask({ command: "echo guard", cwd: "/tmp" });

		const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
		expect(spawnOptions?.env?.SUMOCODE_BG_CHILD).toBe("1");
	});

	it("writes meta.json on spawn and again on completion", async () => {
		spawnMock.mockReturnValue(mockChild(0));
		const pi = buildPiStub();
		const manager = new BackgroundTaskManager(pi as never);

		const task = manager.spawnTask({
			command: "echo meta",
			cwd: "/tmp/project",
			title: "meta probe",
		});

		expect(task.metaFile).toBeDefined();
		expect(existsSync(task.metaFile!)).toBe(true);
		const initial = JSON.parse(readFileSync(task.metaFile!, "utf8"));
		expect(initial.id).toBe(task.id);
		expect(initial.command).toBe("echo meta");
		expect(initial.runner).toBe("shell");
		expect(initial.status).toBe("running");

		await vi.waitFor(() => expect(task.status).toBe("completed"));

		const final = JSON.parse(readFileSync(task.metaFile!, "utf8"));
		expect(final.status).toBe("completed");
		expect(final.exitCode).toBe(0);
	});

	it("fires cmux notify on shell task exit when inside cmux", async () => {
		process.env.CMUX_SURFACE_ID = "surface:99";
		spawnMock.mockReturnValue(mockChild(0));
		const pi = buildPiStub();
		const manager = new BackgroundTaskManager(pi as never);

		const task = manager.spawnTask({
			command: "echo notify",
			cwd: "/tmp/project",
			title: "build artifacts",
		});

		await vi.waitFor(() => expect(task.status).toBe("completed"));

		const notifyCall = pi.exec.mock.calls.find(
			(call) => call[0] === "cmux" && Array.isArray(call[1]) && (call[1] as string[])[0] === "notify",
		);
		expect(notifyCall, "expected a cmux notify exec call").toBeDefined();
		const args = notifyCall![1] as string[];
		expect(args).toContain("--title");
		expect(args.some((a) => a.includes(task.id))).toBe(true);
		expect(args).toContain("--body");
		expect(args).toContain("build artifacts");
	});

	it("does not fire cmux notify outside cmux", async () => {
		delete process.env.CMUX_SURFACE_ID;
		spawnMock.mockReturnValue(mockChild(0));
		const pi = buildPiStub();
		const manager = new BackgroundTaskManager(pi as never);

		const task = manager.spawnTask({
			command: "echo silent",
			cwd: "/tmp/project",
		});

		await vi.waitFor(() => expect(task.status).toBe("completed"));

		const notifyCall = pi.exec.mock.calls.find(
			(call) => call[0] === "cmux" && Array.isArray(call[1]) && (call[1] as string[])[0] === "notify",
		);
		expect(notifyCall).toBeUndefined();
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

	it("launches visible sumocode bare and injects the prompt via cmux send once the editor is ready", async () => {
		process.env.CMUX_SURFACE_ID = "surface:1";
		const pi = buildPiStub();
		// Mock read-screen to immediately report the editor is ready.
		pi.exec.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === "cmux" && args[0] === "read-screen") {
				return { code: 0, stdout: " ● READY · gpt-5.5 · xhigh    17/272k · $0.00 ", stderr: "", killed: false };
			}
			return { code: 0, stdout: "", stderr: "", killed: false };
		});
		const cmuxSplit = await import("../commands/cmux-split.js");
		const openSplit = vi.spyOn(cmuxSplit, "openCommandInNewSplitWithRefs").mockResolvedValue({
			ok: true,
			workspaceRef: "workspace:1",
			surfaceRef: "surface:2",
		});

		const manager = new BackgroundTaskManager(pi as never);
		const task = manager.spawnTask({
			command: "Review the diff: with colons & quotes",
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
			"cd '/repo with spaces' && exec sumocode",
		);
		expect(task.exitFile).toBeDefined();
		expect(existsSync(task.exitFile!.replace("exit.code", "run.sh"))).toBe(false);

		// Verify the prompt was typed into the pane via cmux send + send-key return.
		await vi.waitFor(() => {
			const sendCall = pi.exec.mock.calls.find(
				(call) => call[0] === "cmux" && (call[1] as string[])[0] === "send",
			);
			expect(sendCall, "expected cmux send call with prompt text").toBeDefined();
			expect(sendCall![1] as string[]).toContain("Review the diff: with colons & quotes");

			const sendKeyCall = pi.exec.mock.calls.find(
				(call) => call[0] === "cmux" && (call[1] as string[])[0] === "send-key",
			);
			expect(sendKeyCall, "expected cmux send-key return to submit prompt").toBeDefined();
			expect(sendKeyCall![1] as string[]).toContain("return");
		});
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
