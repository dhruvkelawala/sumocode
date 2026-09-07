#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reapHarnessProcessGroup, runIntegrationPreflight } from "./preflight-integration.mjs";
import {
	HARNESS_OWNER_TOKEN_ENV_KEY,
	HARNESS_RUN_ID_ENV_KEY,
	HARNESS_SIGNATURE,
	HARNESS_SIGNATURE_ENV_KEY,
	HARNESS_SIGNING_KEY_ENV_KEY,
} from "./lib/integration-harness-constants.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RUNNER_TERM_GRACE_MS = 1_000;

function groupAlive(pgid) {
	try { process.kill(-pgid, 0); return true; } catch { return false; }
}

async function waitForGroupExit(pgid, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (groupAlive(pgid) && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	return !groupAlive(pgid);
}

async function retainEvidence(runRoot, reason) {
	await writeFile(
		join(runRoot, "evidence-retained.json"),
		`${JSON.stringify({ ownerPid: process.pid, retainedAt: new Date().toISOString(), reason }, null, 2)}\n`,
		{ mode: 0o600 },
	);
}

async function preparePackageSnapshot(runRoot, env) {
	const packageRoot = join(runRoot, "package");
	await mkdir(packageRoot, { recursive: true, mode: 0o700 });
	for (const entry of ["bin", "scripts", "src", "package.json", "pnpm-lock.yaml", "tsconfig.json", "sumo-rpc-host.js"]) {
		await cp(join(ROOT, entry), join(packageRoot, entry), { recursive: true });
	}
	await symlink(join(ROOT, "node_modules"), join(packageRoot, "node_modules"), "dir");
	for (const script of ["scripts/build-host.mjs", "scripts/build-extension.mjs"]) {
		const result = spawnSync(process.execPath, [script], { cwd: packageRoot, env, encoding: "utf8" });
		if (result.status !== 0) {
			throw new Error(`private artifact build failed (${script})\n${result.stdout ?? ""}${result.stderr ?? ""}`);
		}
	}
	return packageRoot;
}

export async function manifestProcessGroups(manifest, ownerToken, { runId, signingKey }) {
	let contents = "";
	try { contents = await readFile(manifest, "utf8"); } catch { return []; }
	const groups = new Map();
	for (const line of contents.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event.event === "spawn" && Number.isSafeInteger(event.pid) && event.pid > 1
				&& Number.isSafeInteger(event.pgid) && event.pgid > 1) {
				groups.set(event.pgid, {
					pid: event.pid,
					pgid: event.pgid,
					processStart: event.processStart,
					ownerPid: event.ownerPid,
					ownerProcessStart: event.ownerProcessStart,
					ownerToken,
					runId: event.runId === runId ? event.runId : undefined,
					registrationHmac: event.registrationHmac,
					signingKey,
					// This audit owns a shared run. A manifest event cannot opt into
					// focused mode's tokenless owner proof.
					ownershipMode: "shared",
				});
			}
		} catch {
			// A worker can be interrupted mid-append; earlier complete registrations remain auditable.
		}
	}
	return [...groups.values()];
}

async function auditAndReap(manifest, ownerToken, auth) {
	const groups = await manifestProcessGroups(manifest, ownerToken, auth);
	const results = [];
	for (const group of groups) {
		results.push({ group, result: await reapHarnessProcessGroup(group, {
			wait: () => waitForGroupExit(group.pgid, RUNNER_TERM_GRACE_MS),
		}) });
	}
	const nonclean = results.filter(({ result }) => result.status !== "exited");
	if (nonclean.length > 0) {
		const details = nonclean.map(({ group, result }) => `${group.pgid}:${result.status}${result.identityStatus ? `/${result.identityStatus}` : ""}${result.error ? ` (${result.error})` : ""}`).join(", ");
		process.stderr.write(`[integration harness] zero-orphan audit FAILED: ${nonclean.length} nonclean registered group(s) (${details})\n`);
		return false;
	}
	process.stdout.write(`[integration harness] zero-orphan audit: 0 survivors across ${groups.length} registered process group(s)\n`);
	return true;
}

async function runVitest(vitestEntry, args, env) {
	const child = spawn(process.execPath, [vitestEntry, ...args], {
		cwd: ROOT,
		detached: true,
		env,
		stdio: "inherit",
	});
	if (child.pid === undefined) throw new Error("vitest did not publish a pid");
	let interrupted = false;
	const forward = (signal) => {
		interrupted = true;
		try { process.kill(-child.pid, signal); } catch {}
	};
	process.once("SIGINT", forward);
	process.once("SIGTERM", forward);
	const status = await new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
	process.removeListener("SIGINT", forward);
	process.removeListener("SIGTERM", forward);
	return { ...status, interrupted };
}

