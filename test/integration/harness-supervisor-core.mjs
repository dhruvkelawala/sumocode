import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn as spawnPty } from "node-pty";
import { prepareHarnessAdmission } from "./harness-admission.mjs";
import {
	HARNESS_OWNER_TOKEN_ENV_KEY,
	HARNESS_RUN_ID_ENV_KEY,
	HARNESS_SIGNATURE,
	HARNESS_SIGNATURE_ENV_KEY,
	HARNESS_SIGNING_KEY_ENV_KEY,
} from "../../scripts/lib/integration-harness-constants.mjs";
import { signSpawnRegistration } from "../../scripts/lib/integration-harness-auth.mjs";
import { liveProcessStart, reapHarnessProcessGroup } from "../../scripts/preflight-integration.mjs";

export {
	HARNESS_OWNER_TOKEN_ENV_KEY,
	HARNESS_RUN_ID_ENV_KEY,
	HARNESS_SIGNATURE,
	HARNESS_SIGNATURE_ENV_KEY,
	HARNESS_SIGNING_KEY_ENV_KEY,
};

/**
 * Cross-file harness contract: this module and scripts/run-integration-harness.mjs write owner.json
 * (`pid`, `startedAt`, optional `ownerToken`/`root`/`mode`) and evidence-retained.json (`ownerPid`, `retainedAt`,
 * optional `reason`); scripts/preflight-integration.mjs consumes those files. TERM→KILL grace is
 * owned by SUPERVISOR_TERM_GRACE_MS here, RUNNER_TERM_GRACE_MS in the runner, and
 * PREFLIGHT_TERM_GRACE_MS in preflight.
 */
const SUPERVISOR_TERM_GRACE_MS = 750;
const STDERR_TAIL_BYTES = 64 * 1024;
const AUDIT_FAILURES_FILE = "audit-failures.jsonl";

export const READINESS_EVENT_BY_STATE = {
	boot: "boot_screen_frame",
	// editor_ready marks editable input; stable_chrome_ready is the owned-shell
	// mark the removed app_ready alias used to duplicate.
	input: "editor_ready",
	app: "stable_chrome_ready",
};

/** OS-reported start time of this process, or undefined when ps is unavailable. */
function ownProcessStart() {
	return liveProcessStart(process.pid);
}

let fallbackRoot;
let fallbackOwnerToken;
let fallbackRunId;
let fallbackSigningKey;
let childSequence = 0;
const focusedProcessGroups = new Map();

function harnessRoot(env = process.env) {
	if (env.SUMOCODE_INTEGRATION_RUN_ROOT) return env.SUMOCODE_INTEGRATION_RUN_ROOT;
	if (fallbackRoot === undefined) {
		fallbackRoot = mkdtempSync(join(tmpdir(), "sumocode-harness-v2-focused-"));
		fallbackOwnerToken = randomUUID();
		fallbackRunId = randomUUID();
		fallbackSigningKey = randomBytes(32).toString("hex");
		// A focused vitest worker cannot re-exec to plant the owner token in its
		// initial environment (ps shows exec-time env only), so tokenless focused
		// namespaces carry the OS-reported process start time instead: a reused
		// PID belongs to a different process with a different start time, which
		// preflight can check without any token (Codex cycle-4, PR #422).
		writeFileSync(
			join(fallbackRoot, "owner.json"),
			`${JSON.stringify({
				pid: process.pid,
				startedAt: new Date().toISOString(),
				mode: "focused",
				ownerToken: env[HARNESS_OWNER_TOKEN_ENV_KEY],
				ownerProcessStart: ownProcessStart(),
				runId: fallbackRunId,
			}, null, 2)}\n`,
			{ mode: 0o600 },
		);
	}
	return fallbackRoot;
}

function manifestPath(env = process.env) {
	return env.SUMOCODE_INTEGRATION_MANIFEST ?? join(harnessRoot(env), "children.jsonl");
}

function harnessAuth(env) {
	// A focused namespace mints its identity on first use; make sure it exists
	// before reading it, so this does not depend on evidence-dir call order.
	if (env.SUMOCODE_INTEGRATION_RUN_ROOT === undefined) harnessRoot(env);
	const runId = env.SUMOCODE_INTEGRATION_RUN_ROOT === undefined ? fallbackRunId : process.env[HARNESS_RUN_ID_ENV_KEY];
	const signingKey = env.SUMOCODE_INTEGRATION_RUN_ROOT === undefined ? fallbackSigningKey : process.env[HARNESS_SIGNING_KEY_ENV_KEY];
	return runId && signingKey ? { runId, signingKey } : undefined;
}

