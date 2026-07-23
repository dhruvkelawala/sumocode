import { existsSync, writeFileSync } from "node:fs";
import { withPrivateFileLock } from "../../src/activity/persistence.js";

const [role, lockPath, readyFile, gateFile, enteredFile] = process.argv.slice(2);
if (!role || !lockPath || !readyFile || !gateFile || !enteredFile) {
	throw new Error("usage: activity-lock-racer <stale|live> <lock> <ready> <gate> <entered>");
}

function waitFor(path: string): void {
	while (!existsSync(path)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}

if (role === "stale") {
	let paused = false;
	try {
		withPrivateFileLock(lockPath, () => {
			writeFileSync(enteredFile, "stale\n", { mode: 0o600 });
		}, {
			timeoutMs: 350,
			pollMs: 5,
			beforeAbandonedLockTakeover: () => {
				if (paused) return;
				paused = true;
				writeFileSync(readyFile, "ready\n", { mode: 0o600 });
				waitFor(gateFile);
			},
		});
		process.stdout.write("stale-acquired\n");
	} catch {
		process.stdout.write("stale-blocked\n");
	}
} else if (role === "live") {
	withPrivateFileLock(lockPath, () => {
		writeFileSync(enteredFile, "live\n", { mode: 0o600 });
		writeFileSync(readyFile, "ready\n", { mode: 0o600 });
		waitFor(gateFile);
	}, { timeoutMs: 2_000, pollMs: 5 });
	process.stdout.write("live-released\n");
} else {
	throw new Error(`unknown role: ${role}`);
}
