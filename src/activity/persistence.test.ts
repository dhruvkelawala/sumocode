import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { activityPaths, withPrivateFileLock, writePrivateJsonExclusive } from "./persistence.js";

const roots: string[] = [];

function temporaryRoot(): string {
	const path = mkdtempSync(join(tmpdir(), "sumocode-activity-lock-"));
	roots.push(path);
	return path;
}

function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const poll = (): void => {
			if (predicate()) {
				resolve();
				return;
			}
			if (Date.now() >= deadline) {
				reject(new Error("timed out waiting for activity lock racer"));
				return;
			}
			setTimeout(poll, 5);
		};
		poll();
	});
}

function runRacer(
	role: "stale" | "live",
	lockPath: string,
	readyFile: string,
	gateFile: string,
	enteredFile: string,
): Promise<string> {
	const fixture = fileURLToPath(new URL("../../test/fixtures/activity-lock-racer.ts", import.meta.url));
	return new Promise((resolve, reject) => {
		execFile(join(process.cwd(), "node_modules", ".bin", "jiti"), [fixture, role, lockPath, readyFile, gateFile, enteredFile], (error, stdout, stderr) => {
			if (error) reject(new Error(`activity lock racer failed: ${stderr || error.message}`));
			else resolve(stdout.trim());
		});
	});
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("activity private file lock", () => {
	it.skipIf(process.platform === "win32")("never lets a stale-reader takeover overlap a new live owner", async () => {
		const stateRoot = temporaryRoot();
		const directory = activityPaths("session-aba", stateRoot).directory;
		const lockPath = join(directory, "ui.json.lock");
		const staleReady = join(stateRoot, "stale-ready");
		const staleGate = join(stateRoot, "stale-gate");
		const staleEntered = join(stateRoot, "stale-entered");
		const liveReady = join(stateRoot, "live-ready");
		const liveGate = join(stateRoot, "live-gate");
		const liveEntered = join(stateRoot, "live-entered");
		writePrivateJsonExclusive(lockPath, {
			schemaVersion: 1,
			token: "dead-generation",
			pid: 2_147_483_647,
			processStartTime: "dead-start",
		});

		const stale = runRacer("stale", lockPath, staleReady, staleGate, staleEntered);
		await waitFor(() => existsSync(staleReady));
		// Replace the dead generation after the contender's read but before its
		// rename. This is the exact ABA window that previously displaced a live
		// owner and exposed an acquireable canonical pathname.
		unlinkSync(lockPath);
		const live = runRacer("live", lockPath, liveReady, liveGate, liveEntered);
		await waitFor(() => existsSync(liveReady));
		writeFileSync(staleGate, "go\n", { mode: 0o600 });

		expect(await stale).toBe("stale-blocked");
		expect(existsSync(staleEntered)).toBe(false);
		expect(existsSync(liveEntered)).toBe(true);
		const takeoverPrefix = `${basename(lockPath)}.takeover-`;
		expect(existsSync(lockPath)).toBe(false);
		expect(readdirSync(directory).some((name) => name.startsWith(takeoverPrefix))).toBe(true);

		writeFileSync(liveGate, "release\n", { mode: 0o600 });
		expect(await live).toBe("live-released");
		await waitFor(() => !readdirSync(directory).some((name) => name.startsWith(takeoverPrefix)));
		expect(existsSync(lockPath)).toBe(false);

		let recovered = false;
		withPrivateFileLock(lockPath, () => { recovered = true; });
		expect(recovered).toBe(true);
	});
});
