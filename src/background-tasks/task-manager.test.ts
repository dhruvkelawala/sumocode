import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BackgroundTaskCapacityError,
	BackgroundTaskManager,
	DEFAULT_SUMOCODE_AGENT_MODEL,
	DEFAULT_SUMOCODE_AGENT_THINKING,
} from "./task-manager.js";

const spawnMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn(() => "Mon Jun  1 10:00:00 2026\n"));

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
	execFileSync: execFileSyncMock,
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
	let originalTmpdir: string | undefined;
	let originalAgentModel: string | undefined;
	let originalAgentThinking: string | undefined;

	beforeEach(() => {
		spawnMock.mockReset();
		execFileSyncMock.mockReset();
		execFileSyncMock.mockReturnValue("Mon Jun  1 10:00:00 2026\n");
		baseDir = mkdtempSync(join(tmpdir(), "sumocode-bg-test-"));
		originalCmuxSurface = process.env.CMUX_SURFACE_ID;
		originalTmpdir = process.env.TMPDIR;
		process.env.TMPDIR = baseDir;
		originalAgentModel = process.env.SUMOCODE_BG_AGENT_MODEL;
		originalAgentThinking = process.env.SUMOCODE_BG_AGENT_THINKING;
		delete process.env.CMUX_WORKSPACE_ID;
		delete process.env.SUMOCODE_BG_AGENT_MODEL;
		delete process.env.SUMOCODE_BG_AGENT_THINKING;
	});

	function restoreEnv(name: "CMUX_SURFACE_ID" | "TMPDIR" | "SUMOCODE_BG_AGENT_MODEL" | "SUMOCODE_BG_AGENT_THINKING", value: string | undefined): void {
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
		restoreEnv("SUMOCODE_BG_AGENT_MODEL", originalAgentModel);
		restoreEnv("SUMOCODE_BG_AGENT_THINKING", originalAgentThinking);
	});

	it("spawns invisible tasks via shell-redirect to logFile (detached survives parent teardown)", async () => {
		spawnMock.mockReturnValue(mockChild(0));
		const pi = buildPiStub();
		const manager = new BackgroundTaskManager(pi as never);

		const task = manager.spawnTask({
			command: "echo hello",
			cwd: "/tmp/project",
			notifyOnExit: true,
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
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
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

		// notifyOnExit defaults to false: completion must NOT inject a
		// message-queue follow-up that wakes the agent. (The in-cmux
		// passive-notify-still-fires angle is covered above; this is the plain
		// no-wake default.)
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
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
		// cmux spawns argv[0] directly (no shell), so the compound launch line is
		// wrapped in bash -lc and its inner quotes are '\'' escaped.
		const respawnArg = openSplit.mock.calls[0]?.[2] as string;
		expect(respawnArg.startsWith("bash -lc '")).toBe(true);
		expect(respawnArg).toContain(`cd '\\''/repo with spaces'\\'' && `);
		expect(respawnArg).toContain("SUMOCODE_TASK_RESPONSE_FILE=");
		expect(respawnArg).toContain("SUMOCODE_TASK_STARTED_FILE=");
		expect(respawnArg).toContain("SUMOCODE_TASK_DIAG_FILE=");
		expect(respawnArg).toContain(`exec sumocode task --model '\\''${DEFAULT_SUMOCODE_AGENT_MODEL}'\\'' --thinking '\\''${DEFAULT_SUMOCODE_AGENT_THINKING}'\\'' --prompt-file '\\''`);
		expect(respawnArg).toContain("/prompt.txt");
		expect(task.model).toBe(DEFAULT_SUMOCODE_AGENT_MODEL);
		expect(task.thinking).toBe(DEFAULT_SUMOCODE_AGENT_THINKING);
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
		expect(task.markerFile).toBe(task.exitFile!.replace("exit.code", "started.marker"));
		expect(task.diagFile).toBe(task.exitFile!.replace("exit.code", "diag.jsonl"));
		expect(task.promptFile).toBe(promptFile);
	});

	it("uses environment-configurable model and thinking defaults for sumocode agents", async () => {
		process.env.CMUX_SURFACE_ID = "surface:1";
		process.env.SUMOCODE_BG_AGENT_MODEL = "anthropic/claude-sonnet-4-5";
		process.env.SUMOCODE_BG_AGENT_THINKING = "medium";
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
			notifyOnExit: false,
		});

		await vi.waitFor(() => {
			expect(task.cmux).toBeDefined();
		});

		const respawnArg = openSplit.mock.calls[0]?.[2] as string;
		expect(respawnArg).toContain(`--model '\\''anthropic/claude-sonnet-4-5'\\''`);
		expect(respawnArg).toContain(`--thinking '\\''medium'\\''`);
		expect(task.model).toBe("anthropic/claude-sonnet-4-5");
		expect(task.thinking).toBe("medium");
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
		expect(respawnArg).toContain(`--model '\\''openai/gpt-4o-mini'\\''`);
		expect(respawnArg).toContain(`--thinking '\\''low'\\''`);
		expect(task.model).toBe("openai/gpt-4o-mini");
		expect(task.thinking).toBe("low");
	});

	it("rejects over-capacity agent spawns with structured backpressure while allowing shell tasks", async () => {
		process.env.CMUX_SURFACE_ID = "surface:1";
		spawnMock.mockReturnValue(mockLongLivedChild());
		const pi = buildPiStub();
		const cmuxSplit = await import("../commands/cmux-split.js");
		vi.spyOn(cmuxSplit, "openCommandInNewSplitWithRefs").mockResolvedValue({
			ok: true,
			workspaceRef: "workspace:1",
			surfaceRef: "surface:2",
		});

		const manager = new BackgroundTaskManager(pi as never, { agentCapacity: 1 });
		const first = manager.spawnTask({
			command: "review one",
			cwd: "/repo",
			visible: true,
			runner: "sumocode",
			title: "agent one",
			notifyOnExit: false,
		});
		await vi.waitFor(() => expect(first.cmux).toBeDefined());

		let capacityError: unknown;
		try {
			manager.spawnTask({
				command: "review two",
				cwd: "/repo",
				visible: true,
				runner: "sumocode",
				notifyOnExit: false,
			});
		} catch (error) {
			capacityError = error;
		}

		expect(capacityError).toBeInstanceOf(BackgroundTaskCapacityError);
		expect((capacityError as BackgroundTaskCapacityError).details).toMatchObject({
			status: "at_capacity",
			capacity: 1,
			runningCount: 1,
		});
		expect((capacityError as BackgroundTaskCapacityError).details.running[0]?.id).toBe(first.id);
		expect(manager.listTasks().filter((task) => task.runner === "sumocode")).toHaveLength(1);

		const shellTask = manager.spawnTask({ command: "sleep 100", cwd: "/repo", notifyOnExit: false });
		expect(shellTask.runner).toBe("shell");
	});

	it("creates and persists a worktree before spawning a sumocode agent", async () => {
		process.env.CMUX_SURFACE_ID = "surface:1";
		const pi = buildPiStub();
		const cmuxSplit = await import("../commands/cmux-split.js");
		const openSplit = vi.spyOn(cmuxSplit, "openCommandInNewSplitWithRefs").mockResolvedValue({
			ok: true,
			workspaceRef: "workspace:1",
			surfaceRef: "surface:2",
		});
		const worktree = await import("../git/worktree.js");
		const create = vi.spyOn(worktree, "createWorktree").mockResolvedValue({
			ok: true,
			path: "/repo.sumo-worktrees/sumo__review",
			branch: "sumo/review",
			baseRef: "HEAD",
		});

		const manager = new BackgroundTaskManager(pi as never);
		const task = manager.spawnTask({
			command: "review",
			cwd: "/repo",
			visible: true,
			runner: "sumocode",
			worktree: true,
			title: "review",
			notifyOnExit: false,
		});
		await vi.waitFor(() => expect(task.cmux).toBeDefined());

		expect(create).toHaveBeenCalledWith({ repoRoot: "/repo", branch: "sumo/review", baseRef: "HEAD", path: "/repo.sumo-worktrees/sumo__review" });
		expect(task.cwd).toBe("/repo.sumo-worktrees/sumo__review");
		expect(task.worktree).toEqual({ path: "/repo.sumo-worktrees/sumo__review", branch: "sumo/review", baseRef: "HEAD", repoRoot: "/repo" });
		expect(openSplit.mock.calls[0]?.[2]).toContain(`cd '\\''/repo.sumo-worktrees/sumo__review'\\''`);
		expect(JSON.parse(readFileSync(task.metaFile!, "utf8")).worktree).toEqual(task.worktree);
	});

	it("finalizes the task as failed when deferred worktree creation fails", async () => {
		process.env.CMUX_SURFACE_ID = "surface:1";
		const pi = buildPiStub();
		const cmuxSplit = await import("../commands/cmux-split.js");
		const openSplit = vi.spyOn(cmuxSplit, "openCommandInNewSplitWithRefs").mockResolvedValue({
			ok: true,
			workspaceRef: "workspace:1",
			surfaceRef: "surface:2",
		});
		const worktree = await import("../git/worktree.js");
		vi.spyOn(worktree, "createWorktree").mockResolvedValue({
			ok: false,
			error: "branch_already_exists",
			message: "branch already exists: sumo/x",
		});

		const manager = new BackgroundTaskManager(pi as never);
		const task = manager.spawnTask({
			command: "review",
			cwd: "/repo",
			visible: true,
			runner: "sumocode",
			worktree: true,
			title: "review",
			notifyOnExit: false,
		});
		await vi.waitFor(() => expect(task.status).toBe("failed"));

		expect(openSplit).not.toHaveBeenCalled();
		expect(readFileSync(task.logFile, "utf8")).toContain("worktree create failed: branch already exists: sumo/x");
		// Fix A: the speculative worktree ref must be cleared so a later prune
		// does not try to remove a nonexistent worktree and get stuck.
		expect(task.worktree).toBeUndefined();
		expect(manager.clearFinishedTasks({ pruneWorktrees: true })).toBe(1);
		expect(manager.findTask(task.id)).toBeUndefined();
	});

	it("keeps agent task running when response.md appears before real process exit", async () => {
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

		// Simulate the child writing response.md on agent_end. The task must not
		// complete until task-mode writes the real process-exit marker.
		writeFileSync(task.responseFile!, "hello world\n");
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(task.status).toBe("running");

		writeFileSync(task.exitFile!, "0\n");
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

	it("wakes the orchestrator exactly once when an agent response is harvested", async () => {
		vi.useFakeTimers();
		try {
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
				command: "summarize the diff",
				cwd: "/repo",
				visible: true,
				runner: "sumocode",
				title: "agent review",
				notifyOnExit: true,
			});

			await vi.waitFor(() => expect(task.cmux).toBeDefined());
			writeFileSync(task.responseFile!, "done\n");
			writeFileSync(task.exitFile!, "0\n");

			await vi.advanceTimersByTimeAsync(750);

			expect(task.status).toBe("completed");
			expect(task.exitCode).toBe(0);
			expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
			expect(pi.sendUserMessage).toHaveBeenCalledWith(
				expect.stringContaining(`background task ${task.id} completed: agent review (cmux surface:2)`),
				{ deliverAs: "followUp" },
			);
			const notifyCall = pi.exec.mock.calls.find(
				(call) => call[0] === "cmux" && Array.isArray(call[1]) && (call[1] as string[])[0] === "notify",
			);
			expect(notifyCall, "expected a cmux notify exec call").toBeDefined();

			// The response watcher is cleared by finalization, so later polling cannot
			// emit a second completion/failure notification for the same task.
			await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
			expect(task.status).toBe("completed");
			expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
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
		expect(harvest.ready).toBe(false);
		expect(harvest.content).toContain("## Review");

		writeFileSync(task.exitFile!, "0\n");
		await vi.waitFor(() => expect(task.status).toBe("completed"));
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

	it("rejects spawn when visible=false and runner is sumocode (prompt would be misread as shell)", () => {
		const manager = new BackgroundTaskManager(buildPiStub() as never);
		expect(() =>
			manager.spawnTask({
				command: "Reply with: hello",
				cwd: "/repo",
				visible: false,
				runner: "sumocode",
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

	it("getTaskHarvest reports ready=true (empty content) once an agent task reaches a terminal state without response.md", async () => {
		process.env.CMUX_SURFACE_ID = "surface:1";
		const pi = buildPiStub();
		const cmuxSplit = await import("../commands/cmux-split.js");
		vi.spyOn(cmuxSplit, "openCommandInNewSplitWithRefs").mockResolvedValue({
			ok: true,
			workspaceRef: "workspace:1",
			surfaceRef: "surface:9",
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

		// While running with no response.md: ready=false (poll again).
		let harvest = manager.getTaskHarvest(task);
		expect(harvest.kind).toBe("response");
		expect(harvest.ready).toBe(false);
		expect(harvest.content).toBe("");

		// Simulate a terminal failure WITHOUT response.md.
		// The harvest should now report ready=true so callers don't poll forever.
		task.status = "failed";
		task.exitCode = null;
		harvest = manager.getTaskHarvest(task);
		expect(harvest.kind).toBe("response");
		expect(harvest.ready).toBe(true);
		expect(harvest.content).toBe("");
	});

	it("keeps started agent task running when no exit marker appears after the old watchdog window", async () => {
		vi.useFakeTimers();
		let manager: BackgroundTaskManager | undefined;
		try {
			process.env.CMUX_SURFACE_ID = "surface:1";
			const pi = buildPiStub();
			const cmuxSplit = await import("../commands/cmux-split.js");
			vi.spyOn(cmuxSplit, "openCommandInNewSplitWithRefs").mockResolvedValue({
				ok: true,
				workspaceRef: "workspace:1",
				surfaceRef: "surface:8",
			});

			manager = new BackgroundTaskManager(pi as never);
			const task = manager.spawnTask({
				command: "long-running prompt",
				cwd: "/repo",
				visible: true,
				runner: "sumocode",
				notifyOnExit: false,
			});
			// Let the spawn microtask settle so the response watcher is armed.
			await vi.advanceTimersByTimeAsync(50);
			expect(task.status).toBe("running");
			writeFileSync(task.markerFile!, `${process.pid}\n`);

			// Walk past the previous 10-minute response-era watchdog window. Once
			// task-mode writes started.marker, missing exit marker means still
			// running/unknown rather than failed.
			await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

			expect(task.status).toBe("running");
			expect(readFileSync(task.logFile, "utf8")).not.toContain("startup timeout");
		} finally {
			manager?.shutdown();
			vi.useRealTimers();
		}
	});

	it("reaps a started agent task whose process has died without an exit marker", async () => {
		vi.useFakeTimers();
		let manager: BackgroundTaskManager | undefined;
		const processKill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
			if (pid === 43210 && signal === 0) throw new Error("ESRCH");
			return true;
		}) as typeof process.kill);
		try {
			process.env.CMUX_SURFACE_ID = "surface:1";
			const pi = buildPiStub();
			const cmuxSplit = await import("../commands/cmux-split.js");
			vi.spyOn(cmuxSplit, "openCommandInNewSplitWithRefs").mockResolvedValue({
				ok: true,
				workspaceRef: "workspace:1",
				surfaceRef: "surface:8",
			});

			manager = new BackgroundTaskManager(pi as never);
			const task = manager.spawnTask({
				command: "crashy prompt",
				cwd: "/repo",
				visible: true,
				runner: "sumocode",
				notifyOnExit: false,
			});
			await vi.advanceTimersByTimeAsync(50);
			writeFileSync(task.markerFile!, "43210\n");

			await vi.advanceTimersByTimeAsync(1000);

			expect(task.status).toBe("failed");
			expect(readFileSync(task.logFile, "utf8")).toContain("is gone and no exit marker");
		} finally {
			manager?.shutdown();
			processKill.mockRestore();
			vi.useRealTimers();
		}
	});

	it("keeps a started agent task running while its process is alive", async () => {
		vi.useFakeTimers();
		let manager: BackgroundTaskManager | undefined;
		try {
			process.env.CMUX_SURFACE_ID = "surface:1";
			const pi = buildPiStub();
			const cmuxSplit = await import("../commands/cmux-split.js");
			vi.spyOn(cmuxSplit, "openCommandInNewSplitWithRefs").mockResolvedValue({
				ok: true,
				workspaceRef: "workspace:1",
				surfaceRef: "surface:8",
			});

			manager = new BackgroundTaskManager(pi as never);
			const task = manager.spawnTask({
				command: "long-running prompt",
				cwd: "/repo",
				visible: true,
				runner: "sumocode",
				notifyOnExit: false,
			});
			await vi.advanceTimersByTimeAsync(50);
			writeFileSync(task.markerFile!, `${process.pid}\n`);

			await vi.advanceTimersByTimeAsync(1000);

			expect(task.status).toBe("running");
		} finally {
			manager?.shutdown();
			vi.useRealTimers();
		}
	});

	it("fails agent task when task-mode never writes started marker", async () => {
		vi.useFakeTimers();
		let manager: BackgroundTaskManager | undefined;
		try {
			process.env.CMUX_SURFACE_ID = "surface:1";
			const pi = buildPiStub();
			const cmuxSplit = await import("../commands/cmux-split.js");
			vi.spyOn(cmuxSplit, "openCommandInNewSplitWithRefs").mockResolvedValue({
				ok: true,
				workspaceRef: "workspace:1",
				surfaceRef: "surface:8",
			});

			manager = new BackgroundTaskManager(pi as never);
			const task = manager.spawnTask({
				command: "crashy prompt",
				cwd: "/repo",
				visible: true,
				runner: "sumocode",
				notifyOnExit: false,
			});
			await vi.advanceTimersByTimeAsync(50);
			expect(task.status).toBe("running");

			await vi.advanceTimersByTimeAsync(3 * 60 * 1000);

			expect(task.status).toBe("failed");
			expect(readFileSync(task.logFile, "utf8")).toContain("startup timeout");
		} finally {
			manager?.shutdown();
			vi.useRealTimers();
		}
	});

	it("preserves notifyOnExit flag across recovery", () => {
		const root = join(baseDir, "sumocode-bg", "bg-notify-false-1000");
		mkdirSync(root, { recursive: true });
		const logFile = join(root, "output.log");
		const metaFile = join(root, "meta.json");
		writeFileSync(logFile, "running\n");
		writeFileSync(metaFile, `${JSON.stringify({
			schemaVersion: 2,
			id: "bg-notify-false",
			command: "echo quiet",
			cwd: "/tmp",
			status: "running",
			startedAt: 1000,
			updatedAt: 1000,
			logFile,
			metaFile,
			visible: false,
			runner: "shell",
			notifyOnExit: false,
		}, null, 2)}\n`);

		const manager = new BackgroundTaskManager(buildPiStub() as never);

		expect(manager.findTask("bg-notify-false")?.notifyOnExit).toBe(false);
	});

	it("notifies when a recovered running task completes after reload", async () => {
		const root = join(baseDir, "sumocode-bg", "bg-notify-true-1000");
		mkdirSync(root, { recursive: true });
		const logFile = join(root, "output.log");
		const exitFile = join(root, "exit.code");
		const metaFile = join(root, "meta.json");
		writeFileSync(logFile, "running\n");
		writeFileSync(metaFile, `${JSON.stringify({
			schemaVersion: 2,
			id: "bg-notify-true",
			command: "echo loud",
			cwd: "/tmp",
			status: "running",
			startedAt: 1000,
			updatedAt: 1000,
			logFile,
			exitFile,
			metaFile,
			visible: false,
			runner: "shell",
			notifyOnExit: true,
		}, null, 2)}\n`);
		const pi = buildPiStub();
		const manager = new BackgroundTaskManager(pi as never);
		const task = manager.findTask("bg-notify-true");

		writeFileSync(exitFile, "0");
		await vi.waitFor(() => expect(task?.status).toBe("completed"));

		expect(pi.sendUserMessage).toHaveBeenCalled();
	});

	it("recovers agent tasks and fails startup if task-mode never writes started marker", async () => {
		vi.useFakeTimers();
		try {
			const startedAt = Date.now();
			const root = join(baseDir, "sumocode-bg", `bg-recovered-agent-${startedAt}`);
			mkdirSync(root, { recursive: true });
			const logFile = join(root, "output.log");
			const exitFile = join(root, "exit.code");
			const markerFile = join(root, "started.marker");
			const responseFile = join(root, "response.md");
			const metaFile = join(root, "meta.json");
			writeFileSync(logFile, "running\n");
			writeFileSync(metaFile, `${JSON.stringify({
				schemaVersion: 2,
				id: "bg-recovered-agent",
				command: "recover agent",
				cwd: "/tmp",
				status: "running",
				startedAt,
				updatedAt: startedAt,
				logFile,
				exitFile,
				markerFile,
				responseFile,
				metaFile,
				visible: true,
				runner: "sumocode",
			}, null, 2)}\n`);

			const manager = new BackgroundTaskManager(buildPiStub() as never);
			const task = manager.findTask("bg-recovered-agent");
			expect(task?.status).toBe("running");

			await vi.advanceTimersByTimeAsync(3 * 60 * 1000);

			expect(task?.status).toBe("failed");
			expect(readFileSync(logFile, "utf8")).toContain("startup timeout");
		} finally {
			vi.useRealTimers();
		}
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
		const manager = new BackgroundTaskManager(pi as never);
		const task = manager.findTask("bg-recovered-1");

		expect(task?.status).toBe("completed");
		expect(task?.exitCode).toBe(0);
		expect(manager.getTaskHarvest(task!, 1000).content).toContain("done");
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("keeps new invisible shell tasks running when process identity cannot be captured", () => {
		execFileSyncMock.mockImplementation(() => {
			throw new Error("ps unavailable");
		});
		const child = mockLongLivedChild({ pid: 6161 });
		spawnMock.mockReturnValue(child);
		const manager = new BackgroundTaskManager(buildPiStub() as never);

		const task = manager.spawnTask({ command: "sleep 100", cwd: "/tmp", notifyOnExit: false });

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

	it("recovers completed agent tasks from the real-exit marker after reload", () => {
		const root = join(baseDir, "sumocode-bg", "bg-agent-1-1000");
		mkdirSync(root, { recursive: true });
		const logFile = join(root, "output.log");
		const responseFile = join(root, "response.md");
		const exitFile = join(root, "exit.code");
		const metaFile = join(root, "meta.json");
		writeFileSync(logFile, "agent started\n");
		writeFileSync(responseFile, "final answer\n");
		writeFileSync(exitFile, "0\n");
		writeFileSync(metaFile, `${JSON.stringify({
			schemaVersion: 2,
			id: "bg-agent-1",
			command: "do work",
			cwd: "/tmp",
			status: "running",
			startedAt: 1000,
			updatedAt: 1000,
			logFile,
			metaFile,
			exitFile,
			responseFile,
			visible: true,
			runner: "sumocode",
			cmux: { workspaceRef: "workspace:1", surfaceRef: "surface:2" },
		}, null, 2)}\n`);

		const manager = new BackgroundTaskManager(buildPiStub() as never);
		const task = manager.findTask("bg-agent-1");

		expect(task?.status).toBe("completed");
		expect(task?.exitCode).toBe(0);
		expect(manager.getTaskHarvest(task!, 1000)).toMatchObject({ kind: "response", content: "final answer\n", ready: true });
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
		const task = manager.spawnTask({ command: "watch", cwd: "/tmp", notifyOnExit: false });
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
			const task = manager.spawnTask({ command: "watch", cwd: "/tmp", notifyOnExit: false });
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
			const task = manager.spawnTask({ command: "watch", cwd: "/tmp", notifyOnExit: false });
			appendFileSync(task.logFile, "y".repeat(1024));

			await vi.advanceTimersByTimeAsync(15_000);

			expect(readFileSync(task.logFile, "utf8").length).toBe(1024);
			manager.shutdown();
		} finally {
			vi.useRealTimers();
		}
	});
});