/**
 * Resolve the signing identity before a child exists. Failing after spawn
 * would leave a detached process with no handle to reap it.
 */
export function requireHarnessAuth(env) {
	const auth = harnessAuth(env);
	if (auth === undefined) throw new Error("harness spawn signing identity is unavailable");
	return auth;
}

function appendManifest(event, env, auth) {
	const path = manifestPath(env);
	mkdirSync(dirname(path), { recursive: true });
	let writtenEvent = event;
	if (event.event === "spawn") {
		if (auth === undefined) throw new Error("harness spawn registration requires signing identity");
		writtenEvent = {
			...event,
			runId: auth.runId,
			registrationHmac: signSpawnRegistration(event, auth.runId, auth.signingKey),
		};
	}
	appendFileSync(path, `${JSON.stringify({ ts: Date.now(), ...writtenEvent })}\n`, { mode: 0o600 });
	if (env.SUMOCODE_INTEGRATION_RUN_ROOT === undefined && event.event === "spawn") {
		focusedProcessGroups.set(event.pgid, {
			pid: event.pid,
			pgid: event.pgid,
			processStart: event.processStart,
			ownerPid: event.ownerPid ?? 0,
			ownerProcessStart: event.ownerProcessStart,
			ownerToken: env[HARNESS_OWNER_TOKEN_ENV_KEY],
			runId: writtenEvent.runId,
			registrationHmac: writtenEvent.registrationHmac,
			signingKey: fallbackSigningKey,
			// This branch exists only for the in-process focused namespace; the
			// manifest field never chooses the weaker owner proof.
			ownershipMode: "focused",
		});
	}
}

function malformedAuditFailure(reason = "malformed audit failure record") {
	return { phase: "audit record", pid: 0, pgid: 0, reason };
}

/* oxlint-disable anti-slop/no-runtime-typeof -- JSONL audit records are untrusted input; this guard checks the record contract field by field. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSONL is untrusted input; this predicate checks its audit-record contract.
function isHarnessAuditFailure(value) {
	if (value === null || typeof value !== "object") return false;
	// SAFETY: the object guard permits field inspection; every required field is checked below.
	const failure = value;
	return typeof failure.phase === "string"
		&& typeof failure.pid === "number" && Number.isSafeInteger(failure.pid)
		&& typeof failure.pgid === "number" && Number.isSafeInteger(failure.pgid)
		&& typeof failure.reason === "string";
}
/* oxlint-enable anti-slop/no-runtime-typeof */

function reportAuditFailure(env, failure) {
	try {
		const root = harnessRoot(env);
		appendFileSync(join(root, AUDIT_FAILURES_FILE), `${JSON.stringify({ ts: Date.now(), ...failure })}\n`, { mode: 0o600 });
		markRunEvidenceRetained(root);
	} catch {
		// If run state itself is unwritable, the worker exit is the last gate against false green.
		process.exitCode ||= 1;
	}
	try {
		process.stderr.write(`[harness supervisor] audit write failed: pid ${failure.pid} pgid ${failure.pgid} born ${failure.processStart ?? "unknown"}; ${failure.phase}: ${failure.reason}\n`);
	} catch {
		// A closed stderr must not turn an event callback into an uncaught exception.
	}
}

export function recordHarnessAuditFailure(
	phase,
	pid,
	pgid,
	env,
	reason,
	processStart = liveProcessStart(pid),
) {
	reportAuditFailure(env, { phase, pid, pgid, processStart, reason });
}

export function harnessAuditFailures(root) {
	let contents;
	try {
		contents = readFileSync(join(root, AUDIT_FAILURES_FILE), "utf8");
	} catch (error) {
		// SAFETY: readFileSync throws an fs error; only ENOENT means no audit file.
		if ((error).code === "ENOENT") return [];
		return [malformedAuditFailure(`could not read audit failure records: ${String(error)}`)];
	}
	const failures = [];
	for (const line of contents.split("\n")) {
		if (!line.trim()) continue;
		try {
			const failure = JSON.parse(line);
			failures.push(isHarnessAuditFailure(failure) ? failure : malformedAuditFailure());
		} catch {
			failures.push(malformedAuditFailure());
		}
	}
	return failures;
}

