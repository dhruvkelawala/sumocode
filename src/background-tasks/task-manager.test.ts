import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskManager } from "./task-manager.js";

const spawnMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn(() => "Mon Jun  1 10:00:00 2026\n"));
const SEND_USER_MESSAGE = ["send", "UserMessage"].join("");

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
	execFileSync: execFileSyncMock,
	spawn: spawnMock,
}));

function buildPiStub(execImpl?: (cmd: string, args: string[], opts?: unknown) => Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>) {
	return {
		[SEND_USER_MESSAGE]: vi.fn(),
		exec: vi.fn(execImpl ?? (async (_cmd: string, _args: string[], _opts?: unknown) => ({
			code: 0,
			stdout: "",
			stderr: "",
			killed: false,
		}))),
	};
}

function mockChild(exitCode = 0) {
	const child = new EventEmitter() as EventEmitter & {
		pid: number;
		stdout: EventEmitter;
		stderr: EventEmitter;
		unref: () => void;
		kill: (signal?: string) => boolean;
		exitCode: number | null;
		signalCode: string | null;
	};
	child.pid = 4242;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.unref = vi.fn();
	child.kill = vi.fn(() => true);
	child.exitCode = null;
	child.signalCode = null;
	queueMicrotask(() => {
		child.stdout.emit("data", Buffer.from("hello\n"));
		child.exitCode = exitCode;
		child.emit("close", exitCode);
	});
	return child;
}

/**
 * Long-lived mock child that does NOT auto-exit. Tests can call `kill()`
 * which simulates SIGTERM responsiveness, or `forceExit()` to simulate a
 * cleanly-exiting process. `unkillable=true` makes kill() a no-op so we can
 * exercise the SIGKILL escalation + timeout path.
 */
function mockLongLivedChild(opts: { unkillable?: boolean; pid?: number } = {}) {
	const child = new EventEmitter() as EventEmitter & {
		pid: number;
		stdout: EventEmitter;
		stderr: EventEmitter;
		unref: () => void;
		kill: (signal?: string) => boolean;
		exitCode: number | null;
		signalCode: string | null;
		forceExit: (code: number) => void;
	};
	child.pid = opts.pid ?? 5151;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.unref = vi.fn();
	child.exitCode = null;
	child.signalCode = null;
	child.kill = vi.fn((signal?: string) => {
		if (opts.unkillable) return true;
		child.exitCode = signal === "SIGKILL" ? 137 : 143;
		child.signalCode = signal === "SIGKILL" ? "SIGKILL" : "SIGTERM";
		queueMicrotask(() => child.emit("close", child.exitCode));
		return true;
	});
	child.forceExit = (code: number) => {
		child.exitCode = code;
		child.emit("close", code);
	};
	return child;
}

