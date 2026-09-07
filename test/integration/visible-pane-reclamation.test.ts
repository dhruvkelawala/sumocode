import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaneChildSpawner } from "../../src/subagents/backend-pane.js";
import type { SpawnedChild } from "../../src/subagents/backend-pi.js";
import { SubagentManager } from "../../src/subagents/manager.js";
import { BUILT_IN_ROLES } from "../../src/subagents/roles.js";
import { registerSubagentTools } from "../../src/subagents/tools.js";
import { herdrTerminalHost } from "../../src/terminal-host/herdr.js";

interface PaneState {
	readonly paneId: string;
	readonly tabId: string;
	readonly cwd: string;
	child?: ChildProcess;
}

interface ToolResult {
	readonly content: Array<{ readonly type: string; readonly text: string }>;
	readonly details?: { readonly subagent?: { readonly id: string } };
}

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
	}
};

class SupervisedHerdrHarness {
	private nextPane = 1;
	private readonly panes = new Map<string, PaneState>();
	private readonly processGroups = new Set<number>();

	public constructor(private readonly workspaceId = "w1", private readonly parentTabId = "w1:t-parent") {
		this.panes.set("w1:p-parent", { paneId: "w1:p-parent", tabId: parentTabId, cwd: process.cwd() });
	}

	public readonly exec = vi.fn(async (_command: string, args: string[]) => {
		if (args[0] === "pane" && args[1] === "list") {
			return this.result({ panes: [...this.panes.values()].map((pane) => ({ pane_id: pane.paneId, workspace_id: this.workspaceId, tab_id: pane.tabId })) });
		}
		if (args[0] === "pane" && args[1] === "split") {
			const anchor = this.panes.get(args[2]!);
			if (!anchor) return this.failure("pane_not_found", `pane ${args[2]} is unavailable`);
			const paneId = `${this.workspaceId}:p${this.nextPane++}`;
			const cwd = args[args.indexOf("--cwd") + 1] ?? anchor.cwd;
			this.panes.set(paneId, { paneId, tabId: anchor.tabId, cwd });
			return this.result({ pane: { pane_id: paneId, workspace_id: this.workspaceId, tab_id: anchor.tabId } });
		}
		if (args[0] === "pane" && args[1] === "run") {
			const pane = this.panes.get(args[2]!);
			if (!pane) return this.failure("pane_not_found", `pane ${args[2]} is unavailable`);
			const child = spawn("bash", ["-lc", args[3]!], { cwd: pane.cwd, detached: true, stdio: "ignore" });
			pane.child = child;
			if (child.pid !== undefined) this.processGroups.add(child.pid);
			child.once("exit", () => this.panes.delete(pane.paneId));
			return this.result({ type: "ok" });
		}
		if (args[0] === "pane" && args[1] === "rename") return this.result({ type: "ok" });
		if (args[0] === "pane" && args[1] === "close") {
			const pane = this.panes.get(args[2]!);
			if (pane?.child?.pid) {
				try { process.kill(-pane.child.pid, "SIGTERM"); } catch { /* already gone */ }
			}
			this.panes.delete(args[2]!);
			return this.result({ type: "ok" });
		}
		if (args[0] === "agent" && args[1] === "explain") {
			return this.result({ type: "agent_explain", explain: { reason: "no available shell pane" } });
		}
		return this.result({ type: "ok" });
	});

	public liveChildPanes(): PaneState[] {
		return [...this.panes.values()].filter((pane) => pane.child !== undefined);
	}

