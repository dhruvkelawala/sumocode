import type { HostResult, PaneRef, PiExecLike, SplitDirection, TerminalHost } from "./types.js";

interface HerdrEnvelope { result?: unknown }
interface HerdrAgentResult { agent?: { pane_id?: string; workspace_id?: string } }
interface HerdrPaneInfoResult { pane?: { tab_id?: string } }

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
	async closePane(pi: PiExecLike, pane: PaneRef) {
		const result = await pi.exec("herdr", ["pane", "close", pane.paneId], { timeout: 5000 });
		if (result.code !== 0) return { ok: false, error: result.stderr || result.stdout || `herdr pane close exited ${result.code}` };
		return { ok: true };
	},
	async notify(pi: PiExecLike, title: string, body: string) {
		await pi.exec("herdr", ["notification", "show", title, "--body", body, "--sound", "done"], { timeout: 5000 }).catch(() => undefined);
	},
};
