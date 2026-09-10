import { randomUUID } from "node:crypto";
import type { WorktreeResult } from "../git/worktree-disposition.js";
import { RetainedResults } from "./retained-results.js";
import { isDeepStrictEqual } from "node:util";
import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { atomicWritePrivateJson, readPrivateJson, withPrivateFileLock, writePrivateJsonExclusive } from "../activity/persistence.js";
import { captureProcessBirthTime, type ProcessTreeIdentity, type ProcessTreeVerification } from "../background-tasks/process-tree.js";
import { assertPrivateArtifact, assertPrivateDir, isErrnoCode, nodeArtifactFs } from "../private-artifact.js";
import type { RunOutcome, SubagentLaunchFailure, SubagentPaneRef, SubagentRecoveryReason, SubagentWorktreeRef } from "./domain.js";
import { validateSubagentBudget, type SubagentBudget } from "./budget-policy.js";

export type ResultDisposition = "unreviewed" | "inspected" | "applied" | "dismissed" | "pruned";
export interface RegisteredWorktreeResult extends WorktreeResult {
	readonly disposition: ResultDisposition;
	readonly dispositionRevision: number;
}
const DISPOSITION_TRANSITIONS = {
	unreviewed: ["inspected", "dismissed"], inspected: ["applied", "dismissed", "pruned"],
	applied: ["dismissed", "pruned"], dismissed: ["pruned"], pruned: [],
} satisfies Record<ResultDisposition, readonly ResultDisposition[]>;

export interface RegistryProcess {
	readonly identity: ProcessTreeIdentity;
	readonly verification: ProcessTreeVerification;
}

export interface RegistryWriter {
	readonly token: string;
	readonly pid: number;
	/** Kernel birth time only, never argv. */
	readonly processStartTime: string;
}

export interface RegistryWriterLease {
	readonly generation: number;
	readonly owner: RegistryWriter;
	readonly renewedAt: number;
	readonly expiresAt: number;
}

/** A read snapshot, not a bearer credential. Reservation also checks the calling identity. */
export interface RegistryControlAuthority {
	readonly id: string;
	readonly ownerSessionId: string;
	readonly controllerSessionId?: string;
	readonly controllerGeneration?: number;
	readonly generation: number;
	readonly owner: RegistryWriter;
	readonly head: number;
}

export interface RegistryControlSuccessor {
	readonly sessionId: string;
	readonly owner: RegistryWriter;
}

export type RegistrySendState =
	| { readonly state: "undelivered" }
	| { readonly state: "sending"; readonly completionId: string; readonly controllerGeneration: number; readonly at: number }
	| { readonly state: "sent"; readonly completionId: string };

export type RegistryDelivery =
	| { readonly state: "none"; readonly claim: null }
	| RegistrySendState
	| { readonly state: "delivery-uncertain"; readonly completionId: string;
		readonly notice: RegistrySendState | { readonly state: "delivery-uncertain"; readonly completionId: string } };

export interface SubagentRecord {
	/** Explicit writer-authorized handoff; null/absent grants no successor rights. */
	readonly controlReservation?: RegistryControlSuccessor | null;
	readonly schemaVersion: 2;
	readonly budget?: SubagentBudget;
	/** Absent legacy telemetry means unobserved, never zero usage or a fresh heartbeat. */
	readonly telemetry?: {
		readonly startedAt: number | null;
		readonly lastProgressAt: number | null;
		readonly lastHeartbeatAt?: number;
		readonly reportedTokens?: number;
		readonly reportedCostUsd?: number;
	};
	readonly revision: number;
	readonly id: string;
	/** Immutable origin; readable history does not follow control handoffs. */
	readonly ownerSessionId: string;
	/** Absent on legacy records: origin session, generation zero. */
	readonly controllerSessionId?: string;
	readonly controllerGeneration?: number;
	readonly backend: "headless" | "visible";
	readonly status: "queued" | "starting" | "running" | "settling" | "settled" | "lost" | "ambiguous";
	readonly taskDir: string;
	/** null proves spawn was not admitted; absent legacy evidence is unknown. */
	readonly launchIntent?: { readonly nonce: string } | null;
	readonly child: RegistryProcess | null;
	readonly supervisor: RegistryProcess | null;
	readonly pane: SubagentPaneRef | null;
	readonly worktree: SubagentWorktreeRef | null;
	readonly sessionFilePath: string | null;
	readonly modelLabel: string | null;
	readonly roleId: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly settledAt: number | null;
	readonly completionId: string | null;
	readonly outcome: RunOutcome["kind"] | null;
	/** Structurally refused launch evidence; absent unless the owner observed one. */
	readonly failure?: SubagentLaunchFailure;
	readonly delivery: RegistryDelivery;
	/** Private direct-child artifacts; null means no durable result evidence. */
	readonly result: { readonly file: "result.json"; readonly bytes: number } | null;
	readonly manifest: { readonly file: "manifest.json"; readonly bytes: number } | null;
	readonly writerLease: RegistryWriterLease | null;
	readonly controlLease: RegistryWriterLease | null;
	/** Advances on grants, revocations and reservations; never reset, even with no lease. */
	readonly controlHead: number;
}

interface RecoveryObservation {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly revision: number;
	readonly controllerGeneration: number;
	readonly classification: "lost" | "ambiguous";
	readonly reason?: SubagentRecoveryReason;
}

export interface SubagentRegistryOptions {
	readonly now?: () => number;
	readonly writerIdentity?: RegistryWriter;
	readonly inspectWriter?: (owner: RegistryWriter) => "alive" | "dead" | "unknown";
}

