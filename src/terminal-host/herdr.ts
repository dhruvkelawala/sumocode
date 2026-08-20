import type {
	HostResult,
	PaneRef,
	PiExecLike,
	SplitDirection,
	StartAgentPaneOptions,
	StartedAgentPane,
	TerminalHost,
} from "./types.js";

interface HerdrEnvelope { result?: unknown }
interface HerdrErrorEnvelope { error?: { code?: string; message?: string } }
interface HerdrPaneInfo { pane_id?: string; workspace_id?: string; tab_id?: string }
interface HerdrPaneInfoResult { pane?: HerdrPaneInfo }
interface HerdrTabResult { tab?: { tab_id?: string; workspace_id?: string }; tab_id?: string; root_pane?: HerdrPaneInfo }
interface HerdrWorktreeResult { root_pane?: HerdrPaneInfo; workspace?: { workspace_id?: string } }
interface HerdrPaneListResult { panes?: HerdrPaneInfo[] }

function parseEnvelope<T>(stdout: string): HostResult<T> {
	try {
		const parsed = JSON.parse(stdout) as HerdrEnvelope;
		return { ok: true, ...(parsed.result as T) };
	} catch {
		return { ok: false, error: `Malformed herdr JSON: ${stdout.trim() || "<empty>"}` };
	}
}

const execFailure = (operation: string, result: { code: number; stderr: string; stdout: string }): HostResult<never> => ({
	ok: false,
	error: result.stderr || result.stdout || `${operation} exited ${result.code}`,
});

function parseHerdrError(result: { stderr: string; stdout: string }): { code?: string; message?: string } | undefined {
	for (const text of [result.stderr, result.stdout]) {
		try {
			const parsed = JSON.parse(text) as HerdrErrorEnvelope;
			if (parsed.error) return parsed.error;
		} catch {
			// Try the next stream; CLI errors usually arrive as JSON on stderr.
		}
	}
	return undefined;
}

const hasHerdrCaller = (env: NodeJS.ProcessEnv = process.env): boolean => env.HERDR_ENV === "1" && Boolean(env.HERDR_PANE_ID);

function workspaceIdFromPaneEnv(env: NodeJS.ProcessEnv): string | undefined {
	const paneId = env.HERDR_PANE_ID;
	if (!paneId) return undefined;
	const workspace = paneId.split(":")[0];
	return workspace && /^w[0-9A-Za-z]+$/.test(workspace) ? workspace : undefined;
}

async function currentPane(pi: PiExecLike): Promise<HostResult<{ pane: HerdrPaneInfo }>> {
	const result = await pi.exec("herdr", ["pane", "current", "--current"], { timeout: 5000 });
	if (result.code !== 0) return execFailure("herdr pane current", result);
	const parsed = parseEnvelope<HerdrPaneInfoResult>(result.stdout);
	if (!parsed.ok) return parsed;
	return parsed.pane?.pane_id ? { ok: true, pane: parsed.pane } : { ok: false, error: "herdr pane current did not return a pane_id" };
}

async function resolveCallerWorkspaceId(pi: PiExecLike, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	if (hasHerdrCaller(env)) {
		const current = await currentPane(pi);
		if (current.ok && current.pane.workspace_id) return current.pane.workspace_id;
	}
	return workspaceIdFromPaneEnv(env);
}

function workspaceIdFromWorktreeResult(parsed: HerdrWorktreeResult): string | undefined {
	return parsed.workspace?.workspace_id ?? parsed.root_pane?.workspace_id;
}

async function runInWorktreeWorkspace(
	pi: PiExecLike,
	workspaceId: string,
	shellCommand?: string,
): Promise<HostResult<{ pane: PaneRef }>> {
	const panesResult = await pi.exec("herdr", ["pane", "list", "--workspace", workspaceId], { timeout: 5000 });
	if (panesResult.code !== 0) return execFailure("herdr pane list", panesResult);
	const panesParsed = parseEnvelope<HerdrPaneListResult>(panesResult.stdout);
	if (!panesParsed.ok) return panesParsed;
	// The list is already scoped by --workspace, so the first pane IS the
	// workspace's pane; matching on per-pane workspace_id would spuriously
	// fail if herdr ever omits that field.
	const paneId = panesParsed.panes?.[0]?.pane_id;
	if (!paneId) return { ok: false, error: `herdr pane list returned no panes for workspace ${workspaceId}` };
	if (shellCommand !== undefined) {
		const runResult = await pi.exec("herdr", ["pane", "run", paneId, shellCommand], { timeout: 5000 });
		if (runResult.code !== 0) return execFailure("herdr pane run", runResult);
	}
	return { ok: true, pane: { host: "herdr", paneId, workspaceId } };
}

const slugAgentPrefix = (prefix: string): string => prefix
	.toLowerCase()
	.replace(/[^a-z0-9]+/g, "-")
	.replace(/^-+|-+$/g, "")
	.slice(0, 40) || "sumocode";

