import { describe, expect, it, vi } from "vitest";
import { herdrTerminalHost } from "./herdr.js";
import type { PiExecLike, TerminalHost } from "./types.js";

const pane = { host: "herdr" as const, paneId: "w1:p2" };
const info = { pane_id: pane.paneId, shell_pid: 101, foreground_process_group_id: 202, foreground_processes: [{ pid: 202, name: "bash", cmdline: "private command" }] };
const host: TerminalHost = herdrTerminalHost;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- malformed wire fixtures exercise the adapter's JSON boundary.
function executor(processInfo: unknown): PiExecLike {
	return { exec: vi.fn().mockResolvedValue({ code: 0, stderr: "", stdout: JSON.stringify({ result: { type: "pane_process_info", process_info: processInfo } }) }) };
}

describe("Herdr pane process inspection", () => {
	it("queries an explicit pane and exposes numeric association evidence, not command text or liveness", async () => {
		const pi = executor(info);
		expect(await host.inspectPane!(pi, pane)).toEqual({ ok: true, shellPid: 101, foregroundProcessGroupId: 202, foregroundPids: [202] });
		expect(pi.exec).toHaveBeenCalledWith("herdr", ["pane", "process-info", "--pane", pane.paneId], { timeout: 5000 });
	});
	it("keeps absent process evidence unknown", async () => {
		expect(await host.inspectPane!(executor({ pane_id: pane.paneId }), pane)).toEqual({ ok: true, shellPid: null, foregroundProcessGroupId: null, foregroundPids: [] });
	});
	it.each([
		{ ...info, pane_id: "w1:p3" },
		{ ...info, shell_pid: "101" },
		{ ...info, foreground_process_group_id: -1 },
		{ ...info, foreground_processes: [{ pid: 0 }] },
		{ ...info, foreground_processes: {} },
	])("fails closed on malformed or mismatched association %j", async (value) => {
		expect(await host.inspectPane!(executor(value), pane)).toEqual({ ok: false, error: "pane-unverified" });
	});
	it.each(["throw", "nonzero", "malformed"])("redacts %s query failure", async (failure) => {
		const exec = vi.fn();
		if (failure === "throw") exec.mockRejectedValue(new Error("private command"));
		else exec.mockResolvedValue({ code: failure === "nonzero" ? 1 : 0, stdout: "private command", stderr: "private command" });
		expect(await host.inspectPane!({ exec }, pane)).toEqual({ ok: false, error: "pane-unverified" });
	});
});
