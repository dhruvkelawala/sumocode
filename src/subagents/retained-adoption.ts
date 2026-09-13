import { isDeepStrictEqual } from "node:util";
import type { ProcessTreeOperations } from "../background-tasks/process-tree.js";
import type { PiExecLike, TerminalHost } from "../terminal-host/types.js";
import type { SubagentRecoveryReason, SubagentSnapshot } from "./domain.js";
import { SubagentRevisionConflict, type RegistryControlAuthority, type RegistryControlSuccessor, type RegistryProcess, type RegistryWriter, type SubagentRecord, type SubagentRegistry } from "./registry.js";
import type { RetainedHeadlessSupervisor } from "./retained-supervisor.js";
import { RetainedResults } from "./retained-results.js";
import { censusRetained } from "./retained-census.js";
import { controlAuthority, reserveRemoteControl, retainedControlClient } from "./retained-control.js";
export { controlAuthority } from "./retained-control.js";

/** Controller view over a local supervisor or its private file transport. */
export interface RetainedSubagent {
	readonly registry: SubagentRegistry;
	readonly supervisor?: Pick<RetainedHeadlessSupervisor, "record" | "completion" | "subscribe" | "controllerChild"> & {
		reserveControl(authority: RegistryControlAuthority, successor: RegistryControlSuccessor): SubagentRecord | Promise<SubagentRecord>;
	};
	readonly snapshot: SubagentSnapshot;
	readonly authority: RegistryControlAuthority;
}

function sameAnchor(process: RegistryProcess, operations: ProcessTreeOperations): boolean {
	const root = process.verification.members.find((member) => member.pid === process.identity.pid);
	return root !== undefined && operations.identityMatches(process.identity) === "same"
		&& operations.verificationMatches?.(process.identity, { members: [root] }) === "same";
}

function refused(reason: SubagentRecoveryReason): RetainedVerification {
	return { classification: "ambiguous", reason };
}

function visibleAnchorRefusal(process: RegistryProcess, operations: ProcessTreeOperations): SubagentRecoveryReason | undefined {
	const root = process.verification.members.find((member) => member.pid === process.identity.pid);
	if (!root) return { code: "visible-pane-child-root-recheck", expected: "present", observed: "missing" };
	const identity = operations.identityMatches(process.identity);
	if (identity !== "same") return { code: "visible-pane-child-identity-recheck", expected: "same", observed: identity };
	if (!operations.verificationMatches) return { code: "visible-pane-child-verifier-recheck", expected: "available", observed: "missing" };
	const verification = operations.verificationMatches(process.identity, { members: [root] });
	return verification === "same" ? undefined : { code: "visible-pane-child-verification-recheck", expected: "same", observed: verification };
}

export interface RetainedVerification {
	readonly classification: "verified" | "lost" | "ambiguous";
	readonly reason?: SubagentRecoveryReason;
}