async function main(ownerToken) {
	if (!await runIntegrationPreflight()) return 1;
	const auth = { runId: randomUUID(), signingKey: randomBytes(32).toString("hex") };
	const nativeOnly = process.argv.includes("--native-only");
	const runRoot = await mkdtemp(join(tmpdir(), "sumocode-harness-v2-run-"));
	const manifest = join(runRoot, "children.jsonl");
	const tempRoot = join(runRoot, "tmp");
	const compileCache = join(runRoot, "node-compile-cache");
	await Promise.all([mkdir(tempRoot, { recursive: true, mode: 0o700 }), mkdir(compileCache, { recursive: true, mode: 0o700 })]);
	await writeFile(join(runRoot, "owner.json"), `${JSON.stringify({
		pid: process.pid,
		ownerToken,
		runId: auth.runId,
		// The signing key stays in this process only: every child is told
		// SUMOCODE_INTEGRATION_RUN_ROOT, so anything written here is readable
		// by the processes the key is meant to authenticate.
		root: ROOT,
		startedAt: new Date().toISOString(),
	}, null, 2)}\n`, { mode: 0o600 });
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key === HARNESS_OWNER_TOKEN_ENV_KEY || key === HARNESS_RUN_ID_ENV_KEY || key === HARNESS_SIGNING_KEY_ENV_KEY
			|| key === "NODE_PATH" || key === "NODE_OPTIONS" || key.startsWith("HERDR_") || key.startsWith("PI_SESSION")) delete env[key];
	}
	Object.assign(env, {
		SUMOCODE_INTEGRATION_RUN_ROOT: runRoot,
		SUMOCODE_INTEGRATION_MANIFEST: manifest,
		[HARNESS_OWNER_TOKEN_ENV_KEY]: ownerToken,
		[HARNESS_RUN_ID_ENV_KEY]: auth.runId,
		[HARNESS_SIGNING_KEY_ENV_KEY]: auth.signingKey,
		[HARNESS_SIGNATURE_ENV_KEY]: HARNESS_SIGNATURE,
		NODE_COMPILE_CACHE: compileCache,
		TMPDIR: tempRoot,
	});
	let seamStatus = { code: 0, signal: null, interrupted: false };
	let integrationStatus = { code: 1, signal: null, interrupted: false };
	const vitestEntry = join(ROOT, "node_modules", "vitest", "vitest.mjs");
	if (nativeOnly) {
		env.SUMOCODE_INTEGRATION_PACKAGE_ROOT = ROOT;
		env.SUMOCODE_NATIVE_CONTRACT = "1";
		process.stdout.write("[integration harness] native contract tests\n");
		integrationStatus = await runVitest(vitestEntry, [
			"run",
			"test/integration/native-",
			"--fileParallelism=false",
		], env);
	} else {
		let packageRoot;
		try {
			packageRoot = await preparePackageSnapshot(runRoot, env);
		} catch (error) {
			await retainEvidence(runRoot, "private artifact build failed");
			process.stderr.write(`[integration harness] ${String(error)}\nEvidence retained: ${runRoot}\n`);
			return 1;
		}
		env.SUMOCODE_INTEGRATION_PACKAGE_ROOT = packageRoot;
		process.stdout.write("[integration harness] seam tests\n");
		seamStatus = await runVitest(vitestEntry, ["run", "test/integration/verification-harness.test.ts", "--fileParallelism=false"], env);
		if (seamStatus.code === 0 && !seamStatus.interrupted) {
			process.stdout.write("[integration harness] integration tests\n");
			integrationStatus = await runVitest(vitestEntry, [
				"run",
				"test/integration/",
				"--fileParallelism=false",
				"--exclude",
				"test/integration/verification-harness.test.ts",
			], env);
		}
	}
	const auditPassed = await auditAndReap(manifest, ownerToken, auth);
	const exitCode = resolveHarnessExitCode({ seamStatus, integrationStatus, auditPassed });
	if (exitCode === 0) await rm(runRoot, { recursive: true, force: true });
	else {
		await retainEvidence(runRoot, "integration verification failed");
		process.stderr.write(`[integration harness] evidence retained: ${runRoot}\n`);
	}
	return exitCode;
}

/**
 * One decision point for the command's exit code. A surviving registered
 * group must fail the command even when every test lane exited 0 — otherwise
 * CI reports the audit failure yet still gates green and the zero-survivor
 * contract is decorative (Codex P1, PR #422).
 */
export function resolveHarnessExitCode({ seamStatus, integrationStatus, auditPassed }) {
	const passed = seamStatus.code === 0
		&& !seamStatus.interrupted
		&& integrationStatus.code === 0
		&& !integrationStatus.interrupted
		&& auditPassed;
	if (passed) return 0;
	if (!auditPassed) return 1;
	if (seamStatus.code !== 0) return seamStatus.code ?? 1;
	// An interrupted lane can carry code 0; it still must not gate green.
	if (seamStatus.interrupted || integrationStatus.interrupted) return integrationStatus.code || 1;
	return integrationStatus.code ?? 1;
}

async function runOwnedHarness() {
	const ownerToken = process.env[HARNESS_OWNER_TOKEN_ENV_KEY];
	if (ownerToken) return main(ownerToken);

	const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
		cwd: process.cwd(),
		env: { ...process.env, [HARNESS_OWNER_TOKEN_ENV_KEY]: randomUUID() },
		stdio: "inherit",
	});
	const forward = (signal) => child.kill(signal);
	process.once("SIGINT", forward);
	process.once("SIGTERM", forward);
	const code = await new Promise((resolveExit) => child.once("exit", (exitCode) => resolveExit(exitCode)));
	process.removeListener("SIGINT", forward);
	process.removeListener("SIGTERM", forward);
	return code ?? 1;
}

// Execute only when invoked as a script; importing this module (e.g. the
// seam test importing resolveHarnessExitCode) must not launch the harness.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = await runOwnedHarness();
}
