import { describe, expect, it, vi } from "vitest";
import { systemProcessTree, terminateProcessTree, type ProcessTreeOperations } from "./process-tree.js";

const identity = { pid: 123, processGroupId: 123, processStartTime: "start" };

describe("process tree operations", () => {
	it.skipIf(process.platform === "win32")("signals only the POSIX process group and never falls back on EPERM", async () => {
		const denied = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
		const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
			if (pid === -123 && signal === "SIGTERM") throw denied;
			return true;
		}) as typeof process.kill);
		try {
			expect(await systemProcessTree.signalTree(identity, "SIGTERM")).toMatchObject({ ok: false, gone: false });
			expect(kill).toHaveBeenCalledTimes(1);
			expect(kill).toHaveBeenCalledWith(-123, "SIGTERM");
			expect(kill).not.toHaveBeenCalledWith(123, "SIGTERM");
		} finally {
			kill.mockRestore();
		}
	});

	it("escalates from TERM to KILL and confirms the whole tree is empty", async () => {
		let waits = 0;
		const operations: ProcessTreeOperations = {
			captureStartTime: vi.fn(() => "start"),
			identityMatches: vi.fn((): "same" => "same"),
			isTreeEmpty: vi.fn(() => waits >= 2),
			signalTree: vi.fn(async () => ({ ok: true, gone: false })),
			waitForTreeEmpty: vi.fn(async () => {
				waits += 1;
				return waits >= 2;
			}),
		};

		expect(await terminateProcessTree(operations, identity, { termGraceMs: 10, killGraceMs: 10 })).toBe(true);
		expect(operations.signalTree).toHaveBeenNthCalledWith(1, identity, "SIGTERM");
		expect(operations.signalTree).toHaveBeenNthCalledWith(2, identity, "SIGKILL");
		expect(operations.waitForTreeEmpty).toHaveBeenCalledTimes(2);
	});
});
