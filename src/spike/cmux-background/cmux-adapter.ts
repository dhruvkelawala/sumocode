/**
 * Portable cmux CLI adapter for visible background tasks.
 *
 * Spike extracted from pi-cmux (respawn-pane split flow) and opencode-cmux
 * (status/notify helpers). No Pi extension dependency — inject execCmux for tests.
 */

import { existsSync } from "node:fs";

export type SplitDirection = "right" | "down";

export interface CmuxExecResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	error?: string;
	killed?: boolean;
}

export type CmuxExecFn = (args: string[], options?: { timeoutMs?: number }) => Promise<CmuxExecResult>;

export interface CmuxCallerContext {
	workspaceRef: string;
	surfaceRef: string;
}

export interface CmuxPaneInfo {
	ref?: string;
	selected_surface_ref?: string;
	surface_refs?: string[];
}

export interface OpenVisibleTaskOptions {
	direction: SplitDirection;
	command: string;
	execCmux: CmuxExecFn;
	timeoutMs?: number;
	splitReadyAttempts?: number;
	splitReadyDelayMs?: number;
	surfaceBootDelayMs?: number;
}

export type OpenVisibleTaskResult =
	| { ok: true; workspaceRef: string; surfaceRef: string }
	| { ok: false; error: string };

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_SPLIT_READY_ATTEMPTS = 20;
const DEFAULT_SPLIT_READY_DELAY_MS = 150;
const DEFAULT_SURFACE_BOOT_DELAY_MS = 250;

export function resolveCmuxBinary(): string {
	const bundled = process.env.CMUX_BUNDLED_CLI_PATH;
	if (bundled && existsSync(bundled)) {
		return bundled;
	}
	return "cmux";
}

export function isInCmux(): boolean {
	return Boolean(process.env.CMUX_WORKSPACE_ID || process.env.CMUX_SURFACE_ID);
}

