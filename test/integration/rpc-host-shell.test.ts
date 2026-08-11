import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TERMINAL_CLEANUP_SEQUENCE } from "../../src/sumo-tui/runtime/terminal-controller.js";
import { PI_BOOT_SEQUENCE, spawnPiPty, spawnSumocodePty, type SpawnedPiPty } from "./spawn-pi-pty.js";

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPid(path: string): Promise<number> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		try {
			const pid = Number.parseInt(await readFile(path, "utf8"), 10);
			if (Number.isFinite(pid)) return pid;
		} catch {}
		await delay(10);
	}
	throw new Error(`timed out waiting for child pid file: ${path}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await delay(10);
	}
	throw new Error(`process ${pid} remained alive after host relinquished child ownership`);
}

async function waitForFileText(path: string, expected: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		try {
			if ((await readFile(path, "utf8")) === expected) return;
		} catch {}
		await delay(10);
	}
	throw new Error(`timed out waiting for ${path} to contain ${expected}; output=${app?.getOutput()}`);
}

describe("sumocode RPC host shell integration", () => {
	beforeAll(() => {
		execFileSync(process.execPath, ["scripts/build-host.mjs"], { cwd: process.cwd(), stdio: "pipe" });
	});

	async function bootWithHostMode(mode: "1" | "0"): Promise<void> {
		const agentDir = await mkdtemp(join(tmpdir(), `sumocode-rpc-${mode === "1" ? "bundle" : "jiti"}-agent-`));
		app = spawnSumocodePty({
			env: { PI_CODING_AGENT_DIR: agentDir, SUMOCODE_HOST_BUNDLE: mode },
			cols: 100,
			rows: 30,
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		expect(app.getCurrentTerminalState().altscreenActive).toBe(true);
		app.sendSignal("SIGTERM");
		await app.waitForOutput(TERMINAL_CLEANUP_SEQUENCE, 5_000);
		expect(app.getCurrentTerminalState().altscreenActive).toBe(false);
	}

	it("boots the retained host from the fresh bundle", async () => {
		await bootWithHostMode("1");
	}, 30_000);

	it("reaps the pre-spawned child when forced host main rejects before adoption", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sumocode-rpc-rejected-host-main-"));
		const piBin = join(directory, "stalled-pi");
		const pidFile = join(directory, "pid");
		await writeFile(
			piBin,
			"#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.PID_FILE, String(process.pid));\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n",
			{ mode: 0o700 },
		);
		const bundlePath = join(process.cwd(), "dist/host/sumo-rpc-host.bundle.mjs");
		const original = await readFile(bundlePath);
		await writeFile(bundlePath, 'import { existsSync } from "node:fs"; export async function main() { for (let i = 0; i < 100 && !existsSync(process.env.PID_FILE); i++) await new Promise((resolve) => setTimeout(resolve, 20)); throw new Error("forced main rejection"); }\n');
		try {
			app = spawnSumocodePty({
				env: {
					PI_BIN: piBin,
					PID_FILE: pidFile,
					PI_CODING_AGENT_DIR: join(directory, "agent"),
					SUMOCODE_HOST_BUNDLE: "1",
				},
				cols: 100,
				rows: 30,
			});
			await app.waitForOutput("forced main rejection", 5_000);
			const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
			expect(Number.isFinite(pid)).toBe(true);
			await waitForProcessExit(pid);
		} finally {
			await writeFile(bundlePath, original);
		}
	}, 30_000);

	it("fails instead of source-falling back when the forced bundle cannot import", async () => {
		const bundlePath = join(process.cwd(), "dist/host/sumo-rpc-host.bundle.mjs");
		const original = await readFile(bundlePath);
		await writeFile(bundlePath, "export { this is invalid syntax");
		try {
			const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-broken-forced-bundle-agent-"));
			app = spawnSumocodePty({
				env: { PI_CODING_AGENT_DIR: agentDir, SUMOCODE_HOST_BUNDLE: "1" },
				cols: 100,
				rows: 30,
			});
			await app.waitForOutput("forced host bundle failed to import", 5_000);
			expect(app.getOutput()).not.toContain(PI_BOOT_SEQUENCE);
		} finally {
			await writeFile(bundlePath, original);
		}
	}, 30_000);

	it("boots the retained host through the jiti fallback", async () => {
		await bootWithHostMode("0");
	}, 30_000);

	it("never loads executable host code from the project cwd", async () => {
		const project = await mkdtemp(join(tmpdir(), "sumocode-untrusted-host-project-"));
		const maliciousBundle = join(project, "dist", "host", "sumo-rpc-host.bundle.mjs");
		await mkdir(join(project, "dist", "host"), { recursive: true });
		await writeFile(maliciousBundle, 'export async function main() { process.stdout.write("UNTRUSTED HOST BUNDLE\\n"); }\n');
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-untrusted-host-agent-"));
		app = spawnPiPty({
			command: process.execPath,
			args: [join(process.cwd(), "sumo-rpc-host.js"), "--offline", "--no-extensions", "--no-session"],
			cwd: project,
			env: {
				PI_BIN: join(process.cwd(), "node_modules", ".bin", "pi"),
				PI_CODING_AGENT_DIR: agentDir,
				SUMOCODE_HOST_BUNDLE: "1",
			},
			cols: 100,
			rows: 30,
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		expect(app.getOutput()).not.toContain("UNTRUSTED HOST BUNDLE");
		app.sendSignal("SIGTERM");
		await app.waitForOutput(TERMINAL_CLEANUP_SEQUENCE, 5_000);
	}, 30_000);

	it("falls back to source when the copied spawn helper is stale", async () => {
		const helperPath = join(process.cwd(), "dist/host/spawn-child.mjs");
		const original = await readFile(helperPath);
		await writeFile(helperPath, Buffer.concat([original, Buffer.from("\n// stale copy\n")]));
		try {
			const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-stale-helper-agent-"));
			app = spawnSumocodePty({ env: { PI_CODING_AGENT_DIR: agentDir }, cols: 100, rows: 30 });
			await app.waitForOutput("host bundle stale — using source", 15_000);
			await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		} finally {
			await writeFile(helperPath, original);
		}
	}, 30_000);

	it("falls back to source when tsconfig is newer than the host bundle", async () => {
		const configPath = join(process.cwd(), "tsconfig.json");
		const [original, timestamps] = await Promise.all([readFile(configPath), stat(configPath)]);
		await writeFile(configPath, Buffer.concat([original, Buffer.from("\n")]));
		try {
			const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-stale-tsconfig-agent-"));
			app = spawnSumocodePty({ env: { PI_CODING_AGENT_DIR: agentDir }, cols: 100, rows: 30 });
			await app.waitForOutput("host bundle stale — using source", 15_000);
			await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		} finally {
			await writeFile(configPath, original);
			await utimes(configPath, timestamps.atime, timestamps.mtime);
		}
	}, 30_000);

	it.each(["package.json", "pnpm-lock.yaml"] as const)("falls back to source when %s is newer than the host bundle", async (input) => {
		const inputPath = join(process.cwd(), input);
		const [original, timestamps] = await Promise.all([readFile(inputPath), stat(inputPath)]);
		await writeFile(inputPath, Buffer.concat([original, Buffer.from("\n")]));
		try {
			const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-stale-package-input-agent-"));
			app = spawnSumocodePty({ env: { PI_CODING_AGENT_DIR: agentDir }, cols: 100, rows: 30 });
			await app.waitForOutput("host bundle stale — using source", 15_000);
			await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		} finally {
			await writeFile(inputPath, original);
			await utimes(inputPath, timestamps.atime, timestamps.mtime);
		}
	}, 30_000);

	it.each(["SIGINT", "SIGTERM"] as const)("renders a retained Cathedral empty state and cleans up after %s", async (signal) => {
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-agent-"));
		app = spawnSumocodePty({ env: { PI_CODING_AGENT_DIR: agentDir }, cols: 100, rows: 30 });

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		await app.waitForOutput("DIVINE INVOCATION", 15_000);
		await app.waitForOutput(/CTRL\+\/[\s\S]*COMMANDS/, 15_000);
		await delay(250);

		const output = app.getOutput();
		expect(output).not.toContain("SUMOCODE RPC");
		expect(output).not.toContain("empty transcript");
		expect(output).not.toContain("rpc host");

		const activeState = app.getCurrentTerminalState();
		expect(activeState.altscreenActive).toBe(true);
		expect(activeState.mouseSGRActive).toBe(true);
		expect(activeState.cleanupSequenceSeen).toBe(false);

		app.sendSignal(signal);
		await app.waitForOutput(TERMINAL_CLEANUP_SEQUENCE, 5_000);

		const cleanState = app.getCurrentTerminalState();
		expect(cleanState.cleanupSequenceSeen).toBe(true);
		expect(cleanState.altscreenActive).toBe(false);
		expect(cleanState.mouseSGRActive).toBe(false);
		expect(cleanState.cursorVisible).toBe(true);
	}, 30_000);

	it("ignores stale legacy environment and still boots the RPC host", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-stale-env-agent-"));
		const staleLegacyKey = ["SUMO", "LEGACY"].join("_");
		app = spawnSumocodePty({
			env: { PI_CODING_AGENT_DIR: agentDir, [staleLegacyKey]: "1" },
			cols: 100,
			rows: 30,
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		await app.waitForOutput("DIVINE INVOCATION", 15_000);
		await app.waitForOutput(/CTRL\+\/[\s\S]*COMMANDS/, 15_000);
		await delay(250);

		const output = app.getOutput();
		expect(output).not.toContain("SUMOCODE RPC");
		expect(output).not.toContain("empty transcript");
		expect(output).not.toContain("rpc host");

		const activeState = app.getCurrentTerminalState();
		expect(activeState.altscreenActive).toBe(true);
		expect(activeState.mouseSGRActive).toBe(true);
		expect(activeState.cleanupSequenceSeen).toBe(false);
	}, 30_000);

	it("reaps the pre-spawned child across repeated signals before host adoption", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sumocode-rpc-early-signal-"));
		const piBin = join(directory, "stalled-pi");
		const pidFile = join(directory, "pid");
		const exitCodeFile = join(directory, "exit-code");
		await writeFile(
			piBin,
			"#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nrequire('node:fs').writeFileSync(process.env.PID_FILE, String(process.pid));\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n",
			{ mode: 0o700 },
		);
		app = spawnPiPty({
			command: process.execPath,
			args: [join(process.cwd(), "sumo-rpc-host.js")],
			env: {
				PI_BIN: piBin,
				PID_FILE: pidFile,
				PI_CODING_AGENT_DIR: join(directory, "agent"),
				SUMOCODE_EXIT_CODE_FILE: exitCodeFile,
				SUMOCODE_TEST_PRE_ADOPTION_DELAY_MS: "5000",
				NODE_ENV: "test",
			},
			cols: 100,
			rows: 30,
		});

		const pid = await waitForPid(pidFile);
		app.sendSignal("SIGTERM");
		await delay(50);
		app.sendSignal("SIGTERM");
		await waitForProcessExit(pid);
		await waitForFileText(exitCodeFile, "0");
	}, 30_000);

	it("exits promptly when startup hydration is stalled", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sumocode-rpc-stalled-hydration-"));
		const piBin = join(directory, "stalled-pi");
		await writeFile(piBin, "#!/usr/bin/env node\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n", { mode: 0o700 });
		app = spawnSumocodePty({
			env: { PI_BIN: piBin, PI_CODING_AGENT_DIR: join(directory, "agent") },
			cols: 100,
			rows: 30,
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		app.sendInput("\u001f");
		await delay(100);
		expect(app.getOutput()).not.toContain("host controls");
		app.sendInput("\u0004");
		await app.waitForOutput(TERMINAL_CLEANUP_SEQUENCE, 2_000);
		expect(app.getCurrentTerminalState().altscreenActive).toBe(false);
	}, 30_000);

	it("accepts editor input while startup hydration is pending", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-early-input-agent-"));
		app = spawnSumocodePty({ env: { PI_CODING_AGENT_DIR: agentDir }, cols: 100, rows: 30 });

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		app.sendInput("hello");
		await app.waitForOutput("hello", 2_000);

		// This test owns only the early-input contract. Ctrl-C has separate
		// draft-clearing semantics (first press clears non-empty input), so using
		// it for cleanup made the test race hydration and assert the wrong owner.
		app.sendSignal("SIGTERM");
		await app.waitForOutput(TERMINAL_CLEANUP_SEQUENCE, 5_000);
		expect(app.getCurrentTerminalState().altscreenActive).toBe(false);
	}, 30_000);

	it("opens the host command palette from Ctrl+/", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-palette-agent-"));
		app = spawnSumocodePty({ env: { PI_CODING_AGENT_DIR: agentDir }, cols: 100, rows: 30 });

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		await app.waitForOutput("DIVINE INVOCATION", 15_000);
		await app.waitForOutput(/CTRL\+\/[\s\S]*COMMANDS/, 15_000);
		app.sendInput("\u001f");

		await app.waitForOutput("host controls", 10_000);
	}, 30_000);
});
