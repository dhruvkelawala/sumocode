import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readPrivateJson, withPrivateFileLock, writePrivateJsonExclusive } from "../activity/persistence.js";
import type { ProcessTreeIdentity, ProcessTreeVerification } from "../background-tasks/process-tree.js";
import { assertPrivateArtifact, assertPrivateDir, isErrnoCode, nodeArtifactFs } from "../private-artifact.js";
import type { SubagentPaneRef, SubagentWorktreeRef } from "./domain.js";

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

export interface SubagentRecord {
	readonly schemaVersion: 1;
	readonly revision: number;
	readonly id: string;
	readonly ownerSessionId: string;
	readonly backend: "headless" | "visible";
	readonly status: "queued" | "starting" | "running" | "settling" | "settled" | "lost" | "ambiguous";
	readonly taskDir: string;
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
	readonly delivery: {
		readonly state: "none" | "pending" | "claimed" | "delivered" | "suppressed";
		readonly claim: RegistryWriterLease | null;
	};
	/** Private direct-child artifacts; null means no durable result evidence. */
	readonly result: { readonly file: "result.json"; readonly bytes: number } | null;
	readonly manifest: { readonly file: "manifest.json"; readonly bytes: number } | null;
	readonly writerLease: RegistryWriterLease | null;
}

const MAX_RECORD_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const RECORD_KEYS = "schemaVersion revision id ownerSessionId backend status taskDir child supervisor pane worktree sessionFilePath modelLabel roleId createdAt updatedAt settledAt completionId delivery result manifest writerLease";

// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- registry records are untrusted JSON; validate every field and reject unknown metadata (including prompt content).
function object(value: unknown, required: string, optional = ""): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const keys = Object.keys(value);
	const requiredKeys = required.split(" ");
	const allowed = new Set([...requiredKeys, ...optional.split(" ")]);
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
function validRecord(value: unknown): value is SubagentRecord {
	if (!object(value, RECORD_KEYS)) return false;
	const r = value;
	if (r.schemaVersion !== 1 || !positive(r.revision) || !text(r.id) || !/^sa-[A-Za-z0-9_-]{1,128}$/u.test(r.id)
		|| !text(r.ownerSessionId) || !["headless", "visible"].includes(String(r.backend))
		|| !["queued", "starting", "running", "settling", "settled", "lost", "ambiguous"].includes(String(r.status))
		|| !pathValue(r.taskDir) || !processEvidence(r.child) || !processEvidence(r.supervisor)
		|| !(r.sessionFilePath === null || pathValue(r.sessionFilePath))
		|| !(r.modelLabel === null || text(r.modelLabel)) || !(r.roleId === null || text(r.roleId))
		|| !integer(r.createdAt) || !integer(r.updatedAt) || r.updatedAt < r.createdAt
		|| !(r.settledAt === null || (integer(r.settledAt) && r.settledAt >= r.createdAt && r.settledAt <= r.updatedAt))
		|| !(r.completionId === null || text(r.completionId))
		|| !pointer(r.result, "result.json") || !pointer(r.manifest, "manifest.json")
		|| !(r.writerLease === null || (lease(r.writerLease) && r.writerLease.renewedAt <= r.updatedAt && r.writerLease.renewedAt >= r.createdAt))) return false;
	if (r.pane !== null && (!object(r.pane, "agentName", "workspaceId tabId paneId") || !Object.values(r.pane).every(text))) return false;
	if (r.backend === "headless" && r.pane !== null) return false;
	if (r.worktree !== null && (!object(r.worktree, "path branch baseRef repoRoot") || !pathValue(r.worktree.path)
		|| !pathValue(r.worktree.repoRoot) || !text(r.worktree.branch) || !text(r.worktree.baseRef))) return false;
	if (!object(r.delivery, "state claim") || !["none", "pending", "claimed", "delivered", "suppressed"].includes(String(r.delivery.state))) return false;
	if (r.delivery.state === "claimed" ? !lease(r.delivery.claim) : r.delivery.claim !== null) return false;
	if (["running", "settling"].includes(String(r.status)) && (r.child === null || r.supervisor === null || r.writerLease === null)) return false;
	if (r.status === "queued" && (r.child !== null || r.supervisor !== null)) return false;
	if (r.status === "settled") {
		if (r.settledAt === null || r.completionId === null || r.delivery.state === "none") return false;
	} else if (["queued", "starting", "running", "settling"].includes(String(r.status))) {
		if (r.settledAt !== null || r.completionId !== null || r.delivery.state !== "none") return false;
	}
	// Lost/ambiguous describe recovery evidence, not a fabricated successful exit.
	if ((r.completionId === null) !== (r.delivery.state === "none")) return false;
	return true;
}
// oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type

function assertDirectory(path: string): void {
	assertPrivateDir(nodeArtifactFs, path, "subagent registry directory");
	if ((lstatSync(path).mode & 0o777) !== 0o700 || realpathSync(path) !== path) throw new Error("subagent directory must be canonical and 0700");
}

/** Disk authority only. No watchers, backend handles, signalling, or delivery effects. */
export class SubagentRegistry {
	private readonly directoryIdentity: { dev: number; ino: number };

	public constructor(private readonly directory: string, private readonly ownerSessionId: string) {
		if (!pathValue(directory) || !text(ownerSessionId)) throw new Error("invalid registry path or owner");
		if (realpathSync(dirname(directory)) !== dirname(directory)) throw new Error("registry parent must be canonical");
		try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (!isErrnoCode(error, "EEXIST")) throw error; }
		assertDirectory(directory);
		this.directoryIdentity = lstatSync(directory);
	}

	public create(record: SubagentRecord): SubagentRecord {
		this.validate(record);
		if (record.revision !== 1 || record.writerLease !== null || !["starting", "queued"].includes(record.status)) throw new Error("new registry record must be unlaunched at revision 1");
		const path = this.recordPath(record.id);
		return withPrivateFileLock(`${path}.lock`, () => {
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
		if (!validRecord(record) || record.id !== id) throw new Error("corrupt subagent record");
		this.validate(record);
		return record;
	}

	private recordPath(id: string): string {
		if (!/^sa-[A-Za-z0-9_-]{1,128}$/u.test(id)) throw new Error("invalid subagent id");
		assertDirectory(this.directory);
		const current = lstatSync(this.directory);
		if (current.dev !== this.directoryIdentity.dev || current.ino !== this.directoryIdentity.ino) throw new Error("registry directory replaced");
		return join(this.directory, `${id}.json`);
	}

	private validate(record: SubagentRecord): void {
		if (!validRecord(record) || Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) throw new Error("invalid subagent record schema");
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
