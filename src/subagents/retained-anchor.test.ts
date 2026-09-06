import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPiChildSpawner, type HeadlessLaunchGate } from "./backend-pi.js";
import type { ProcessTreeOperations } from "../background-tasks/process-tree.js";

const runnerEnvironment = process.env;
beforeEach(() => { process.env = { PATH: "/synthetic/bin", HOME: "/synthetic/home", TMPDIR: "/tmp" }; });
afterEach(() => { process.env = runnerEnvironment; });

it("retains a separate live group anchor through Pi title changes and post-Pi-exit KILL", async () => {
	const proc = Object.assign(new EventEmitter(), {
		pid: 4242, exitCode: null, signalCode: null,
		stdin: { on: vi.fn(), write: vi.fn(), end: vi.fn() },
		stdout: new EventEmitter(), stderr: new EventEmitter(),
		send: vi.fn(), kill: vi.fn(),
	});
	const spawn = vi.fn(() => proc);
	const tree = {
		identity: { pid: 4242, processGroupId: 4242, processStartTime: "anchor-command" },
		verification: { members: [{ pid: 4242, processStartTime: "anchor-birth" }] },
	};
	const gate: HeadlessLaunchGate = {
		beforeSpawn: vi.fn(() => "12345678-1234-1234-1234-123456789abc"), beforePrompt: vi.fn(), beforeStdin: vi.fn(),
		beforeSignal: () => tree, onRefused: vi.fn(),
	};
	let finishWait!: (empty: boolean) => void;
	const signals: string[] = [];
	const operations: ProcessTreeOperations = {
		captureStartTime: () => { throw new Error("no recapture"); },
		identityMatches: (identity) => identity.pid === 4242 ? "same" : "different",
		verificationMatches: () => "same", isTreeEmpty: () => false,
		signalTree: async (identity, signal) => {
			expect(identity.pid).toBe(4242);
			signals.push(signal);
			return { ok: true, gone: signal === "SIGKILL" };
		},
		waitForTreeEmpty: () => new Promise((resolve) => { finishWait = resolve; }),
	};
	// SAFETY: fake anchor process implements the backend's piped child-process surface.
	const child = createPiChildSpawner(spawn as never, () => undefined, () => "/selected/pi", () => undefined, operations)({
		prompt: "private", cwd: "/workspace", inherited: {}, launchGate: gate,
	});
	if (Symbol.asyncIterator in child.events) throw new Error("callback expected");
	child.events(() => undefined);
	expect(spawn).toHaveBeenCalledWith(expect.any(String), ["-e", expect.any(String), "sumocode-retained-anchor:12345678-1234-1234-1234-123456789abc"], expect.objectContaining({ detached: true }));
	expect(proc.send).not.toHaveBeenCalled();
	proc.emit("spawn");
	expect(proc.send).toHaveBeenCalledTimes(1);
	expect(proc.stdin.write).not.toHaveBeenCalled();
	proc.emit("message", { kind: "started", child: { pid: 4343, processStartTime: "pi-birth" } });
	await child.ready;
	expect(proc.stdin.write).toHaveBeenCalledExactlyOnceWith("private");
	proc.emit("message", { kind: "exited", code: 0, signal: null });
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(signals).toEqual(["SIGTERM"]);
	finishWait(false);
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	expect(gate.onRefused).not.toHaveBeenCalled();
	proc.emit("close", null, "SIGKILL");
});
