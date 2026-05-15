import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * cmux split helpers — ported from `pi-cmux@0.1.8` (MIT, Javier Molina,
 * https://github.com/javiermolinar/pi-cmux) with light adaptation for the
 * `@earendil-works` namespace and SumoCode's typed-result style. pi-cmux is
 * already installed alongside SumoCode for many users, but its exports are
 * Pi-loaded extensions rather than a library, so the helpers can't be
 * imported directly. Keeping the small parity copy here means `/sumo:diff`
 * and any future cmux-aware command works whether or not pi-cmux is installed.
 *
 * Pattern documented in `pi-cmux/extensions/cmux-core.ts`:
 *   1. `cmux --json identify` → confirm we're in a cmux surface; extract workspace + surface refs.
 *   2. snapshot `cmux --json list-panes` for the workspace before the split.
 *   3. `cmux new-split <direction>` against the current surface.
 *   4. poll `list-panes` until a new pane appears — capture its surface ref.
 *   5. `cmux respawn-pane --command <cmd>` runs the command in the new pane.
 */

const CMUX_TIMEOUT_MS = 5_000;
const SPLIT_READY_ATTEMPTS = 20;
const SPLIT_READY_DELAY_MS = 150;
const SURFACE_BOOT_DELAY_MS = 250;

export type SplitDirection = "left" | "right" | "up" | "down";

interface CmuxCallerInfo {
	workspace_ref?: string;
	surface_ref?: string;
}

interface CmuxIdentifyResponse {
	caller?: CmuxCallerInfo;
}

interface CmuxPaneInfo {
	ref?: string;
	selected_surface_ref?: string;
	surface_refs?: string[];
}

interface CmuxListPanesResponse {
	panes?: CmuxPaneInfo[];
}

interface CmuxExecResult {
	readonly ok: boolean;
	readonly stdout: string;
	readonly stderr: string;
	readonly error?: string;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

/**
 * POSIX single-quote escape. Wraps `value` in single quotes and escapes any
 * literal single quote inside. Safe for paths with spaces, parentheses, and
 * shell metacharacters — including SumoCode's own `/Volumes/SumoDeus NVMe`
 * dev path.
 */
export function shellEscape(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Build a `cd <cwd> && exec sh -lc <command>` string for `cmux respawn-pane`'s
 * `--command` argument. Two layers of escaping: cwd is escaped once for the
 * outer shell, command is escaped once more so the inner `sh -lc` sees it as
 * a single string argument.
 */
export function buildShellCommand(cwd: string, command: string): string {
	return ["cd", shellEscape(cwd), "&&", "exec", "sh", "-lc", shellEscape(command)].join(" ");
}

function collectSurfaceRefs(panes: readonly CmuxPaneInfo[]): Set<string> {
	const refs = new Set<string>();
	for (const pane of panes) {
		if (pane.selected_surface_ref) refs.add(pane.selected_surface_ref);
		for (const surfaceRef of pane.surface_refs ?? []) refs.add(surfaceRef);
	}
	return refs;
}

async function execCmux(pi: ExtensionAPI, args: readonly string[]): Promise<CmuxExecResult> {
	const result = await pi.exec("cmux", [...args], { timeout: CMUX_TIMEOUT_MS });
	if (result.killed) {
		return { ok: false, stdout: result.stdout, stderr: result.stderr, error: "cmux command timed out" };
	}
	if (result.code !== 0) {
		return {
			ok: false,
			stdout: result.stdout,
			stderr: result.stderr,
			error: result.stderr.trim() || result.stdout.trim() || `cmux exited with code ${result.code}`,
		};
	}
	return { ok: true, stdout: result.stdout, stderr: result.stderr };
}

async function getCallerInfo(
	pi: ExtensionAPI,
): Promise<{ ok: true; caller: Required<CmuxCallerInfo> } | { ok: false; error: string }> {
	const result = await execCmux(pi, ["--json", "identify"]);
	if (!result.ok) return { ok: false, error: result.error ?? "Failed to identify cmux caller" };

	const parsed = parseJson<CmuxIdentifyResponse>(result.stdout);
	const workspaceRef = parsed?.caller?.workspace_ref;
	const surfaceRef = parsed?.caller?.surface_ref;
	if (!workspaceRef || !surfaceRef) {
		return { ok: false, error: "This command must be run from inside a cmux surface" };
	}
	return { ok: true, caller: { workspace_ref: workspaceRef, surface_ref: surfaceRef } };
}

async function listPanes(
	pi: ExtensionAPI,
	workspaceRef: string,
): Promise<{ ok: true; panes: CmuxPaneInfo[] } | { ok: false; error: string }> {
	const result = await execCmux(pi, ["--json", "list-panes", "--workspace", workspaceRef]);
	if (!result.ok) return { ok: false, error: result.error ?? "Failed to list cmux panes" };
	const parsed = parseJson<CmuxListPanesResponse>(result.stdout);
	return { ok: true, panes: parsed?.panes ?? [] };
}

async function waitForNewSurface(
	pi: ExtensionAPI,
	workspaceRef: string,
	previousPanes: readonly CmuxPaneInfo[],
): Promise<string | undefined> {
	const previousPaneRefs = new Set(
		previousPanes.map((pane) => pane.ref).filter((ref): ref is string => Boolean(ref)),
	);
	const previousSurfaceRefs = collectSurfaceRefs(previousPanes);

	for (let attempt = 0; attempt < SPLIT_READY_ATTEMPTS; attempt += 1) {
		const panesResult = await listPanes(pi, workspaceRef);
		if (!panesResult.ok) return undefined;

		// Prefer the new pane created by the split — its ref won't be in our
		// pre-split snapshot. Once we see it, only inspect *its* surfaces;
		// scanning other panes risks picking up an unrelated surface that
		// appeared concurrently (e.g. user opens a tab in another pane).
		let foundNewPane = false;
		for (const pane of panesResult.panes) {
			if (pane.ref && !previousPaneRefs.has(pane.ref)) {
				foundNewPane = true;
				if (pane.selected_surface_ref) return pane.selected_surface_ref;
				const firstNew = pane.surface_refs?.find((ref) => !previousSurfaceRefs.has(ref));
				if (firstNew) return firstNew;
			}
		}

		// Fallback: only scan existing panes when no new pane ref has appeared
		// yet. This covers the edge case where cmux adds a surface to an
		// existing pane instead of creating a new one.
		if (!foundNewPane) {
			for (const pane of panesResult.panes) {
				for (const surfaceRef of pane.surface_refs ?? []) {
					if (!previousSurfaceRefs.has(surfaceRef)) return surfaceRef;
				}
			}
		}

		await delay(SPLIT_READY_DELAY_MS);
	}

	return undefined;
}

export type OpenSplitResult = { ok: true } | { ok: false; error: string };

/**
 * Create a new cmux split next to the current surface and run `command`
 * in it. Returns `ok: false` with a human-readable error message if any
 * step fails. Caller decides how to surface the error (typically via
 * `ctx.ui.notify`).
 */
export async function openCommandInNewSplit(
	pi: ExtensionAPI,
	direction: SplitDirection,
	command: string,
): Promise<OpenSplitResult> {
	const callerResult = await getCallerInfo(pi);
	if (!callerResult.ok) return callerResult;

	const { workspace_ref: workspaceRef, surface_ref: surfaceRef } = callerResult.caller;
	const beforePanesResult = await listPanes(pi, workspaceRef);
	if (!beforePanesResult.ok) return beforePanesResult;

	const splitResult = await execCmux(pi, [
		"new-split",
		direction,
		"--workspace",
		workspaceRef,
		"--surface",
		surfaceRef,
	]);
	if (!splitResult.ok) {
		return { ok: false, error: splitResult.error ?? "Failed to create cmux split" };
	}

	const newSurfaceRef = await waitForNewSurface(pi, workspaceRef, beforePanesResult.panes);
	if (!newSurfaceRef) {
		return { ok: false, error: "Created split, but could not find the new cmux surface" };
	}

	await delay(SURFACE_BOOT_DELAY_MS);

	const respawnResult = await execCmux(pi, [
		"respawn-pane",
		"--workspace",
		workspaceRef,
		"--surface",
		newSurfaceRef,
		"--command",
		command,
	]);
	if (!respawnResult.ok) {
		return { ok: false, error: respawnResult.error ?? "Failed to run command in the new split" };
	}

	return { ok: true };
}