function appendLifecycleManifest(event, env, processStart) {
	try {
		appendManifest(event, env, undefined);
	} catch (error) {
		reportAuditFailure(env, {
			phase: `${event.event} manifest`,
			pid: event.pid,
			pgid: event.pgid,
			processStart,
			reason: String(error),
		});
	}
}

function failSpawnRegistration(
	error,
	env,
	registration,
) {
	reportAuditFailure(env, {
		phase: "spawn registration",
		pid: registration.pid,
		pgid: registration.pgid,
		processStart: registration.processStart,
		reason: String(error),
	});
	const cleanup = "safe post-spawn cleanup control is unavailable; process-group state is unknown";
	reportAuditFailure(env, {
		phase: "spawn registration cleanup",
		pid: registration.pid,
		pgid: registration.pgid,
		processStart: registration.processStart,
		reason: cleanup,
	});
	throw new Error(`spawn registration failed for pid ${registration.pid}: ${cleanup}; registration error: ${String(error)}`);
}

function shellArg(value) {
	if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function childLabel(argv) {
	const command = basename(argv[0] ?? "child").replaceAll(/[^A-Za-z0-9_.-]/g, "-");
	return `${String(++childSequence).padStart(3, "0")}-${command}`;
}

export function createChildEvidenceContext(
	argv,
	env = process.env,
	diagPath,
) {
	const root = harnessRoot(env);
	if (env.SUMOCODE_INTEGRATION_RUN_ROOT === undefined) {
		env[HARNESS_OWNER_TOKEN_ENV_KEY] = fallbackOwnerToken;
		const tempRoot = join(root, "tmp");
		mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
		env.TMPDIR = tempRoot;
	} else if (env.SUMOCODE_INTEGRATION_RUN_ROOT === process.env.SUMOCODE_INTEGRATION_RUN_ROOT) {
		env[HARNESS_OWNER_TOKEN_ENV_KEY] = process.env[HARNESS_OWNER_TOKEN_ENV_KEY];
	}
	const evidenceDir = join(root, "evidence", `worker-${process.pid}`, childLabel(argv));
	mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
	return {
		evidenceDir,
		stderrPath: join(evidenceDir, "stderr.log"),
		diagPath: diagPath ?? join(evidenceDir, "diagnostics-live.jsonl"),
		argv,
	};
}

function groupMayExist(pgid) {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		// SAFETY: kill(0) throws an OS error; only ESRCH proves absence, not EPERM.
		return (error).code !== "ESRCH";
	}
}

