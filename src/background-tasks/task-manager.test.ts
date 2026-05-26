import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		// On POSIX the shell wraps the command with `( cmd ) >>logFile 2>&1`
		// so the orphaned process can keep writing to the log even if the
		// orchestrator exits. Verify that shape rather than the file contents
		// (the mocked spawn does not actually run a shell).
		const spawnArgs = spawnMock.mock.calls[0] as unknown as [string, string[], { stdio?: unknown }];
		const commandStr = spawnArgs[1][spawnArgs[1].length - 1];
		if (process.platform !== "win32") {
			expect(commandStr).toContain("echo hello");
			expect(commandStr).toContain(`>>'${task.logFile}'`);
			expect(commandStr).toContain("2>&1");
			expect(spawnArgs[2]?.stdio).toBe("ignore");
		}
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

	it("writes prompt.txt and launches sumocode with --prompt-file so the cmux command stays short", async () => {
		process.env.CMUX_SURFACE_ID = "surface:1";
		const pi = buildPiStub();
		const cmuxSplit = await import("../commands/cmux-split.js");
		const openSplit = vi.spyOn(cmuxSplit, "openCommandInNewSplitWithRefs").mockResolvedValue({
			ok: true,
			workspaceRef: "workspace:1",
			surfaceRef: "surface:2",
		});

		const longPrompt = "A long delegation prompt with 'quotes', colons:, $vars, `backticks`,\nand multi-line content that would otherwise echo as a wall of text in the cmux pane.";

		const manager = new BackgroundTaskManager(pi as never);
		const task = manager.spawnTask({
			command: longPrompt,
			cwd: "/repo with spaces",
			visible: true,
			runner: "sumocode",
			notifyOnExit: false,
		});

		await vi.waitFor(() => {
			expect(task.cmux).toEqual({ workspaceRef: "workspace:1", surfaceRef: "surface:2" });
		});

		// The cmux respawn command embeds the prompt-file PATH, never the prompt text.
		const respawnArg = openSplit.mock.calls[0]?.[2] as string;
		expect(respawnArg).toContain("cd '/repo with spaces' && ");
		expect(respawnArg).toContain("SUMOCODE_TASK_RESPONSE_FILE=");
		expect(respawnArg).toContain("SUMOCODE_TASK_DIAG_FILE=");
		expect(respawnArg).toContain("exec sumocode task --prompt-file '");
		expect(respawnArg).toContain("/prompt.txt'");
		expect(respawnArg).not.toContain("quotes");
		expect(respawnArg).not.toContain("backticks");
		expect(respawnArg).not.toContain("wall of text");

		// prompt.txt must contain the full prompt as a single file.
		expect(task.exitFile).toBeDefined();
		const promptFile = task.exitFile!.replace("exit.code", "prompt.txt");
		expect(existsSync(promptFile)).toBe(true);
		expect(readFileSync(promptFile, "utf8")).toBe(longPrompt);

		// No run.sh for agent tasks.
		expect(existsSync(task.exitFile!.replace("exit.code", "run.sh"))).toBe(false);

		// No cmux send / send-key hacks: the prompt is read from the file by
		// the wrapper and becomes Pi's kickoff message.
		const sendCall = pi.exec.mock.calls.find(
			(call) => call[0] === "cmux" && Array.isArray(call[1]) && (call[1] as string[])[0] === "send",
		);
		expect(sendCall, "agent panes should NOT use cmux send for prompt injection").toBeUndefined();

		// Task snapshot exposes the harvest paths so future tooling can find them.
		expect(task.responseFile).toBe(task.exitFile!.replace("exit.code", "response.md"));
		expect(task.diagFile).toBe(task.exitFile!.replace("exit.code", "diag.jsonl"));
		expect(task.promptFile).toBe(promptFile);
	});

	it("forwards model and thinking flags into the cmux respawn command", async () => {
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
			command: "review",
			cwd: "/repo",
			visible: true,
			runner: "sumocode",
			model: "openai/gpt-4o-mini",
			thinking: "low",
			notifyOnExit: false,
		});

		await vi.waitFor(() => {
			expect(task.cmux).toBeDefined();
		});

		const respawnArg = openSplit.mock.calls[0]?.[2] as string;
		expect(respawnArg).toContain("--model 'openai/gpt-4o-mini'");
		expect(respawnArg).toContain("--thinking 'low'");
		expect(task.model).toBe("openai/gpt-4o-mini");
		expect(task.thinking).toBe("low");
	});

	it("transitions agent task to status=completed when response.md appears", async () => {
		process.env.CMUX_SURFACE_ID = "surface:1";
		const pi = buildPiStub();
		const cmuxSplit = await import("../commands/cmux-split.js");
		vi.spyOn(cmuxSplit, "openCommandInNewSplitWithRefs").mockResolvedValue({
			ok: true,
			workspaceRef: "workspace:1",
			surfaceRef: "surface:2",
		});

		const manager = new BackgroundTaskManager(pi as never);
		const task = manager.spawnTask({
			command: "hello",
			cwd: "/repo",
			visible: true,
			runner: "sumocode",
			notifyOnExit: false,
		});

		await vi.waitFor(() => expect(task.cmux).toBeDefined());
		expect(task.status).toBe("running");

		// Simulate the child writing response.md
		writeFileSync(task.responseFile!, "hello world\n");

		await vi.waitFor(
			() => {
				expect(task.status).toBe("completed");
				expect(task.exitCode).toBe(0);
			},
			{ timeout: 3_000 },
		);

		const meta = JSON.parse(readFileSync(task.metaFile!, "utf8"));
		expect(meta.status).toBe("completed");
		expect(meta.responseFile).toBe(task.responseFile);
	});

	it("getTaskHarvest returns response.md for agent runners when ready", async () => {
		process.env.CMUX_SURFACE_ID = "surface:1";
		const pi = buildPiStub();
		const cmuxSplit = await import("../commands/cmux-split.js");
		vi.spyOn(cmuxSplit, "openCommandInNewSplitWithRefs").mockResolvedValue({
			ok: true,
			workspaceRef: "workspace:1",
			surfaceRef: "surface:2",
		});
		const manager = new BackgroundTaskManager(pi as never);
		const task = manager.spawnTask({
			command: "hi",
			cwd: "/repo",
			visible: true,
			runner: "sumocode",
			notifyOnExit: false,
		});
		await vi.waitFor(() => expect(task.cmux).toBeDefined());

		// Before response is written
		let harvest = manager.getTaskHarvest(task);
		expect(harvest.kind).toBe("response");
		expect(harvest.ready).toBe(false);
		expect(harvest.content).toBe("");

		writeFileSync(task.responseFile!, "## Review\n\nLooks good\n");
		harvest = manager.getTaskHarvest(task);
		expect(harvest.kind).toBe("response");
		expect(harvest.ready).toBe(true);
		expect(harvest.content).toContain("## Review");
	});

	it("getTaskHarvest returns log kind/empty for shell runners until the wrapped shell writes", async () => {
		spawnMock.mockReturnValue(mockChild(0));
		const pi = buildPiStub();
		const manager = new BackgroundTaskManager(pi as never);
		const task = manager.spawnTask({ command: "echo harvest-shell", cwd: "/tmp", notifyOnExit: false });
		await vi.waitFor(() => expect(task.status).toBe("completed"));

		// Simulate what the real detached shell wrapper would write to the log
		// (the mock skips spawning a real shell, so we backfill).
		writeFileSync(task.logFile, "echo output from shell wrapper\n");

		const harvest = manager.getTaskHarvest(task);
		expect(harvest.kind).toBe("log");
		expect(harvest.ready).toBe(true);
		expect(harvest.content).toContain("echo output");
	});

	it("rejects spawn when visible=false and runner is pi/sumocode (prompt would be misread as shell)", () => {
		const manager = new BackgroundTaskManager(buildPiStub() as never);
		expect(() =>
			manager.spawnTask({
				command: "Reply with: hello",
				cwd: "/repo",
				visible: false,
				runner: "sumocode",
			}),
		).toThrow(/requires visible=true/);
		expect(() =>
			manager.spawnTask({
				command: "Reply with: hello",
				cwd: "/repo",
				visible: false,
				runner: "pi",
			}),
		).toThrow(/requires visible=true/);
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
			notifyOnExit: false,
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
			notifyOnExit: false,
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
		const task = manager.spawnTask({ command: "sleep 100", cwd: "/tmp", notifyOnExit: false });
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
			const task = manager.spawnTask({ command: "trap-sigterm.sh", cwd: "/tmp", notifyOnExit: false });
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
			runner: "sumocode",
			notifyOnExit: false,
		});
		await vi.waitFor(() => expect(task.cmux).toBeDefined());

		const result = await manager.stopTask(task);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("surface not found");
		// Task should NOT be marked stopped if we couldn't actually close it.
		expect(task.status).toBe("running");
	});

	it("transitions agent task to failed when response.md never appears (watchdog timeout)", async () => {
		vi.useFakeTimers();
		try {
			process.env.CMUX_SURFACE_ID = "surface:1";
			const pi = buildPiStub();
			const cmuxSplit = await import("../commands/cmux-split.js");
			vi.spyOn(cmuxSplit, "openCommandInNewSplitWithRefs").mockResolvedValue({
				ok: true,
				workspaceRef: "workspace:1",
				surfaceRef: "surface:8",
			});

			const manager = new BackgroundTaskManager(pi as never);
			const task = manager.spawnTask({
				command: "crashy prompt",
				cwd: "/repo",
				visible: true,
				runner: "sumocode",
				notifyOnExit: false,
			});
			// Let the spawn microtask settle so the response watcher is armed.
			await vi.advanceTimersByTimeAsync(50);
			expect(task.status).toBe("running");

			// Walk past the watchdog deadline (10 min default).
			await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

			expect(task.status).toBe("failed");
			expect(readFileSync(task.logFile, "utf8")).toContain("watchdog timeout");
		} finally {
			vi.useRealTimers();
		}
	});

	it("readLogTail returns only the tail bytes of a large log", async () => {
		// Direct sanity check on the perf fix: write a 200KB file and confirm
		// readLogTail returns < 20KB. The pollVisibleTask used to readFileSync
		// the whole file every 500ms; with tail-only reads it's bounded.
		spawnMock.mockReturnValue(mockChild(0));
		const manager = new BackgroundTaskManager(buildPiStub() as never);
		const task = manager.spawnTask({ command: "echo big", cwd: "/tmp", notifyOnExit: false });
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
		manager.spawnTask({ command: "echo one", cwd: "/tmp" });
		await vi.waitFor(() => expect(manager.listTasks()[0]?.status).toBe("completed"));

		expect(manager.listTasks()).toHaveLength(1);
		expect(manager.clearFinishedTasks()).toBe(1);
		expect(manager.listTasks()).toHaveLength(0);
	});
});
