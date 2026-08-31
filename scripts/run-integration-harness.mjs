#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIntegrationPreflight } from "./preflight-integration.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REAP_GRACE_MS = 1_000;

function groupAlive(pgid) {
	try { process.kill(-pgid, 0); return true; } catch { return false; }
}

async function waitForGroupExit(pgid, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (groupAlive(pgid) && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	return !groupAlive(pgid);
}

async function reapGroup(pgid) {
	if (!groupAlive(pgid)) return;
	try { process.kill(-pgid, "SIGTERM"); } catch { return; }
	if (await waitForGroupExit(pgid, REAP_GRACE_MS)) return;
	try { process.kill(-pgid, "SIGKILL"); } catch { return; }
	await waitForGroupExit(pgid, REAP_GRACE_MS);
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

async function manifestProcessGroups(manifest) {
	let contents = "";
	try { contents = await readFile(manifest, "utf8"); } catch { return []; }
	const groups = new Set();
	for (const line of contents.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event.event === "spawn" && Number.isSafeInteger(event.pgid) && event.pgid > 1) groups.add(event.pgid);
		} catch {
			// A worker can be interrupted mid-append; earlier complete registrations remain auditable.
		}
	}
	return [...groups];
}

async function auditAndReap(manifest) {
	const groups = await manifestProcessGroups(manifest);
	const survivors = groups.filter(groupAlive);
	for (const pgid of survivors) await reapGroup(pgid);
	const unreaped = survivors.filter(groupAlive);
	if (survivors.length > 0) {
		process.stderr.write(`[integration harness] zero-orphan audit FAILED: ${survivors.length} survivor group(s) registered (${survivors.join(", ")}); ${unreaped.length} remained after TERM→KILL\n`);
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

async function main() {
	if (!await runIntegrationPreflight()) return 1;
	const runRoot = await mkdtemp(join(tmpdir(), "sumocode-harness-v2-run-"));
	const manifest = join(runRoot, "children.jsonl");
	const tempRoot = join(runRoot, "tmp");
	const compileCache = join(runRoot, "node-compile-cache");
	await Promise.all([mkdir(tempRoot, { recursive: true, mode: 0o700 }), mkdir(compileCache, { recursive: true, mode: 0o700 })]);
	await writeFile(join(runRoot, "owner.json"), `${JSON.stringify({ pid: process.pid, root: ROOT, startedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key === "NODE_PATH" || key === "NODE_OPTIONS" || key.startsWith("HERDR_") || key.startsWith("PI_SESSION")) delete env[key];
	}
	Object.assign(env, {
		SUMOCODE_INTEGRATION_RUN_ROOT: runRoot,
		SUMOCODE_INTEGRATION_MANIFEST: manifest,
		SUMOCODE_HARNESS_SIGNATURE: "sumocode-verification-harness-v2",
		NODE_COMPILE_CACHE: compileCache,
		TMPDIR: tempRoot,
	});
	let packageRoot;
	try {
		packageRoot = await preparePackageSnapshot(runRoot, env);
	} catch (error) {
		await retainEvidence(runRoot, "private artifact build failed");
		process.stderr.write(`[integration harness] ${String(error)}\nEvidence retained: ${runRoot}\n`);
		return 1;
	}
	env.SUMOCODE_INTEGRATION_PACKAGE_ROOT = packageRoot;

	const vitestEntry = join(ROOT, "node_modules", "vitest", "vitest.mjs");
	process.stdout.write("[integration harness] seam tests\n");
	const seamStatus = await runVitest(vitestEntry, ["run", "test/integration/verification-harness.test.ts", "--fileParallelism=false"], env);
	let integrationStatus = { code: 1, signal: null, interrupted: false };
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
	const auditPassed = await auditAndReap(manifest);
	const passed = seamStatus.code === 0
		&& !seamStatus.interrupted
		&& integrationStatus.code === 0
		&& !integrationStatus.interrupted
		&& auditPassed;
	if (passed) await rm(runRoot, { recursive: true, force: true });
	else {
		await retainEvidence(runRoot, "integration verification failed");
		process.stderr.write(`[integration harness] evidence retained: ${runRoot}\n`);
	}
	if (passed) return 0;
	if (seamStatus.code !== 0) return seamStatus.code ?? 1;
	return integrationStatus.code ?? 1;
}

process.exitCode = await main();
