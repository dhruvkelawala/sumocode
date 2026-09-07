import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPaneChildSpawner } from "../../src/subagents/backend-pane.js";
import type { SpawnedChild } from "../../src/subagents/backend-pi.js";
import { SubagentManager } from "../../src/subagents/manager.js";
import { BUILT_IN_ROLES } from "../../src/subagents/roles.js";
import { registerSubagentTools } from "../../src/subagents/tools.js";
import { herdrTerminalHost } from "../../src/terminal-host/herdr.js";

interface ExecResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
	readonly killed: boolean;
}

interface PaneInfo {
	readonly pane_id: string;
	readonly tab_id: string;
	readonly workspace_id: string;
}

interface ToolResult {
	readonly content: Array<{ readonly text: string }>;
	readonly details?: { readonly subagent?: { readonly id: string } };
}

const ROOT = resolve(import.meta.dirname, "../..");
const LIVE_HERDR = process.env.SUMOCODE_LIVE_HERDR === "1";
const delay = (ms: number): Promise<void> => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await delay(50);
	}
}

function processGroupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
}

function sessionExec(sessionName: string, args: readonly string[], timeout = 5_000): Promise<ExecResult> {
	return new Promise((resolveExec) => {
		execFile("herdr", ["--session", sessionName, ...args], { timeout }, (error, stdout, stderr) => {
			resolveExec({
				stdout,
				stderr,
				code: error ? 1 : 0,
				killed: error?.killed === true,
			});
		});
	});
}

function resultValue<T>(result: ExecResult): T {
	if (result.code !== 0) throw new Error(result.stderr || result.stdout || `herdr exited ${result.code}`);
	// SAFETY: Herdr 0.8 CLI commands return the documented JSON result envelope.
	return (JSON.parse(result.stdout) as { result: T }).result;
}

