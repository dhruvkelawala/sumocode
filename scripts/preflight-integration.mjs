#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	extensionInputManifestIsFresh,
	extensionOutputsHash,
} from "./lib/extension-bundle.mjs";
import {
	hostInputManifestIsFresh,
	hostOutputsHash,
} from "./lib/host-bundle.mjs";
import {
	HARNESS_OWNER_TOKEN_ENV_KEY,
	HARNESS_SIGNATURE,
	HARNESS_SIGNATURE_ENV_KEY,
} from "./lib/integration-harness-constants.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HARNESS_DIR_PREFIXES = ["sumocode-harness-v2-", "sumocode-fake-pi-"];
const RETAINED_EVIDENCE_MARKER = "evidence-retained.json";
const PS_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const PREFLIGHT_TERM_GRACE_MS = 300;

// BSD ps (macOS) accepts `eww -axo`; procps (Linux) rejects mixing the BSD
// `eww` personality with dashed `-axo` ("must set personality to get -x").
// Try the platform-appropriate form first, then the other, so a runner with
// either ps lineage produces a process table instead of the degraded issue.
// On procps, `e`(env) `ww`(wide) `a`+`x`(all) `o`(format) combine dashless.
const PS_ARG_FORMS = process.platform === "darwin"
	? [["eww", "-axo", "pid=,ppid=,pgid=,command="], ["ewwaxo", "pid=,ppid=,pgid=,command="]]
	: [["ewwaxo", "pid=,ppid=,pgid=,command="], ["eww", "-axo", "pid=,ppid=,pgid=,command="]];

export function processRows(execute = execFileSync) {
	let lastError;
	for (const args of PS_ARG_FORMS) {
		try {
			const output = execute("ps", args, {
				encoding: "utf8",
				maxBuffer: PS_MAX_BUFFER_BYTES,
			});
			const rows = output.split("\n").flatMap((line) => {
				const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
				return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] }] : [];
			});
			return { rows };
		} catch (error) {
			lastError = error;
		}
	}
	{
		const error = lastError;
		return {
			rows: [],
			issue: {
				code: "process-table-unavailable",
				message: `could not inspect processes with ps: ${String(error)}`,
				remediation: "ensure ps is available, then rerun pnpm test:integration:preflight",
			},
		};
	}
}

function hasProcessMarker(row, key, value) {
	return row.command.includes(`${key}=${value}`);
}

function hasHarnessSignature(row) {
	return hasProcessMarker(row, HARNESS_SIGNATURE_ENV_KEY, HARNESS_SIGNATURE);
}

function isHarnessProcess(row) {
	return row.pid !== process.pid && (
		hasHarnessSignature(row)
		|| /(?:^|\/)sumocode-fake-pi-[A-Za-z0-9._-]+(?:\/|\s|$)/.test(row.command)
	);
}

