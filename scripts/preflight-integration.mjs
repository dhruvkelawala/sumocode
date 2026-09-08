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

export function processRows(execute = execFileSync) {
	let lastError;
	for (const args of PS_ARG_FORMS) {
		try {
			const output = execute("ps", args, {
				encoding: "utf8",
				maxBuffer: PS_MAX_BUFFER_BYTES,
			});
			const rows = [];
			let malformedRows = 0;
			for (const line of output.split("\n")) {
				if (line.trim() === "") continue;
				const match = line.match(PS_ROW);
				if (!match) {
					malformedRows += 1;
					continue;
				}
				rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), state: match[4], start: match[5], command: match[6].trimEnd() });
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
	return new RegExp(`(?:^|\\s)${marker}(?:\\s|$)`).test(row.command);
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
export function liveProcessStart(pid, execute = execFileSync) {
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
			mode: owner.mode === "focused" ? "focused" : "shared",
			// oxlint-disable-next-line anti-slop/no-runtime-typeof -- owner.json is untrusted state parsed at this I/O boundary
			runId: typeof owner.runId === "string" && owner.runId.length > 0 ? owner.runId : undefined,
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
	try { entries = await readdir(tempRoot, { withFileTypes: true }); } catch { return { staleDirs: [], retainedDirs: [], liveOwnerPids: [], dirs: [] }; }
	const state = { staleDirs: [], retainedDirs: [], liveOwnerPids: [], dirs: [] };
	for (const entry of entries) {
		if (!entry.isDirectory() || !HARNESS_DIR_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
		const path = join(tempRoot, entry.name);
		state.dirs.push(path);
		const classification = await classifyHarnessDir(path, rowsByPid, tokenIdentityAvailable);
		if (classification === "live") {
			const owner = await readOwner(path);
			if (owner !== undefined) state.liveOwnerPids.push(owner.pid);
		} else if (classification === "retained") state.retainedDirs.push(path);
		else if (classification === "stale") state.staleDirs.push(path);
	}
	return state;
}

/**
 * Spawn registrations left by a run whose owner is gone. No key survives a
 * dead runner that a same-user child could not also have read, so these are
 * identity records for a human, never proof that authorizes a signal.
 */
async function deadRunSpawnRegistrations(path) {
	const owner = await readOwner(path);
	if (owner?.runId === undefined) return [];
	let contents;
	try { contents = await readFile(join(path, "children.jsonl"), "utf8"); } catch { return []; }
	const registrations = [];
	for (const line of contents.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event.event !== "spawn" || event.runId !== owner.runId) continue;
			if (!Number.isSafeInteger(event.pid) || !Number.isSafeInteger(event.pgid)) continue;
			registrations.push({ pid: event.pid, pgid: event.pgid, processStart: event.processStart });
		} catch {
			// A killed worker may leave one partial final append.
		}
	}
	return registrations;
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
	const processTable = rows === undefined ? processRows() : { rows };
	const issues = processTable.issue === undefined ? [] : [processTable.issue];
	const notices = [];
	const rowsByPid = new Map(processTable.rows.map((row) => [row.pid, row]));
	const state = await harnessState(tempRoot, rowsByPid, processTable.issue === undefined);
	const liveHarnessPids = new Set([
		...state.liveOwnerPids,
		...signedHarnessLineage(process.pid, rowsByPid),
	]);
	// Title-hidden survivors of a dead run: recognizable by registered pid+birth,
	// but not reclaimable automatically. Surfaced with their identity so a human
	// can end them deliberately; --fix never signals on this evidence alone.
	const registeredSurvivors = [];
	if (processTable.issue === undefined) {
		for (const path of state.dirs) {
			for (const registration of await deadRunSpawnRegistrations(path)) {
				const row = rowsByPid.get(registration.pid);
				if (registrationMatchesRow(registration, row) && !belongsToLiveHarnessRun(row, rowsByPid, liveHarnessPids)) {
					registeredSurvivors.push({ path, pid: registration.pid, pgid: registration.pgid, start: row.start, command: row.command.slice(0, 160) });
				}
			}
		}
	}
	const orphanRows = [];
	const orphanPids = new Set(registeredSurvivors.map((group) => group.pid));
	for (const row of processTable.rows) {
		if ((isHarnessProcess(row) || orphanPids.has(row.pid)) && !belongsToLiveHarnessRun(row, rowsByPid, liveHarnessPids)) orphanRows.push(row);
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
	if (state.status !== "owned") return state;
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
	rows = processRows().rows,
	readRows = () => processRows().rows,
	currentPgid = currentProcessGroupId(rows),
	kill = process.kill.bind(process),
	wait = () => new Promise((resolveDelay) => setTimeout(resolveDelay, PREFLIGHT_TERM_GRACE_MS)),
} = {}) {
	const orphanIssue = report.issues.find((issue) => issue.code === "orphan-harness-children");
	const rowsByPid = new Map(rows.map((row) => [row.pid, row]));
	const liveHarnessPids = new Set(report.liveHarnessPids ?? []);
	// Never auto-signal a dead run's registered survivors: their record is same-user writable.
	const registeredSurvivorPids = new Set((orphanIssue?.registeredSurvivors ?? []).map((group) => group.pid));
	const fixableRows = [];
	for (const reportedRow of orphanIssue?.rows ?? []) {
		const row = rowsByPid.get(reportedRow.pid);
		if (row !== undefined && !registeredSurvivorPids.has(row.pid) && isHarnessProcess(row)
			&& !belongsToLiveHarnessRun(row, rowsByPid, liveHarnessPids)) fixableRows.push(row);
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
