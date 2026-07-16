import { describe, expect, it, vi } from "vitest";
import { herdrTerminalHost, parseHerdrPaneSplit } from "./herdr.js";

function pi(stdout: string, code = 0) {
	return { exec: vi.fn(async () => ({ stdout, stderr: "", code, killed: false })) };
}

describe("herdrTerminalHost", () => {
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
	it("parses pane split envelopes", () => {
		expect(parseHerdrPaneSplit(JSON.stringify({ result: { pane: { pane_id: "w1:p2", workspace_id: "w1" } } }))).toEqual({ ok: true, pane: { host: "herdr", paneId: "w1:p2", workspaceId: "w1" } });
	});
	it("closes and notifies", async () => {
		const fake = pi(JSON.stringify({ result: { type: "ok" } }));
		await herdrTerminalHost.closePane(fake as never, { host: "herdr", paneId: "w1:p2" });
		await herdrTerminalHost.notify(fake as never, "title", "body");
		expect(fake.exec).toHaveBeenCalledWith("herdr", ["pane", "close", "w1:p2"], { timeout: 5000 });
		expect(fake.exec).toHaveBeenCalledWith("herdr", ["notification", "show", "title", "--body", "body", "--sound", "done"], { timeout: 5000 });
	});
});