/** No effects or identity recapture: pane numbers alone never establish ownership. */
export async function verifyRetained(record: SubagentRecord, operations: ProcessTreeOperations, host?: TerminalHost, pi?: PiExecLike): Promise<RetainedVerification> {
	if (record.status === "settled") {
		try { return { classification: RetainedResults.read(record.taskDir) ? "verified" : "ambiguous" }; }
		catch { return { classification: "ambiguous" }; }
	}
	if (record.status === "settling") {
		return record.supervisor && sameAnchor(record.supervisor, operations)
			? { classification: "verified" }
			: { classification: "ambiguous" };
	}
	if (!record.child) return { classification: record.launchIntent === null ? "lost" : "ambiguous" };
	const { identity, verification } = record.child;
	if (!sameAnchor(record.child, operations)) return { classification: operations.identityMatches(identity) === "different" && operations.isTreeEmpty(identity, verification) ? "lost" : "ambiguous" };
	if (record.backend === "visible") {
		if (!record.pane?.paneId) return refused({ code: "visible-pane-reference", expected: "pane-id", observed: "missing" });
		if (!host) return refused({ code: "visible-pane-host", expected: "available", observed: "missing" });
		if (host.kind === "none") return refused({ code: "visible-pane-host", expected: "pane-capable", observed: "none" });
		if (!host.inspectPane) return refused({ code: "visible-pane-inspector", expected: "available", observed: "missing" });
		if (!pi) return refused({ code: "visible-pane-executor", expected: "available", observed: "missing" });
		let pane;
		try { pane = await host.inspectPane(pi, { ...record.pane, paneId: record.pane.paneId, host: host.kind }); }
		catch { return refused({ code: "visible-pane-inspection", expected: "verified", observed: "error" }); }
		if (!pane.ok) return refused({ code: "visible-pane-inspection", expected: "verified", observed: "refused" });
		if (pane.foregroundProcessGroupId === null) return refused({ code: "visible-pane-foreground-process-group", expected: "same", observed: "missing" });
		if (pane.foregroundProcessGroupId !== identity.processGroupId) return refused({ code: "visible-pane-foreground-process-group", expected: "same", observed: "different" });
		// Herdr reports the pane shell separately from its foreground children after exec.
		if (pane.shellPid === null) return refused({ code: "visible-pane-shell-process", expected: "same", observed: "missing" });
		if (pane.shellPid !== identity.pid) return refused({ code: "visible-pane-shell-process", expected: "same", observed: "different" });
		if (pane.foregroundPids.length === 0) return refused({ code: "visible-pane-foreground-processes", expected: "present", observed: "missing" });
		const anchorRefusal = visibleAnchorRefusal(record.child, operations);
		if (anchorRefusal) return refused(anchorRefusal);
	}
	return { classification: "verified" };
}

function recoveryEvidence(record: SubagentRecord) {
	// Telemetry is not authority; every other field must survive inspection unchanged.
	return { ...record, revision: 0, updatedAt: 0, telemetry: undefined };
}

/** Heartbeats and progress cannot invalidate an otherwise identical ownership snapshot. */
export function sameRetainedEvidence(first: SubagentRecord, second: SubagentRecord): boolean {
	return isDeepStrictEqual(recoveryEvidence(first), recoveryEvidence(second));
}

