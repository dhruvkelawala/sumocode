import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPrivateJson } from "../activity/persistence.js";
import type { CompletionManifest } from "./manifest.js";
import { CHILD_JSON_FRAME_MAX_BYTES } from "../child-protocol.js";
import type { ProcessTreeOperations } from "../background-tasks/process-tree.js";
import { createPiChildSpawner } from "./backend-pi.js";
import { SubagentRegistry, type RegistryProcess, type SubagentRecord } from "./registry.js";
import { createRetainedHeadlessLaunchGate, RetainedHeadlessSupervisor } from "./retained-supervisor.js";

// oxlint-disable-next-line anti-slop/no-module-mocking -- filesystem publication faults; all other I/O uses private real files.
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }));
const runnerEnvironment = process.env;
beforeEach(() => { process.env = { PATH: "/synthetic/bin", HOME: "/synthetic/home", TMPDIR: tmpdir() }; });
afterEach(() => { process.env = runnerEnvironment; vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sumocode-launch-gate-")));
	chmodSync(root, 0o700);
	const taskDir = join(root, "task");
	mkdirSync(taskDir, { mode: 0o700 });
	let now = 1000;
	const supervisor: RegistryProcess = {
		identity: { pid: process.pid, processGroupId: process.pid, processStartTime: "supervisor-command" },
		verification: { members: [{ pid: process.pid, processStartTime: "supervisor-birth" }] },
	};
	const registry = new SubagentRegistry(join(root, "registry"), "session-a", {
		now: () => now,
		writerIdentity: { token: "owner", pid: process.pid, processStartTime: "supervisor-birth" },
		inspectWriter: () => "alive",
	});
	const record: SubagentRecord = {
		schemaVersion: 2, revision: 1, id: "sa-proof", ownerSessionId: "session-a",
		backend: "headless", status: "starting", taskDir,
		child: null, supervisor: null, pane: null, worktree: null, sessionFilePath: null,
		modelLabel: null, roleId: null, createdAt: 1000, updatedAt: 1000, settledAt: null,
		completionId: null, outcome: null, delivery: { state: "none", claim: null },
		result: null, manifest: null, writerLease: null, controlLease: null, controlHead: 0,
	};
	const operations: ProcessTreeOperations = {
		captureStartTime: vi.fn(() => "child-command"),
		identityMatches: vi.fn(() => "same" as const),
		captureTreeVerification: vi.fn((identity) => ({ members: [{ pid: identity.pid, processStartTime: "child-birth" }] })),
		verificationMatches: vi.fn(() => "same" as const),
		isTreeEmpty: vi.fn(() => false),
		signalTree: vi.fn(async (_identity, signal) => ({ ok: true, gone: signal === "SIGKILL" })),
		waitForTreeEmpty: vi.fn(async () => false),
	};
	return { registry, record, supervisor, operations, setNow: (value: number) => { now = value; } };
}

function retainedFixture(attach = false) {
	const f = fixture();
	const proc = Object.assign(new EventEmitter(), {
		pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter(),
		stdin: { on: vi.fn(), end: vi.fn(), write: vi.fn() }, kill: vi.fn(),
	});
	Object.assign(proc, { send: vi.fn(() => proc.emit("message", { kind: "started", child: { pid: 4343, processStartTime: "child-birth" } })) });
	const spawn = vi.fn(() => proc);
	// SAFETY: fake piped process; the production backend parser owns these streams.
	const backend = createPiChildSpawner(spawn as never, () => undefined, () => "/selected/pi", () => undefined, f.operations);
	let releaseManifest!: (manifest: CompletionManifest) => void;
	const manifest = new Promise<CompletionManifest>((resolve) => { releaseManifest = resolve; });
	const subscriptions = vi.fn();
	if (attach) f.registry.create(f.record);
	const owner = new RetainedHeadlessSupervisor({
		registry: f.registry, initial: f.record, supervisor: f.supervisor,
		attach: attach ? { cwd: f.record.taskDir } : undefined,
		launch: { prompt: "prompt-secret", cwd: f.record.taskDir, inherited: {}, builtInTools: ["read"] }, baseRef: "host-base",
	}, {
		operations: f.operations,
		spawn: (options) => {
			const child = backend(options);
			return { ...child, events: (emit) => {
				subscriptions();
				if (Symbol.asyncIterator in child.events) throw new Error("expected callback backend");
				child.events(emit);
			} };
		},
		buildManifest: () => manifest,
	});
	const release = (changedPaths: readonly string[] = []) => releaseManifest({ baseRef: "host-base", headRef: "host-head", changedPaths, commits: 0, exit: "completed", durationMs: 10 });
	const finish = async (code = 0) => {
		proc.emit("message", { kind: "exited", code, signal: null });
		for (let i = 0; i < 10; i++) await Promise.resolve();
		proc.emit("close", null, "SIGKILL");
		for (let i = 0; i < 10; i++) await Promise.resolve();
	};
	return { ...f, proc, spawn, subscriptions, owner, release, finish };
}

describe("retained supervisor handle ownership", () => {
	it("authorizes a control reservation while retaining parser, child and writer ownership", async () => {
		const f = retainedFixture();
		f.proc.emit("spawn");
		await f.owner.ready;
		const record = f.registry.get(f.record.id)!;
		const granted = f.registry.acquireControl(record.id, record.revision, record.writerLease!.generation, 0, record.writerLease!.owner, 1000);
		const reserved = f.owner.reserveControl({
			id: record.id, ownerSessionId: record.ownerSessionId, generation: granted.controlLease!.generation,
			owner: granted.controlLease!.owner, head: granted.controlHead,
		}, { sessionId: "successor", owner: { token: "successor", pid: 77, processStartTime: "successor-birth" } });
		expect(reserved.writerLease).toEqual(record.writerLease);
		expect(reserved.controlLease).toBeNull();
		expect(f.subscriptions).toHaveBeenCalledTimes(1);
		expect(f.operations.signalTree).not.toHaveBeenCalled();
		await f.finish();
		f.release();
		expect(await f.owner.settlement).toBe("settled");
		expect(f.registry.get(record.id)?.controlReservation?.sessionId).toBe("successor");
	});
	it.each(["different", "unknown"] as const)("refuses transfer after %s anchor identity without signals or a new controller", async (status) => {
		const f = retainedFixture();
		f.proc.emit("spawn");
		await f.owner.ready;
		const record = f.registry.get(f.record.id)!;
		const granted = f.registry.acquireControl(record.id, record.revision, record.writerLease!.generation, 0, record.writerLease!.owner, 1000);
		vi.mocked(f.operations.identityMatches).mockImplementation((identity) => identity.pid === 4242 ? status : "same");
		expect(() => f.owner.reserveControl({ id: record.id, ownerSessionId: record.ownerSessionId,
			generation: granted.controlLease!.generation, owner: granted.controlLease!.owner, head: granted.controlHead,
		}, { sessionId: "successor", owner: { token: "successor", pid: 77, processStartTime: "successor-birth" } })).toThrow();
		expect(await f.owner.settlement).toBe("ambiguous");
		expect(f.registry.get(record.id)).toMatchObject({ status: "ambiguous", controlLease: granted.controlLease, writerLease: record.writerLease });
		expect(f.registry.get(record.id)?.controlReservation).toBeUndefined();
		expect(f.operations.signalTree).not.toHaveBeenCalled();
	});

	it("persists parsed progress and accumulated reported usage before observers and settlement", async () => {
		const f = retainedFixture();
		f.proc.emit("spawn");
		await f.owner.ready;
		const observed: SubagentRecord[] = [];
		f.owner.subscribe((record) => { observed.push(record); });
		f.setNow(2000);
		for (const tokens of [60, 40]) f.proc.stdout.emit("data", `${JSON.stringify({ type: "message_end", message: { role: "assistant", text: "private answer", usage: { totalTokens: tokens, cost: { total: 0.25 } } } })}\n`);
		expect(f.registry.get(f.record.id)?.telemetry).toEqual({ startedAt: 1000, lastProgressAt: 2000, reportedTokens: 100, reportedCostUsd: 0.5 });
		expect(observed.at(-1)?.telemetry).toEqual(f.registry.get(f.record.id)?.telemetry);
		expect(f.operations.signalTree).not.toHaveBeenCalled();
		await f.finish();
		f.release();
		expect(await f.owner.settlement).toBe("settled");
		expect(f.registry.get(f.record.id)?.telemetry).toEqual({ startedAt: 1000, lastProgressAt: 2000, reportedTokens: 100, reportedCostUsd: 0.5 });
	});
	for (const [cut, loss] of [["TERM", "expiry"], ["KILL", "expiry"], ["TERM", "replacement"], ["KILL", "replacement"]] as const) {
		it(`stops the real kernel on lease ${loss} before ${cut}, with no late backend effects`, async () => {
			const f = retainedFixture();
			f.proc.emit("spawn");
			await f.owner.ready;
			let releaseWait!: (empty: boolean) => void;
			f.operations.waitForTreeEmpty = () => new Promise((resolve) => { releaseWait = resolve; });
			const lose = (): void => {
				f.setNow(61_000);
				if (loss === "replacement") {
					const replacement = new SubagentRegistry(join(f.record.taskDir, "..", "registry"), "session-a", {
						now: () => 61_000,
						writerIdentity: { token: "replacement", pid: process.pid + 1, processStartTime: "new-birth" },
						inspectWriter: (writer) => writer.token === "replacement" ? "alive" : "dead",
					});
					const r = replacement.get(f.record.id)!;
					replacement.acquireWriter(r.id, r.revision, 60_000);
				}
			};
			if (cut === "TERM") lose();
			f.proc.stdout.emit("data", Buffer.alloc(CHILD_JSON_FRAME_MAX_BYTES + 1, 0x73));
			if (cut === "KILL") {
				await new Promise<void>((resolve) => setImmediate(resolve));
				lose();
				releaseWait(false);
			}
			expect(await f.owner.settlement).toBe("ambiguous");
			expect(f.operations.signalTree).toHaveBeenCalledTimes(cut === "TERM" ? 0 : 1);
			if (cut === "KILL") expect(f.operations.signalTree).toHaveBeenCalledWith(
				f.registry.get(f.record.id)!.child!.identity, "SIGTERM", f.registry.get(f.record.id)!.child!.verification,
			);
			const unchanged = f.registry.get(f.record.id);
			f.proc.emit("close", 0);
			f.proc.emit("spawn");
			f.proc.emit("error", new Error("late child callback"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(f.registry.get(f.record.id)).toEqual(unchanged);
			expect(() => f.owner.renew()).toThrow(/stopped/);
			expect(f.proc.stdin.write).toHaveBeenCalledTimes(1);
			expect(f.proc.kill).not.toHaveBeenCalled();
			expect(existsSync(join(f.record.taskDir, "result.json"))).toBe(false);
		});
	}

	it("attaches an unowned starting record and renews through manifest collection", async () => {
		vi.useFakeTimers();
		try {
			const f = retainedFixture(true);
			f.proc.emit("spawn");
			await f.owner.ready;
			f.setNow(21_000);
			await vi.advanceTimersByTimeAsync(20_000);
			expect(f.registry.get("sa-proof")?.writerLease?.expiresAt).toBe(81_000);
			await f.finish();
			f.setNow(41_000);
			await vi.advanceTimersByTimeAsync(20_000);
			f.release();
			expect(await f.owner.settlement).toBe("settled");
			expect(vi.getTimerCount()).toBe(0);
		} finally { vi.useRealTimers(); }
	});

	for (const refusal of ["missing", "duplicate", "owned", "id", "session", "taskDir", "cwd", "worktree"] as const) {
		it(`refuses ${refusal} attach before backend spawn`, () => {
			const f = fixture();
			if (refusal !== "missing") f.registry.create(f.record);
			if (refusal === "owned") f.registry.acquireWriter(f.record.id, 1, 60_000);
			const otherDir = join(f.record.taskDir, "other");
			mkdirSync(otherDir, { mode: 0o700 });
			const initial = { ...(refusal === "owned" ? f.registry.get(f.record.id)! : f.record),
				id: refusal === "id" ? "sa-other" : f.record.id,
				ownerSessionId: refusal === "session" ? "other" : f.record.ownerSessionId,
				taskDir: refusal === "taskDir" ? otherDir : f.record.taskDir,
				worktree: refusal === "worktree" ? { path: otherDir, repoRoot: otherDir, baseRef: "base", branch: "branch" } : null,
			};
			const spawn = vi.fn();
			expect(() => new RetainedHeadlessSupervisor({
				registry: f.registry, initial, supervisor: f.supervisor,
				attach: refusal === "duplicate" ? undefined : { cwd: refusal === "cwd" ? otherDir : f.record.taskDir },
				launch: { prompt: "secret", cwd: f.record.taskDir, inherited: {} }, baseRef: "base",
			}, { operations: f.operations, spawn })).toThrow();
			expect(spawn).not.toHaveBeenCalled();
			expect(existsSync(join(f.record.taskDir, "events.json"))).toBe(false);
		});
	}

	it("preserves control grants, reservations and revocation across startup and a slow manifest", async () => {
		vi.useFakeTimers();
		const f = retainedFixture();
		const grant = () => {
			const r = f.registry.get(f.record.id)!;
			return f.registry.acquireControl(r.id, r.revision, r.writerLease!.generation, r.controlHead, r.writerLease!.owner, 60_000);
		};
		const authority = (r: SubagentRecord) => ({ id: r.id, ownerSessionId: r.ownerSessionId,
			generation: r.controlLease!.generation, owner: r.controlLease!.owner, head: r.controlHead });
		let r = grant();
		r = f.registry.reserveControl(r.revision, authority(r), `${r.id}:${r.controlHead + 1}`);
		const transition = f.registry.transition.bind(f.registry);
		// A second request wins after the kernel read but before its metadata CAS.
		vi.spyOn(f.registry, "transition").mockImplementationOnce((id, revision, generation, update) => {
			r = f.registry.reserveControl(r.revision, authority(r), `${r.id}:${r.controlHead + 1}`);
			return transition(id, revision, generation, update);
		});
		f.proc.emit("spawn");
		await f.owner.ready;
		await f.finish();
		f.setNow(21_000);
		await vi.advanceTimersByTimeAsync(20_000);
		r = f.registry.get(r.id)!;
		r = f.registry.releaseControl(r.revision, r.writerLease!.generation, authority(r));
		r = grant();
		r = f.registry.reserveControl(r.revision, authority(r), `${r.id}:${r.controlHead + 1}`);
		f.release();
		expect(await f.owner.settlement).toBe("settled");
		expect(f.registry.get(r.id)).toMatchObject({ controlHead: 6, controlLease: r.controlLease });
		expect(f.spawn).toHaveBeenCalledTimes(1);
		expect(f.proc.stdin.write).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	for (const cut of ["prompt", "manifest"] as const) {
		for (const loss of ["expiry", "other writer"] as const) {
			it(`stops automatic renewal on ${loss} before ${cut}, with no late release or pointers`, async () => {
				vi.useFakeTimers();
				const f = retainedFixture();
				if (cut === "manifest") {
					f.proc.emit("spawn");
					await f.owner.ready;
					await f.finish();
				}
				f.setNow(61_000);
				if (loss === "other writer") {
					const replacement = new SubagentRegistry(join(f.record.taskDir, "..", "registry"), "session-a", {
						now: () => 61_000,
						writerIdentity: { token: "replacement", pid: process.pid + 1, processStartTime: "new-birth" },
						inspectWriter: (writer) => writer.token === "replacement" ? "alive" : "dead",
					});
					const r = replacement.get(f.record.id)!;
					replacement.acquireWriter(r.id, r.revision, 60_000);
				}
				await vi.advanceTimersByTimeAsync(20_000);
				expect(await f.owner.settlement).toBe("ambiguous");
				expect(vi.getTimerCount()).toBe(0);
				if (cut === "prompt") {
					f.proc.emit("spawn");
					await expect(f.owner.ready).rejects.toThrow(/readiness timeout/);
					expect(f.proc.stdin.write).not.toHaveBeenCalled();
				}
				f.release();
				await Promise.resolve();
				expect(f.registry.get(f.record.id)).toMatchObject({ completionId: null, result: null, manifest: null });
				expect(existsSync(join(f.record.taskDir, "manifest.json"))).toBe(false);
				expect(f.proc.kill).not.toHaveBeenCalled();
				expect(() => f.owner.renew()).toThrow(/stopped/);
			});
		}
	}

	it("keeps a starting record and starts no backend when initial journal publication refuses", () => {
		const f = fixture();
		writeFileSync(join(f.record.taskDir, "events.json"), "private prior evidence", { mode: 0o600 });
		const spawn = vi.fn();
		expect(() => new RetainedHeadlessSupervisor({
			registry: f.registry, initial: f.record, supervisor: f.supervisor,
			launch: { prompt: "secret", cwd: f.record.taskDir, inherited: {} }, baseRef: "base",
		}, { operations: f.operations, spawn })).toThrow();
		expect(spawn).not.toHaveBeenCalled();
		expect(f.registry.get("sa-proof")).toMatchObject({ status: "starting", supervisor: f.supervisor, child: null });
		expect(readFileSync(join(f.record.taskDir, "events.json"), "utf8")).toBe("private prior evidence");
	});

	it("blocks spawn when persisting the synchronous run-started event fails", async () => {
		const rename = fs.renameSync;
		vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
			if (String(to).endsWith("/events.json")) throw new Error("journal unavailable");
			return rename(from, to);
		});
		const f = retainedFixture();
		expect(f.spawn).not.toHaveBeenCalled();
		await expect(f.owner.ready).rejects.toThrow();
		expect(await f.owner.settlement).toBe("ambiguous");
		expect(f.registry.get("sa-proof")).toMatchObject({ status: "ambiguous", child: null });
	});

	it("settles synchronous configuration failure without claiming launch readiness", async () => {
		const f = fixture();
		const owner = new RetainedHeadlessSupervisor({
			registry: f.registry, initial: f.record, supervisor: f.supervisor,
			launch: { prompt: "secret", cwd: f.record.taskDir, inherited: {} }, baseRef: "base",
		}, {
			operations: f.operations,
			spawn: () => ({ events: (emit) => emit({ kind: "run-settled", outcome: { kind: "failed", errorText: "invalid configuration" } }), interrupt: vi.fn() }),
		});
		await expect(owner.ready).rejects.toThrow(/release/);
		expect(await owner.settlement).toBe("settled");
		expect(f.registry.get("sa-proof")).toMatchObject({ status: "settled", child: null, outcome: "failed", delivery: { state: "pending" } });
	});

	it("does not turn a pre-release zero exit into completed work", async () => {
		const f = retainedFixture();
		f.proc.emit("close", 0);
		await expect(f.owner.ready).rejects.toThrow();
		expect(await f.owner.settlement).toBe("ambiguous");
		expect(f.registry.get("sa-proof")).toMatchObject({ status: "ambiguous", outcome: null, completionId: null });
		expect(f.proc.kill).not.toHaveBeenCalled();
	});

	it("refuses a corrupt private journal instead of overwriting evidence or publishing completion", async () => {
		const f = retainedFixture();
		f.proc.emit("spawn");
		await f.owner.ready;
		writeFileSync(join(f.record.taskDir, "events.json"), "{broken", { mode: 0o600 });
		f.proc.stdout.emit("data", '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"secret"}}\n');
		f.proc.emit("close", 0);
		f.release();
		expect(await f.owner.settlement).toBe("ambiguous");
		expect(readFileSync(join(f.record.taskDir, "events.json"), "utf8")).toBe("{broken");
		expect(f.registry.get("sa-proof")).toMatchObject({ status: "ambiguous", completionId: null, outcome: null });
		expect(f.proc.kill).not.toHaveBeenCalled();
	});

	for (const cut of ["journal", "result", "manifest", "pointer"] as const) {
		it(`contains ${cut} publication failure with no completion notification or signal`, async () => {
			const f = retainedFixture();
			f.proc.emit("spawn");
			await f.owner.ready;
			const observed: SubagentRecord[] = [];
			f.owner.subscribe((record) => { observed.push(record); });
			const link = fs.linkSync;
			vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
				if (to === join(f.record.taskDir, `${cut}.json`)) throw new Error("injected link failure");
				return link(from, to);
			});
			const rename = fs.renameSync;
			vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
				if ((cut === "journal" && to === join(f.record.taskDir, "events.json"))
					|| (cut === "pointer" && String(to).endsWith("/sa-proof.json") && readFileSync(from, "utf8").includes('"status": "settled"'))) {
					throw new Error("injected rename failure");
				}
				return rename(from, to);
			});
			await f.finish();
			f.release();
			expect(await f.owner.settlement).toBe("ambiguous");
			expect(f.registry.get("sa-proof")).toMatchObject({ status: "ambiguous", completionId: null, result: null, manifest: null, delivery: { state: "none" } });
			expect(existsSync(join(f.record.taskDir, "result.json"))).toBe(cut === "manifest" || cut === "pointer");
			expect(existsSync(join(f.record.taskDir, "manifest.json"))).toBe(cut === "pointer");
			expect(observed.some((record) => record.status === "settled")).toBe(false);
			expect(f.proc.kill).not.toHaveBeenCalled();
			expect(f.subscriptions).toHaveBeenCalledTimes(1);
		});
	}

	for (const tamper of ["symlink", "permissions"] as const) {
		it(`refuses ${tamper} journal tampering without replacing it`, async () => {
			const f = retainedFixture();
			f.proc.emit("spawn");
			await f.owner.ready;
			const path = join(f.record.taskDir, "events.json");
			if (tamper === "symlink") {
				fs.renameSync(path, join(f.record.taskDir, "saved-events.json"));
				symlinkSync(join(f.record.taskDir, "saved-events.json"), path);
			} else chmodSync(path, 0o644);
			f.proc.emit("close", 1);
			expect(await f.owner.settlement).toBe("ambiguous");
			expect(f.registry.get("sa-proof")?.completionId).toBeNull();
			expect(f.proc.kill).not.toHaveBeenCalled();
		});
	}

	it("bounds JSON-escaped results and journals while retaining authoritative outcome", async () => {
		const f = retainedFixture();
		f.proc.emit("spawn");
		await f.owner.ready;
		for (let i = 0; i < 260; i++) f.proc.stdout.emit("data", '{"type":"tool_execution_start","toolCallId":"id-secret","toolName":"read","args":{"password":"argument-secret"}}\n');
		f.proc.stdout.emit("data", `${JSON.stringify({ type: "message_end", message: { role: "assistant", text: "\u0001".repeat(600_000) } })}\n`);
		await f.finish();
		f.release();
		expect(await f.owner.settlement).toBe("settled");
		const record = f.registry.get("sa-proof")!;
		expect(record.result!.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
		expect(readFileSync(join(record.taskDir, "result.json"), "utf8")).toContain("[output truncated]");
		expect(statSync(join(record.taskDir, "events.json")).size).toBeLessThan(32 * 1024);
		expect(readPrivateJson(join(record.taskDir, "events.json"))).toMatchObject({ schemaVersion: 1, dropped: 8, events: expect.any(Array) });
		expect(readFileSync(join(record.taskDir, "events.json"), "utf8")).not.toMatch(/argument-secret|id-secret|password/);
		expect(record).toMatchObject({ status: "settled", outcome: "completed" });
	}, 30_000);

	it("refuses an oversized host manifest without truncating it into misleading evidence", async () => {
		const f = retainedFixture();
		f.proc.emit("spawn");
		await f.owner.ready;
		await f.finish();
		f.release(["x".repeat(4 * 1024 * 1024)]);
		expect(await f.owner.settlement).toBe("ambiguous");
		expect(f.registry.get("sa-proof")).toMatchObject({ status: "ambiguous", outcome: "completed", completionId: null, result: null, manifest: null });
		expect(existsSync(join(f.record.taskDir, "result.json"))).toBe(true);
		expect(existsSync(join(f.record.taskDir, "manifest.json"))).toBe(false);
	});

	it("rejects same-size result corruption before publishing any pointer", async () => {
		const f = retainedFixture();
		f.proc.emit("spawn");
		await f.owner.ready;
		await f.finish();
		const path = join(f.record.taskDir, "result.json");
		const original = readFileSync(path, "utf8");
		writeFileSync(path, original.replace("completed", "compLeted"), { mode: 0o600 });
		f.release();
		expect(await f.owner.settlement).toBe("ambiguous");
		expect(f.registry.get("sa-proof")).toMatchObject({ status: "ambiguous", result: null, manifest: null, completionId: null });
	});

	it("persists a backend failure even if manifest collection reports a completed exit", async () => {
		const f = retainedFixture();
		f.proc.emit("spawn");
		await f.owner.ready;
		f.proc.stdout.emit("data", '{"type":"message_end","message":{"role":"assistant","text":"partial","stopReason":"error","errorMessage":"provider refused"}}\n');
		await f.finish();
		f.release();
		expect(await f.owner.settlement).toBe("settled");
		expect(f.registry.get("sa-proof")?.outcome).toBe("failed");
		expect(readPrivateJson(join(f.record.taskDir, "result.json"))).toMatchObject({ outcome: { kind: "failed", errorText: "provider refused", partialText: "partial" } });
		expect(readPrivateJson(join(f.record.taskDir, "manifest.json"))).toMatchObject({ manifest: { exit: "failed" } });
	});

	for (const streamFailure of ["reject", "end"] as const) {
		it(`records lost on event-stream ${streamFailure} without inventing a backend outcome or killing`, async () => {
			const f = fixture();
			const interrupt = vi.fn();
			const owner = new RetainedHeadlessSupervisor({
				registry: f.registry, initial: f.record, supervisor: f.supervisor,
				launch: { prompt: "secret", cwd: f.record.taskDir, inherited: {} }, baseRef: "base",
			}, {
				operations: f.operations,
				spawn: ({ launchGate }) => ({
					interrupt,
					events: (async function* () {
						launchGate!.beforeSpawn();
						launchGate!.beforePrompt(4242);
						yield { kind: "run-started" } as const;
						if (streamFailure === "reject") throw new Error("stream-secret");
					})(),
				}),
			});
			expect(await owner.settlement).toBe("lost");
			expect(f.registry.get("sa-proof")).toMatchObject({ status: "lost", child: { identity: { pid: 4242 } }, outcome: null, completionId: null });
			expect(interrupt).not.toHaveBeenCalled();
			expect(existsSync(join(f.record.taskDir, "result.json"))).toBe(false);
			expect(readFileSync(join(f.record.taskDir, "events.json"), "utf8")).not.toContain("stream-secret");
		});
	}

	it("refuses a stale revision during manifest collection rather than adopting it", async () => {
		const f = retainedFixture();
		f.proc.emit("spawn");
		await f.owner.ready;
		await f.finish();
		const current = f.registry.get("sa-proof")!;
		f.registry.acquireWriter(current.id, current.revision, 60_000);
		f.release();
		expect(await f.owner.settlement).toBe("ambiguous");
		expect(f.registry.get("sa-proof")).toMatchObject({ status: "settling", completionId: null, writerLease: { generation: 2 } });
		expect(() => f.owner.renew()).toThrow(/stopped/);
	});

	it("preserves the last running record when fsync fails, with only a local ambiguous verdict", async () => {
		const f = retainedFixture();
		f.proc.emit("spawn");
		await f.owner.ready;
		vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("disk unavailable"); });
		f.proc.emit("close", 1);
		expect(await f.owner.settlement).toBe("ambiguous");
		expect(f.registry.get("sa-proof")).toMatchObject({ status: "running", completionId: null, outcome: null });
		expect(f.proc.kill).not.toHaveBeenCalled();
	});

	it("keeps settling evidence on async manifest lease expiry and never retries publication", async () => {
		const f = retainedFixture();
		f.proc.emit("spawn");
		await f.owner.ready;
		await f.finish();
		expect(f.registry.get("sa-proof")?.status).toBe("settling");
		f.setNow(61_000);
		f.release();
		expect(await f.owner.settlement).toBe("ambiguous");
		expect(f.registry.get("sa-proof")).toMatchObject({ status: "settling", outcome: "completed", completionId: null, result: null, manifest: null });
		expect(existsSync(join(f.record.taskDir, "result.json"))).toBe(true);
		expect(existsSync(join(f.record.taskDir, "manifest.json"))).toBe(false);
		expect(() => f.owner.renew()).toThrow(/stopped/);
		expect(f.proc.kill).not.toHaveBeenCalled();
	});

	it("renews only its live revision and generation before later settlement", async () => {
		const f = retainedFixture();
		f.proc.emit("spawn");
		await f.owner.ready;
		f.setNow(60_000);
		f.owner.renew();
		expect(f.registry.get("sa-proof")?.writerLease).toMatchObject({ generation: 2, expiresAt: 120_000 });
		f.setNow(65_000);
		await f.finish();
		f.release();
		expect(await f.owner.settlement).toBe("settled");
		expect(f.subscriptions).toHaveBeenCalledTimes(1);
	});

	it("publishes host-derived private evidence before completion observers and leaves delivery pending", async () => {
		const f = retainedFixture();
		f.proc.emit("spawn");
		await f.owner.ready;
		const old = vi.fn();
		const unsubscribe = f.owner.subscribe(old);
		unsubscribe();
		f.owner.subscribe(() => { throw new Error("bad observer"); });
		f.owner.subscribe(async () => { throw new Error("async observer failed"); });
		const observed: SubagentRecord[] = [];
		f.owner.subscribe((record) => {
			if (record.status !== "settled") return;
			expect(readPrivateJson(join(record.taskDir, "result.json"))).toMatchObject({ outcome: { kind: "completed", finalText: "answer-secret" } });
			expect(readPrivateJson(join(record.taskDir, "manifest.json"))).toMatchObject({ manifest: { baseRef: "host-base", headRef: "host-head", exit: "completed" } });
			observed.push(record);
		});
		f.proc.stdout.emit("data", `${JSON.stringify({ type: "message_end", message: { role: "assistant", text: "answer-secret", manifest: { headRef: "child-forgery" } } })}\n`);
		await f.finish();
		expect(f.registry.get("sa-proof")).toMatchObject({ status: "settling", outcome: "completed", result: null, manifest: null, completionId: null, delivery: { state: "none" } });
		expect(existsSync(join(f.record.taskDir, "result.json"))).toBe(true);
		expect(observed).toHaveLength(0);
		f.release();
		expect(await f.owner.settlement).toBe("settled");
		const record = f.registry.get("sa-proof")!;
		expect(observed).toHaveLength(1);
		expect(observed[0]).toEqual(record);
		expect(record).toMatchObject({ delivery: { state: "pending", claim: null } });
		expect(record.completionId).toBeTruthy();
		for (const file of ["events.json", "result.json", "manifest.json"]) expect(statSync(join(record.taskDir, file)).mode & 0o777).toBe(0o600);
		expect(record.result?.bytes).toBe(statSync(join(record.taskDir, "result.json")).size);
		expect(record.manifest?.bytes).toBe(statSync(join(record.taskDir, "manifest.json")).size);
		expect(readFileSync(join(record.taskDir, "events.json"), "utf8")).not.toMatch(/prompt-secret|answer-secret|child-forgery/);
		expect(JSON.stringify(record)).not.toMatch(/prompt-secret|answer-secret|child-forgery/);
		expect(old).not.toHaveBeenCalled();
		expect(f.subscriptions).toHaveBeenCalledTimes(1);
		expect(f.spawn).toHaveBeenCalledTimes(1);
		expect(f.proc.kill).not.toHaveBeenCalled();
	});

	it("keeps the sole refused backend without killing or claiming later settlement", async () => {
		const f = fixture();
		const proc = Object.assign(new EventEmitter(), {
			pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter(),
			stdin: { on: vi.fn(), end: vi.fn(), write: vi.fn() }, kill: vi.fn(),
		});
		const spawn = vi.fn(() => proc);
		// SAFETY: fake piped process; the production parser and start gate run unchanged.
		const backend = createPiChildSpawner(spawn as never, () => undefined, () => "/selected/pi");
		const owner = new RetainedHeadlessSupervisor({
			registry: f.registry, initial: f.record, supervisor: f.supervisor,
			launch: { prompt: "private prompt", cwd: f.record.taskDir, inherited: {} }, baseRef: "base",
		}, { operations: f.operations, spawn: backend, buildManifest: async () => { throw new Error("git unavailable"); } });
		f.operations.identityMatches = (identity) => identity.pid === 4242 ? "unknown" : "same";
		proc.emit("spawn");
		await expect(owner.ready).rejects.toThrow(/ambiguous/);
		expect(f.registry.get("sa-proof")).toMatchObject({ status: "ambiguous", child: { identity: { pid: 4242 } } });
		owner.subscribe(() => { throw new Error("observer failed"); });
		proc.emit("close", 1);
		expect(await owner.settlement).toBe("ambiguous");
		expect(f.registry.get("sa-proof")).toMatchObject({ status: "ambiguous", outcome: null, result: null, delivery: { state: "none" } });
		expect(() => owner.renew()).toThrow(/stopped/);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(proc.kill).not.toHaveBeenCalled();
		expect(proc.stdin.write).not.toHaveBeenCalled();
		expect(proc.stdin.end).not.toHaveBeenCalled();
	});
});

