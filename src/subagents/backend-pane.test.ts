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

const createHarness = (
	startResult: typeof startedPane | { ok: false; error: string } = startedPane,
	placement: { kind: "tab"; tabId: string; direction: "right" } | { kind: "workspace"; workspaceId: string; paneId: string } = { kind: "tab", tabId: "w1:t1", direction: "right" },
) => {
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
		// SAFETY: pi.exec is the only member the pane backend uses on this object.
		pi: { exec: vi.fn() } as never,
		placement,
	});
	const events: SubagentEvent[] = [];
	if (!(Symbol.asyncIterator in child.events)) child.events((event: SubagentEvent) => events.push(event));
	else throw new Error("pane backend must use callback events");
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
			// SAFETY: the harness host always records a StartAgentPaneOptions object as the second call argument.
			const launched = (harness.host.startAgentPane as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { shellCommand: string };
			expect(launched.shellCommand).toBe("exec '/tmp/subagents/sa-1-1234/run.sh'");
			const script = harness.fs.files.get(harness.paths.scriptFile) ?? "";
			// Visible children must inherit the pane's real stdout TTY. Stderr is
			// redirected directly to the diagnostics log; a combined-output pipe would
			// make `sumocode` select its non-interactive direct-Pi path.
			expect(script).not.toContain("tee");
			expect(script).toContain("( cd '/repo'");
			expect(script).toContain("exec sumocode 'task'");
			expect(script).toContain("'--task-dir' '/tmp/subagents/sa-1-1234'");
			expect(script).toContain("2>> '/tmp/subagents/sa-1-1234/output.log'");
			// The private script guarantees the exit marker on any process death.
			expect(script).toMatch(/trap '__sumo_finish "\$\?"' EXIT.*trap '__sumo_finish 129' HUP/s);
			harness.fs.files.set(harness.paths.responseFile, "final answer\n");
			harness.fs.files.set(harness.paths.exitFile, "0\n");

			await vi.advanceTimersByTimeAsync(2_000);

			expect(settledEvents(harness.events)).toEqual([{ kind: "run-settled", outcome: { kind: "completed", finalText: "final answer\n" } }]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses the stderr log tail and partial response for non-zero exits", async () => {
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

	it("forwards workspace placement and bootstrap pane to the terminal host", async () => {
		const placement = { kind: "workspace" as const, workspaceId: "w9", paneId: "w9:p1" };
		const harness = createHarness(startedPane, placement);
		await flushPromises();

		expect(harness.host.startAgentPane).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ placement }));
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
			// SAFETY: closePane is a vi.fn double; queueing a rejection exercises the failure path.
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
		const { dirname, join: joinPath } = await import("node:path");
		const run = promisify(execFile);
		const dir = mkdtempSync(joinPath(tmpdir(), "sumo-exit-guard-"));
		try {
			// SAFETY: the double implements only the TerminalHost members this flow touches.
			const host: TerminalHost = {
				kind: "herdr",
				startAgentPane: vi.fn(async () => startedPane),
				closePane: vi.fn(async () => ({ ok: true as const })),
				notify: vi.fn(async () => {}),
			} as never;
			const spawn = createPaneChildSpawner({ baseDir: dir });
			const controller = new AbortController();
			// SAFETY: pi.exec is the only PaneChildOptions member this flow exercises beyond defaults.
			const child = spawn({
				id: "sa-guard",
				prompt: "irrelevant",
				// cd into a directory that does not exist: the child never starts,
				// so only the wrapper's trap can write the exit marker.
				cwd: joinPath(dir, "missing-checkout"),
				signal: controller.signal,
				title: "guard",
				placement: { kind: "tab", tabId: "w1:t1", direction: "right" },
				// SAFETY: pi.exec is the only member the pane backend uses on this object.
				pi: { exec: vi.fn() } as never,
				host,
				// SAFETY: the double covers every TerminalHost member this flow touches.
			} as never);
			if (!(Symbol.asyncIterator in child.events)) child.events(() => {});
			else throw new Error("pane backend must use callback events");
			await flushPromises();
			// SAFETY: startAgentPane records a StartAgentPaneOptions object as its second argument.
			const started = (host.startAgentPane as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { shellCommand: string };
			await run("bash", ["-c", started.shellCommand]).catch(() => {});
			const scriptFile = [...(started.shellCommand.match(/^exec '([^']+)'$/) ?? [])][1]!;
			const exitFile = joinPath(dirname(scriptFile), "exit.code");
			expect(realExists(exitFile)).toBe(true);
			expect(realRead(exitFile, "utf8")).toBe("1");
			child.interrupt();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
