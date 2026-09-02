import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Valid private-control fixtures: the orchestrator writes the control dir
 * owner-only and every control file 0600, and the child watcher refuses
 * anything else. These helpers mirror that producer contract.
 */
const makeControlDir = (dir: string): void => {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
};
const writeControl = (path: string, text: string): void => {
	writeFileSync(path, text, { mode: 0o600 });
};
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
	captureAndScrubTaskMarkerEnv,
	extractFinalAssistantText,
	installTaskModeAutoExit,
	resetSubmittedControlsForTests,
	resetTaskMarkerEnvForTests,
	shouldInstallTaskModeAutoExit,
	submittedControlsForTests,
	writeTaskExitMarker,
	writeTaskStartedMarker,
} from "./task-mode.js";

type Handler = (...args: unknown[]) => void;

function buildPiStub() {
	const handlers = new Map<string, Handler[]>();
	// Pin the public extension seam: unlike ReplacedSessionContext's method,
	// ExtensionAPI.sendUserMessage synchronously returns void, not Promise<void>.
	const sendUserMessage = vi.fn<ExtensionAPI["sendUserMessage"]>(() => undefined);
	const pi = {
		on: vi.fn((event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		}),
		sendUserMessage,
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
		// The captured marker snapshot is process-global; stale control dirs from
		// one test must not confine another test's markers.
		resetTaskMarkerEnvForTests();
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
		makeControlDir(controlDir);
		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, {
			env: { SUMOCODE_TASK_MODE: "1", SUMOCODE_TASK_KEEP_OPEN: "1", SUMOCODE_TASK_CONTROL_DIR: controlDir },
			graceMs: 10_000,
		});
		// The countdown-only handler stays off under keep-open.
		expect(handlers.has("input")).toBe(false);
		// agent_end IS registered: it persists response.md and honors a deferred
		// close. Those are orchestrator guarantees, not countdown behavior.
		expect(handlers.has("agent_end")).toBe(true);

		const ctx = buildCtxStub();
		handlers.get("session_start")?.[0]?.({}, ctx);
		handlers.get("agent_end")?.[0]?.({ messages: [] }, ctx);
		// ...but it must never arm a countdown here.
		expect(ctx.ui.setStatus).not.toHaveBeenCalled();
		expect(ctx.shutdown).not.toHaveBeenCalled();

		// Close is explicit, not silence-based — it works under keep-open.
		writeControl(join(controlDir, "close.request"), "1");
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
		makeControlDir(join(workDir, "control"));

		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/exec surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, {
			env: {
				SUMOCODE_TASK_MODE: "1",
				SUMOCODE_TASK_RESPONSE_FILE: responseFile,
				SUMOCODE_TASK_CONTROL_DIR: join(workDir, "control"),
			},
			graceMs: 10_000,
		});

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
		makeControlDir(join(workDir, "control"));

		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/exec surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, {
			env: {
				SUMOCODE_TASK_MODE: "1",
				SUMOCODE_TASK_RESPONSE_FILE: responseFile,
				SUMOCODE_TASK_CONTROL_DIR: join(workDir, "control"),
			},
			graceMs: 10_000,
		});

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
		makeControlDir(join(workDir, "control"));
		const { pi } = buildPiStub();

		// SAFETY: the pi double supplies the on/exec surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, {
			env: {
				SUMOCODE_TASK_MODE: "1",
				SUMOCODE_TASK_STARTED_FILE: startedFile,
				SUMOCODE_TASK_CONTROL_DIR: join(workDir, "control"),
			},
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

		makeControlDir(join(workDir, "control"));
		const env: NodeJS.ProcessEnv = {
			SUMOCODE_TASK_MODE: "1",
			SUMOCODE_TASK_STARTED_FILE: startedFile,
			SUMOCODE_TASK_RESPONSE_FILE: responseFile,
			SUMOCODE_TASK_EXIT_FILE: join(workDir, "exit.code"),
			SUMOCODE_TASK_DIAG_FILE: join(workDir, "diag.jsonl"),
			SUMOCODE_TASK_CONTROL_DIR: join(workDir, "control"),
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
	const installWithControlDir = (keepOpen = false, diagFile?: string, unlink?: (path: string) => void) => {
		const controlDir = join(workDir!, "control");
		makeControlDir(controlDir);
		const { pi, handlers } = buildPiStub();
		const env: NodeJS.ProcessEnv = {
			SUMOCODE_TASK_MODE: "1",
			SUMOCODE_TASK_CONTROL_DIR: controlDir,
			SUMOCODE_TASK_DIAG_FILE: diagFile,
		};
		if (keepOpen) env.SUMOCODE_TASK_KEEP_OPEN = "1";
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, {
			env,
			graceMs: 10_000,
			unlink,
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
		// The submitted-control registry is process-global; drop it here so
		// ownership state cannot leak across tests or files.
		resetSubmittedControlsForTests();
	});

	it("submits a steer through the void ExtensionAPI and unlinks only after the synchronous call returns", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const diagFile = join(workDir, "diag.jsonl");
		const { pi, controlDir } = installWithControlDir(false, diagFile);
		const steerPath = join(controlDir, "steer-1.txt");
		writeControl(steerPath, "focus on the failing tests");

		vi.advanceTimersByTime(500);

		expectTypeOf(pi.sendUserMessage).returns.toEqualTypeOf<void>();
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(pi.sendUserMessage).toHaveBeenCalledWith("focus on the failing tests", { deliverAs: "steer" });
		expect(existsSync(steerPath)).toBe(false);
		const diagnostics = readFileSync(diagFile, "utf8");
		expect(diagnostics).toContain('"event":"steer_submitted"');
		expect(diagnostics).not.toMatch(/steer_(?:injected|delivered|accepted)/);
	});

	it("never resubmits a submitted steer whose ack unlink fails; retries the unlink only", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const diagFile = join(workDir, "diag.jsonl");
		// The submission succeeds but the acknowledgement unlink fails once; the
		// injected seam then delegates to the real unlinkSync for the retries.
		let failNextUnlink = true;
		const { pi, controlDir } = installWithControlDir(false, diagFile, (path) => {
			if (failNextUnlink) {
				failNextUnlink = false;
				throw new Error("EBUSY: ack unlink raced a reader");
			}
			unlinkSync(path);
		});
		const steerPath = join(controlDir, "steer-1.txt");
		writeControl(steerPath, "submit exactly once");

		vi.advanceTimersByTime(500);

		// Submitted exactly once, file left behind, and the diagnostic names the
		// ack cleanup — not a submit failure.
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(pi.sendUserMessage).toHaveBeenCalledWith("submit exactly once", { deliverAs: "steer" });
		expect(existsSync(steerPath)).toBe(true);
		const diagnostics = readFileSync(diagFile, "utf8");
		expect(diagnostics).toContain('"event":"steer_ack_unlink_failed"');
		expect(diagnostics).not.toContain('"event":"steer_submit_failed"');

		// The next poll retries ONLY the unlink — no second Pi call.
		vi.advanceTimersByTime(500);
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

		// The eventual unlink success restores the parent semantics: the file is
		// gone, so the parent's consumption acknowledgement resolves.
		vi.advanceTimersByTime(1);
		expect(existsSync(steerPath)).toBe(false);
		expect(readFileSync(diagFile, "utf8")).toContain('"event":"steer_ack_unlinked"');
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
	});

	it("keeps submitted ownership across watcher recreation; the replacement retries the unlink only", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const controlDir = join(workDir!, "control");
		makeControlDir(controlDir);
		const steerPath = join(controlDir, "steer-1.txt");
		writeControl(steerPath, "owned across recreation");
		// Pi recreates the extension API in the SAME process for /new, /resume,
		// and /fork, so both installs see this one (progressively scrubbed) env.
		const env: NodeJS.ProcessEnv = { SUMOCODE_TASK_MODE: "1", SUMOCODE_TASK_CONTROL_DIR: controlDir };
		let failUnlink = true;
		const unlink = (path: string): void => {
			if (failUnlink) throw new Error("EBUSY: ack unlink raced a reader");
			unlinkSync(path);
		};

		const first = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(first.pi as never, { env, graceMs: 10_000, unlink });
		first.handlers.get("session_start")?.[0]?.({}, buildCtxStub());
		vi.advanceTimersByTime(500);

		// The submission succeeded exactly once but the ack unlink failed, so the
		// control remains and the registry owns it.
		expect(first.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(existsSync(steerPath)).toBe(true);
		expect(submittedControlsForTests().get(resolve(controlDir))).toEqual(new Set([steerPath]));

		// Session recreation: the old watcher stops and a fresh one installs on
		// the SAME control directory, with the unlink now succeeding.
		first.handlers.get("session_shutdown")?.[0]?.({}, buildCtxStub());
		failUnlink = false;
		const second = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(second.pi as never, { env, graceMs: 10_000, unlink });
		second.handlers.get("session_start")?.[0]?.({}, buildCtxStub());
		vi.advanceTimersByTime(500);

		// The replacement watcher retried ONLY the unlink — a second Pi call would
		// duplicate steering Pi already owns.
		expect(first.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(second.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(existsSync(steerPath)).toBe(false);

		// The eventual successful unlink cleared the registry entry and its empty
		// directory bucket.
		expect(submittedControlsForTests().get(resolve(controlDir))).toBeUndefined();

		// A genuinely new control submits normally.
		writeControl(join(controlDir, "steer-2.txt"), "fresh steer");
		vi.advanceTimersByTime(500);
		expect(second.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(second.pi.sendUserMessage).toHaveBeenCalledWith("fresh steer", { deliverAs: "steer" });
	});

	it("treats an ENOENT ack unlink as already acknowledged: clears ownership without resubmitting or leaking", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const diagFile = join(workDir, "diag.jsonl");
		// The submission succeeds and the first ack unlink fails with EBUSY. By the
		// retry poll, another consumer has already removed the consumed control, so
		// the retry unlink reports ENOENT — the acknowledgement is then complete.
		let firstUnlink = true;
		const { pi, controlDir } = installWithControlDir(false, diagFile, (path) => {
			if (firstUnlink) {
				firstUnlink = false;
				throw new Error("EBUSY: ack unlink raced a reader");
			}
			// Simulate the other consumer winning the race between readdir and this
			// unlink: the file is gone, and Node surfaces that as ENOENT.
			rmSync(path, { force: true });
			// SAFETY: NodeJS.ErrnoException carries the errno string on its optional `code`; the fixture pins the shape a real unlink rejection would have.
			const enoent = new Error(`ENOENT: no such file or directory, unlink '${path}'`) as NodeJS.ErrnoException;
			enoent.code = "ENOENT";
			throw enoent;
		});
		const steerPath = join(controlDir, "steer-1.txt");
		writeControl(steerPath, "acked by removal");

		vi.advanceTimersByTime(500);
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(submittedControlsForTests().get(resolve(controlDir))).toEqual(new Set([steerPath]));

		// The ENOENT retry clears ownership and names the already-complete ack —
		// it is not retained as a pending unlink failure.
		vi.advanceTimersByTime(500);
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		const diagnostics = readFileSync(diagFile, "utf8");
		expect(diagnostics).toContain('"event":"steer_ack_already_unlinked"');
		expect(diagnostics.match(/"event":"steer_ack_unlink_failed"/g)).toHaveLength(1);
		expect(submittedControlsForTests().get(resolve(controlDir))).toBeUndefined();
		expect([...submittedControlsForTests().keys()].filter((key) => key.startsWith(workDir!))).toEqual([]);

		// No leak, no duplicate: a genuinely new control submits normally.
		writeControl(join(controlDir, "steer-2.txt"), "after the race");
		vi.advanceTimersByTime(500);
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
		expect(pi.sendUserMessage).toHaveBeenCalledWith("after the race", { deliverAs: "steer" });
		expect(existsSync(join(controlDir, "steer-2.txt"))).toBe(false);
	});

	it("canonicalizes the control dir once: equivalent spellings share one bucket with canonical member paths", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const controlDir = join(workDir, "control");
		makeControlDir(controlDir);
		const canonicalControlDir = resolve(controlDir);
		const steerPath = join(canonicalControlDir, "steer-1.txt");
		writeControl(steerPath, "one canonical spelling");

		let failUnlink = true;
		const unlink = (path: string): void => {
			if (failUnlink) throw new Error("EBUSY: ack unlink raced a reader");
			unlinkSync(path);
		};

		// The first install sees an equivalent-but-different spelling (trailing
		// separator) of the SAME directory; the second sees the plain spelling.
		const first = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(first.pi as never, {
			env: { SUMOCODE_TASK_MODE: "1", SUMOCODE_TASK_CONTROL_DIR: `${controlDir}${sep}` },
			graceMs: 10_000,
			unlink,
		});
		first.handlers.get("session_start")?.[0]?.({}, buildCtxStub());
		vi.advanceTimersByTime(500);

		// The bucket key and its member path are both the canonical spelling.
		const snapshot = submittedControlsForTests();
		expect(snapshot.get(canonicalControlDir)).toEqual(new Set([steerPath]));
		expect([...snapshot.keys()].filter((key) => key.startsWith(workDir!))).toEqual([canonicalControlDir]);

		// Session recreation on the plain spelling: the replacement retries the
		// unlink only — equivalent spellings must not duplicate the submission.
		first.handlers.get("session_shutdown")?.[0]?.({}, buildCtxStub());
		failUnlink = false;
		const second = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(second.pi as never, {
			env: { SUMOCODE_TASK_MODE: "1", SUMOCODE_TASK_CONTROL_DIR: controlDir },
			graceMs: 10_000,
			unlink,
		});
		second.handlers.get("session_start")?.[0]?.({}, buildCtxStub());
		vi.advanceTimersByTime(500);

		expect(first.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(second.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(existsSync(steerPath)).toBe(false);
		expect(submittedControlsForTests().get(canonicalControlDir)).toBeUndefined();
	});

	it("shares submitted ownership across distinct module instances in the same process", async () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const controlDir = join(workDir, "control");
		makeControlDir(controlDir);
		const steerPath = join(controlDir, "steer-1.txt");
		writeControl(steerPath, "owned process-wide");
		const env: NodeJS.ProcessEnv = { SUMOCODE_TASK_MODE: "1", SUMOCODE_TASK_CONTROL_DIR: controlDir };
		let failUnlink = true;
		const unlink = (path: string): void => {
			if (failUnlink) throw new Error("EBUSY: ack unlink raced a reader");
			unlinkSync(path);
		};
		const first = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(first.pi as never, { env, graceMs: 10_000, unlink });
		first.handlers.get("session_start")?.[0]?.({}, buildCtxStub());
		vi.advanceTimersByTime(500);

		// Re-evaluating the SAME source models the distinct module instance a
		// committed bundle or second entry path creates. Its registry view must
		// show the first instance's submission — the registry is process-wide.
		vi.resetModules();
		const freshInstance = await import("./task-mode.js");
		expect(freshInstance.submittedControlsForTests().get(resolve(controlDir))).toEqual(new Set([steerPath]));

		// The sibling instance's watcher retries the unlink only: no duplicate Pi
		// submission, and the eventual unlink clears the shared bucket.
		failUnlink = false;
		const second = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		freshInstance.installTaskModeAutoExit(second.pi as never, {
			env: { SUMOCODE_TASK_MODE: "1", SUMOCODE_TASK_CONTROL_DIR: controlDir },
			graceMs: 10_000,
			unlink,
		});
		second.handlers.get("session_start")?.[0]?.({}, buildCtxStub());
		vi.advanceTimersByTime(500);
		expect(first.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(second.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(existsSync(steerPath)).toBe(false);
		expect(freshInstance.submittedControlsForTests().get(resolve(controlDir))).toBeUndefined();
		freshInstance.resetTaskMarkerEnvForTests();
	});

	it("exposes only a cloned snapshot: mutating the test view cannot touch real ownership", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const diagFile = join(workDir, "diag.jsonl");
		const { pi, controlDir } = installWithControlDir(false, diagFile, () => {
			throw new Error("EBUSY: ack unlink raced a reader");
		});
		const steerPath = join(controlDir, "steer-1.txt");
		writeControl(steerPath, "snapshot safety");

		vi.advanceTimersByTime(500);
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(submittedControlsForTests().get(resolve(controlDir))).toEqual(new Set([steerPath]));

		// Wipe the snapshot — even bypassing the readonly types — and the live
		// registry keeps its entry: the next poll still retries the unlink only.
		// SAFETY: the seam returns a deep clone, so this deliberate readonly bypass can mutate only the snapshot; the assertions below prove the live registry kept its entry.
		(submittedControlsForTests() as Map<string, Set<string>>).get(resolve(controlDir))?.clear();
		expect(submittedControlsForTests().get(resolve(controlDir))).toEqual(new Set([steerPath]));
		vi.advanceTimersByTime(500);
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
	});

	it("resetSubmittedControlsForTests clears the process-global registry", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const diagFile = join(workDir, "diag.jsonl");
		const { pi, controlDir } = installWithControlDir(false, diagFile, () => {
			throw new Error("EBUSY: ack unlink raced a reader");
		});
		const steerPath = join(controlDir, "steer-1.txt");
		writeControl(steerPath, "reset clears ownership");

		vi.advanceTimersByTime(500);
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(submittedControlsForTests().get(resolve(controlDir))).toEqual(new Set([steerPath]));

		resetSubmittedControlsForTests();
		expect(submittedControlsForTests().size).toBe(0);
	});

	it("preserves and retries a steer when ExtensionAPI throws synchronously", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const diagFile = join(workDir, "diag.jsonl");
		const { pi, controlDir } = installWithControlDir(false, diagFile);
		const steerPath = join(controlDir, "steer-1.txt");
		writeControl(steerPath, "retry after sync failure");
		pi.sendUserMessage.mockImplementationOnce(() => {
			throw new Error("runtime not ready");
		});

		vi.advanceTimersByTime(500);

		expect(existsSync(steerPath)).toBe(true);
		expect(readFileSync(diagFile, "utf8")).toContain('"event":"steer_submit_failed"');

		vi.advanceTimersByTime(500);
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
		expect(existsSync(steerPath)).toBe(false);
	});

	it("processes steer files in ascending seq order within one tick", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const { pi, controlDir } = installWithControlDir();
		// Written out of order on purpose: consumption must sort by seq.
		writeControl(join(controlDir, "steer-2.txt"), "second");
		writeControl(join(controlDir, "steer-1.txt"), "first");

		vi.advanceTimersByTime(500);

		expect(pi.sendUserMessage.mock.calls.map((call) => call[0])).toEqual(["first", "second"]);
	});

	it("ignores .tmp steer writes until they are renamed into place", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const { pi, controlDir } = installWithControlDir();
		const tmpPath = join(controlDir, "steer-1.txt.tmp");
		writeControl(tmpPath, "half written");

		vi.advanceTimersByTime(1_500);

		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(existsSync(tmpPath)).toBe(true);
	});

	it("consumes empty steer files without submitting them", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const diagFile = join(workDir, "diag.jsonl");
		const { pi, controlDir } = installWithControlDir(false, diagFile);
		const emptyPath = join(controlDir, "steer-3.txt");
		writeControl(emptyPath, "");

		vi.advanceTimersByTime(500);

		// Truthful legacy-blank handling: consumption is recorded with its own
		// diagnostic, and no diagnostic or call claims a Pi submission.
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(existsSync(emptyPath)).toBe(false);
		const diagnostics = readFileSync(diagFile, "utf8");
		expect(diagnostics).toContain('"event":"steer_blank_consumed"');
		expect(diagnostics).not.toContain('"event":"steer_submitted"');
	});

	it("close.request shuts the child down and stops the watcher", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const { pi, controlDir, ctx } = installWithControlDir();
		writeControl(join(controlDir, "close.request"), "1");

		vi.advanceTimersByTime(500);
		expect(ctx.shutdown).toHaveBeenCalledTimes(1);

		// The watcher is stopped — later ticks must not re-fire shutdown.
		writeControl(join(controlDir, "steer-1.txt"), "late steer");
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

	it("holds steer submission until the extension runtime is initialized", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const controlDir = join(workDir, "control");
		makeControlDir(controlDir);
		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, {
			env: { SUMOCODE_TASK_MODE: "1", SUMOCODE_TASK_CONTROL_DIR: controlDir },
			graceMs: 10_000,
		});
		const steerPath = join(controlDir, "steer-1.txt");
		writeControl(steerPath, "steer before boot");

		// No session_start yet: sendUserMessage would throw "Extension runtime not
		// initialized", burning the submission and pushing control consumption
		// past the orchestrator's acknowledgement budget.
		vi.advanceTimersByTime(2_000);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(existsSync(steerPath)).toBe(true);

		handlers.get("session_start")?.[0]?.({}, buildCtxStub());
		vi.advanceTimersByTime(500);

		expect(pi.sendUserMessage).toHaveBeenCalledWith("steer before boot", { deliverAs: "steer" });
		expect(existsSync(steerPath)).toBe(false);
	});

	it("defers a mid-turn close until agent_end has persisted the response", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const controlDir = join(workDir, "control");
		makeControlDir(controlDir);
		const responseFile = join(workDir, "response.md");
		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, {
			env: {
				SUMOCODE_TASK_MODE: "1",
				SUMOCODE_TASK_CONTROL_DIR: controlDir,
				SUMOCODE_TASK_RESPONSE_FILE: responseFile,
			},
			graceMs: 10_000,
		});
		const ctx = buildCtxStub();
		handlers.get("session_start")?.[0]?.({}, ctx);

		// A turn is streaming when the orchestrator asks to close.
		handlers.get("agent_start")?.[0]?.({}, ctx);
		writeControl(join(controlDir, "close.request"), "1");
		vi.advanceTimersByTime(1_500);

		// Exiting here would settle the parent on an empty response.md while
		// reporting a normal completion — losing the in-flight turn.
		expect(ctx.shutdown).not.toHaveBeenCalled();
		expect(existsSync(responseFile)).toBe(false);

		handlers.get("agent_end")?.[0]?.({
			messages: [{ role: "assistant", content: [{ type: "text", text: "the real answer" }] }],
		}, ctx);

		expect(readFileSync(responseFile, "utf8")).toContain("the real answer");
		expect(ctx.shutdown).toHaveBeenCalledTimes(1);
		// The deferred close wins over re-arming the silence countdown.
		expect(ctx.ui.setStatus).not.toHaveBeenCalledWith(expect.any(String), expect.stringContaining("exiting in"));
	});

	it("closes immediately when no turn is active", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const { controlDir, ctx } = installWithControlDir();
		writeControl(join(controlDir, "close.request"), "1");

		vi.advanceTimersByTime(500);

		expect(ctx.shutdown).toHaveBeenCalledTimes(1);
	});

	it("keeps steering alive across session recreation (/new, /resume, /fork)", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const controlDir = join(workDir, "control");
		makeControlDir(controlDir);
		// Pi recreates the extension API in the SAME process, so the second
		// install sees an env the first one already scrubbed.
		const env: NodeJS.ProcessEnv = { SUMOCODE_TASK_MODE: "1", SUMOCODE_TASK_CONTROL_DIR: controlDir };
		const first = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(first.pi as never, { env, graceMs: 10_000 });
		first.handlers.get("session_start")?.[0]?.({}, buildCtxStub());
		first.handlers.get("session_shutdown")?.[0]?.({}, buildCtxStub());
		expect(env.SUMOCODE_TASK_CONTROL_DIR).toBeUndefined();

		const second = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(second.pi as never, { env, graceMs: 10_000 });
		second.handlers.get("session_start")?.[0]?.({}, buildCtxStub());
		const steerPath = join(controlDir, "steer-1.txt");
		writeControl(steerPath, "steer after resume");
		vi.advanceTimersByTime(500);

		expect(second.pi.sendUserMessage).toHaveBeenCalledWith("steer after resume", { deliverAs: "steer" });
		expect(existsSync(steerPath)).toBe(false);
	});

	it("steering cancels a pending silence countdown", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const { pi, handlers, controlDir, ctx } = installWithControlDir();
		handlers.get("agent_end")?.[0]?.({ messages: [] }, ctx);
		writeControl(join(controlDir, "steer-1.txt"), "steer mid-countdown");

		vi.advanceTimersByTime(500);
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

		// The countdown was cancelled with the steer; nothing re-arms it here
		// (the stub does not fire agent_start/agent_end for the new turn).
		vi.advanceTimersByTime(20_000);
		expect(ctx.shutdown).not.toHaveBeenCalled();
	});

	it("consumes controls created after the watcher boots (late control dir)", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const controlDir = join(workDir, "control");
		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, {
			env: { SUMOCODE_TASK_MODE: "1", SUMOCODE_TASK_CONTROL_DIR: controlDir },
			graceMs: 10_000,
		});
		handlers.get("session_start")?.[0]?.({}, buildCtxStub());
		vi.advanceTimersByTime(500);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();

		// The orchestrator creates the control dir after the child booted.
		makeControlDir(controlDir);
		writeControl(join(controlDir, "steer-1.txt"), "late dir steer");
		vi.advanceTimersByTime(500);
		expect(pi.sendUserMessage).toHaveBeenCalledWith("late dir steer", { deliverAs: "steer" });
	});

	it("drops diag lines through an in-task-dir symlinked sink without following it", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-mode-test-"));
		makeControlDir(join(workDir, "control"));
		const outside = mkdtempSync(join(tmpdir(), "sumocode-task-escape-"));
		const victimDiag = join(outside, "diag.jsonl");
		const diagFile = join(workDir, "diag.jsonl");
		symlinkSync(victimDiag, diagFile);
		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, {
			env: {
				SUMOCODE_TASK_MODE: "1",
				SUMOCODE_TASK_CONTROL_DIR: join(workDir, "control"),
				SUMOCODE_TASK_DIAG_FILE: diagFile,
			},
			graceMs: 10_000,
		});
		handlers.get("session_start")?.[0]?.({}, buildCtxStub());
		vi.advanceTimersByTime(500);
		// The sink was tampered after a legitimate-looking capture: the line is
		// dropped, and the symlink target is never created.
		expect(existsSync(victimDiag)).toBe(false);
		expect(lstatSync(diagFile).isSymbolicLink()).toBe(true);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("refuses a control dir that is a symlink and consumes nothing", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const realDir = join(workDir, "elsewhere");
		makeControlDir(realDir);
		const controlDir = join(workDir, "control");
		symlinkSync(realDir, controlDir);
		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, {
			env: { SUMOCODE_TASK_MODE: "1", SUMOCODE_TASK_CONTROL_DIR: controlDir },
			graceMs: 10_000,
		});
		handlers.get("session_start")?.[0]?.({}, buildCtxStub());
		writeControl(join(realDir, "steer-1.txt"), "sneaky");
		vi.advanceTimersByTime(1_000);
		// The watcher is live (a session context is captured) but refuses the
		// redirected control dir, so the steer is never consumed.
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(existsSync(join(realDir, "steer-1.txt"))).toBe(true);
		expect(handlers.has("session_start")).toBe(true);
	});

	it("re-validates the control dir on every tick after a later swap", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const { pi, controlDir } = installWithControlDir();
		writeControl(join(controlDir, "steer-1.txt"), "first");
		vi.advanceTimersByTime(500);
		expect(pi.sendUserMessage).toHaveBeenCalledWith("first", { deliverAs: "steer" });

		// Swap the validated control dir for a symlink to another private dir
		// carrying a planted control: the next tick must re-validate and refuse.
		const realDir = join(workDir!, "elsewhere");
		makeControlDir(realDir);
		writeControl(join(realDir, "steer-2.txt"), "sneaky");
		rmSync(controlDir, { recursive: true, force: true });
		symlinkSync(realDir, controlDir);
		vi.advanceTimersByTime(500);
		expect(pi.sendUserMessage).not.toHaveBeenCalledWith("sneaky", { deliverAs: "steer" });
		expect(existsSync(join(realDir, "steer-2.txt"))).toBe(true);
	});

	it("refuses a group-readable control dir", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const controlDir = join(workDir, "control");
		mkdirSync(controlDir, { recursive: true, mode: 0o755 });
		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, {
			env: { SUMOCODE_TASK_MODE: "1", SUMOCODE_TASK_CONTROL_DIR: controlDir },
			graceMs: 10_000,
		});
		const ctx = buildCtxStub();
		handlers.get("session_start")?.[0]?.({}, ctx);
		writeControl(join(controlDir, "steer-1.txt"), "wide open");
		writeControl(join(controlDir, "close.request"), "1");
		vi.advanceTimersByTime(1_000);
		// The watcher is live (a session context is captured) but the widened
		// directory fails closed: no steering is consumed and no close honored.
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(ctx.shutdown).not.toHaveBeenCalled();
	});

	it("refuses a symlinked steer control, leaves it in place, and never submits it", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const { pi, controlDir } = installWithControlDir();
		const victim = join(workDir, "victim.txt");
		writeFileSync(victim, "do not read", { mode: 0o600 });
		const steerPath = join(controlDir, "steer-1.txt");
		symlinkSync(victim, steerPath);

		vi.advanceTimersByTime(1_000);

		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		// The replaced control stays on disk: the parent's send budget then ends
		// in an ambiguous timeout, which the existing protocol treats as
		// recoverable rather than acknowledging a control we refused to read.
		expect(existsSync(steerPath)).toBe(true);
		expect(readFileSync(victim, "utf8")).toBe("do not read");
	});

	it("refuses a response marker redirected outside the task dir", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-mode-test-"));
		makeControlDir(join(workDir, "control"));
		const outside = mkdtempSync(join(tmpdir(), "sumocode-task-escape-"));
		const responseFile = join(outside, "response.md");
		const diagFile = join(workDir, "diag.jsonl");
		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, {
			env: {
				SUMOCODE_TASK_MODE: "1",
				SUMOCODE_TASK_RESPONSE_FILE: responseFile,
				SUMOCODE_TASK_CONTROL_DIR: join(workDir, "control"),
				SUMOCODE_TASK_DIAG_FILE: diagFile,
			},
			graceMs: 10_000,
		});
		const ctx = buildCtxStub();
		handlers.get("agent_end")?.[0]?.(
			{ messages: [{ role: "assistant", content: [{ type: "text", text: "harvested" }] }] },
			ctx,
		);
		expect(existsSync(responseFile)).toBe(false);
		expect(readFileSync(diagFile, "utf8")).toContain("marker_refused");
	});

	it("refuses to overwrite a response artifact replaced by a symlink", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-mode-test-"));
		makeControlDir(join(workDir, "control"));
		const responseFile = join(workDir, "response.md");
		const victim = join(workDir, "victim.md");
		writeFileSync(victim, "keep me", { mode: 0o600 });
		symlinkSync(victim, responseFile);
		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, {
			env: {
				SUMOCODE_TASK_MODE: "1",
				SUMOCODE_TASK_RESPONSE_FILE: responseFile,
				SUMOCODE_TASK_CONTROL_DIR: join(workDir, "control"),
			},
			graceMs: 10_000,
		});
		handlers.get("agent_end")?.[0]?.(
			{ messages: [{ role: "assistant", content: [{ type: "text", text: "harvested" }] }] },
			buildCtxStub(),
		);
		expect(readFileSync(victim, "utf8")).toBe("keep me");
		expect(existsSync(responseFile)).toBe(true);
		expect(readFileSync(responseFile, "utf8")).toBe("keep me");
	});

	it("refuses to unlink a submitted control that was replaced before the ack", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const victim = join(workDir, "victim.txt");
		writeFileSync(victim, "do not remove", { mode: 0o600 });
		let attempts = 0;
		const replaceWithSymlinkThenFail = (path: string): void => {
			attempts += 1;
			if (attempts === 1) {
				// The ack unlink fails once (raced reader), and an adversary replaces
				// the control with a symlink before the retry.
				unlinkSync(path);
				symlinkSync(victim, path);
				throw new Error("EBUSY: ack unlink raced a reader");
			}
			// Guard must refuse: a later retry never removes the replacement.
			throw new Error("retry must not reach unlink through the replaced path");
		};
		const { pi, controlDir } = installWithControlDir(false, undefined, replaceWithSymlinkThenFail);
		const steerPath = join(controlDir, "steer-1.txt");
		writeControl(steerPath, "submitted then swapped");

		vi.advanceTimersByTime(2_000);

		// Submission happened exactly once; the replacement was never unlinked.
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(attempts).toBe(1);
		expect(existsSync(steerPath)).toBe(true);
		expect(readFileSync(victim, "utf8")).toBe("do not remove");
	});

	it("quarantines all markers before logging refusals when no control dir is set", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-mode-test-"));
		const outside = mkdtempSync(join(tmpdir(), "sumocode-task-escape-"));
		const outsideDiag = join(outside, "diag.jsonl");
		const responseFile = join(workDir, "response.md");
		const { pi } = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, {
			env: {
				SUMOCODE_TASK_MODE: "1",
				SUMOCODE_TASK_RESPONSE_FILE: responseFile,
				SUMOCODE_TASK_DIAG_FILE: outsideDiag,
			},
			graceMs: 10_000,
		});
		// Without a control dir, both markers are refused; the diag sink must be
		// quarantined before the response refusal is logged, so nothing is ever
		// appended to the unvalidated diag path.
		expect(existsSync(outsideDiag)).toBe(false);
		expect(existsSync(responseFile)).toBe(false);
	});

	it("does not write a refusal through a refused diag path", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-mode-test-"));
		makeControlDir(join(workDir, "control"));
		const outside = mkdtempSync(join(tmpdir(), "sumocode-task-escape-"));
		const outsideDiag = join(outside, "diag.jsonl");
		const responseFile = join(workDir, "response.md");
		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, {
			env: {
				SUMOCODE_TASK_MODE: "1",
				SUMOCODE_TASK_RESPONSE_FILE: responseFile,
				SUMOCODE_TASK_CONTROL_DIR: join(workDir, "control"),
				SUMOCODE_TASK_DIAG_FILE: outsideDiag,
			},
			graceMs: 10_000,
		});
		handlers.get("agent_end")?.[0]?.(
			{ messages: [{ role: "assistant", content: [{ type: "text", text: "harvested" }] }] },
			buildCtxStub(),
		);
		// The escaped diag file is quarantined before its own refusal is logged,
		// so nothing is ever appended to it; the valid response still persists.
		expect(existsSync(outsideDiag)).toBe(false);
		expect(existsSync(responseFile)).toBe(true);
	});

	it("refuses to create a response artifact through a dangling symlink", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-mode-test-"));
		makeControlDir(join(workDir, "control"));
		const responseFile = join(workDir, "response.md");
		const outside = mkdtempSync(join(tmpdir(), "sumocode-task-escape-"));
		const victim = join(outside, "response.md");
		symlinkSync(victim, responseFile);
		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, {
			env: {
				SUMOCODE_TASK_MODE: "1",
				SUMOCODE_TASK_RESPONSE_FILE: responseFile,
				SUMOCODE_TASK_CONTROL_DIR: join(workDir, "control"),
			},
			graceMs: 10_000,
		});
		handlers.get("agent_end")?.[0]?.(
			{ messages: [{ role: "assistant", content: [{ type: "text", text: "harvested" }] }] },
			buildCtxStub(),
		);
		// The dangling link was not followed: no target file was created and no
		// response landed outside the task dir.
		expect(existsSync(victim)).toBe(false);
		expect(lstatSync(responseFile).isSymbolicLink()).toBe(true);
	});

	it("honors a `..`-decorated marker by writing to its resolved task-dir path", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-mode-test-"));
		makeControlDir(join(workDir, "control"));
		const responseFile = join(workDir, "sub", "..", "response.md");
		const { pi, handlers } = buildPiStub();
		// SAFETY: the pi double supplies the on/sendUserMessage surfaces installTaskModeAutoExit reads.
		installTaskModeAutoExit(pi as never, {
			env: {
				SUMOCODE_TASK_MODE: "1",
				SUMOCODE_TASK_RESPONSE_FILE: responseFile,
				SUMOCODE_TASK_CONTROL_DIR: join(workDir, "control"),
			},
			graceMs: 10_000,
		});
		handlers.get("agent_end")?.[0]?.(
			{ messages: [{ role: "assistant", content: [{ type: "text", text: "resolved" }] }] },
			buildCtxStub(),
		);
		// Capture normalized the spelling: the artifact exists once, at the
		// resolved direct-child path.
		expect(existsSync(join(workDir, "response.md"))).toBe(true);
		expect(readFileSync(join(workDir, "response.md"), "utf8").trim()).toBe("resolved");
	});

	it("refuses a symlinked close control and keeps steering live", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const victim = join(workDir, "victim.txt");
		writeFileSync(victim, "not a close control", { mode: 0o600 });
		const { pi, controlDir } = installWithControlDir();
		symlinkSync(victim, join(controlDir, "close.request"));
		const ctx = buildCtxStub();
		// Re-capture the context the way installWithControlDir does (its ctx is
		// already captured); close.request arrives on the first tick.
		vi.advanceTimersByTime(500);
		expect(ctx.shutdown).not.toHaveBeenCalled();

		// The control channel is still live: a valid steer is consumed.
		writeControl(join(controlDir, "steer-1.txt"), "still steering");
		vi.advanceTimersByTime(500);
		expect(pi.sendUserMessage).toHaveBeenCalledWith("still steering", { deliverAs: "steer" });
		// The replacement was never removed.
		expect(existsSync(join(controlDir, "close.request"))).toBe(true);
	});

	it("keeps a steer file readable after a read failure on a later tick", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-control-"));
		const { pi, controlDir } = installWithControlDir();
		// A directory where a steer file is expected makes readFileSync throw.
		mkdirSync(join(controlDir, "steer-9.txt"));

		expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
		writeControl(join(controlDir, "steer-1.txt"), "still works");
		vi.advanceTimersByTime(500);
		expect(pi.sendUserMessage).toHaveBeenCalledWith("still works", { deliverAs: "steer" });
	});
});
