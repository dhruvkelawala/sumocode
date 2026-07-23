import { afterEach, describe, expect, it, vi } from "vitest";
import { herdrTerminalHost, uniqueHerdrAgentName } from "./herdr.js";

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
		expect(exec).toHaveBeenCalledWith("herdr", ["agent", "start", expect.stringMatching(/^sumocode-/), "--cwd", "/tmp", "--tab", "w7:t2", "--split", "right", "--no-focus", "--", "bash", "-lc", "echo ok"], { timeout: 5000 });
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
		expect(exec).toHaveBeenCalledWith("herdr", ["agent", "start", expect.stringMatching(/^sumocode-/), "--cwd", "/tmp", "--split", "down", "--no-focus", "--", "bash", "-lc", "echo ok"], { timeout: 5000 });
	});
	it("resolves the workspace pane even when herdr omits per-pane workspace_id", async () => {
		const exec = vi.fn(async (_bin: string, args: string[]) => {
			if (args[0] === "worktree") {
				return { stdout: JSON.stringify({ result: { workspace: { workspace_id: "wC" } } }), stderr: "", code: 0, killed: false };
			}
			if (args[0] === "pane" && args[1] === "list") {
				return { stdout: JSON.stringify({ result: { panes: [{ pane_id: "wC:p1" }, { pane_id: "wC:p2" }] } }), stderr: "", code: 0, killed: false };
			}
			return { stdout: JSON.stringify({ result: { type: "ok" } }), stderr: "", code: 0, killed: false };
		});
		await expect(
			herdrTerminalHost.openWorktreeWorkspace?.({ exec } as never, { branch: "sumo/x", baseRef: "HEAD", path: "/repo.wt/sumo__x", label: "sumo · x", shellCommand: "exec sumocode", sourceCwd: "/repo" }),
		).resolves.toEqual({ ok: true, pane: { host: "herdr", paneId: "wC:p1", workspaceId: "wC" } });
	});

	it("opens with agent start and returns pane ref", async () => {
		const fake = pi(JSON.stringify({ result: { agent: { pane_id: "w1:p2", workspace_id: "w1" } } }));
		const result = await herdrTerminalHost.openCommandInSplit(fake as never, "right", { cwd: "/tmp", shellCommand: "echo ok" });
		expect(result).toEqual({ ok: true, pane: { host: "herdr", paneId: "w1:p2", workspaceId: "w1" } });
		expect(fake.exec).toHaveBeenCalledWith("herdr", ["agent", "start", expect.stringMatching(/^sumocode-/), "--cwd", "/tmp", "--split", "right", "--no-focus", "--", "bash", "-lc", "echo ok"], { timeout: 5000 });
	});
	it("moves a worktree workspace's bootstrap shell out of the agent tab", async () => {
		const exec = vi.fn(async (_bin: string, args: string[]) => args[0] === "agent"
			? { stdout: JSON.stringify({ result: { agent: { pane_id: "w9:p2", workspace_id: "w9", tab_id: "w9:t1" } } }), stderr: "", code: 0, killed: false }
			: { stdout: "", stderr: "", code: 0, killed: false });
		const result = await herdrTerminalHost.startAgentPane({ exec } as never, {
			name: "API Worker",
			cwd: "/repo/packages/api",
			shellCommand: "exec sumocode task",
			placement: { kind: "workspace", workspaceId: "w9", paneId: "w9:p1" },
		});
		expect(result).toMatchObject({ ok: true, agentName: expect.stringMatching(/^api-worker-/), workspaceId: "w9", tabId: "w9:t1", paneId: "w9:p2" });
		expect(exec).toHaveBeenNthCalledWith(1, "herdr", ["agent", "start", expect.stringMatching(/^api-worker-/), "--workspace", "w9", "--cwd", "/repo/packages/api", "--no-focus", "--", "bash", "-lc", "exec sumocode task"], { timeout: 5000 });
		expect(exec).toHaveBeenNthCalledWith(2, "herdr", ["pane", "move", "w9:p1", "--new-tab", "--workspace", "w9", "--label", "shell", "--no-focus"], { timeout: 5000 });
		expect(exec).toHaveBeenNthCalledWith(3, "herdr", ["pane", "rename", "w9:p2", "API Worker"], { timeout: 5000 });
	});

	it("keeps the started agent when the cosmetic bootstrap-shell move fails", async () => {
		const exec = vi.fn(async (_bin: string, args: string[]) => {
			if (args[0] === "agent") return { stdout: JSON.stringify({ result: { agent: { pane_id: "w9:p2", workspace_id: "w9", tab_id: "w9:t1" } } }), stderr: "", code: 0, killed: false };
			if (args[0] === "pane" && args[1] === "move") return { stdout: "", stderr: "move denied", code: 1, killed: false };
			return { stdout: "", stderr: "", code: 0, killed: false };
		});
		const result = await herdrTerminalHost.startAgentPane({ exec } as never, {
			name: "API Worker",
			cwd: "/repo",
			shellCommand: "exec sumocode task",
			placement: { kind: "workspace", workspaceId: "w9", paneId: "w9:p1" },
		});
		expect(result).toMatchObject({ ok: true, paneId: "w9:p2" });
		expect(exec).not.toHaveBeenCalledWith("herdr", ["pane", "close", "w9:p2"], expect.anything());
		expect(exec).toHaveBeenCalledWith("herdr", ["pane", "rename", "w9:p2", "API Worker"], { timeout: 5000 });
	});

	it("starts an agent in an existing workspace when no reusable pane is supplied", async () => {
		const exec = vi.fn(async (_bin: string, args: string[]) => {
			if (args[0] === "agent") return { stdout: JSON.stringify({ result: { agent: { pane_id: "w9:p2", workspace_id: "w9", tab_id: "w9:t1" } } }), stderr: "", code: 0, killed: false };
			return { stdout: "", stderr: "", code: 0, killed: false };
		});
		const result = await herdrTerminalHost.startAgentPane({ exec } as never, {
			name: "API Worker",
			cwd: "/repo/packages/api",
			shellCommand: "exec sumocode task",
			placement: { kind: "workspace", workspaceId: "w9" },
		});
		expect(result).toMatchObject({ ok: true, agentName: expect.stringMatching(/^api-worker-/), workspaceId: "w9", tabId: "w9:t1", paneId: "w9:p2" });
		expect(exec).toHaveBeenNthCalledWith(1, "herdr", ["agent", "start", expect.stringMatching(/^api-worker-/), "--workspace", "w9", "--cwd", "/repo/packages/api", "--no-focus", "--", "bash", "-lc", "exec sumocode task"], { timeout: 5000 });
		expect(exec).toHaveBeenNthCalledWith(2, "herdr", ["pane", "rename", "w9:p2", "API Worker"], { timeout: 5000 });
	});

	it("starts an agent as a split in an existing tab", async () => {
		const exec = vi.fn(async () => ({ stdout: JSON.stringify({ result: { agent: { pane_id: "w3:p4", workspace_id: "w3", tab_id: "w3:t2" } } }), stderr: "", code: 0, killed: false }));
		await expect(herdrTerminalHost.startAgentPane({ exec } as never, {
			name: "review",
			cwd: "/repo",
			shellCommand: "run child",
			placement: { kind: "tab", tabId: "w3:t2", direction: "down" },
		})).resolves.toMatchObject({ ok: true, tabId: "w3:t2", paneId: "w3:p4" });
		expect(exec).toHaveBeenNthCalledWith(1, "herdr", ["agent", "start", expect.stringMatching(/^review-/), "--tab", "w3:t2", "--split", "down", "--cwd", "/repo", "--no-focus", "--", "bash", "-lc", "run child"], { timeout: 5000 });
	});

	it("creates a no-focus tab before starting an agent in it", async () => {
		vi.stubEnv("HERDR_PANE_ID", "");
		const exec = vi.fn(async (_bin: string, args: string[]) => {
			if (args[0] === "tab") return { stdout: JSON.stringify({ result: { tab: { tab_id: "w5:t8" } } }), stderr: "", code: 0, killed: false };
			return { stdout: JSON.stringify({ result: { agent: { pane_id: "w5:p9", workspace_id: "w5", tab_id: "w5:t8" } } }), stderr: "", code: 0, killed: false };
		});
		await expect(herdrTerminalHost.startAgentPane({ exec } as never, {
			name: "research",
			cwd: "/repo",
			shellCommand: "run child",
			placement: { kind: "new-tab", label: "subagents" },
		})).resolves.toMatchObject({ ok: true, tabId: "w5:t8", paneId: "w5:p9" });
		expect(exec).toHaveBeenNthCalledWith(1, "herdr", ["tab", "create", "--label", "subagents", "--no-focus"], { timeout: 5000 });
		expect(exec).toHaveBeenNthCalledWith(2, "herdr", ["agent", "start", expect.stringMatching(/^research-/), "--tab", "w5:t8", "--cwd", "/repo", "--no-focus", "--", "bash", "-lc", "run child"], { timeout: 5000 });
		vi.unstubAllEnvs();
	});

	it("anchors a new subagents tab to the caller workspace from HERDR_PANE_ID", async () => {
		vi.stubEnv("HERDR_PANE_ID", "w7:pB");
		try {
			const exec = vi.fn(async (_bin: string, args: string[]) => {
				if (args[0] === "tab") return { stdout: JSON.stringify({ result: { tab: { tab_id: "w7:t3" } } }), stderr: "", code: 0, killed: false };
				return { stdout: JSON.stringify({ result: { agent: { pane_id: "w7:p9", workspace_id: "w7", tab_id: "w7:t3" } } }), stderr: "", code: 0, killed: false };
			});
			await herdrTerminalHost.startAgentPane!({ exec } as never, {
				name: "research",
				cwd: "/repo",
				shellCommand: "run child",
				placement: { kind: "new-tab", label: "subagents" },
			});
			expect(exec).toHaveBeenNthCalledWith(1, "herdr", ["tab", "create", "--workspace", "w7", "--label", "subagents", "--no-focus"], { timeout: 5000 });
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("keeps a successful start when pane rename fails", async () => {
		const exec = vi.fn(async (_bin: string, args: string[]) => args[0] === "agent"
			? { stdout: JSON.stringify({ result: { agent: { pane_id: "w1:p7", workspace_id: "w1", tab_id: "w1:t1" } } }), stderr: "", code: 0, killed: false }
			: { stdout: "", stderr: "rename denied", code: 1, killed: false });
		await expect(herdrTerminalHost.startAgentPane({ exec } as never, {
			name: "worker",
			cwd: "/repo",
			shellCommand: "run child",
			placement: { kind: "workspace", workspaceId: "w1" },
		})).resolves.toMatchObject({ ok: true, paneId: "w1:p7" });
	});

	it("sends pane text through pane run", async () => {
		const fake = pi("");
		await expect(herdrTerminalHost.sendPaneText(fake as never, { host: "herdr", paneId: "w1:p2" }, "continue with tests")).resolves.toEqual({ ok: true });
		expect(fake.exec).toHaveBeenCalledWith("herdr", ["pane", "run", "w1:p2", "continue with tests"], { timeout: 5000 });
	});

	it("reports malformed json", async () => {
		const fake = pi("not-json");
		const result = await herdrTerminalHost.openCommandInSplit(fake as never, "down", { cwd: "/tmp", shellCommand: "echo ok" });
		expect(result.ok).toBe(false);
	});
	it("creates a native worktree workspace, finds its pane, and runs the command", async () => {
		const exec = vi.fn(async (_bin: string, args: string[]) => {
			if (args[0] === "worktree" && args[1] === "create") {
				return { stdout: JSON.stringify({ result: { workspace: { workspace_id: "wA" }, root_pane: { pane_id: "wA:p1", workspace_id: "wA" } } }), stderr: "", code: 0, killed: false };
			}
			if (args[0] === "pane" && args[1] === "list") {
				return { stdout: JSON.stringify({ result: { panes: [{ pane_id: "wA:p1", workspace_id: "wA" }] } }), stderr: "", code: 0, killed: false };
			}
			return { stdout: JSON.stringify({ result: { type: "ok" } }), stderr: "", code: 0, killed: false };
		});

		const result = await herdrTerminalHost.openWorktreeWorkspace?.({ exec } as never, {
			sourceCwd: "/repo",
			branch: "sumo/task",
			baseRef: "origin/main",
			path: "/repo.wt/sumo__task",
			label: "sumo · task",
			shellCommand: "exec sumocode",
		});

		expect(result).toEqual({ ok: true, pane: { host: "herdr", paneId: "wA:p1", workspaceId: "wA" } });
		expect(exec).toHaveBeenCalledWith("herdr", ["worktree", "create", "--cwd", "/repo", "--branch", "sumo/task", "--base", "origin/main", "--path", "/repo.wt/sumo__task", "--label", "sumo · task", "--focus", "--json"], { timeout: 5000 });
		expect(exec).toHaveBeenCalledWith("herdr", ["pane", "list", "--workspace", "wA"], { timeout: 5000 });
		expect(exec).toHaveBeenCalledWith("herdr", ["pane", "run", "wA:p1", "exec sumocode"], { timeout: 5000 });
	});
	it("opens an existing native worktree workspace", async () => {
		const exec = vi.fn(async (_bin: string, args: string[]) => {
			if (args[0] === "worktree" && args[1] === "open") {
				return { stdout: JSON.stringify({ result: { workspace: { workspace_id: "wB" } } }), stderr: "", code: 0, killed: false };
			}
			if (args[0] === "pane" && args[1] === "list") {
				return { stdout: JSON.stringify({ result: { panes: [{ pane_id: "wB:p1", workspace_id: "wB" }] } }), stderr: "", code: 0, killed: false };
			}
			return { stdout: "", stderr: "", code: 0, killed: false };
		});

		const result = await herdrTerminalHost.openExistingWorktreeWorkspace?.({ exec } as never, { path: "/repo.wt/sumo__task", label: "sumo · task", shellCommand: "exec sumocode", sourceCwd: "/repo" });

		expect(result).toEqual({ ok: true, pane: { host: "herdr", paneId: "wB:p1", workspaceId: "wB" } });
		expect(exec).toHaveBeenCalledWith("herdr", ["worktree", "open", "--cwd", "/repo", "--path", "/repo.wt/sumo__task", "--label", "sumo · task", "--focus", "--json"], { timeout: 5000 });
	});

	it("passes --no-focus to worktree open when focus is explicitly disabled (visible subagents)", async () => {
		const exec = vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ result: { workspace_id: "w9", pane_id: "w9:p1" } }), stderr: "" }));
		await herdrTerminalHost.openExistingWorktreeWorkspace!({ exec } as never, { path: "/repo.wt/sumo__task", label: "sumo · task", sourceCwd: "/repo", focus: false });
		expect(exec).toHaveBeenCalledWith("herdr", ["worktree", "open", "--cwd", "/repo", "--path", "/repo.wt/sumo__task", "--label", "sumo · task", "--no-focus", "--json"], { timeout: 5000 });
	});
	it("reports native worktree errors when workspace or panes are missing", async () => {
		const noWorkspace = pi(JSON.stringify({ result: { type: "worktree_created" } }));
		await expect(herdrTerminalHost.openWorktreeWorkspace?.(noWorkspace as never, { branch: "sumo/task", baseRef: "HEAD", path: "/repo.wt/sumo__task", label: "sumo · task", shellCommand: "exec sumocode", sourceCwd: "/repo" })).resolves.toEqual({ ok: false, error: "herdr worktree create did not return a workspace_id" });

		const exec = vi.fn(async (_bin: string, args: string[]) => {
			if (args[0] === "worktree") return { stdout: JSON.stringify({ result: { workspace: { workspace_id: "wA" } } }), stderr: "", code: 0, killed: false };
			return { stdout: JSON.stringify({ result: { panes: [] } }), stderr: "", code: 0, killed: false };
		});
		const emptyPanes = await herdrTerminalHost.openWorktreeWorkspace?.({ exec } as never, { branch: "sumo/task", baseRef: "HEAD", path: "/repo.wt/sumo__task", label: "sumo · task", shellCommand: "exec sumocode", sourceCwd: "/repo" });
		expect(emptyPanes).toEqual({ ok: false, error: "herdr pane list returned no panes for workspace wA" });
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

	it("generates a unique agent name per spawn (no agent_name_taken collision)", () => {
		const a = uniqueHerdrAgentName();
		const b = uniqueHerdrAgentName();
		expect(a).toMatch(/^sumocode-/);
		expect(b).toMatch(/^sumocode-/);
		expect(a).not.toBe(b);
	});
});