function pidIsAlive(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

/** OS-reported start time for a live pid, or undefined when unavailable. */
function liveProcessStart(pid, execute = execFileSync) {
	try {
		return execute("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

async function readOwner(path) {
	try {
		const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
		if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 1) return undefined;
		return {
			pid: owner.pid,
			// oxlint-disable-next-line anti-slop/no-runtime-typeof -- owner.json is untrusted state parsed at this I/O boundary
			ownerToken: typeof owner.ownerToken === "string" && owner.ownerToken.length > 0
				? owner.ownerToken
				: undefined,
			// oxlint-disable-next-line anti-slop/no-runtime-typeof -- owner.json is untrusted state parsed at this I/O boundary
			ownerProcessStart: typeof owner.ownerProcessStart === "string" && owner.ownerProcessStart.length > 0
				? owner.ownerProcessStart
				: undefined,
		};
	} catch {
		return undefined;
	}
}

async function classifyHarnessDir(path, rowsByPid = new Map(), tokenIdentityAvailable = true) {
	if (!HARNESS_DIR_PREFIXES.some((prefix) => basename(path).startsWith(prefix))) return "unrelated";
	const owner = await readOwner(path);
	if (owner !== undefined && pidIsAlive(owner.pid)) {
		if (owner.ownerToken !== undefined) {
			if (!tokenIdentityAvailable) return "live";
			const row = rowsByPid.get(owner.pid);
			if (row !== undefined && hasProcessMarker(row, HARNESS_OWNER_TOKEN_ENV_KEY, owner.ownerToken)) return "live";
		} else if (owner.ownerProcessStart !== undefined) {
			// Tokenless focused namespaces: identity = OS-reported start time of
			// the recorded pid. A reused PID is a different process with a
			// different start time, so the namespace classifies stale and --fix
			// can reclaim it (Codex cycle-4, PR #422).
			if (liveProcessStart(owner.pid) === owner.ownerProcessStart) return "live";
		} else {
			// Legacy namespaces with neither identity field keep the original
			// PID-liveness behavior.
			return "live";
		}
	}
	return existsSync(join(path, RETAINED_EVIDENCE_MARKER)) ? "retained" : "stale";
}

async function harnessState(tempRoot, rowsByPid, tokenIdentityAvailable) {
	let entries = [];
	try { entries = await readdir(tempRoot, { withFileTypes: true }); } catch { return { staleDirs: [], retainedDirs: [], liveOwnerPids: [] }; }
	const state = { staleDirs: [], retainedDirs: [], liveOwnerPids: [] };
	for (const entry of entries) {
		if (!entry.isDirectory() || !HARNESS_DIR_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
		const path = join(tempRoot, entry.name);
		const classification = await classifyHarnessDir(path, rowsByPid, tokenIdentityAvailable);
		if (classification === "live") {
			const owner = await readOwner(path);
			if (owner !== undefined) state.liveOwnerPids.push(owner.pid);
		} else if (classification === "retained") state.retainedDirs.push(path);
		else if (classification === "stale") state.staleDirs.push(path);
	}
	return state;
}

function signedHarnessLineage(pid, rowsByPid) {
	const lineage = [];
	const seen = new Set();
	while (Number.isSafeInteger(pid) && pid > 1 && !seen.has(pid)) {
		seen.add(pid);
		const row = rowsByPid.get(pid);
		if (row === undefined) break;
		if (hasHarnessSignature(row)) lineage.push(pid);
		pid = row.ppid;
	}
	return lineage;
}

function belongsToLiveHarnessRun(row, rowsByPid, liveHarnessPids) {
	let pid = row.pid;
	const seen = new Set();
	while (Number.isSafeInteger(pid) && pid > 1 && !seen.has(pid)) {
		if (liveHarnessPids.has(pid) && pidIsAlive(pid)) return true;
		seen.add(pid);
		pid = rowsByPid.get(pid)?.ppid;
	}
	return false;
}

async function artifactIssue(root, kind) {
	const manifestPath = join(root, "dist", kind, ".inputs.json");
	if (!existsSync(manifestPath)) {
		if (kind === "host") return undefined;
		return {
			code: "stale-dist-extension",
			message: "dist/extension has no .inputs.json manifest",
			remediation: "run pnpm build:extension",
		};
	}
	try {
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		const inputsFresh = kind === "host"
			? await hostInputManifestIsFresh(root, manifest)
			: await extensionInputManifestIsFresh(root, manifest);
		const outputsHash = kind === "host" ? await hostOutputsHash(root) : await extensionOutputsHash(root);
		if (inputsFresh && outputsHash === manifest.outputsHash) return undefined;
	} catch {
		// Named below with the same deterministic remediation.
	}
	return {
		code: `stale-dist-${kind}`,
		message: `dist/${kind} does not match its .inputs.json manifest`,
		remediation: `run pnpm build:${kind}`,
	};
}

async function nodeModulesIssue(root) {
	const path = join(root, "node_modules");
	if (!existsSync(path)) return { code: "node-modules-missing", message: "node_modules is missing", remediation: "run pnpm install --frozen-lockfile" };
	const info = await lstat(path);
	if (!info.isSymbolicLink()) return undefined;
	const target = await realpath(path);
	const targetRelative = relative(root, target);
	if (targetRelative !== "node_modules" && (targetRelative === ".." || targetRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))) {
		return {
			code: "node-modules-symlink-drift",
			message: `node_modules symlink resolves outside this worktree: ${target}`,
			remediation: "replace the cross-worktree symlink with pnpm install --frozen-lockfile in this worktree",
		};
	}
	return undefined;
}

export async function inspectIntegrationPreflight({ root = ROOT, tempRoot = tmpdir(), rows, env = process.env } = {}) {
	const processTable = rows === undefined ? processRows() : { rows };
	const issues = processTable.issue === undefined ? [] : [processTable.issue];
	const notices = [];
	const rowsByPid = new Map(processTable.rows.map((row) => [row.pid, row]));
	const state = await harnessState(tempRoot, rowsByPid, processTable.issue === undefined);
	const liveHarnessPids = new Set([
		...state.liveOwnerPids,
		...signedHarnessLineage(process.pid, rowsByPid),
	]);
	const orphanRows = [];
	for (const row of processTable.rows.filter(isHarnessProcess)) {
		if (!belongsToLiveHarnessRun(row, rowsByPid, liveHarnessPids)) orphanRows.push(row);
	}
	if (orphanRows.length > 0) {
		issues.push({
			code: "orphan-harness-children",
			message: `harness-owned children are still alive: ${orphanRows.map((row) => `${row.pid} (${row.command.slice(0, 160)})`).join(", ")}`,
			remediation: "run node scripts/preflight-integration.mjs --fix",
			rows: orphanRows,
		});
	}
	if (state.staleDirs.length > 0) {
		issues.push({
			code: "stale-harness-state",
			message: `stale harness locks/state: ${state.staleDirs.join(", ")}`,
			remediation: "run node scripts/preflight-integration.mjs --fix",
			paths: state.staleDirs,
		});
	}
	for (const path of state.retainedDirs) notices.push(`retained-evidence: ${path}`);
	const modules = await nodeModulesIssue(root);
	if (modules) issues.push(modules);
	for (const kind of ["host", "extension"]) {
		const issue = await artifactIssue(root, kind);
		if (issue) issues.push(issue);
	}
	if (env.NODE_PATH) notices.push(`inherited NODE_PATH will be stripped: ${env.NODE_PATH}`);
	if (env.NODE_COMPILE_CACHE) notices.push(`inherited NODE_COMPILE_CACHE will be replaced: ${env.NODE_COMPILE_CACHE}`);
	for (const key of Object.keys(env).filter((key) => key.startsWith("HERDR_") || key.startsWith("PI_SESSION"))) {
		notices.push(`inherited ${key} will be stripped`);
	}
	return { issues, notices, retainedEvidence: state.retainedDirs, liveHarnessPids: [...liveHarnessPids] };
}

function currentProcessGroupId(rows) {
	const ownRow = rows.find((row) => row.pid === process.pid);
	if (ownRow !== undefined) return ownRow.pgid;
	try {
		return Number.parseInt(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
			encoding: "utf8",
			maxBuffer: PS_MAX_BUFFER_BYTES,
		}).trim(), 10);
	} catch {
		return undefined;
	}
}

function sendSignal(kill, pid, signal) {
	try { kill(pid, signal); } catch {}
}

function groupIsHarnessOwned(pgid, rows, currentPgid) {
	if (currentPgid === undefined || pgid === currentPgid) return false;
	const leader = rows.find((row) => row.pid === pgid);
	return leader !== undefined && isHarnessProcess(leader);
}

function survivingGroupIsHarnessOwned(pgid, rows, currentPgid) {
	return currentPgid !== undefined
		&& pgid !== currentPgid
		&& rows.some((row) => row.pgid === pgid && hasHarnessSignature(row));
}

export async function fixIntegrationPreflight(report, {
	purgeEvidence = false,
	rows = processRows().rows,
	readRows = () => processRows().rows,
	currentPgid = currentProcessGroupId(rows),
	kill = process.kill.bind(process),
	wait = () => new Promise((resolveDelay) => setTimeout(resolveDelay, PREFLIGHT_TERM_GRACE_MS)),
} = {}) {
	const orphanIssue = report.issues.find((issue) => issue.code === "orphan-harness-children");
	const rowsByPid = new Map(rows.map((row) => [row.pid, row]));
	const liveHarnessPids = new Set(report.liveHarnessPids ?? []);
	const fixableRows = [];
	for (const reportedRow of orphanIssue?.rows ?? []) {
		const row = rowsByPid.get(reportedRow.pid);
		if (row !== undefined && isHarnessProcess(row) && !belongsToLiveHarnessRun(row, rowsByPid, liveHarnessPids)) fixableRows.push(row);
	}
	const harnessOwnedGroups = new Set(fixableRows
		.map((row) => row.pgid)
		.filter((pgid) => groupIsHarnessOwned(pgid, rows, currentPgid)));
	const individuallySignaled = new Map(fixableRows
		.filter((row) => !harnessOwnedGroups.has(row.pgid))
		.map((row) => [row.pid, row]));
	for (const pgid of harnessOwnedGroups) sendSignal(kill, -pgid, "SIGTERM");
	for (const row of individuallySignaled.values()) sendSignal(kill, row.pid, "SIGTERM");
	if (harnessOwnedGroups.size > 0 || individuallySignaled.size > 0) await wait();
	let latestRows = readRows();
	let escalated = false;
	for (const pgid of harnessOwnedGroups) {
		if (survivingGroupIsHarnessOwned(pgid, latestRows, currentPgid)) {
			sendSignal(kill, -pgid, "SIGKILL");
			escalated = true;
		}
	}
	for (const [pid, signaledRow] of individuallySignaled) {
		const survivor = latestRows.find((row) => row.pid === pid);
		if (survivor !== undefined && survivor.command === signaledRow.command && isHarnessProcess(survivor)) {
			sendSignal(kill, pid, "SIGKILL");
			escalated = true;
		}
	}
	if (escalated) {
		await wait();
		latestRows = readRows();
	}
	const latestRowsByPid = new Map(latestRows.map((row) => [row.pid, row]));

	const stateIssue = report.issues.find((issue) => issue.code === "stale-harness-state");
	// Destructive boundary: classification rechecks the harness basename and owner identity; report paths alone never authorize rm.
	for (const path of stateIssue?.paths ?? []) {
		if (await classifyHarnessDir(path, latestRowsByPid) === "stale") await rm(path, { recursive: true, force: true });
	}
	if (purgeEvidence) {
		for (const path of report.retainedEvidence ?? []) {
			if (await classifyHarnessDir(path, latestRowsByPid) === "retained") await rm(path, { recursive: true, force: true });
		}
	}
}

export async function runIntegrationPreflight({ fix = false, purgeEvidence = false } = {}) {
	let report = await inspectIntegrationPreflight();
	if (fix) {
		await fixIntegrationPreflight(report, { purgeEvidence });
		report = await inspectIntegrationPreflight();
	}
	for (const notice of report.notices) {
		const prefix = notice.startsWith("retained-evidence:") ? "" : "contained: ";
		process.stdout.write(`[integration preflight] ${prefix}${notice}\n`);
	}
	if (report.issues.length === 0) {
		process.stdout.write("[integration preflight] clean\n");
		return true;
	}
	for (const issue of report.issues) {
		process.stderr.write(`[integration preflight] ${issue.code}: ${issue.message}\n  remediation: ${issue.remediation}\n`);
	}
	return false;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const unknown = args.filter((arg) => arg !== "--fix" && arg !== "--purge-evidence");
	if (unknown.length > 0) {
		process.stderr.write(`unknown preflight option: ${unknown.join(" ")}\n`);
		process.exitCode = 2;
	} else if (args.includes("--purge-evidence") && !args.includes("--fix")) {
		process.stderr.write("--purge-evidence requires --fix\n");
		process.exitCode = 2;
	} else if (!await runIntegrationPreflight({ fix: args.includes("--fix"), purgeEvidence: args.includes("--purge-evidence") })) {
		process.exitCode = 1;
	}
}
