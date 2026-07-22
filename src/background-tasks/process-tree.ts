import { execFile, execFileSync } from "node:child_process";

export interface ProcessTreeIdentity {
	readonly pid: number;
	readonly processGroupId: number;
	readonly processStartTime: string;
}

export type ProcessIdentityStatus = "same" | "different" | "unknown";

export interface ProcessTreeMemberAnchor {
	readonly pid: number;
	readonly processStartTime: string;
}

export interface ProcessTreeVerification {
	readonly members: readonly ProcessTreeMemberAnchor[];
}

export interface ProcessTreeSignalResult {
	readonly ok: boolean;
	readonly gone: boolean;
	readonly identityStatus?: ProcessIdentityStatus;
	/** A soft Windows taskkill failed, so the verified tree still needs /T /F. */
	readonly forceRequired?: boolean;
	readonly error?: string;
}

export interface ProcessTreeOperations {
	captureStartTime(pid: number): string | undefined;
	identityMatches(identity: ProcessTreeIdentity): ProcessIdentityStatus;
	isTreeEmpty(identity: ProcessTreeIdentity): boolean;
	/** Capture live anchors while the persisted leader identity is still verified. */
	captureTreeVerification?(identity: ProcessTreeIdentity): ProcessTreeVerification | undefined;
	verificationMatches?(identity: ProcessTreeIdentity, verification: ProcessTreeVerification): ProcessIdentityStatus;
	/** Signal a persisted tree. Production implementations verify identity again internally. */
	signalTree(identity: ProcessTreeIdentity, signal: "SIGTERM" | "SIGKILL", verification?: ProcessTreeVerification): Promise<ProcessTreeSignalResult>;
	/** Only for a process group returned by the current, not-yet-persisted spawn call. */
	signalFreshTree?(identity: ProcessTreeIdentity, signal: "SIGTERM" | "SIGKILL"): Promise<ProcessTreeSignalResult>;
	waitForTreeEmpty(identity: ProcessTreeIdentity, timeoutMs: number): Promise<boolean>;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function positivePidStatus(pid: number): "alive" | "gone" | "unknown" {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		const code = errorCode(error);
		if (code === "ESRCH") return "gone";
		if (code === "EPERM") return "alive";
		return "unknown";
	}
}

function posixGroupEmpty(processGroupId: number): boolean {
	try {
		process.kill(-processGroupId, 0);
		return false;
	} catch (error) {
		if (errorCode(error) === "ESRCH") return true;
		// EPERM proves the group exists. Unknown failures are conservative: never
		// report cancellation while group emptiness is unproven.
		return false;
	}
}

interface WindowsProcessRow extends ProcessTreeMemberAnchor {
	readonly parentPid: number;
}

function listWindowsProcesses(): WindowsProcessRow[] | undefined {
	try {
		const script = [
			"Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 -and $null -ne $_.CreationDate } | ForEach-Object {",
			"[PSCustomObject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; processStartTime = $_.CreationDate.ToUniversalTime().ToString('o') }",
			"} | ConvertTo-Json -Compress",
		].join(" ");
		const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
		if (!output) return [];
		const parsed = JSON.parse(output) as unknown;
		const values = Array.isArray(parsed) ? parsed : [parsed];
		const rows: WindowsProcessRow[] = [];
		for (const value of values) {
			if (!value || typeof value !== "object") return undefined;
			const row = value as Record<string, unknown>;
			if (
				typeof row.pid !== "number" || !Number.isSafeInteger(row.pid) || row.pid <= 0 ||
				typeof row.parentPid !== "number" || !Number.isSafeInteger(row.parentPid) || row.parentPid < 0 ||
				typeof row.processStartTime !== "string" || !row.processStartTime
			) return undefined;
			rows.push({ pid: row.pid, parentPid: row.parentPid, processStartTime: row.processStartTime });
		}
		return rows;
	} catch {
		return undefined;
	}
}

function listWindowsTreeMembers(pid: number): ProcessTreeMemberAnchor[] | undefined {
	const rows = listWindowsProcesses();
	if (!rows) return undefined;
	const treePids = new Set([pid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const row of rows) {
			if (treePids.has(row.pid) || !treePids.has(row.parentPid)) continue;
			treePids.add(row.pid);
			changed = true;
		}
	}
	return rows.filter((row) => treePids.has(row.pid)).map(({ pid: memberPid, processStartTime }) => ({ pid: memberPid, processStartTime }));
}

function listPosixGroupMembers(processGroupId: number): ProcessTreeMemberAnchor[] | undefined {
	try {
		const rows = execFileSync("ps", ["-axo", "pid=,pgid=,lstart="], { encoding: "utf8" }).split("\n");
		const members: Array<{ pid: number; processStartTime: string }> = [];
		for (const row of rows) {
			const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
			if (!match || Number.parseInt(match[2]!, 10) !== processGroupId) continue;
			members.push({ pid: Number.parseInt(match[1]!, 10), processStartTime: match[3]!.trim() });
		}
		return members;
	} catch {
		return undefined;
	}
}

