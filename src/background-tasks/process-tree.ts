import { execFile, execFileSync } from "node:child_process";

export interface ProcessTreeIdentity {
	readonly pid: number;
	readonly processGroupId: number;
	readonly processStartTime: string;
}

export interface ProcessTreeSignalResult {
	readonly ok: boolean;
	readonly gone: boolean;
	readonly error?: string;
}

export interface ProcessTreeOperations {
	captureStartTime(pid: number): string | undefined;
	identityMatches(identity: ProcessTreeIdentity): "same" | "different" | "unknown";
	isTreeEmpty(identity: ProcessTreeIdentity): boolean;
	signalTree(identity: ProcessTreeIdentity, signal: "SIGTERM" | "SIGKILL"): Promise<ProcessTreeSignalResult>;
	waitForTreeEmpty(identity: ProcessTreeIdentity, timeoutMs: number): Promise<boolean>;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function positivePidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
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

function captureStartTime(pid: number): string | undefined {
	try {
		if (process.platform === "win32") {
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

function runTaskkill(pid: number, force: boolean): Promise<ProcessTreeSignalResult> {
	return new Promise((resolve) => {
		const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
		execFile("taskkill.exe", args, (error) => {
			if (!error) {
				resolve({ ok: true, gone: false });
				return;
			}
			if (!positivePidAlive(pid)) {
				resolve({ ok: true, gone: true });
				return;
			}
			resolve({ ok: false, gone: false, error: error.message });
		});
	});
}

export const systemProcessTree: ProcessTreeOperations = {
	captureStartTime,
	identityMatches(identity): "same" | "different" | "unknown" {
		if (process.platform !== "win32" && !posixGroupEmpty(identity.processGroupId) && !positivePidAlive(identity.pid)) {
			// The detached leader exited while descendants remain in its process
			// group. PGIDs cannot be reused until the group empties, so the group is
			// still the original terminal even though the leader cannot be probed.
			return "same";
		}
		if (!positivePidAlive(identity.pid)) return "different";
		const actual = captureStartTime(identity.pid);
		if (!actual) return "unknown";
		return actual === identity.processStartTime ? "same" : "different";
	},
	isTreeEmpty(identity): boolean {
		return process.platform === "win32" ? !positivePidAlive(identity.pid) : posixGroupEmpty(identity.processGroupId);
	},
	async signalTree(identity, signal): Promise<ProcessTreeSignalResult> {
		if (process.platform === "win32") return runTaskkill(identity.pid, signal === "SIGKILL");
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
	},
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

export async function terminateProcessTree(
	operations: ProcessTreeOperations,
	identity: ProcessTreeIdentity,
	options: { readonly termGraceMs: number; readonly killGraceMs: number },
): Promise<boolean> {
	const term = await operations.signalTree(identity, "SIGTERM");
	if (!term.ok) return false;
	if (term.gone || await operations.waitForTreeEmpty(identity, options.termGraceMs)) return true;
	const kill = await operations.signalTree(identity, "SIGKILL");
	if (!kill.ok) return false;
	return kill.gone || await operations.waitForTreeEmpty(identity, options.killGraceMs);
}
