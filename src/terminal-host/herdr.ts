import type { HostResult, PaneRef, PiExecLike, SplitDirection, TerminalHost } from "./types.js";

interface HerdrEnvelope { result?: unknown }
interface HerdrAgentResult { agent?: { pane_id?: string; workspace_id?: string } }
interface HerdrPaneInfoResult { pane?: { tab_id?: string } }
interface HerdrWorktreeResult { root_pane?: { pane_id?: string; workspace_id?: string }; workspace?: { workspace_id?: string } }
interface HerdrPaneListResult { panes?: Array<{ pane_id?: string; workspace_id?: string }> }

function parseEnvelope<T>(stdout: string): HostResult<T> {
	try {
		const parsed = JSON.parse(stdout) as HerdrEnvelope;
		return { ok: true, ...(parsed.result as T) };
	} catch {
		return { ok: false, error: `Malformed herdr JSON: ${stdout.trim() || "<empty>"}` };
	}
}

/**
 * Resolve the tab that owns the pane THIS SumoCode process runs in, so new
 * splits are anchored beside the orchestrator instead of wherever herdr's
 * default placement puts them.
 *
 * Without an explicit `--tab`, `herdr agent start` chooses its own placement
 * (observed live: a different workspace entirely — the operator had to hunt
 * for the spawned executor pane). `HERDR_PANE_ID` identifies our pane;
 * `herdr pane get` maps it to its `tab_id`. Best-effort: on any failure we
 * return undefined and fall back to herdr's default placement rather than
 * failing the spawn.
 */
async function resolveCallerTabId(pi: PiExecLike, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const paneId = env.HERDR_PANE_ID;
	if (!paneId) return undefined;
	try {
		const result = await pi.exec("herdr", ["pane", "get", paneId], { timeout: 5000 });
		if (result.code !== 0) return undefined;
		const parsed = parseEnvelope<HerdrPaneInfoResult>(result.stdout);
		if (!parsed.ok) return undefined;
		const tabId = parsed.pane?.tab_id;
		return typeof tabId === "string" && tabId.length > 0 ? tabId : undefined;
	} catch {
		return undefined;
	}
}

function workspaceIdFromWorktreeResult(parsed: HerdrWorktreeResult): string | undefined {
	return parsed.workspace?.workspace_id ?? parsed.root_pane?.workspace_id;
}

async function runInWorktreeWorkspace(
	pi: PiExecLike,
	workspaceId: string,
	shellCommand: string,
): Promise<HostResult<{ pane: PaneRef }>> {
	const panesResult = await pi.exec("herdr", ["pane", "list", "--workspace", workspaceId], { timeout: 5000 });
	if (panesResult.code !== 0) return { ok: false, error: panesResult.stderr || panesResult.stdout || `herdr pane list exited ${panesResult.code}` };
	const panesParsed = parseEnvelope<HerdrPaneListResult>(panesResult.stdout);
	if (!panesParsed.ok) return panesParsed;
	// The list is already scoped by --workspace, so the first pane IS the
	// workspace's pane; matching on per-pane workspace_id would spuriously
	// fail if herdr ever omits that field.
	const paneId = panesParsed.panes?.[0]?.pane_id;
	if (!paneId) return { ok: false, error: `herdr pane list returned no panes for workspace ${workspaceId}` };
	const runResult = await pi.exec("herdr", ["pane", "run", paneId, shellCommand], { timeout: 5000 });
	if (runResult.code !== 0) return { ok: false, error: runResult.stderr || runResult.stdout || `herdr pane run exited ${runResult.code}` };
	return { ok: true, pane: { host: "herdr", paneId, workspaceId } };
}

export const herdrTerminalHost: TerminalHost = {
	kind: "herdr",
	async openCommandInSplit(pi: PiExecLike, direction: SplitDirection, options: { cwd: string; shellCommand: string }) {
		const tabId = await resolveCallerTabId(pi, process.env);
		const tabArgs = tabId ? ["--tab", tabId] : [];
		const result = await pi.exec(
			"herdr",
			["agent", "start", "sumocode-task", "--cwd", options.cwd, ...tabArgs, "--split", direction, "--no-focus", "--", "bash", "-lc", options.shellCommand],
			{ timeout: 5000 },
		);
		if (result.code !== 0) return { ok: false, error: result.stderr || result.stdout || `herdr agent start exited ${result.code}` };
		const parsed = parseEnvelope<HerdrAgentResult>(result.stdout);
		if (!parsed.ok) return parsed;
		const paneId = parsed.agent?.pane_id;
		if (!paneId) return { ok: false, error: "herdr agent start did not return a pane_id" };
		return { ok: true, pane: { host: "herdr", paneId, workspaceId: parsed.agent?.workspace_id } };
	},
	async openWorktreeWorkspace(pi: PiExecLike, options: { branch: string; baseRef: string; path: string; label: string; shellCommand: string }) {
		const result = await pi.exec(
			"herdr",
			["worktree", "create", "--branch", options.branch, "--base", options.baseRef, "--path", options.path, "--label", options.label, "--focus", "--json"],
			{ timeout: 5000 },
		);
		if (result.code !== 0) return { ok: false, error: result.stderr || result.stdout || `herdr worktree create exited ${result.code}` };
		const parsed = parseEnvelope<HerdrWorktreeResult>(result.stdout);
		if (!parsed.ok) return parsed;
		const workspaceId = workspaceIdFromWorktreeResult(parsed);
		if (!workspaceId) return { ok: false, error: "herdr worktree create did not return a workspace_id" };
		return await runInWorktreeWorkspace(pi, workspaceId, options.shellCommand);
	},
	async openExistingWorktreeWorkspace(pi: PiExecLike, options: { path: string; label: string; shellCommand: string }) {
		const result = await pi.exec(
			"herdr",
			["worktree", "open", "--path", options.path, "--label", options.label, "--focus", "--json"],
			{ timeout: 5000 },
		);
		if (result.code !== 0) return { ok: false, error: result.stderr || result.stdout || `herdr worktree open exited ${result.code}` };
		const parsed = parseEnvelope<HerdrWorktreeResult>(result.stdout);
		if (!parsed.ok) return parsed;
		const workspaceId = workspaceIdFromWorktreeResult(parsed);
		if (!workspaceId) return { ok: false, error: "herdr worktree open did not return a workspace_id" };
		return await runInWorktreeWorkspace(pi, workspaceId, options.shellCommand);
	},
	async closePane(pi: PiExecLike, pane: PaneRef) {
		const result = await pi.exec("herdr", ["pane", "close", pane.paneId], { timeout: 5000 });
		if (result.code !== 0) return { ok: false, error: result.stderr || result.stdout || `herdr pane close exited ${result.code}` };
		return { ok: true };
	},
	async notify(pi: PiExecLike, title: string, body: string) {
		await pi.exec("herdr", ["notification", "show", title, "--body", body, "--sound", "done"], { timeout: 5000 }).catch(() => undefined);
	},
};
