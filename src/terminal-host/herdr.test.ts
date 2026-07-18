import { afterEach, describe, expect, it, vi } from "vitest";
import { herdrTerminalHost } from "./herdr.js";

function pi(stdout: string, code = 0) {
	return { exec: vi.fn(async () => ({ stdout, stderr: "", code, killed: false })) };
}

describe("herdrTerminalHost", () => {
	afterEach(() => {
		delete process.env.HERDR_PANE_ID;
	});
	it("anchors the split to the caller's tab when HERDR_PANE_ID resolves", async () => {
		process.env.HERDR_PANE_ID = "w7:p3";
		const exec = vi.fn(async (_bin: string, args: string[]) => {
			if (args[0] === "pane" && args[1] === "get") {
				return { stdout: JSON.stringify({ result: { pane: { tab_id: "w7:t2" } } }), stderr: "", code: 0, killed: false };
			}
			return { stdout: JSON.stringify({ result: { agent: { pane_id: "w7:p9", workspace_id: "w7" } } }), stderr: "", code: 0, killed: false };
		});
		const result = await herdrTerminalHost.openCommandInSplit({ exec } as never, "right", { cwd: "/tmp", shellCommand: "echo ok" });
		expect(result).toEqual({ ok: true, pane: { host: "herdr", paneId: "w7:p9", workspaceId: "w7" } });
		expect(exec).toHaveBeenCalledWith("herdr", ["pane", "get", "w7:p3"], { timeout: 5000 });
		expect(exec).toHaveBeenCalledWith("herdr", ["agent", "start", "sumocode-task", "--cwd", "/tmp", "--tab", "w7:t2", "--split", "right", "--no-focus", "--", "bash", "-lc", "echo ok"], { timeout: 5000 });
	});
	it("falls back to default placement when the anchor cannot be resolved", async () => {
		process.env.HERDR_PANE_ID = "w7:p3";
		const exec = vi.fn(async (_bin: string, args: string[]) => {
			if (args[0] === "pane" && args[1] === "get") {
				return { stdout: "", stderr: "no such pane", code: 1, killed: false };
			}
			return { stdout: JSON.stringify({ result: { agent: { pane_id: "w1:p2", workspace_id: "w1" } } }), stderr: "", code: 0, killed: false };
		});
		const result = await herdrTerminalHost.openCommandInSplit({ exec } as never, "down", { cwd: "/tmp", shellCommand: "echo ok" });
		expect(result).toEqual({ ok: true, pane: { host: "herdr", paneId: "w1:p2", workspaceId: "w1" } });
		expect(exec).toHaveBeenCalledWith("herdr", ["agent", "start", "sumocode-task", "--cwd", "/tmp", "--split", "down", "--no-focus", "--", "bash", "-lc", "echo ok"], { timeout: 5000 });
	});
	it("opens with agent start and returns pane ref", async () => {
		const fake = pi(JSON.stringify({ result: { agent: { pane_id: "w1:p2", workspace_id: "w1" } } }));
		const result = await herdrTerminalHost.openCommandInSplit(fake as never, "right", { cwd: "/tmp", shellCommand: "echo ok" });
		expect(result).toEqual({ ok: true, pane: { host: "herdr", paneId: "w1:p2", workspaceId: "w1" } });
		expect(fake.exec).toHaveBeenCalledWith("herdr", ["agent", "start", "sumocode-task", "--cwd", "/tmp", "--split", "right", "--no-focus", "--", "bash", "-lc", "echo ok"], { timeout: 5000 });
	});
	it("reports malformed json", async () => {
		const fake = pi("not-json");
		const result = await herdrTerminalHost.openCommandInSplit(fake as never, "down", { cwd: "/tmp", shellCommand: "echo ok" });
		expect(result.ok).toBe(false);
	});
	it("closes and notifies", async () => {
		const fake = pi(JSON.stringify({ result: { type: "ok" } }));
		await herdrTerminalHost.closePane(fake as never, { host: "herdr", paneId: "w1:p2" });
		await herdrTerminalHost.notify(fake as never, "title", "body");
		expect(fake.exec).toHaveBeenCalledWith("herdr", ["pane", "close", "w1:p2"], { timeout: 5000 });
		expect(fake.exec).toHaveBeenCalledWith("herdr", ["notification", "show", "title", "--body", "body", "--sound", "done"], { timeout: 5000 });
	});
	it("notify is best-effort when exec rejects", async () => {
		const fake = { exec: vi.fn(async () => { throw new Error("no daemon"); }) };
		await expect(herdrTerminalHost.notify(fake as never, "title", "body")).resolves.toBeUndefined();
	});
});
