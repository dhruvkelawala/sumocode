import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessTreeOperations } from "../background-tasks/process-tree.js";
import { herdrTerminalHost } from "../terminal-host/herdr.js";
import type { TerminalHost } from "../terminal-host/types.js";
import { createPaneChildSpawner } from "./backend-pane.js";
import { SubagentRegistry, type SubagentRecord } from "./registry.js";
import { controlAuthority } from "./retained-adoption.js";
import { RetainedVisibleSupervisor } from "./retained-supervisor.js";

const stops: Array<() => void> = [];
afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function fixture(association = true) {
	const failures: string[] = [];
	const onFailure = vi.fn((phase: string) => { failures.push(phase); });
	vi.useFakeTimers();
	vi.setSystemTime(1000);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "retained-visible-")));
	chmodSync(root, 0o700);
	const taskDir = join(root, "task");
	mkdirSync(taskDir, { mode: 0o700 });
	const registry = new SubagentRegistry(join(root, "registry"), "session", {
		writerIdentity: { token: "writer", pid: process.pid, processStartTime: "owner-birth" }, inspectWriter: () => "alive",
	});
	const record: SubagentRecord = {
		schemaVersion: 2, revision: 1, id: "sa-visible", ownerSessionId: "session", backend: "visible", status: "starting", taskDir,
		child: null, supervisor: null, pane: null, worktree: null, sessionFilePath: null, modelLabel: null, roleId: null,
		createdAt: 1000, updatedAt: 1000, settledAt: null, completionId: null, outcome: null,
		delivery: { state: "none", claim: null }, result: null, manifest: null, writerLease: null, controlLease: null, controlHead: 0,
	};
	let nonce = "";
	const operations: ProcessTreeOperations = {
		captureStartTime: vi.fn(() => `birth <cmd> ${join(taskDir, "run.sh")} ${nonce}`),
		captureTreeVerification: vi.fn(() => ({ members: [{ pid: 42, processStartTime: "wrapper-birth" }] })),
		identityMatches: vi.fn(() => "same" as const), verificationMatches: vi.fn(() => "same" as const),
		isTreeEmpty: vi.fn(() => false), signalTree: vi.fn(async (_identity, signal) => ({ ok: true, gone: signal === "SIGKILL" })),
		waitForTreeEmpty: vi.fn(async () => false),
	};
	const host: TerminalHost = {
		kind: "herdr", openCommandInSplit: vi.fn(), closePane: vi.fn(), notify: vi.fn(),
		inspectPane: vi.fn(herdrTerminalHost.inspectPane),
		startAgentPane: vi.fn<NonNullable<TerminalHost["startAgentPane"]>>(async (_pi, launch) => {
			expect(registry.get(record.id)).toMatchObject({ status: "starting", writerLease: { generation: 1 }, supervisor: expect.any(Object), child: null });
			nonce = launch.shellCommand.split("'").at(-2)!;
			writeFileSync(join(taskDir, "launch.born"), `${nonce}\n42\n42\nwrapper-birth\n`, { mode: 0o600 });
			return { ok: true, agentName: "worker", paneId: "pane:1", pane: { host: "herdr", paneId: "pane:1" } };
		}),
	};
	const owner = new RetainedVisibleSupervisor({ registry, initial: record,
		supervisor: { identity: { pid: process.pid, processGroupId: process.pid, processStartTime: "owner-command" }, verification: { members: [{ pid: process.pid, processStartTime: "owner-birth" }] } },
		launch: { prompt: "task", name: "worker", id: record.id, cwd: taskDir, host, pi: { exec: vi.fn(async () => ({ code: 0, stderr: "", killed: false, stdout: JSON.stringify({ result: {
			type: "pane_process_info", process_info: { pane_id: "pane:1", shell_pid: 42,
				foreground_process_group_id: association ? 42 : 99, foreground_processes: [{ pid: 42 }] },
		} }) })) }, placement: { kind: "new-tab", label: "worker" } }, baseRef: "HEAD",
	}, { onFailure, operations, spawn: createPaneChildSpawner({ processTree: operations, resolveLauncher: () => "/synthetic/sumocode" }),
		buildManifest: async () => ({ baseRef: "HEAD", changedPaths: [], commits: 0, exit: "completed", durationMs: 1 }),
	});
	stops.push(() => { vi.mocked(operations.identityMatches).mockReturnValue("unknown"); try { owner.renew(); } catch { /* Dispose the fake owner without a signal. */ } });
	const start = async () => { await vi.advanceTimersByTimeAsync(50); await owner.ready; };
	const control = () => {
		const current = owner.record;
		const granted = registry.acquireControl(current.id, current.revision, current.writerLease!.generation, current.controlHead, current.writerLease!.owner, 60_000);
		const authority = controlAuthority(granted);
		return { authority, child: owner.controllerChild(authority) };
	};
	const finish = async () => {
		writeFileSync(join(taskDir, "response.md"), "answer", { mode: 0o600 });
		writeFileSync(join(taskDir, "exit.code"), "0", { mode: 0o600 });
		await vi.advanceTimersByTimeAsync(750);
	};
	return { registry, record, owner, operations, host, taskDir, start, control, finish, failures, onFailure };
}

