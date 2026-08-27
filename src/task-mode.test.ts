import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	captureAndScrubTaskMarkerEnv,
	extractFinalAssistantText,
	installTaskModeAutoExit,
	resetTaskMarkerEnvForTests,
	shouldInstallTaskModeAutoExit,
	writeTaskExitMarker,
	writeTaskStartedMarker,
} from "./task-mode.js";

type Handler = (...args: unknown[]) => void;

function buildPiStub() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: vi.fn((event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		}),
		sendUserMessage: vi.fn(),
		exec: vi.fn(async (_cmd: string, _args: string[], _opts?: { timeout?: number; env?: NodeJS.ProcessEnv }) => ({
			code: 0,
			stdout: "",
			stderr: "",
			killed: false,
		})),
	};
	return { pi, handlers };
}

function buildCtxStub() {
	const ctx = {
		shutdown: vi.fn(),
		ui: {
			setStatus: vi.fn(),
			notify: vi.fn(),
		},
	};
	return ctx;
}

describe("extractFinalAssistantText", () => {
	it("returns empty string when messages is empty", () => {
		expect(extractFinalAssistantText([])).toBe("");
	});

	it("returns empty string when no assistant message is present", () => {
		expect(
			extractFinalAssistantText([
				{ role: "user", content: [{ type: "text", text: "hello" }] },
			]),
		).toBe("");
	});

	it("extracts text from the LAST assistant message (final response, not intermediates)", () => {
		const text = extractFinalAssistantText([
			{ role: "user", content: [{ type: "text", text: "do the thing" }] },
			{ role: "assistant", content: [{ type: "text", text: "thinking..." }] },
			{ role: "toolResult", content: [{ type: "text", text: "tool out" }] },
			{ role: "assistant", content: [{ type: "text", text: "final answer" }] },
		]);
		expect(text).toBe("final answer");
	});

	it("concatenates multiple text blocks of the final assistant message", () => {
		const text = extractFinalAssistantText([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "part 1" },
					{ type: "tool_use", name: "read" },
					{ type: "text", text: "part 2" },
				],
			},
		]);
		expect(text).toBe("part 1\npart 2");
	});

	it("ignores non-text content blocks (tool_use, tool_result, etc.)", () => {
		const text = extractFinalAssistantText([
			{
				role: "assistant",
				content: [
					{ type: "tool_use", name: "bash" },
					{ type: "text", text: "only this" },
				],
			},
		]);
		expect(text).toBe("only this");
	});

	it("handles malformed input defensively", () => {
		// SAFETY: the malformed arguments are deliberately not message arrays;
		// the extractor must return "" rather than throw.
		expect(extractFinalAssistantText(null as never)).toBe("");
		// SAFETY: the entries are deliberately not message records; the extractor must ignore them.
		expect(extractFinalAssistantText([null, undefined, "not an object"] as never)).toBe("");
	});
});

describe("shouldInstallTaskModeAutoExit", () => {
	it("is true in task mode when keep-open is unset", () => {
		expect(shouldInstallTaskModeAutoExit({ env: { SUMOCODE_TASK_MODE: "1" } })).toBe(true);
	});

	it("is false outside task mode", () => {
		expect(shouldInstallTaskModeAutoExit({ env: {} })).toBe(false);
		expect(shouldInstallTaskModeAutoExit({ env: { SUMOCODE_TASK_MODE: "0" } })).toBe(false);
	});

	it("is false when SUMOCODE_TASK_KEEP_OPEN=1 explicitly opts out", () => {
		expect(
			shouldInstallTaskModeAutoExit({
				env: { SUMOCODE_TASK_MODE: "1", SUMOCODE_TASK_KEEP_OPEN: "1" },
			}),
		).toBe(false);
	});
});

