import { describe, expect, it, vi } from "vitest";
import { buildVisibleTaskPaths } from "../background-tasks/visible-spawn.js";
import type { TerminalHost } from "../terminal-host/types.js";
import { type PrivateArtifactStat } from "../private-artifact.js";
import { createPaneChildSpawner } from "./backend-pane.js";
import type { SubagentEvent } from "./domain.js";

class FakeFs {
	readonly files = new Map<string, string>();
	/** Recorded creation modes so permission expectations are assertable. */
	readonly dirModes = new Map<string, number | undefined>();
	readonly fileModes = new Map<string, number | undefined>();
	readonly dirs = new Set<string>();
	/** Adversarial fixture: paths whose lstat reports a symlink instead of a regular file. */
	readonly symlinks = new Set<string>();
	/** Adversarial fixture: paths whose lstat reports a widened (group/other) mode. */
	readonly widenedModes = new Set<string>();

	existsSync(path: string): boolean {
		return this.files.has(path) || this.dirs.has(path) || this.symlinks.has(path);
	}

	lstatSync(path: string): PrivateArtifactStat {
		// SAFETY: the returned literals satisfy the PrivateArtifactStat subset the validators consume.
		if (this.symlinks.has(path)) {
			return { isFile: () => false, isDirectory: () => false, mode: 0o777, uid: process.getuid?.() ?? 0 };
		}
		if (this.dirs.has(path)) {
			const mode = this.dirModes.get(path) ?? 0o700;
			return { isFile: () => false, isDirectory: () => true, mode, uid: process.getuid?.() ?? 0 };
		}
		if (this.files.has(path)) {
			const mode = this.widenedModes.has(path) ? 0o644 : (this.fileModes.get(path) ?? 0o600);
			return { isFile: () => true, isDirectory: () => false, mode, uid: process.getuid?.() ?? 0 };
		}
		// SAFETY: Node reports lstat ENOENT as an ErrnoException; the double reproduces that shape for isEnoent.
		const error = new Error(`ENOENT: no such file or directory, lstat '${path}'`) as Error & { code?: string };
		error.code = "ENOENT";
		throw error;
	}

	mkdirSync(path?: string, options?: { recursive?: boolean; mode?: number }): void {
		if (path === undefined) return;
		if (!options?.recursive && (this.dirs.has(path) || this.files.has(path))) {
			// SAFETY: Node reports mkdir EEXIST as an ErrnoException; the double reproduces that shape for isEexist.
			const error = new Error(`EEXIST: file already exists, mkdir '${path}'`) as Error & { code?: string };
			error.code = "EEXIST";
			throw error;
		}
		// A real recursive mkdir creates missing components with the given mode
		// but never re-modes an existing directory — record only the first mode.
		const created = !this.dirs.has(path);
		this.dirs.add(path);
		if (created) this.dirModes.set(path, options?.mode);
	}

	readFileSync(path: string): string {
		const value = this.files.get(path);
		if (value === undefined) throw new Error(`missing ${path}`);
		return value;
	}

	renameSync(source: string, target: string): void {
		const value = this.files.get(source);
		if (value === undefined) throw new Error(`missing ${source}`);
		this.files.delete(source);
		this.files.set(target, value);
		// A real rename carries the source's mode across.
		this.fileModes.set(target, this.fileModes.get(source));
		this.fileModes.delete(source);
	}