async function writeFauxProvider(agentDir: string): Promise<void> {
	const extensionsDir = join(agentDir, "extensions");
	await mkdir(extensionsDir, { recursive: true });
	const fauxProviderUrl = new URL("./providers/faux.js", import.meta.resolve("@earendil-works/pi-ai")).href;
	await writeFile(join(extensionsDir, "issue470-provider.ts"), `
import { createFauxCore, fauxAssistantMessage } from ${JSON.stringify(fauxProviderUrl)};
const provider = "issue470-live";
const modelId = "implement-cheap";
const api = "issue470-live-api";
export default function install(pi) {
  const model = { id: modelId, name: "Issue 470 live fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
  const core = createFauxCore({ provider, api, tokensPerSecond: 1000, models: [model] });
  core.setResponses([fauxAssistantMessage("issue470 live child complete", { stopReason: "stop" })]);
  pi.registerProvider(provider, { name: "Issue 470 Live", baseUrl: "http://localhost:0", apiKey: "fixture", api, streamSimple: core.streamSimple, models: [model] });
}
`, "utf8");
	await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ defaultProjectTrust: "always" })}\n`, "utf8");
}

async function paneList(sessionName: string, workspaceId: string): Promise<PaneInfo[]> {
	return resultValue<{ panes: PaneInfo[] }>(await sessionExec(sessionName, ["pane", "list", "--workspace", workspaceId])).panes;
}

async function waitForOnlyParentPane(sessionName: string, workspaceId: string, parentPaneId: string, label: string): Promise<PaneInfo[]> {
	return waitFor(async () => {
		const panes = await paneList(sessionName, workspaceId);
		return panes.length === 1 && panes[0]?.pane_id === parentPaneId ? panes : undefined;
	}, 10_000, label);
}

async function processGroupForPane(sessionName: string, paneId: string): Promise<number | undefined> {
	const result = await sessionExec(sessionName, ["pane", "process-info", "--pane", paneId]);
	if (result.code !== 0) return undefined;
	const parsed = resultValue<{ process_info?: { foreground_process_group_id?: number } }>(result);
	return parsed.process_info?.foreground_process_group_id;
}

async function waitForTaskResponse(baseDir: string, id: string): Promise<string> {
	return waitFor(async () => {
		try {
			const entry = (await readdir(baseDir)).find((candidate) => candidate.startsWith(`${id}-`));
			if (!entry) return undefined;
			const response = await readFile(join(baseDir, entry, "response.md"), "utf8");
			return response.includes("issue470 live child complete") ? response : undefined;
		} catch {
			return undefined;
		}
	}, 20_000, `${id} real Pi response`);
}

async function waitForDiagnosticCount(path: string, event: string, count: number): Promise<void> {
	await waitFor(async () => {
		try {
			const matches = (await readFile(path, "utf8")).split("\n").filter((line) => line.includes(`"event":"${event}"`));
			return matches.length >= count ? true : undefined;
		} catch {
			return undefined;
		}
	}, 20_000, `${count} ${event} diagnostics`);
}

let ownedServer: ChildProcess | undefined;
let ownedSession: string | undefined;
let tempRoot: string | undefined;

async function stopOwnedSession(): Promise<void> {
	if (ownedSession) await sessionExec(ownedSession, ["session", "stop", ownedSession, "--json"], 5_000);
	if (ownedServer?.pid) {
		await waitFor(async () => ownedServer?.exitCode !== null ? true : undefined, 5_000, "owned Herdr server exit").catch(() => undefined);
		if (ownedServer.exitCode === null) {
			try { process.kill(-ownedServer.pid, "SIGKILL"); } catch { /* already stopped */ }
		}
	}
	ownedServer = undefined;
	ownedSession = undefined;
}

afterEach(async () => {
	await stopOwnedSession();
	if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
	tempRoot = undefined;
});

describe.skipIf(!LIVE_HERDR)("live Herdr visible pane reclamation", () => {
	it("starts real implement-cheap Pi children after explicit and automatic close", async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "sumocode-issue470-live-"));
		const agentDir = join(tempRoot, "agent");
		const taskDir = join(tempRoot, "tasks");
		const rpcDiagnostics = join(tempRoot, "rpc-diagnostics.jsonl");
		await writeFauxProvider(agentDir);
		ownedSession = `sumocode-issue470-${process.pid}-${randomUUID().slice(0, 8)}`;
		const sessionName = ownedSession;
		ownedServer = spawn("herdr", ["--session", sessionName, "server"], {
			cwd: ROOT,
			detached: true,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				PI_OFFLINE: "1",
				SUMO_TUI_DIAG_FILE: rpcDiagnostics,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (!ownedServer.pid) throw new Error("owned Herdr server did not publish a pid");
		let serverStderr = "";
		ownedServer.stderr?.on("data", (chunk: Buffer) => { serverStderr += chunk.toString("utf8"); });
		await waitFor(async () => {
			const listed = await sessionExec(sessionName, ["workspace", "list"], 1_000);
			return listed.code === 0 ? true : undefined;
		}, 10_000, `Herdr server ${sessionName}`).catch((error) => {
			throw new Error(`${String(error)}; server stderr=${serverStderr}`);
		});

		const created = resultValue<{ workspace: { workspace_id: string }; tab: { tab_id: string }; root_pane: PaneInfo }>(await sessionExec(sessionName, [
			"workspace", "create", "--cwd", ROOT, "--label", "issue470 live", "--no-focus",
		]));
		const workspaceId = created.workspace.workspace_id;
		const parentPaneId = created.root_pane.pane_id;
		const before = await paneList(sessionName, workspaceId);
		process.stdout.write(`[issue470 live] before panes: ${before.map((pane) => pane.pane_id).join(", ")}\n`);

		const exec = async (_command: string, args: string[], options?: { timeout?: number }): Promise<ExecResult> => sessionExec(sessionName, args, options?.timeout);
		const spawnPane = createPaneChildSpawner({
			baseDir: taskDir,
			pollIntervalMs: 100,
			env: {
				SUMOCODE_LAUNCHER: resolve(ROOT, "bin/sumocode.sh"),
				PI_BIN: resolve(ROOT, "node_modules/.bin/pi"),
			},
		});
		const manager = new SubagentManager((task): SpawnedChild => {
			if (!task.placement) throw new Error("live visible child has no pane placement");
			return spawnPane({
				...task,
				name: task.title,
				host: herdrTerminalHost,
				// SAFETY: this adapter implements the pi.exec surface through the owned named Herdr session.
				pi: { exec } as never,
				placement: task.placement,
			});
		}, {
			captureGitContext: async () => ({ repoRoot: ROOT, baseRef: "HEAD" }),
			buildCompletionManifest: async (options) => ({ exit: options.outcome.kind, durationMs: 1 }),
			terminalHost: herdrTerminalHost,
			// SAFETY: this adapter implements the pi.exec surface through the owned named Herdr session.
			pi: { exec } as never,
			initialVisibleTabId: created.tab.tab_id,
		});
		const registered: Array<{ name: string; execute: (...args: unknown[]) => Promise<ToolResult> }> = [];
		const pi = {
			exec,
			registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<ToolResult> }) => registered.push(tool),
			getActiveTools: () => ["read", "bash"],
			getThinkingLevel: () => "medium",
		};
		// SAFETY: the integration adapter implements every ExtensionAPI member registerSubagentTools uses.
		registerSubagentTools(pi as never, manager, undefined, herdrTerminalHost, () => ({ roles: BUILT_IN_ROLES, warnings: [] }));
		const spawnTool = registered.find((tool) => tool.name === "subagent_spawn")!;
		const closeTool = registered.find((tool) => tool.name === "subagent_close")!;
		const ctx = { cwd: ROOT, model: { provider: "issue470-live", id: "implement-cheap" } };
		const childPgids: number[] = [];
		const childPaneIds: string[] = [];
		const childPgid = (index: number): number => {
			const pgid = childPgids[index];
			if (pgid === undefined) throw new Error(`child ${index + 1} did not publish a process group`);
			return pgid;
		};

		const spawnChild = async (sequence: number): Promise<string> => {
			const result = await spawnTool.execute(`spawn-${sequence}`, {
				prompt: `complete live issue470 fixture ${sequence}`,
				name: `issue470 child ${sequence}`,
				role: "implement-cheap",
				visible: true,
				worktree: false,
				model: "issue470-live/implement-cheap",
			}, undefined, undefined, ctx);
			expect(result.content[0]?.text).toContain(`Started sa-${sequence}`);
			const id = result.details?.subagent?.id;
			if (!id) throw new Error(`spawn ${sequence} did not return a subagent id`);
			const paneId = await waitFor(async () => manager.get(id)?.pane?.paneId, 10_000, `${id} pane attachment`);
			const pgid = await waitFor(() => processGroupForPane(sessionName, paneId), 10_000, `${id} process group`);
			childPaneIds.push(paneId);
			childPgids.push(pgid);
			await waitForDiagnosticCount(rpcDiagnostics, "app_ready", sequence);
			await waitForTaskResponse(taskDir, id);
			return id;
		};

		const first = await spawnChild(1);
		const duringFirst = await paneList(sessionName, workspaceId);
		process.stdout.write(`[issue470 live] first spawn panes: ${duringFirst.map((pane) => pane.pane_id).join(", ")}\n`);
		await closeTool.execute("close-1", { ids: [first] });
		await waitFor(async () => manager.get(first)?.status === "done" ? true : undefined, 20_000, `${first} explicit close`);
		await waitFor(async () => !processGroupAlive(childPgid(0)) ? true : undefined, 10_000, `${first} process-group exit`);
		const afterExplicitClose = await waitForOnlyParentPane(sessionName, workspaceId, parentPaneId, `${first} pane reclamation`);
		process.stdout.write(`[issue470 live] after explicit close panes: ${afterExplicitClose.map((pane) => pane.pane_id).join(", ")}\n`);

		const second = await spawnChild(2);
		const duringSecond = await paneList(sessionName, workspaceId);
		process.stdout.write(`[issue470 live] respawn panes: ${duringSecond.map((pane) => pane.pane_id).join(", ")}\n`);
		await waitFor(async () => manager.get(second)?.status === "done" ? true : undefined, 40_000, `${second} automatic close`);
		await waitFor(async () => !processGroupAlive(childPgid(1)) ? true : undefined, 10_000, `${second} process-group exit`);
		const afterAutomaticClose = await waitForOnlyParentPane(sessionName, workspaceId, parentPaneId, `${second} automatic pane reclamation`);
		process.stdout.write(`[issue470 live] after automatic close panes: ${afterAutomaticClose.map((pane) => pane.pane_id).join(", ")}\n`);

		const third = await spawnChild(3);
		await closeTool.execute("close-3", { ids: [third] });
		await waitFor(async () => manager.get(third)?.status === "done" ? true : undefined, 20_000, `${third} close`);
		await waitFor(async () => !processGroupAlive(childPgid(2)) ? true : undefined, 10_000, `${third} process-group exit`);

		const after = await paneList(sessionName, workspaceId);
		process.stdout.write(`[issue470 live] after panes: ${after.map((pane) => pane.pane_id).join(", ")}\n`);
		expect(before.map((pane) => pane.pane_id)).toEqual([parentPaneId]);
		expect(after.map((pane) => pane.pane_id)).toEqual([parentPaneId]);
		expect(new Set(childPaneIds).size).toBe(3);
		expect(childPgids.every((pgid) => !processGroupAlive(pgid))).toBe(true);
		const diagnostics = await readFile(rpcDiagnostics, "utf8");
		expect((diagnostics.match(/"event":"app_ready"/g) ?? []).length).toBeGreaterThanOrEqual(3);
		expect(diagnostics).not.toContain("Timed out waiting for get_state response");

		const serverPgid = ownedServer.pid;
		await stopOwnedSession();
		await waitFor(async () => !processGroupAlive(serverPgid) ? true : undefined, 5_000, "owned Herdr server process-group exit");
	}, 120_000);
});
