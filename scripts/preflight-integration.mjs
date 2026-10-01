#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
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
import { spawnRegistrationHmacIsValid } from "./lib/integration-harness-auth.mjs";
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
// `lstart` rides in the same snapshot as membership so a leader that exits
// between two separate ps calls cannot read as "present but birth unknown".
const PS_COLUMNS = "pid=,ppid=,pgid=,state=,lstart=,command=";
const PS_ARG_FORMS = process.platform === "darwin"
	? [["eww", "-axo", PS_COLUMNS], ["ewwaxo", PS_COLUMNS]]
	: [["ewwaxo", PS_COLUMNS], ["eww", "-axo", PS_COLUMNS]];
// lstart is a fixed 24-character field, e.g. "Sat Aug 22 13:54:46 2026".
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S{3} \S{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*)$/;
const RAW_COMMAND = Symbol("rawCommand");
const ENV_ASSIGNMENT = /\s+[A-Za-z_][A-Za-z0-9_]*=/;

function scrubPsCommand(command) {
	const visible = command.trimEnd();
	const environmentStart = visible.search(ENV_ASSIGNMENT);
	return environmentStart === -1 ? visible : visible.slice(0, environmentStart).trimEnd();
}

function commandForMarkers(row) {
	return row[RAW_COMMAND] ?? row.command;
}

function commandIdentity(row) {
	return row[RAW_COMMAND] ?? row.command;
}

function processRow(match) {
	const command = match[6].trimEnd();
	const row = {
		pid: Number(match[1]),
		ppid: Number(match[2]),
		pgid: Number(match[3]),
		state: match[4],
		start: match[5],
		command: scrubPsCommand(command),
	};
	Object.defineProperty(row, RAW_COMMAND, { value: command });
	return row;
}

