import { execFile, execFileSync } from "node:child_process";

export interface ProcessTreeIdentity {
	readonly pid: number;
	readonly processGroupId: number;
	readonly processStartTime: string;
}

export type ProcessIdentityStatus = "same" | "different" | "unknown";

export interface ProcessTreeSignalResult {
	readonly ok: boolean;
	readonly gone: boolean;
	readonly identityStatus?: ProcessIdentityStatus;
	readonly error?: string;
}

export interface ProcessTreeOperations {
	captureStartTime(pid: number): string | undefined;
	identityMatches(identity: ProcessTreeIdentity): ProcessIdentityStatus;
	isTreeEmpty(identity: ProcessTreeIdentity): boolean;
	/** Signal a persisted tree. Production implementations verify identity again internally. */
	signalTree(identity: ProcessTreeIdentity, signal: "SIGTERM" | "SIGKILL"): Promise<ProcessTreeSignalResult>;
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

export function captureProcessStartTime(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
	try {
		if (platform === "win32") {
			return execFileSync(
				"powershell.exe",
				["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").CreationDate`],
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

/**
 * `taskkill /T` is the Windows tree authority. Its successful completion is
 * accepted as tree-wide disposition; an error is never converted to success
 * merely because the leader disappeared, since descendants may still live.
 */
export function runWindowsTaskkill(
	pid: number,
	force: boolean,
	execute: WindowsTaskkillExecutor = (args, callback) => {
		execFile("taskkill.exe", [...args], (error) => callback(error));
	},
): Promise<ProcessTreeSignalResult> {
	return new Promise((resolve) => {
		const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
		execute(args, (error) => {
			if (!error) {
				resolve({ ok: true, gone: true });
				return;
			}
			resolve({ ok: false, gone: false, error: error.message });
		});
	});
}

async function rawSystemSignal(
	identity: ProcessTreeIdentity,
	signal: "SIGTERM" | "SIGKILL",
): Promise<ProcessTreeSignalResult> {
	if (process.platform === "win32") return runWindowsTaskkill(identity.pid, signal === "SIGKILL");
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
		if (process.platform !== "win32" && !posixGroupEmpty(identity.processGroupId) && leader === "gone") {
			// A POSIX PGID cannot be reused while descendants still occupy the group.
			// The persisted group therefore remains the owned tree after leader exit.
			return "same";
		}
		if (leader === "gone") return "different";
		if (leader === "unknown") return "unknown";
		const actual = captureProcessStartTime(identity.pid);
		if (!actual) return "unknown";
		return actual === identity.processStartTime ? "same" : "different";
	},
	isTreeEmpty(identity): boolean {
		// Leader absence is not proof of descendant absence on Windows. Windows
		// cancellation succeeds only from a successful taskkill /T operation.
		return process.platform === "win32" ? false : posixGroupEmpty(identity.processGroupId);
	},
	async signalTree(identity, signal): Promise<ProcessTreeSignalResult> {
		// Defense in depth: all production callers verify, and the system operation
		// repeats the check immediately before the actual TERM/KILL boundary.
		const identityStatus = this.identityMatches(identity);
		if (identityStatus !== "same") {
			return {
				ok: false,
				gone: false,
				identityStatus,
				error: identityStatus === "different" ? "process identity changed" : "process identity could not be verified",
			};
		}
		return rawSystemSignal(identity, signal);
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
): Promise<ProcessTreeSignalResult> {
	const identityStatus = operations.identityMatches(identity);
	if (identityStatus !== "same") {
		return {
			ok: false,
			gone: false,
			identityStatus,
			error: identityStatus === "different" ? "process identity changed" : "process identity could not be verified",
		};
	}
	return operations.signalTree(identity, signal);
}

export async function terminateProcessTree(
	operations: ProcessTreeOperations,
	identity: ProcessTreeIdentity,
	options: { readonly termGraceMs: number; readonly killGraceMs: number },
): Promise<boolean> {
	const term = await signalVerifiedProcessTree(operations, identity, "SIGTERM");
	if (!term.ok) return false;
	if (term.gone || await operations.waitForTreeEmpty(identity, options.termGraceMs)) return true;
	const kill = await signalVerifiedProcessTree(operations, identity, "SIGKILL");
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
	if (!term.ok) return false;
	if (term.gone || await operations.waitForTreeEmpty(identity, options.termGraceMs)) return true;
	const kill = await signal(identity, "SIGKILL");
	if (!kill.ok) return false;
	return kill.gone || await operations.waitForTreeEmpty(identity, options.killGraceMs);
}
