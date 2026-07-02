import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type IPty } from "node-pty";
import { buildSpawnEnv } from "./spawn-pi-pty.js";

/**
 * Verifies the `/sumo:reload` respawn loop end-to-end via node-pty:
 * `bin/sumocode.sh` runs pi inside a `while :;` loop and re-launches with
 * `--continue` whenever pi exits with code `100` (the agreed reload signal).
 *
 * We don't drive the actual `/sumo:reload` slash command in this PTY because
 * Pi's autocomplete dispatch on `Enter` is fragile to drive over a raw PTY.
 * The slash-command handler itself is unit-covered in
 * `src/commands/reload.test.ts`. This test owns the bash loop side: a mock
 * pi binary exits with `100` on its first invocation and `0` on its second,
 * and we assert both invocations ran with the expected argv.
 */

interface PtySession {
	readonly child: IPty;
	getOutput(): string;
	exit: Promise<{ exitCode: number; signal?: number }>;
	cleanup(): void;
}

function spawnLauncherWithMockPi(stateFile: string, extraArgs: string[] = []): PtySession {
	const launcher = resolve(process.cwd(), "bin/sumocode.sh");
	const mockPi = resolve(process.cwd(), "test/integration/fixtures/mock-pi-reload.sh");
	const child: IPty = spawn(launcher, extraArgs, {
		name: "xterm-256color",
		cols: 100,
		rows: 30,
		cwd: process.cwd(),
		env: buildSpawnEnv(process.env, {
			PI_BIN: mockPi,
			SUMO_LEGACY: "1",
			SUMO_TUI: "0",
			SUMOCODE_RELOAD_TEST_STATE: stateFile,
		}),
	});
	let output = "";
	child.onData((data) => {
		output += data;
		if (output.length > 200_000) output = output.slice(-100_000);
	});
	const exit = new Promise<{ exitCode: number; signal?: number }>((resolveExit) => {
		child.onExit((event) => resolveExit(event));
	});
	return {
		child,
		getOutput: () => output,
		exit,
		cleanup(): void {
			try { child.kill("SIGKILL"); } catch { /* already gone */ }
		},
	};
}

let session: PtySession | undefined;
let stateFile: string | undefined;

afterEach(async () => {
	session?.cleanup();
	session = undefined;
	if (stateFile && existsSync(stateFile)) {
		try { unlinkSync(stateFile); } catch { /* swallow */ }
	}
	stateFile = undefined;
});

describe("bin/sumocode.sh reload loop", () => {
	it("re-execs pi with --continue when the inner process exits with code 100", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "sumocode-reload-"));
		stateFile = join(tempDir, "mock-pi.count");
		session = spawnLauncherWithMockPi(stateFile);

		const event = await session.exit;
		const output = session.getOutput();

		// Mock pi was launched twice (loop respawned after exit-100).
		expect(output).toMatch(/RUN-1/);
		expect(output).toMatch(/RUN-2/);

		// Second launch carries `--continue` so the session resumes against fresh code.
		const runTwoLine = output.split(/[\r\n]+/).find((line) => line.includes("RUN-2"));
		expect(runTwoLine).toMatch(/--continue/);
		// And no synthetic empty-string arg trailing it (regression: a previous
		// `"${SUMOCODE_ARGS[@]:-}"` spread inserted `\"\"` after `--continue`).
		expect(runTwoLine).not.toMatch(/--continue\s+$/);
		expect(runTwoLine?.trimEnd()).toMatch(/--continue$/);

		// Final exit code propagates from the second run.
		expect(event.exitCode).toBe(0);

		await rm(tempDir, { recursive: true, force: true });
	}, 15_000);

	it("strips --resume and replaces with --continue on relaunch (one-shot picker becomes in-place resume)", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "sumocode-reload-resume-"));
		stateFile = join(tempDir, "mock-pi.count");
		session = spawnLauncherWithMockPi(stateFile, ["--resume"]);

		const event = await session.exit;
		const output = session.getOutput();

		const runOne = output.split(/[\r\n]+/).find((l) => l.includes("RUN-1"));
		const runTwo = output.split(/[\r\n]+/).find((l) => l.includes("RUN-2"));
		expect(runOne).toMatch(/--resume/);
		expect(runTwo).not.toMatch(/--resume/);
		expect(runTwo).toMatch(/--continue/);
		expect(event.exitCode).toBe(0);

		await rm(tempDir, { recursive: true, force: true });
	}, 15_000);

	it("preserves the inner exit code for any non-100 exit (no respawn)", async () => {
		// Mock-pi exits 100 on first invocation; we verify the second invocation
		// (which exits 0) does NOT trigger a third respawn.
		const tempDir = await mkdtemp(join(tmpdir(), "sumocode-reload-noloop-"));
		stateFile = join(tempDir, "mock-pi.count");
		session = spawnLauncherWithMockPi(stateFile);

		const event = await session.exit;
		const output = session.getOutput();

		// Exactly two invocations, not three.
		expect((output.match(/RUN-1/g) ?? []).length).toBe(1);
		expect((output.match(/RUN-2/g) ?? []).length).toBe(1);
		expect(output).not.toMatch(/RUN-3/);
		expect(event.exitCode).toBe(0);

		await rm(tempDir, { recursive: true, force: true });
	}, 15_000);
});