function verificationStatus(
	identity: ProcessTreeIdentity,
	verification: ProcessTreeVerification,
): ProcessIdentityStatus {
	const current = process.platform === "win32"
		? listWindowsProcesses()?.map(({ pid, processStartTime }) => ({ pid, processStartTime }))
		: listPosixGroupMembers(identity.processGroupId);
	if (!current) return "unknown";
	if (current.length === 0) return "different";
	return verification.members.some((anchor) => current.some((member) =>
		member.pid === anchor.pid && member.processStartTime === anchor.processStartTime,
	)) ? "same" : "different";
}

export function captureProcessStartTime(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
	try {
		if (platform === "win32") {
			return execFileSync(
				"powershell.exe",
				["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").CreationDate.ToUniversalTime().ToString('o')`],
				{ encoding: "utf8" },
			).trim() || undefined;
		}
		return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

export type WindowsTaskkillExecutor = (
	args: readonly string[],
	callback: (error?: Error | null) => void,
) => void;

const executeWindowsTaskkill: WindowsTaskkillExecutor = (args, callback) => {
	execFile("taskkill.exe", [...args], (error) => callback(error));
};

/**
 * `taskkill /T` is the Windows tree authority. Its successful completion is
 * accepted as tree-wide disposition; an error is never converted to success
 * merely because the leader disappeared, since descendants may still live.
 */
export function runWindowsTaskkill(
	pid: number,
	force: boolean,
	execute: WindowsTaskkillExecutor = executeWindowsTaskkill,
): Promise<ProcessTreeSignalResult> {
	return new Promise((resolve) => {
		const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
		execute(args, (error) => {
			if (!error) {
				resolve({ ok: true, gone: true });
				return;
			}
			resolve({ ok: false, gone: false, forceRequired: !force, error: error.message });
		});
	});
}

export async function runWindowsVerifiedForceTaskkill(
	verification: ProcessTreeVerification,
	execute: WindowsTaskkillExecutor = executeWindowsTaskkill,
	listMembers: () => readonly ProcessTreeMemberAnchor[] | undefined = () => listWindowsProcesses(),
): Promise<ProcessTreeSignalResult> {
	const before = listMembers();
	if (!before) return { ok: false, gone: false, error: "Windows process tree could not be reverified" };
	const liveAnchors = verification.members.filter((anchor) => before.some((member) =>
		member.pid === anchor.pid && member.processStartTime === anchor.processStartTime,
	));
	if (liveAnchors.length === 0) return { ok: true, gone: true };
	const failures: string[] = [];
	for (const anchor of liveAnchors) {
		const result = await runWindowsTaskkill(anchor.pid, true, execute);
		if (!result.ok && result.error) failures.push(result.error);
	}
	const after = listMembers();
	if (!after) return { ok: false, gone: false, error: "Windows process tree could not be verified after forced taskkill" };
	const remains = verification.members.some((anchor) => after.some((member) =>
		member.pid === anchor.pid && member.processStartTime === anchor.processStartTime,
	));
	if (!remains) return { ok: true, gone: true };
	return { ok: false, gone: false, error: failures[0] ?? "verified Windows process-tree members remain alive" };
}

async function rawSystemSignal(
	identity: ProcessTreeIdentity,
	signal: "SIGTERM" | "SIGKILL",
	verification?: ProcessTreeVerification,
): Promise<ProcessTreeSignalResult> {
	if (process.platform === "win32") {
		return signal === "SIGKILL" && verification
			? runWindowsVerifiedForceTaskkill(verification)
			: runWindowsTaskkill(identity.pid, signal === "SIGKILL");
	}
	try {
		process.kill(-identity.processGroupId, signal);
		return { ok: true, gone: false };
	} catch (error) {
		const code = errorCode(error);
		if (code === "ESRCH") return { ok: true, gone: true };
		// In particular, EPERM must never fall back to the positive leader PID:
		// doing so could leave descendants alive while claiming cancellation.
		return { ok: false, gone: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export const systemProcessTree: ProcessTreeOperations = {
	captureStartTime: captureProcessStartTime,
	identityMatches(identity): ProcessIdentityStatus {
		const leader = positivePidStatus(identity.pid);
		if (leader === "gone") {
			// An occupied numeric PGID after downtime may belong to a later unrelated
			// group. Only a verification captured while the leader was known can
			// prove a surviving descendant belongs to this terminal.
			return process.platform !== "win32" && !posixGroupEmpty(identity.processGroupId) ? "unknown" : "different";
		}
		if (leader === "unknown") return "unknown";
		const actual = captureProcessStartTime(identity.pid);
		if (!actual) return "unknown";
		return actual === identity.processStartTime ? "same" : "different";
	},
	captureTreeVerification(identity): ProcessTreeVerification | undefined {
		if (this.identityMatches(identity) !== "same") return undefined;
		const members = process.platform === "win32"
			? listWindowsTreeMembers(identity.pid)
			: listPosixGroupMembers(identity.processGroupId);
		if (!members || members.length === 0) return undefined;
		// Bracket the snapshot with persisted-leader checks. If the original group
		// exits/reuses its numeric PGID during `ps`, never anchor the replacement.
		if (this.identityMatches(identity) !== "same") return undefined;
		if (!members.some((member) => member.pid === identity.pid && member.processStartTime === identity.processStartTime)) return undefined;
		return { members };
	},
	verificationMatches: verificationStatus,
	isTreeEmpty(identity): boolean {
		// Leader absence is not proof of descendant absence on Windows. Windows
		// cancellation succeeds only from a successful taskkill /T operation.
		return process.platform === "win32" ? false : posixGroupEmpty(identity.processGroupId);
	},
	async signalTree(identity, signal, verification): Promise<ProcessTreeSignalResult> {
		// Defense in depth: all production callers verify, and the system operation
		// repeats the check immediately before the actual TERM/KILL boundary.
		let identityStatus = this.identityMatches(identity);
		if (identityStatus !== "same" && verification) identityStatus = verificationStatus(identity, verification);
		if (identityStatus !== "same") {
			return {
				ok: false,
				gone: false,
				identityStatus,
				error: identityStatus === "different" ? "process identity changed" : "process identity could not be verified",
			};
		}
		return rawSystemSignal(identity, signal, verification);
	},
	signalFreshTree: rawSystemSignal,
	waitForTreeEmpty(identity, timeoutMs): Promise<boolean> {
		return new Promise((resolve) => {
			if (this.isTreeEmpty(identity)) {
				resolve(true);
				return;
			}
			const deadline = Date.now() + Math.max(0, timeoutMs);
			const poll = (): void => {
				if (this.isTreeEmpty(identity)) {
					resolve(true);
					return;
				}
				if (Date.now() >= deadline) {
					resolve(false);
					return;
				}
				const timer = setTimeout(poll, 25);
				timer.unref?.();
			};
			poll();
		});
	},
};

export async function signalVerifiedProcessTree(
	operations: ProcessTreeOperations,
	identity: ProcessTreeIdentity,
	signal: "SIGTERM" | "SIGKILL",
	verification?: ProcessTreeVerification,
): Promise<ProcessTreeSignalResult> {
	let identityStatus = operations.identityMatches(identity);
	if (identityStatus !== "same" && verification && operations.verificationMatches) {
		identityStatus = operations.verificationMatches(identity, verification);
	}
	if (identityStatus !== "same") {
		return {
			ok: false,
			gone: false,
			identityStatus,
			error: identityStatus === "different" ? "process identity changed" : "process identity could not be verified",
		};
	}
	return verification
		? operations.signalTree(identity, signal, verification)
		: operations.signalTree(identity, signal);
}

export async function terminateProcessTree(
	operations: ProcessTreeOperations,
	identity: ProcessTreeIdentity,
	options: { readonly termGraceMs: number; readonly killGraceMs: number },
): Promise<boolean> {
	const verification = operations.captureTreeVerification?.(identity);
	const term = await signalVerifiedProcessTree(operations, identity, "SIGTERM", verification);
	if (!term.ok && !term.forceRequired) return false;
	if (term.ok && (term.gone || await operations.waitForTreeEmpty(identity, options.termGraceMs))) return true;
	const kill = await signalVerifiedProcessTree(operations, identity, "SIGKILL", verification);
	if (!kill.ok) return false;
	return kill.gone || await operations.waitForTreeEmpty(identity, options.killGraceMs);
}

/** Cleanup for the exact group returned by the current spawn before ownership is persisted. */
export async function terminateFreshProcessTree(
	operations: ProcessTreeOperations,
	identity: ProcessTreeIdentity,
	options: { readonly termGraceMs: number; readonly killGraceMs: number },
): Promise<boolean> {
	const signal = operations.signalFreshTree ?? operations.signalTree.bind(operations);
	const term = await signal(identity, "SIGTERM");
	if (!term.ok && !term.forceRequired) return false;
	if (term.ok && (term.gone || await operations.waitForTreeEmpty(identity, options.termGraceMs))) return true;
	const kill = await signal(identity, "SIGKILL");
	if (!kill.ok) return false;
	return kill.gone || await operations.waitForTreeEmpty(identity, options.killGraceMs);
}
