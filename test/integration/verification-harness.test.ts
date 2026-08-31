import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	captureTimeoutEvidence,
	spawnSupervisedProcess,
	waitForDiagnosticReadiness,
	type SupervisedProcess,
} from "./harness-supervisor.js";
import { inspectIntegrationPreflight } from "../../scripts/preflight-integration.mjs";
import { buildSpawnEnv } from "./spawn-pi-pty.js";

const roots: string[] = [];
const children: SupervisedProcess[] = [];

function createRunRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "sumocode-harness-v2-test-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(children.splice(0).map((child) => child.terminate()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("verification harness v2 seam", () => {
	it("constructs child env from an allowlist and pins run-scoped state", () => {
		const root = createRunRoot();
		const env = buildSpawnEnv(
			{
				PATH: "/usr/bin",
				HOME: "/Users/test",
				LANG: "en_US.UTF-8",
				NODE_PATH: "/other/worktree/node_modules",
				NODE_COMPILE_CACHE: "/other/worktree/cache",
				HERDR_ENV: "1",
				PI_SESSION_ID: "ambient-session",
				UNRELATED_AMBIENT_VALUE: "poison",
				SUMOCODE_INTEGRATION_RUN_ROOT: root,
			},
			{ TEST_SYNTHETIC_VALUE: "kept" },
		);

		expect(env).toMatchObject({
			PATH: "/usr/bin",
			HOME: "/Users/test",
			LANG: "en_US.UTF-8",
			NODE_COMPILE_CACHE: join(root, "node-compile-cache"),
			TMPDIR: join(root, "tmp"),
			TEST_SYNTHETIC_VALUE: "kept",
		});
		expect(env.NODE_PATH).toBeUndefined();
		expect(env.HERDR_ENV).toBeUndefined();
		expect(env.PI_SESSION_ID).toBeUndefined();
		expect(env.UNRELATED_AMBIENT_VALUE).toBeUndefined();
	});

	it("supervises and reaps a whole process group while recording the manifest", async () => {
		const root = createRunRoot();
		const manifest = join(root, "children.jsonl");
		const child = spawnSupervisedProcess(
			process.execPath,
			["-e", "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); setInterval(()=>{},1000)"],
			{
				env: { ...process.env, SUMOCODE_INTEGRATION_RUN_ROOT: root, SUMOCODE_INTEGRATION_MANIFEST: manifest },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		children.push(child);

		await child.terminate();
		expect(() => process.kill(-child.pgid, 0)).toThrow();
		// SAFETY: the manifest is written by the harness in this test and only the asserted event/pid fields are consumed.
		const events = readFileSync(manifest, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { event: string; pid: number });
		expect(events).toContainEqual(expect.objectContaining({ event: "spawn", pid: child.child.pid }));
		expect(events).toContainEqual(expect.objectContaining({ event: "exit", pid: child.child.pid }));
	});

	it("waits on the extensible diagnostic readiness table", async () => {
		const root = createRunRoot();
		const diag = join(root, "diag.jsonl");
		writeFileSync(diag, `${JSON.stringify({ event: "boot_screen_frame" })}\n`);
		setTimeout(() => writeFileSync(diag, `${JSON.stringify({ event: "input_ready" })}\n`, { flag: "a" }), 20);

		await expect(waitForDiagnosticReadiness(diag, "input", 500)).resolves.toMatchObject({ event: "input_ready" });
	});

	it("names harness-owned orphan processes without matching unrelated children", async () => {
		const tempRoot = createRunRoot();
		const report = await inspectIntegrationPreflight({
			root: process.cwd(),
			tempRoot,
			rows: [
				{ pid: 41001, ppid: 1, pgid: 41001, command: "bash /tmp/sumocode-fake-pi-owned/stub" },
				{ pid: 41002, ppid: 1, pgid: 41002, command: "node unrelated-server.js" },
			],
			env: {},
		});

		expect(report.issues).toContainEqual(expect.objectContaining({
			code: "orphan-harness-children",
			message: expect.stringContaining("41001"),
		}));
		expect(JSON.stringify(report)).not.toContain("41002");
	});

	it("writes argv, stderr, diagnostics, and the final screen on timeout", async () => {
		const root = createRunRoot();
		const evidenceDir = join(root, "evidence", "timeout-case");
		const diag = join(root, "diag.jsonl");
		const stderr = join(root, "stderr.log");
		writeFileSync(diag, `${JSON.stringify({ event: "boot_screen_frame" })}\n`);
		writeFileSync(stderr, "activation failed: Tool terminal_start not found\n");

		const path = await captureTimeoutEvidence({
			evidenceDir,
			argv: ["pi", "--mode", "rpc"],
			stderrPath: stderr,
			diagPath: diag,
			output: "raw terminal bytes",
			finalScreen: "READY\nfinal frame",
		});

		expect(path).toBe(evidenceDir);
		expect(readFileSync(join(evidenceDir, "argv.txt"), "utf8")).toContain("pi --mode rpc");
		expect(readFileSync(join(evidenceDir, "stderr-tail.txt"), "utf8")).toContain("activation failed");
		expect(readFileSync(join(evidenceDir, "diagnostics.jsonl"), "utf8")).toContain("boot_screen_frame");
		expect(readFileSync(join(evidenceDir, "final-screen.txt"), "utf8")).toContain("final frame");
	});
});