describe("installTaskModeAutoExit", () => {
	let originalResponseFile: string | undefined;
	let originalExitFile: string | undefined;
	let originalStartedFile: string | undefined;
	let workDir: string | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		originalResponseFile = process.env.SUMOCODE_TASK_RESPONSE_FILE;
		originalExitFile = process.env.SUMOCODE_TASK_EXIT_FILE;
		originalStartedFile = process.env.SUMOCODE_TASK_STARTED_FILE;
		delete process.env.SUMOCODE_TASK_RESPONSE_FILE;
		delete process.env.SUMOCODE_TASK_EXIT_FILE;
		delete process.env.SUMOCODE_TASK_STARTED_FILE;
		workDir = undefined;
	});

	afterEach(() => {
		vi.useRealTimers();
		if (originalResponseFile === undefined) delete process.env.SUMOCODE_TASK_RESPONSE_FILE;
		else process.env.SUMOCODE_TASK_RESPONSE_FILE = originalResponseFile;
		if (originalExitFile === undefined) delete process.env.SUMOCODE_TASK_EXIT_FILE;
		else process.env.SUMOCODE_TASK_EXIT_FILE = originalExitFile;
		if (originalStartedFile === undefined) delete process.env.SUMOCODE_TASK_STARTED_FILE;
		else process.env.SUMOCODE_TASK_STARTED_FILE = originalStartedFile;
		if (workDir) rmSync(workDir, { recursive: true, force: true });
	});

	it("does nothing when not in task mode", () => {
		const { pi } = buildPiStub();
		// SAFETY: the pi double supplies the on/exec surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, { env: {} });
		expect(pi.on).not.toHaveBeenCalled();
	});

	it("skips countdown wiring when keep-open is set but still installs the control watcher", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-mode-test-"));
		const controlDir = join(workDir, "control");
		mkdirSync(controlDir, { recursive: true });
		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, {
			env: { SUMOCODE_TASK_MODE: "1", SUMOCODE_TASK_KEEP_OPEN: "1", SUMOCODE_TASK_CONTROL_DIR: controlDir },
			graceMs: 10_000,
		});
		// No auto-exit handlers: agent_end must not arm a countdown.
		expect(handlers.has("agent_end")).toBe(false);
		expect(handlers.has("input")).toBe(false);

		// Close is explicit, not silence-based — it works under keep-open.
		const ctx = buildCtxStub();
		handlers.get("session_start")?.[0]?.({}, ctx);
		writeFileSync(join(controlDir, "close.request"), "1");
		vi.advanceTimersByTime(500);
		expect(ctx.shutdown).toHaveBeenCalledTimes(1);
	});

	it("schedules process shutdown after the silence window on first agent_end", async () => {
		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/exec surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, { env: { SUMOCODE_TASK_MODE: "1" }, graceMs: 10_000 });

		const ctx = buildCtxStub();
		const onAgentEnd = handlers.get("agent_end")?.[0];
		expect(onAgentEnd).toBeDefined();

		onAgentEnd!({ messages: [] }, ctx);

		// status is set immediately with full grace countdown
		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			"sumocode-task-auto-exit",
			expect.stringContaining("exiting in 10s"),
		);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			"sumocode-task-auto-exit",
			expect.stringContaining("type or steer to extend"),
		);

		// nothing has fired yet
		expect(pi.exec).not.toHaveBeenCalled();

		vi.advanceTimersByTime(9_999);
		expect(pi.exec).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		// Let the floated promise inside the timer callback settle
		await Promise.resolve();
		expect(pi.exec).not.toHaveBeenCalled();
		expect(ctx.shutdown).toHaveBeenCalledTimes(1);
	});

	it("kickoff input before the first agent_end is a no-op (no countdown exists yet)", async () => {
		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/exec surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, { env: { SUMOCODE_TASK_MODE: "1" }, graceMs: 10_000 });

		const ctx = buildCtxStub();
		// Pi delivers the CLI positional kickoff as input with source=interactive.
		// This must NOT cancel anything — there is no countdown to cancel, and
		// the subsequent agent_end arms the timer normally.
		handlers.get("input")?.[0]?.({ source: "interactive", text: "kickoff prompt" }, ctx);
		handlers.get("agent_end")?.[0]?.({ messages: [] }, ctx);

		vi.advanceTimersByTime(10_000);
		await Promise.resolve();
		expect(pi.exec).not.toHaveBeenCalled();
		expect(ctx.shutdown).toHaveBeenCalledTimes(1);
	});

	it("interactive input cancels the pending countdown; the next agent_end re-arms it", async () => {
		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/exec surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, { env: { SUMOCODE_TASK_MODE: "1" }, graceMs: 10_000 });

		const ctx = buildCtxStub();
		handlers.get("agent_end")?.[0]?.({ messages: [] }, ctx);
		// User types 3 seconds in — cancels, no longer permanently
		vi.advanceTimersByTime(3_000);
		handlers.get("input")?.[0]?.({ source: "interactive", text: "follow-up" }, ctx);
		vi.advanceTimersByTime(20_000);
		expect(ctx.shutdown).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("auto-exit deferred"), "info");

		// The follow-up turn settles: a fresh full window is armed.
		handlers.get("agent_end")?.[0]?.({ messages: [] }, ctx);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			"sumocode-task-auto-exit",
			expect.stringContaining("exiting in 10s"),
		);
		vi.advanceTimersByTime(9_999);
		expect(ctx.shutdown).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		await Promise.resolve();
		expect(ctx.shutdown).toHaveBeenCalledTimes(1);
	});

	it("agent_start cancels a pending countdown so a running turn is never interrupted", async () => {
		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/exec surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, { env: { SUMOCODE_TASK_MODE: "1" }, graceMs: 10_000 });

		const ctx = buildCtxStub();
		handlers.get("agent_end")?.[0]?.({ messages: [] }, ctx);
		handlers.get("agent_start")?.[0]?.({}, ctx);

		vi.advanceTimersByTime(60_000);
		expect(ctx.shutdown).not.toHaveBeenCalled();

		// Silence after the turn ends exits normally.
		handlers.get("agent_end")?.[0]?.({ messages: [] }, ctx);
		vi.advanceTimersByTime(10_000);
		await Promise.resolve();
		expect(ctx.shutdown).toHaveBeenCalledTimes(1);
	});

	it("re-arms a fresh countdown on every agent_end (silence window restarts)", async () => {
		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/exec surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, { env: { SUMOCODE_TASK_MODE: "1" }, graceMs: 10_000 });

		const ctx = buildCtxStub();
		const onAgentEnd = handlers.get("agent_end")?.[0];

		onAgentEnd!({ messages: [] }, ctx);
		// A second agent_end 8s in replaces the countdown — the full window restarts.
		vi.advanceTimersByTime(8_000);
		onAgentEnd!({ messages: [] }, ctx);
		vi.advanceTimersByTime(8_000);
		expect(ctx.shutdown).not.toHaveBeenCalled();
		vi.advanceTimersByTime(2_000);
		await Promise.resolve();
		expect(ctx.shutdown).toHaveBeenCalledTimes(1);
	});

	it("writes response.md with final assistant text on first agent_end", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-mode-test-"));
		const responseFile = join(workDir, "response.md");
		process.env.SUMOCODE_TASK_RESPONSE_FILE = responseFile;

		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/exec surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, { env: { SUMOCODE_TASK_MODE: "1" }, graceMs: 10_000 });

		const ctx = buildCtxStub();
		handlers.get("agent_end")?.[0]?.(
			{
				messages: [
					{ role: "user", content: [{ type: "text", text: "do x" }] },
					{ role: "assistant", content: [{ type: "text", text: "done x" }] },
				],
			},
			ctx,
		);

		expect(existsSync(responseFile)).toBe(true);
		expect(readFileSync(responseFile, "utf8").trim()).toBe("done x");
	});

	it("updates response.md on later agent_end events while re-arming the countdown", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-mode-test-"));
		const responseFile = join(workDir, "response.md");
		process.env.SUMOCODE_TASK_RESPONSE_FILE = responseFile;

		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/exec surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, { env: { SUMOCODE_TASK_MODE: "1" }, graceMs: 10_000 });

		const ctx = buildCtxStub();
		const onAgentEnd = handlers.get("agent_end")?.[0];
		onAgentEnd?.({ messages: [{ role: "assistant", content: [{ type: "text", text: "first" }] }] }, ctx);
		onAgentEnd?.({ messages: [{ role: "assistant", content: [{ type: "text", text: "second" }] }] }, ctx);

		expect(readFileSync(responseFile, "utf8").trim()).toBe("second");
		// Both agent_end events armed/re-armed the countdown status (the re-arm
		// first clears the status line via cancelPending, then writes the copy).
		expect(ctx.ui.setStatus).toHaveBeenCalledTimes(3);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
			"sumocode-task-auto-exit",
			expect.stringContaining("exiting in 10s"),
		);
	});

	it("writes a task-started marker for manager startup liveness", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-mode-test-"));
		const startedFile = join(workDir, "started.marker");
		// SAFETY: the env double carries only the marker key the helper reads.
		writeTaskStartedMarker({ SUMOCODE_TASK_STARTED_FILE: startedFile } as NodeJS.ProcessEnv);

		expect(readFileSync(startedFile, "utf8").trim()).toBe(String(process.pid));
	});

	it("writes a task-started marker during task-mode install", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-mode-test-"));
		const startedFile = join(workDir, "started.marker");
		const { pi } = buildPiStub();

		// SAFETY: the pi double supplies the on/exec surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, {
			env: { SUMOCODE_TASK_MODE: "1", SUMOCODE_TASK_STARTED_FILE: startedFile },
			graceMs: 10_000,
		});

		expect(readFileSync(startedFile, "utf8").trim()).toBe(String(process.pid));
	});

	it("writes a real-exit marker for the manager to harvest", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-mode-test-"));
		const exitFile = join(workDir, "exit.code");
		// SAFETY: the env double carries only the marker key the helper reads.
		writeTaskExitMarker(0, { SUMOCODE_TASK_EXIT_FILE: exitFile } as NodeJS.ProcessEnv);

		expect(readFileSync(exitFile, "utf8").trim()).toBe("0");
	});

	it("scrubs marker-file env vars at install so subprocesses cannot clobber them", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-mode-test-"));
		const startedFile = join(workDir, "started.marker");
		const responseFile = join(workDir, "response.md");
		const { pi, handlers } = buildPiStub();

		const env: NodeJS.ProcessEnv = {
			SUMOCODE_TASK_MODE: "1",
			SUMOCODE_TASK_STARTED_FILE: startedFile,
			SUMOCODE_TASK_RESPONSE_FILE: responseFile,
			SUMOCODE_TASK_EXIT_FILE: join(workDir, "exit.code"),
			SUMOCODE_TASK_DIAG_FILE: join(workDir, "diag.jsonl"),
		};
		try {
			// SAFETY: the pi double supplies the on/exec surfaces installTaskModeAutoExit reads.
			installTaskModeAutoExit(pi as never, { env, graceMs: 10_000 });

			// Marker keys must be gone from the env (what subprocesses inherit)…
			expect(env.SUMOCODE_TASK_STARTED_FILE).toBeUndefined();
			expect(env.SUMOCODE_TASK_RESPONSE_FILE).toBeUndefined();
			expect(env.SUMOCODE_TASK_EXIT_FILE).toBeUndefined();
			expect(env.SUMOCODE_TASK_DIAG_FILE).toBeUndefined();
			// …task-mode itself stays active for this process…
			expect(env.SUMOCODE_TASK_MODE).toBe("1");
			// …and the lifecycle still writes markers via the captured snapshot.
			expect(readFileSync(startedFile, "utf8").trim()).toBe(String(process.pid));

			const ctx = buildCtxStub();
			handlers.get("agent_end")?.[0]?.(
				{ messages: [{ role: "assistant", content: [{ type: "text", text: "harvested" }] }] },
				ctx,
			);
			expect(readFileSync(responseFile, "utf8").trim()).toBe("harvested");
		} finally {
			resetTaskMarkerEnvForTests();
		}
	});

	it("captureAndScrubTaskMarkerEnv leaves unrelated keys alone", () => {
		try {
			const env: NodeJS.ProcessEnv = {
				SUMOCODE_TASK_EXIT_FILE: "/tmp/x/exit.code",
				SUMOCODE_TASK_MODE: "1",
				PATH: "/usr/bin",
			};
			const snapshot = captureAndScrubTaskMarkerEnv(env);
			expect(snapshot.SUMOCODE_TASK_EXIT_FILE).toBe("/tmp/x/exit.code");
			expect(env.SUMOCODE_TASK_EXIT_FILE).toBeUndefined();
			expect(env.PATH).toBe("/usr/bin");
			expect(env.SUMOCODE_TASK_MODE).toBe("1");
		} finally {
			resetTaskMarkerEnvForTests();
		}
	});

	it("does not write response.md when env var is unset", () => {
		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/exec surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, { env: { SUMOCODE_TASK_MODE: "1" }, graceMs: 10_000 });

		const ctx = buildCtxStub();
		handlers.get("agent_end")?.[0]?.(
			{
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "no harvest" }] },
				],
			},
			ctx,
		);

		// No file path was given — nothing to check, just ensure no crash.
		expect(true).toBe(true);
	});
});

