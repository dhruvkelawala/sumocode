#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reapHarnessProcessGroup, runIntegrationPreflight } from "./preflight-integration.mjs";
import { spawnRegistrationHmacIsValid } from "./lib/integration-harness-auth.mjs";
import {
	HARNESS_OWNER_TOKEN_ENV_KEY,
	HARNESS_RUN_ID_ENV_KEY,
	HARNESS_SIGNATURE,
	HARNESS_SIGNATURE_ENV_KEY,
	HARNESS_SIGNING_KEY_ENV_KEY,
} from "./lib/integration-harness-constants.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RUNNER_TERM_GRACE_MS = 1_000;
const AUDIT_FAILURES_FILE = "audit-failures.jsonl";

/** Validate before owner re-exec or preflight; unknown argv must never select the full lane. */
export async function resolveHarnessRunPlan(argv) {
	// pnpm run forwards its optional delimiter to node scripts.
	const args = argv[0] === "--" ? argv.slice(1) : argv;
	const nativeOnly = args.length === 1 && args[0] === "--native-only";
	let selectedFile;
	if (args.length === 2 && args[0] === "--file") {
		selectedFile = args[1];
		if (!selectedFile.endsWith(".test.ts") || !/^test\/integration\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.test\.ts$/.test(selectedFile)) {
			throw new Error("--file requires one canonical test/integration/*.test.ts path (no traversal or patterns)");
		}
		let target;
		try {
			target = await realpath(join(ROOT, selectedFile));
			if (!(await stat(target)).isFile()) throw new Error("not a regular file");
		} catch {
			throw new Error("--file requires an existing regular integration test file");
		}
		const integrationRoot = join(await realpath(ROOT), "test", "integration");
		if (!target.startsWith(`${integrationRoot}${sep}`)) throw new Error("--file resolves outside test/integration");
	} else if (!nativeOnly && (args.length > 0 || argv.length > 0)) {
		throw new Error("expected no args, --native-only, or --file <test/integration/path.test.ts>");
	}
	return {
		nativeOnly,
		selectedFile,
		seamArgs: nativeOnly ? null : ["run", "test/integration/verification-harness.test.ts", "--fileParallelism=false"],
		integrationArgs: nativeOnly
			? ["run", "test/integration/native-", "--fileParallelism=false"]
			: selectedFile
				? ["run", selectedFile, "--fileParallelism=false"]
				: ["run", "test/integration/", "--fileParallelism=false", "--exclude", "test/integration/verification-harness.test.ts"],
	};
}

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