export class SubagentRevisionConflict extends Error {}
export class SubagentLeaseConflict extends Error {}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- private control transport decodes an untrusted successor identity.
export function isRegistryControlSuccessor(value: unknown): value is RegistryControlSuccessor {
	return object(value, "owner sessionId") && writer(value.owner) && text(value.sessionId);
}

function inspectWriter(owner: RegistryWriter): "alive" | "dead" | "unknown" {
	try { process.kill(owner.pid, 0); }
	catch (error) {
		if (isErrnoCode(error, "ESRCH")) return "dead";
		if (!isErrnoCode(error, "EPERM")) return "unknown";
	}
	const birth = captureProcessBirthTime(owner.pid);
	return birth === undefined ? "unknown" : birth === owner.processStartTime ? "alive" : "dead";
}

function sameWriter(left: RegistryWriter, right: RegistryWriter): boolean {
	return left.token === right.token && left.pid === right.pid && left.processStartTime === right.processStartTime;
}

const MAX_RECORD_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const RECORD_KEYS = "schemaVersion revision id ownerSessionId backend status taskDir child supervisor pane worktree sessionFilePath modelLabel roleId createdAt updatedAt settledAt completionId outcome delivery result manifest writerLease controlLease controlHead";

// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- registry records are untrusted JSON; validate every field and reject unknown metadata (including prompt content).
function disposition(value: unknown): value is ResultDisposition {
	return value === "unreviewed" || value === "inspected" || value === "applied" || value === "dismissed" || value === "pruned";
}
function object(value: unknown, required: string, optional = ""): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const keys = Object.keys(value);
	const requiredKeys = required.split(" ");
	const allowed = new Set([...requiredKeys, ...(optional ? optional.split(" ") : [])]);
	return requiredKeys.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key));
}
function text(value: unknown): value is string {
	// oxlint-disable-next-line no-control-regex -- metadata must not carry control characters or multiline prompt text.
	return typeof value === "string" && value.trim().length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/u.test(value);
}
function integer(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function positive(value: unknown): value is number { return integer(value) && value > 0; }
function pathValue(value: unknown): value is string {
	return text(value) && isAbsolute(value) && resolve(value) === value;
}
function writer(value: unknown): value is RegistryWriter {
	return object(value, "token pid processStartTime") && text(value.token) && positive(value.pid) && text(value.processStartTime);
}
function lease(value: unknown): value is RegistryWriterLease {
	return object(value, "generation owner renewedAt expiresAt") && positive(value.generation) && writer(value.owner)
		&& integer(value.renewedAt) && positive(value.expiresAt) && value.expiresAt > value.renewedAt;
}
function processEvidence(value: unknown): boolean {
	if (value === null) return true;
	if (!object(value, "identity verification")) return false;
	const { identity, verification } = value;
	if (!object(identity, "pid processGroupId processStartTime") || !positive(identity.pid)
		|| !positive(identity.processGroupId) || !text(identity.processStartTime)
		|| !object(verification, "members") || !Array.isArray(verification.members)
		|| verification.members.length === 0 || verification.members.length > 4096) return false;
	const pids = new Set<number>();
	for (const member of verification.members) {
		if (!object(member, "pid processStartTime") || !positive(member.pid) || !text(member.processStartTime) || pids.has(member.pid)) return false;
		pids.add(member.pid);
	}
	return pids.has(identity.pid);
}
function pointer(value: unknown, file: string): boolean {
	return value === null || (object(value, "file bytes") && value.file === file && integer(value.bytes) && value.bytes <= MAX_RESULT_BYTES);
}
function launchFailure(value: unknown): value is SubagentLaunchFailure {
	if (!object(value, "paneStillOpen", "errorText errorCode errorReason paneTabGone orphanPane")) return false;
	// Host error text is a bounded diagnostic, not record metadata: unlike
	// identifiers it may carry the raw (possibly multi-line) stderr the host saw.
	const diagnostic = (candidate: unknown): candidate is string =>
		typeof candidate === "string" && candidate.length > 0 && candidate.length <= 4096;
	return typeof value.paneStillOpen === "boolean"
		&& (value.errorText === undefined || diagnostic(value.errorText))
		&& (value.errorCode === undefined || text(value.errorCode))
		&& (value.errorReason === undefined || diagnostic(value.errorReason))
		&& (value.paneTabGone === undefined || typeof value.paneTabGone === "boolean")
		&& (value.orphanPane === undefined
			|| object(value.orphanPane, "agentName", "workspaceId tabId paneId") && Object.values(value.orphanPane).every(text));
}
function sendState(value: unknown, completionId: string, generation: number, createdAt: number, updatedAt: number): boolean {
	if (object(value, "state") && value.state === "undelivered") return true;
	if (object(value, "state completionId") && value.state === "sent") return value.completionId === completionId;
	return object(value, "state completionId controllerGeneration at") && value.state === "sending"
		&& value.completionId === completionId && integer(value.controllerGeneration) && value.controllerGeneration <= generation
		&& integer(value.at) && value.at >= createdAt && value.at <= updatedAt;
}
function deliveryState(value: unknown, completionId: string | null, generation: number, createdAt: number, updatedAt: number): value is RegistryDelivery {
	if (completionId === null) return object(value, "state claim") && value.state === "none" && value.claim === null;
	if (sendState(value, completionId, generation, createdAt, updatedAt)) return true;
	if (!object(value, "state completionId notice") || value.state !== "delivery-uncertain" || value.completionId !== completionId) return false;
	const noticeId = `${completionId}:uncertain`;
	return sendState(value.notice, noticeId, generation, createdAt, updatedAt)
		|| object(value.notice, "state completionId") && value.notice.state === "delivery-uncertain" && value.notice.completionId === noticeId;
}
function validRecord(value: unknown): value is SubagentRecord {
	if (!object(value, RECORD_KEYS, "budget telemetry controllerSessionId controllerGeneration controlReservation launchIntent failure")) return false;
	if ((value.controllerSessionId === undefined) !== (value.controllerGeneration === undefined)
		|| value.controllerSessionId !== undefined && (!text(value.controllerSessionId) || !positive(value.controllerGeneration))) return false;
	if (value.controlReservation != null && (!object(value.controlReservation, "sessionId owner")
		|| !text(value.controlReservation.sessionId) || !writer(value.controlReservation.owner) || value.controlLease !== null)) return false;
	if (value.launchIntent != null && (!object(value.launchIntent, "nonce")
		|| typeof value.launchIntent.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(value.launchIntent.nonce))) return false;
	const r = value;
	if (r.budget !== undefined) {
		try { validateSubagentBudget(r.budget); } catch { return false; }
	}
	if (r.telemetry !== undefined) {
		if (!object(r.telemetry, "startedAt lastProgressAt", "lastHeartbeatAt reportedTokens reportedCostUsd")) return false;
		for (const key of ["startedAt", "lastProgressAt", "lastHeartbeatAt"] as const) {
			const at = r.telemetry[key];
			if (at === null && key !== "lastHeartbeatAt" || at === undefined && key === "lastHeartbeatAt") continue;
			if (!integer(at) || !integer(r.updatedAt) || !integer(r.createdAt) || at < r.createdAt || at > r.updatedAt) return false;
		}
		for (const key of ["reportedTokens", "reportedCostUsd"] as const) {
			const used = r.telemetry[key];
			if (used !== undefined && (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > Number.MAX_SAFE_INTEGER)) return false;
		}
	}
	if (r.schemaVersion !== 2 || !positive(r.revision) || !text(r.id) || !/^sa-[A-Za-z0-9_-]{1,128}$/u.test(r.id)
		|| !text(r.ownerSessionId) || !text(r.backend) || !["headless", "visible"].includes(r.backend)
		|| !text(r.status) || !["queued", "starting", "running", "settling", "settled", "lost", "ambiguous"].includes(r.status)
		|| !pathValue(r.taskDir) || !processEvidence(r.child) || !processEvidence(r.supervisor)
		|| !(r.sessionFilePath === null || pathValue(r.sessionFilePath))
		|| !(r.modelLabel === null || text(r.modelLabel)) || !(r.roleId === null || text(r.roleId))
		|| !integer(r.createdAt) || !integer(r.updatedAt) || r.updatedAt < r.createdAt
		|| !(r.settledAt === null || (integer(r.settledAt) && r.settledAt >= r.createdAt && r.settledAt <= r.updatedAt))
		|| !(r.completionId === null || text(r.completionId))
		|| !(r.outcome === null || (text(r.outcome) && ["completed", "failed", "interrupted"].includes(r.outcome)))
		|| !pointer(r.result, "result.json") || !pointer(r.manifest, "manifest.json")
		|| !integer(r.controlHead)
		|| !(r.controlLease === null || (lease(r.controlLease) && r.controlLease.generation <= r.controlHead
			&& r.controlLease.renewedAt >= r.createdAt && r.controlLease.renewedAt <= r.updatedAt))
		|| !(r.writerLease === null || (lease(r.writerLease) && r.writerLease.renewedAt <= r.updatedAt && r.writerLease.renewedAt >= r.createdAt))) return false;
	if (r.pane !== null && (!object(r.pane, "agentName", "workspaceId tabId paneId") || !Object.values(r.pane).every(text))) return false;
	if (r.failure !== undefined && !launchFailure(r.failure)) return false;
	if (r.backend === "headless" && r.pane !== null) return false;
	if (r.worktree !== null && (!object(r.worktree, "path branch baseRef repoRoot") || !pathValue(r.worktree.path)
		|| !pathValue(r.worktree.repoRoot) || !text(r.worktree.branch) || !text(r.worktree.baseRef))) return false;
	const generation = r.controllerGeneration ?? 0;
	if (!integer(generation) || !deliveryState(r.delivery, r.completionId, generation, r.createdAt, r.updatedAt)) return false;
	if (["running", "settling"].includes(r.status) && (r.child === null || r.supervisor === null || r.writerLease === null)) return false;
	if (r.status === "queued" && (r.child !== null || r.supervisor !== null)) return false;
	if (r.launchIntent === null && r.child !== null) return false;
	if (r.status === "settled") {
		if (r.settledAt === null || r.completionId === null || r.delivery.state === "none") return false;
	} else if (["queued", "starting", "running", "settling"].includes(r.status)) {
		if (r.settledAt !== null || r.completionId !== null || r.delivery.state !== "none") return false;
	}
	// Lost/ambiguous describe recovery evidence, not a fabricated successful exit.
	if ((r.completionId === null) !== (r.delivery.state === "none")) return false;
	if (r.completionId !== null && (r.settledAt === null || r.outcome === null)) return false;
	if (r.outcome !== null && !["settling", "settled", "lost", "ambiguous"].includes(r.status)) return false;
	return true;
}
// oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type

function matchesControlIdentity(current: SubagentRecord, authority: RegistryControlAuthority): boolean {
	const held = current.controlLease;
	return held !== null && authority.id === current.id && authority.ownerSessionId === current.ownerSessionId
		&& authority.controllerSessionId === current.controllerSessionId && authority.controllerGeneration === current.controllerGeneration
		&& authority.generation === held.generation && authority.head === current.controlHead
		&& writer(authority.owner) && sameWriter(authority.owner, held.owner);
}

function assertDirectory(path: string): void {
	assertPrivateDir(nodeArtifactFs, path, "subagent registry directory");
	if ((lstatSync(path).mode & 0o777) !== 0o700 || realpathSync(path) !== path) throw new Error("subagent directory must be canonical and 0700");
}

/** Disk authority only. No watchers, backend handles, signalling, or delivery effects. */
export class SubagentRegistry {
	private readonly directoryIdentity: { dev: number; ino: number };
	private writerIdentity?: RegistryWriter;

	public constructor(private readonly directory: string, private readonly ownerSessionId: string, private readonly options: SubagentRegistryOptions = {}) {
		if (!pathValue(directory) || !text(ownerSessionId)) throw new Error("invalid registry path or owner");
		assertDirectory(dirname(directory));
		try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (!isErrnoCode(error, "EEXIST")) throw error; }
		assertDirectory(directory);
		this.directoryIdentity = lstatSync(directory);
	}

	/** The configured private installation directory, not the active session, bounds discovery. */
	public discover(): Array<{ registry: SubagentRegistry; record: SubagentRecord }> {
		this.assertDirectoryIdentity();
		return readdirSync(this.directory).filter((name) => /^sa-[a-zA-Z0-9_-]+\.json$/.test(name)).map((name) => {
			const path = join(this.directory, name);
			assertPrivateArtifact(nodeArtifactFs, path, this.directory, "subagent discovery");
			const value = readPrivateJson(path, MAX_RECORD_BYTES);
			if (!validRecord(value)) throw new Error("corrupt discovered record");
			const registry = new SubagentRegistry(this.directory, value.ownerSessionId, this.options);
			this.assertDirectoryIdentity();
			return { registry, record: registry.get(name.slice(0, -5))! };
		});
	}

	/** A dead controller can be replaced without acquiring the surviving writer's lease. */
	public recoverControl(id: string, revision: number, generation: number, sessionId: string): SubagentRecord {
		if (!text(sessionId)) throw new Error("invalid controller session");
		return this.change(id, revision, (record, now) => {
			const owner = this.ownWriter();
			const inspect = this.options.inspectWriter ?? inspectWriter;
			const fence = (): void => {
				const at = this.clock(record);
				if ((record.controllerGeneration ?? 0) !== generation || record.controlReservation
					|| !record.writerLease || at >= record.writerLease.expiresAt || inspect(record.writerLease.owner) !== "alive"
					|| !record.controlLease || at < record.controlLease.expiresAt || inspect(record.controlLease.owner) !== "dead"
					|| inspect(owner) !== "alive" || this.clock(record) >= record.writerLease.expiresAt) throw new SubagentLeaseConflict("controller recovery refused");
			};
			fence();
			const head = record.controlHead + 1;
			fence();
			if (this.clock(record) >= now + 60_000) throw new SubagentLeaseConflict("recovery expired");
			return { ...record, controllerSessionId: sessionId, controllerGeneration: generation + 1, controlHead: head,
				controlLease: { owner, generation: head, renewedAt: now, expiresAt: now + 60_000 } };
		});
	}

	public controllerState(id: string): "alive" | "dead" | "unknown" {
		const lease = this.get(id)?.controlLease;
		return lease ? (this.options.inspectWriter ?? inspectWriter)(lease.owner) : "unknown";
	}

	public writerState(id: string): "alive" | "dead" | "unknown" {
		const lease = this.get(id)?.writerLease;
		return lease ? (this.options.inspectWriter ?? inspectWriter)(lease.owner) : "unknown";
	}

	/** Renew the same grant, without creating a new generation or effect slot. */
	public renewControl(authority: RegistryControlAuthority): void {
		const current = this.get(authority.id);
		if (!current) throw new Error("missing subagent record");
		this.change(current.id, current.revision, (record, now) => {
			if (!sameWriter(this.ownWriter(), authority.owner) || !this.matchesControl(record, authority, now)
				|| !this.matchesControl(record, authority, this.clock(record))) throw new SubagentLeaseConflict("control renewal refused");
			return { ...record, controlLease: { ...record.controlLease!, renewedAt: now, expiresAt: now + 60_000 } };
		});
	}

	/** A successor gets its own identity, never the persistence writer's token. */
	public forController(identity: RegistryWriter): SubagentRegistry {
		this.assertDirectoryIdentity();
		const controller = new SubagentRegistry(this.directory, this.ownerSessionId, { ...this.options, writerIdentity: structuredClone(identity) });
		this.assertDirectoryIdentity();
		return controller;
	}

	/** Observation only: this does not change leases, status, or grant effects. */
	public recordRecovery(id: string, expectedRevision: number, classification: "lost" | "ambiguous", reason?: SubagentRecoveryReason): void {
		if (!["lost", "ambiguous"].includes(classification)) throw new Error("invalid recovery classification");
		const path = this.recordPath(id);
		this.withLock(path, () => {
			const record = this.get(id);
			if (!record || record.revision !== expectedRevision) throw new SubagentRevisionConflict("recovery observation is stale");
			const base = { schemaVersion: 1 as const, id, revision: record.revision, controllerGeneration: record.controllerGeneration ?? 0, classification };
			const observation: RecoveryObservation = reason ? { ...base, reason } : base;
			const evidence = join(this.directory, `${id}.recovery-${record.revision}-${classification}.json`);
			try { writePrivateJsonExclusive(evidence, observation); }
			catch (error) {
				if (!isErrnoCode(error, "EEXIST")) throw error;
				assertPrivateArtifact(nodeArtifactFs, evidence, this.directory, "recovery observation");
				if (!isDeepStrictEqual(readPrivateJson(evidence, 4096), observation)) throw new Error("recovery observation changed");
			}
		});
	}

	public create(record: SubagentRecord): SubagentRecord {
		this.validate(record);
		if (record.launchIntent != null || record.revision !== 1 || record.controlReservation != null || record.controllerSessionId !== undefined || record.controllerGeneration !== undefined || record.controlLease !== null || record.controlHead !== 0 || record.writerLease !== null || record.child !== null || record.supervisor !== null || record.result !== null || record.manifest !== null || !["starting", "queued"].includes(record.status)) throw new Error("new registry record must be unlaunched at revision 1");
		const path = this.recordPath(record.id);
		return this.withLock(path, () => {
			this.validate(record);
			writePrivateJsonExclusive(path, record);
			return structuredClone(record);
		});
	}

	public get(id: string): SubagentRecord | undefined {
		const path = this.recordPath(id);
		try { assertPrivateArtifact(nodeArtifactFs, path, this.directory, "subagent record"); }
		catch (error) { if (isErrnoCode(error, "ENOENT")) return undefined; throw error; }
		const record = readPrivateJson(path, MAX_RECORD_BYTES);
		// Experimental v1 files are preserved, never silently upgraded into control authority.
		if (object(record, "schemaVersion", RECORD_KEYS) && record.schemaVersion !== 2) throw new Error("unsupported subagent record version");
		if (!validRecord(record) || record.id !== id) throw new Error("corrupt subagent record");
		this.validate(record);
		return record;
	}

	/** Human review metadata is independent of the persistence writer and delivery lease. */
	public worktreeResult(id: string): RegisteredWorktreeResult | undefined {
		const record = this.get(id);
		if (!record || record.status !== "settled" || !record.worktree || !record.completionId || !record.result || !record.manifest) return undefined;
		const evidence = RetainedResults.read(record.taskDir);
		if (!evidence || !("baseRef" in evidence.manifest)) throw new Error("worktree completion evidence unavailable");
		const manifest = evidence.manifest;
		if (manifest.baseRef !== record.worktree.baseRef || manifest.worktreePath !== record.worktree.path || manifest.branch !== record.worktree.branch) throw new Error("worktree completion binding changed");
		const path = join(this.directory, `${id}.disposition.json`);
		let state: ResultDisposition = "unreviewed";
		let revision = 0;
		try {
			assertPrivateArtifact(nodeArtifactFs, path, this.directory, "worktree disposition");
			const value = readPrivateJson(path, 4096);
			if (!object(value, "schemaVersion id completionId state revision") || value.schemaVersion !== 1
				|| value.id !== id || value.completionId !== record.completionId || !disposition(value.state)
				|| !positive(value.revision)) throw new Error("corrupt worktree disposition");
			state = value.state;
			revision = value.revision;
		} catch (error) { if (!isErrnoCode(error, "ENOENT")) throw error; }
		return { id, completionId: record.completionId, worktree: record.worktree, manifest, disposition: state, dispositionRevision: revision };
	}

	public setWorktreeDisposition(id: string, completionId: string, expectedRevision: number, next: ResultDisposition): RegisteredWorktreeResult {
		return this.withLock(this.recordPath(id), () => {
			const current = this.worktreeResult(id);
			if (!current || current.completionId !== completionId || current.dispositionRevision !== expectedRevision
				|| !DISPOSITION_TRANSITIONS[current.disposition].some((state) => state === next)) throw new Error("stale or invalid worktree disposition transition");
			const revision = expectedRevision + 1;
			atomicWritePrivateJson(join(this.directory, `${id}.disposition.json`), { schemaVersion: 1, id, completionId, state: next, revision });
			return { ...current, disposition: next, dispositionRevision: revision };
		});
	}

	/**
	 * Explicit session handoff, atomically acquiring writer and control generations.
	 * The recovery caller verifies retained process/pane evidence before this CAS
	 * and again before effects. This method grants no pipe or backend handle.
	 */
	public handoffController(id: string, expectedRevision: number, expectedGeneration: number, sessionId: string, durationMs: number): SubagentRecord {
		if (!text(sessionId) || !integer(expectedGeneration) || !positive(durationMs) || durationMs > 60_000) throw new Error("invalid controller handoff");
		return this.change(id, expectedRevision, (current, now) => {
			if ((current.controllerGeneration ?? 0) !== expectedGeneration) throw new SubagentLeaseConflict("stale controller generation");
			const owner = this.ownWriter();
			const inspect = this.options.inspectWriter ?? inspectWriter;
			if (inspect(owner) !== "alive") throw new SubagentLeaseConflict("candidate controller lease identity is not live");
			for (const held of [current.writerLease, current.controlLease]) {
				// Even the same process/token must not silently move a live session.
				if (held && (now < held.expiresAt || inspect(held.owner) !== "dead")) throw new SubagentLeaseConflict("controller lease is held or owner death is unproven");
			}
			if (this.clock(current) >= now + durationMs) throw new SubagentLeaseConflict("controller lease expired during inspection");
			const head = current.controlHead + 1;
			return { ...current, controlReservation: null, controllerSessionId: sessionId, controllerGeneration: expectedGeneration + 1,
				writerLease: { owner, generation: (current.writerLease?.generation ?? 0) + 1, renewedAt: now, expiresAt: now + durationMs },
				controlHead: head, controlLease: { owner, generation: head, renewedAt: now, expiresAt: now + durationMs },
			};
		});
	}

	/** CAS-acquire or renew. Even an expired lease blocks takeover until its process is proven dead. */
	public acquireWriter(id: string, expectedRevision: number, durationMs: number): SubagentRecord {
		if (!positive(durationMs) || durationMs > 60_000) throw new Error("writer lease duration must be 1..60000ms");
		return this.change(id, expectedRevision, (current, now) => {
			const owner = this.ownWriter();
			const inspect = this.options.inspectWriter ?? inspectWriter;
			if (inspect(owner) !== "alive") throw new SubagentLeaseConflict("candidate writer lease identity is not live");
			const previous = current.writerLease;
			if (previous && !sameWriter(previous.owner, owner)
				&& (now < previous.expiresAt || inspect(previous.owner) !== "dead")) throw new SubagentLeaseConflict("writer lease is held or owner death is unproven");
			const next = { ...current, writerLease: { owner, generation: (previous?.generation ?? 0) + 1, renewedAt: now, expiresAt: now + durationMs } };
			return previous && !sameWriter(previous.owner, owner) ? { ...next, controlReservation: null } : next;
		});
	}

	/**
	 * Only the live persistence writer grants control to an explicitly selected live
	 * identity. Session membership is not permission to self-grant. Bootstrap the
	 * writer in the controller, never in its spawning observer. This is same-user
	 * cooperative fencing, not authentication against a process that can edit disk.
	 * A live holder cannot be replaced without a separate explicit revocation.
	 */
	public acquireControl(id: string, expectedRevision: number, writerGeneration: number, expectedHead: number, owner: RegistryWriter, durationMs: number, sessionId?: string): SubagentRecord {
		if (!writer(owner) || !positive(durationMs) || durationMs > 60_000) throw new Error("invalid control lease candidate or duration");
		return this.change(id, expectedRevision, (current, now) => {
			const reservation = current.controlReservation;
			const assertGrant = (at: number): void => {
				if (!reservation) {
					if (sessionId !== undefined) throw new SubagentLeaseConflict("no successor reservation");
					this.assertWriter(current, writerGeneration, at);
					return;
				}
				const held = current.writerLease;
				if (reservation.sessionId !== sessionId || !sameWriter(reservation.owner, owner) || !sameWriter(this.ownWriter(), owner)
					|| !held || held.generation !== writerGeneration || at >= held.expiresAt
					|| (this.options.inspectWriter ?? inspectWriter)(held.owner) !== "alive" || this.clock(current) >= held.expiresAt) {
					throw new SubagentLeaseConflict("successor reservation or live writer unverified");
				}
			};
			assertGrant(now);
			if (current.controlHead !== expectedHead) throw new SubagentLeaseConflict("stale control head");
			const inspect = this.options.inspectWriter ?? inspectWriter;
			if (inspect(owner) !== "alive") throw new SubagentLeaseConflict("candidate control lease identity is not live");
			const previous = current.controlLease;
			if (previous && !sameWriter(previous.owner, owner)
				&& (now < previous.expiresAt || inspect(previous.owner) !== "dead")) throw new SubagentLeaseConflict("control lease is held or owner death is unproven");
			assertGrant(this.clock(current));
			if (this.clock(current) >= now + durationMs) throw new SubagentLeaseConflict("proposed control lease expired during inspection");
			const head = current.controlHead + 1;
			const next = { ...current, controlHead: head, controlLease: { owner: structuredClone(owner), generation: head, renewedAt: now, expiresAt: now + durationMs } };
			return reservation ? { ...next, controlReservation: null, controllerSessionId: reservation.sessionId, controllerGeneration: (current.controllerGeneration ?? 0) + 1 } : next;
		});
	}

	/** Only the current live writer may explicitly revoke, including an expired lease. */
	public releaseControl(expectedRevision: number, writerGeneration: number, authority: RegistryControlAuthority): SubagentRecord {
		return this.change(authority.id, expectedRevision, (current, now) => {
			this.assertWriter(current, writerGeneration, now);
			if (!matchesControlIdentity(current, authority)) throw new SubagentLeaseConflict("stale or absent control authority");
			this.assertWriter(current, writerGeneration, this.clock(current));
			return { ...current, controlLease: null, controlHead: current.controlHead + 1 };
		});
	}

	/**
	 * With a successor, only the persistence writer may reserve: this revokes the
	 * outgoing controller and binds the next grant to one session and identity.
	 * Without a successor this reserves an ordinary controller effect slot.
	 * Request IDs are exactly `${record.id}:${expectedHead + 1}`. Consuming the
	 * monotonically increasing slot makes that ID permanently unreservable again,
	 * including across restart/regrant. No payload or receipt history is stored.
	 * The later private request-file protocol MUST durably bind each logical request
	 * and its payload to this original session/record/slot before submission; it must
	 * never rebase a retry onto a fresh head. This cannot deduplicate renamed requests.
	 * Returns only after publication, BEFORE any caller effect. Lost return/ack is
	 * ambiguous, not permission to retry. No exactly-once effect guarantee.
	 */
	public reserveControl(expectedRevision: number, authority: RegistryControlAuthority, requestId: string, successor?: RegistryControlSuccessor & { readonly writerGeneration: number }): SubagentRecord {
		if (successor && (!text(successor.sessionId) || !writer(successor.owner))) throw new Error("invalid successor reservation");
		return this.change(authority.id, expectedRevision, (current, now) => {
			const owner = this.ownWriter();
			if (!this.matchesControl(current, authority, now)) throw new SubagentLeaseConflict("stale or absent control authority");
			if (successor) {
				this.assertWriter(current, successor.writerGeneration, now);
				if ((this.options.inspectWriter ?? inspectWriter)(successor.owner) !== "alive") throw new SubagentLeaseConflict("successor identity unverified");
				this.assertWriter(current, successor.writerGeneration, this.clock(current));
			} else if (!sameWriter(current.controlLease!.owner, owner)) throw new SubagentLeaseConflict("control lease is not owned");
			if (!this.matchesControl(current, authority, this.clock(current))) throw new SubagentLeaseConflict("control authority expired during reservation");
			if (requestId !== `${current.id}:${current.controlHead + 1}`) throw new SubagentLeaseConflict("control request does not identify the next slot");
			const next = { ...current, controlHead: current.controlHead + 1 };
			return successor ? { ...next, controlLease: null, controlReservation: { sessionId: successor.sessionId, owner: structuredClone(successor.owner) } } : next;
		});
	}

	/**
	 * Read-only effect/post-ack fence. Ordinary writer heartbeat revisions do not
	 * invalidate it; control changes, expiry and unproven liveness do. A true result
	 * is a point-in-time observation, not a lock spanning OS effects or an async ack.
	 * Use the reservation's resulting head, not the pre-reservation snapshot.
	 */
	public inspectControl(authority: RegistryControlAuthority): boolean {
		const current = this.get(authority.id);
		return current !== undefined && this.matchesControl(current, authority, this.clock(current));
	}

	private matchesControl(current: SubagentRecord, authority: RegistryControlAuthority, now: number): boolean {
		const held = current.controlLease;
		return held !== null && matchesControlIdentity(current, authority) && now < held.expiresAt
			&& (this.options.inspectWriter ?? inspectWriter)(held.owner) === "alive" && this.clock(current) < held.expiresAt;
	}

	/** Sender admission only: Pi's void return is not a conversation-insertion receipt. */
	public advanceDelivery(expectedRevision: number, authority: RegistryControlAuthority, action: "send" | "sent" | "uncertain", notice = false): SubagentRecord {
		return this.change(authority.id, expectedRevision, (current, now) => {
			const fence = (): void => {
				if (!sameWriter(this.ownWriter(), authority.owner) || !this.matchesControl(current, authority, this.clock(current))) throw new SubagentLeaseConflict("stale delivery controller");
			};
			fence();
			if (current.status !== "settled" || !current.completionId || !current.result || !current.manifest) throw new Error("delivery requires settled result evidence");
			const delivery = current.delivery;
			const slot = notice && delivery.state === "delivery-uncertain" ? delivery.notice : delivery;
			if (notice && delivery.state !== "delivery-uncertain") throw new Error("no uncertainty notice");
			const completionId = notice ? `${current.completionId}:uncertain` : current.completionId;
			const generation = current.controllerGeneration ?? 0;
			let next: RegistrySendState | { readonly state: "delivery-uncertain"; readonly completionId: string };
			if (action === "send" && slot.state === "undelivered") next = { state: "sending", completionId, controllerGeneration: generation, at: now };
			else if (action === "sent" && slot.state === "sending" && slot.controllerGeneration === generation) next = { state: "sent", completionId };
			else if (action === "uncertain" && slot.state === "sending" && slot.controllerGeneration < generation) next = { state: "delivery-uncertain", completionId };
			else throw new SubagentLeaseConflict("delivery state transition refused");
			fence();
			return { ...current, delivery: notice && delivery.state === "delivery-uncertain" ? { ...delivery, notice: next }
				: next.state === "delivery-uncertain" ? { ...next, notice: { state: "undelivered" } } : next };
		});
	}

	/** The callback only decides metadata. It must not signal, launch, deliver, or return a promise. */
	public transition(id: string, expectedRevision: number, generation: number, update: (current: SubagentRecord) => SubagentRecord): SubagentRecord {
		return this.change(id, expectedRevision, (current, now) => {
			this.assertWriter(current, generation, now);
			const next = update(structuredClone(current));
			if (!isDeepStrictEqual(next.delivery, current.delivery)
				&& !(current.delivery.state === "none" && next.delivery.state === "undelivered" && next.status === "settled")) throw new Error("delivery requires controller CAS");
			for (const key of ["schemaVersion", "id", "ownerSessionId", "backend", "taskDir", "createdAt", "writerLease", "controlLease", "controlHead", "controllerSessionId", "controllerGeneration", "controlReservation", "budget"] as const) {
				if (!isDeepStrictEqual(next[key], current[key])) throw new Error(`immutable registry field: ${key}`);
			}
			for (const key of ["child", "supervisor", "pane", "worktree", "sessionFilePath", "completionId", "outcome", "settledAt", "result", "manifest"] as const) {
				if (current[key] !== null && !isDeepStrictEqual(next[key], current[key])) throw new Error(`registry evidence must be preserved: ${key}`);
			}
			// Optional evidence (absent on legacy records) needs its own guard:
			// `undefined !== null` would make the loop above reject the first write.
			if (current.failure != null && !isDeepStrictEqual(next.failure, current.failure)) throw new Error("registry evidence must be preserved: failure");
			if (current.launchIntent !== undefined && (next.launchIntent === undefined
				|| current.launchIntent !== null && !isDeepStrictEqual(current.launchIntent, next.launchIntent))) throw new Error("launch intent must be preserved");
			if (current.telemetry) {
				if (!next.telemetry) throw new Error("registry telemetry must be preserved");
				for (const key of ["startedAt", "lastProgressAt", "lastHeartbeatAt", "reportedTokens", "reportedCostUsd"] as const) {
					const before = current.telemetry[key];
					const after = next.telemetry[key];
					if (before != null && (after == null || after < before || key === "startedAt" && after !== before)) throw new Error("registry telemetry must be preserved");
				}
			}
			this.assertWriter(current, generation, this.clock(current));
			return next;
		});
	}

	private change(id: string, expectedRevision: number, update: (current: SubagentRecord, now: number) => SubagentRecord): SubagentRecord {
		const path = this.recordPath(id);
		return this.withLock(path, () => {
			const current = this.get(id);
			if (!current) throw new Error("missing subagent record");
			if (current.revision !== expectedRevision) throw new SubagentRevisionConflict(`subagent revision conflict: expected ${expectedRevision}, found ${current.revision}`);
			const next = { ...update(current, this.clock(current)), revision: current.revision + 1, updatedAt: this.clock(current) };
			this.validate(next);
			atomicWritePrivateJson(path, next);
			return structuredClone(next);
		});
	}

	private withLock<T>(path: string, operation: () => T): T {
		const lock = `${path}.lock`;
		// The shared lock handles stale-reader/rename races. Check ownership here too:
		// its JSON reader checks inode/mode, but deliberately does not check uid.
		for (const name of readdirSync(this.directory)) {
			if (name !== basename(lock) && !name.startsWith(`${basename(lock)}.takeover-`)) continue;
			const candidate = join(this.directory, name);
			try {
				assertPrivateArtifact(nodeArtifactFs, candidate, this.directory, "subagent registry lock");
				const owner = readPrivateJson(candidate, 16 * 1024);
				if (!object(owner, "schemaVersion token pid", "processStartTime") || owner.schemaVersion !== 1 || !text(owner.token)
					|| !positive(owner.pid) || !(owner.processStartTime === undefined || text(owner.processStartTime))) throw new Error("corrupt subagent registry lock");
			} catch (error) { if (!isErrnoCode(error, "ENOENT")) throw error; }
		}
		return withPrivateFileLock(lock, operation);
	}

	private ownWriter(): RegistryWriter {
		if (!this.writerIdentity) {
			const candidate = this.options.writerIdentity ?? { token: randomUUID(), pid: process.pid, processStartTime: captureProcessBirthTime(process.pid) };
			if (!writer(candidate)) throw new SubagentLeaseConflict("writer birth identity unavailable");
			this.writerIdentity = structuredClone(candidate);
		}
		return structuredClone(this.writerIdentity);
	}

	private assertWriter(record: SubagentRecord, generation: number, now: number): void {
		const held = record.writerLease;
		const owner = this.ownWriter();
		if (!held || held.generation !== generation || !sameWriter(held.owner, owner) || now >= held.expiresAt
			|| (this.options.inspectWriter ?? inspectWriter)(owner) !== "alive" || this.clock(record) >= held.expiresAt) throw new SubagentLeaseConflict("writer lease is stale, expired, or not owned");
	}

	private clock(record: SubagentRecord): number {
		// Persist epoch milliseconds across restarts. Rollback blocks writes until wall time catches up;
		// forward jumps never evict a live owner. No monotonic timestamp survives process replacement.
		const now = (this.options.now ?? Date.now)();
		if (!integer(now) || now < record.updatedAt) throw new Error("registry clock moved backwards or is invalid");
		return now;
	}

	private recordPath(id: string): string {
		if (!/^sa-[A-Za-z0-9_-]{1,128}$/u.test(id)) throw new Error("invalid subagent id");
		this.assertDirectoryIdentity();
		return join(this.directory, `${id}.json`);
	}

	private assertDirectoryIdentity(): void {
		assertDirectory(dirname(this.directory));
		assertDirectory(this.directory);
		const current = lstatSync(this.directory);
		if (current.dev !== this.directoryIdentity.dev || current.ino !== this.directoryIdentity.ino) throw new Error("registry directory replaced");
	}

	private validate(record: SubagentRecord): void {
		if (!validRecord(record) || Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`) > MAX_RECORD_BYTES) throw new Error("invalid subagent record schema");
		if (record.ownerSessionId !== this.ownerSessionId) throw new Error("subagent owner mismatch");
		this.recordPath(record.id);
		try { assertDirectory(record.taskDir); }
		catch (error) {
			if (!(isErrnoCode(error, "ENOENT") && ["lost", "ambiguous"].includes(record.status))) throw error;
		}
		for (const artifact of [record.result, record.manifest]) {
			if (artifact === null) continue;
			const path = join(record.taskDir, artifact.file);
			assertPrivateArtifact(nodeArtifactFs, path, record.taskDir, "subagent result evidence");
			const stat = lstatSync(path);
			if ((stat.mode & 0o777) !== 0o600 || stat.size !== artifact.bytes) throw new Error("subagent artifact size or mode mismatch");
		}
	}
}
