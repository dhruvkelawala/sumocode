import { execFileSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TERMINAL_CLEANUP_SEQUENCE } from "../../src/sumo-tui/runtime/terminal-controller.js";
import { PI_BOOT_SEQUENCE, replayScreenRows, spawnPiPty, spawnSumocodePty, type SpawnedPiPty } from "./spawn-pi-pty.js";
import { createRpcChildFixture } from "./rpc-child-fixture.js";
import { hostOutputsHash } from "../../scripts/lib/host-bundle.mjs";

const CSI_U_ENTER = "\x1b[13u";

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
	for (let attempt = 0; attempt < 500; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await delay(10);
	}
	throw new Error(`process ${pid} remained alive after host relinquished child ownership`);
}

async function waitForFileText(path: string, expected: string, attempts = 200): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
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
		execFileSync(process.execPath, ["scripts/build-extension.mjs"], { cwd: process.cwd(), stdio: "pipe" });
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

	it("pre-spawns Pi before a slow host-bundle freshness scan", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sumocode-rpc-slow-bundle-scan-"));
		const piBin = join(directory, "stalled-pi");
		const pidFile = join(directory, "pid");
		await writeFile(
			piBin,
			"#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.PID_FILE, String(process.pid));\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n",
			{ mode: 0o700 },
		);
		const startedAt = Date.now();
		app = spawnPiPty({
			command: process.execPath,
			args: [join(process.cwd(), "sumo-rpc-host.js")],
			env: {
				PI_BIN: piBin,
				PID_FILE: pidFile,
				PI_CODING_AGENT_DIR: join(directory, "agent"),
				NODE_ENV: "test",
				SUMOCODE_TEST_BUNDLE_SCAN_DELAY_MS: "3000",
			},
			cols: 100,
			rows: 30,
		});

		const pid = await waitForPid(pidFile);
		expect(Date.now() - startedAt).toBeLessThan(2_000);
		app.sendSignal("SIGTERM");
		await waitForProcessExit(pid);
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
			app = spawnPiPty({
				command: process.execPath,
				args: [join(process.cwd(), "sumo-rpc-host.js")],
				env: {
					PI_BIN: piBin,
					PID_FILE: pidFile,
					PI_CODING_AGENT_DIR: join(directory, "agent"),
					SUMOCODE_HOST_BUNDLE: "1",
					SUMOCODE_RELOAD: "1",
				},
				cols: 100,
				rows: 30,
			});
			await app.waitForOutput("forced main rejection", 5_000);
			expect(app.getOutput()).toContain(TERMINAL_CLEANUP_SEQUENCE);
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
			app = spawnPiPty({
				command: process.execPath,
				args: [join(process.cwd(), "sumo-rpc-host.js")],
				env: { PI_CODING_AGENT_DIR: agentDir, SUMOCODE_HOST_BUNDLE: "1", SUMOCODE_RELOAD: "1" },
				cols: 100,
				rows: 30,
			});
			await app.waitForOutput("forced host bundle failed to import", 5_000);
			expect(app.getOutput()).not.toContain(PI_BOOT_SEQUENCE);
			expect(app.getOutput()).toContain(TERMINAL_CLEANUP_SEQUENCE);
		} finally {
			await writeFile(bundlePath, original);
		}
	}, 30_000);

	it("falls back to source when a fresh host bundle omits main", async () => {
		const bundlePath = join(process.cwd(), "dist/host/sumo-rpc-host.bundle.mjs");
		const manifestPath = join(process.cwd(), "dist/host/.inputs.json");
		const original = await readFile(bundlePath);
		const originalManifest = await readFile(manifestPath);
		await writeFile(bundlePath, "export const incomplete = true;\n");
		// Repoint the manifest's outputsHash at the incomplete bundle so it passes
		// the freshness/output-integrity checks, isolating the "no main()" guard.
		const manifest = JSON.parse(originalManifest.toString()) as { outputsHash: string };
		manifest.outputsHash = await hostOutputsHash(process.cwd());
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		try {
			const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-incomplete-bundle-agent-"));
			app = spawnSumocodePty({ env: { PI_CODING_AGENT_DIR: agentDir }, cols: 100, rows: 30 });
			await app.waitForOutput("host bundle does not export main", 5_000);
			await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		} finally {
			await writeFile(bundlePath, original);
			await writeFile(manifestPath, originalManifest);
		}
	}, 30_000);

	it("boots the retained host through the jiti fallback", async () => {
		await bootWithHostMode("0");
	}, 30_000);

	it("does not paint the splash while a populated session reload hydrates", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sumocode-rpc-reload-screen-"));
		const piBin = join(directory, "reload-pi.cjs");
		const runFile = join(directory, "run-count");
		const secondHydrationFile = join(directory, "second-hydration");
		await writeFile(piBin, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const runFile = process.env.RUN_FILE;
let run = 0;
try { run = Number.parseInt(fs.readFileSync(runFile, "utf8"), 10) || 0; } catch {}
run += 1;
fs.writeFileSync(runFile, String(run));
const messages = [
  { id: "reload-user", role: "user", content: "reload question" },
  { id: "reload-assistant", role: "assistant", content: "reload answer" }
];
function write(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
function respond(command, data) { write({ type: "response", id: command.id, command: command.type, success: true, data }); }
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_state") {
    respond(command, { model: { provider: "openai", id: "gpt-5", name: "GPT-5" }, thinkingLevel: "medium", isStreaming: false, isCompacting: false, sessionId: "reload-session", sessionName: "Reload Session", messageCount: messages.length, pendingMessageCount: 0 });
    return;
  }
  if (command.type === "get_messages") {
    if (run === 2) {
      fs.writeFileSync(process.env.SECOND_HYDRATION_FILE, "waiting");
      setTimeout(() => respond(command, { messages }), 2000);
    } else respond(command, { messages });
    return;
  }
  if (command.type === "get_commands") { respond(command, { commands: [] }); return; }
  if (command.type === "get_session_stats") {
    respond(command, { totalMessages: messages.length, tokens: { total: 1200 }, contextUsage: { tokens: 1200, contextWindow: 200000 }, cost: 0 });
    if (run === 1) setTimeout(() => process.exit(100), 100);
    return;
  }
  respond(command, {});
});
`, { mode: 0o700 });

		app = spawnSumocodePty({
			env: {
				PI_BIN: piBin,
				PI_CODING_AGENT_DIR: join(directory, "agent"),
				RUN_FILE: runFile,
				SECOND_HYDRATION_FILE: secondHydrationFile,
			},
			cols: 100,
			rows: 30,
		});

		await waitForFileText(secondHydrationFile, "waiting", 1_500);
		const output = app.getOutput();
		const screen = (await replayScreenRows(output, 100, 30)).join("\n");
		expect(screen).not.toMatch(/█████ █   █ █   █ █████/);
		expect(screen).toContain("reload answer");
		// Reload is a retained-frame handoff, not a terminal teardown/re-entry.
		expect((output.match(/\x1b\[\?1049h/g) ?? []).length).toBe(1);
	}, 30_000);

	it("never loads executable host code from the project cwd", async () => {
		const project = await mkdtemp(join(tmpdir(), "sumocode-untrusted-host-project-"));
		const maliciousBundle = join(project, "dist", "host", "sumo-rpc-host.bundle.mjs");
		const maliciousCacheModule = join(project, "src", "sumo-tui", "rpc", "chrome-cache.ts");
		const maliciousMarker = join(project, "untrusted-cache-loaded");
		await mkdir(join(project, "dist", "host"), { recursive: true });
		await mkdir(join(project, "src", "sumo-tui", "rpc"), { recursive: true });
		await writeFile(maliciousBundle, 'export async function main() { process.stdout.write("UNTRUSTED HOST BUNDLE\\n"); }\n');
		await writeFile(maliciousCacheModule, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(maliciousMarker)}, "loaded");\nexport const readCachedChrome = () => undefined;\nexport const writeCachedChrome = () => undefined;\n`);
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
		await delay(1_000);
		expect(app.getOutput()).not.toContain("UNTRUSTED HOST BUNDLE");
		await expect(readFile(maliciousMarker, "utf8")).rejects.toThrow();
		app.sendSignal("SIGTERM");
		await app.waitForOutput(TERMINAL_CLEANUP_SEQUENCE, 5_000);
	}, 30_000);

	async function bootWithExtensionMode(mode: "bundle" | "source"): Promise<void> {
		const agentDir = await mkdtemp(join(tmpdir(), `sumocode-extension-${mode}-agent-`));
		app = spawnSumocodePty({
			args: ["--offline", "--no-session", "--approve"],
			env: {
				PI_CODING_AGENT_DIR: agentDir,
				...(mode === "source" ? { SUMOCODE_EXTENSION_BUNDLE: "0" } : {}),
			},
			cols: 100,
			rows: 30,
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		await app.waitForOutput("DIVINE INVOCATION", 15_000);
		await app.waitForOutput(/CTRL\+\/[\s\S]*COMMANDS/, 15_000);
	}

	it.each([
		["fresh extension bundle", "bundle"],
		["extension source fallback", "source"],
	] as const)("boots with the %s", async (_label, mode) => {
		await bootWithExtensionMode(mode);
	}, 30_000);

	it.each(["bundle", "source"] as const)("loads %s from a peer-only package copy with no local node_modules", async (mode) => {
		const packageRoot = await mkdtemp(join(tmpdir(), `sumocode-peer-only-${mode}-package-`));
		await mkdir(join(packageRoot, "dist"), { recursive: true });
		await mkdir(join(packageRoot, "scripts", "lib"), { recursive: true });
		await Promise.all([
			cp(join(process.cwd(), "src"), join(packageRoot, "src"), { recursive: true }),
			cp(join(process.cwd(), "dist", "extension"), join(packageRoot, "dist", "extension"), { recursive: true }),
			cp(join(process.cwd(), "scripts", "build-extension.mjs"), join(packageRoot, "scripts", "build-extension.mjs")),
			cp(join(process.cwd(), "scripts", "lib", "extension-bundle.mjs"), join(packageRoot, "scripts", "lib", "extension-bundle.mjs")),
			cp(join(process.cwd(), "package.json"), join(packageRoot, "package.json")),
			cp(join(process.cwd(), "tsconfig.json"), join(packageRoot, "tsconfig.json")),
		]);
		await expect(access(join(packageRoot, "node_modules"))).rejects.toThrow();
		await expect(access(join(packageRoot, "pnpm-lock.yaml"))).rejects.toThrow();
		const agentDir = await mkdtemp(join(tmpdir(), `sumocode-peer-only-${mode}-agent-`));
		app = spawnPiPty({
			args: ["--offline", "--no-extensions", "--no-session", "--approve", "-e", packageRoot],
			env: {
				PI_CODING_AGENT_DIR: agentDir,
				...(mode === "source" ? { SUMOCODE_EXTENSION_BUNDLE: "0" } : {}),
			},
			cols: 100,
			rows: 30,
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		await app.waitForOutput("DIVINE INVOCATION", 15_000);
		expect(app.getOutput()).not.toContain("extension bundle failed to import");
	}, 30_000);

	it.each(["bundle", "source"] as const)("boots the package manifest through the stable extension entry (%s)", async (mode) => {
		const agentDir = await mkdtemp(join(tmpdir(), `sumocode-package-entry-${mode}-agent-`));
		app = spawnPiPty({
			args: ["--offline", "--no-extensions", "--no-session", "--approve", "-e", "."],
			env: {
				PI_CODING_AGENT_DIR: agentDir,
				...(mode === "source" ? { SUMOCODE_EXTENSION_BUNDLE: "0" } : {}),
			},
			cols: 100,
			rows: 30,
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		await app.waitForOutput("DIVINE INVOCATION", 15_000);
		await app.waitForOutput(/CTRL\+[\s\S]*COMMANDS/, 15_000);
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

	it("falls back to source when the published host bundle bytes do not match the manifest", async () => {
		const tamperBundlePath = join(process.cwd(), "dist/host/sumo-rpc-host.bundle.mjs");
		const original = await readFile(tamperBundlePath);
		// Simulate a concurrent build's interleaved bundle: the input manifest is
		// unchanged, but the recorded outputsHash no longer matches these bytes.
		await writeFile(tamperBundlePath, Buffer.concat([original, Buffer.from("\n// interleaved build\n")]));
		try {
			const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-tampered-bundle-agent-"));
			app = spawnSumocodePty({ env: { PI_CODING_AGENT_DIR: agentDir }, cols: 100, rows: 30 });
			await app.waitForOutput("host bundle stale — using source", 15_000);
			await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		} finally {
			await writeFile(tamperBundlePath, original);
		}
	}, 30_000);

	it("falls back to source when a recorded host input has been deleted", async () => {
		const manifestPath = join(process.cwd(), "dist", "host", ".inputs.json");
		const original = await readFile(manifestPath);
		const manifest = JSON.parse(original.toString()) as { inputs: string[] };
		manifest.inputs = [...manifest.inputs, "src/deleted-production-input.ts"].sort();
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		try {
			const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-deleted-host-input-agent-"));
			app = spawnSumocodePty({ env: { PI_CODING_AGENT_DIR: agentDir }, cols: 100, rows: 30 });
			await app.waitForOutput("host bundle stale — using source", 15_000);
			await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		} finally {
			await writeFile(manifestPath, original);
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

	it("dispatches a queued prompt only after a deferred model cycle applies", async () => {
		const logDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-model-cycle-order-"));
		const logPath = join(logDir, "commands.jsonl");
		const piBin = await createRpcChildFixture("sumocode-rpc-model-cycle-child-", {
			initialHydrationRace: true,
			initialHydrationDelayMs: 2_500,
		});
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-model-cycle-agent-"));
		app = spawnSumocodePty({
			env: { PI_BIN: piBin, PI_CODING_AGENT_DIR: agentDir, SUMOCODE_RPC_FIXTURE_LOG: logPath },
			cols: 100,
			rows: 30,
		});

		// The splash editor accepts input before hydration completes; wait for it so
		// the child stdin is reading, then act inside the 2.5s hydration window.
		await app.waitForOutput(/CTRL\+\/[\s\S]*COMMANDS/, 15_000);
		// Cycle the model (Ctrl+P, kitty encoding) then submit a prompt. The submit
		// must wait for the deferred cycle's set_model to apply.
		app.sendInput("\x1b[112;5u");
		await delay(50);
		app.sendInput(`hello world${CSI_U_ENTER}`);
		await app.waitForOutput("fixture response complete: hello world", 15_000);

		const log = (await readFile(logPath, "utf8")).trim().split("\n")
			.map((line) => JSON.parse(line) as { type: string; provider?: string; modelId?: string; message?: string });
		const setModelIndex = log.findIndex((command) => command.type === "set_model");
		const promptIndex = log.findIndex((command) => command.type === "prompt" && command.message === "hello world");
		expect(setModelIndex).toBeGreaterThanOrEqual(0);
		expect(promptIndex).toBeGreaterThanOrEqual(0);
		expect(setModelIndex).toBeLessThan(promptIndex);
		expect(log[setModelIndex]).toMatchObject({ provider: "anthropic", modelId: "claude-opus-4" });
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

	it("never adopts or enters altscreen when a signal lands in the import-tail window", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sumocode-rpc-import-tail-signal-"));
		const piBin = join(directory, "stalled-pi");
		const pidFile = join(directory, "pid");
		const exitCodeFile = join(directory, "exit-code");
		// The child ignores SIGTERM, so early cleanup must escalate to SIGKILL while
		// the import-tail window is held open — the exact overlap with adoption.
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
				SUMOCODE_TEST_PRE_MAIN_DELAY_MS: "5000",
				NODE_ENV: "test",
			},
			cols: 100,
			rows: 30,
		});

		const pid = await waitForPid(pidFile);
		app.sendSignal("SIGTERM");
		await waitForProcessExit(pid);
		await waitForFileText(exitCodeFile, "0");
		// Adoption never happened, so the retained runtime/altscreen never started.
		expect(app.getOutput()).not.toContain("\x1b[?1049h");
		expect(app.getCurrentTerminalState().altscreenActive).toBe(false);
	}, 30_000);

	it("never adopts or enters altscreen when a signal lands during main() pre-adoption setup", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sumocode-rpc-pre-adoption-main-signal-"));
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
				// main() reaches its pre-adoption setup, then holds so the signal lands
				// after the entry guard but before SumoRpcClient adopts the child.
				SUMOCODE_TEST_PRE_ADOPTION_MAIN_DELAY_MS: "5000",
				NODE_ENV: "test",
			},
			cols: 100,
			rows: 30,
		});

		const pid = await waitForPid(pidFile);
		app.sendSignal("SIGTERM");
		await waitForProcessExit(pid);
		await waitForFileText(exitCodeFile, "0");
		expect(app.getOutput()).not.toContain("\x1b[?1049h");
		expect(app.getCurrentTerminalState().altscreenActive).toBe(false);
	}, 30_000);

	it("reaps an adopted SIGTERM-ignoring child across repeated signals", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sumocode-rpc-adopted-repeat-signal-"));
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
			},
			cols: 100,
			rows: 30,
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		const pid = await waitForPid(pidFile);
		app.sendSignal("SIGTERM");
		await delay(50);
		app.sendSignal("SIGTERM");
		await waitForProcessExit(pid);
		await waitForFileText(exitCodeFile, "0");
	}, 30_000);

	it("restores altscreen when shutdown starts during adopted branch lookup", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sumocode-rpc-adopted-branch-signal-"));
		const piBin = join(directory, "stalled-pi");
		const gitBin = join(directory, "git");
		const pidFile = join(directory, "pid");
		const gitStartedFile = join(directory, "git-started");
		const exitCodeFile = join(directory, "exit-code");
		await writeFile(
			piBin,
			"#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nrequire('node:fs').writeFileSync(process.env.PID_FILE, String(process.pid));\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n",
			{ mode: 0o700 },
		);
		await writeFile(
			gitBin,
			"#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.GIT_STARTED_FILE, 'started');\nsetTimeout(() => process.stdout.write('main\\n'), 1500);\n",
			{ mode: 0o700 },
		);
		app = spawnPiPty({
			command: process.execPath,
			args: [join(process.cwd(), "sumo-rpc-host.js")],
			env: {
				PI_BIN: piBin,
				PID_FILE: pidFile,
				GIT_STARTED_FILE: gitStartedFile,
				PI_CODING_AGENT_DIR: join(directory, "agent"),
				SUMOCODE_EXIT_CODE_FILE: exitCodeFile,
				PATH: `${directory}:${process.env.PATH ?? ""}`,
			},
			cols: 100,
			rows: 30,
		});

		const pid = await waitForPid(pidFile);
		await waitForFileText(gitStartedFile, "started", 1_000);
		await app.waitForOutput("\x1b[?1049h", 5_000);
		app.sendSignal("SIGTERM");
		await waitForProcessExit(pid);
		await waitForFileText(exitCodeFile, "0");
		const terminal = app.getCurrentTerminalState();
		expect(terminal.altscreenActive).toBe(false);
		expect(terminal.cleanupSequenceSeen).toBe(true);
	}, 30_000);

	it("hydrates before optional branch metadata resolves", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sumocode-rpc-async-branch-hydration-"));
		const piBin = await createRpcChildFixture("sumocode-rpc-async-branch-child-", {
			initialHydrationRace: true,
			initialHydrationDelayMs: 50,
		});
		const gitBin = join(directory, "git");
		const gitStartedFile = join(directory, "git-started");
		const gitFinishedFile = join(directory, "git-finished");
		await writeFile(
			gitBin,
			"#!/usr/bin/env node\nconst fs = require('node:fs');\nif (process.argv.includes('--show-current')) {\n  fs.writeFileSync(process.env.GIT_STARTED_FILE, 'started');\n  setTimeout(() => { fs.writeFileSync(process.env.GIT_FINISHED_FILE, 'finished'); process.stdout.write('main\\n'); }, 1800);\n} else {\n  process.stdout.write('.git/HEAD\\n');\n}\n",
			{ mode: 0o700 },
		);
		app = spawnPiPty({
			command: process.execPath,
			args: [join(process.cwd(), "sumo-rpc-host.js")],
			env: {
				PI_BIN: piBin,
				GIT_STARTED_FILE: gitStartedFile,
				GIT_FINISHED_FILE: gitFinishedFile,
				PI_CODING_AGENT_DIR: join(directory, "agent"),
				PATH: `${directory}:${process.env.PATH ?? ""}`,
			},
			cols: 100,
			rows: 30,
		});

		await waitForFileText(gitStartedFile, "started", 1_000);
		await app.waitForOutput("initial race completed", 5_000);
		await expect(readFile(gitFinishedFile, "utf8")).rejects.toThrow();
		await waitForFileText(gitFinishedFile, "finished", 1_000);
		app.sendSignal("SIGTERM");
		await app.waitForOutput(TERMINAL_CLEANUP_SEQUENCE, 5_000);
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

	it("handles /quit while startup hydration is stalled", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sumocode-rpc-stalled-quit-"));
		const piBin = join(directory, "stalled-pi");
		await writeFile(piBin, "#!/usr/bin/env node\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n", { mode: 0o700 });
		app = spawnSumocodePty({
			env: { PI_BIN: piBin, PI_CODING_AGENT_DIR: join(directory, "agent") },
			cols: 100,
			rows: 30,
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		app.sendInput(`/quit${CSI_U_ENTER}`);
		await app.waitForOutput(TERMINAL_CLEANUP_SEQUENCE, 3_000);
		expect(app.getCurrentTerminalState().altscreenActive).toBe(false);
	}, 30_000);

	it("replays only the latest mutually exclusive selector after hydration", async () => {
		const piBin = await createRpcChildFixture("sumocode-rpc-deferred-selector-", {
			initialHydrationRace: true,
			initialHydrationDelayMs: 750,
		});
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-deferred-selector-agent-"));
		app = spawnSumocodePty({ env: { PI_BIN: piBin, PI_CODING_AGENT_DIR: agentDir }, cols: 100, rows: 30 });

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		app.sendInput("\u001f");
		app.sendInput("\u000c");
		await app.waitForOutput("initial race completed", 5_000);
		await delay(250);
		expect(app.getOutput()).not.toContain("host controls");
		app.sendSignal("SIGTERM");
		await app.waitForOutput(TERMINAL_CLEANUP_SEQUENCE, 5_000);
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
