import { describe, expect, it, vi } from "vitest";
import { buildVisibleTaskPaths } from "../background-tasks/visible-spawn.js";
import type { TerminalHost } from "../terminal-host/types.js";
import { createPaneChildSpawner } from "./backend-pane.js";
import type { SubagentEvent } from "./domain.js";

class FakeFs {
	readonly files = new Map<string, string>();

	existsSync(path: string): boolean {
		return this.files.has(path);
	}

	mkdirSync(): void {}

	readFileSync(path: string): string {
		const value = this.files.get(path);
		if (value === undefined) throw new Error(`missing ${path}`);
		return value;
	}

	writeFileSync(path: string, contents: string): void {
		this.files.set(path, contents);
	}
}

const startedPane = {
	ok: true as const,
	pane: { host: "herdr" as const, paneId: "w1:p2", workspaceId: "w1" },
	agentName: "worker-abc",
	workspaceId: "w1",
	tabId: "w1:t1",
	paneId: "w1:p2",
};

const flushPromises = async (): Promise<void> => {
	await Promise.resolve();
	await Promise.resolve();
};

const createHarness = (startResult: typeof startedPane | { ok: false; error: string } = startedPane) => {
	const fs = new FakeFs();
	const closePane = vi.fn(async () => ({ ok: true as const }));
	const host: TerminalHost = {
		kind: "herdr",
		startAgentPane: vi.fn(async () => startResult),
		sendPaneText: vi.fn(async () => ({ ok: true as const })),
		openCommandInSplit: vi.fn(async () => ({ ok: false as const, error: "unused" })),
		closePane,
		notify: vi.fn(async () => undefined),
	};
	const spawn = createPaneChildSpawner({ fs, now: () => 1234, baseDir: "/tmp/subagents", pollIntervalMs: 750 });
	const child = spawn({
		prompt: "do the work",
		name: "worker",
		cwd: "/repo",
		id: "sa-1",
		model: "openai/gpt-5",
		thinking: "high",
		host,
		pi: { exec: vi.fn() } as never,
		placement: { kind: "tab", tabId: "w1:t1", direction: "right" },
	});
	const events: SubagentEvent[] = [];
	if (typeof child.events !== "function") throw new Error("pane backend must use callback events");
	child.events((event: SubagentEvent) => events.push(event));
	return { fs, host, closePane, child, events, paths: buildVisibleTaskPaths("sa-1", 1234, "/tmp/subagents") };
};

const settledEvents = (events: readonly SubagentEvent[]) => events.filter((event): event is Extract<SubagentEvent, { kind: "run-settled" }> => event.kind === "run-settled");