	writeFileSync(path: string, contents: string, options?: { mode?: number; flag?: string }): void {
		if (options?.flag === "wx" && (this.files.has(path) || this.dirs.has(path))) {
			// SAFETY: Node reports open EEXIST as an ErrnoException; the double reproduces that shape for isEexist.
			const error = new Error(`EEXIST: file already exists, open '${path}'`) as Error & { code?: string };
			error.code = "EEXIST";
			throw error;
		}
		this.files.set(path, contents);
		this.fileModes.set(path, options?.mode);
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
	appendSystemPrompt?: string,
	spawnerDependencies?: { sendAckPollMs?: number; sendAckTimeoutMs?: number },
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
	const spawn = createPaneChildSpawner({ fs, now: () => 1234, baseDir: "/tmp/subagents", pollIntervalMs: 750, ...spawnerDependencies });
	const child = spawn({
		prompt: "do the work",
		name: "worker",
		cwd: "/repo",
		id: "sa-1",
		model: "openai/gpt-5",
		thinking: "high",
		appendSystemPrompt,
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
			// Owner-only marker creation is scoped to the guard subshell: the
			// agent process keeps the user's umask.
			expect(script).toContain("( umask 077; printf");
			expect(script).not.toMatch(/^umask 077$/m);
			harness.fs.files.set(harness.paths.responseFile, "final answer\n");
			harness.fs.files.set(harness.paths.exitFile, "0\n");

			await vi.advanceTimersByTimeAsync(2_000);

			expect(settledEvents(harness.events)).toEqual([{ kind: "run-settled", outcome: { kind: "completed", finalText: "final answer\n" } }]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("prepends role instructions to the visible prompt file", () => {
		const harness = createHarness(startedPane, { kind: "tab", tabId: "w1:t1", direction: "right" }, "review carefully");
		expect(harness.fs.files.get(harness.paths.promptFile)).toBe([
			"role instructions (follow these for this entire session):",
			"review carefully",
			"---",
			"do the work",
		].join("\n"));
		harness.child.interrupt();
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

	it("fails closed when the task root is not a private directory", () => {
		const fs = new FakeFs();
		// Simulate a pre-existing, group-accessible root (e.g. hand-created).
		fs.mkdirSync("/tmp/subagents", { recursive: true, mode: 0o755 });
		const spawn = createPaneChildSpawner({ fs, now: () => 1234, baseDir: "/tmp/subagents" });
		// SAFETY: the spawn must fail on allocation before any host/pi member is touched, so empty doubles suffice.
		expect(() => spawn({ prompt: "p", name: "worker", cwd: "/repo", id: "sa-1", host: {} as never, pi: { exec: vi.fn() } as never, placement: { kind: "tab", tabId: "t", direction: "right" } })).toThrow(/task root directory is not owner-only/);
	});

	it("fails closed when the predicted task directory already exists", () => {
		const fs = new FakeFs();
		fs.dirs.add("/tmp/subagents/sa-1-1234");
		const spawn = createPaneChildSpawner({ fs, now: () => 1234, baseDir: "/tmp/subagents" });
		// SAFETY: the spawn must fail on allocation before any host/pi member is touched, so empty doubles suffice.
		expect(() => spawn({ prompt: "p", name: "worker", cwd: "/repo", id: "sa-1", host: {} as never, pi: { exec: vi.fn() } as never, placement: { kind: "tab", tabId: "t", direction: "right" } })).toThrow(/refusing to reuse/);
		// Nothing was written into the pre-existing directory.
		expect([...fs.files.keys()].filter((path) => path.startsWith("/tmp/subagents/sa-1-1234"))).toEqual([]);
	});

	it("exclusive creates never overwrite an existing steer temp file", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await flushPromises();
			const tmpPath = `${harness.paths.controlDir}/steer-1.txt.tmp`;
			harness.fs.files.set(tmpPath, "planted");
			// The exclusive create throws before publication: the planted temp is
			// left byte-for-byte intact.
			expect(() => harness.child.send!("replacement")).toThrow(/EEXIST/);
			expect(harness.fs.files.get(tmpPath)).toBe("planted");
			expect(harness.fs.files.has(`${harness.paths.controlDir}/steer-1.txt`)).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("settles failed when the exit marker is replaced by a symlink", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await flushPromises();
			harness.fs.symlinks.add(harness.paths.exitFile);
			await vi.advanceTimersByTimeAsync(750);
			const settled = settledEvents(harness.events);
			expect(settled).toHaveLength(1);
			expect(settled[0].outcome).toMatchObject({ kind: "failed", errorText: expect.stringContaining("not a regular file") });
		} finally {
			vi.useRealTimers();
		}
	});

	it("completes with an empty response when the child wrote no response artifact", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await flushPromises();
			// Exit 0 with no response.md is a legitimate empty completion.
			harness.fs.files.set(harness.paths.exitFile, "0");
			await vi.advanceTimersByTimeAsync(750);
			expect(settledEvents(harness.events)).toEqual([
				{ kind: "run-settled", outcome: { kind: "completed", finalText: "" } },
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("settles failed when a completed child's response artifact was replaced", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await flushPromises();
			harness.fs.symlinks.add(harness.paths.responseFile);
			harness.fs.files.set(harness.paths.exitFile, "0");
			await vi.advanceTimersByTimeAsync(750);
			// A missing response is a legitimate empty completion, but a replaced
			// response artifact must not surface as a normal result.
			expect(settledEvents(harness.events)).toEqual([
				{ kind: "run-settled", outcome: { kind: "failed", errorText: expect.stringContaining("response artifact refused") } },
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("refuses to harvest from a widened exit marker", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await flushPromises();
			harness.fs.widenedModes.add(harness.paths.exitFile);
			harness.fs.files.set(harness.paths.exitFile, "0");
			await vi.advanceTimersByTimeAsync(750);
			expect(settledEvents(harness.events)[0].outcome.kind).toBe("failed");
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
			// The guard subshell wrote the marker owner-only; the rest of the
			// script (and the agent it launches) keeps the ambient umask.
			const { statSync: realStat } = await import("node:fs");
			expect(realStat(exitFile).mode & 0o777).toBe(0o600);
			child.interrupt();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("pane subagent steering and close", () => {
	it("publishes steer files tmp-then-rename and resolves when the child consumes them", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await flushPromises();
			const steerPath = `${harness.paths.controlDir}/steer-1.txt`;

			const sendPromise = harness.child.send!("focus the tests");
			// tmp-then-rename: the tmp file is consumed by the rename immediately.
			expect(harness.fs.files.has(`${steerPath}.tmp`)).toBe(false);
			expect(harness.fs.files.get(steerPath)).toBe("focus the tests");
			expect(vi.getTimerCount()).toBe(2);

			// No consumption evidence yet — the promise must stay pending.
			await vi.advanceTimersByTimeAsync(250);
			let settled = false;
			void sendPromise.then(() => { settled = true; });
			await flushPromises();
			expect(settled).toBe(false);

			// Unlink proves that the child watcher consumed the control file. It does
			// not prove that Pi accepted the steer into a model turn.
			harness.fs.files.delete(steerPath);
			await vi.advanceTimersByTimeAsync(250);
			await expect(sendPromise).resolves.toBeUndefined();
			expect(vi.getTimerCount()).toBe(1);

			harness.child.interrupt();
			await flushPromises();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("tracks simultaneous sends independently and clears both consumption timers", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await flushPromises();
			const first = harness.child.send!("first steer");
			const second = harness.child.send!("second steer");

			expect(harness.fs.files.get(`${harness.paths.controlDir}/steer-1.txt`)).toBe("first steer");
			expect(harness.fs.files.get(`${harness.paths.controlDir}/steer-2.txt`)).toBe("second steer");
			expect(vi.getTimerCount()).toBe(3);

			harness.fs.files.delete(`${harness.paths.controlDir}/steer-1.txt`);
			harness.fs.files.delete(`${harness.paths.controlDir}/steer-2.txt`);
			await vi.advanceTimersByTimeAsync(250);
			await expect(first).resolves.toBeUndefined();
			await expect(second).resolves.toBeUndefined();
			expect(vi.getTimerCount()).toBe(1);

			harness.child.interrupt();
			await flushPromises();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects all sends and clears every timer when the child exits before consumption", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await flushPromises();
			const first = harness.child.send!("too late");
			const second = harness.child.send!("also too late");
			const firstRejection = expect(first).rejects.toThrow("has settled");
			const secondRejection = expect(second).rejects.toThrow("has settled");
			harness.fs.files.set(harness.paths.exitFile, "0");

			await vi.advanceTimersByTimeAsync(250);
			await firstRejection;
			await secondRejection;
			expect(settledEvents(harness.events)).toHaveLength(1);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects on consumption timeout, preserves the ambiguous file, and removes its timer once", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness(startedPane, { kind: "tab", tabId: "w1:t1", direction: "right" }, undefined, { sendAckPollMs: 100, sendAckTimeoutMs: 500 });
			await flushPromises();
			const sendPromise = harness.child.send!("never acked");
			const rejection = expect(sendPromise).rejects.toThrow("consumption was not acknowledged within 500ms");

			await vi.advanceTimersByTimeAsync(600);
			await rejection;
			// The file remains because Pi may still consume it later; retrying could
			// duplicate steering that Pi already owns.
			expect(harness.fs.files.has(`${harness.paths.controlDir}/steer-1.txt`)).toBe(true);
			expect(vi.getTimerCount()).toBe(1);

			harness.child.interrupt();
			await flushPromises();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the ACK budget monotonic when the exit marker re-reads empty mid-tick", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness(startedPane, { kind: "tab", tabId: "w1:t1", direction: "right" }, undefined, { sendAckPollMs: 100, sendAckTimeoutMs: 500 });
			await flushPromises();
			// Model the producer's truncate-before-write: the ack poll's gate read
			// sees a written marker, but poll()'s own re-read sees the truncated
			// empty file and returns without settling. The timeout must still fire.
			const originalRead = harness.fs.readFileSync.bind(harness.fs);
			let exitReads = 0;
			harness.fs.readFileSync = (path: string): string => {
				const value = originalRead(path);
				if (path === harness.paths.exitFile && value.trim()) {
					exitReads += 1;
					return exitReads % 2 === 1 ? value : "";
				}
				return value;
			};
			harness.fs.files.set(harness.paths.exitFile, "0");
			const sendPromise = harness.child.send!("racy marker");
			const rejection = expect(sendPromise).rejects.toThrow("consumption was not acknowledged within 500ms");

			await vi.advanceTimersByTimeAsync(600);
			await rejection;
			// Ambiguous ownership: the steer file remains, exactly like the plain
			// timeout path.
			expect(harness.fs.files.has(`${harness.paths.controlDir}/steer-1.txt`)).toBe(true);

			harness.child.interrupt();
			await flushPromises();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects a pending send when spawn settlement wins the race", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness({ ok: false, error: "herdr unavailable" });
			const sendPromise = harness.child.send!("pending during setup");
			const rejection = expect(sendPromise).rejects.toThrow("has settled");

			await flushPromises();
			await rejection;
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects simultaneous pending sends immediately on interrupt", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await flushPromises();
			const first = harness.child.send!("first pending");
			const second = harness.child.send!("second pending");
			const firstRejection = expect(first).rejects.toThrow("has settled");
			const secondRejection = expect(second).rejects.toThrow("has settled");

			harness.child.interrupt();
			await firstRejection;
			await secondRejection;
			await flushPromises();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	// Race: the child consumes the control and writes its exit marker BEFORE the
	// next ack tick, so the response poll settles first. The waiter must still
	// resolve — consumption is proven by the absent file, not by the ack tick.
	it("resolves a send whose control was consumed even when the response poll settles first", async () => {
		vi.useFakeTimers();
		try {
			// A 1s ack interval against the 750ms response poll makes the
			// settlement-first ordering deterministic.
			const harness = createHarness(startedPane, { kind: "tab", tabId: "w1:t1", direction: "right" }, undefined, { sendAckPollMs: 1_000 });
			await flushPromises();
			const sendPromise = harness.child.send!("consumed then settled");
			const steerPath = `${harness.paths.controlDir}/steer-1.txt`;
			expect(harness.fs.files.get(steerPath)).toBe("consumed then settled");

			// The child consumes the steer and exits before any ack tick.
			harness.fs.files.delete(steerPath);
			harness.fs.files.set(harness.paths.responseFile, "final answer");
			harness.fs.files.set(harness.paths.exitFile, "0");

			await vi.advanceTimersByTimeAsync(750);

			await expect(sendPromise).resolves.toBeUndefined();
			expect(settledEvents(harness.events)).toEqual([{ kind: "run-settled", outcome: { kind: "completed", finalText: "final answer" } }]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("resolves an interrupted send whose control was already consumed", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await flushPromises();
			const sendPromise = harness.child.send!("consumed before interrupt");
			// The child watcher consumed the control before the interrupt landed:
			// the submission boundary occurred, so the waiter resolves instead of
			// being rejected as ambiguous.
			harness.fs.files.delete(`${harness.paths.controlDir}/steer-1.txt`);

			harness.child.interrupt();
			await expect(sendPromise).resolves.toBeUndefined();
			await flushPromises();
			expect(settledEvents(harness.events)).toEqual([{ kind: "run-settled", outcome: { kind: "interrupted" } }]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("settles a pending send and clears timers after a graceful close exits", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await flushPromises();
			const sendPromise = harness.child.send!("pending at close");
			const rejection = expect(sendPromise).rejects.toThrow("has settled");
			harness.child.requestClose?.();
			harness.fs.files.set(harness.paths.responseFile, "closed");
			harness.fs.files.set(harness.paths.exitFile, "0");

			await vi.advanceTimersByTimeAsync(250);
			await rejection;
			expect(settledEvents(harness.events)).toEqual([{ kind: "run-settled", outcome: { kind: "completed", finalText: "closed" } }]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects send after the child settled", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await flushPromises();
			harness.fs.files.set(harness.paths.responseFile, "done");
			harness.fs.files.set(harness.paths.exitFile, "0");
			await vi.advanceTimersByTimeAsync(2_000);
			expect(settledEvents(harness.events)).toHaveLength(1);

			await expect(harness.child.send!("late")).rejects.toThrow("has settled");
		} finally {
			vi.useRealTimers();
		}
	});

	it("requestClose writes the close.request control file", () => {
		const harness = createHarness();
		harness.child.requestClose?.();
		expect(harness.fs.files.get(`${harness.paths.controlDir}/close.request`)).toBe("1");
		harness.child.interrupt();
	});

	it("requestClose is idempotent and never overwrites a published control", () => {
		const harness = createHarness();
		harness.child.requestClose?.();
		harness.child.requestClose?.();
		expect(harness.fs.files.get(`${harness.paths.controlDir}/close.request`)).toBe("1");
		harness.child.interrupt();
	});

	it("keeps the task dir, control dir, and control files owner-only", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await flushPromises();
			// Steering text routinely carries source snippets, and a timed-out send
			// leaves its file behind, so world-readable /tmp defaults would leak it.
			expect(harness.fs.dirModes.get(harness.paths.controlDir)).toBe(0o700);
			expect([...harness.fs.dirModes.values()].every((mode) => mode === 0o700)).toBe(true);

			const steerPath = `${harness.paths.controlDir}/steer-1.txt`;
			const sendPromise = harness.child.send!("secret steering text");
			// The tmp file is written 0600 and rename preserves it, so the published
			// file is never briefly world-readable.
			expect(harness.fs.fileModes.get(steerPath)).toBe(0o600);

			harness.child.requestClose?.();
			expect(harness.fs.fileModes.get(`${harness.paths.controlDir}/close.request`)).toBe(0o600);

			harness.fs.files.delete(steerPath);
			await vi.advanceTimersByTimeAsync(250);
			await expect(sendPromise).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
