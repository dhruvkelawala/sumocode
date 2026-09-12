import type {
	HostResult,
	PaneRef,
	PaneProcessInfo,
	PiExecLike,
	SplitDirection,
	StartAgentPaneOptions,
	StartedAgentPane,
	TerminalHost,
} from "./types.js";
import { chooseSplitAnchor, type PaneRect, type PaneSplitChoice } from "../subagents/layout.js";

interface HerdrEnvelope { result?: unknown }
interface HerdrErrorEnvelope { error?: { code?: string; message?: string } }
interface HerdrPaneInfo { pane_id?: string; workspace_id?: string; tab_id?: string }
interface HerdrPaneInfoResult { pane?: HerdrPaneInfo }
interface HerdrTabResult { tab?: { tab_id?: string; workspace_id?: string }; tab_id?: string; root_pane?: HerdrPaneInfo }
interface HerdrWorktreeResult { root_pane?: HerdrPaneInfo; workspace?: { workspace_id?: string } }
interface HerdrPaneListResult { panes?: HerdrPaneInfo[] }
interface HerdrPaneRect { x?: number | null; y?: number | null; width?: number | null; height?: number | null }
interface HerdrPaneLayoutEntry { pane_id?: string; rect?: HerdrPaneRect }
interface HerdrPaneLayoutResult { layout?: { panes?: HerdrPaneLayoutEntry[] } }

function parseEnvelope<T>(stdout: string): HostResult<T> {
	try {
		// SAFETY: malformed herdr CLI output rejects into the catch below.
		const parsed = JSON.parse(stdout) as HerdrEnvelope;
		// SAFETY: callers pass T matching the documented herdr envelope result shape.
		return { ok: true, ...(parsed.result as T) };
	} catch {
		return { ok: false, error: `Malformed herdr JSON: ${stdout.trim() || "<empty>"}` };
	}
}

function parseHerdrError(result: { stderr: string; stdout: string }): { code?: string; message?: string } | undefined {
	for (const text of [result.stderr, result.stdout]) {
		try {
			// SAFETY: non-JSON stream content rejects into the catch below.
			const parsed = JSON.parse(text) as HerdrErrorEnvelope;
			if (parsed.error) return parsed.error;
		} catch {
			// Try the next stream; CLI errors usually arrive as JSON on stderr.
		}
	}
	return undefined;
}

const execFailure = (operation: string, result: { code: number; stderr: string; stdout: string; killed?: boolean }): HostResult<never> => ({
	ok: false,
	error: parseHerdrError(result)?.message
		?? ((result.stderr || result.stdout).trim() || (result.killed ? `${operation} timed out` : `${operation} exited ${result.code}`)),
});

const HERDR_AGENT_PROMPT_TIMEOUT_MS = 10_000;
const CHILD_CLEANUP_ERROR_MAX = 1_024;
// Leave cleanup headroom inside the public five-second failure contract. Pi's
// exec timeout terminates the CLI process, so no detached Promise.race can
// continue creating panes after startAgentPane has returned.
const HERDR_PANE_PROVISION_TOTAL_MS = 4_750;
const HERDR_PANE_CLEANUP_RESERVE_MS = 500;

interface ProvisionDeadline { readonly expiresAt: number }

const remainingProvisionMs = (deadline: ProvisionDeadline, reserveMs = 0): number | undefined => {
	const remaining = Math.floor(deadline.expiresAt - Date.now() - reserveMs);
	return remaining > 0 ? remaining : undefined;
};

const deadlineFailure = (operation: string): HostResult<never> => ({
	ok: false,
	error: `${operation} exceeded the Herdr pane provisioning deadline`,
});

const hasHerdrCaller = (env: NodeJS.ProcessEnv = process.env): boolean => env.HERDR_ENV === "1" && Boolean(env.HERDR_PANE_ID);

function workspaceIdFromPaneEnv(env: NodeJS.ProcessEnv): string | undefined {
	const paneId = env.HERDR_PANE_ID;
	if (!paneId) return undefined;
	const workspace = paneId.split(":")[0];
	return workspace && /^w[0-9A-Za-z]+$/.test(workspace) ? workspace : undefined;
}