async function waitForGroupExit(pgid, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (groupMayExist(pgid) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return !groupMayExist(pgid);
}

async function terminateGroup(registration) {
	const result = await reapHarnessProcessGroup(registration, {
		wait: () => waitForGroupExit(registration.pgid, SUPERVISOR_TERM_GRACE_MS),
	});
	if (result.status !== "exited" && result.status !== "reaped") {
		throw new Error(`refused unsafe process-group cleanup for ${registration.pgid}: ${result.status}${result.identityStatus ? `/${result.identityStatus}` : ""}${result.error ? ` (${result.error})` : ""}`);
	}
}

function readTail(path) {
	if (!existsSync(path)) return "<no stderr captured>\n";
	const bytes = readFileSync(path);
	return bytes.subarray(Math.max(0, bytes.length - STDERR_TAIL_BYTES)).toString("utf8");
}

function runRootForEvidence(evidenceDir) {
	let path = evidenceDir;
	for (;;) {
		if (basename(path) === "evidence") return dirname(path);
		const parent = dirname(path);
		if (parent === path) return undefined;
		path = parent;
	}
}

function markRunEvidenceRetained(root) {
	writeFileSync(
		join(root, "evidence-retained.json"),
		`${JSON.stringify({ ownerPid: process.pid, retainedAt: new Date().toISOString() }, null, 2)}\n`,
		{ mode: 0o600 },
	);
}

function markEvidenceRetained(evidenceDir) {
	const root = runRootForEvidence(evidenceDir);
	if (root !== undefined) markRunEvidenceRetained(root);
}

export async function captureTimeoutEvidence(input) {
	await mkdir(input.evidenceDir, { recursive: true, mode: 0o700 });
	await Promise.all([
		writeFile(join(input.evidenceDir, "argv.txt"), `${input.argv.map(shellArg).join(" ")}\n`, { mode: 0o600 }),
		writeFile(join(input.evidenceDir, "stderr-tail.txt"), readTail(input.stderrPath), { mode: 0o600 }),
		writeFile(join(input.evidenceDir, "raw-output.txt"), input.output, { mode: 0o600 }),
		writeFile(join(input.evidenceDir, "final-screen.txt"), input.finalScreen, { mode: 0o600 }),
		existsSync(input.diagPath)
			? copyFile(input.diagPath, join(input.evidenceDir, "diagnostics.jsonl"))
			: writeFile(join(input.evidenceDir, "diagnostics.jsonl"), "<no diagnostics captured>\n", { mode: 0o600 }),
	]);
	markEvidenceRetained(input.evidenceDir);
	return input.evidenceDir;
}

export async function waitForDiagnosticReadiness(diagPath, state, timeoutMs) {
	const expected = READINESS_EVENT_BY_STATE[state];
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (existsSync(diagPath)) {
			const lines = await readFile(diagPath, "utf8");
			for (const line of lines.split("\n")) {
				if (!line.trim()) continue;
				try {
					// SAFETY: readiness consumes only the string `event` discriminator; all other diagnostic fields are ignored.
					const event = JSON.parse(line);
					if (event.event === expected) return event;
				} catch {
					// The final JSONL write may be in flight; retry the state predicate.
				}
			}
		}
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for diagnostic readiness ${state} (${expected})`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function harnessGroupRegistration(pid, pgid, env, auth) {
	const registration = {
		pid,
		pgid,
		processStart: liveProcessStart(pid),
		ownerPid: process.pid,
		ownerProcessStart: ownProcessStart(),
		ownerToken: env[HARNESS_OWNER_TOKEN_ENV_KEY],
		ownershipMode: env.SUMOCODE_INTEGRATION_RUN_ROOT === undefined ? "focused" : "shared",
	};
	return {
		...registration,
		runId: auth.runId,
		registrationHmac: signSpawnRegistration(registration, auth.runId, auth.signingKey),
		signingKey: auth.signingKey,
	};
}

export function spawnSupervisedProcess(command, args, options = {}) {
	const env = { ...options.env, [HARNESS_SIGNATURE_ENV_KEY]: HARNESS_SIGNATURE };
	delete env[HARNESS_SIGNING_KEY_ENV_KEY];
	delete env[HARNESS_RUN_ID_ENV_KEY];
	const auth = requireHarnessAuth(env);
	const evidence = createChildEvidenceContext([command, ...args], env);
	const admission = prepareHarnessAdmission(command, args, evidence.evidenceDir);
	let child;
	try {
		child = spawn(admission.command, admission.args, { ...options, detached: true, env });
	} catch (error) {
		admission.cancel();
		throw error;
	}
	child.once("exit", () => admission.cancel());
	child.once("error", () => admission.cancel());
	if (child.pid === undefined) {
		admission.cancel();
		throw new Error(`supervised child did not publish a pid: ${command}`);
	}
	const pid = child.pid;
	const pgid = pid;
	const registration = harnessGroupRegistration(pid, pgid, env, auth);
	try {
		appendManifest({
			event: "spawn",
			pid,
			pgid,
			processStart: registration.processStart,
			ownerPid: registration.ownerPid,
			ownerProcessStart: registration.ownerProcessStart,
			ownershipMode: registration.ownershipMode,
			argv: [command, ...args],
			evidenceDir: evidence.evidenceDir,
		}, env, auth);
		admission.release(pid);
	} catch (error) {
		admission.cancel();
		failSpawnRegistration(String(error), env, registration);
	}
	child.stderr?.on("data", (chunk) => {
		try {
			appendFileSync(evidence.stderrPath, chunk);
		} catch (error) {
			reportAuditFailure(env, { phase: "stderr capture", pid, pgid, processStart: registration.processStart, reason: String(error) });
		}
	});
	const exited = new Promise((resolveExit) => child.once("exit", (code, signal) => {
		appendLifecycleManifest({ event: "exit", pid, pgid, code, signal }, env, registration.processStart);
		resolveExit();
	}));
	let reaping;
	let terminationExpected = false;
	return {
		child,
		pid,
		pgid,
		evidence,
		terminate() {
			terminationExpected = true;
			reaping ??= (async () => {
				// Let spawn complete its setsid before addressing the new group.
				await new Promise((resolveTurn) => setImmediate(resolveTurn));
				try {
					await terminateGroup(registration);
				} catch (error) {
					reportAuditFailure(env, {
						phase: "process-group cleanup",
						pid,
						pgid,
						processStart: registration.processStart,
						reason: String(error),
					});
					throw error;
				}
				await Promise.race([exited, new Promise((resolveDelay) => setTimeout(resolveDelay, SUPERVISOR_TERM_GRACE_MS))]);
				appendLifecycleManifest({ event: "reaped", pid, pgid }, env, registration.processStart);
			})();
			return reaping;
		},
		shouldCaptureExitFailure(hasPendingWaiters) {
			return !terminationExpected || hasPendingWaiters;
		},
		captureFailure(output = "", finalScreen = "") {
			return captureTimeoutEvidence({ ...evidence, output, finalScreen });
		},
	};
}

export function spawnSupervisedPty(command, args, options, evidence, auth) {
	const env = { ...options.env, [HARNESS_SIGNATURE_ENV_KEY]: HARNESS_SIGNATURE };
	delete env[HARNESS_SIGNING_KEY_ENV_KEY];
	delete env[HARNESS_RUN_ID_ENV_KEY];
	const admission = prepareHarnessAdmission(command, args, evidence.evidenceDir);
	let child;
	try {
		child = spawnPty(admission.command, admission.args, { ...options, env });
	} catch (error) {
		admission.cancel();
		throw error;
	}
	child.onExit(() => admission.cancel());
	try {
		const supervision = supervisePtyProcess(child.pid, evidence, env, auth);
		admission.release(child.pid);
		return { child, supervision };
	} catch (error) {
		admission.cancel();
		throw error;
	}
}

/**
 * The PTY child already exists when this runs, so it takes the auth the
 * caller resolved with requireHarnessAuth BEFORE spawning.
 */
export function supervisePtyProcess(pid, evidence, env, auth) {
	const pgid = pid;
	let reaping;
	env[HARNESS_SIGNATURE_ENV_KEY] = HARNESS_SIGNATURE;
	const registration = harnessGroupRegistration(pid, pgid, env, auth);
	try {
		appendManifest({
			event: "spawn",
			pid,
			pgid,
			processStart: registration.processStart,
			ownerPid: registration.ownerPid,
			ownerProcessStart: registration.ownerProcessStart,
			ownershipMode: registration.ownershipMode,
			argv: evidence.argv,
			evidenceDir: evidence.evidenceDir,
			kind: "pty",
		}, env, auth);
	} catch (error) {
		failSpawnRegistration(String(error), env, registration);
	}
	return {
		pid,
		pgid,
		evidence,
		terminate() {
			reaping ??= terminateGroup(registration).then(() => appendLifecycleManifest({ event: "reaped", pid, pgid }, env, registration.processStart));
			return reaping;
		},
		captureFailure(output = "", finalScreen = "") {
			return captureTimeoutEvidence({ ...evidence, output, finalScreen });
		},
	};
}

export function recordPtyExit(pid, pgid, exitCode, signal, env) {
	appendLifecycleManifest({ event: "exit", pid, pgid, code: exitCode, signal, kind: "pty" }, env, liveProcessStart(pid));
}

// The TS facade (harness-supervisor.ts) registers this as a Vitest afterAll hook at import
// time, so every focused Vitest file that imports this seam gets a final process-group audit,
// even when a test fails before it can register its own cleanup hook. This function owns the
// focused-namespace cleanup body.
export async function finalizeFocusedNamespace() {
	if (fallbackRoot === undefined) return;
	const root = fallbackRoot;
	const results = [];
	for (const registration of focusedProcessGroups.values()) {
		results.push(await reapHarnessProcessGroup(registration, {
			wait: () => waitForGroupExit(registration.pgid, SUPERVISOR_TERM_GRACE_MS),
		}));
	}
	const survivors = results.filter((result) => result.status !== "exited");
	const unreaped = results.filter((result) => result.status === "survived" || result.status === "unverified");
	const auditFailures = harnessAuditFailures(root);
	process.stdout.write(`[focused harness] zero-survivor audit: ${survivors.length} survivors across ${focusedProcessGroups.size} registered process group(s)\n`);
	if (survivors.length > 0 || auditFailures.length > 0) markRunEvidenceRetained(root);
	if (!existsSync(join(root, "evidence-retained.json"))) rmSync(root, { recursive: true, force: true });
	fallbackRoot = undefined;
	fallbackOwnerToken = undefined;
	fallbackRunId = undefined;
	fallbackSigningKey = undefined;
	focusedProcessGroups.clear();
	if (survivors.length > 0 || auditFailures.length > 0) {
		throw new Error(`focused harness failed: ${survivors.length} surviving process group(s), ${unreaped.length} unreaped, ${auditFailures.length} audit failure record(s)`);
	}
}
