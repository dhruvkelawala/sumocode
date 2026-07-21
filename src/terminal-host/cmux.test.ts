import { describe, expect, it, vi } from "vitest";
import { cmuxTerminalHost } from "./cmux.js";

function fakePi(outputs: string[]) {
	return { exec: vi.fn(async () => ({ stdout: outputs.shift() ?? "", stderr: "", code: 0, killed: false })) };
}

describe("cmuxTerminalHost", () => {
	it("maps cmux split refs to pane refs", async () => {
		const fake = fakePi([
			JSON.stringify({ caller: { workspace_ref: "workspace:1", surface_ref: "surface:1" } }),
			JSON.stringify({ panes: [{ ref: "pane:1", selected_surface_ref: "surface:1" }] }),
			"OK surface:2 workspace:1",
			"",
		]);
		const result = await cmuxTerminalHost.openCommandInSplit(fake as never, "right", { cwd: "/tmp", shellCommand: "echo ok" });
		expect(result).toEqual({ ok: true, pane: { host: "cmux", paneId: "surface:2", workspaceId: "workspace:1" } });
	});
	it("starts visible agents through the degraded right-split fallback", async () => {
		const fake = fakePi([
			JSON.stringify({ caller: { workspace_ref: "workspace:1", surface_ref: "surface:1" } }),
			JSON.stringify({ panes: [{ ref: "pane:1", selected_surface_ref: "surface:1" }] }),
			"OK surface:2 workspace:1",
			"",
		]);
		const result = await cmuxTerminalHost.startAgentPane(fake as never, {
			name: "worker",
			cwd: "/tmp",
			shellCommand: "echo ok",
			placement: { kind: "new-tab", label: "subagents" },
		});
		expect(result).toEqual({ ok: true, pane: { host: "cmux", paneId: "surface:2", workspaceId: "workspace:1" }, agentName: "worker", workspaceId: "workspace:1", paneId: "surface:2" });
	});

	it("reports pane steering as unsupported", async () => {
		await expect(cmuxTerminalHost.sendPaneText({ exec: vi.fn() } as never, { host: "cmux", paneId: "surface:2" }, "continue")).resolves.toEqual({ ok: false, error: "not supported on cmux" });
	});

	it("notify is best-effort when exec rejects", async () => {
		const fake = { exec: vi.fn(async () => { throw new Error("no cmux"); }) };
		await expect(cmuxTerminalHost.notify(fake as never, "title", "body")).resolves.toBeUndefined();
	});
});