/** Unique child label used in SumoCode snapshots and pane metadata. */
export function uniqueHerdrAgentName(prefix = "sumocode"): string {
	return `${slugAgentPrefix(prefix)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function listWorkspacePanes(pi: PiExecLike, workspaceId: string): Promise<HostResult<{ panes: HerdrPaneInfo[] }>> {
	const result = await pi.exec("herdr", ["pane", "list", "--workspace", workspaceId], { timeout: 5000 });
	if (result.code !== 0) return execFailure("herdr pane list", result);
	const parsed = parseEnvelope<HerdrPaneListResult>(result.stdout);
	if (!parsed.ok) return parsed;
	return { ok: true, panes: parsed.panes ?? [] };
}

async function paneForTab(pi: PiExecLike, tabId: string): Promise<HostResult<{ pane: HerdrPaneInfo }>> {
	const workspaceId = tabId.split(":")[0];
	if (!workspaceId) return { ok: false, error: `invalid herdr tab id: ${tabId}` };
	const listed = await listWorkspacePanes(pi, workspaceId);
	if (!listed.ok) return listed;
	const pane = listed.panes.find((candidate) => candidate.tab_id === tabId);
	return pane?.pane_id ? { ok: true, pane } : { ok: false, error: `herdr returned no pane for tab ${tabId}` };
}

type PaneTarget = { kind: "current" } | { kind: "id"; paneId: string };

function paneTargetArgs(target: PaneTarget): string[] {
	return target.kind === "current" ? ["--current"] : [target.paneId];
}

async function splitPane(pi: PiExecLike, target: PaneTarget, direction: SplitDirection, cwd: string): Promise<HostResult<{ pane: HerdrPaneInfo }>> {
	const result = await pi.exec("herdr", ["pane", "split", ...paneTargetArgs(target), "--direction", direction, "--cwd", cwd, "--no-focus"], { timeout: 5000 });
	if (result.code !== 0) return execFailure("herdr pane split", result);
	const parsed = parseEnvelope<HerdrPaneInfoResult>(result.stdout);
	if (!parsed.ok) return parsed;
	return parsed.pane?.pane_id ? { ok: true, pane: parsed.pane } : { ok: false, error: "herdr pane split did not return a pane_id" };
}

async function createTabPane(pi: PiExecLike, cwd: string, label: string): Promise<HostResult<{ pane: HerdrPaneInfo }>> {
	const workspaceId = await resolveCallerWorkspaceId(pi, process.env);
	const workspaceArgs = workspaceId ? ["--workspace", workspaceId] : [];
	const result = await pi.exec("herdr", ["tab", "create", ...workspaceArgs, "--cwd", cwd, "--label", label, "--no-focus"], { timeout: 5000 });
	if (result.code !== 0) return execFailure("herdr tab create", result);
	const parsed = parseEnvelope<HerdrTabResult>(result.stdout);
	if (!parsed.ok) return parsed;
	if (parsed.root_pane?.pane_id) return { ok: true, pane: parsed.root_pane };
	const tabId = parsed.tab?.tab_id ?? parsed.tab_id;
	if (!tabId) return { ok: false, error: "herdr tab create did not return a tab_id" };
	return paneForTab(pi, tabId);
}

async function runPaneCommand(pi: PiExecLike, pane: HerdrPaneInfo, command: string): Promise<HostResult<{}>> {
	if (!pane.pane_id) return { ok: false, error: "herdr pane has no pane_id" };
	const result = await pi.exec("herdr", ["pane", "run", pane.pane_id, command], { timeout: 5000 });
	return result.code === 0 ? { ok: true } : execFailure("herdr pane run", result);
}

async function startAgentPane(pi: PiExecLike, options: StartAgentPaneOptions): Promise<HostResult<StartedAgentPane>> {
	let target: HostResult<{ pane: HerdrPaneInfo }>;
	if (options.placement.kind === "workspace") {
		let anchorPaneId = options.placement.paneId;
		if (!anchorPaneId) {
			const listed = await listWorkspacePanes(pi, options.placement.workspaceId);
			if (!listed.ok) return listed;
			anchorPaneId = listed.panes[0]?.pane_id;
		}
		if (!anchorPaneId) return { ok: false, error: `herdr returned no pane for workspace ${options.placement.workspaceId}` };
		target = await splitPane(pi, { kind: "id", paneId: anchorPaneId }, "right", options.cwd);
		if (target.ok) {
			// Keep a shell alive after the child exits so Herdr preserves the
			// worktree workspace for inspection. Moving it is cosmetic; if the move
			// fails, the shell stays beside the child and still keeps the workspace.
			await pi.exec("herdr", ["pane", "move", anchorPaneId, "--new-tab", "--workspace", options.placement.workspaceId, "--label", "shell", "--no-focus"], { timeout: 5000 }).catch(() => undefined);
		}
	} else if (options.placement.kind === "tab") {
		const anchor = await paneForTab(pi, options.placement.tabId);
		target = anchor.ok && anchor.pane.pane_id
			? await splitPane(pi, { kind: "id", paneId: anchor.pane.pane_id }, options.placement.direction, options.cwd)
			: anchor;
	} else {
		target = await createTabPane(pi, options.cwd, options.placement.label);
	}
	if (!target.ok) return target;
	const started = await runPaneCommand(pi, target.pane, options.shellCommand);
	if (!started.ok) return started;

	const agentName = uniqueHerdrAgentName(options.name);
	const paneId = target.pane.pane_id!;
	const workspaceId = target.pane.workspace_id ?? (options.placement.kind === "workspace" ? options.placement.workspaceId : undefined);
	const tabId = target.pane.tab_id ?? (options.placement.kind === "tab" ? options.placement.tabId : undefined);
	await pi.exec("herdr", ["pane", "rename", paneId, options.name], { timeout: 5000 }).catch(() => undefined);
	return {
		ok: true,
		pane: { host: "herdr", paneId, workspaceId },
		agentName,
		workspaceId,
		tabId,
		paneId,
	};
}

export const herdrTerminalHost = {
	kind: "herdr",
	startAgentPane,
	async sendPaneText(pi: PiExecLike, pane: PaneRef, text: string) {
		try {
			const prompted = await pi.exec("herdr", ["agent", "prompt", pane.paneId, text], { timeout: 5000 });
			if (prompted.code === 0) return { ok: true };
			const error = parseHerdrError(prompted);
			if (error?.code === "agent_blocked") return { ok: false, error: error.message || "agent is blocked" };
			if (error?.code === "agent_not_found") return { ok: false, error: error.message || "Herdr does not recognize an agent in this pane yet" };
			return execFailure("herdr agent prompt", prompted);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	},
	async openCommandInSplit(pi: PiExecLike, direction: SplitDirection, options: { cwd: string; shellCommand: string }) {
		const target = hasHerdrCaller()
			? await splitPane(pi, { kind: "current" }, direction, options.cwd)
			: await createTabPane(pi, options.cwd, "sumocode");
		if (!target.ok) return target;
		const started = await runPaneCommand(pi, target.pane, options.shellCommand);
		if (!started.ok) return started;
		const paneId = target.pane.pane_id!;
		return { ok: true, pane: { host: "herdr", paneId, workspaceId: target.pane.workspace_id } };
	},
	async openWorktreeWorkspace(pi: PiExecLike, options: { branch: string; baseRef: string; path: string; label: string; shellCommand: string; sourceCwd: string; focus?: boolean }) {
		const result = await pi.exec(
			"herdr",
			["worktree", "create", "--cwd", options.sourceCwd, "--branch", options.branch, "--base", options.baseRef, "--path", options.path, "--label", options.label, options.focus === false ? "--no-focus" : "--focus", "--json"],
			{ timeout: 5000 },
		);
		if (result.code !== 0) return execFailure("herdr worktree create", result);
		const parsed = parseEnvelope<HerdrWorktreeResult>(result.stdout);
		if (!parsed.ok) return parsed;
		const workspaceId = workspaceIdFromWorktreeResult(parsed);
		if (!workspaceId) return { ok: false, error: "herdr worktree create did not return a workspace_id" };
		return await runInWorktreeWorkspace(pi, workspaceId, options.shellCommand);
	},
	async openExistingWorktreeWorkspace(pi: PiExecLike, options: { path: string; label: string; shellCommand?: string; sourceCwd: string; focus?: boolean }) {
		const result = await pi.exec(
			"herdr",
			["worktree", "open", "--cwd", options.sourceCwd, "--path", options.path, "--label", options.label, options.focus === false ? "--no-focus" : "--focus", "--json"],
			{ timeout: 5000 },
		);
		if (result.code !== 0) return execFailure("herdr worktree open", result);
		const parsed = parseEnvelope<HerdrWorktreeResult>(result.stdout);
		if (!parsed.ok) return parsed;
		const workspaceId = workspaceIdFromWorktreeResult(parsed);
		if (!workspaceId) return { ok: false, error: "herdr worktree open did not return a workspace_id" };
		return await runInWorktreeWorkspace(pi, workspaceId, options.shellCommand);
	},
	async closePane(pi: PiExecLike, pane: PaneRef) {
		const result = await pi.exec("herdr", ["pane", "close", pane.paneId], { timeout: 5000 });
		if (result.code !== 0) return execFailure("herdr pane close", result);
		return { ok: true };
	},
	async notify(pi: PiExecLike, title: string, body: string) {
		await pi.exec("herdr", ["notification", "show", title, "--body", body, "--sound", "done"], { timeout: 5000 }).catch(() => undefined);
	},
} satisfies TerminalHost;