describe("retained supervisor headless launch admission", () => {
	it("drives the production backend gate: starting at spawn and durable running at stdin write", async () => {
		const f = fixture();
		const proc = Object.assign(new EventEmitter(), {
			pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter(),
			stdin: { on: vi.fn(), end: vi.fn(), write: vi.fn(() => {
				expect(f.registry.get("sa-proof")).toMatchObject({ status: "running", child: { identity: { pid: 4242 } } });
			}) }, kill: vi.fn(),
		});
		const spawn = vi.fn(() => {
			expect(f.registry.get("sa-proof")).toMatchObject({ status: "starting", supervisor: f.supervisor, child: null });
			return proc;
		});
		Object.assign(proc, { send: vi.fn(() => proc.emit("message", { kind: "started", child: { pid: 4343, processStartTime: "child-birth" } })) });
		const launchGate = createRetainedHeadlessLaunchGate(f.registry, f.record, f.supervisor, f.operations);
		// SAFETY: this fake implements the backend's piped child-process surface; no process is launched.
		const child = createPiChildSpawner(spawn as never, () => undefined, () => "/selected/pi", () => undefined, f.operations)({
			prompt: "private λ", cwd: f.record.taskDir, inherited: {}, launchGate,
		});
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- the backend explicitly exposes callback or AsyncIterable events.
		if (typeof child.events !== "function") throw new Error("expected callback backend");
		child.events(() => {});
		expect(proc.stdin.write).not.toHaveBeenCalled();
		proc.emit("spawn");
		await child.ready;
		expect(proc.stdin.write).toHaveBeenCalledExactlyOnceWith("private λ");
		expect(spawn).toHaveBeenCalledTimes(1);
		proc.emit("close", 0);
	});

	it("persists starting and the supervisor before spawn, then child anchors before release", () => {
		const f = fixture();
		const gate = createRetainedHeadlessLaunchGate(f.registry, f.record, f.supervisor, f.operations);
		expect(f.registry.get("sa-proof")).toMatchObject({ status: "starting", supervisor: f.supervisor, child: null });
		gate.beforeSpawn();
		expect(f.registry.get("sa-proof")?.status).toBe("starting");
		gate.beforePrompt(4242);
		expect(f.registry.get("sa-proof")).toMatchObject({
			status: "running", child: { identity: { pid: 4242, processGroupId: 4242, processStartTime: "child-command" }, verification: { members: [{ pid: 4242, processStartTime: "child-birth" }] } },
		});
		expect(f.operations.signalTree).not.toHaveBeenCalled();
		expect(() => gate.beforeSpawn()).toThrow(/already used/);
		expect(() => gate.beforePrompt(4242)).toThrow(/unavailable/);
	});

	for (const cut of ["before spawn", "before release"] as const) {
		for (const refusal of ["revision", "expiry", "supervisor death", "corrupt record"] as const) {
			it(`refuses ${refusal} ${cut} without capture, release or signals`, () => {
				const f = fixture();
				const gate = createRetainedHeadlessLaunchGate(f.registry, f.record, f.supervisor, f.operations);
				if (cut === "before release") gate.beforeSpawn();
				const record = f.registry.get("sa-proof")!;
				if (refusal === "revision") f.registry.acquireWriter(record.id, record.revision, 60_000);
				if (refusal === "expiry") f.setNow(61_000);
				if (refusal === "supervisor death") f.operations.identityMatches = () => "different";
				if (refusal === "corrupt record") writeFileSync(join(f.record.taskDir, "..", "registry", "sa-proof.json"), "{broken", { mode: 0o600 });
				expect(() => cut === "before spawn" ? gate.beforeSpawn() : gate.beforePrompt(4242)).toThrow();
				expect(f.operations.captureStartTime).not.toHaveBeenCalled();
				expect(f.operations.signalTree).not.toHaveBeenCalled();
			});
		}
	}

	it("refuses expiry during OS capture without publishing child authority", () => {
		const f = fixture();
		const gate = createRetainedHeadlessLaunchGate(f.registry, f.record, f.supervisor, f.operations);
		gate.beforeSpawn();
		f.operations.captureTreeVerification = () => {
			f.setNow(61_000);
			return { members: [{ pid: 4242, processStartTime: "child-birth" }] };
		};
		expect(() => gate.beforePrompt(4242)).toThrow(/expired/);
		expect(f.registry.get("sa-proof")).toMatchObject({ status: "starting", child: null });
		expect(f.operations.signalTree).not.toHaveBeenCalled();
	});

	it("preserves captured child anchors when final identity verification refuses release", () => {
		const f = fixture();
		const gate = createRetainedHeadlessLaunchGate(f.registry, f.record, f.supervisor, f.operations);
		gate.beforeSpawn();
		f.operations.identityMatches = (identity) => identity.pid === 4242 ? "unknown" : "same";
		expect(() => gate.beforePrompt(4242)).toThrow(/ambiguous/);
		expect(f.registry.get("sa-proof")).toMatchObject({ status: "starting", child: { identity: { pid: 4242 } } });
		expect(() => gate.beforePrompt(4242)).toThrow(/unavailable/);
		expect(f.operations.signalTree).not.toHaveBeenCalled();
	});

	it.each(["reused", "moved", "unowned", "unknown"] as const)("denies %s targets before stdin and signal effects", (target) => {
		const f = fixture();
		const gate = createRetainedHeadlessLaunchGate(f.registry, f.record, f.supervisor, f.operations);
		gate.beforeSpawn();
		gate.beforePrompt(4242);
		const original = f.registry.get("sa-proof")!.child;
		if (target === "reused" || target === "unknown") {
			f.operations.identityMatches = (identity) => identity.pid === 4242 ? target === "reused" ? "different" : "unknown" : "same";
		}
		if (target === "moved") f.operations.verificationMatches = (identity, verification) => {
			if (identity.pid !== 4242) return "same";
			expect(verification.members).toEqual([{ pid: 4242, processStartTime: "child-birth" }]);
			return "different";
		};
		const pid = target === "unowned" ? 4343 : 4242;
		expect(() => gate.beforeStdin(pid)).toThrow();
		expect(() => gate.beforeSignal(pid)).toThrow();
		expect(f.operations.signalTree).not.toHaveBeenCalled();
		expect(f.registry.get("sa-proof")!.child).toEqual(original);
	});

	it("does not create a record for a foreign supervisor or visible backend", () => {
		const f = fixture();
		expect(() => createRetainedHeadlessLaunchGate(f.registry, { ...f.record, backend: "visible" }, f.supervisor, f.operations)).toThrow();
		expect(() => createRetainedHeadlessLaunchGate(f.registry, f.record, { ...f.supervisor, identity: { ...f.supervisor.identity, pid: process.pid + 1 } }, f.operations)).toThrow();
		expect(() => createRetainedHeadlessLaunchGate(f.registry, f.record, { ...f.supervisor, identity: { ...f.supervisor.identity, processGroupId: process.pid + 1 } }, f.operations)).toThrow();
		expect(f.registry.get("sa-proof")).toBeUndefined();
	});
});