function manifestFileIdentity(info) {
	return [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

function groupIdentity(group) {
	return JSON.stringify([group.pid, group.pgid, group.processStart, group.ownerPid,
		group.ownerProcessStart, group.ownerToken, group.runId, group.registrationHmac,
		group.signingKey, group.ownershipMode]);
}

function addManifestGroup(groups, group, failures) {
	if (groups.some((known) => groupIdentity(known) === groupIdentity(group))) return false;
	if (groups.some((known) => known.pgid === group.pgid)) failures.push("manifest conflicting pgid registrations");
	groups.push(group);
	return true;
}

/* oxlint-disable anti-slop/no-runtime-typeof -- Validate the supervisor's untrusted JSONL event schema before consuming fields. */
function manifestEventIsValid(event) {
	if (event === null || typeof event !== "object" || Array.isArray(event)
		|| !["spawn", "exit", "reaped"].includes(event.event)
		|| !Number.isSafeInteger(event.pid) || event.pid <= 1
		|| !Number.isSafeInteger(event.pgid) || event.pgid <= 1) return false;
	for (const field of ["processStart", "ownerProcessStart", "runId", "registrationHmac", "evidenceDir"]) {
		if (event[field] !== undefined && (typeof event[field] !== "string" || event[field].trim().length === 0)) return false;
	}
	return (event.ownerPid === undefined || (Number.isSafeInteger(event.ownerPid) && event.ownerPid > 1 && event.ownerPid !== event.pid))
		&& (event.ownershipMode === undefined || ["shared", "focused"].includes(event.ownershipMode))
		&& (event.argv === undefined || (Array.isArray(event.argv) && event.argv.every((arg) => typeof arg === "string")))
		&& (event.kind === undefined || event.kind === "pty")
		&& (event.code === undefined || event.code === null || Number.isSafeInteger(event.code))
		&& (event.signal === undefined || event.signal === null || typeof event.signal === "string" || Number.isSafeInteger(event.signal));
}

async function manifestSnapshot(manifest, ownerToken, { runId, signingKey }) {
	const snapshot = { groups: [], failures: [], contents: undefined, identity: undefined };
	let file;
	try {
		const before = await lstat(manifest, { bigint: true });
		if (!before.isFile()) {
			snapshot.failures.push("manifest is not a regular file (symlinks refused)");
			return snapshot;
		}
		file = await open(manifest, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = await file.stat({ bigint: true });
		snapshot.identity = manifestFileIdentity(opened);
		if (!opened.isFile() || snapshot.identity !== manifestFileIdentity(before)) {
			snapshot.failures.push("manifest file identity changed before read");
			if (!opened.isFile()) return snapshot;
		}
		snapshot.contents = await file.readFile();
		const after = await file.stat({ bigint: true });
		const pathAfter = await lstat(manifest, { bigint: true });
		if (snapshot.identity !== manifestFileIdentity(after) || snapshot.identity !== manifestFileIdentity(pathAfter)) {
			snapshot.failures.push("manifest unstable during read");
		}
	} catch {
		snapshot.failures.push("manifest read unavailable or lost");
	} finally {
		if (file) {
			try { await file.close(); } catch { snapshot.failures.push("manifest close failed"); }
		}
	}
	if (snapshot.contents === undefined) return snapshot;
	const contents = snapshot.contents.toString("utf8");
	const lines = contents.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (index === lines.length - 1 && line.length > 0) snapshot.failures.push(`manifest torn line ${index + 1}`);
		if (!line.trim()) continue;
		let event;
		try { event = JSON.parse(line); } catch {
			snapshot.failures.push(`manifest malformed line ${index + 1}`);
			continue;
		}
		if (!manifestEventIsValid(event)) {
			snapshot.failures.push(`manifest invalid event or spawn identity at line ${index + 1}`);
			continue;
		}
		if (event.event !== "spawn") continue;
		if (typeof event.processStart !== "string" || event.processStart.trim().length === 0
			|| typeof event.ownerProcessStart !== "string" || event.ownerProcessStart.trim().length === 0
			|| !Number.isSafeInteger(event.ownerPid) || event.ownerPid <= 1 || event.ownerPid === event.pid) {
			snapshot.failures.push(`manifest incomplete spawn identity at line ${index + 1}`);
			continue;
		}
		if (event.runId !== runId || !spawnRegistrationHmacIsValid(event, runId, signingKey)) {
			snapshot.failures.push(`manifest spawn authentication failed at line ${index + 1}`);
			continue;
		}
		addManifestGroup(snapshot.groups, {
			pid: event.pid, pgid: event.pgid, processStart: event.processStart,
			ownerPid: event.ownerPid, ownerProcessStart: event.ownerProcessStart,
			ownerToken, runId, registrationHmac: event.registrationHmac, signingKey,
			// The shared audit never accepts record-selected focused owner proof.
			ownershipMode: "shared",
		}, snapshot.failures);
	}
	return snapshot;
}
/* oxlint-enable anti-slop/no-runtime-typeof */

export async function manifestProcessGroups(manifest, ownerToken, auth) {
	const { groups, failures } = await manifestSnapshot(manifest, ownerToken, auth);
	return { groups, failures };
}

function malformedAuditFailure(reason = "malformed audit failure record") {
	return { phase: "audit record", pid: 0, pgid: 0, reason };
}

/* oxlint-disable anti-slop/no-runtime-typeof -- Validate untrusted JSONL at the audit boundary before reading record fields. */
function isAuditFailure(value) {
	return value !== null
		&& typeof value === "object"
		&& typeof value.phase === "string"
		&& Number.isSafeInteger(value.pid)
		&& Number.isSafeInteger(value.pgid)
		&& typeof value.reason === "string";
}
/* oxlint-enable anti-slop/no-runtime-typeof */

async function readAuditFailures(root) {
	let contents;
	try {
		contents = await readFile(join(root, AUDIT_FAILURES_FILE), "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		return [malformedAuditFailure(`could not read audit failure records: ${String(error)}`)];
	}
	return contents.split("\n").filter((line) => line.trim()).map((line) => {
		try {
			const failure = JSON.parse(line);
			return isAuditFailure(failure) ? failure : malformedAuditFailure();
		} catch {
			return malformedAuditFailure();
		}
	});
}

export async function auditAndReap(manifest, ownerToken, auth, processIO = {}) {
	const first = await manifestSnapshot(manifest, ownerToken, auth);
	const groups = [];
	const failures = [...first.failures];
	const results = [];
	// Two complete observations only. Cleanup can append lifecycle records or
	// expose a new registration; uncertainty must not discard either snapshot.
	for (let pass = 0; pass < 2; pass++) {
		const snapshot = pass === 0 ? first : await manifestSnapshot(manifest, ownerToken, auth);
		if (pass === 1) {
			failures.push(...snapshot.failures);
			if (first.contents === undefined || snapshot.contents === undefined
				|| !first.contents.equals(snapshot.contents) || first.identity !== snapshot.identity) {
				failures.push("manifest changed or lost between census observations");
			}
		}
		for (const group of snapshot.groups) {
			if (!addManifestGroup(groups, group, failures)) continue;
			try {
				results.push({ group, result: await reapHarnessProcessGroup(group, {
					...processIO,
					wait: processIO.wait ?? (() => waitForGroupExit(group.pgid, RUNNER_TERM_GRACE_MS)),
				}) });
			} catch {
				results.push({ group, result: { status: "unverified", error: "registered group cleanup threw" } });
			}
		}
	}
	const nonclean = results.filter(({ result }) => result.status !== "exited");
	const auditFailures = await readAuditFailures(resolve(manifest, ".."));
	if (nonclean.length > 0 || auditFailures.length > 0 || failures.length > 0) {
		const details = [
			...nonclean.map(({ group, result }) => `pid ${group.pid} pgid ${group.pgid} born ${group.processStart ?? "unknown"}: ${result.status}${result.identityStatus ? `/${result.identityStatus}` : ""}${result.error ? ` (${result.error})` : ""}`),
			...auditFailures.map((failure) => `pid ${failure.pid ?? "unknown"} pgid ${failure.pgid ?? "unknown"} born ${failure.processStart ?? "unknown"}: ${failure.phase ?? "audit"} (${failure.reason ?? "unknown reason"})`),
			...failures,
		].join(", ");
		process.stderr.write(`[integration harness] zero-orphan audit FAILED: ${nonclean.length} nonclean registered group(s), ${auditFailures.length} audit failure record(s), ${failures.length} census failure(s) (${details}); registered-only scope, not complete process coverage\n`);
		return false;
	}
	process.stdout.write(`[integration harness] zero-orphan audit: 0 survivors across ${groups.length} registered process group(s); registered-only scope, not complete process coverage or quiescence\n`);
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

async function main(ownerToken, plan) {
	if (plan.selectedFile) process.stdout.write(`[integration harness] selected-file scope (partial; not full integration/native certification): ${plan.selectedFile}\n`);
	if (!await runIntegrationPreflight()) return 1;
	const auth = { runId: randomUUID(), signingKey: randomBytes(32).toString("hex") };
	const nativeOnly = plan.nativeOnly;
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
	await writeFile(manifest, "", { mode: 0o600, flag: "wx" });
	if (plan.selectedFile) await writeFile(join(runRoot, "selection.json"), `${JSON.stringify({
		scope: "selected-file (partial; not full integration/native certification)",
		selectedFile: plan.selectedFile,
		seamArgs: plan.seamArgs,
		integrationArgs: plan.integrationArgs,
	}, null, 2)}\n`, { mode: 0o600 });
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key === HARNESS_OWNER_TOKEN_ENV_KEY || key === HARNESS_RUN_ID_ENV_KEY || key === HARNESS_SIGNING_KEY_ENV_KEY
			|| key === "SUMOCODE_INTEGRATION_SELECTED_FILE"
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
		integrationStatus = await runVitest(vitestEntry, plan.integrationArgs, env);
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
		seamStatus = await runVitest(vitestEntry, plan.seamArgs, env);
		if (seamStatus.code === 0 && !seamStatus.interrupted) {
			process.stdout.write("[integration harness] integration tests\n");
			// Positional Vitest filters are substrings; the config narrows include
			// to this validated literal path only after the mandatory seam succeeds.
			if (plan.selectedFile) env.SUMOCODE_INTEGRATION_SELECTED_FILE = plan.selectedFile;
			integrationStatus = await runVitest(vitestEntry, plan.integrationArgs, env);
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
	let plan;
	try {
		plan = await resolveHarnessRunPlan(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`[integration harness] invalid integration selection: ${error.message}\n`);
		return 2;
	}
	const ownerToken = process.env[HARNESS_OWNER_TOKEN_ENV_KEY];
	if (ownerToken) return main(ownerToken, plan);

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
