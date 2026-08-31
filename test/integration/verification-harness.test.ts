import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	captureTimeoutEvidence,
	HARNESS_OWNER_TOKEN_ENV_KEY,
	HARNESS_SIGNATURE,
	HARNESS_SIGNATURE_ENV_KEY,
	spawnSupervisedProcess,
	waitForDiagnosticReadiness,
	type SupervisedProcess,
} from "./harness-supervisor.js";
import { fixIntegrationPreflight, inspectIntegrationPreflight, processRows } from "../../scripts/preflight-integration.mjs";
import { buildSpawnEnv } from "./spawn-pi-pty.js";

const roots: string[] = [];
const children: SupervisedProcess[] = [];

function spawnLegacyOrphan(ignoreTerm: boolean) {
	const fakeRoot = mkdtempSync(join(tmpdir(), "sumocode-fake-pi-legacy-orphan-"));
	const leaderRoot = mkdtempSync(join(tmpdir(), "sumocode-preflight-group-leader-"));
	roots.push(fakeRoot, leaderRoot);
	const orphanScript = join(fakeRoot, "orphan.mjs");
	const leaderScript = join(leaderRoot, "leader.mjs");
	const pidFile = join(leaderRoot, "orphan.pid");
	writeFileSync(orphanScript, `${ignoreTerm ? 'process.on("SIGTERM", () => {});\n' : ""}setInterval(() => {}, 1_000);\n`);
	writeFileSync(leaderScript, [
		'import { spawn } from "node:child_process";',
		'import { writeFileSync } from "node:fs";',
		`const child = spawn(process.execPath, [${JSON.stringify(orphanScript)}], { stdio: "ignore", env: { PATH: process.env.PATH } });`,
		`writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
		"setInterval(() => {}, 1_000);",
	].join("\n"));
	const launcher = [
		'const { spawn } = require("node:child_process");',
		"const leader = spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH } });",
		"leader.unref();",
		"process.stdout.write(String(leader.pid));",
	].join("\n");
	const leaderPid = Number(execFileSync(process.execPath, ["-e", launcher, leaderScript], { encoding: "utf8" }));
	const deadline = Date.now() + 5_000;
	while (!existsSync(pidFile) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
	if (!existsSync(pidFile)) throw new Error("legacy orphan group leader did not publish its child pid");
	return { leaderPid, orphanPid: Number(readFileSync(pidFile, "utf8")) };
}

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
			[join(process.cwd(), "test/integration/fixtures/harness-process-tree.mjs")],
			{
				env: { ...process.env, SUMOCODE_INTEGRATION_RUN_ROOT: root, SUMOCODE_INTEGRATION_MANIFEST: manifest },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		children.push(child);

		expect(child.shouldCaptureExitFailure(false)).toBe(true);
		const termination = child.terminate();
		expect(child.shouldCaptureExitFailure(false)).toBe(false);
		expect(child.shouldCaptureExitFailure(true)).toBe(true);
		await termination;
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

	it("removes a stale token-owned namespace after its owner exits", async () => {
		const tempRoot = createRunRoot();
		const staleRoot = join(tempRoot, "sumocode-harness-v2-dead-token-owner");
		mkdirSync(staleRoot);
		writeFileSync(join(staleRoot, "owner.json"), `${JSON.stringify({ pid: 2_147_483_647, ownerToken: "dead-owner-token" })}\n`);

		const report = await inspectIntegrationPreflight({ root: process.cwd(), tempRoot, rows: [], env: {} });
		expect(report.issues.find((issue) => issue.code === "stale-harness-state")?.paths).toEqual([staleRoot]);

		await fixIntegrationPreflight(report, {
			rows: [],
			readRows: () => [],
			currentPgid: 999_999,
			kill: () => true,
			wait: async () => {},
		});
		expect(existsSync(staleRoot)).toBe(false);
	});

	it("does not trust a reused live pid without the matching owner token", async () => {
		const tempRoot = createRunRoot();
		const reusedRoot = join(tempRoot, "sumocode-harness-v2-reused-pid");
		mkdirSync(reusedRoot);
		writeFileSync(join(reusedRoot, "owner.json"), `${JSON.stringify({ pid: process.pid, ownerToken: "stale-owner-token" })}\n`);
		const rows = [{ pid: process.pid, ppid: 1, pgid: process.pid, command: "node unrelated-live-process.js" }];

		const report = await inspectIntegrationPreflight({ root: process.cwd(), tempRoot, rows, env: {} });
		expect(report.issues.find((issue) => issue.code === "stale-harness-state")?.paths).toEqual([reusedRoot]);

		await fixIntegrationPreflight(report, {
			rows,
			readRows: () => rows,
			currentPgid: 999_999,
			kill: () => true,
			wait: async () => {},
		});
		expect(existsSync(reusedRoot)).toBe(false);
	});

	it("spares a live namespace when pid and owner token match", async () => {
		const tempRoot = createRunRoot();
		const liveRoot = join(tempRoot, "sumocode-harness-v2-live with space");
		mkdirSync(liveRoot);
		writeFileSync(join(liveRoot, "owner.json"), `${JSON.stringify({ pid: process.pid, ownerToken: "live-owner-token" })}\n`);
		const rows = [{
			pid: process.pid,
			ppid: 1,
			pgid: process.pid,
			command: `${HARNESS_OWNER_TOKEN_ENV_KEY}=live-owner-token node active-test.js`,
		}];

		const report = await inspectIntegrationPreflight({ root: process.cwd(), tempRoot, rows, env: {} });

		expect(report.issues.some((issue) => issue.code === "stale-harness-state")).toBe(false);
		expect(existsSync(liveRoot)).toBe(true);
	});

	it("keeps pid-only owner files compatible and rejects unrelated report paths", async () => {
		const tempRoot = createRunRoot();
		const liveRoot = join(tempRoot, "sumocode-harness-v2-legacy-live");
		const deadRoot = join(tempRoot, "sumocode-harness-v2-legacy-dead");
		const unrelatedRoot = join(tempRoot, "unrelated-dead");
		mkdirSync(liveRoot);
		mkdirSync(deadRoot);
		mkdirSync(unrelatedRoot);
		writeFileSync(join(liveRoot, "owner.json"), `${JSON.stringify({ pid: process.pid })}\n`);
		writeFileSync(join(deadRoot, "owner.json"), `${JSON.stringify({ pid: 2_147_483_647 })}\n`);
		writeFileSync(join(unrelatedRoot, "owner.json"), `${JSON.stringify({ pid: 2_147_483_647 })}\n`);

		const report = await inspectIntegrationPreflight({ root: process.cwd(), tempRoot, rows: [], env: {} });
		const staleIssue = report.issues.find((issue) => issue.code === "stale-harness-state");
		expect(staleIssue?.paths).toEqual([deadRoot]);
		if (staleIssue === undefined) throw new Error("expected stale-harness-state issue");
		staleIssue.paths.push(unrelatedRoot);

		await fixIntegrationPreflight(report, {
			rows: [],
			readRows: () => [],
			currentPgid: 999_999,
			kill: () => true,
			wait: async () => {},
		});
		expect(existsSync(liveRoot)).toBe(true);
		expect(existsSync(deadRoot)).toBe(false);
		expect(existsSync(unrelatedRoot)).toBe(true);
	});

	it("treats children of the current signed harness ancestor as live", async () => {
		const tempRoot = createRunRoot();
		const rows = [
			{ pid: process.pid, ppid: 1, pgid: process.pid, command: `${HARNESS_SIGNATURE_ENV_KEY}=${HARNESS_SIGNATURE} node preflight.js` },
			{ pid: 50501, ppid: process.pid, pgid: 50501, command: `${HARNESS_SIGNATURE_ENV_KEY}=${HARNESS_SIGNATURE} node active-test.js` },
		];

		const report = await inspectIntegrationPreflight({ root: process.cwd(), tempRoot, rows, env: {} });

		expect(report.issues.some((issue) => issue.code === "orphan-harness-children")).toBe(false);
	});

	it("preserves retained failure evidence until --purge-evidence is explicit", async () => {
		const tempRoot = createRunRoot();
		const evidenceRoot = join(tempRoot, "sumocode-harness-v2-failed");
		mkdirSync(evidenceRoot);
		writeFileSync(join(evidenceRoot, "owner.json"), `${JSON.stringify({ pid: 2_147_483_647 })}\n`);
		writeFileSync(join(evidenceRoot, "evidence-retained.json"), `${JSON.stringify({ ownerPid: 2_147_483_647 })}\n`);

		let report = await inspectIntegrationPreflight({ root: process.cwd(), tempRoot, rows: [], env: {} });
		expect(report.issues.some((issue) => issue.code === "stale-harness-state")).toBe(false);
		expect(report.notices).toContain(`retained-evidence: ${evidenceRoot}`);
		await fixIntegrationPreflight(report, { rows: [], currentPgid: 999_999, kill: () => true, wait: async () => {} });
		expect(existsSync(evidenceRoot)).toBe(true);

		report = await inspectIntegrationPreflight({ root: process.cwd(), tempRoot, rows: [], env: {} });
		await fixIntegrationPreflight(report, { purgeEvidence: true, rows: [], currentPgid: 999_999, kill: () => true, wait: async () => {} });
		expect(existsSync(evidenceRoot)).toBe(false);
	});

	for (const testCase of [
		{ name: "TERM-compliant", ignoreTerm: false },
		{ name: "TERM-ignoring", ignoreTerm: true },
	]) {
		it(`lets --fix exit zero on the first pass for a ${testCase.name} legacy orphan without group-killing`, () => {
			const { leaderPid, orphanPid } = spawnLegacyOrphan(testCase.ignoreTerm);
			const env = { ...process.env };
			for (const key of ["SUMOCODE_INTEGRATION_RUN_ROOT", "SUMOCODE_INTEGRATION_MANIFEST", "SUMOCODE_INTEGRATION_PACKAGE_ROOT", HARNESS_OWNER_TOKEN_ENV_KEY, HARNESS_SIGNATURE_ENV_KEY]) delete env[key];

			try {
				expect(execFileSync(process.execPath, ["scripts/preflight-integration.mjs", "--fix"], {
					cwd: process.cwd(),
					env,
					encoding: "utf8",
					timeout: 30_000,
					killSignal: "SIGKILL",
				})).toContain("[integration preflight] clean");
				expect(() => process.kill(orphanPid, 0)).toThrow();
				expect(() => process.kill(leaderPid, 0)).not.toThrow();
			} finally {
				try { process.kill(orphanPid, "SIGKILL"); } catch { /* preflight reaped it */ }
				try { process.kill(leaderPid, "SIGKILL"); } catch { /* leader exited */ }
			}
		});
	}

	it("waits for a TERM-compliant individually signaled orphan without escalation", async () => {
		const tempRoot = createRunRoot();
		const rows = [{ pid: 50901, ppid: 1, pgid: 50900, command: "node /tmp/sumocode-fake-pi-term-compliant/stub" }];
		const report = await inspectIntegrationPreflight({ root: process.cwd(), tempRoot, rows, env: {} });
		const signals: Array<[number, NodeJS.Signals | number]> = [];
		let waits = 0;

		await fixIntegrationPreflight(report, {
			rows,
			readRows: () => [],
			currentPgid: 999_999,
			kill: (pid, signal) => { signals.push([pid, signal ?? 0]); return true; },
			wait: async () => { waits += 1; },
		});

		expect(waits).toBe(1);
		expect(signals).toEqual([[50901, "SIGTERM"]]);
	});

	it("escalates a TERM-ignoring individual orphan by pid without group signals", async () => {
		const tempRoot = createRunRoot();
		const row = { pid: 50911, ppid: 1, pgid: 50900, command: "node /tmp/sumocode-fake-pi-term-ignoring/stub" };
		const report = await inspectIntegrationPreflight({ root: process.cwd(), tempRoot, rows: [row], env: {} });
		const signals: Array<[number, NodeJS.Signals | number]> = [];
		let scans = 0;

		await fixIntegrationPreflight(report, {
			rows: [row],
			readRows: () => { scans += 1; return scans === 1 ? [row] : []; },
			currentPgid: 999_999,
			kill: (pid, signal) => { signals.push([pid, signal ?? 0]); return true; },
			wait: async () => {},
		});

		expect(scans).toBe(2);
		expect(signals).toEqual([[50911, "SIGTERM"], [50911, "SIGKILL"]]);
		expect(signals.every(([pid]) => pid > 0)).toBe(true);
	});

	it("never group-kills the current or a non-harness-owned process group", async () => {
		const tempRoot = createRunRoot();
		const rows = [
			{ pid: 51000, ppid: 1, pgid: 51000, command: "zsh -l" },
			{ pid: 51001, ppid: 51000, pgid: 51000, command: "node /tmp/sumocode-fake-pi-legacy/stub" },
			{ pid: 52000, ppid: 1, pgid: 52000, command: "zsh -l" },
			{ pid: 52001, ppid: 52000, pgid: 52000, command: "node /tmp/sumocode-fake-pi-other/stub" },
			{ pid: 53000, ppid: 1, pgid: 53000, command: `${HARNESS_SIGNATURE_ENV_KEY}=${HARNESS_SIGNATURE} node leader.js` },
			{ pid: 53001, ppid: 53000, pgid: 53000, command: `${HARNESS_SIGNATURE_ENV_KEY}=${HARNESS_SIGNATURE} node child.js` },
		];
		const report = await inspectIntegrationPreflight({ root: process.cwd(), tempRoot, rows, env: {} });
		const signals: Array<[number, NodeJS.Signals | number]> = [];

		await fixIntegrationPreflight(report, {
			rows,
			readRows: () => rows,
			currentPgid: 51000,
			kill: (pid, signal) => { signals.push([pid, signal ?? 0]); return true; },
			wait: async () => {},
		});

		expect(signals).toContainEqual([51001, "SIGTERM"]);
		expect(signals).toContainEqual([52001, "SIGTERM"]);
		expect(signals).not.toContainEqual([-51000, "SIGTERM"]);
		expect(signals).not.toContainEqual([-52000, "SIGTERM"]);
		expect(signals).toContainEqual([-53000, "SIGTERM"]);
		expect(signals).toContainEqual([-53000, "SIGKILL"]);
	});

	it("escalates when a signed descendant survives its group leader", async () => {
		const tempRoot = createRunRoot();
		const rows = [
			{ pid: 53500, ppid: 1, pgid: 53500, command: `${HARNESS_SIGNATURE_ENV_KEY}=${HARNESS_SIGNATURE} node leader.js` },
			{ pid: 53501, ppid: 53500, pgid: 53500, command: `${HARNESS_SIGNATURE_ENV_KEY}=${HARNESS_SIGNATURE} node child.js` },
		];
		const report = await inspectIntegrationPreflight({ root: process.cwd(), tempRoot, rows, env: {} });
		const signals: Array<[number, NodeJS.Signals | number]> = [];

		await fixIntegrationPreflight(report, {
			rows,
			readRows: () => [rows[1]!],
			currentPgid: 999_999,
			kill: (pid, signal) => { signals.push([pid, signal ?? 0]); return true; },
			wait: async () => {},
		});

		expect(signals).toContainEqual([-53500, "SIGTERM"]);
		expect(signals).toContainEqual([-53500, "SIGKILL"]);
	});

	it("does not escalate when only an unsigned descendant survives its group leader", async () => {
		const tempRoot = createRunRoot();
		const rows = [
			{ pid: 54000, ppid: 1, pgid: 54000, command: `${HARNESS_SIGNATURE_ENV_KEY}=${HARNESS_SIGNATURE} node leader.js` },
			{ pid: 54001, ppid: 54000, pgid: 54000, command: `${HARNESS_SIGNATURE_ENV_KEY}=${HARNESS_SIGNATURE} node child.js` },
		];
		const report = await inspectIntegrationPreflight({ root: process.cwd(), tempRoot, rows, env: {} });
		const signals: Array<[number, NodeJS.Signals | number]> = [];

		await fixIntegrationPreflight(report, {
			rows,
			readRows: () => [{ pid: 54001, ppid: 1, pgid: 54000, command: "node unsigned-survivor.js" }],
			currentPgid: 999_999,
			kill: (pid, signal) => { signals.push([pid, signal ?? 0]); return true; },
			wait: async () => {},
		});

		expect(signals).toContainEqual([-54000, "SIGTERM"]);
		expect(signals).not.toContainEqual([-54000, "SIGKILL"]);
	});

	it("leaves no focused namespace before the next preflight", () => {
		const tempRoot = createRunRoot();
		const env = { ...process.env, TMPDIR: tempRoot };
		for (const key of ["SUMOCODE_INTEGRATION_RUN_ROOT", "SUMOCODE_INTEGRATION_MANIFEST", "SUMOCODE_INTEGRATION_PACKAGE_ROOT", HARNESS_OWNER_TOKEN_ENV_KEY, HARNESS_SIGNATURE_ENV_KEY]) delete env[key];
		execFileSync(process.execPath, [
			join(process.cwd(), "node_modules", "vitest", "vitest.mjs"),
			"run",
			"test/integration/fixtures/focused-harness-probe.test.ts",
			"--fileParallelism=false",
		], { cwd: process.cwd(), env, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });

		execFileSync(process.execPath, ["scripts/preflight-integration.mjs"], {
			cwd: process.cwd(),
			env,
			encoding: "utf8",
			timeout: 30_000,
			killSignal: "SIGKILL",
		});
		const focusedNamespaces = readdirSync(tempRoot).filter((name) => name.startsWith("sumocode-harness-v2-focused-"));
		const retainedMarkers = readdirSync(tempRoot, { recursive: true }).filter((name) => name.endsWith("evidence-retained.json"));
		expect(retainedMarkers).toEqual([]);
		expect(focusedNamespaces).toEqual([]);
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
		expect(existsSync(join(root, "evidence-retained.json"))).toBe(true);
	});
});

describe("portable process-table probe", () => {
	const psRow = "  101   1  101 /usr/bin/some-command\n";

	it("falls back to the alternate ps personality when the first form is rejected", () => {
		const attempts: string[][] = [];
		// SAFETY: the fake implements the single (cmd, args, options) call shape
		// processRows uses; the assertion narrows the test double to that seam.
		const execute = ((_cmd: string, args: string[]) => {
			attempts.push(args);
			// First form rejected the way procps rejects BSD `eww` + dashed `-axo`
			// ("must set personality to get -x option") — second form succeeds.
			if (attempts.length === 1) throw new Error("must set personality to get -x option");
			return psRow;
		}) as typeof execFileSync;

		const result = processRows(execute);
		expect(attempts).toHaveLength(2);
		expect(result.issue).toBeUndefined();
		expect(result.rows).toEqual([{ pid: 101, ppid: 1, pgid: 101, command: "/usr/bin/some-command" }]);
	});

	it("degrades to the named process-table issue only when every ps form fails", () => {
		// SAFETY: same seam-shaped test double as above; always throws.
		const execute = (() => {
			throw new Error("ps unavailable");
		}) as typeof execFileSync;

		const result = processRows(execute);
		expect(result.rows).toEqual([]);
		expect(result.issue?.code).toBe("process-table-unavailable");
	});
});
