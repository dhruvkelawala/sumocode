import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "sumocode-bounded-terminal-"));
	roots.push(path);
	return path;
}

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const poll = (): void => {
			if (predicate()) return resolve();
			if (Date.now() >= deadline) return reject(new Error("timed out waiting for bounded terminal output"));
			setTimeout(poll, 5);
		};
		poll();
	});
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("bounded terminal runner", () => {
	it.skipIf(process.platform === "win32")("keeps the newest tail bounded while the command is still running", async () => {
		const directory = root();
		const commandFile = join(directory, "command.sh");
		const logFile = join(directory, "output.log");
		const runner = fileURLToPath(new URL("./bounded-terminal-runner.mjs", import.meta.url));
		const maxBytes = 1_024;
		writeFileSync(commandFile, [
			"i=0",
			"while [ \"$i\" -lt 400 ]; do",
			"  printf 'old-%03d:%0100d\\n' \"$i\" 0",
			"  i=$((i + 1))",
			"done",
			"printf 'NEWEST-OUTPUT-STILL-VISIBLE\\n'",
			"sleep 0.25",
		].join("\n"), { mode: 0o600 });
		writeFileSync(logFile, "", { mode: 0o600 });
		chmodSync(directory, 0o700);
		const child = spawn(process.execPath, [runner, "posix", commandFile, logFile, String(maxBytes)], { stdio: "ignore" });
		const exited = waitForExit(child);

		await waitFor(() => readFileSync(logFile, "utf8").includes("NEWEST-OUTPUT-STILL-VISIBLE"));
		const live = readFileSync(logFile, "utf8");
		expect(statSync(logFile).size).toBeLessThanOrEqual(maxBytes);
		expect(live).toContain("NEWEST-OUTPUT-STILL-VISIBLE");
		expect(live).not.toContain("old-000:");
		expect(await exited).toBe(0);
	});

	it.skipIf(process.platform === "win32")("returns the command exit code after flushing output", async () => {
		const directory = root();
		const commandFile = join(directory, "command.sh");
		const logFile = join(directory, "output.log");
		const runner = fileURLToPath(new URL("./bounded-terminal-runner.mjs", import.meta.url));
		writeFileSync(commandFile, "printf 'failed visibly\\n'\nexit 7\n", { mode: 0o600 });
		writeFileSync(logFile, "", { mode: 0o600 });
		const child = spawn(process.execPath, [runner, "posix", commandFile, logFile, "1024"], { stdio: "ignore" });

		expect(await waitForExit(child)).toBe(7);
		expect(readFileSync(logFile, "utf8")).toBe("failed visibly\n");
	});
});