async function currentPane(pi: PiExecLike, timeout = 5000): Promise<HostResult<{ pane: HerdrPaneInfo }>> {
	const result = await pi.exec("herdr", ["pane", "current", "--current"], { timeout });
	if (result.code !== 0) return execFailure("herdr pane current", result);
	const parsed = parseEnvelope<HerdrPaneInfoResult>(result.stdout);
	if (!parsed.ok) return parsed;
	return parsed.pane?.pane_id ? { ok: true, pane: parsed.pane } : { ok: false, error: "herdr pane current did not return a pane_id" };
}

async function resolveCallerWorkspaceId(pi: PiExecLike, env: NodeJS.ProcessEnv = process.env, timeout = 5000): Promise<string | undefined> {
	if (hasHerdrCaller(env)) {
		const current = await currentPane(pi, timeout);
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
	deadline?: ProvisionDeadline,
): Promise<HostResult<{ pane: PaneRef }>> {
	const listTimeout = deadline ? remainingProvisionMs(deadline) : 5000;
	if (listTimeout === undefined) return deadlineFailure("herdr pane list");
	const panesResult = await pi.exec("herdr", ["pane", "list", "--workspace", workspaceId], { timeout: listTimeout });
	if (panesResult.code !== 0) return execFailure("herdr pane list", panesResult);
	const panesParsed = parseEnvelope<HerdrPaneListResult>(panesResult.stdout);
	if (!panesParsed.ok) return panesParsed;
	// The list is already scoped by --workspace, so the first pane IS the
	// workspace's pane; matching on per-pane workspace_id would spuriously
	// fail if herdr ever omits that field.
	const paneId = panesParsed.panes?.[0]?.pane_id;
	if (!paneId) return { ok: false, error: `herdr pane list returned no panes for workspace ${workspaceId}` };
	if (shellCommand !== undefined) {
		const runTimeout = deadline ? remainingProvisionMs(deadline) : 5000;
		if (runTimeout === undefined) return deadlineFailure("herdr pane run");
		const runResult = await pi.exec("herdr", ["pane", "run", paneId, shellCommand], { timeout: runTimeout });
		if (runResult.code !== 0) return execFailure("herdr pane run", runResult);
	}
	return { ok: true, pane: { host: "herdr", paneId, workspaceId } };
}

async function openExistingWorktreeWorkspace(
	pi: PiExecLike,
	options: { path: string; label: string; shellCommand?: string; sourceCwd: string; focus?: boolean },
	deadline?: ProvisionDeadline,
): Promise<HostResult<{ pane: PaneRef }>> {
	// Reserve cleanup headroom before opening the worktree workspace: a slow
	// open must not consume the entire deadline and starve the follow-up split
	// and run. The opened workspace is intentionally preserved on failure — it
	// anchors a preserved git worktree and is the caller's recovery anchor, so
	// no owned-pane/owned-tab cleanup is performed for it.
	const openTimeout = deadline ? remainingProvisionMs(deadline, HERDR_PANE_CLEANUP_RESERVE_MS) : 5000;
	if (openTimeout === undefined) return deadlineFailure("herdr worktree open");
	const result = await pi.exec(
		"herdr",
		["worktree", "open", "--cwd", options.sourceCwd, "--path", options.path, "--label", options.label, options.focus === false ? "--no-focus" : "--focus", "--json"],
		{ timeout: openTimeout },
	);
	if (result.code !== 0) return execFailure("herdr worktree open", result);
	const parsed = parseEnvelope<HerdrWorktreeResult>(result.stdout);
	if (!parsed.ok) return parsed;
	const workspaceId = workspaceIdFromWorktreeResult(parsed);
	if (!workspaceId) return { ok: false, error: "herdr worktree open did not return a workspace_id" };
	return runInWorktreeWorkspace(pi, workspaceId, options.shellCommand, deadline);
}

async function listWorkspacePanes(pi: PiExecLike, workspaceId: string, timeout = 5000): Promise<HostResult<{ panes: HerdrPaneInfo[] }>> {
	const result = await pi.exec("herdr", ["pane", "list", "--workspace", workspaceId], { timeout });
	if (result.code !== 0) return execFailure("herdr pane list", result);
	const parsed = parseEnvelope<HerdrPaneListResult>(result.stdout);
	if (!parsed.ok) return parsed;
	return { ok: true, panes: parsed.panes ?? [] };
}

const paneUnavailable = (failure: HostResult<never>): HostResult<never> => {
	if (failure.ok) return failure;
	const structured: HostResult<never> = { ok: false, code: "pane_unavailable", error: failure.error, reason: failure.reason ?? failure.error };
	// A tab-placement failure whose target tab has no live pane is the one
	// definitive "tab is gone" signal: preserve it so the manager can retire
	// stale still-open records anchored on that tab.
	return failure.tabGone === true ? { ...structured, tabGone: true } : structured;
};

async function paneForTab(pi: PiExecLike, tabId: string, timeout = 5000, deadline?: ProvisionDeadline, reserveMs = 0, signalTabGone = false): Promise<HostResult<{ pane: HerdrPaneInfo }>> {
	const workspaceId = tabId.split(":")[0];
	if (!workspaceId) return { ok: false, error: `invalid herdr tab id: ${tabId}` };
	// A just-created tab can be returned before its root pane appears in
	// `pane list` (observed live as `no pane for tab`). Bound the retry so a
	// genuinely closed/stale tab still fails quickly and invalidates the cache.
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const callTimeout = deadline ? remainingProvisionMs(deadline, reserveMs) : timeout;
		if (callTimeout === undefined) return deadlineFailure("herdr pane list");
		const listed = await listWorkspacePanes(pi, workspaceId, callTimeout);
		if (!listed.ok) return listed;
		const pane = listed.panes.find((candidate) => candidate.tab_id === tabId);
		if (pane?.pane_id) return { ok: true, pane };
		if (attempt < 3) {
			const retryDelay = deadline ? Math.min(25, remainingProvisionMs(deadline, reserveMs) ?? 0) : 25;
			if (retryDelay <= 0) return deadlineFailure("herdr pane list");
			await new Promise<void>((resolve) => setTimeout(resolve, retryDelay));
		}
	}
	// No live pane remains in the tab: for an explicit tab placement that is
	// the definitive "tab is gone" signal the manager uses to retire stale
	// still-open records anchored on it. A just-created new tab can simply be
	// racing its own root pane, so that flow does not signal.
	return signalTabGone
		? { ok: false, error: `herdr returned no pane for tab ${tabId}`, tabGone: true }
		: { ok: false, error: `herdr returned no pane for tab ${tabId}` };
}

