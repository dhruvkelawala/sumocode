import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	captureTimeoutEvidence,
	HARNESS_OWNER_TOKEN_ENV_KEY,
	HARNESS_RUN_ID_ENV_KEY,
	HARNESS_SIGNATURE,
	HARNESS_SIGNATURE_ENV_KEY,
	HARNESS_SIGNING_KEY_ENV_KEY,
	spawnSupervisedProcess,
	waitForDiagnosticReadiness,
	type SupervisedProcess,
} from "./harness-supervisor.js";
import {
	EXTENSION_INPUT_MANIFEST_VERSION,
	EXTENSION_RUNTIME_OUTPUTS,
	extensionInputsHashFromManifest,
	extensionOutputsHash,
} from "../../scripts/lib/extension-bundle.mjs";
import { signSpawnRegistration } from "../../scripts/lib/integration-harness-auth.mjs";
import { fixIntegrationPreflight, inspectIntegrationPreflight, processRows, reapHarnessProcessGroup } from "../../scripts/preflight-integration.mjs";
import { manifestProcessGroups, resolveHarnessExitCode } from "../../scripts/run-integration-harness.mjs";
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
				[HARNESS_SIGNING_KEY_ENV_KEY]: "worker-only-secret",
				[HARNESS_RUN_ID_ENV_KEY]: "worker-only-run-id",
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
		expect(env[HARNESS_SIGNING_KEY_ENV_KEY]).toBeUndefined();
		expect(env[HARNESS_RUN_ID_ENV_KEY]).toBeUndefined();
	});

	it("reaps a title-changing child through the public supervised spawn seam", async () => {
		const child = spawnSupervisedProcess(
			process.execPath,
			[join(process.cwd(), "test/integration/fixtures/title-changing-harness-child.mjs")],
			{
				env: { ...process.env },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		children.push(child);
		const childEnv = await new Promise<{ hasOwnerToken: boolean; hasSignature: boolean; hasSigningKey: boolean }>((resolveReady, rejectReady) => {
			const timer = setTimeout(() => rejectReady(new Error("title-changing child did not become ready")), 5_000);
			child.child.stdout?.once("data", (data) => {
				clearTimeout(timer);
				resolveReady(JSON.parse(String(data)));
			});
		});
		expect(childEnv).toEqual({ hasOwnerToken: true, hasSignature: true, hasSigningKey: false });

		const command = execFileSync("ps", ["eww", "-p", String(child.pid), "-o", "command="], { encoding: "utf8" });
		expect(command).not.toContain(`${HARNESS_SIGNATURE_ENV_KEY}=${HARNESS_SIGNATURE}`);

		expect(child.shouldCaptureExitFailure(false)).toBe(true);
		const termination = child.terminate();
		expect(child.shouldCaptureExitFailure(false)).toBe(false);
		expect(child.shouldCaptureExitFailure(true)).toBe(true);
		await termination;
		expect(() => process.kill(-child.pgid, 0)).toThrow();
		const root = resolve(child.evidence.evidenceDir, "../../..");
		const manifest = process.env.SUMOCODE_INTEGRATION_MANIFEST ?? join(root, "children.jsonl");
		// SAFETY: the manifest is written by the harness in this test and only the asserted registration fields are consumed.
		const events = readFileSync(manifest, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
			event: string;
			pid: number;
			ownerPid?: number;
			ownerProcessStart?: string;
			runId?: string;
			registrationHmac?: string;
			ownershipMode?: string;
		});
		expect(events).toContainEqual(expect.objectContaining({
			event: "spawn",
			pid: child.child.pid,
			ownerPid: process.pid,
			ownerProcessStart: expect.any(String),
			runId: expect.any(String),
			registrationHmac: expect.stringMatching(/^[a-f\d]{64}$/),
			ownershipMode: process.env.SUMOCODE_INTEGRATION_RUN_ROOT === undefined ? "focused" : "shared",
		}));
		expect(events).toContainEqual(expect.objectContaining({ event: "exit", pid: child.child.pid }));
	});

	it("reports a dead run's title-hidden survivor by identity and never signals it from --fix", async () => {
		const child = spawnSupervisedProcess(
			process.execPath,
			[join(process.cwd(), "test/integration/fixtures/title-changing-harness-child.mjs")],
			{ env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
		);
		children.push(child);
		await new Promise<void>((resolveReady, rejectReady) => {
			const timer = setTimeout(() => rejectReady(new Error("title-changing child did not become ready")), 5_000);
			child.child.stdout?.once("data", () => {
				clearTimeout(timer);
				resolveReady();
			});
		});

		const root = resolve(child.evidence.evidenceDir, "../../..");
		// A run whose owner is gone: the child is reparented and its owner row is absent.
		const withoutOwnerPath = () => processRows().rows
			.filter((row) => row.pid !== process.pid)
			.map((row) => row.pid === child.pid ? { ...row, ppid: 1 } : row);
		const report = await inspectIntegrationPreflight({
			root: process.cwd(),
			tempRoot: resolve(root, ".."),
			rows: withoutOwnerPath(),
			env: {},
		});
		const orphanIssue = report.issues.find((issue) => issue.code === "orphan-harness-children");
		expect(orphanIssue?.rows).toContainEqual(expect.objectContaining({ pid: child.pid, command: "pi" }));
		// The survivor is named with its immutable identity for a human to act on.
		expect(orphanIssue?.registeredSurvivors).toContainEqual(expect.objectContaining({ pid: child.pid, pgid: child.pgid }));
		expect(orphanIssue?.remediation).toContain(`pid ${child.pid} pgid ${child.pgid} born `);

		// The record it was matched from is same-user writable, so --fix must not act on it.
		const signals: Array<[number, NodeJS.Signals | number]> = [];
		await fixIntegrationPreflight(report, {
			rows: withoutOwnerPath(),
			readRows: withoutOwnerPath,
			currentPgid: 999_999,
			kill: (pid, signal) => { signals.push([pid, signal ?? 0]); return true; },
			wait: async () => {},
		});
		expect(signals.filter(([pid]) => pid === child.pid || pid === -child.pgid)).toEqual([]);
		expect(() => process.kill(child.pid, 0)).not.toThrow();
		// The supervisor that spawned it still holds the key in memory and reaps it.
		await child.terminate();
		expect(() => process.kill(-child.pgid, 0)).toThrow();
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

	it("treats a missing generated artifact as source fallback, not a preflight failure", async () => {
		const tempRoot = createRunRoot();
		const packageRoot = createRunRoot();
		const report = await inspectIntegrationPreflight({ root: packageRoot, tempRoot, rows: [], env: {} });
		expect(JSON.stringify(report)).not.toContain("stale-dist-");
	});

	it("notices, without blocking, a checkout artifact whose inputs drifted from its manifest", async () => {
		const tempRoot = createRunRoot();
		const packageRoot = createRunRoot();
		const outDir = join(packageRoot, "dist", "extension");
		mkdirSync(join(packageRoot, "src"), { recursive: true });
		mkdirSync(join(outDir, "assets"), { recursive: true });
		writeFileSync(join(packageRoot, "src", "extension.ts"), "export default {};\n");
		for (const output of EXTENSION_RUNTIME_OUTPUTS) writeFileSync(join(outDir, output), `// ${output}\n`);
		const inputs = ["src/extension.ts"];
		const manifest = {
			version: EXTENSION_INPUT_MANIFEST_VERSION,
			inputs,
			hash: await extensionInputsHashFromManifest(packageRoot, inputs),
			outputsHash: await extensionOutputsHash(packageRoot),
		};
		writeFileSync(join(outDir, ".inputs.json"), `${JSON.stringify(manifest)}\n`);

		const fresh = await inspectIntegrationPreflight({ root: packageRoot, tempRoot, rows: [], env: {} });
		expect(JSON.stringify(fresh)).not.toContain("stale-dist-");

		writeFileSync(join(packageRoot, "src", "extension.ts"), "export default { drifted: true };\n");
		const drifted = await inspectIntegrationPreflight({ root: packageRoot, tempRoot, rows: [], env: {} });
		expect(drifted.notices).toContainEqual(expect.stringMatching(/^stale-dist-extension: .*pnpm build:extension/));
		expect(JSON.stringify(drifted.issues)).not.toContain("stale-dist-");
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

	it("classifies a tokenless focused namespace stale when the pid's start time mismatches", async () => {
		const tempRoot = createRunRoot();
		const reusedRoot = join(tempRoot, "sumocode-harness-v2-focused-reused");
		mkdirSync(reusedRoot);
		// Live pid (this process) but a start time no live process can have:
		// simulates a crashed focused worker whose PID was reused.
		writeFileSync(join(reusedRoot, "owner.json"), `${JSON.stringify({ pid: process.pid, ownerProcessStart: "Mon Jan  1 00:00:00 2001" })}\n`);

		const report = await inspectIntegrationPreflight({ root: process.cwd(), tempRoot, rows: [], env: {} });
		expect(report.issues.find((issue) => issue.code === "stale-harness-state")?.paths).toEqual([reusedRoot]);

		await fixIntegrationPreflight(report, {
			rows: [],
			readRows: () => [],
			currentPgid: 999_999,
			kill: () => true,
			wait: async () => {},
		});
		expect(existsSync(reusedRoot)).toBe(false);
	});

	it("spares a tokenless focused namespace whose pid start time matches the live owner", async () => {
		const tempRoot = createRunRoot();
		const liveRoot = join(tempRoot, "sumocode-harness-v2-focused-live");
		mkdirSync(liveRoot);
		const liveStart = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8" }).trim();
		writeFileSync(join(liveRoot, "owner.json"), `${JSON.stringify({ pid: process.pid, ownerProcessStart: liveStart })}\n`);

		const report = await inspectIntegrationPreflight({ root: process.cwd(), tempRoot, rows: [], env: {} });
		expect(report.issues.some((issue) => issue.code === "stale-harness-state")).toBe(false);
		expect(existsSync(liveRoot)).toBe(true);
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

	it.each([undefined, Buffer.from('{ "reason": "earlier timeout", "ownerPid": 123 }\n')])(
		"preserves the shared run's retention state through the probe (%s)",
		(markerBefore) => {
			const root = createRunRoot();
			const marker = join(root, "evidence-retained.json");
			const tempRoot = join(root, "tmp");
			const manifest = join(root, "children.jsonl");
			mkdirSync(tempRoot);
			if (markerBefore !== undefined) writeFileSync(marker, markerBefore);
			const env = {
				...process.env,
				TMPDIR: tempRoot,
				SUMOCODE_INTEGRATION_RUN_ROOT: root,
				SUMOCODE_INTEGRATION_MANIFEST: manifest,
				[HARNESS_OWNER_TOKEN_ENV_KEY]: "shared-run-test-owner",
				[HARNESS_RUN_ID_ENV_KEY]: "shared-run-test-id",
				[HARNESS_SIGNING_KEY_ENV_KEY]: "shared-run-test-key",
				[HARNESS_SIGNATURE_ENV_KEY]: HARNESS_SIGNATURE,
			};
			const output = execFileSync(process.execPath, [
				join(process.cwd(), "node_modules", "vitest", "vitest.mjs"),
				"run",
				"test/integration/fixtures/focused-harness-probe.test.ts",
				"--fileParallelism=false",
			], { cwd: process.cwd(), env, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });

			expect(output).toContain("zero-survivor audit: 0 survivors across 1 registered process group(s)");
			expect(existsSync(marker) ? readFileSync(marker) : undefined).toEqual(markerBefore);
			expect(readdirSync(tempRoot)).toEqual([]);
		},
	);

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

describe("verified harness group cleanup", () => {
	type FakeProcessRow = { pid: number; ppid: number; pgid: number; state?: string; start?: string; command: string };
	const ownerToken = "run-owner";
	const registration = {
		pid: 60_001,
		pgid: 60_001,
		processStart: "leader-start",
		ownerPid: 59_001,
		ownerProcessStart: "owner-start",
		ownerToken,
		ownershipMode: "shared",
	};
	const signingKey = "test-signing-key";
	const runId = "test-run-id";
	const authenticatedRegistration = {
		...registration,
		runId,
		registrationHmac: signSpawnRegistration(registration, runId, signingKey),
		signingKey,
	};
	const ownedCommand = `${HARNESS_SIGNATURE_ENV_KEY}=${HARNESS_SIGNATURE} ${HARNESS_OWNER_TOKEN_ENV_KEY}=${ownerToken} node child.js`;
	const owner = { pid: registration.ownerPid, ppid: 58_001, pgid: 58_001, command: ownedCommand };
	const leader = { pid: registration.pid, ppid: owner.pid, pgid: registration.pgid, command: "pi" };
	const member = { pid: 60_002, ppid: leader.pid, pgid: registration.pgid, command: "pi" };
	const descendant = { pid: 60_003, ppid: 1, pgid: registration.pgid, command: ownedCommand };
	const starts = new Map([
		[registration.pid, registration.processStart],
		[registration.ownerPid, registration.ownerProcessStart],
	]);

	function fakeCleanup(
		// Rows admit null so tests can inject a malformed table at the untrusted seam.
		tables: Array<{ rows: Array<FakeProcessRow | null>; issue?: { code: string } }>,
		processStarts: ReadonlyMap<number, string | undefined> = starts,
		registered = registration,
	) {
		const signals: Array<[number, NodeJS.Signals | number]> = [];
		return {
			signals,
			result: reapHarnessProcessGroup(registered, {
				readProcessTable: () => tables.shift() ?? { rows: [] },
				currentPgid: 99_999,
				readProcessStart: (pid) => processStarts.get(pid),
				kill: (pid, signal) => { signals.push([pid, signal ?? 0]); return true; },
				wait: async () => {},
			}),
		};
	}

	it("signs the fixed spawn identity tuple", () => {
		expect(signSpawnRegistration(registration, runId, signingKey))
			.toBe("3aaabd84c11b95dd1e56a71dc5d165542de38863b2ed7148264447813b419a78");
	});

	it("cleans an authenticated tree even when titles hide every child marker", async () => {
		const cleanup = fakeCleanup([{ rows: [owner, leader, member] }, { rows: [] }]);
		await expect(cleanup.result).resolves.toMatchObject({ status: "reaped" });
		expect(cleanup.signals).toEqual([[-registration.pgid, "SIGTERM"]]);
	});

	it("authenticates a focused owner by its captured pid and birth", async () => {
		const focused = { ...registration, ownershipMode: "focused" };
		const unsignedOwner = { ...owner, command: "vitest" };
		const cleanup = fakeCleanup([{ rows: [unsignedOwner, leader] }, { rows: [] }], starts, focused);
		await expect(cleanup.result).resolves.toMatchObject({ status: "reaped" });
		expect(cleanup.signals).toEqual([[-registration.pgid, "SIGTERM"]]);
	});

	it("takes the leader's birth from the membership snapshot when a separate lookup finds nothing", async () => {
		// A leader exiting between two ps calls must not read as present-but-unknown.
		const snapshotLeader = { ...leader, start: registration.processStart };
		const snapshotOwner = { ...owner, start: registration.ownerProcessStart };
		const cleanup = fakeCleanup([{ rows: [snapshotOwner, snapshotLeader, member] }, { rows: [] }], new Map());
		await expect(cleanup.result).resolves.toMatchObject({ status: "reaped" });
		expect(cleanup.signals).toEqual([[-registration.pgid, "SIGTERM"]]);
	});

	it("still refuses a snapshot leader whose birth differs from the registration", async () => {
		const replaced = { ...leader, start: "replacement-start" };
		const cleanup = fakeCleanup([{ rows: [owner, replaced] }], new Map());
		await expect(cleanup.result).resolves.toMatchObject({ status: "unverified", identityStatus: "different" });
		expect(cleanup.signals).toEqual([]);
	});

	it("refuses a leader whose birth identity changed", async () => {
		const changed = new Map(starts).set(registration.pid, "replacement-start");
		const cleanup = fakeCleanup([{ rows: [owner, leader] }], changed);
		await expect(cleanup.result).resolves.toMatchObject({ status: "unverified", identityStatus: "different" });
		expect(cleanup.signals).toEqual([]);
	});

	it("refuses an owner whose birth identity changed", async () => {
		const changed = new Map(starts).set(registration.ownerPid, "replacement-start");
		const cleanup = fakeCleanup([{ rows: [owner, leader] }], changed);
		await expect(cleanup.result).resolves.toMatchObject({ status: "unverified", identityStatus: "different" });
		expect(cleanup.signals).toEqual([]);
	});

	it.each([
		["signature", { ...owner, command: `${HARNESS_OWNER_TOKEN_ENV_KEY}=${ownerToken} node worker.js` }],
		["token", { ...owner, command: `${HARNESS_SIGNATURE_ENV_KEY}=${HARNESS_SIGNATURE} ${HARNESS_OWNER_TOKEN_ENV_KEY}=${ownerToken}-forged node worker.js` }],
	])("refuses a shared owner with the wrong %s", async (_kind, wrongOwner) => {
		const cleanup = fakeCleanup([{ rows: [wrongOwner, leader] }]);
		await expect(cleanup.result).resolves.toMatchObject({ status: "unverified", identityStatus: "different" });
		expect(cleanup.signals).toEqual([]);
	});

	it.each([
		["cycle", [owner, leader, { ...member, ppid: 60_004 }, { pid: 60_004, ppid: member.pid, pgid: registration.pgid, command: "pi" }]],
		["broken", [owner, leader, { ...member, ppid: 60_099 }]],
		["missing", [owner, leader, { ...member, ppid: 0 }]],
		["unrelated same-pgid member", [owner, leader, { ...member, ppid: owner.pid }]],
	] satisfies Array<[string, FakeProcessRow[]]>)("refuses a group with %s ancestry", async (_kind, rows) => {
		const cleanup = fakeCleanup([{ rows }]);
		await expect(cleanup.result).resolves.toMatchObject({ status: "unverified", identityStatus: "different" });
		expect(cleanup.signals).toEqual([]);
	});

	it("refuses cleanup when process ownership cannot be inspected", async () => {
		const cleanup = fakeCleanup([{ rows: [], issue: { code: "process-table-unavailable" } }]);
		await expect(cleanup.result).resolves.toMatchObject({ status: "unverified", identityStatus: "unknown" });
		expect(cleanup.signals).toEqual([]);
	});

	it("refuses cleanup when an injected process row is null", async () => {
		const cleanup = fakeCleanup([{ rows: [null] }]);
		await expect(cleanup.result).resolves.toMatchObject({
			status: "unverified",
			identityStatus: "unknown",
			error: "process table malformed",
		});
		expect(cleanup.signals).toEqual([]);
	});

	it("refuses escalation when owner authentication changes during TERM grace", async () => {
		const wrongOwner = { ...owner, command: `${HARNESS_SIGNATURE_ENV_KEY}=${HARNESS_SIGNATURE} ${HARNESS_OWNER_TOKEN_ENV_KEY}=other-run node worker.js` };
		const cleanup = fakeCleanup([
			{ rows: [owner, leader, member] },
			{ rows: [wrongOwner, leader, member] },
		]);
		await expect(cleanup.result).resolves.toMatchObject({ status: "unverified", identityStatus: "different" });
		expect(cleanup.signals).toEqual([[-registration.pgid, "SIGTERM"]]);
	});

	it("reports an already exited group without signaling", async () => {
		const cleanup = fakeCleanup([{ rows: [] }]);
		await expect(cleanup.result).resolves.toMatchObject({ status: "exited" });
		expect(cleanup.signals).toEqual([]);
	});

	it("reaps a reparented title-hidden leader from an authenticated birth registration", async () => {
		const hiddenLeader = { ...leader, ppid: 1, start: registration.processStart, command: "pi" };
		const hiddenMember = { ...member, command: "pi" };
		const cleanup = fakeCleanup([{ rows: [hiddenLeader, hiddenMember] }, { rows: [] }], new Map(), authenticatedRegistration);
		await expect(cleanup.result).resolves.toMatchObject({ status: "reaped" });
		expect(cleanup.signals).toEqual([[-registration.pgid, "SIGTERM"]]);
	});

	it.each([
		["missing", undefined],
		["forged", "0".repeat(64)],
	])("refuses a %s registration HMAC without signaling", async (_kind, registrationHmac) => {
		const hiddenLeader = { ...leader, ppid: 1, start: registration.processStart, command: "pi" };
		const cleanup = fakeCleanup([{ rows: [hiddenLeader] }], new Map(), {
			...authenticatedRegistration,
			registrationHmac,
		});
		await expect(cleanup.result).resolves.toMatchObject({ status: "unverified" });
		expect(cleanup.signals).toEqual([]);
	});

	it("refuses an authenticated registration when the live birth differs", async () => {
		const reusedLeader = { ...leader, ppid: 1, start: "replacement-start", command: "pi" };
		const cleanup = fakeCleanup([{ rows: [reusedLeader] }], new Map(), authenticatedRegistration);
		await expect(cleanup.result).resolves.toMatchObject({ status: "unverified", identityStatus: "different" });
		expect(cleanup.signals).toEqual([]);
	});

	it("reaps a reparented live leader only when every member carries the run identity", async () => {
		const signedLeader = { ...leader, ppid: 1, command: ownedCommand };
		const signedMember = { ...member, command: ownedCommand };
		const cleanup = fakeCleanup([{ rows: [signedLeader, signedMember] }, { rows: [] }]);
		await expect(cleanup.result).resolves.toMatchObject({ status: "reaped" });
		expect(cleanup.signals).toEqual([[-registration.pgid, "SIGTERM"]]);
	});

	it("refuses a member carrying a fake-pi name and token without a harness signature", async () => {
		// A reparented leader takes the run-identity fallback, so only the missing
		// signature decides this refusal; with an owner-linked leader the absent
		// owner row would refuse first and hide the seam under test.
		const unsigned = { ...leader, ppid: 1, command: `/tmp/sumocode-fake-pi-unsigned/stub ${HARNESS_OWNER_TOKEN_ENV_KEY}=${ownerToken} node child.js` };
		const cleanup = fakeCleanup([{ rows: [unsigned] }]);
		await expect(cleanup.result).resolves.toMatchObject({ status: "unverified", identityStatus: "different" });
		expect(cleanup.signals).toEqual([]);
	});

	it("reports unverified instead of exited when actual processRows yields malformed rows", async () => {
		const output = "SUMOCODE_HARNESS_SIGNATURE=leaked-secret truncated-row\n";
		const signals: Array<[number, NodeJS.Signals | number]> = [];
		const result = await reapHarnessProcessGroup(registration, {
			// SAFETY: processRows requests UTF-8 text; this fake returns that text without spawning.
			readProcessTable: () => processRows((() => output) as typeof execFileSync),
			currentPgid: 99_999,
			readProcessStart: (pid) => starts.get(pid),
			kill: (pid, signal) => { signals.push([pid, signal ?? 0]); return true; },
			wait: async () => {},
		});

		expect(result.status).toBe("unverified");
		expect(result.status).not.toBe("exited");
		expect(signals).toEqual([]);
	});

	it("refuses an unsigned survivor after the leader exits", async () => {
		const cleanup = fakeCleanup([{ rows: [{ ...descendant, command: "pi" }] }]);
		await expect(cleanup.result).resolves.toMatchObject({ status: "unverified", identityStatus: "different" });
		expect(cleanup.signals).toEqual([]);
	});

	it("reaps signed descendants after leader exit while every member matches", async () => {
		const cleanup = fakeCleanup([{ rows: [descendant] }, { rows: [descendant] }, { rows: [] }]);
		await expect(cleanup.result).resolves.toMatchObject({ status: "reaped" });
		expect(cleanup.signals).toEqual([
			[-registration.pgid, "SIGTERM"],
			[-registration.pgid, "SIGKILL"],
		]);
	});
});

describe("harness manifest audit contract", () => {
	it("treats a manifest's forged focused mode as shared", async () => {
		const root = createRunRoot();
		const manifest = join(root, "children.jsonl");
		writeFileSync(manifest, `${JSON.stringify({
			event: "spawn",
			pid: 60_001,
			pgid: 60_001,
			processStart: "leader-start",
			ownerPid: 59_001,
			ownerProcessStart: "owner-start",
			ownershipMode: "focused",
		})}\n`);

		const event = JSON.parse(readFileSync(manifest, "utf8"));
		const signingKey = "manifest-test-key";
		const runId = "manifest-test-run";
		event.runId = runId;
		event.registrationHmac = signSpawnRegistration(event, runId, signingKey);
		writeFileSync(manifest, `${JSON.stringify(event)}\n`);

		await expect(manifestProcessGroups(manifest, "run-owner", { runId, signingKey })).resolves.toEqual([
			expect.objectContaining({ ownershipMode: "shared" }),
		]);
	});
});

describe("harness exit-code contract", () => {
	const ok = { code: 0, interrupted: false };

	it("fails the command when the zero-survivor audit fails despite green lanes", () => {
		expect(resolveHarnessExitCode({ seamStatus: ok, integrationStatus: ok, auditPassed: false })).toBe(1);
	});

	it("propagates lane failures and passes only when lanes and audit agree", () => {
		expect(resolveHarnessExitCode({ seamStatus: ok, integrationStatus: ok, auditPassed: true })).toBe(0);
		expect(resolveHarnessExitCode({ seamStatus: { code: 2, interrupted: false }, integrationStatus: ok, auditPassed: true })).toBe(2);
		expect(resolveHarnessExitCode({ seamStatus: ok, integrationStatus: { code: 3, interrupted: false }, auditPassed: true })).toBe(3);
		expect(resolveHarnessExitCode({ seamStatus: ok, integrationStatus: { code: 0, interrupted: true }, auditPassed: true })).toBe(1);
	});
});

describe("portable process-table probe", () => {
	const psRow = "  101   1   101 S Sat Aug 22 13:54:46 2026 /usr/bin/some-command\n";

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
		expect(result.rows).toEqual([{ pid: 101, ppid: 1, pgid: 101, state: "S", start: "Sat Aug 22 13:54:46 2026", command: "/usr/bin/some-command" }]);
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

	it("parses valid rows and skips blank lines without an issue", () => {
		const output = "\n  101   1   101 S Sat Aug 22 13:54:46 2026 /usr/bin/a\n\n  102 101   101 R Sat Sep  5 20:57:01 2026 /usr/bin/b\n\n";
		// SAFETY: processRows requests UTF-8 text; this fake returns that text without spawning.
		const execute = (() => output) as typeof execFileSync;

		const result = processRows(execute);
		expect(result.issue).toBeUndefined();
		expect(result.rows).toEqual([
			{ pid: 101, ppid: 1, pgid: 101, state: "S", start: "Sat Aug 22 13:54:46 2026", command: "/usr/bin/a" },
			{ pid: 102, ppid: 101, pgid: 101, state: "R", start: "Sat Sep  5 20:57:01 2026", command: "/usr/bin/b" },
		]);
	});

	it("flags malformed nonblank rows as an issue without echoing their content", () => {
		const output = [
			"SUMOCODE_HARNESS_SIGNATURE=leaked-secret truncated-row",
			"  103   1",
			"  101   1   101 S Sat Aug 22 13:54:46 2026 /usr/bin/fine",
			"",
		].join("\n");
		// SAFETY: processRows requests UTF-8 text; this fake returns that text without spawning.
		const execute = (() => output) as typeof execFileSync;

		const result = processRows(execute);
		expect(result.rows).toEqual([{ pid: 101, ppid: 1, pgid: 101, state: "S", start: "Sat Aug 22 13:54:46 2026", command: "/usr/bin/fine" }]);
		expect(result.issue?.code).toBe("process-table-malformed-row");
		expect(JSON.stringify(result)).not.toContain("leaked-secret");
	});
});
