import { describe, expect, it, vi } from "vitest";
import { buildVisibleTaskPaths } from "../background-tasks/visible-spawn.js";
import type { TerminalHost } from "../terminal-host/types.js";
import { type PrivateArtifactStat } from "../private-artifact.js";
import { createPaneChildSpawner, type VisibleLaunchEvidence, type VisibleLaunchGate } from "./backend-pane.js";
import type { ProcessTreeOperations } from "../background-tasks/process-tree.js";
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
	/** Adversarial fixture: paths whose lstat reports foreign ownership. */
	readonly foreignUids = new Set<string>();

	existsSync(path: string): boolean {
		return this.files.has(path) || this.dirs.has(path) || this.symlinks.has(path);
	}

	realpathSync(path: string): string { return path; }

	lstatSync(path: string): PrivateArtifactStat {
		// SAFETY: the returned literals satisfy the PrivateArtifactStat subset the validators consume.
		if (this.symlinks.has(path)) {
			return { isFile: () => false, isDirectory: () => false, mode: 0o777, uid: process.getuid?.() ?? 0 };
		}
		if (this.dirs.has(path)) {
			const mode = this.dirModes.get(path) ?? 0o700;
			const uid = this.foreignUids.has(path) ? (process.getuid?.() ?? 0) + 1 : (process.getuid?.() ?? 0);
			return { isFile: () => false, isDirectory: () => true, mode, uid };
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

	chmodSync(path: string, mode: number): void {
		// chmod follows symlinks in node; the production code only chmods
		// entries it has already lstat-validated as real directories.
		if (!this.dirs.has(path) && !this.files.has(path)) {
			throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);
		}
		this.dirModes.set(path, mode);
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
		if (options?.flag === "wx" && (this.files.has(path) || this.dirs.has(path) || this.symlinks.has(path))) {
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
	startResult: typeof startedPane | { ok: false; error: string; code?: string; reason?: string; orphanPaneId?: string; orphanTabId?: string } = startedPane,
	placement: { kind: "tab"; tabId: string; direction: "right" } | { kind: "workspace"; workspaceId: string; paneId: string } = { kind: "tab", tabId: "w1:t1", direction: "right" },
	appendSystemPrompt?: string,
	spawnerDependencies?: { sendAckPollMs?: number; sendAckTimeoutMs?: number; resolveLauncher?: () => string; env?: NodeJS.ProcessEnv },
	onEvent?: (event: SubagentEvent) => void,
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
	const spawn = createPaneChildSpawner({ fs, now: () => 1234, baseDir: "/tmp/subagents", pollIntervalMs: 750, env: {}, ...spawnerDependencies });
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
	if (!(Symbol.asyncIterator in child.events)) child.events((event: SubagentEvent) => {
		events.push(event);
		onEvent?.(event);
	});
	else throw new Error("pane backend must use callback events");
	return { fs, host, closePane, child, events, paths: buildVisibleTaskPaths("sa-1", 1234, "/tmp/subagents") };
};

const settledEvents = (events: readonly SubagentEvent[]) => events.filter((event): event is Extract<SubagentEvent, { kind: "run-settled" }> => event.kind === "run-settled");

const createGateHarness = () => {
	const fs = new FakeFs();
	const taskDir = "/tmp/subagents/sa-gate-1234";
	const bornFile = `${taskDir}/launch.born`;
	const releaseFile = `${taskDir}/launch.release`;
	let nonce = "";
	const evidence: VisibleLaunchEvidence[] = [];
	const operations: ProcessTreeOperations = {
		captureStartTime: () => `birth /bin/bash ${taskDir}/run.sh ${nonce}`,
		identityMatches: () => "same",
		captureTreeVerification: () => ({ members: [{ pid: 4242, processStartTime: "birth" }] }),
		verificationMatches: () => "same",
		isTreeEmpty: () => false,
		signalTree: vi.fn(),
		waitForTreeEmpty: vi.fn(),
	};
	const gate: VisibleLaunchGate = {
		beforeSpawn(launch) { nonce = launch.nonce; },
		wrapperBorn(value) { evidence.push(value); },
		beforeRelease: vi.fn(),
		beforeEffect: vi.fn(),
		onRefused: vi.fn(),
		interrupt: vi.fn(),
	};
	const host: TerminalHost = {
		kind: "herdr",
		startAgentPane: vi.fn(async () => startedPane),
		closePane: vi.fn(), openCommandInSplit: vi.fn(), notify: vi.fn(),
	};
	const spawn = createPaneChildSpawner({ fs, now: () => 1234, baseDir: "/tmp/subagents", resolveLauncher: () => "/parent tools/sumocode", env: {}, processTree: operations });
	const options = {
		id: "sa-gate", name: "worker", prompt: "private task prompt", cwd: "/repo", host,
		pi: { exec: vi.fn() }, placement: { kind: "tab" as const, tabId: "t", direction: "right" as const }, launchGate: gate,
	};
	const child = spawn(options);
	const events: SubagentEvent[] = [];
	const subscribe = (): void => {
		if (Symbol.asyncIterator in child.events) throw new Error("expected callback backend");
		child.events((event) => events.push(event));
	};
	const born = (): void => { fs.writeFileSync(bornFile, `${nonce}\n4242\n4242\nbirth\n`, { mode: 0o600 }); };
	return { fs, taskDir, bornFile, releaseFile, gate, operations, host, child, events, evidence, subscribe, born, options, get nonce() { return nonce; } };
};

describe("visible launch gate", () => {
	it("fences follow-up host commands after an awaited creation and retains late pane evidence", async () => {
		vi.useFakeTimers();
		try {
			const h = createGateHarness();
			let revoked = false;
			h.gate.beforeEffect = () => { if (revoked) throw new Error("lease lost"); };
			h.options.pi.exec.mockImplementation(async () => {
				revoked = true;
				return { code: 0, stdout: "created pane evidence", stderr: "", killed: false };
			});
			h.host.startAgentPane = async (pi) => {
				await pi.exec("herdr", ["pane", "split"]);
				await pi.exec("herdr", ["pane", "run", "w1:p2", "private command"]).catch(() => undefined);
				await pi.exec("herdr", ["pane", "close", "w1:p2"]).catch(() => undefined);
				return startedPane;
			};
			h.subscribe();
			await vi.advanceTimersByTimeAsync(1000);
			expect(h.options.pi.exec).toHaveBeenCalledTimes(1);
			await expect(h.child.ready).rejects.toThrow(/lease lost/);
			expect(h.events.some((event) => event.kind === "pane-attached")).toBe(true);
			expect(h.gate.onRefused).toHaveBeenCalledOnce();
			expect(settledEvents(h.events)).toEqual([]);
			expect(h.fs.files.has(h.releaseFile)).toBe(false);
			expect(vi.getTimerCount()).toBe(0);
		} finally { vi.clearAllTimers(); vi.useRealTimers(); }
	});

	for (const boundary of ["ack tick", "result tick"] as const) {
		it(`rejects late consumption at ${boundary} after authority loss and stops timers`, async () => {
			vi.useFakeTimers();
			try {
				const h = createGateHarness();
				h.subscribe(); h.born();
				await vi.advanceTimersByTimeAsync(50);
				await h.child.ready;
				if (boundary === "result tick") await vi.advanceTimersByTimeAsync(500);
				const consumed = h.child.send!("consumed private text");
				const pending = h.child.send!("pending private text");
				const consumedCheck = consumed.catch((error: Error) => error.message);
				const pendingCheck = pending.catch((error: Error) => error.message);
				h.fs.files.delete(`${h.taskDir}/control/steer-1.txt`);
				if (boundary === "result tick") {
					// The earlier-registered response poll wins the shared 800ms deadline.
					h.fs.files.set(`${h.taskDir}/exit.code`, "0");
				}
				h.gate.beforeEffect = () => { throw new Error("revoked"); };
				h.gate.onRefused = vi.fn(() => { throw new Error("disk unavailable"); });
				await vi.advanceTimersByTimeAsync(1000);
				expect(await consumedCheck).toMatch(/unconfirmed/);
				expect(await pendingCheck).toMatch(/unconfirmed/);
				expect(h.fs.files.get(`${h.taskDir}/control/steer-2.txt`)).toBe("pending private text");
				expect(h.gate.onRefused).toHaveBeenCalledOnce();
				h.gate.beforeEffect = vi.fn();
				h.child.interrupt();
				await expect(h.child.send!("retry forbidden")).rejects.toThrow(/unconfirmed/);
				expect(() => h.child.requestClose!()).toThrow(/unconfirmed/);
				expect(h.gate.interrupt).not.toHaveBeenCalled();
				expect(h.host.closePane).not.toHaveBeenCalled();
				expect(settledEvents(h.events)).toEqual([]);
				expect(vi.getTimerCount()).toBe(0);
			} finally { vi.clearAllTimers(); vi.useRealTimers(); }
		});
	}

	it("does not authorize host failure cleanup from a pane ID even with a live persistence owner", async () => {
		vi.useFakeTimers();
		try {
			const h = createGateHarness();
			h.options.pi.exec.mockResolvedValue({ code: 0, stdout: "", stderr: "", killed: false });
			h.host.startAgentPane = async (pi) => {
				await pi.exec("herdr", ["pane", "split"]);
				await pi.exec("herdr", ["pane", "close", "w1:p2"]).catch(() => undefined);
				return startedPane;
			};
			h.subscribe();
			await vi.advanceTimersByTimeAsync(100);
			expect(h.options.pi.exec).toHaveBeenCalledTimes(1);
			await expect(h.child.ready).rejects.toThrow(/verified.*authority/);
			expect(h.events.some((event) => event.kind === "pane-attached")).toBe(true);
			expect(h.operations.signalTree).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally { vi.clearAllTimers(); vi.useRealTimers(); }
	});

	for (const cut of ["late pane", "release", "steer temp", "close after await"] as const) {
		it(`fences the ${cut} write boundary without discarding private evidence`, async () => {
			vi.useFakeTimers();
			try {
				const h = createGateHarness();
				let revoked = false;
				h.gate.beforeEffect = () => { if (revoked) throw new Error("lease revoked"); };
				if (cut === "late pane") h.host.startAgentPane = async () => {
					await Promise.resolve(); revoked = true; return startedPane;
				};
				if (cut === "release") h.gate.beforeRelease = () => { revoked = true; };
				h.subscribe(); h.born();
				await vi.advanceTimersByTimeAsync(50);
				if (cut === "late pane" || cut === "release") {
					await expect(h.child.ready).rejects.toThrow(/lease revoked/);
					expect(h.fs.files.has(h.releaseFile)).toBe(false);
					expect(h.events.some((event) => event.kind === "pane-attached")).toBe(true);
					expect(h.evidence).toHaveLength(cut === "release" ? 1 : 0);
				} else {
					await h.child.ready;
					if (cut === "steer temp") {
						const write = h.fs.writeFileSync.bind(h.fs);
						h.fs.writeFileSync = (path, text, opts) => {
							write(path, text, opts);
							if (path.endsWith(".tmp")) revoked = true;
						};
						await expect(h.child.send!("private pending text")).rejects.toThrow(/unconfirmed/);
						expect(h.fs.files.get(`${h.taskDir}/control/steer-1.txt.tmp`)).toBe("private pending text");
						expect(h.fs.files.has(`${h.taskDir}/control/steer-1.txt`)).toBe(false);
					} else {
						await Promise.resolve(); revoked = true;
						expect(() => h.child.requestClose!()).toThrow(/unconfirmed/);
						expect(h.fs.files.has(`${h.taskDir}/control/close.request`)).toBe(false);
					}
				}
				expect(h.fs.files.get(`${h.taskDir}/prompt.txt`)).toBe("private task prompt");
				expect(h.fs.files.has(h.bornFile)).toBe(true);
				expect(h.gate.onRefused).toHaveBeenCalledOnce();
				expect(settledEvents(h.events)).toEqual([]);
				expect(h.host.closePane).not.toHaveBeenCalled();
				expect(vi.getTimerCount()).toBe(0);
			} finally { vi.clearAllTimers(); vi.useRealTimers(); }
		});
	}

	it("allows fenced host command and key effects on the normal launch path", async () => {
		vi.useFakeTimers();
		try {
			const h = createGateHarness();
			h.options.pi.exec.mockResolvedValue({ code: 0, stdout: "", stderr: "", killed: false });
			h.host.startAgentPane = async (pi) => {
				await pi.exec("herdr", ["pane", "split"]);
				await pi.exec("herdr", ["pane", "run", "w1:p2", "run.sh"]);
				await pi.exec("herdr", ["pane", "send-key", "w1:p2", "enter"]);
				return startedPane;
			};
			h.subscribe(); h.born();
			await vi.advanceTimersByTimeAsync(50);
			await h.child.ready;
			expect(h.options.pi.exec).toHaveBeenCalledTimes(3);
			expect(h.fs.files.get(h.releaseFile)).toBe(h.nonce);
			expect(h.gate.onRefused).not.toHaveBeenCalled();
		} finally { vi.clearAllTimers(); vi.useRealTimers(); }
	});

	it("stops delayed host follow-ups after launch timeout without closing the late pane", async () => {
		vi.useFakeTimers();
		try {
			const h = createGateHarness();
			let finish = (): void => {};
			const created = new Promise<void>((resolve) => { finish = resolve; });
			h.options.pi.exec.mockImplementation(async () => {
				await created;
				return { code: 0, stdout: "created", stderr: "", killed: false };
			});
			h.host.startAgentPane = async (pi) => {
				await pi.exec("herdr", ["pane", "split"]);
				await pi.exec("herdr", ["pane", "run", "w1:p2", "run.sh"]).catch(() => undefined);
				return startedPane;
			};
			h.subscribe();
			await vi.advanceTimersByTimeAsync(30_000);
			await expect(h.child.ready).rejects.toThrow(/timed out/);
			finish();
			await vi.advanceTimersByTimeAsync(1000);
			expect(h.options.pi.exec).toHaveBeenCalledTimes(1);
			expect(h.events.some((event) => event.kind === "pane-attached")).toBe(true);
			expect(h.host.closePane).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally { vi.clearAllTimers(); vi.useRealTimers(); }
	});

	it("contains a refused cancellation callback and stops autonomous watchers", async () => {
		vi.useFakeTimers();
		try {
			const h = createGateHarness();
			h.subscribe(); h.born();
			await vi.advanceTimersByTimeAsync(50);
			await h.child.ready;
			const send = h.child.send!("private pending text").catch((error: Error) => error.message);
			h.gate.interrupt = vi.fn(() => { throw new Error("verified cancellation refused"); });
			expect(() => h.child.interrupt()).not.toThrow();
			expect(await send).toMatch(/unconfirmed/);
			h.child.interrupt();
			expect(h.gate.interrupt).toHaveBeenCalledOnce();
			expect(h.gate.onRefused).toHaveBeenCalledOnce();
			expect(h.fs.files.get(`${h.taskDir}/control/steer-1.txt`)).toBe("private pending text");
			expect(settledEvents(h.events)).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		} finally { vi.clearAllTimers(); vi.useRealTimers(); }
	});

	it("preserves a gated send file after the unchanged visible consumption timeout", async () => {
		vi.useFakeTimers();
		try {
			const h = createGateHarness();
			h.subscribe(); h.born();
			await vi.advanceTimersByTimeAsync(50);
			await h.child.ready;
			const send = h.child.send!("private timed out text").catch((error: Error) => error.message);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(await send).toMatch(/not acknowledged within 30000ms.*file remains/);
			expect(h.fs.files.get(`${h.taskDir}/control/steer-1.txt`)).toBe("private timed out text");
			expect(h.gate.onRefused).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(1);
		} finally { vi.clearAllTimers(); vi.useRealTimers(); }
	});

	it("refuses a planted release symlink before the persistence callback", async () => {
		vi.useFakeTimers();
		try {
			const h = createGateHarness();
			h.subscribe(); h.born();
			h.fs.symlinks.add(h.releaseFile);
			const refused = expect(h.child.ready).rejects.toThrow();
			await vi.advanceTimersByTimeAsync(50);
			await refused;
			expect(h.evidence).toEqual([]);
			expect(h.host.closePane).not.toHaveBeenCalled();
			expect(settledEvents(h.events)).toEqual([]);
			expect(h.fs.symlinks.has(h.releaseFile)).toBe(true);
		} finally { vi.clearAllTimers(); vi.useRealTimers(); }
	});

	for (const refusal of ["nonce", "birth", "symlink", "mode", "owner", "shared group", "command", "unknown identity", "missing anchors", "extra fields"] as const) {
		it(`holds launcher release on forged ${refusal} evidence without signalling or settlement`, async () => {
			vi.useFakeTimers();
			try {
				const h = createGateHarness();
				h.subscribe(); h.born();
				switch (refusal) {
					case "nonce": h.fs.files.set(h.bornFile, "forged\n4242\n4242\nbirth\n"); break;
					case "birth": h.fs.files.set(h.bornFile, `${h.nonce}\n4242\n4242\nreused-pid-birth\n`); break;
					case "symlink": h.fs.symlinks.add(h.bornFile); break;
					case "mode": h.fs.widenedModes.add(h.bornFile); break;
					case "owner": h.fs.foreignUids.add(h.taskDir); break;
					case "shared group": h.fs.files.set(h.bornFile, `${h.nonce}\n4242\n9999\nbirth\n`); break;
					case "command": h.operations.captureStartTime = () => "birth unrelated-command"; break;
					case "unknown identity": h.operations.identityMatches = () => "unknown"; break;
					case "missing anchors": h.operations.captureTreeVerification = () => undefined; break;
					case "extra fields": h.fs.files.set(h.bornFile, `${h.nonce}\n4242\n4242\nbirth\nextra\n`); break;
				}
				const refused = expect(h.child.ready).rejects.toThrow();
				await vi.advanceTimersByTimeAsync(50);
				await refused;
				expect(h.evidence).toEqual([]);
				expect(h.fs.files.has(h.releaseFile)).toBe(false);
				expect(h.fs.files.has(h.bornFile)).toBe(true);
				expect(h.operations.signalTree).not.toHaveBeenCalled();
				expect(h.host.closePane).not.toHaveBeenCalled();
				expect(settledEvents(h.events)).toEqual([]);
				expect(vi.getTimerCount()).toBe(0);
			} finally { vi.clearAllTimers(); vi.useRealTimers(); }
		});
	}

	it("rejects ready on the bounded birth wait, keeps late pane evidence and never retries release", async () => {
		vi.useFakeTimers();
		try {
			const h = createGateHarness();
			let finishPane = (_pane: typeof startedPane): void => {};
			h.host.startAgentPane = () => new Promise((resolve) => { finishPane = resolve; });
			h.subscribe();
			const refused = expect(h.child.ready).rejects.toThrow(/timed out.*evidence retained/);
			await vi.advanceTimersByTimeAsync(30_000);
			await refused;
			finishPane(startedPane); h.born();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(h.events).toContainEqual({ kind: "pane-attached", pane: { agentName: "worker-abc", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p2" } });
			expect(h.evidence).toEqual([]);
			expect(h.fs.files.has(h.releaseFile)).toBe(false);
			expect(h.fs.files.get(`${h.taskDir}/prompt.txt`)).toBe("private task prompt");
			expect(h.host.closePane).not.toHaveBeenCalled();
			expect(settledEvents(h.events)).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		} finally { vi.clearAllTimers(); vi.useRealTimers(); }
	});

	it("retains captured evidence if final birth verification refuses release", async () => {
		vi.useFakeTimers();
		try {
			const h = createGateHarness();
			h.gate.wrapperBorn = (evidence) => {
				h.evidence.push(evidence);
				h.operations.identityMatches = () => "different";
			};
			h.subscribe(); h.born();
			const refused = expect(h.child.ready).rejects.toThrow("identity is ambiguous");
			await vi.advanceTimersByTimeAsync(50);
			await refused;
			expect(h.evidence).toHaveLength(1);
			expect(h.fs.files.has(h.bornFile)).toBe(true);
			expect(h.fs.files.has(h.releaseFile)).toBe(false);
			h.child.interrupt();
			expect(h.gate.interrupt).toHaveBeenCalledOnce();
			expect(h.operations.signalTree).not.toHaveBeenCalled();
			expect(h.host.closePane).not.toHaveBeenCalled();
			expect(settledEvents(h.events)).toEqual([]);
		} finally { vi.clearAllTimers(); vi.useRealTimers(); }
	});

	for (const cut of ["wrapper persistence", "release fence"] as const) {
		it(`refuses ${cut} without dropping the handle or inventing process death`, async () => {
			vi.useFakeTimers();
			try {
				const h = createGateHarness();
				const refuse = (): void => { throw new Error("lease expired"); };
				if (cut === "wrapper persistence") h.gate.wrapperBorn = refuse;
				else h.gate.beforeRelease = refuse;
				h.subscribe(); h.born();
				const rejected = expect(h.child.ready).rejects.toThrow("lease expired");
				await vi.advanceTimersByTimeAsync(50);
				await rejected;
				expect(h.fs.files.has(h.releaseFile)).toBe(false);
				expect(h.fs.files.has(h.bornFile)).toBe(true);
				expect(h.evidence).toHaveLength(cut === "wrapper persistence" ? 0 : 1);
				h.child.interrupt();
				expect(h.gate.interrupt).not.toHaveBeenCalled();
				expect(h.host.closePane).not.toHaveBeenCalled();
				expect(settledEvents(h.events)).toEqual([]);
			} finally { vi.clearAllTimers(); vi.useRealTimers(); }
		});
	}

	it("retains task-mode control and result watching after release and delegates cancel without fake settlement", async () => {
		vi.useFakeTimers();
		try {
			const h = createGateHarness();
			h.subscribe(); h.born();
			await vi.advanceTimersByTimeAsync(50);
			await h.child.ready;
			const send = h.child.send!("next task");
			const steer = `${h.taskDir}/control/steer-1.txt`;
			expect(h.fs.files.get(steer)).toBe("next task");
			h.fs.files.delete(steer);
			await vi.advanceTimersByTimeAsync(250);
			await send;
			h.child.requestClose!();
			expect(h.fs.files.get(`${h.taskDir}/control/close.request`)).toBe("1");
			h.child.interrupt();
			expect(h.gate.interrupt).toHaveBeenCalledOnce();
			expect(h.host.closePane).not.toHaveBeenCalled();
			expect(settledEvents(h.events)).toEqual([]);
			h.fs.writeFileSync(`${h.taskDir}/response.md`, "done", { mode: 0o600 });
			h.fs.writeFileSync(`${h.taskDir}/exit.code`, "0", { mode: 0o600 });
			await vi.advanceTimersByTimeAsync(750);
			expect(settledEvents(h.events)).toEqual([{ kind: "run-settled", outcome: { kind: "completed", finalText: "done" } }]);
			expect(vi.getTimerCount()).toBe(0);
		} finally { vi.clearAllTimers(); vi.useRealTimers(); }
	});

	it("refuses spawn on the starting fence and prevents resubscription or early controls", async () => {
		const h = createGateHarness();
		h.gate.beforeSpawn = () => { throw new Error("starting lease refused"); };
		h.subscribe();
		await expect(h.child.ready).rejects.toThrow("starting lease refused");
		expect(h.host.startAgentPane).not.toHaveBeenCalled();
		expect(h.subscribe).toThrow("already subscribed");
		await expect(h.child.send!("secret steer")).rejects.toThrow("unconfirmed");
		expect(() => h.child.requestClose!()).toThrow("unconfirmed");
		expect([...h.fs.files.keys()].some((path) => path.includes("/control/"))).toBe(false);
		expect(settledEvents(h.events)).toEqual([]);
	});

	it("does not create a pane when cancellation arrives during the starting fence", async () => {
		const h = createGateHarness();
		h.gate.beforeSpawn = () => h.child.interrupt();
		h.subscribe();
		await expect(h.child.ready).rejects.toThrow("interrupted before release");
		expect(h.host.startAgentPane).not.toHaveBeenCalled();
		expect(h.gate.interrupt).toHaveBeenCalledOnce();
	});

	it("delegates pre-release cancellation to the retained owner without closing a pane or releasing work", async () => {
		vi.useFakeTimers();
		try {
			const h = createGateHarness();
			h.subscribe(); h.born();
			h.child.interrupt();
			await expect(h.child.ready).rejects.toThrow("interrupted before release");
			await vi.advanceTimersByTimeAsync(100);
			expect(h.gate.interrupt).toHaveBeenCalledOnce();
			expect(h.host.closePane).not.toHaveBeenCalled();
			expect(h.evidence).toEqual([]);
			expect(h.fs.files.has(h.releaseFile)).toBe(false);
			expect(settledEvents(h.events)).toEqual([]);
		} finally { vi.clearAllTimers(); vi.useRealTimers(); }
	});

	it("places the bounded private wait before all launcher/model/task work and preserves PTY stdout", () => {
		const h = createGateHarness();
		const script = h.fs.files.get(`${h.taskDir}/run.sh`)!;
		expect(script).toContain("__sumo_wait<300");
		expect(script).toContain("[ ! -L \"$1\" ] && [ -O \"$1\" ]");
		expect(script).toContain("set -C; printf");
		expect(script).toContain("__sumo_private '/tmp/subagents/sa-gate-1234/launch.release' 600 || exit 125");
		const hold = script.indexOf('[ "$__sumo_released" = 1 ] || exit 125');
		const launch = script.indexOf("exec '/parent tools/sumocode' 'task'");
		expect(hold).toBeGreaterThan(0);
		expect(launch).toBeGreaterThan(hold);
		expect(script.indexOf("trap '__sumo_finish")).toBeGreaterThan(hold);
		expect(script).toContain("'--task-dir' '/tmp/subagents/sa-gate-1234'");
		expect(script).not.toContain("private task prompt");
		expect(script).not.toContain("tee");
		expect(script).toContain("2>> '/tmp/subagents/sa-gate-1234/output.log'");
	});

	it("gives the durable gate a canonical task path rather than an ancestor alias", async () => {
		const h = createGateHarness();
		const fs = new FakeFs();
		fs.realpathSync = (path) => {
			const canonical = path.replace("/tmp/", "/private/tmp/");
			fs.dirs.add(canonical);
			fs.dirModes.set(canonical, 0o700);
			return canonical;
		};
		const gate = { ...h.gate, beforeSpawn: vi.fn(() => { throw new Error("recorded path"); }) };
		const child = createPaneChildSpawner({ fs, now: () => 1234, baseDir: "/tmp/subagents", resolveLauncher: () => "/parent/sumocode" })({ ...h.options, launchGate: gate });
		if (Symbol.asyncIterator in child.events) throw new Error("expected callback backend");
		child.events(() => {});
		await expect(child.ready).rejects.toThrow("recorded path");
		expect(gate.beforeSpawn).toHaveBeenCalledWith({ taskDir: "/private/tmp/subagents/sa-gate-1234", nonce: expect.any(String) });
		expect(fs.files.has("/private/tmp/subagents/sa-gate-1234/prompt.txt")).toBe(true);
	});

	it("rejects PATH launcher fallback for gated launches", () => {
		const h = createGateHarness();
		const spawn = createPaneChildSpawner({ fs: new FakeFs(), now: () => 1234, baseDir: "/tmp/subagents", resolveLauncher: () => "sumocode" });
		expect(() => spawn(h.options)).toThrow("absolute SumoCode provenance");
		expect(h.host.startAgentPane).not.toHaveBeenCalled();
	});

	it("records before pane spawn and persists verified wrapper and pane references before private release", async () => {
		vi.useFakeTimers();
		try {
			const h = createGateHarness();
			h.host.startAgentPane = vi.fn(async () => {
				expect(h.nonce).toMatch(/^[a-f0-9-]{36}$/);
				expect(h.fs.files.has(h.releaseFile)).toBe(false);
				return startedPane;
			});
			h.gate.wrapperBorn = (evidence) => {
				expect(h.fs.files.has(h.releaseFile)).toBe(false);
				expect(evidence.process).toEqual({
					identity: { pid: 4242, processGroupId: 4242, processStartTime: `birth /bin/bash ${h.taskDir}/run.sh ${h.nonce}` },
					verification: { members: [{ pid: 4242, processStartTime: "birth" }] },
				});
				expect(evidence.pane).toEqual(startedPane);
				h.evidence.push(evidence);
			};
			h.gate.beforeRelease = () => {
				expect(h.evidence).toHaveLength(1);
				// No slow OS recapture may run after the final lease fence.
				h.operations.identityMatches = () => { throw new Error("OS inspection after fence"); };
			};
			h.subscribe();
			await flushPromises();
			expect(h.evidence).toEqual([]);
			h.born();
			await vi.advanceTimersByTimeAsync(50);
			await h.child.ready;
			expect(h.evidence).toHaveLength(1);
			expect(h.fs.files.get(h.releaseFile)).toBe(h.nonce);
			expect(h.operations.signalTree).not.toHaveBeenCalled();
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});
});

describe("pane subagent backend", () => {
	it("emits only fresh private heartbeat observations and leaves no timer after settlement", async () => {
		vi.useFakeTimers();
		try {
			const { fs, child, paths, events, closePane } = createHarness();
			await child.ready;
			const file = `${paths.controlDir}/heartbeat`;
			fs.writeFileSync(file, "1234\n", { mode: 0o600 });
			await vi.advanceTimersByTimeAsync(750);
			expect(events.filter((event) => event.kind === "heartbeat")).toEqual([{ kind: "heartbeat", at: 1234 }]);
			await vi.advanceTimersByTimeAsync(750);
			fs.writeFileSync(file, "1235\n", { mode: 0o600 });
			await vi.advanceTimersByTimeAsync(750);
			fs.symlinks.add(file);
			await vi.advanceTimersByTimeAsync(750);
			expect(events.filter((event) => event.kind === "heartbeat")).toHaveLength(1);
			expect(closePane).not.toHaveBeenCalled();
			fs.writeFileSync(paths.exitFile, "0\n");
			await vi.advanceTimersByTimeAsync(750);
			expect(vi.getTimerCount()).toBe(0);
		} finally { vi.useRealTimers(); }
	});
	it("retains the control and result watcher while replacing a same-process event observer", async () => {
		vi.useFakeTimers();
		const oldEvents: SubagentEvent[] = [];
		const newEvents: SubagentEvent[] = [];
		let observer = (event: SubagentEvent): void => { oldEvents.push(event); };
		const harness = createHarness(startedPane, undefined, undefined, undefined, (event) => observer(event));
		try {
			await harness.child.ready;
			observer = (event) => { newEvents.push(event); };
			const ack = harness.child.send!("continue after replacement");
			const control = `${harness.paths.controlDir}/steer-1.txt`;
			expect(harness.fs.files.get(control)).toBe("continue after replacement");
			// This simulates task-mode consumption, not Pi/model acceptance or real recovery.
			harness.fs.files.delete(control);
			await vi.advanceTimersByTimeAsync(250);
			await ack;
			harness.fs.writeFileSync(harness.paths.responseFile, "after replacement", { mode: 0o600 });
			harness.fs.writeFileSync(harness.paths.exitFile, "0", { mode: 0o600 });
			await vi.advanceTimersByTimeAsync(750);
			expect(harness.host.startAgentPane).toHaveBeenCalledTimes(1);
			expect(harness.closePane).not.toHaveBeenCalled();
			expect(settledEvents(oldEvents)).toEqual([]);
			expect(newEvents).toEqual([{
				kind: "run-settled",
				outcome: { kind: "completed", finalText: "after replacement" },
			}]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			harness.child.interrupt();
			await flushPromises();
			vi.useRealTimers();
		}
	});

	it("threads launcher provenance into the visible child command", () => {
		const harness = createHarness(startedPane, undefined, undefined, { resolveLauncher: () => "/parent tools/sumocode" });
		const script = harness.fs.files.get(harness.paths.scriptFile) ?? "";
		expect(script).toContain("exec '/parent tools/sumocode' 'task'");
		harness.child.interrupt();
	});

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
			expect(script).toContain("( umask 077; set -C; printf");
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

	it("starts a worktree child with the parent launcher and Pi binary", async () => {
		const harness = createHarness(startedPane, { kind: "workspace", workspaceId: "w9", paneId: "w9:p1" }, undefined, {
			env: {
				SUMOCODE_LAUNCHER: "/opt/Sumo Code/bin/sumocode.sh",
				PI_BIN: "/opt/Pi Current/bin/pi",
			},
		});
		await flushPromises();

		const script = harness.fs.files.get(harness.paths.scriptFile) ?? "";
		expect(script).toContain("exec env 'PI_BIN=/opt/Pi Current/bin/pi' '/opt/Sumo Code/bin/sumocode.sh' 'task'");
		expect(script).not.toContain("exec sumocode 'task'");
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
			expect(settledEvents(harness.events)).toEqual([{ kind: "run-settled", outcome: { kind: "failed", errorText: "failed to close visible child pane: pane still alive", paneStillOpen: true } }]);
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

	it("preserves a structured pane-unavailable host failure", async () => {
		const harness = createHarness({
			ok: false,
			code: "pane_unavailable",
			error: "herdr returned no pane for tab w5:t8",
			reason: "tab has no available shell pane",
		});
		await flushPromises();

		expect(settledEvents(harness.events)).toEqual([{
			kind: "run-settled",
			outcome: {
				kind: "failed",
				errorText: "herdr returned no pane for tab w5:t8",
				errorCode: "pane_unavailable",
				errorReason: "tab has no available shell pane",
			},
		}]);
	});

	it("reports provisioning orphans so their slot stays counted", async () => {
		const harness = createHarness({
			ok: false,
			code: "pane_unavailable",
			error: "herdr pane run exited 1",
			reason: "herdr pane run exited 1; cleanup: close refused",
			orphanPaneId: "w1:p9",
		});
		await flushPromises();

		expect(settledEvents(harness.events)).toEqual([{
			kind: "run-settled",
			outcome: {
				kind: "failed",
				errorText: "herdr pane run exited 1",
				errorCode: "pane_unavailable",
				errorReason: "herdr pane run exited 1; cleanup: close refused",
				paneStillOpen: true,
				orphanPane: { agentName: "worker", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p9" },
			},
		}]);
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

	it("self-heals a widened task root left by an older build", () => {
		const fs = new FakeFs();
		// Simulate a pre-existing, group-accessible root (recursive mkdir from an
		// older build never re-modes an existing directory).
		fs.mkdirSync("/tmp/subagents", { recursive: true, mode: 0o755 });
		const spawn = createPaneChildSpawner({ fs, now: () => 1234, baseDir: "/tmp/subagents" });
		// SAFETY: the spawn fails on allocation before any host/pi member is touched, so empty doubles suffice.
		expect(() => spawn({ prompt: "p", name: "worker", cwd: "/repo", id: "sa-1", host: {} as never, pi: { exec: vi.fn() } as never, placement: { kind: "tab", tabId: "t", direction: "right" } })).not.toThrow();
		expect(fs.dirModes.get("/tmp/subagents")).toBe(0o700);
	});

	it("never chmods a foreign-owned task root, even with filesystem capability", () => {
		const fs = new FakeFs();
		fs.mkdirSync("/tmp/subagents", { recursive: true, mode: 0o755 });
		fs.foreignUids.add("/tmp/subagents");
		const spawn = createPaneChildSpawner({ fs, now: () => 1234, baseDir: "/tmp/subagents" });
		// SAFETY: the spawn must fail on allocation before any host/pi member is touched, so empty doubles suffice.
		expect(() => spawn({ prompt: "p", name: "worker", cwd: "/repo", id: "sa-1", host: {} as never, pi: { exec: vi.fn() } as never, placement: { kind: "tab", tabId: "t", direction: "right" } })).toThrow(/task root directory/);
		// Ownership is checked before chmod: a foreign dir must never be re-moded.
		expect(fs.dirModes.get("/tmp/subagents")).toBe(0o755);
	});

	it("fails closed when the task root is a symlinked directory", () => {
		const fs = new FakeFs();
		// SAFETY: the spawn fails on allocation before any host/pi member is touched, so empty doubles suffice.
		const spawn = createPaneChildSpawner({ fs, now: () => 1234, baseDir: "/tmp/subagents" });
		fs.dirs.add("/tmp/subagents");
		fs.symlinks.add("/tmp/subagents");
		// SAFETY: the spawn must fail on allocation before any host/pi member is touched, so empty doubles suffice.
		expect(() => spawn({ prompt: "p", name: "worker", cwd: "/repo", id: "sa-1", host: {} as never, pi: { exec: vi.fn() } as never, placement: { kind: "tab", tabId: "t", direction: "right" } })).toThrow(/task root directory is not a directory/);
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
			// lstat (not existsSync) detects the replacement: a dangling symlink
			// must settle failed, not read as "not yet written" and pin the child.
			expect(settled[0].outcome).toMatchObject({ kind: "failed", errorText: expect.stringContaining("non-regular entry") });
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
		const { mkdtempSync, mkdirSync: realMkdirSync, existsSync: realExists, lstatSync: realLstatSync, readFileSync: realRead, rmSync } = await import("node:fs");
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
			// A dangling symlink planted at the marker path must not be followed:
			// noclobber refuses the exclusive create and nothing lands outside.
			const second = mkdtempSync(joinPath(tmpdir(), "sumo-exit-guard-nofollow-"));
			const { spawnPaneChild: spawnAgain } = await import("./backend-pane.js");
			const { symlinkSync: realSymlink, rmSync: realRm } = await import("node:fs");
			const escapeTarget = joinPath(second, "outside", "exit.code");
			realMkdirSync(joinPath(second, "outside"), { recursive: true });
			try {
				// SAFETY: the double covers every TerminalHost member this flow touches.
				const child2 = spawnAgain({
					id: "sa-guard-nofollow",
					prompt: "irrelevant",
					cwd: joinPath(second, "missing-checkout"),
					signal: controller.signal,
					title: "guard-nofollow",
					placement: { kind: "tab", tabId: "w1:t1", direction: "right" },
					// SAFETY: pi.exec is the only member the pane backend uses on this object.
					pi: { exec: vi.fn() } as never,
					host,
				} as never);
				if (!(Symbol.asyncIterator in child2.events)) child2.events(() => {});
				else throw new Error("pane backend must use callback events");
				await flushPromises();
				// SAFETY: startAgentPane records a StartAgentPaneOptions object as its second argument.
				const started2 = (host.startAgentPane as ReturnType<typeof vi.fn>).mock.calls[1]?.[1] as { shellCommand: string };
				const script2 = [...(started2.shellCommand.match(/^exec '([^']+)'$/) ?? [])][1]!;
				const exit2 = joinPath(dirname(script2), "exit.code");
				realSymlink(escapeTarget, exit2);
				await run("bash", ["-c", started2.shellCommand]).catch(() => {});
				expect(realExists(escapeTarget)).toBe(false);
				expect(realLstatSync(exit2).isSymbolicLink()).toBe(true);
				child2.interrupt();
			} finally {
				realRm(second, { recursive: true, force: true });
			}
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

	it("propagates a planted close control instead of treating it as a repeat", () => {
		const harness = createHarness();
		harness.fs.symlinks.add(`${harness.paths.controlDir}/close.request`);
		// A symlinked close.request raises EEXIST like a repeat, but it is not a
		// published control: the error must propagate so the manager surfaces the
		// refusal instead of reporting close as requested.
		expect(() => harness.child.requestClose?.()).toThrow(/not a regular file/);
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