	public hasLiveProcessGroup(pid: number): boolean {
		try {
			process.kill(-pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	public async auditZeroOrphans(): Promise<void> {
		await waitFor(() => [...this.processGroups].every((pid) => !this.hasLiveProcessGroup(pid)));
	}

	public cleanup(): void {
		for (const pid of this.processGroups) {
			if (!this.hasLiveProcessGroup(pid)) continue;
			try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
		}
	}

	private result<T extends object>(result: T) {
		return { stdout: JSON.stringify({ result }), stderr: "", code: 0, killed: false };
	}

	private failure(code: string, message: string) {
		return { stdout: "", stderr: JSON.stringify({ error: { code, message } }), code: 1, killed: false };
	}
}

describe("supervised visible pane reclamation", () => {
	const roots: string[] = [];
	const harnesses: SupervisedHerdrHarness[] = [];

	afterEach(() => {
		for (const harness of harnesses) harness.cleanup();
		for (const root of roots) rmSync(root, { recursive: true, force: true });
	});

	it("closes and respawns implement-cheap in a live pane with zero orphan process groups", async () => {
		const root = mkdtempSync(join(tmpdir(), "sumocode-visible-reclaim-"));
		roots.push(root);
		const worktree = join(root, "worktree");
		mkdirSync(worktree);
		const launcher = join(root, "sumocode-fixture.sh");
		writeFileSync(launcher, [
			"#!/usr/bin/env bash",
			"set -eu",
			"args=\"$*\"",
			"task_dir=",
			"while [ \"$#\" -gt 0 ]; do",
			"  if [ \"$1\" = \"--task-dir\" ]; then task_dir=$2; shift 2; else shift; fi",
			"done",
			"[ -n \"$task_dir\" ]",
			"printf '%s\\n' \"$args\" > \"$task_dir/launcher.argv\"",
			"printf '%s\\n' \"$$\" > \"$task_dir/started.marker\"",
			"finish() { [ -f \"$task_dir/exit.code\" ] || printf '143\\n' > \"$task_dir/exit.code\"; exit 143; }",
			"trap finish HUP INT TERM",
			"while [ ! -f \"$task_dir/control/close.request\" ]; do sleep 0.02; done",
			"printf 'supervised result\\n' > \"$task_dir/response.md\"",
			"printf '0\\n' > \"$task_dir/exit.code\"",
		].join("\n"));
		chmodSync(launcher, 0o700);

		const herdr = new SupervisedHerdrHarness();
		harnesses.push(herdr);
		const spawnPane = createPaneChildSpawner({
			baseDir: join(root, "tasks"),
			pollIntervalMs: 20,
			env: { SUMOCODE_LAUNCHER: launcher, PI_BIN: "/fixture/pi" },
		});
		const manager = new SubagentManager((task): SpawnedChild => spawnPane({
			...task,
			host: herdrTerminalHost,
			// SAFETY: the harness implements the pi.exec surface used by herdrTerminalHost.
			pi: { exec: herdr.exec } as never,
			placement: task.placement!,
		}), {
			captureGitContext: async () => ({ repoRoot: worktree, baseRef: "base-ref" }),
			createWorktree: async () => ({ ok: true, path: worktree, branch: "fix/cheap", baseRef: "base-ref" }),
			resolveWorktreeBaseRef: async () => "base-ref",
			buildCompletionManifest: async (options) => ({ baseRef: options.baseRef, changedPaths: [], dirty: false, commits: 0, exit: options.outcome.kind, durationMs: 1 }),
			terminalHost: herdrTerminalHost,
			// SAFETY: the harness implements the pi.exec surface used by the manager and pane backend.
			pi: { exec: herdr.exec } as never,
			initialVisibleTabId: "w1:t-parent",
		});
		const registered: Array<{ name: string; execute: (...args: unknown[]) => Promise<ToolResult> }> = [];
		const pi = {
			exec: herdr.exec,
			registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<ToolResult> }) => registered.push(tool),
			getActiveTools: () => ["read", "bash"],
			getThinkingLevel: () => "medium",
		};
		// SAFETY: this integration double implements every ExtensionAPI member registerSubagentTools uses.
		registerSubagentTools(pi as never, manager, undefined, herdrTerminalHost, () => ({ roles: BUILT_IN_ROLES, warnings: [] }));
		const tool = (name: string) => registered.find((candidate) => candidate.name === name)!;
		const ctx = { cwd: worktree, model: { provider: "openai", id: "gpt-5" } };

		const first = await tool("subagent_spawn").execute("spawn-1", { prompt: "first", name: "cheap one", role: "implement-cheap", visible: true }, undefined, undefined, ctx);
		expect(first.content[0].text).toContain("Started sa-1");
		await waitFor(() => herdr.liveChildPanes().length === 1 && manager.get("sa-1")?.pane?.paneId !== undefined);
		const firstPane = manager.get("sa-1")!.pane!.paneId!;
		const firstTaskDir = join(root, "tasks", readdirSync(join(root, "tasks")).find((entry) => entry.startsWith("sa-1-"))!);
		const firstArgsFile = join(firstTaskDir, "launcher.argv");
		await waitFor(() => {
			try { return readFileSync(firstArgsFile, "utf8").includes("--thinking low"); } catch { return false; }
		});

		await tool("subagent_close").execute("close-1", { ids: ["sa-1"] });
		await waitFor(() => herdr.liveChildPanes().length === 0);

		const second = await tool("subagent_spawn").execute("spawn-2", { prompt: "second", name: "cheap two", role: "implement-cheap", visible: true }, undefined, undefined, ctx);
		expect(second.content[0].text).toContain("Started sa-2");
		await waitFor(() => herdr.liveChildPanes().length === 1 && manager.get("sa-2")?.pane?.paneId !== undefined);
		const secondPane = manager.get("sa-2")!.pane!.paneId!;
		expect(secondPane).not.toBe(firstPane);

		await tool("subagent_close").execute("close-2", { ids: ["sa-2"] });
		await waitFor(() => herdr.liveChildPanes().length === 0);
		await herdr.auditZeroOrphans();
	}, 15_000);
});