export function shellEscape(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildShellCommand(cwd: string, command: string): string {
	return ["cd", shellEscape(cwd), "&&", "exec", "sh", "-lc", shellEscape(command)].join(" ");
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function parseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

function collectSurfaceRefs(panes: CmuxPaneInfo[]): Set<string> {
	const refs = new Set<string>();
	for (const pane of panes) {
		if (pane.selected_surface_ref) {
			refs.add(pane.selected_surface_ref);
		}
		for (const surfaceRef of pane.surface_refs ?? []) {
			refs.add(surfaceRef);
		}
	}
	return refs;
}

export async function execCmuxCommand(
	execCmux: CmuxExecFn,
	args: string[],
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CmuxExecResult> {
	const result = await execCmux(args, { timeoutMs });
	if (result.killed) {
		return { ...result, ok: false, error: "cmux command timed out" };
	}
	if (!result.ok) {
		return {
			...result,
			error: result.stderr.trim() || result.stdout.trim() || "cmux command failed",
		};
	}
	return result;
}

export async function identifyCmuxCaller(execCmux: CmuxExecFn): Promise<
	{ ok: true; caller: CmuxCallerContext } | { ok: false; error: string }
> {
	const result = await execCmuxCommand(execCmux, ["--json", "identify"]);
	if (!result.ok) {
		return { ok: false, error: result.error ?? "Failed to identify cmux caller" };
	}

	const parsed = parseJson<{ caller?: { workspace_ref?: string; surface_ref?: string } }>(result.stdout);
	const workspaceRef = parsed?.caller?.workspace_ref;
	const surfaceRef = parsed?.caller?.surface_ref;
	if (!workspaceRef || !surfaceRef) {
		return { ok: false, error: "Must run inside a cmux surface (missing workspace/surface refs)" };
	}

	return { ok: true, caller: { workspaceRef, surfaceRef } };
}

export async function listCmuxPanes(
	execCmux: CmuxExecFn,
	workspaceRef: string,
): Promise<{ ok: true; panes: CmuxPaneInfo[] } | { ok: false; error: string }> {
	const result = await execCmuxCommand(execCmux, ["--json", "list-panes", "--workspace", workspaceRef]);
	if (!result.ok) {
		return { ok: false, error: result.error ?? "Failed to list cmux panes" };
	}

	const parsed = parseJson<{ panes?: CmuxPaneInfo[] }>(result.stdout);
	return { ok: true, panes: parsed?.panes ?? [] };
}

export async function waitForNewCmuxSurface(
	execCmux: CmuxExecFn,
	workspaceRef: string,
	previousPanes: CmuxPaneInfo[],
	attempts = DEFAULT_SPLIT_READY_ATTEMPTS,
	delayMs = DEFAULT_SPLIT_READY_DELAY_MS,
): Promise<string | undefined> {
	const previousPaneRefs = new Set(previousPanes.map((pane) => pane.ref).filter((ref): ref is string => Boolean(ref)));
	const previousSurfaceRefs = collectSurfaceRefs(previousPanes);

	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const panesResult = await listCmuxPanes(execCmux, workspaceRef);
		if (!panesResult.ok) {
			return undefined;
		}

		for (const pane of panesResult.panes) {
			if (pane.ref && !previousPaneRefs.has(pane.ref)) {
				if (pane.selected_surface_ref) {
					return pane.selected_surface_ref;
				}
				const firstSurfaceRef = pane.surface_refs?.find((ref) => !previousSurfaceRefs.has(ref));
				if (firstSurfaceRef) {
					return firstSurfaceRef;
				}
			}
		}

		for (const pane of panesResult.panes) {
			for (const surfaceRef of pane.surface_refs ?? []) {
				if (!previousSurfaceRefs.has(surfaceRef)) {
					return surfaceRef;
				}
			}
		}

		await delay(delayMs);
	}

	return undefined;
}

export async function openVisibleTaskInSplit(options: OpenVisibleTaskOptions): Promise<OpenVisibleTaskResult> {
	const {
		direction,
		command,
		execCmux,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		splitReadyAttempts = DEFAULT_SPLIT_READY_ATTEMPTS,
		splitReadyDelayMs = DEFAULT_SPLIT_READY_DELAY_MS,
		surfaceBootDelayMs = DEFAULT_SURFACE_BOOT_DELAY_MS,
	} = options;

	const callerResult = await identifyCmuxCaller(execCmux);
	if (!callerResult.ok) {
		return callerResult;
	}

	const { workspaceRef, surfaceRef } = callerResult.caller;
	const beforePanesResult = await listCmuxPanes(execCmux, workspaceRef);
	if (!beforePanesResult.ok) {
		return beforePanesResult;
	}

	const splitResult = await execCmuxCommand(
		execCmux,
		["new-split", direction, "--workspace", workspaceRef, "--surface", surfaceRef],
		timeoutMs,
	);
	if (!splitResult.ok) {
		return { ok: false, error: splitResult.error ?? "Failed to create cmux split" };
	}

	const newSurfaceRef = await waitForNewCmuxSurface(
		execCmux,
		workspaceRef,
		beforePanesResult.panes,
		splitReadyAttempts,
		splitReadyDelayMs,
	);
	if (!newSurfaceRef) {
		return { ok: false, error: "Created split, but could not find the new cmux surface" };
	}

	await delay(surfaceBootDelayMs);

	const respawnResult = await execCmuxCommand(
		execCmux,
		["respawn-pane", "--workspace", workspaceRef, "--surface", newSurfaceRef, "--command", command],
		timeoutMs,
	);
	if (!respawnResult.ok) {
		return { ok: false, error: respawnResult.error ?? "Failed to start command in cmux split" };
	}

	return { ok: true, workspaceRef, surfaceRef: newSurfaceRef };
}

export async function setCmuxStatus(
	execCmux: CmuxExecFn,
	key: string,
	text: string,
	opts?: { icon?: string; color?: string },
): Promise<void> {
	if (!isInCmux()) {
		return;
	}
	const args = [key, text];
	if (opts?.icon) {
		args.push("--icon", opts.icon);
	}
	if (opts?.color) {
		args.push("--color", opts.color);
	}
	await execCmuxCommand(execCmux, ["set-status", ...args]);
}

export async function clearCmuxStatus(execCmux: CmuxExecFn, key: string): Promise<void> {
	if (!isInCmux()) {
		return;
	}
	await execCmuxCommand(execCmux, ["clear-status", key]);
}

export async function notifyCmux(
	execCmux: CmuxExecFn,
	opts: { title: string; subtitle?: string; body?: string },
): Promise<void> {
	if (!isInCmux()) {
		return;
	}
	const bodyParts: string[] = [];
	if (opts.subtitle) {
		bodyParts.push(opts.subtitle);
	}
	if (opts.body) {
		bodyParts.push(opts.body);
	}
	const payload = JSON.stringify({ title: opts.title, body: bodyParts.join(" — ") });
	await execCmuxCommand(execCmux, ["rpc", "notification.create", payload]);
}

export async function closeCmuxSurface(
	execCmux: CmuxExecFn,
	workspaceRef: string,
	surfaceRef: string,
): Promise<void> {
	await execCmuxCommand(execCmux, ["close-surface", "--workspace", workspaceRef, "--surface", surfaceRef]);
}