// Herdr omits or nulls layout dimensions for panes it cannot measure; an
// unmeasurable pane is left out of the chooser and the planned direction wins.
const finite = (value: number | null | undefined): value is number => Number.isFinite(value);

function paneRects(panes: readonly HerdrPaneLayoutEntry[] | undefined): PaneRect[] {
	const rects: PaneRect[] = [];
	for (const pane of panes ?? []) {
		const rect = pane.rect;
		if (!pane.pane_id || !rect) continue;
		if (!finite(rect.x) || !finite(rect.y) || !finite(rect.width) || !finite(rect.height)) continue;
		rects.push({ paneId: pane.pane_id, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
	}
	return rects;
}

/**
 * Read the tab's live geometry through one of its panes and pick the next
 * split. A count-based or planned direction cannot see the tree a previous
 * child left behind, so the pane with the largest area wins and its longer
 * axis is the split axis. Returns undefined when the layout cannot be read;
 * the caller then keeps its planned direction.
 */
async function tabSplitChoice(pi: PiExecLike, paneId: string, deadline: ProvisionDeadline): Promise<PaneSplitChoice | undefined> {
	const timeout = remainingProvisionMs(deadline, HERDR_PANE_CLEANUP_RESERVE_MS);
	if (timeout === undefined) return undefined;
	try {
		const result = await pi.exec("herdr", ["pane", "layout", "--pane", paneId], { timeout });
		if (result.code !== 0) return undefined;
		const parsed = parseEnvelope<HerdrPaneLayoutResult>(result.stdout);
		return parsed.ok ? chooseSplitAnchor(paneRects(parsed.layout?.panes)) : undefined;
	} catch {
		// A geometry read is best-effort: an unavailable layout must not fail a
		// spawn whose split the planned direction can still place.
		return undefined;
	}
}

type PaneTarget = { kind: "current" } | { kind: "id"; paneId: string };

function paneTargetArgs(target: PaneTarget): string[] {
	return target.kind === "current" ? ["--current"] : [target.paneId];
}

async function splitPane(pi: PiExecLike, target: PaneTarget, direction: SplitDirection, cwd: string, timeout = 5000): Promise<HostResult<{ pane: HerdrPaneInfo }>> {
	const result = await pi.exec("herdr", ["pane", "split", ...paneTargetArgs(target), "--direction", direction, "--cwd", cwd, "--no-focus"], { timeout });
	if (result.code !== 0) return execFailure("herdr pane split", result);
	const parsed = parseEnvelope<HerdrPaneInfoResult>(result.stdout);
	if (!parsed.ok) return parsed;
	return parsed.pane?.pane_id ? { ok: true, pane: parsed.pane } : { ok: false, error: "herdr pane split did not return a pane_id" };
}

async function createTabPane(
	pi: PiExecLike,
	cwd: string,
	label: string,
	timeout = 5000,
	deadline?: ProvisionDeadline,
	onCreatedTab?: (tabId: string) => void,
): Promise<HostResult<{ pane: HerdrPaneInfo }>> {
	const currentTimeout = deadline ? remainingProvisionMs(deadline) : timeout;
	if (currentTimeout === undefined) return deadlineFailure("herdr pane current");
	const workspaceId = await resolveCallerWorkspaceId(pi, process.env, currentTimeout);
	const workspaceArgs = workspaceId ? ["--workspace", workspaceId] : [];
	// Reserve cleanup headroom before allocating the tab: `tab create` owns
	// the new tab, and a slow create must not leave fail() without time to
	// close it when the subsequent run misses its own reserve check.
	const createTimeout = deadline ? remainingProvisionMs(deadline, HERDR_PANE_CLEANUP_RESERVE_MS) : timeout;
	if (createTimeout === undefined) return deadlineFailure("herdr tab create");
	const result = await pi.exec("herdr", ["tab", "create", ...workspaceArgs, "--cwd", cwd, "--label", label, "--no-focus"], { timeout: createTimeout });
	if (result.code !== 0) return execFailure("herdr tab create", result);
	const parsed = parseEnvelope<HerdrTabResult>(result.stdout);
	if (!parsed.ok) return parsed;
	const tabId = parsed.root_pane?.tab_id ?? parsed.tab?.tab_id ?? parsed.tab_id;
	if (tabId) onCreatedTab?.(tabId);
	if (parsed.root_pane?.pane_id) return { ok: true, pane: parsed.root_pane };
	if (!tabId) return { ok: false, error: "herdr tab create did not return a tab_id" };
	return paneForTab(pi, tabId, timeout, deadline, HERDR_PANE_CLEANUP_RESERVE_MS);
}

async function runPaneCommand(pi: PiExecLike, pane: HerdrPaneInfo, command: string, timeout = 5000): Promise<HostResult<{}>> {
	if (!pane.pane_id) return { ok: false, error: "herdr pane has no pane_id" };
	try {
		const result = await pi.exec("herdr", ["pane", "run", pane.pane_id, command], { timeout });
		return result.code === 0 ? { ok: true } : execFailure("herdr pane run", result);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

async function cleanFailedChildStart(
	pi: PiExecLike,
	paneId: string,
	primaryError: string,
	recoveryShell?: { paneId: string; workspaceId: string },
): Promise<HostResult<never>> {
	let error = primaryError;
	if (recoveryShell) error += `. Recovery shell preserved at pane ${recoveryShell.paneId} in workspace ${recoveryShell.workspaceId}.`;
	try {
		const cleanup = await pi.exec("herdr", ["pane", "close", paneId], { timeout: 5000 });
		if (cleanup.code !== 0) {
			const context = (cleanup.stderr || cleanup.stdout || `herdr pane close exited ${cleanup.code}`).slice(0, CHILD_CLEANUP_ERROR_MAX);
			error += `${error.endsWith(".") ? "" : "."} Child cleanup failed: ${context}`;
		}
	} catch (cleanupError) {
		const context = (cleanupError instanceof Error ? cleanupError.message : String(cleanupError)).slice(0, CHILD_CLEANUP_ERROR_MAX);
		error += `${error.endsWith(".") ? "" : "."} Child cleanup failed: ${context}`;
	}
	return { ok: false, error };
}

async function startAgentPane(pi: PiExecLike, options: StartAgentPaneOptions): Promise<HostResult<StartedAgentPane>> {
	const requestedBudget = options.provisioningTimeoutMs ?? HERDR_PANE_PROVISION_TOTAL_MS;
	const deadline: ProvisionDeadline = {
		expiresAt: Date.now() + Math.min(HERDR_PANE_PROVISION_TOTAL_MS, Math.max(0, requestedBudget)),
	};
	let ownedPaneId: string | undefined;
	let ownedTabId: string | undefined;
	let workspaceAnchorToMove: { paneId: string; workspaceId: string } | undefined;
	// The retained owner admits the pane inside `beforeRun`. Until that admission
	// is attempted, a generated tab/pane from target provisioning is unadmitted
	// and this call owns its cleanup; a refused admission or any later failure
	// keeps the pane with the owner, so no close runs here.
	let admissionAttempted = false;

	const fail = async (failure: HostResult<never>): Promise<HostResult<never>> => {
		let cleanupFailure: string | undefined;
		const cleanupArgs = ownedPaneId
			? ["pane", "close", ownedPaneId]
			: ownedTabId
				? ["tab", "close", ownedTabId]
				: undefined;
		if (cleanupArgs) {
			const timeout = remainingProvisionMs(deadline);
			if (timeout === undefined) cleanupFailure = "cleanup skipped because the provisioning deadline expired";
			else {
				try {
					const closed = await pi.exec("herdr", cleanupArgs, { timeout });
					if (closed.code !== 0) cleanupFailure = execFailure(`herdr ${cleanupArgs[0]} close`, closed).error;
				} catch (error) {
					cleanupFailure = error instanceof Error ? error.message : String(error);
				}
				if (cleanupFailure) cleanupFailure = cleanupFailure.slice(0, CHILD_CLEANUP_ERROR_MAX);
			}
		}
		const structured = paneUnavailable(failure);
		if (structured.ok || !cleanupFailure) return structured;
		// Cleanup failed or was skipped, so the allocated pane/tab still occupies
		// layout capacity. Report it so the manager can keep counting the slot
		// instead of over-tiling the tab on the next spawn. A failed pane close
		// leaves both the pane and, for new-tab spawns, its generated tab alive:
		// report both identifiers so the manager can make the surviving tab
		// reclaimable (`tab` placements infer their tab from the placement, but a
		// generated tab id only exists here).
		const reason = `${structured.reason}; cleanup: ${cleanupFailure}`;
		if (ownedPaneId !== undefined) {
			return ownedTabId !== undefined
				? { ...structured, reason, orphanPaneId: ownedPaneId, orphanTabId: ownedTabId }
				: { ...structured, reason, orphanPaneId: ownedPaneId };
		}
		if (ownedTabId !== undefined) return { ...structured, reason, orphanTabId: ownedTabId };
		return { ...structured, reason };
	};

	try {
		let target: HostResult<{ pane: HerdrPaneInfo }>;
		if (options.placement.kind === "workspace" || options.placement.kind === "worktree-workspace") {
			let workspaceId: string;
			let anchorPaneId: string | undefined;
			if (options.placement.kind === "worktree-workspace") {
				const opened = await openExistingWorktreeWorkspace(pi, { ...options.placement, focus: false }, deadline);
				if (!opened.ok) return fail(opened);
				workspaceId = opened.pane.workspaceId ?? "";
				anchorPaneId = opened.pane.paneId;
			} else {
				workspaceId = options.placement.workspaceId;
				anchorPaneId = options.placement.paneId;
			}
			if (!workspaceId) return fail({ ok: false, error: "herdr worktree workspace did not return a workspace_id" });
			if (!anchorPaneId) {
				const timeout = remainingProvisionMs(deadline);
				if (timeout === undefined) return fail(deadlineFailure("herdr pane list"));
				const listed = await listWorkspacePanes(pi, workspaceId, timeout);
				if (!listed.ok) return fail(listed);
				anchorPaneId = listed.panes[0]?.pane_id;
			}
			if (!anchorPaneId) return fail({ ok: false, error: `herdr returned no pane for workspace ${workspaceId}` });
			// Reserve cleanup headroom before allocating the new pane: a slow
			// split must not consume the entire budget and leave no time to
			// close the pane if the subsequent run fails its own reserve check.
			const timeout = remainingProvisionMs(deadline, HERDR_PANE_CLEANUP_RESERVE_MS);
			if (timeout === undefined) return fail(deadlineFailure("herdr pane split"));
			target = await splitPane(pi, { kind: "id", paneId: anchorPaneId }, "right", options.cwd, timeout);
			workspaceAnchorToMove = { paneId: anchorPaneId, workspaceId };
		} else if (options.placement.kind === "tab") {
			const anchor = await paneForTab(pi, options.placement.tabId, 5000, deadline, 0, true);
			if (!anchor.ok || !anchor.pane.pane_id) target = anchor;
			else {
				// Tile from the live geometry instead of the placement's count-based
				// direction so sequential children fill the tab's grid rather than
				// nesting halves of one corner. The placement direction remains the
				// fallback for an unreadable layout.
				const choice = await tabSplitChoice(pi, anchor.pane.pane_id, deadline)
					?? { paneId: anchor.pane.pane_id, direction: options.placement.direction };
				const timeout = remainingProvisionMs(deadline, HERDR_PANE_CLEANUP_RESERVE_MS);
				target = timeout === undefined
					? deadlineFailure("herdr pane split")
					: await splitPane(pi, { kind: "id", paneId: choice.paneId }, choice.direction, options.cwd, timeout);
			}
		} else {
			target = await createTabPane(pi, options.cwd, options.placement.label, 5000, deadline, (tabId) => {
				ownedTabId = tabId;
			});
		}
		if (!target.ok) return fail(target);
		ownedPaneId = target.pane.pane_id;

		// Retained-launch gate (retained-work feature): the retained owner must
		// admit the pane before its command runs. A refused admission rejects
		// the launch and the owner keeps the pane, so no cleanup runs here; the
		// same contract applies when the admitted command fails to start.
		if (options.beforeRun) {
			admissionAttempted = true;
			await options.beforeRun({ host: "herdr", paneId: target.pane.pane_id!, workspaceId: target.pane.workspace_id });
			const started = await runPaneCommand(pi, target.pane, options.shellCommand, remainingProvisionMs(deadline, HERDR_PANE_CLEANUP_RESERVE_MS) ?? 5000);
			if (!started.ok) return started;
		} else {
			const runTimeout = remainingProvisionMs(deadline, HERDR_PANE_CLEANUP_RESERVE_MS);
			if (runTimeout === undefined) return fail(deadlineFailure("herdr pane run"));
			const started = await runPaneCommand(pi, target.pane, options.shellCommand, runTimeout);
			if (!started.ok) return fail(started);
		}

		// Keep a shell alive after an isolated child exits. This move is cosmetic
		// and occurs only after child launch succeeds; failure preserves both the
		// parent anchor and the running child in their original tab.
		if (workspaceAnchorToMove) {
			const moveTimeout = remainingProvisionMs(deadline);
			if (moveTimeout !== undefined) {
				await pi.exec("herdr", ["pane", "move", workspaceAnchorToMove.paneId, "--new-tab", "--workspace", workspaceAnchorToMove.workspaceId, "--label", "shell", "--no-focus"], { timeout: moveTimeout }).catch(() => undefined);
			}
		}

		const paneId = target.pane.pane_id!;
		const workspaceId = target.pane.workspace_id ?? workspaceAnchorToMove?.workspaceId;
		// A new-tab creation can return a bare root pane whose tab id only
		// exists on the creation result itself; ownedTabId carries it.
		const tabId = target.pane.tab_id ?? ownedTabId ?? (options.placement.kind === "tab" ? options.placement.tabId : undefined);
		const renameTimeout = remainingProvisionMs(deadline);
		if (renameTimeout !== undefined) await pi.exec("herdr", ["pane", "rename", paneId, options.name], { timeout: renameTimeout }).catch(() => undefined);
		return {
			ok: true,
			pane: { host: "herdr", paneId, workspaceId },
			// The caller owns subagent identity: the id is the agent name verbatim.
			// No timestamp/random suffix and no length cap — the id's counter and
			// retention namespace sit at the end, so truncation would strip the
			// disambiguator.
			agentName: options.agentName,
			workspaceId,
			tabId,
			paneId,
		};
	} catch (error) {
		// Once admission was attempted the owner owns the pane; before that the
		// target failure is an unadmitted resource this call must clean up and
		// report as structured pane_unavailable.
		if (admissionAttempted) throw error;
		return fail({ ok: false, error: error instanceof Error ? error.message : String(error) });
	}
}

// Herdr protocol 20: PaneProcessInfo numeric fields may be absent/null. Never
// infer death from missing data, or retain the accompanying argv/cwd payload.
async function inspectPane(pi: PiExecLike, pane: PaneRef): Promise<HostResult<PaneProcessInfo>> {
	const refused = { ok: false as const, error: "pane-unverified" };
	try {
		const result = await pi.exec("herdr", ["pane", "process-info", "--pane", pane.paneId], { timeout: 5000 });
		if (result.code !== 0) return refused;
		// SAFETY: every association field is checked below before being returned.
		const parsed = JSON.parse(result.stdout) as { result?: { type?: string; process_info?: { pane_id?: string; shell_pid?: number | null; foreground_process_group_id?: number | null; foreground_processes?: { pid: number }[] } } };
		const info = parsed?.result?.process_info;
		const pid = (value: number): boolean => Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff;
		if (parsed?.result?.type !== "pane_process_info" || !info || info.pane_id !== pane.paneId
			|| info.shell_pid != null && !pid(info.shell_pid)
			|| info.foreground_process_group_id != null && !pid(info.foreground_process_group_id)
			|| info.foreground_processes !== undefined && (!Array.isArray(info.foreground_processes)
				|| !info.foreground_processes.every((process) => process && pid(process.pid)))) return refused;
		return { ok: true, shellPid: info.shell_pid ?? null, foregroundProcessGroupId: info.foreground_process_group_id ?? null,
			foregroundPids: info.foreground_processes?.map((process) => process.pid) ?? [] };
	} catch {
		return refused;
	}
}

export const herdrTerminalHost = {
	kind: "herdr",
	inspectPane,
	startAgentPane,
	async sendPaneText(pi: PiExecLike, pane: PaneRef, text: string) {
		try {
			// Herdr waits up to five seconds after delivery to observe the
			// lifecycle transition; keep SumoCode's process timeout above that
			// window so a delivered prompt is not reported as failed and retried.
			const prompted = await pi.exec("herdr", ["agent", "prompt", pane.paneId, text], { timeout: HERDR_AGENT_PROMPT_TIMEOUT_MS });
			if (prompted.code === 0) return { ok: true };
			const error = parseHerdrError(prompted);
			// Herdr reports this only after delivering the prompt and then failing
			// to observe the agent transition quickly enough. Treat it as sent so
			// callers do not retry and duplicate the instruction.
			if (error?.code === "agent_prompt_stalled") return { ok: true };
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
		const paneId = target.pane.pane_id;
		if (!paneId) return { ok: false, error: "herdr child target has no pane_id; cleanup skipped" };
		const started = await runPaneCommand(pi, target.pane, options.shellCommand);
		if (!started.ok) return cleanFailedChildStart(pi, paneId, started.error);
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
	openExistingWorktreeWorkspace,
	async closePane(pi: PiExecLike, pane: PaneRef) {
		const result = await pi.exec("herdr", ["pane", "close", pane.paneId], { timeout: 5000 });
		if (result.code !== 0) return execFailure("herdr pane close", result);
		return { ok: true };
	},
	async notify(pi: PiExecLike, title: string, body: string) {
		await pi.exec("herdr", ["notification", "show", title, "--body", body, "--sound", "done"], { timeout: 5000 }).catch(() => undefined);
	},
} satisfies TerminalHost;