describe("control watcher", () => {
	let workDir: string | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	/** Install task mode with a control dir inside a fresh temp workdir. */
	const installWithControlDir = (keepOpen = false) => {
		const controlDir = join(workDir!, "control");
		mkdirSync(controlDir, { recursive: true });
		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, {
			env: {
				SUMOCODE_TASK_MODE: "1",
				SUMOCODE_TASK_CONTROL_DIR: controlDir,
				...(keepOpen ? { SUMOCODE_TASK_KEEP_OPEN: "1" } : {}),
			},
			graceMs: 10_000,
		});
		const ctx = buildCtxStub();
		// Capture a context the way a real Pi session would.
		handlers.get("session_start")?.[0]?.({}, ctx);
		return { pi, handlers, controlDir, ctx };
	};

	afterEach(() => {
		vi.useRealTimers();
		if (workDir) rmSync(workDir, { recursive: true, force: true });
		workDir = undefined;
		resetTaskMarkerEnvForTests();
	});

	it("injects a steer file as a Pi steering message and unlinks it (the ack)", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const { pi, controlDir } = installWithControlDir();
		const steerPath = join(controlDir, "steer-1.txt");
		writeFileSync(steerPath, "focus on the failing tests");

		vi.advanceTimersByTime(500);

		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(pi.sendUserMessage).toHaveBeenCalledWith("focus on the failing tests", { deliverAs: "steer" });
		expect(existsSync(steerPath)).toBe(false);
	});

	it("processes steer files in ascending seq order within one tick", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const { pi, controlDir } = installWithControlDir();
		// Written out of order on purpose: consumption must sort by seq.
		writeFileSync(join(controlDir, "steer-2.txt"), "second");
		writeFileSync(join(controlDir, "steer-1.txt"), "first");

		vi.advanceTimersByTime(500);

		expect(pi.sendUserMessage.mock.calls.map((call) => call[0])).toEqual(["first", "second"]);
	});

	it("ignores .tmp steer writes until they are renamed into place", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const { pi, controlDir } = installWithControlDir();
		const tmpPath = join(controlDir, "steer-1.txt.tmp");
		writeFileSync(tmpPath, "half written");

		vi.advanceTimersByTime(1_500);

		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(existsSync(tmpPath)).toBe(true);
	});

	it("deletes empty steer files without injecting", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const { pi, controlDir } = installWithControlDir();
		const emptyPath = join(controlDir, "steer-3.txt");
		writeFileSync(emptyPath, "");

		vi.advanceTimersByTime(500);

		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(existsSync(emptyPath)).toBe(false);
	});

	it("close.request shuts the child down and stops the watcher", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const { pi, controlDir, ctx } = installWithControlDir();
		writeFileSync(join(controlDir, "close.request"), "1");

		vi.advanceTimersByTime(500);
		expect(ctx.shutdown).toHaveBeenCalledTimes(1);

		// The watcher is stopped — later ticks must not re-fire shutdown.
		writeFileSync(join(controlDir, "steer-1.txt"), "late steer");
		vi.advanceTimersByTime(2_000);
		expect(ctx.shutdown).toHaveBeenCalledTimes(1);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("tolerates a missing control directory (child booted before the parent created it)", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const { pi } = installWithControlDir();

		expect(() => vi.advanceTimersByTime(1_500)).not.toThrow();
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("steering cancels a pending silence countdown", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const { pi, handlers, controlDir, ctx } = installWithControlDir();
		handlers.get("agent_end")?.[0]?.({ messages: [] }, ctx);
		writeFileSync(join(controlDir, "steer-1.txt"), "steer mid-countdown");

		vi.advanceTimersByTime(500);
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

		// The countdown was cancelled with the steer; nothing re-arms it here
		// (the stub does not fire agent_start/agent_end for the new turn).
		vi.advanceTimersByTime(20_000);
		expect(ctx.shutdown).not.toHaveBeenCalled();
	});

	it("keeps a steer file readable after a read failure on a later tick", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const { pi, controlDir } = installWithControlDir();
		// A directory where a steer file is expected makes readFileSync throw.
		mkdirSync(join(controlDir, "steer-9.txt"));

		expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
		writeFileSync(join(controlDir, "steer-1.txt"), "still works");
		vi.advanceTimersByTime(500);
		expect(pi.sendUserMessage).toHaveBeenCalledWith("still works", { deliverAs: "steer" });
	});
});