/** A new host needs only its private registry namespace, never an old JS handle. */
export async function reconstructRetained(registry: SubagentRegistry, successor: RegistryWriter, sessionId: string,
	operations: ProcessTreeOperations, host?: TerminalHost, pi?: PiExecLike,
): Promise<Array<{ entry: RetainedSubagent; classification: "adopted" | "persist-only" | "lost" | "ambiguous"; reason?: SubagentRecoveryReason }>> {
	const results: Array<{ entry: RetainedSubagent; classification: "adopted" | "persist-only" | "lost" | "ambiguous"; reason?: SubagentRecoveryReason }> = [];
	for (const { registry: discovered, record: initial, launch } of censusRetained(registry, operations)) {
		if (!initial.controlLease) {
			// Pre-control crashes still need durable successor accounting, not adoption.
			const lost = discovered.writerState(initial.id) === "dead" && (launch === "never-launched" || launch === "empty");
			discovered.recordRecovery(initial.id, initial.revision, lost ? "lost" : "ambiguous");
			continue;
		}
		const controller = discovered.forController(successor);
		const snapshot: SubagentSnapshot = { id: initial.id, title: initial.id, prompt: "", cwd: initial.worktree?.path ?? initial.taskDir,
			baseRef: initial.worktree?.baseRef ?? "HEAD", status: "running", createdAt: initial.createdAt, visible: initial.backend === "visible",
			roleId: initial.roleId ?? undefined, modelLabel: initial.modelLabel ?? undefined, sessionFilePath: initial.sessionFilePath ?? undefined,
			pane: initial.pane ?? undefined, worktree: initial.worktree ?? undefined, budget: initial.budget,
			turnState: initial.backend === "visible" ? initial.telemetry?.turnState ?? "working" : undefined,
			turnSequence: initial.backend === "visible" ? initial.telemetry?.turnSequence ?? 0 : undefined,
			usage: { turns: 0 }, transcript: [], liveText: "", liveTools: [], finalText: "" };
		let entry: RetainedSubagent = { registry: controller, authority: controlAuthority(initial), snapshot };
		let classification: "adopted" | "persist-only" | "lost" | "ambiguous" = "ambiguous";
		let reason: SubagentRecoveryReason | undefined;
		try {
			const verification = await verifyRetained(initial, operations, host, pi);
			const verified = verification.classification;
			reason = verification.reason;
			classification = verified === "lost" ? "lost" : "ambiguous";
			if (initial.status !== "settled" && controller.writerState(initial.id) === "dead") {
				results.push(await acquireRetained(entry, successor, sessionId, operations, host, pi));
				continue;
			}
			if (initial.status !== "settled") {
				if (launch !== "verified") throw new Error("retained census unverified");
				if (!initial.supervisor || initial.supervisor.identity.pid === successor.pid
					|| !sameAnchor(initial.supervisor, operations) || controller.writerState(initial.id) !== "alive") throw new Error("retained owner unverified");
			}
			if (verified !== "verified") throw new Error("retained evidence unverified");
			RetainedResults.read(initial.taskDir);
			if (initial.status !== "settled" && (!initial.child || !initial.supervisor
				|| !sameAnchor(initial.child, operations) || !sameAnchor(initial.supervisor, operations))) throw new Error("retained anchor changed during inspection");
			const mirror = controller.controllerState(initial.id) === "alive";
			const handoff = !mirror && initial.status === "settled" && controller.writerState(initial.id) === "dead";
			// Finish OS checks before this read. A live writer heartbeats by design, so a
			// revision conflict is retried a few times; every attempt must still match the
			// originally verified authority, and the registry CAS itself stays exact.
			let record: SubagentRecord | undefined;
			for (let attempt = 1; record === undefined; attempt++) {
				const fresh = controller.get(initial.id);
				if (!fresh || !sameRetainedEvidence(initial, fresh)) throw new Error("retained evidence changed during inspection");
				if (mirror) { record = fresh; break; }
				try {
					record = handoff
						? controller.handoffController(fresh.id, fresh.revision, fresh.controllerGeneration ?? 0, sessionId, 60_000)
						: controller.recoverControl(fresh.id, fresh.revision, fresh.controllerGeneration ?? 0, sessionId);
				} catch (error) {
					if (!(error instanceof SubagentRevisionConflict) || attempt >= 3) throw error;
				}
			}
			const authority = controlAuthority(record);
			const supervisor = observeRemoteRetained(controller, record, operations, mirror);
			entry = { ...entry, supervisor, authority };
			classification = mirror ? "persist-only" : "adopted";
		} catch { /* Refusal preserves the original process evidence and writer. */ }
		results.push({ entry, classification, reason });
	}
	return results;
}