describe("retained visible owner", () => {
	it("persists the nonce command, original tree and inspected pane before release", async () => {
		const f = fixture();
		expect(existsSync(join(f.taskDir, "launch.release"))).toBe(false);
		await f.start();
		const nonce = readFileSync(join(f.taskDir, "launch.release"), "utf8");
		expect(f.owner.record).toMatchObject({ status: "running", pane: { paneId: "pane:1" }, child: {
			identity: { pid: 42, processGroupId: 42, processStartTime: `birth <cmd> ${join(f.taskDir, "run.sh")} ${nonce}` },
			verification: { members: [{ pid: 42, processStartTime: "wrapper-birth" }] },
		} });
		expect(f.host.inspectPane).toHaveBeenCalledTimes(1);
	});
	it("refuses a pane ID with a different process association", async () => {
		const f = fixture(false);
		await vi.advanceTimersByTimeAsync(50);
		await expect(f.owner.ready).rejects.toThrow("pane-unverified");
		expect(await f.owner.settlement).toBe("ambiguous");
		expect(existsSync(join(f.taskDir, "launch.release"))).toBe(false);
		expect(f.owner.record.child).toBeNull();
		expect(f.operations.signalTree).not.toHaveBeenCalled();
	});
	it("refuses pane-ID-only hosts without an inspection capability", async () => {
		const f = fixture();
		f.host.inspectPane = undefined;
		await vi.advanceTimersByTimeAsync(50);
		await expect(f.owner.ready).rejects.toThrow("pane-unverified");
		expect(await f.owner.settlement).toBe("ambiguous");
		expect(existsSync(join(f.taskDir, "launch.release"))).toBe(false);
	});
	it("times out a pending pane query and refuses its late association", async () => {
		const f = fixture();
		let release!: (value: Awaited<ReturnType<NonNullable<TerminalHost["inspectPane"]>>>) => void;
		vi.mocked(f.host.inspectPane!).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
		await vi.advanceTimersByTimeAsync(30_000);
		await expect(f.owner.ready).rejects.toThrow("inspection timed out");
		expect(await f.owner.settlement).toBe("ambiguous");
		release({ ok: true, shellPid: 42, foregroundProcessGroupId: 42, foregroundPids: [42] });
		await vi.advanceTimersByTimeAsync(50);
		expect(existsSync(join(f.taskDir, "launch.release"))).toBe(false);
		expect(f.owner.record.child).toBeNull();
		expect(f.operations.signalTree).not.toHaveBeenCalled();
	});
	it("refuses publication when the writer lease expires during pane inspection", async () => {
		const f = fixture();
		vi.mocked(f.host.inspectPane!).mockImplementation(async () => {
			vi.setSystemTime(61_001);
			return { ok: true, shellPid: 42, foregroundProcessGroupId: 42, foregroundPids: [42] };
		});
		await vi.advanceTimersByTimeAsync(50);
		await expect(f.owner.ready).rejects.toThrow();
		expect(await f.owner.settlement).toBe("ambiguous");
		expect(existsSync(join(f.taskDir, "launch.release"))).toBe(false);
		expect(f.owner.record.child).toBeNull();
		expect(f.operations.signalTree).not.toHaveBeenCalled();
	});
	it.each(["different", "unknown"] as const)("refuses all controls on %s original identity", async (state) => {
		const f = fixture(); await f.start();
		const { child } = f.control();
		vi.mocked(f.operations.identityMatches).mockReturnValue(state);
		await expect(child.send!("denied")).rejects.toThrow();
		expect(() => child.requestClose!()).toThrow();
		expect(() => child.interrupt()).toThrow();
		expect(f.operations.signalTree).not.toHaveBeenCalled();
		expect(f.host.closePane).not.toHaveBeenCalled();
	});
	it("rejects old controls after reservation and rechecks pending steer acknowledgements", async () => {
		const f = fixture(); await f.start();
		const { child, authority } = f.control();
		const pending = child.send!("steer");
		const refused = expect(pending).rejects.toThrow();
		f.owner.reserveControl(authority, { sessionId: "next", owner: { token: "next", pid: 77, processStartTime: "next-birth" } });
		expect(() => child.requestClose!()).toThrow();
		expect(() => child.interrupt()).toThrow();
		const steer = join(f.taskDir, "control", "steer-1.txt");
		renameSync(steer, `${steer}.consumed`);
		await vi.advanceTimersByTimeAsync(250);
		await refused;
		expect(f.operations.signalTree).not.toHaveBeenCalled();
	});
	it("persists heartbeat observations and permits an authorized graceful close", async () => {
		const f = fixture(); await f.start();
		const { child } = f.control();
		writeFileSync(join(f.taskDir, "control", "heartbeat"), "1050\n", { mode: 0o600 });
		await vi.advanceTimersByTimeAsync(750);
		expect(f.owner.record.telemetry).toMatchObject({ lastHeartbeatAt: 1050, lastProgressAt: null });
		child.requestClose!();
		expect(readFileSync(join(f.taskDir, "control", "close.request"), "utf8")).toBe("1");
		await f.finish();
		expect(await f.owner.settlement).toBe("settled");
	});
	it("waits for original-tree cleanup before settlement and never closes by pane ID", async () => {
		const f = fixture(); await f.start();
		let release!: (empty: boolean) => void;
		vi.mocked(f.operations.waitForTreeEmpty).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
		await f.finish();
		expect(f.owner.completion).toBeUndefined();
		expect(f.owner.record.status).toBe("running");
		release(false);
		expect(await f.owner.settlement).toBe("settled");
		expect(f.owner.completion?.outcome).toMatchObject({ kind: "completed" });
		expect(vi.mocked(f.operations.signalTree).mock.calls.map((call) => call[1])).toEqual(["SIGTERM", "SIGKILL"]);
		expect(f.host.closePane).not.toHaveBeenCalled();
	});
	it("settles verified cleanup across renewal after the child exits", async () => {
		const f = fixture(); await f.start();
		let release!: (empty: boolean) => void;
		vi.mocked(f.operations.waitForTreeEmpty).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
		await f.finish();
		expect(f.operations.signalTree).toHaveBeenCalledTimes(1);
		const lease = f.owner.record.writerLease!;
		vi.mocked(f.operations.identityMatches).mockImplementation((identity) => identity.pid === 42 ? "different" : "same");
		vi.mocked(f.operations.verificationMatches!).mockImplementation((identity) => identity.pid === 42 ? "different" : "same");
		await vi.advanceTimersByTimeAsync(20_000);
		expect(f.owner.record).toMatchObject({ status: "running", outcome: null, result: null, manifest: null });
		expect(f.owner.record.writerLease!.renewedAt).toBeGreaterThan(lease.renewedAt);
		expect(f.owner.record.writerLease!.owner).toEqual(lease.owner);
		expect(f.owner.record.writerLease!.generation).toBe(2);
		expect(f.owner.completion).toBeUndefined();
		release(true);
		expect(await f.owner.settlement).toBe("settled");
		expect(f.owner.completion?.outcome).toEqual({ kind: "completed", finalText: "answer" });
		expect(f.owner.record).toMatchObject({ status: "settled", result: expect.any(Object), manifest: expect.any(Object) });
		expect(f.failures).toEqual([]);
		expect(f.operations.signalTree).toHaveBeenCalledTimes(1);
		expect(f.host.closePane).not.toHaveBeenCalled();
	});
	it.each(["different", "unknown"] as const)("refuses renewal before cleanup on %s child identity", async (state) => {
		const f = fixture(); await f.start();
		vi.mocked(f.operations.identityMatches).mockImplementation((identity) => identity.pid === 42 ? state : "same");
		expect(() => f.owner.renew()).toThrow();
		expect(await f.owner.settlement).toBe("ambiguous");
		expect(f.failures).toEqual(["renew-effect"]);
		await f.finish();
		expect(f.owner.record).toMatchObject({ outcome: null, result: null, manifest: null });
		expect(f.owner.completion).toBeUndefined();
		expect(f.operations.signalTree).not.toHaveBeenCalled();
	});
	it.each(["different", "unknown"] as const)("does not treat %s identity as verified empty during cleanup", async (state) => {
		const f = fixture(); await f.start();
		let release!: (empty: boolean) => void;
		vi.mocked(f.operations.waitForTreeEmpty).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
		await f.finish();
		vi.mocked(f.operations.identityMatches).mockImplementation((identity) => identity.pid === 42 ? state : "same");
		vi.mocked(f.operations.verificationMatches!).mockImplementation((identity) => identity.pid === 42 ? state : "same");
		await vi.advanceTimersByTimeAsync(20_000);
		expect(f.owner.record.status).toBe("running");
		expect(f.owner.completion).toBeUndefined();
		release(false);
		expect(await f.owner.settlement).toBe("ambiguous");
		expect(f.failures).toEqual(["visible-cleanup", "backend-refused"]);
		expect(f.owner.record).toMatchObject({ outcome: null, result: null, manifest: null });
		expect(f.owner.completion).toBeUndefined();
		expect(f.operations.signalTree).toHaveBeenCalledTimes(1);
		expect(f.host.closePane).not.toHaveBeenCalled();
	});
	for (const cut of ["renewal", "cleanup fence"] as const) {
		it.each(["expiry", "replacement"] as const)(`refuses writer %s during cleanup at ${cut}`, async (loss) => {
			const f = fixture(); await f.start();
			let release!: (empty: boolean) => void;
			vi.mocked(f.operations.waitForTreeEmpty).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
			await f.finish();
			vi.setSystemTime(f.owner.record.writerLease!.expiresAt + 1);
			if (loss === "replacement") {
				const replacement = new SubagentRegistry(join(f.taskDir, "..", "registry"), "session", {
					writerIdentity: { token: "replacement", pid: 77, processStartTime: "replacement-birth" },
					inspectWriter: (writer) => writer.token === "replacement" ? "alive" : "dead",
				});
				const current = replacement.get(f.record.id)!;
				replacement.acquireWriter(current.id, current.revision, 60_000);
			}
			const fencedRecord = f.owner.record;
			if (cut === "renewal") {
				await vi.advanceTimersByTimeAsync(20_000);
				expect(await f.owner.settlement).toBe("ambiguous");
				expect(f.failures).toEqual(["renew-writer"]);
			}
			release(true);
			await vi.advanceTimersByTimeAsync(0);
			expect(await f.owner.settlement).toBe("ambiguous");
			if (cut === "cleanup fence") expect(f.failures).toEqual(["visible-cleanup-fence", "backend-refused"]);
			expect(f.owner.record).toEqual(fencedRecord);
			expect(f.owner.record).toMatchObject({ outcome: null, result: null, manifest: null });
			expect(f.owner.completion).toBeUndefined();
			expect(f.operations.signalTree).toHaveBeenCalledTimes(1);
			expect(f.host.closePane).not.toHaveBeenCalled();
		});
	}
	it("reports cleanup failure using fixed phases, not the thrown error", async () => {
		const f = fixture(); await f.start();
		vi.mocked(f.operations.waitForTreeEmpty).mockRejectedValue(new Error("synthetic private error details"));
		await f.finish();
		expect(await f.owner.settlement).toBe("ambiguous");
		expect(f.failures).toEqual(["visible-cleanup", "backend-refused"]);
		expect(f.owner.record).toMatchObject({ outcome: null, result: null, manifest: null });
		expect(f.operations.signalTree).toHaveBeenCalledTimes(1);
	});
	it("keeps cleanup failure ambiguous when the diagnostic observer throws", async () => {
		const f = fixture(); await f.start();
		f.onFailure.mockImplementation(() => { throw new Error("diagnostic unavailable"); });
		vi.mocked(f.operations.waitForTreeEmpty).mockRejectedValue(new Error("cleanup unconfirmed"));
		await f.finish();
		expect(await f.owner.settlement).toBe("ambiguous");
		expect(f.owner.record).toMatchObject({ outcome: null, result: null, manifest: null });
		expect(f.owner.completion).toBeUndefined();
		expect(f.operations.signalTree).toHaveBeenCalledTimes(1);
	});
	it("does not publish success when cleanup cannot confirm emptiness", async () => {
		const f = fixture(); await f.start();
		vi.mocked(f.operations.signalTree).mockResolvedValue({ ok: true, gone: false });
		await f.finish();
		expect(await f.owner.settlement).toBe("ambiguous");
		expect(f.owner.completion).toBeUndefined();
		expect(f.owner.record.result).toBeNull();
		expect(f.host.closePane).not.toHaveBeenCalled();
	});
	it("does not escalate after control loss during cancellation cleanup", async () => {
		const f = fixture(); await f.start();
		const { child, authority } = f.control();
		let release!: (empty: boolean) => void;
		let waiting!: () => void;
		const entered = new Promise<void>((resolve) => { waiting = resolve; });
		vi.mocked(f.operations.waitForTreeEmpty).mockImplementation(() => new Promise((resolve) => { release = resolve; waiting(); }));
		child.interrupt();
		await entered;
		f.owner.reserveControl(authority, { sessionId: "next", owner: { token: "next", pid: 77, processStartTime: "next-birth" } });
		release(false);
		expect(await f.owner.settlement).toBe("ambiguous");
		expect(f.operations.signalTree).toHaveBeenCalledTimes(1);
	});
	it.each(["anchor", "supervisor"])("classifies %s death as ambiguous without cleanup signals", async (dead) => {
		const f = fixture(); await f.start();
		vi.mocked(f.operations.identityMatches).mockImplementation((identity) => identity.pid === (dead === "anchor" ? 42 : process.pid) ? "different" : "same");
		expect(() => f.owner.renew()).toThrow();
		expect(await f.owner.settlement).toBe("ambiguous");
		expect(f.owner.completion).toBeUndefined();
		expect(f.operations.signalTree).not.toHaveBeenCalled();
	});
});
