import { describe, expect, it, vi } from "vitest";
import {
	captureProcessStartTime,
	runWindowsTaskkill,
	signalVerifiedProcessTree,
	systemProcessTree,
	terminateProcessTree,
	type ProcessTreeOperations,
} from "./process-tree.js";

const identity = { pid: 123, processGroupId: 123, processStartTime: "start" };

function operations(overrides: Partial<ProcessTreeOperations> = {}): ProcessTreeOperations {
	return {
		captureStartTime: vi.fn(() => "start"),
		identityMatches: vi.fn((): "same" => "same"),
		isTreeEmpty: vi.fn(() => false),
		signalTree: vi.fn(async () => ({ ok: true, gone: false })),
		waitForTreeEmpty: vi.fn(async () => false),
		...overrides,
	};
}

describe("process tree operations", () => {
	it.skipIf(process.platform === "win32")("signals only the POSIX process group and never falls back on EPERM", async () => {
		const processStartTime = captureProcessStartTime(process.pid)!;
		const denied = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
		const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
			if (pid === -123 && signal === "SIGTERM") throw denied;
			return true;
		}) as typeof process.kill);
		try {
			expect(await systemProcessTree.signalTree({ pid: process.pid, processGroupId: 123, processStartTime }, "SIGTERM")).toMatchObject({ ok: false, gone: false });
			expect(kill).toHaveBeenCalledWith(-123, "SIGTERM");
			expect(kill).not.toHaveBeenCalledWith(process.pid, "SIGTERM");
		} finally {
			kill.mockRestore();
		}
	});

	it.each(["different", "unknown"] as const)("refuses to signal when persisted identity is %s", async (status) => {
		const harness = operations({ identityMatches: vi.fn(() => status) });
		expect(await signalVerifiedProcessTree(harness, identity, "SIGTERM")).toMatchObject({ ok: false, identityStatus: status });
		expect(harness.signalTree).not.toHaveBeenCalled();
	});

	it("permits escalation after leader exit only with a still-matching captured descendant anchor", async () => {
		const verification = { members: [{ pid: 456, processStartTime: "child-start" }] };
		const harness = operations({
			identityMatches: vi.fn((): "unknown" => "unknown"),
			verificationMatches: vi.fn((): "same" => "same"),
		});
		expect(await signalVerifiedProcessTree(harness, identity, "SIGKILL", verification)).toMatchObject({ ok: true });
		expect(harness.verificationMatches).toHaveBeenCalledWith(identity, verification);
		expect(harness.signalTree).toHaveBeenCalledWith(identity, "SIGKILL", verification);
	});

	it("re-verifies identity immediately before TERM and KILL", async () => {
		let waits = 0;
		const harness = operations({
			waitForTreeEmpty: vi.fn(async () => {
				waits += 1;
				return waits >= 2;
			}),
		});

		expect(await terminateProcessTree(harness, identity, { termGraceMs: 10, killGraceMs: 10 })).toBe(true);
		expect(harness.identityMatches).toHaveBeenCalledTimes(2);
		expect(harness.signalTree).toHaveBeenNthCalledWith(1, identity, "SIGTERM");
		expect(harness.signalTree).toHaveBeenNthCalledWith(2, identity, "SIGKILL");
	});

	it("refuses KILL when identity changes during TERM grace", async () => {
		const harness = operations({
			identityMatches: vi.fn()
				.mockReturnValueOnce("same")
				.mockReturnValueOnce("different"),
		});
		expect(await terminateProcessTree(harness, identity, { termGraceMs: 1, killGraceMs: 1 })).toBe(false);
		expect(harness.signalTree).toHaveBeenCalledTimes(1);
	});

	it("trusts only successful taskkill /T completion and never leader absence on error", async () => {
		const successExecutor = vi.fn((_args, callback: (error?: Error | null) => void) => callback());
		expect(await runWindowsTaskkill(123, true, successExecutor)).toEqual({ ok: true, gone: true });
		expect(successExecutor).toHaveBeenCalledWith(["/PID", "123", "/T", "/F"], expect.any(Function));

		const descendantStillAlive = vi.fn((_args, callback: (error?: Error | null) => void) => callback(new Error("leader not found; descendant remains")));
		expect(await runWindowsTaskkill(123, true, descendantStillAlive)).toMatchObject({ ok: false, gone: false });
	});
});