export async function acquireRetained(
	entry: RetainedSubagent, successor: RegistryWriter, sessionId: string,
	operations: ProcessTreeOperations, host?: TerminalHost, pi?: PiExecLike,
): Promise<{ entry: RetainedSubagent; classification: "adopted" | "lost" | "ambiguous"; reason?: SubagentRecoveryReason }> {
	const registry = entry.registry.forController(successor);
	let classification: "adopted" | "lost" | "ambiguous" = "ambiguous";
	let reason: SubagentRecoveryReason | undefined;
	try {
		let record = registry.get(entry.snapshot.id);
		if (!record) throw new Error("owned subagent record missing");
		const verification = await verifyRetained(record, operations, host, pi);
		reason = verification.reason;
		if (verification.classification !== "verified") classification = verification.classification;
		else if (registry.writerState(record.id) === "alive" && entry.supervisor && record.supervisor) {
			if (!sameAnchor(record.supervisor, operations)) throw new Error("retained supervisor identity unverified");
			if (!sameRetainedEvidence(entry.supervisor.record, registry.get(record.id)!)) throw new Error("retained owner record changed");
			const reserved = await entry.supervisor.reserveControl(entry.authority, { owner: successor, sessionId });
			record = registry.acquireControl(record.id, reserved.revision, reserved.writerLease!.generation, reserved.controlHead, successor, 60_000, sessionId);
			const supervisor = record.supervisor?.identity.pid === process.pid ? entry.supervisor : observeRemoteRetained(registry, record, operations);
			return { entry: { ...entry, registry, authority: controlAuthority(record), supervisor }, classification: "adopted" };
		} else if (registry.writerState(record.id) === "dead") {
			// Death + expiry are enforced together by the existing generation CAS.
			// A new writer cannot reconstruct the former parser's pipes.
			record = registry.handoffController(record.id, record.revision, record.controllerGeneration ?? 0, sessionId, 60_000);
			if (record.status === "settled") {
				const supervisor = observeRemoteRetained(registry, record, operations);
				return { entry: { ...entry, registry, authority: controlAuthority(record), supervisor }, classification: "adopted" };
			}
			record = registry.transition(record.id, record.revision, record.writerLease!.generation, (r) => ({ ...r, status: "lost" }));
			classification = "lost";
		}
	} catch {
		// The manager records refusal without editing a live writer's status.
		classification = "ambiguous";
	}
	return { entry: { ...entry, registry }, classification, reason };
}


export function observeRemoteRetained(registry: SubagentRegistry, record: SubagentRecord, operations: ProcessTreeOperations, mirror = false): NonNullable<RetainedSubagent["supervisor"]> {
	const fence = (requireChild = true): SubagentRecord => {
		for (let attempt = 0; attempt < 3; attempt++) {
			const current = registry.get(record.id)!;
			if (current.status === "settled" && current.completionId && current.result && current.manifest
				&& (current.controllerGeneration ?? 0) === (record.controllerGeneration ?? 0)
				&& current.controllerSessionId === record.controllerSessionId
				&& (record.status !== "settled" || current.completionId === record.completionId)) return current;
			// Settlement starts after backend cleanup; its original writer remains the
			// authority while collecting Git evidence, even though the child is gone.
			const ownerVerified = current.supervisor && sameAnchor(current.supervisor, operations)
				&& registry.writerState(record.id) === "alive";
			// Read-only observation follows the live writer through backend cleanup;
			// control requests still require the child anchor until settlement begins.
			const childVerified = !requireChild || current.status === "settling" || current.child && sameAnchor(current.child, operations);
			// OS inspection and disk reads cannot form one transaction. If settlement
			// advanced during inspection, validate the new record before declaring loss.
			const fresh = registry.get(record.id);
			if (!fresh || !sameRetainedEvidence(current, fresh)) continue;
			if (!ownerVerified || !childVerified) throw new Error("retained owner changed");
			return fresh;
		}
		throw new Error("retained observation changed during inspection");
	};

	const supervisor: NonNullable<RetainedSubagent["supervisor"]> = {
		get record() { return fence(false); },
		get completion() { return registry.get(record.id)?.status === "settled" ? RetainedResults.read(record.taskDir) : undefined; },
		reserveControl: (authority, successor) => {
			if (mirror) throw new Error("persist-only controller");
			fence();
			return reserveRemoteControl(registry, authority, successor);
		},
		controllerChild: (grant) => {
			if (mirror) throw new Error("persist-only controller");
			fence();
			return retainedControlClient(registry, grant);
		},
		subscribe: (listener) => {
			let revision = record.revision;
			const timer = setInterval(() => {
				try {
					const current = fence(false);
					if (current.revision !== revision) { revision = current.revision; listener(current); }
					if (current.status === "settled") clearInterval(timer);
				} catch { clearInterval(timer); listener({ ...record, status: "ambiguous" }); }
			}, 250);
			timer.unref();
			return () => { clearInterval(timer); };
		},
	};
	return supervisor;
}