describe("BackgroundTaskManager", () => {
	let baseDir: string;
	let originalCmuxSurface: string | undefined;
	let originalTmpdir: string | undefined;
	let originalHerdrEnv: string | undefined;
	let originalHerdrPane: string | undefined;

	beforeEach(() => {
		spawnMock.mockReset();
		execFileSyncMock.mockReset();
		execFileSyncMock.mockReturnValue("Mon Jun  1 10:00:00 2026\n");
		baseDir = mkdtempSync(join(tmpdir(), "sumocode-bg-test-"));
		originalCmuxSurface = process.env.CMUX_SURFACE_ID;
		originalTmpdir = process.env.TMPDIR;
		process.env.TMPDIR = baseDir;
		originalHerdrEnv = process.env.HERDR_ENV;
		originalHerdrPane = process.env.HERDR_PANE_ID;
		delete process.env.CMUX_WORKSPACE_ID;
		delete process.env.HERDR_ENV;
		delete process.env.HERDR_PANE_ID;
	});

	function restoreEnv(name: "CMUX_SURFACE_ID" | "TMPDIR" | "HERDR_ENV" | "HERDR_PANE_ID", value: string | undefined): void {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(baseDir, { recursive: true, force: true });
		restoreEnv("CMUX_SURFACE_ID", originalCmuxSurface);
		restoreEnv("TMPDIR", originalTmpdir);
		restoreEnv("HERDR_ENV", originalHerdrEnv);
		restoreEnv("HERDR_PANE_ID", originalHerdrPane);
	});

	it("spawns invisible tasks via shell-redirect to logFile (detached survives parent teardown)", async () => {
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
		// On POSIX the shell wraps the command with log redirection + exit.code persistence
		// so the orphaned process can keep writing to the log even if the
		// orchestrator exits. Verify that shape rather than the file contents
		// (the mocked spawn does not actually run a shell).
		const spawnArgs = spawnMock.mock.calls[0] as unknown as [string, string[], { stdio?: unknown }];
		const commandStr = spawnArgs[1][spawnArgs[1].length - 1];
		if (process.platform !== "win32") {
			expect(commandStr).toContain("echo hello");
			expect(commandStr).toContain(`>>'${task.logFile}'`);
			expect(commandStr).toContain(`> '${task.exitFile}'`);
			expect(commandStr).toContain("2>&1");
			expect(spawnArgs[2]?.stdio).toBe("ignore");
		}
		expect(pi[SEND_USER_MESSAGE]).not.toHaveBeenCalled();
	});

	it("calls only the typed finalized hook exactly once for a live self-exit", async () => {
		spawnMock.mockReturnValue(mockChild(0));
		const pi = buildPiStub();
		const onTaskFinalized = vi.fn();
		const manager = new BackgroundTaskManager(pi as never, { onTaskFinalized });
		const task = manager.spawnTask({ command: "echo typed", cwd: "/tmp" });

		await vi.waitFor(() => expect(onTaskFinalized).toHaveBeenCalledOnce());

		expect(onTaskFinalized).toHaveBeenCalledWith(expect.objectContaining({
			id: task.id,
			status: "completed",
			exitCode: 0,
		}));
		expect(pi[SEND_USER_MESSAGE]).not.toHaveBeenCalled();
	});

	it("does not call the finalized hook for an explicitly stopped task", async () => {
		const child = mockLongLivedChild();
		spawnMock.mockReturnValue(child);
		const onTaskFinalized = vi.fn();
		const manager = new BackgroundTaskManager(buildPiStub() as never, { onTaskFinalized });
		const task = manager.spawnTask({ command: "sleep 100", cwd: "/tmp" });

		await manager.stopTask(task);

		expect(task.status).toBe("stopped");
		expect(onTaskFinalized).not.toHaveBeenCalled();
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
		expect(initial.schemaVersion).toBe(3);
		expect(initial.id).toBe(task.id);
		expect(initial.pid).toBe(4242);
		expect(initial.processStartTime).toBe("Mon Jun  1 10:00:00 2026");
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

		// New default: a fire-and-forget shell task must NOT wake the agent. The
		// passive cmux toast above is decoupled from the message-queue follow-up.
		expect(pi[SEND_USER_MESSAGE]).not.toHaveBeenCalled();
	});

	it("does not wake the orchestrator for a default fire-and-forget task", async () => {
		spawnMock.mockReturnValue(mockChild(0));
		const pi = buildPiStub();
		const manager = new BackgroundTaskManager(pi as never);

		const task = manager.spawnTask({
			command: "echo quiet",
			cwd: "/tmp/project",
		});

		await vi.waitFor(() => {
			expect(task.status).toBe("completed");
		});

		// Completion must NOT inject a prose message-queue follow-up. The in-cmux
		// passive-notify-still-fires angle is covered above; this is the plain
		// no-wake path.
		expect(pi[SEND_USER_MESSAGE]).not.toHaveBeenCalled();
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
		).toThrow(/terminal host/i);
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
		});

		await vi.waitFor(() => {
			expect(task.pane).toEqual({ host: "cmux", workspaceId: "workspace:1", paneId: "surface:2" });
		});
		expect(task.exitFile).toBeDefined();
		const persisted = JSON.parse(readFileSync(task.metaFile!, "utf8")) as Record<string, unknown>;
		expect(persisted.pane).toEqual({ host: "cmux", workspaceId: "workspace:1", paneId: "surface:2" });
		expect(persisted).not.toHaveProperty("cmux");
		const scriptFile = task.exitFile!.replace("exit.code", "run.sh");
		expect(existsSync(scriptFile)).toBe(true);
		expect(readFileSync(scriptFile, "utf8")).toContain("pnpm test");
		writeFileSync(task.exitFile!, "0");

		await vi.waitFor(() => {
			expect(task.status).toBe("completed");
		});
	});

	it("stores herdr pane refs and closes them on stop", async () => {
		delete process.env.CMUX_SURFACE_ID;
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "w1:p1";
		const calls: Array<[string, string[]]> = [];
		const pi = buildPiStub(async (cmd, args) => {
			calls.push([cmd, args]);
			if (cmd === "herdr" && args[0] === "agent") {
				return { code: 0, stdout: JSON.stringify({ result: { agent: { pane_id: "w1:p2", workspace_id: "w1" } } }), stderr: "", killed: false };
			}
			return { code: 0, stdout: "", stderr: "", killed: false };
		});
		const manager = new BackgroundTaskManager(pi as never);
		const task = manager.spawnTask({ command: "pnpm test", cwd: "/tmp/project", visible: true });
		await vi.waitFor(() => expect(task.pane).toEqual({ host: "herdr", paneId: "w1:p2", workspaceId: "w1" }));
		const result = await manager.stopTask(task);
		expect(result.ok).toBe(true);
		expect(calls).toContainEqual(["herdr", ["pane", "close", "w1:p2"]]);
	});

	it("getTaskHarvest returns log kind/empty for shell runners until the wrapped shell writes", async () => {
		spawnMock.mockReturnValue(mockChild(0));
		const pi = buildPiStub();
		const manager = new BackgroundTaskManager(pi as never);
		const task = manager.spawnTask({ command: "echo harvest-shell", cwd: "/tmp" });
		await vi.waitFor(() => expect(task.status).toBe("completed"));

		// Simulate what the real detached shell wrapper would write to the log
		// (the mock skips spawning a real shell, so we backfill).
		writeFileSync(task.logFile, "echo output from shell wrapper\n");

		const harvest = manager.getTaskHarvest(task);
		expect(harvest.kind).toBe("log");
		expect(harvest.ready).toBe(true);
		expect(harvest.content).toContain("echo output");
	});

	it("finalizes task as failed when visible spawn throws (e.g. cmux unreachable)", async () => {
		process.env.CMUX_SURFACE_ID = "surface:1";
		const pi = buildPiStub();
		const cmuxSplit = await import("../commands/cmux-split.js");
		vi.spyOn(cmuxSplit, "openCommandInNewSplitWithRefs").mockRejectedValue(
			new Error("cmux socket missing"),
		);

		const manager = new BackgroundTaskManager(pi as never);
		const task = manager.spawnTask({
			command: "pnpm test",
			cwd: "/repo",
			visible: true,
		});

		await vi.waitFor(() => expect(task.status).toBe("failed"));
		expect(readFileSync(task.logFile, "utf8")).toContain("cmux socket missing");
	});

	it("stopTask waits for the in-flight visible spawn before finalizing", async () => {
		process.env.CMUX_SURFACE_ID = "surface:1";
		const pi = buildPiStub();
		const cmuxSplit = await import("../commands/cmux-split.js");
		let resolveSplit: ((value: { ok: true; workspaceRef: string; surfaceRef: string }) => void) | null = null;
		vi.spyOn(cmuxSplit, "openCommandInNewSplitWithRefs").mockReturnValue(
			new Promise((resolve) => {
				resolveSplit = resolve;
			}),
		);

		const manager = new BackgroundTaskManager(pi as never);
		const task = manager.spawnTask({
			command: "slow build",
			cwd: "/repo",
			visible: true,
		});

		// stopTask is called BEFORE cmux refs come back; spawn is in flight.
		const stopPromise = manager.stopTask(task);
		// Now let the split resolve. The spawn coroutine sees stopRequested and
		// closes the surface it just created, then finalizes stopped.
		const resolver = resolveSplit as unknown as ((value: { ok: true; workspaceRef: string; surfaceRef: string }) => void) | null;
		resolver?.({ ok: true, workspaceRef: "workspace:1", surfaceRef: "surface:2" });

		const result = await stopPromise;
		expect(result.ok).toBe(true);
		expect(task.status).toBe("stopped");

		// The orphan surface must have been closed.
		const closeCall = pi.exec.mock.calls.find(
			(call) =>
				call[0] === "cmux" && Array.isArray(call[1]) && (call[1] as string[])[0] === "close-surface",
		);
		expect(closeCall, "orphan surface should be closed").toBeDefined();
	});

	it("stopTask waits for the child process to actually exit before reporting success", async () => {
		const longLived = mockLongLivedChild();
		spawnMock.mockReturnValue(longLived);
		const manager = new BackgroundTaskManager(buildPiStub() as never);
		const task = manager.spawnTask({ command: "sleep 100", cwd: "/tmp" });
		await Promise.resolve();

		const result = await manager.stopTask(task);
		expect(result.ok).toBe(true);
		expect(task.status).toBe("stopped");
		expect(longLived.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("stopTask escalates SIGTERM to SIGKILL when child ignores the first signal", async () => {
		vi.useFakeTimers();
		try {
			const longLived = mockLongLivedChild({ unkillable: true });
			spawnMock.mockReturnValue(longLived);
			const manager = new BackgroundTaskManager(buildPiStub() as never);
			const task = manager.spawnTask({ command: "trap-sigterm.sh", cwd: "/tmp" });
			await Promise.resolve();

			const stopPromise = manager.stopTask(task);
			// First SIGTERM, child ignores. Advance past the grace period.
			await vi.advanceTimersByTimeAsync(5_000);
			// SIGKILL fires; child still doesn't exit (unkillable mock). Advance
			// past the post-SIGKILL window so terminateChildAndWait returns false.
			await vi.advanceTimersByTimeAsync(2_000);

			const result = await stopPromise;
			expect(result.ok).toBe(false);
			expect(longLived.kill).toHaveBeenCalledWith("SIGTERM");
			expect(longLived.kill).toHaveBeenCalledWith("SIGKILL");
		} finally {
			vi.useRealTimers();
		}
	});

	it("stopTask returns failure when cmux close-surface fails", async () => {
		process.env.CMUX_SURFACE_ID = "surface:1";
		const pi = buildPiStub();
		pi.exec.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === "cmux" && args[0] === "close-surface") {
				return { code: 1, stdout: "", stderr: "surface not found", killed: false };
			}
			return { code: 0, stdout: "", stderr: "", killed: false };
		});
		const cmuxSplit = await import("../commands/cmux-split.js");
		vi.spyOn(cmuxSplit, "openCommandInNewSplitWithRefs").mockResolvedValue({
			ok: true,
			workspaceRef: "workspace:1",
			surfaceRef: "surface:7",
		});

		const manager = new BackgroundTaskManager(pi as never);
		const task = manager.spawnTask({
			command: "hello",
			cwd: "/repo",
			visible: true,
		});
		await vi.waitFor(() => expect(task.pane).toBeDefined());

		const result = await manager.stopTask(task);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("surface not found");
		// Task should NOT be marked stopped if we couldn't actually close it.
		expect(task.status).toBe("running");
	});

	it("recovers shell tasks and reconciles exit.code after reload without injecting a message-queue followUp", () => {
		const root = join(baseDir, "sumocode-bg", "bg-recovered-1-1000");
		mkdirSync(root, { recursive: true });
		const logFile = join(root, "output.log");
		const exitFile = join(root, "exit.code");
		const metaFile = join(root, "meta.json");
		writeFileSync(logFile, "done\n");
		writeFileSync(exitFile, "0");
		writeFileSync(metaFile, `${JSON.stringify({
			schemaVersion: 2,
			id: "bg-recovered-1",
			command: "echo recovered",
			cwd: "/tmp",
			status: "running",
			startedAt: 1000,
			updatedAt: 1000,
			logFile,
			exitFile,
			metaFile,
			visible: false,
			runner: "shell",
		}, null, 2)}\n`);

		const pi = buildPiStub();
		const onTaskFinalized = vi.fn();
		const manager = new BackgroundTaskManager(pi as never, { onTaskFinalized });
		const task = manager.findTask("bg-recovered-1");

		expect(task?.status).toBe("completed");
		expect(task?.exitCode).toBe(0);
		expect(manager.getTaskHarvest(task!, 1000).content).toContain("done");
		expect(pi[SEND_USER_MESSAGE]).not.toHaveBeenCalled();
		expect(onTaskFinalized).not.toHaveBeenCalled();
	});

	it("keeps new invisible shell tasks running when process identity cannot be captured", () => {
		execFileSyncMock.mockImplementation(() => {
			throw new Error("ps unavailable");
		});
		const child = mockLongLivedChild({ pid: 6161 });
		spawnMock.mockReturnValue(child);
		const manager = new BackgroundTaskManager(buildPiStub() as never);
		const task = manager.spawnTask({ command: "sleep 100", cwd: "/tmp" });

		expect(task.status).toBe("running");
		expect(child.kill).not.toHaveBeenCalled();
		expect(readFileSync(task.logFile, "utf8")).toContain("failed to capture process identity");
	});

	it("stops recovered invisible shell tasks by persisted pid", async () => {
		const root = join(baseDir, "sumocode-bg", "bg-recovered-running-1000");
		mkdirSync(root, { recursive: true });
		const logFile = join(root, "output.log");
		const exitFile = join(root, "exit.code");
		const metaFile = join(root, "meta.json");
		writeFileSync(logFile, "running\n");
		writeFileSync(metaFile, `${JSON.stringify({
			schemaVersion: 2,
			id: "bg-recovered-running",
			pid: 7777,
			processStartTime: "Mon Jun  1 10:00:00 2026",
			command: "sleep 100",
			cwd: "/tmp",
			status: "running",
			startedAt: 1000,
			updatedAt: 1000,
			logFile,
			exitFile,
			metaFile,
			visible: false,
			runner: "shell",
		}, null, 2)}\n`);
		let alive = true;
		const processKill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
			if (signal === 0) {
				if (alive && (pid === 7777 || pid === -7777)) return true;
				throw new Error("not alive");
			}
			if (pid === -7777 && signal === "SIGTERM") {
				alive = false;
				return true;
			}
			return true;
		}) as typeof process.kill);
		try {
			const manager = new BackgroundTaskManager(buildPiStub() as never);
			const task = manager.findTask("bg-recovered-running");

			expect(task?.status).toBe("running");
			const result = await manager.stopTask(task!);

			expect(result.ok).toBe(true);
			expect(task?.status).toBe("stopped");
			expect(processKill).toHaveBeenCalledWith(-7777, "SIGTERM");
		} finally {
			processKill.mockRestore();
		}
	});

	it("recaptures missing recovered process identity before stopping", async () => {
		const root = join(baseDir, "sumocode-bg", "bg-unverified-pid-1000");
		mkdirSync(root, { recursive: true });
		const logFile = join(root, "output.log");
		const exitFile = join(root, "exit.code");
		const metaFile = join(root, "meta.json");
		writeFileSync(logFile, "still here\n");
		writeFileSync(metaFile, `${JSON.stringify({
			schemaVersion: 2,
			id: "bg-unverified-pid",
			pid: 6666,
			command: "sleep 100",
			cwd: "/tmp",
			status: "running",
			startedAt: 1000,
			updatedAt: 1000,
			logFile,
			exitFile,
			metaFile,
			visible: false,
			runner: "shell",
		}, null, 2)}\n`);
		let alive = true;
		const processKill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
			if (signal === 0) {
				if (alive && (pid === 6666 || pid === -6666)) return true;
				throw new Error("not alive");
			}
			if (pid === -6666 && signal === "SIGTERM") {
				alive = false;
				return true;
			}
			return true;
		}) as typeof process.kill);
		try {
			const manager = new BackgroundTaskManager(buildPiStub() as never);
			const task = manager.findTask("bg-unverified-pid");

			expect(task?.status).toBe("running");
			expect(manager.getTaskHarvest(task!, 1000).content).toContain("still here");
			expect(await manager.stopTask(task!)).toMatchObject({ ok: true });
			expect(task?.status).toBe("stopped");
			expect(processKill).toHaveBeenCalledWith(-6666, "SIGTERM");
		} finally {
			processKill.mockRestore();
		}
	});

	it("leaves recovered shell task running when stop identity probe fails", async () => {
		const root = join(baseDir, "sumocode-bg", "bg-probe-fails-1000");
		mkdirSync(root, { recursive: true });
		const logFile = join(root, "output.log");
		const exitFile = join(root, "exit.code");
		const metaFile = join(root, "meta.json");
		writeFileSync(logFile, "running\n");
		writeFileSync(metaFile, `${JSON.stringify({
			schemaVersion: 2,
			id: "bg-probe-fails",
			pid: 5555,
			processStartTime: "Mon Jun  1 10:00:00 2026",
			command: "sleep 100",
			cwd: "/tmp",
			status: "running",
			startedAt: 1000,
			updatedAt: 1000,
			logFile,
			exitFile,
			metaFile,
			visible: false,
			runner: "shell",
		}, null, 2)}\n`);
		execFileSyncMock.mockImplementation(() => {
			throw new Error("ps unavailable");
		});
		const processKill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
			if (signal === 0 && (pid === 5555 || pid === -5555)) return true;
			return true;
		}) as typeof process.kill);
		try {
			const manager = new BackgroundTaskManager(buildPiStub() as never);
			const task = manager.findTask("bg-probe-fails");

			expect(task?.status).toBe("running");
			expect(await manager.stopTask(task!)).toMatchObject({ ok: false });
			expect(task?.status).toBe("running");
			expect(processKill).not.toHaveBeenCalledWith(-5555, "SIGTERM");

			writeFileSync(exitFile, "0");
			await vi.waitFor(() => expect(task?.status).toBe("completed"));
		} finally {
			processKill.mockRestore();
		}
	});

	it("refuses to stop a recovered shell task when pid identity changed", async () => {
		const root = join(baseDir, "sumocode-bg", "bg-reused-pid-1000");
		mkdirSync(root, { recursive: true });
		const logFile = join(root, "output.log");
		const exitFile = join(root, "exit.code");
		const metaFile = join(root, "meta.json");
		writeFileSync(logFile, "running\n");
		writeFileSync(metaFile, `${JSON.stringify({
			schemaVersion: 2,
			id: "bg-reused-pid",
			pid: 8888,
			processStartTime: "Mon Jun  1 10:00:00 2026",
			command: "sleep 100",
			cwd: "/tmp",
			status: "running",
			startedAt: 1000,
			updatedAt: 1000,
			logFile,
			exitFile,
			metaFile,
			visible: false,
			runner: "shell",
		}, null, 2)}\n`);
		execFileSyncMock.mockReturnValue("Mon Jun  1 11:00:00 2026\n");
		const processKill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
			if (signal === 0 && (pid === 8888 || pid === -8888)) return true;
			return true;
		}) as typeof process.kill);
		try {
			const manager = new BackgroundTaskManager(buildPiStub() as never);
			const task = manager.findTask("bg-reused-pid");

			expect(task?.status).toBe("failed");
			expect(await manager.stopTask(task!)).toMatchObject({ ok: false });
			expect(processKill).not.toHaveBeenCalledWith(-8888, "SIGTERM");
		} finally {
			processKill.mockRestore();
		}
	});

	it("shutdown signals recovered invisible shell tasks by verified pid", () => {
		const root = join(baseDir, "sumocode-bg", "bg-shutdown-1000");
		mkdirSync(root, { recursive: true });
		const logFile = join(root, "output.log");
		const metaFile = join(root, "meta.json");
		writeFileSync(logFile, "running\n");
		writeFileSync(metaFile, `${JSON.stringify({
			schemaVersion: 2,
			id: "bg-shutdown",
			pid: 4444,
			processStartTime: "Mon Jun  1 10:00:00 2026",
			command: "sleep 100",
			cwd: "/tmp",
			status: "running",
			startedAt: 1000,
			updatedAt: 1000,
			logFile,
			metaFile,
			visible: false,
			runner: "shell",
		}, null, 2)}\n`);
		const processKill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
			if (signal === 0 && pid === 4444) return true;
			return true;
		}) as typeof process.kill);
		try {
			const manager = new BackgroundTaskManager(buildPiStub() as never);

			manager.shutdown();

			expect(processKill).toHaveBeenCalledWith(-4444, "SIGTERM");
		} finally {
			processKill.mockRestore();
		}
	});

	it("recovers legacy sumocode metadata as terminal and listable without rearming watchers", () => {
		const root = join(baseDir, "sumocode-bg", "bg-legacy-agent-1000");
		mkdirSync(root, { recursive: true });
		const logFile = join(root, "output.log");
		const metaFile = join(root, "meta.json");
		writeFileSync(logFile, "legacy agent was running\n");
		writeFileSync(metaFile, `${JSON.stringify({
			schemaVersion: 2,
			id: "bg-legacy-agent",
			command: "review the diff",
			cwd: "/tmp",
			status: "running",
			startedAt: 1000,
			updatedAt: 1000,
			logFile,
			metaFile,
			exitFile: join(root, "exit.code"),
			markerFile: join(root, "started.marker"),
			responseFile: join(root, "response.md"),
			visible: true,
			runner: "sumocode",
			cmux: { workspaceRef: "workspace:1", surfaceRef: "surface:2" },
		}, null, 2)}\n`);
		const intervalSpy = vi.spyOn(globalThis, "setInterval");
		const pi = buildPiStub();
		const onTaskFinalized = vi.fn();

		const manager = new BackgroundTaskManager(pi as never, { onTaskFinalized });
		const task = manager.findTask("bg-legacy-agent");

		expect(task).toMatchObject({
			id: "bg-legacy-agent",
			runner: "sumocode",
			status: "failed",
			exitCode: null,
			pane: { host: "cmux", workspaceId: "workspace:1", paneId: "surface:2" },
		});
		expect(manager.listTasks()).toEqual([expect.objectContaining({ id: "bg-legacy-agent", status: "failed" })]);
		expect(intervalSpy).not.toHaveBeenCalled();
		expect(onTaskFinalized).not.toHaveBeenCalled();
		expect(pi[SEND_USER_MESSAGE]).not.toHaveBeenCalled();
	});

	it("ignores older meta schema versions during recovery", () => {
		const root = join(baseDir, "sumocode-bg", "bg-v1-1-1000");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "meta.json"), JSON.stringify({
			schemaVersion: 1,
			id: "bg-v1-1",
			pid: 9999,
			command: "sleep 100",
			cwd: "/tmp",
			status: "running",
			startedAt: 1000,
			updatedAt: 1000,
			logFile: join(root, "output.log"),
			visible: false,
			runner: "shell",
		}));

		const manager = new BackgroundTaskManager(buildPiStub() as never);

		expect(manager.findTask("bg-v1-1")).toBeUndefined();
	});

	it("ignores unknown meta schema versions during recovery", () => {
		const root = join(baseDir, "sumocode-bg", "bg-legacy-1-1000");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "meta.json"), JSON.stringify({ schemaVersion: 999, id: "bg-legacy-1" }));

		const manager = new BackgroundTaskManager(buildPiStub() as never);

		expect(manager.findTask("bg-legacy-1")).toBeUndefined();
	});

	it("generates stable non-counter IDs that do not collide after reload", () => {
		spawnMock.mockReturnValue(mockLongLivedChild({ pid: 9001 }));
		const processKill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
			if (signal === 0 && pid === 9001) return true;
			return true;
		}) as typeof process.kill);
		try {
			const first = new BackgroundTaskManager(buildPiStub() as never).spawnTask({ command: "sleep 10", cwd: "/tmp" });
			const second = new BackgroundTaskManager(buildPiStub() as never).spawnTask({ command: "echo next", cwd: "/tmp" });

			expect(second.id).not.toBe(first.id);
			expect(second.id).toMatch(/^bg-[a-z0-9]+-[a-z0-9]+$/);
		} finally {
			processKill.mockRestore();
		}
	});

	it("readLogTail returns only the tail bytes of a large log", async () => {
		// Direct sanity check on the perf fix: write a 200KB file and confirm
		// readLogTail returns < 20KB. The pollVisibleTask used to readFileSync
		// the whole file every 500ms; with tail-only reads it's bounded.
		spawnMock.mockReturnValue(mockChild(0));
		const manager = new BackgroundTaskManager(buildPiStub() as never);
		const task = manager.spawnTask({ command: "echo big", cwd: "/tmp" });
		await vi.waitFor(() => expect(task.status).toBe("completed"));

		// Append a large block to the log file after completion (simulating a
		// long-running build's accumulated output) and verify harvest stays small.
		const bigChunk = `${"x".repeat(50_000)}\n${"y".repeat(50_000)}\n${"z".repeat(50_000)}\n`;
		appendFileSync(task.logFile, bigChunk);

		const tail = manager.getTaskOutput(task);
		expect(tail.length).toBeLessThanOrEqual(20_000);
		expect(tail).toContain("zzz"); // tail content present
	});

	it("lists and clears finished tasks", async () => {
		spawnMock.mockReturnValue(mockChild(0));
		const manager = new BackgroundTaskManager(buildPiStub() as never);
		const task = manager.spawnTask({ command: "echo one", cwd: "/tmp" });
		await vi.waitFor(() => expect(manager.listTasks()[0]?.status).toBe("completed"));

		expect(manager.listTasks()).toHaveLength(1);
		expect(manager.clearFinishedTasks()).toBe(1);
		expect(manager.listTasks()).toHaveLength(0);
		expect(existsSync(task.metaFile!)).toBe(false);
		expect(existsSync(task.logFile)).toBe(false);
		expect(existsSync(dirname(task.logFile))).toBe(false);
		expect(new BackgroundTaskManager(buildPiStub() as never).listTasks()).toHaveLength(0);
	});

	it("prunes stale finished task dirs during recovery without touching running tasks", () => {
		const staleRoot = join(baseDir, "sumocode-bg", "bg-stale-1000");
		const runningRoot = join(baseDir, "sumocode-bg", "bg-running-1000");
		mkdirSync(staleRoot, { recursive: true });
		mkdirSync(runningRoot, { recursive: true });
		const staleLog = join(staleRoot, "output.log");
		const runningLog = join(runningRoot, "output.log");
		writeFileSync(staleLog, "old\n");
		writeFileSync(runningLog, "still running\n");
		writeFileSync(join(staleRoot, "meta.json"), `${JSON.stringify({
			schemaVersion: 2,
			id: "bg-stale",
			command: "old",
			cwd: "/tmp",
			status: "completed",
			startedAt: 1000,
			updatedAt: 1000,
			logFile: staleLog,
			metaFile: join(staleRoot, "meta.json"),
			visible: false,
			runner: "shell",
		}, null, 2)}\n`);
		writeFileSync(join(runningRoot, "meta.json"), `${JSON.stringify({
			schemaVersion: 2,
			id: "bg-running",
			command: "sleep 100",
			cwd: "/tmp",
			status: "running",
			startedAt: 1000,
			updatedAt: 1000,
			logFile: runningLog,
			metaFile: join(runningRoot, "meta.json"),
			visible: false,
			runner: "shell",
		}, null, 2)}\n`);

		const manager = new BackgroundTaskManager(buildPiStub() as never, { finishedTaskMaxAgeMs: 1 });

		expect(manager.findTask("bg-stale")).toBeUndefined();
		expect(existsSync(staleRoot)).toBe(false);
		expect(manager.findTask("bg-running")).toBeDefined();
		expect(existsSync(runningRoot)).toBe(true);
	});

	it("caps output.log size once a task finishes", () => {
		const child = mockLongLivedChild();
		spawnMock.mockReturnValue(child);
		const manager = new BackgroundTaskManager(buildPiStub() as never, { logMaxBytes: 512 });
		const task = manager.spawnTask({ command: "watch", cwd: "/tmp" });
		appendFileSync(task.logFile, "x".repeat(4096));

		// The cap is enforced once, when the task finalizes — i.e. after the
		// external writer (here the mock child) has exited, never while it is
		// still appending. Driving the child to close finalizes the task.
		child.forceExit(0);

		const finished = readFileSync(task.logFile, "utf8");
		expect(finished.length).toBeLessThanOrEqual(512);
		expect(finished.startsWith("[sumocode-bg] log truncated")).toBe(true);
	});

	it("bounds a running task's log writer-safely: truncates to zero, never rewrites", async () => {
		const child = mockLongLivedChild();
		spawnMock.mockReturnValue(child);
		vi.useFakeTimers();
		try {
			const manager = new BackgroundTaskManager(buildPiStub() as never, { logMaxBytes: 512 });
			const task = manager.spawnTask({ command: "watch", cwd: "/tmp" });
			appendFileSync(task.logFile, "x".repeat(4096));

			// The running guard is writer-safe: it truncates to zero (which a live
			// O_APPEND writer can resume past) rather than rewriting the file with a
			// tail, which would race the tee/redirect writer and corrupt the log.
			await vi.advanceTimersByTimeAsync(5_500);

			const running = readFileSync(task.logFile, "utf8");
			expect(running.length).toBe(0);
			expect(running).not.toContain("log truncated");
			manager.shutdown();
		} finally {
			vi.useRealTimers();
		}
	});

	it("leaves a running task's log untouched while it is under the cap", async () => {
		const child = mockLongLivedChild();
		spawnMock.mockReturnValue(child);
		vi.useFakeTimers();
		try {
			const manager = new BackgroundTaskManager(buildPiStub() as never, { logMaxBytes: 4096 });
			const task = manager.spawnTask({ command: "watch", cwd: "/tmp" });
			appendFileSync(task.logFile, "y".repeat(1024));

			await vi.advanceTimersByTimeAsync(15_000);

			expect(readFileSync(task.logFile, "utf8").length).toBe(1024);
			manager.shutdown();
		} finally {
			vi.useRealTimers();
		}
	});
});
