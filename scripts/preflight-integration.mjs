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
import { HARNESS_SIGNATURE, HARNESS_SIGNATURE_ENV_KEY } from "./lib/integration-harness-constants.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HARNESS_DIR_PREFIXES = ["sumocode-harness-v2-", "sumocode-fake-pi-"];
const RETAINED_EVIDENCE_MARKER = "evidence-retained.json";
const PS_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const PREFLIGHT_TERM_GRACE_MS = 300;

function processRows() {
	try {
		const output = execFileSync("ps", ["eww", "-axo", "pid=,ppid=,pgid=,command="], {
			encoding: "utf8",
			maxBuffer: PS_MAX_BUFFER_BYTES,
		});
		const rows = output.split("\n").flatMap((line) => {
			const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
			return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] }] : [];
		});
		return { rows };
	} catch (error) {
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

function isHarnessProcess(row) {
	return row.pid !== process.pid && (
		row.command.includes(`${HARNESS_SIGNATURE_ENV_KEY}=${HARNESS_SIGNATURE}`)
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

async function readOwnerPid(path) {
	try {
		const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
		return Number.isSafeInteger(owner?.pid) && owner.pid > 1 ? owner.pid : undefined;
	} catch {
		return undefined;
	}
}

async function classifyHarnessDir(path) {
	if (!HARNESS_DIR_PREFIXES.some((prefix) => basename(path).startsWith(prefix))) return "unrelated";
	const ownerPid = await readOwnerPid(path);
	if (ownerPid !== undefined && pidIsAlive(ownerPid)) return "live";
	return existsSync(join(path, RETAINED_EVIDENCE_MARKER)) ? "retained" : "stale";
}

async function harnessState(tempRoot) {
	let entries = [];
	try { entries = await readdir(tempRoot, { withFileTypes: true }); } catch { return { staleDirs: [], retainedDirs: [] }; }
	const state = { staleDirs: [], retainedDirs: [] };
	for (const entry of entries) {
		if (!entry.isDirectory() || !HARNESS_DIR_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
		const path = join(tempRoot, entry.name);
		const classification = await classifyHarnessDir(path);
		if (classification === "retained") state.retainedDirs.push(path);
		else if (classification === "stale") state.staleDirs.push(path);
	}
	return state;
}

function harnessRunRootFromCommand(command) {
	return command.match(/(?:^|\s)SUMOCODE_INTEGRATION_RUN_ROOT=([^\s]+)/)?.[1];
}

async function belongsToLiveHarnessRun(row) {
	const runRoot = harnessRunRootFromCommand(row.command);
	if (runRoot === undefined) return false;
	const ownerPid = await readOwnerPid(runRoot);
	return ownerPid !== undefined && pidIsAlive(ownerPid);
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
	const state = await harnessState(tempRoot);
	const orphanRows = [];
	for (const row of processTable.rows.filter(isHarnessProcess)) {
		if (!await belongsToLiveHarnessRun(row)) orphanRows.push(row);
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
	return { issues, notices, retainedEvidence: state.retainedDirs };
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

export async function fixIntegrationPreflight(report, {
	purgeEvidence = false,
	rows = processRows().rows,
	readRows = () => processRows().rows,
	currentPgid = currentProcessGroupId(rows),
	kill = process.kill.bind(process),
	wait = () => new Promise((resolveDelay) => setTimeout(resolveDelay, PREFLIGHT_TERM_GRACE_MS)),
} = {}) {
	const orphanIssue = report.issues.find((issue) => issue.code === "orphan-harness-children");
	const fixableRows = [];
	for (const reportedRow of orphanIssue?.rows ?? []) {
		const row = rows.find((candidate) => candidate.pid === reportedRow.pid);
		if (row !== undefined && isHarnessProcess(row) && !await belongsToLiveHarnessRun(row)) fixableRows.push(row);
	}
	const harnessOwnedGroups = new Set(fixableRows
		.map((row) => row.pgid)
		.filter((pgid) => groupIsHarnessOwned(pgid, rows, currentPgid)));
	for (const pgid of harnessOwnedGroups) sendSignal(kill, -pgid, "SIGTERM");
	for (const row of fixableRows) {
		if (!harnessOwnedGroups.has(row.pgid)) sendSignal(kill, row.pid, "SIGTERM");
	}
	if (harnessOwnedGroups.size > 0) await wait();
	const rowsBeforeKill = readRows();
	for (const pgid of harnessOwnedGroups) {
		if (groupIsHarnessOwned(pgid, rowsBeforeKill, currentPgid)) sendSignal(kill, -pgid, "SIGKILL");
	}

	const stateIssue = report.issues.find((issue) => issue.code === "stale-harness-state");
	// Destructive boundary: classification rechecks the harness basename; report paths alone never authorize rm.
	for (const path of stateIssue?.paths ?? []) {
		if (await classifyHarnessDir(path) === "stale") await rm(path, { recursive: true, force: true });
	}
	if (purgeEvidence) {
		for (const path of report.retainedEvidence ?? []) {
			if (await classifyHarnessDir(path) === "retained") await rm(path, { recursive: true, force: true });
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