describe("pane subagent backend", () => {
	it("harvests a completed child from response and exit files exactly once", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await flushPromises();
			expect(harness.events).toContainEqual({ kind: "run-started" });
			expect(harness.events).toContainEqual({ kind: "pane-attached", pane: { agentName: "worker-abc", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p2" } });
			expect(harness.fs.files.get(harness.paths.promptFile)).toBe("do the work");
			expect(harness.host.startAgentPane).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
				shellCommand: expect.stringContaining("2>&1 | tee -a '/tmp/subagents/sa-1-1234/output.log'"),
			}));
			// The outer wrapper must guarantee the exit marker on ANY process death
			// (cd failure, crash, pane close) — first-writer-wins with the child.
			expect(harness.host.startAgentPane).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
				shellCommand: expect.stringMatching(/trap '__sumo_finish "\$\?"' EXIT.*trap '__sumo_finish 129' HUP/s),
			}));
			harness.fs.files.set(harness.paths.responseFile, "final answer\n");
			harness.fs.files.set(harness.paths.exitFile, "0\n");

			await vi.advanceTimersByTimeAsync(2_000);

			expect(settledEvents(harness.events)).toEqual([{ kind: "run-settled", outcome: { kind: "completed", finalText: "final answer\n" } }]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses the log tail and partial response for non-zero exits", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await flushPromises();
			harness.fs.files.set(harness.paths.logFile, "earlier\nprovider failed\n");
			harness.fs.files.set(harness.paths.responseFile, "partial work");
			harness.fs.files.set(harness.paths.exitFile, "7");

			await vi.advanceTimersByTimeAsync(750);

			expect(settledEvents(harness.events)).toEqual([{
				kind: "run-settled",
				outcome: { kind: "failed", errorText: "earlier\nprovider failed", partialText: "partial work" },
			}]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels its watcher and closes the pane on interrupt", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await flushPromises();
			expect(vi.getTimerCount()).toBe(1);

			harness.child.interrupt();
			await flushPromises();

			expect(harness.closePane).toHaveBeenCalledWith(expect.anything(), startedPane.pane);
			expect(settledEvents(harness.events)).toEqual([{ kind: "run-settled", outcome: { kind: "interrupted" } }]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the pane evidence and reports a failed close on interrupt", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await flushPromises();
			(harness.closePane as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: "pane still alive" });

			harness.child.interrupt();
			await flushPromises();

			expect(harness.events).toContainEqual({ kind: "pane-attached", pane: { agentName: "worker-abc", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p2" } });
			expect(settledEvents(harness.events)).toEqual([{ kind: "run-settled", outcome: { kind: "failed", errorText: "failed to close visible child pane: pane still alive" } }]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("settles when the host refuses the spawn", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness({ ok: false, error: "herdr unavailable" });
			await flushPromises();
			expect(settledEvents(harness.events)).toEqual([{ kind: "run-settled", outcome: { kind: "failed", errorText: "herdr unavailable" } }]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retries an empty exit marker until the producer writes the code", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await flushPromises();
			harness.fs.files.set(harness.paths.responseFile, "done");
			harness.fs.files.set(harness.paths.exitFile, "");
			await vi.advanceTimersByTimeAsync(750);
			expect(settledEvents(harness.events)).toEqual([]);
			expect(vi.getTimerCount()).toBe(1);

			harness.fs.files.set(harness.paths.exitFile, "0");
			await vi.advanceTimersByTimeAsync(750);
			expect(settledEvents(harness.events)).toEqual([{ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } }]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports malformed exit evidence as a failure", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await flushPromises();
			harness.fs.files.set(harness.paths.exitFile, "unknown");
			await vi.advanceTimersByTimeAsync(750);
			expect(settledEvents(harness.events)).toEqual([{ kind: "run-settled", outcome: { kind: "failed", errorText: "invalid visible child exit marker: unknown" } }]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("exit guard writes the marker when the wrapper dies before sumocode does (real bash)", async () => {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const { mkdtempSync, existsSync: realExists, readFileSync: realRead, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join: joinPath } = await import("node:path");
		const run = promisify(execFile);
		const dir = mkdtempSync(joinPath(tmpdir(), "sumo-exit-guard-"));
		try {
			const host: TerminalHost = {
				kind: "herdr",
				startAgentPane: vi.fn(async () => startedPane),
				closePane: vi.fn(async () => ({ ok: true as const })),
				notify: vi.fn(async () => {}),
			} as never;
			const spawn = createPaneChildSpawner({ baseDir: dir });
			const controller = new AbortController();
			const child = spawn({
				id: "sa-guard",
				prompt: "irrelevant",
				// cd into a directory that does not exist: the child never starts,
				// so only the wrapper's trap can write the exit marker.
				cwd: joinPath(dir, "missing-checkout"),
				signal: controller.signal,
				title: "guard",
				placement: { kind: "tab", tabId: "w1:t1", direction: "right" },
				pi: { exec: vi.fn() } as never,
				host,
			} as never);
			if (typeof child.events !== "function") throw new Error("pane backend must use callback events");
			child.events(() => {});
			await flushPromises();
			const started = (host.startAgentPane as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { shellCommand: string };
			await run("bash", ["-c", started.shellCommand]).catch(() => {});
			const exitFile = [...(started.shellCommand.match(/__sumo_exit_file='([^']+)'/) ?? [])][1]!;
			expect(realExists(exitFile)).toBe(true);
			expect(realRead(exitFile, "utf8")).toBe("1");
			child.interrupt();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
