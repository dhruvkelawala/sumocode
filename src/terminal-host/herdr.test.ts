import { afterEach, describe, expect, it, vi } from "vitest";
import { herdrTerminalHost, uniqueHerdrAgentName } from "./herdr.js";

function pi(stdout: string, code = 0) {
	return { exec: vi.fn(async () => ({ stdout, stderr: "", code, killed: false })) };
}

describe("herdrTerminalHost", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		delete process.env.HERDR_ENV;
		delete process.env.HERDR_PANE_ID;
	});
	it("splits from the caller pane and runs the command with Herdr 0.8 pane primitives", async () => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "w7:p3";
		const exec = vi.fn(async (_bin: string, args: string[]) => args[1] === "split"
			? { stdout: JSON.stringify({ result: { pane: { pane_id: "w7:p9", workspace_id: "w7", tab_id: "w7:t2" } } }), stderr: "", code: 0, killed: false }
			: { stdout: JSON.stringify({ result: { type: "ok" } }), stderr: "", code: 0, killed: false });
		// SAFETY: test double only exercises the members this test asserts on.
		const result = await herdrTerminalHost.openCommandInSplit({ exec } as never, "right", { cwd: "/tmp", shellCommand: "echo ok" });
		expect(result).toEqual({ ok: true, pane: { host: "herdr", paneId: "w7:p9", workspaceId: "w7" } });
		expect(exec).toHaveBeenNthCalledWith(1, "herdr", ["pane", "split", "--current", "--direction", "right", "--cwd", "/tmp", "--no-focus"], { timeout: 5000 });
		expect(exec).toHaveBeenNthCalledWith(2, "herdr", ["pane", "run", "w7:p9", "echo ok"], { timeout: 5000 });
	});
	it("creates a command tab when no caller pane is available", async () => {
		delete process.env.HERDR_PANE_ID;
		const exec = vi.fn(async (_bin: string, args: string[]) => args[0] === "tab"
			? { stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t2" } } }), stderr: "", code: 0, killed: false }
			: { stdout: JSON.stringify({ result: { type: "ok" } }), stderr: "", code: 0, killed: false });
		// SAFETY: test double only exercises the members this test asserts on.
		const result = await herdrTerminalHost.openCommandInSplit({ exec } as never, "down", { cwd: "/tmp", shellCommand: "echo ok" });
		expect(result).toEqual({ ok: true, pane: { host: "herdr", paneId: "w1:p2", workspaceId: "w1" } });
		expect(exec).toHaveBeenNthCalledWith(1, "herdr", ["tab", "create", "--cwd", "/tmp", "--label", "sumocode", "--no-focus"], { timeout: 5000 });
		expect(exec).toHaveBeenNthCalledWith(2, "herdr", ["pane", "run", "w1:p2", "echo ok"], { timeout: 5000 });
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
			// SAFETY: test double only exercises the members this test asserts on.
			herdrTerminalHost.openWorktreeWorkspace?.({ exec } as never, { branch: "sumo/x", baseRef: "HEAD", path: "/repo.wt/sumo__x", label: "sumo · x", shellCommand: "exec sumocode", sourceCwd: "/repo" }),
		).resolves.toEqual({ ok: true, pane: { host: "herdr", paneId: "wC:p1", workspaceId: "wC" } });
	});

	it("reports malformed split JSON", async () => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "w1:p1";
		const fake = pi("not-json");
		// SAFETY: test double only exercises the members this test asserts on.
		const result = await herdrTerminalHost.openCommandInSplit(fake as never, "right", { cwd: "/tmp", shellCommand: "echo ok" });
		expect(result.ok).toBe(false);
	});
	it("keeps the worktree bootstrap shell while running the child in a split", async () => {
		const exec = vi.fn(async (_bin: string, args: string[]) => args[1] === "split"
			? { stdout: JSON.stringify({ result: { pane: { pane_id: "w9:p2", workspace_id: "w9", tab_id: "w9:t1" } } }), stderr: "", code: 0, killed: false }
			: { stdout: JSON.stringify({ result: { type: "ok" } }), stderr: "", code: 0, killed: false });
		// SAFETY: test double only exercises the members this test asserts on.
		const result = await herdrTerminalHost.startAgentPane({ exec } as never, {
			name: "API Worker",
			cwd: "/repo/packages/api",
			shellCommand: "exec sumocode task",
			placement: { kind: "workspace", workspaceId: "w9", paneId: "w9:p1" },
		});
		expect(result).toMatchObject({ ok: true, agentName: expect.stringMatching(/^api-worker-/), workspaceId: "w9", tabId: "w9:t1", paneId: "w9:p2" });
		expect(exec).toHaveBeenNthCalledWith(1, "herdr", ["pane", "split", "w9:p1", "--direction", "right", "--cwd", "/repo/packages/api", "--no-focus"], { timeout: 5000 });
		expect(exec).toHaveBeenNthCalledWith(2, "herdr", ["pane", "move", "w9:p1", "--new-tab", "--workspace", "w9", "--label", "shell", "--no-focus"], { timeout: 5000 });
		expect(exec).toHaveBeenNthCalledWith(3, "herdr", ["pane", "run", "w9:p2", "exec sumocode task"], { timeout: 5000 });
	});

	it("keeps the child when moving the bootstrap shell fails", async () => {
		const exec = vi.fn(async (_bin: string, args: string[]) => {
			if (args[1] === "split") return { stdout: JSON.stringify({ result: { pane: { pane_id: "w9:p2", workspace_id: "w9", tab_id: "w9:t1" } } }), stderr: "", code: 0, killed: false };
			if (args[1] === "move") return { stdout: "", stderr: "move denied", code: 1, killed: false };
			return { stdout: JSON.stringify({ result: { type: "ok" } }), stderr: "", code: 0, killed: false };
		});
		// SAFETY: test double only exercises the members this test asserts on.
		await expect(herdrTerminalHost.startAgentPane({ exec } as never, {
			name: "worker", cwd: "/repo", shellCommand: "run child", placement: { kind: "workspace", workspaceId: "w9", paneId: "w9:p1" },
		})).resolves.toMatchObject({ ok: true, paneId: "w9:p2" });
		expect(exec).toHaveBeenCalledWith("herdr", ["pane", "run", "w9:p2", "run child"], { timeout: 5000 });
	});

	it("finds and preserves an available workspace pane when no pane id is supplied", async () => {
		const exec = vi.fn(async (_bin: string, args: string[]) => {
			if (args[1] === "list") return { stdout: JSON.stringify({ result: { panes: [{ pane_id: "w9:p1", workspace_id: "w9", tab_id: "w9:t1" }] } }), stderr: "", code: 0, killed: false };
			if (args[1] === "split") return { stdout: JSON.stringify({ result: { pane: { pane_id: "w9:p2", workspace_id: "w9", tab_id: "w9:t1" } } }), stderr: "", code: 0, killed: false };
			return { stdout: JSON.stringify({ result: { type: "ok" } }), stderr: "", code: 0, killed: false };
		});
		// SAFETY: test double only exercises the members this test asserts on.
		const result = await herdrTerminalHost.startAgentPane({ exec } as never, {
			name: "API Worker",
			cwd: "/repo/packages/api",
			shellCommand: "exec sumocode task",
			placement: { kind: "workspace", workspaceId: "w9" },
		});
		expect(result).toMatchObject({ ok: true, workspaceId: "w9", tabId: "w9:t1", paneId: "w9:p2" });
		expect(exec).toHaveBeenNthCalledWith(1, "herdr", ["pane", "list", "--workspace", "w9"], { timeout: 5000 });
		expect(exec).toHaveBeenNthCalledWith(3, "herdr", ["pane", "move", "w9:p1", "--new-tab", "--workspace", "w9", "--label", "shell", "--no-focus"], { timeout: 5000 });
	});

	it("splits an existing subagents tab before running the child", async () => {
		const exec = vi.fn(async (_bin: string, args: string[]) => {
			if (args[1] === "list") return { stdout: JSON.stringify({ result: { panes: [{ pane_id: "w3:p2", workspace_id: "w3", tab_id: "w3:t2" }] } }), stderr: "", code: 0, killed: false };
			if (args[1] === "split") return { stdout: JSON.stringify({ result: { pane: { pane_id: "w3:p4", workspace_id: "w3", tab_id: "w3:t2" } } }), stderr: "", code: 0, killed: false };
			return { stdout: JSON.stringify({ result: { type: "ok" } }), stderr: "", code: 0, killed: false };
		});
		// SAFETY: test double only exercises the members this test asserts on.
		await expect(herdrTerminalHost.startAgentPane({ exec } as never, {
			name: "review",
			cwd: "/repo",
			shellCommand: "run child",
			placement: { kind: "tab", tabId: "w3:t2", direction: "down" },
		})).resolves.toMatchObject({ ok: true, tabId: "w3:t2", paneId: "w3:p4" });
		expect(exec).toHaveBeenNthCalledWith(2, "herdr", ["pane", "split", "w3:p2", "--direction", "down", "--cwd", "/repo", "--no-focus"], { timeout: 5000 });
		expect(exec).toHaveBeenNthCalledWith(3, "herdr", ["pane", "run", "w3:p4", "run child"], { timeout: 5000 });
	});

	it("creates a no-focus tab with a root pane for the first child", async () => {
		vi.stubEnv("HERDR_PANE_ID", "");
		const exec = vi.fn(async (_bin: string, args: string[]) => args[0] === "tab"
			? { stdout: JSON.stringify({ result: { root_pane: { pane_id: "w5:p9", workspace_id: "w5", tab_id: "w5:t8" } } }), stderr: "", code: 0, killed: false }
			: { stdout: JSON.stringify({ result: { type: "ok" } }), stderr: "", code: 0, killed: false });
		// SAFETY: test double only exercises the members this test asserts on.
		await expect(herdrTerminalHost.startAgentPane({ exec } as never, {
			name: "research",
			cwd: "/repo",
			shellCommand: "run child",
			placement: { kind: "new-tab", label: "subagents" },
		})).resolves.toMatchObject({ ok: true, tabId: "w5:t8", paneId: "w5:p9" });
		expect(exec).toHaveBeenNthCalledWith(1, "herdr", ["tab", "create", "--cwd", "/repo", "--label", "subagents", "--no-focus"], { timeout: 5000 });
		expect(exec).toHaveBeenNthCalledWith(2, "herdr", ["pane", "run", "w5:p9", "run child"], { timeout: 5000 });
		vi.unstubAllEnvs();
	});

	it("anchors a new subagents tab to Herdr's calling pane workspace", async () => {
		vi.stubEnv("HERDR_ENV", "1");
		vi.stubEnv("HERDR_PANE_ID", "w1K:pB");
		const exec = vi.fn(async (_bin: string, args: string[]) => {
			if (args[0] === "pane" && args[1] === "current") {
				return { stdout: JSON.stringify({ result: { pane: { pane_id: "w1K:pB", workspace_id: "w1K", tab_id: "w1K:t1" } } }), stderr: "", code: 0, killed: false };
			}
			if (args[0] === "tab") {
				return { stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1K:p9", workspace_id: "w1K", tab_id: "w1K:t3" } } }), stderr: "", code: 0, killed: false };
			}
			return { stdout: JSON.stringify({ result: { type: "ok" } }), stderr: "", code: 0, killed: false };
		});
		// SAFETY: test double only exercises the members this test asserts on.
		await herdrTerminalHost.startAgentPane!({ exec } as never, {
			name: "research", cwd: "/repo", shellCommand: "run child", placement: { kind: "new-tab", label: "subagents" },
		});
		expect(exec).toHaveBeenNthCalledWith(1, "herdr", ["pane", "current", "--current"], { timeout: 5000 });
		expect(exec).toHaveBeenNthCalledWith(2, "herdr", ["tab", "create", "--workspace", "w1K", "--cwd", "/repo", "--label", "subagents", "--no-focus"], { timeout: 5000 });
	});

	it("keeps a running child when pane rename fails", async () => {
		const exec = vi.fn(async (_bin: string, args: string[]) => {
			if (args[1] === "list") return { stdout: JSON.stringify({ result: { panes: [{ pane_id: "w1:p6", workspace_id: "w1", tab_id: "w1:t1" }] } }), stderr: "", code: 0, killed: false };
			if (args[1] === "split") return { stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p7", workspace_id: "w1", tab_id: "w1:t1" } } }), stderr: "", code: 0, killed: false };
			return { stdout: "", stderr: args[1] === "rename" ? "rename denied" : "", code: args[1] === "rename" ? 1 : 0, killed: false };
		});
		// SAFETY: test double only exercises the members this test asserts on.
		await expect(herdrTerminalHost.startAgentPane({ exec } as never, {
			name: "worker", cwd: "/repo", shellCommand: "run child", placement: { kind: "workspace", workspaceId: "w1" },
		})).resolves.toMatchObject({ ok: true, paneId: "w1:p7" });
	});

	it("sends pane text through Herdr's agent prompt primitive", async () => {
		const fake = pi("");
		// SAFETY: test double only exercises the members this test asserts on.
		await expect(herdrTerminalHost.sendPaneText(fake as never, { host: "herdr", paneId: "w1:p2" }, "continue with tests")).resolves.toEqual({ ok: true });
		expect(fake.exec).toHaveBeenCalledWith("herdr", ["agent", "prompt", "w1:p2", "continue with tests"], { timeout: 10000 });
	});

	it("treats a stalled Herdr prompt as delivered", async () => {
		const exec = vi.fn(async () => ({
			stdout: "",
			stderr: JSON.stringify({ error: { code: "agent_prompt_stalled", message: "agent prompt produced no observed state change" } }),
			code: 1,
			killed: false,
		}));
		// SAFETY: test double only exercises the members this test asserts on.
		await expect(herdrTerminalHost.sendPaneText({ exec } as never, { host: "herdr", paneId: "w1:p2" }, "continue with tests")).resolves.toEqual({ ok: true });
		expect(exec).toHaveBeenCalledTimes(1);
		expect(exec).toHaveBeenCalledWith("herdr", ["agent", "prompt", "w1:p2", "continue with tests"], { timeout: 10000 });
	});

	it("does not fall back to raw pane input when Herdr reports a blocked agent", async () => {
		const exec = vi.fn(async () => ({
			stdout: "",
			stderr: JSON.stringify({ error: { code: "agent_blocked", message: "agent is waiting for approval" } }),
			code: 1,
			killed: false,
		}));
		// SAFETY: test double only exercises the members this test asserts on.
		await expect(herdrTerminalHost.sendPaneText({ exec } as never, { host: "herdr", paneId: "w1:p2" }, "continue with tests")).resolves.toEqual({ ok: false, error: "agent is waiting for approval" });
		expect(exec).toHaveBeenCalledTimes(1);
		expect(exec).toHaveBeenCalledWith("herdr", ["agent", "prompt", "w1:p2", "continue with tests"], { timeout: 10000 });
	});

	it("does not fall back to raw pane input when Herdr does not recognize an agent", async () => {
		const exec = vi.fn(async () => ({
			stdout: "",
			stderr: JSON.stringify({ error: { code: "agent_not_found", message: "agent target w1:p2 not found" } }),
			code: 1,
			killed: false,
		}));
		// SAFETY: test double only exercises the members this test asserts on.
		await expect(herdrTerminalHost.sendPaneText({ exec } as never, { host: "herdr", paneId: "w1:p2" }, "continue with tests")).resolves.toEqual({ ok: false, error: "agent target w1:p2 not found" });
		expect(exec).toHaveBeenCalledTimes(1);
		expect(exec).toHaveBeenCalledWith("herdr", ["agent", "prompt", "w1:p2", "continue with tests"], { timeout: 10000 });
	});

	it("reports malformed json", async () => {
		const fake = pi("not-json");
		// SAFETY: test double only exercises the members this test asserts on.
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

		// SAFETY: test double only exercises the members this test asserts on.
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

		// SAFETY: test double only exercises the members this test asserts on.
		const result = await herdrTerminalHost.openExistingWorktreeWorkspace?.({ exec } as never, { path: "/repo.wt/sumo__task", label: "sumo · task", shellCommand: "exec sumocode", sourceCwd: "/repo" });

		expect(result).toEqual({ ok: true, pane: { host: "herdr", paneId: "wB:p1", workspaceId: "wB" } });
		expect(exec).toHaveBeenCalledWith("herdr", ["worktree", "open", "--cwd", "/repo", "--path", "/repo.wt/sumo__task", "--label", "sumo · task", "--focus", "--json"], { timeout: 5000 });
	});

	it("passes --no-focus to worktree open when focus is explicitly disabled (visible subagents)", async () => {
		const exec = vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ result: { workspace_id: "w9", pane_id: "w9:p1" } }), stderr: "" }));
		// SAFETY: test double only exercises the members this test asserts on.
		await herdrTerminalHost.openExistingWorktreeWorkspace!({ exec } as never, { path: "/repo.wt/sumo__task", label: "sumo · task", sourceCwd: "/repo", focus: false });
		expect(exec).toHaveBeenCalledWith("herdr", ["worktree", "open", "--cwd", "/repo", "--path", "/repo.wt/sumo__task", "--label", "sumo · task", "--no-focus", "--json"], { timeout: 5000 });
	});
	it("reports native worktree errors when workspace or panes are missing", async () => {
		const noWorkspace = pi(JSON.stringify({ result: { type: "worktree_created" } }));
		// SAFETY: test double only exercises the members this test asserts on.
		await expect(herdrTerminalHost.openWorktreeWorkspace?.(noWorkspace as never, { branch: "sumo/task", baseRef: "HEAD", path: "/repo.wt/sumo__task", label: "sumo · task", shellCommand: "exec sumocode", sourceCwd: "/repo" })).resolves.toEqual({ ok: false, error: "herdr worktree create did not return a workspace_id" });

		const exec = vi.fn(async (_bin: string, args: string[]) => {
			if (args[0] === "worktree") return { stdout: JSON.stringify({ result: { workspace: { workspace_id: "wA" } } }), stderr: "", code: 0, killed: false };
			return { stdout: JSON.stringify({ result: { panes: [] } }), stderr: "", code: 0, killed: false };
		});
		// SAFETY: test double only exercises the members this test asserts on.
		const emptyPanes = await herdrTerminalHost.openWorktreeWorkspace?.({ exec } as never, { branch: "sumo/task", baseRef: "HEAD", path: "/repo.wt/sumo__task", label: "sumo · task", shellCommand: "exec sumocode", sourceCwd: "/repo" });
		expect(emptyPanes).toEqual({ ok: false, error: "herdr pane list returned no panes for workspace wA" });
	});
	it("closes and notifies", async () => {
		const fake = pi(JSON.stringify({ result: { type: "ok" } }));
		// SAFETY: test double only exercises the members this test asserts on.
		await herdrTerminalHost.closePane(fake as never, { host: "herdr", paneId: "w1:p2" });
		// SAFETY: test double only exercises the members this test asserts on.
		await herdrTerminalHost.notify(fake as never, "title", "body");
		expect(fake.exec).toHaveBeenCalledWith("herdr", ["pane", "close", "w1:p2"], { timeout: 5000 });
		expect(fake.exec).toHaveBeenCalledWith("herdr", ["notification", "show", "title", "--body", "body", "--sound", "done"], { timeout: 5000 });
	});
	it("notify is best-effort when exec rejects", async () => {
		const fake = { exec: vi.fn(async () => { throw new Error("no daemon"); }) };
		// SAFETY: test double only exercises the members this test asserts on.
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