export function processRows(execute = execFileSync) {
	let lastError;
	for (const args of PS_ARG_FORMS) {
		try {
			const output = execute("ps", args, {
				encoding: "utf8",
				maxBuffer: PS_MAX_BUFFER_BYTES,
				// lstart text is locale-dependent; pin it so birth-identity strings
				// captured here always compare equal across callers. The PATH stays
				// inherited: Node resolves the executable with the child env's PATH.
				env: { ...process.env, LC_ALL: "C" },
			});
			const rows = [];
			let malformedRows = 0;
			for (const line of output.split("\n")) {
				if (line.trim() === "") continue;
				const match = line.match(PS_ROW);
				if (!match) {
					// `eww` command text can wrap onto continuation lines that carry
					// no pid/ppid/pgid fields, so they can hide no process row. A
					// row-shaped line that fails to parse (e.g. truncated) still
					// invalidates the whole table.
					if (/^\s*\d/.test(line)) malformedRows += 1;
					continue;
				}
				rows.push(processRow(match));
			}
			// ps rows can carry process environments; count unparseable rows without
			// echoing them so the issue stays safe to print.
			return malformedRows === 0 ? { rows } : {
				rows,
				issue: {
					code: "process-table-malformed-row",
					message: `ps returned ${malformedRows} row(s) that do not match the expected pid/ppid/pgid/state/command shape; treating the table as unverified`,
					remediation: "inspect ps output manually, then rerun pnpm test:integration:preflight",
				},
			};
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
	const marker = `${key}=${value}`.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|\\s)${marker}(?:\\s|$)`).test(commandForMarkers(row));
}

function hasHarnessSignature(row) {
	return hasProcessMarker(row, HARNESS_SIGNATURE_ENV_KEY, HARNESS_SIGNATURE);
}

function isHarnessProcess(row) {
	return row.pid !== process.pid && (
		hasHarnessSignature(row)
		|| /(?:^|\/)sumocode-fake-pi-[A-Za-z0-9._-]+(?:\/|\s|$)/.test(commandForMarkers(row))
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
export function liveProcessStart(pid, execute = execFileSync) {
	try {
		return execute("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim() || undefined;
	} catch {
		return undefined;
	}
}

/* oxlint-disable anti-slop/no-runtime-typeof -- Owner JSON is untrusted state; validate present fields before contextual absence exemptions. */
async function readOwner(path) {
	const ownerPath = join(path, "owner.json");
	let before;
	try { before = await lstat(ownerPath); } catch (error) {
		return error?.code === "ENOENT" ? { absent: true } : { issue: "owner metadata unavailable" };
	}
	try {
		if (!before.isFile()) return { issue: "owner is not a regular file (symlinks refused)" };
		const contents = await readFile(ownerPath, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK });
		const after = await lstat(ownerPath);
		if (!after.isFile() || [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs].join(":")
			!== [after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(":")) return { issue: "owner changed during read" };
		const owner = JSON.parse(contents);
		if (owner === null || typeof owner !== "object" || Array.isArray(owner)
			|| !Number.isSafeInteger(owner.pid) || owner.pid <= 1) return { issue: "invalid owner object or pid" };
		if (Object.hasOwn(owner, "mode") && !["shared", "focused"].includes(owner.mode)) return { issue: "invalid owner mode" };
		for (const field of ["runId", "ownerToken", "ownerProcessStart"]) {
			if (Object.hasOwn(owner, field) && (typeof owner[field] !== "string" || owner[field].trim().length === 0)) return { issue: "invalid present owner identity field" };
		}
		return { owner: { pid: owner.pid, mode: owner.mode, runId: owner.runId,
			ownerToken: owner.ownerToken, ownerProcessStart: owner.ownerProcessStart } };
	} catch {
		return { issue: "owner read lost or malformed" };
	}
}
/* oxlint-enable anti-slop/no-runtime-typeof */

function unverifiedHarnessDir(path, code, reason) {
	return { classification: "unknown", issue: { code, path, message: `${reason}: ${path}`,
		remediation: "preserve this namespace and inspect its owner/census manually; fix and purge do not remove unknown state" } };
}

async function classifyHarnessDir(path, rowsByPid = new Map(), tokenIdentityAvailable = true) {
	const name = basename(path);
	if (!HARNESS_DIR_PREFIXES.some((prefix) => name.startsWith(prefix))) return { classification: "unrelated" };
	const ownerRead = await readOwner(path);
	if (ownerRead.issue) return unverifiedHarnessDir(path, "harness-owner-unverified", ownerRead.issue);
	const owner = ownerRead.owner;
	if (ownerRead.absent && !name.startsWith("sumocode-fake-pi-")) return unverifiedHarnessDir(path, "harness-owner-unverified", "required v2 owner is absent");
	const currentShared = name.startsWith("sumocode-harness-v2-run-") || owner?.mode === "shared";
	const focused = owner?.mode === "focused";
	if ((currentShared && (focused || owner?.runId === undefined || owner?.ownerToken === undefined))
		|| (focused && (!name.startsWith("sumocode-harness-v2-focused-") || owner.runId === undefined || owner.ownerProcessStart === undefined))
		|| (!focused && owner?.runId !== undefined && owner.ownerToken === undefined)) {
		return unverifiedHarnessDir(path, "harness-owner-unverified", "owner lacks the concrete writer's required identity");
	}
	const census = await deadRunSpawnRegistrations(path, owner, focused || (!currentShared && owner?.runId === undefined));
	if (census.issue) return { ...unverifiedHarnessDir(path, "harness-census-unverified", census.issue), registrations: census.registrations };
	if (owner !== undefined && pidIsAlive(owner.pid)) {
		if (owner.ownerToken !== undefined) {
			if (!tokenIdentityAvailable) return { classification: "live", owner };
			const row = rowsByPid.get(owner.pid);
			if (row !== undefined && hasProcessMarker(row, HARNESS_OWNER_TOKEN_ENV_KEY, owner.ownerToken)) return { classification: "live", owner };
		} else if (owner.ownerProcessStart !== undefined) {
			// Tokenless focused namespaces: identity = OS-reported start time of
			// the recorded pid. A reused PID is a different process with a
			// different start time, so the namespace classifies stale and --fix
			// can reclaim it (Codex cycle-4, PR #422).
			if (liveProcessStart(owner.pid) === owner.ownerProcessStart) return { classification: "live", owner };
		} else {
			// Legacy namespaces with neither identity field keep the original
			// PID-liveness behavior.
			return { classification: "live", owner };
		}
	}
	return { classification: existsSync(join(path, RETAINED_EVIDENCE_MARKER)) ? "retained" : "stale", registrations: census.registrations };
}

async function harnessState(tempRoot, rowsByPid, tokenIdentityAvailable) {
	const state = { staleDirs: [], retainedDirs: [], liveOwnerPids: [], registrations: [], issues: [] };
	let entries;
	try { entries = await readdir(tempRoot, { withFileTypes: true }); } catch {
		state.issues.push({
			code: "harness-root-unavailable", message: "required harness temp root cannot be read",
			remediation: "restore access to the required temp root and inspect it manually before retrying",
		});
		return state;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !HARNESS_DIR_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
		const path = join(tempRoot, entry.name);
		const result = await classifyHarnessDir(path, rowsByPid, tokenIdentityAvailable);
		if (result.issue) state.issues.push(result.issue);
		if (result.classification === "live") state.liveOwnerPids.push(result.owner.pid);
		else if (result.classification === "retained") state.retainedDirs.push(path);
		else if (result.classification === "stale") state.staleDirs.push(path);
		for (const registration of result.registrations ?? []) state.registrations.push({ path, ...registration });
	}
	return state;
}

/**
 * Spawn registrations left by a run whose owner is gone. No key survives a
 * dead runner that a same-user child could not also have read, so these are
 * identity records for a human, never proof that authorizes a signal.
 */
/* oxlint-disable anti-slop/no-runtime-typeof -- Postmortem records are schema-checked only; the signing key is gone and these never authorize signals. */
function deadManifestEventIsValid(event, runId) {
	if (event === null || typeof event !== "object" || Array.isArray(event)
		|| !["spawn", "exit", "reaped"].includes(event.event)
		|| !Number.isSafeInteger(event.pid) || event.pid <= 1
		|| !Number.isSafeInteger(event.pgid) || event.pgid <= 1
		|| (event.runId !== undefined && event.runId !== runId)) return false;
	for (const field of ["processStart", "ownerProcessStart", "runId", "registrationHmac", "evidenceDir"]) {
		if (Object.hasOwn(event, field) && (typeof event[field] !== "string" || event[field].trim().length === 0)) return false;
	}
	if ((event.ownerPid !== undefined && (!Number.isSafeInteger(event.ownerPid) || event.ownerPid <= 1 || event.ownerPid === event.pid))
		|| (event.ownershipMode !== undefined && !["shared", "focused"].includes(event.ownershipMode))
		|| (event.argv !== undefined && (!Array.isArray(event.argv) || !event.argv.every((arg) => typeof arg === "string")))
		|| (event.kind !== undefined && event.kind !== "pty")
		|| (event.code !== undefined && event.code !== null && !Number.isSafeInteger(event.code))
		|| (event.signal !== undefined && event.signal !== null && typeof event.signal !== "string" && !Number.isSafeInteger(event.signal))) return false;
	return event.event !== "spawn" || (event.runId === runId && typeof event.processStart === "string"
		&& typeof event.ownerProcessStart === "string" && Number.isSafeInteger(event.ownerPid) && event.ownerPid > 1 && event.ownerPid !== event.pid
		&& typeof event.registrationHmac === "string" && /^[a-f\d]{64}$/.test(event.registrationHmac));
}
/* oxlint-enable anti-slop/no-runtime-typeof */

async function deadRunSpawnRegistrations(path, owner, allowAbsent) {
	const manifest = join(path, "children.jsonl");
	let before;
	try { before = await lstat(manifest); } catch (error) {
		if (error?.code === "ENOENT" && allowAbsent) return { registrations: [] };
		return { issue: "required census absent or metadata unavailable" };
	}
	if (!before.isFile()) return { issue: "census is not a regular file (symlinks refused)" };
	// PID-only legacy owners are supported only when no census/modern authority exists.
	if (owner?.runId === undefined) return { issue: "present census lacks owner run identity" };
	let contents;
	let issue;
	try {
		contents = await readFile(manifest, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK });
		const after = await lstat(manifest);
		if (!after.isFile() || [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs].join(":")
			!== [after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(":")) issue = "census changed during read";
	} catch {
		issue = "census read unavailable or lost";
	}
	if (contents === undefined) return { issue };
	if (contents.length > 0 && !contents.endsWith("\n")) issue ??= "torn census line";
	const registrations = [];
	const tuples = new Set();
	const pgids = new Set();
	// Readable identities remain human-only exclusions even when other bytes or
	// later metadata are unknown; uncertainty never promotes them to authority.
	for (const line of contents.split("\n")) {
		if (!line.trim()) continue;
		let event;
		try { event = JSON.parse(line); } catch { issue ??= "malformed census line"; continue; }
		if (!deadManifestEventIsValid(event, owner.runId)) { issue ??= "invalid or foreign census event"; continue; }
		if (event.event !== "spawn") continue;
		const tuple = JSON.stringify([event.pid, event.pgid, event.processStart, event.ownerPid, event.ownerProcessStart, event.runId, event.registrationHmac]);
		if (tuples.has(tuple)) continue;
		if (pgids.has(event.pgid)) issue ??= "conflicting census registrations";
		registrations.push({ pid: event.pid, pgid: event.pgid, processStart: event.processStart });
		tuples.add(tuple);
		pgids.add(event.pgid);
	}
	return { registrations, issue };
}

function registrationMatchesRow(registration, row) {
	return row?.pid === registration.pid
		&& row.pgid === registration.pgid
		&& row.start === registration.processStart;
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

// dist/** is generated and never committed, so an absent checkout artifact is
// the normal source-fallback state. The harness builds its own private
// artifacts and never runs the checkout's, so a stale one here cannot affect
// the run; it is surfaced as a notice because local launches will silently
// fall back to source until it is rebuilt.
async function staleArtifactNotice(root, kind) {
	const manifestPath = join(root, "dist", kind, ".inputs.json");
	if (!existsSync(manifestPath)) return undefined;
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
	return `stale-dist-${kind}: dist/${kind} does not match its .inputs.json manifest; local launches use source until you run pnpm build:${kind}`;
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
	// Accept a full table (with `issue`) as well as a bare row array for callers.
	const processTable = rows === undefined ? processRows() : Array.isArray(rows) ? { rows } : rows;
	const issues = processTable.issue === undefined ? [] : [processTable.issue];
	const notices = [];
	const rowsByPid = new Map(processTable.rows.map((row) => [row.pid, row]));
	const state = await harnessState(tempRoot, rowsByPid, processTable.issue === undefined);
	issues.push(...state.issues);
	const liveHarnessPids = new Set([
		...state.liveOwnerPids,
		...signedHarnessLineage(process.pid, rowsByPid),
	]);
	// Title-hidden survivors of a dead run: recognizable by registered pid+birth,
	// but not reclaimable automatically. Surfaced with their identity so a human
	// can end them deliberately; --fix never signals on this evidence alone.
	const registeredSurvivors = [];
	if (processTable.issue === undefined) {
		for (const registration of state.registrations) {
			const row = rowsByPid.get(registration.pid);
			if (registrationMatchesRow(registration, row) && !belongsToLiveHarnessRun(row, rowsByPid, liveHarnessPids)) {
				registeredSurvivors.push({ path: registration.path, pid: registration.pid, pgid: registration.pgid, start: row.start, command: row.command.slice(0, 160) });
			}
		}
	}
	const orphanRows = [];
	const orphanPids = new Set(registeredSurvivors.map((group) => group.pid));
	// A partial or unavailable table proves nothing about ownership; classify
	// orphans only from a fully verified table.
	if (processTable.issue === undefined) {
		for (const row of processTable.rows) {
			if ((isHarnessProcess(row) || orphanPids.has(row.pid)) && !belongsToLiveHarnessRun(row, rowsByPid, liveHarnessPids)) orphanRows.push(row);
		}
	}
	if (orphanRows.length > 0) {
		issues.push({
			code: "orphan-harness-children",
			message: `harness-owned children are still alive: ${orphanRows.map((row) => `${row.pid} (${row.command.slice(0, 160)})`).join(", ")}`,
			remediation: registeredSurvivors.length > 0
				? `run node scripts/preflight-integration.mjs --fix; ${registeredSurvivors.length} title-hidden survivor(s) of a dead run cannot be authenticated post-mortem and must be ended by hand: ${registeredSurvivors.map((group) => `pid ${group.pid} pgid ${group.pgid} born ${group.start}`).join("; ")}`
				: "run node scripts/preflight-integration.mjs --fix",
			rows: orphanRows,
			registeredSurvivors,
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
		const notice = await staleArtifactNotice(root, kind);
		if (notice) notices.push(notice);
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
			env: { ...process.env, LC_ALL: "C" },
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

function ancestryStatus(pid, ancestorPid, rowsByPid) {
	const seen = new Set();
	while (Number.isSafeInteger(pid) && pid > 1) {
		if (pid === ancestorPid) return "reached";
		if (seen.has(pid)) return "cycle";
		seen.add(pid);
		const row = rowsByPid.get(pid);
		if (row === undefined) return "missing";
		pid = row.ppid;
	}
	return "root";
}

function membersCarryRunIdentity(members, ownerToken) {
	return members.every((row) => hasHarnessSignature(row) && hasProcessMarker(row, HARNESS_OWNER_TOKEN_ENV_KEY, ownerToken));
}

/** Birth identity from the same snapshot as membership; a separate ps call only when the row lacks one. */
function readStart(readProcessStart, row, pid) {
	if (row?.start) return row.start;
	try { return readProcessStart(pid); } catch { return undefined; }
}

function inspectHarnessProcessGroup(registration, table, currentPgid, readProcessStart) {
	if (table?.issue !== undefined || !Array.isArray(table?.rows)) {
		return { status: "unverified", identityStatus: "unknown", error: "process table unavailable" };
	}
	const rowsAreValid = table.rows.every((row) => Number.isSafeInteger(row?.pid) && row.pid > 0
		&& Number.isSafeInteger(row.ppid) && row.ppid >= 0
		&& Number.isSafeInteger(row.pgid) && row.pgid >= 0
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- process tables are untrusted at this signal boundary
		&& typeof row.command === "string"
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- injected process tables may omit state; actual ps rows always carry it
		&& (row.state === undefined || typeof row.state === "string"));
	if (!rowsAreValid) {
		return { status: "unverified", identityStatus: "unknown", error: "process table malformed" };
	}
	const rowsByPid = new Map(table.rows.map((row) => [row.pid, row]));
	if (rowsByPid.size !== table.rows.length) {
		return { status: "unverified", identityStatus: "unknown", error: "process table malformed" };
	}
	// Self-group exclusion must use the same validated snapshot as signal ownership.
	currentPgid ??= rowsByPid.get(process.pid)?.pgid;
	const {
		pid,
		pgid,
		processStart,
		ownerPid,
		ownerProcessStart,
		ownerToken,
		ownershipMode,
		runId,
		registrationHmac,
		signingKey,
	} = registration;
	const hasRegistrationAuth = runId !== undefined || registrationHmac !== undefined || signingKey !== undefined;
	if (hasRegistrationAuth && !spawnRegistrationHmacIsValid(registration, runId, signingKey)) {
		return { status: "unverified", identityStatus: "different", error: "spawn registration authentication failed" };
	}
	if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isSafeInteger(pgid) || pgid <= 1
		|| !Number.isSafeInteger(ownerPid) || ownerPid <= 1 || ownerPid === pid) {
		return { status: "unverified", identityStatus: "unknown", error: "invalid process identity" };
	}
	const members = table.rows.filter((row) => row.pgid === pgid && !row.state?.startsWith("Z"));
	if (members.length === 0) {
		// The group is empty, but if the registered leader's pid is alive in some
		// other group that pid has been reused; report it rather than "exited".
		const reused = table.rows.find((row) => row.pid === pid && !row.state?.startsWith("Z"));
		return reused === undefined
			? { status: "exited" }
			: { status: "unverified", identityStatus: "different", error: "leader pid reused outside the registered group" };
	}
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- registrations parsed from JSONL are untrusted at this effect boundary
	if (typeof processStart !== "string" || processStart.length === 0
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- registrations parsed from JSONL are untrusted at this effect boundary
		|| typeof ownerProcessStart !== "string" || ownerProcessStart.length === 0
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- unauthenticated registrations need the process-visible owner token fallback
		|| (!hasRegistrationAuth && (typeof ownerToken !== "string" || ownerToken.length === 0))
		|| (ownershipMode !== "shared" && ownershipMode !== "focused")
		|| currentPgid === undefined || pgid === currentPgid) {
		return { status: "unverified", identityStatus: "unknown", error: "incomplete or unsafe process identity" };
	}
	const leaderRow = rowsByPid.get(pid);
	const leader = leaderRow?.pgid === pgid && !leaderRow.state?.startsWith("Z") ? leaderRow : undefined;
	if (leader === undefined) {
		return membersCarryRunIdentity(members, ownerToken)
			? { status: "owned" }
			: { status: "unverified", identityStatus: "different", error: "process group ownership changed" };
	}
	const leaderStart = readStart(readProcessStart, leader, pid);
	if (leaderStart === undefined) {
		return { status: "unverified", identityStatus: "unknown", error: "leader birth identity unavailable" };
	}
	if (leaderStart !== processStart) {
		return { status: "unverified", identityStatus: "different", error: "leader birth identity changed" };
	}
	if (!members.every((row) => ancestryStatus(row.pid, pid, rowsByPid) === "reached")) {
		return { status: "unverified", identityStatus: "different", error: "process group ancestry changed" };
	}
	const ownerPath = ancestryStatus(pid, ownerPid, rowsByPid);
	if (ownerPath === "cycle") {
		return { status: "unverified", identityStatus: "different", error: "owner ancestry changed" };
	}
	if (ownerPath !== "reached") {
		// A valid HMAC authenticates the recorded tuple, not the live process.
		// Whole-second lstart cannot distinguish a same-second pid/pgid reuse.
		if (hasRegistrationAuth) {
			return { status: "unverified", identityStatus: "unknown", error: "owner process unavailable and leader birth identity is only whole-second resolution" };
		}
		return membersCarryRunIdentity(members, ownerToken)
			? { status: "owned" }
			: { status: "unverified", identityStatus: "different", error: "process group ownership changed" };
	}
	const owner = rowsByPid.get(ownerPid);
	if (owner === undefined || owner.pgid === pgid || owner.state?.startsWith("Z")) {
		return { status: "unverified", identityStatus: "unknown", error: "owner process unavailable" };
	}
	const ownerStart = readStart(readProcessStart, owner, ownerPid);
	if (ownerStart === undefined) {
		return { status: "unverified", identityStatus: "unknown", error: "owner birth identity unavailable" };
	}
	if (ownerStart !== ownerProcessStart) {
		return { status: "unverified", identityStatus: "different", error: "owner birth identity changed" };
	}
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- registrations parsed from JSONL are untrusted at this effect boundary
	if (ownershipMode === "shared" && (typeof ownerToken !== "string" || ownerToken.length === 0
		|| !hasHarnessSignature(owner) || !hasProcessMarker(owner, HARNESS_OWNER_TOKEN_ENV_KEY, ownerToken))) {
		return { status: "unverified", identityStatus: "different", error: "run owner authentication changed" };
	}
	return { status: "owned" };
}

/**
 * TERM→KILL a registered harness group only after checking the live leader,
 * its spawning owner, and every member's ancestry immediately before each
 * signal. If the owner is gone, only process-visible run identity can prove
 * a leader-less descendant group; a spawn HMAC does not identify a live pid.
 */
export async function reapHarnessProcessGroup(registration, {
	readProcessTable = processRows,
	currentPgid,
	readProcessStart = liveProcessStart,
	kill = process.kill.bind(process),
	wait = () => new Promise((resolveDelay) => setTimeout(resolveDelay, PREFLIGHT_TERM_GRACE_MS)),
} = {}) {
	const inspect = () => {
		let table;
		try { table = readProcessTable(); } catch { table = { rows: [], issue: true }; }
		return inspectHarnessProcessGroup(registration, table, currentPgid, readProcessStart);
	};
	let state = inspect();
	if (state.status !== "owned") return state;
	try { kill(-registration.pgid, "SIGTERM"); } catch (error) {
		// A denied signal (e.g. EPERM on an exiting group) proves nothing by
		// itself; the group may already be gone. Give it the same grace period
		// a delivered signal gets, then let the census decide.
		await wait();
		state = inspect();
		return state.status === "exited" ? { status: "reaped" } : { status: "unverified", identityStatus: "unknown", error: String(error) };
	}
	await wait();
	state = inspect();
	if (state.status === "exited") return { status: "reaped" };
	if (state.status !== "owned") {
		if (state.error === "process group ownership changed") {
			// A verified TERM can make the leader exit before short-lived descendants.
			// Never escalate from the changed-ownership snapshot; allow the existing
			// grace path to prove the group is empty, otherwise keep the refusal.
			await wait();
			return inspect().status === "exited" ? { status: "reaped" } : state;
		}
		return state;
	}
	try { kill(-registration.pgid, "SIGKILL"); } catch (error) {
		await wait();
		state = inspect();
		return state.status === "exited" ? { status: "reaped" } : { status: "unverified", identityStatus: "unknown", error: String(error) };
	}
	await wait();
	state = inspect();
	if (state.status === "exited") return { status: "reaped" };
	return state.status === "owned" ? { status: "survived" } : state;
}

export async function fixIntegrationPreflight(report, {
	purgeEvidence = false,
	table = processRows(),
	rows = table.rows,
	readRows = () => processRows().rows,
	currentPgid = currentProcessGroupId(rows),
	kill = process.kill.bind(process),
	wait = () => new Promise((resolveDelay) => setTimeout(resolveDelay, PREFLIGHT_TERM_GRACE_MS)),
} = {}) {
	// Signaling from an unverified table can misclassify a live child as an
	// orphan; refuse before any signal or removal when the table is suspect.
	const tableIssue = table.issue ?? report.issues.find((issue) => issue.code === "process-table-malformed-row" || issue.code === "process-table-unavailable");
	if (tableIssue !== undefined) {
		return { refused: true, reason: `${tableIssue.code}: refusing to signal or remove anything derived from an unverified process table` };
	}
	if (report.issues.some((issue) => issue.code === "harness-root-unavailable")) {
		return { refused: true, reason: "harness-root-unavailable: refusing fix from an unreadable required root" };
	}
	const orphanIssue = report.issues.find((issue) => issue.code === "orphan-harness-children");
	const rowsByPid = new Map(rows.map((row) => [row.pid, row]));
	const liveHarnessPids = new Set(report.liveHarnessPids ?? []);
	// Never auto-signal a dead run's registered survivors: their record is same-user writable.
	const registeredSurvivors = orphanIssue?.registeredSurvivors ?? [];
	const registeredSurvivorPids = new Set(registeredSurvivors.map((group) => group.pid));
	const registeredSurvivorGroups = new Set([
		...registeredSurvivors.map((group) => group.pgid),
		...rows.filter((row) => registeredSurvivorPids.has(row.pid)).map((row) => row.pgid),
	]);
	const fixableRows = [];
	for (const reportedRow of orphanIssue?.rows ?? []) {
		const row = rowsByPid.get(reportedRow.pid);
		if (row !== undefined && !registeredSurvivorPids.has(row.pid) && isHarnessProcess(row)
			&& !belongsToLiveHarnessRun(row, rowsByPid, liveHarnessPids)) fixableRows.push(row);
	}
	const harnessOwnedGroups = new Set(fixableRows
		.map((row) => row.pgid)
		// A signed sibling must not turn a human-only exclusion into a group signal.
		.filter((pgid) => !registeredSurvivorGroups.has(pgid) && groupIsHarnessOwned(pgid, rows, currentPgid)));
	const individuallySignaled = new Map(fixableRows
		.filter((row) => !harnessOwnedGroups.has(row.pgid))
		.map((row) => [row.pid, row]));
	for (const pgid of harnessOwnedGroups) sendSignal(kill, -pgid, "SIGTERM");
	for (const row of individuallySignaled.values()) sendSignal(kill, row.pid, "SIGTERM");
	if (harnessOwnedGroups.size > 0 || individuallySignaled.size > 0) await wait();
	let latestRows = readRows();
	let escalated = false;
	for (const pgid of harnessOwnedGroups) {
		if (!latestRows.some((row) => row.pgid === pgid && registeredSurvivorPids.has(row.pid))
			&& survivingGroupIsHarnessOwned(pgid, latestRows, currentPgid)) {
			sendSignal(kill, -pgid, "SIGKILL");
			escalated = true;
		}
	}
	for (const [pid, signaledRow] of individuallySignaled) {
		const survivor = latestRows.find((row) => row.pid === pid);
		if (survivor !== undefined && commandIdentity(survivor) === commandIdentity(signaledRow) && isHarnessProcess(survivor)) {
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
	const unresolved = report.issues.filter((issue) => issue.code === "harness-owner-unverified" || issue.code === "harness-census-unverified");
	// Both destructive boundaries freshly validate owner AND census. Unknown
	// beats stale/retained; a prior report and purge flag cannot authorize it.
	for (const path of stateIssue?.paths ?? []) {
		const fresh = await classifyHarnessDir(path, latestRowsByPid);
		if (fresh.issue) unresolved.push(fresh.issue);
		if (fresh.classification === "stale") await rm(path, { recursive: true, force: true });
	}
	if (purgeEvidence) {
		for (const path of report.retainedEvidence ?? []) {
			const fresh = await classifyHarnessDir(path, latestRowsByPid);
			if (fresh.issue) unresolved.push(fresh.issue);
			if (fresh.classification === "retained") await rm(path, { recursive: true, force: true });
		}
	}
	if (unresolved.length > 0) return { refused: true, reason: "unverified harness state remains preserved", issues: unresolved };
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
