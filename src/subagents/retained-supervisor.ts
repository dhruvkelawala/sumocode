import { systemProcessTree, type ProcessTreeOperations } from "../background-tasks/process-tree.js";
import type { HeadlessLaunchGate } from "./backend-pi.js";
import { SubagentRegistry, type RegistryProcess, type SubagentRecord } from "./registry.js";

/**
 * Launch-admission portion of the retained owner, not an adoption/runtime entry.
 * The future process entry must retain the backend handle even when ready rejects.
 * No callback here performs an effect inside a registry transaction.
 */
export function createRetainedHeadlessLaunchGate(
	registry: SubagentRegistry,
	initial: SubagentRecord,
	supervisorEvidence: RegistryProcess,
	operations: ProcessTreeOperations = systemProcessTree,
): HeadlessLaunchGate {
	const supervisor = structuredClone(supervisorEvidence);
	if (initial.backend !== "headless" || initial.status !== "starting" || supervisor.identity.pid !== process.pid
		|| supervisor.identity.processGroupId !== process.pid) {
		throw new Error("retained launch requires a starting headless record and this supervisor");
	}
	const assertLive = (tree: RegistryProcess): void => {
		if (operations.identityMatches(tree.identity) !== "same"
			|| operations.verificationMatches?.(tree.identity, tree.verification) !== "same") {
			throw new Error("retained launch identity is ambiguous");
		}
	};
	assertLive(supervisor);
	let current = registry.create(initial);
	current = registry.acquireWriter(current.id, current.revision, 60_000);
	const lease = current.writerLease!;
	if (lease.owner.pid !== supervisor.identity.pid || !supervisor.verification.members.some((member) =>
		member.pid === lease.owner.pid && member.processStartTime === lease.owner.processStartTime)) {
		throw new Error("retained writer does not identify this supervisor");
	}
	const transition = (update: (record: SubagentRecord) => SubagentRecord): void => {
		current = registry.transition(current.id, current.revision, lease.generation, update);
	};
	transition((record) => ({ ...record, supervisor }));
	let phase: "prepared" | "admitted" | "blocked" | "released" = "prepared";

	const fence = (): void => {
		assertLive(supervisor);
		// A no-op metadata CAS checks revision, generation, token, birth and live
		// lease after potentially slow OS inspection, immediately before return.
		transition((record) => record);
	};

	return {
		beforeSpawn(): void {
			if (phase !== "prepared") throw new Error("retained spawn gate already used");
			phase = "blocked";
			fence();
			phase = "admitted";
		},
		beforePrompt(pid: number): void {
			if (phase !== "admitted") throw new Error("retained prompt gate unavailable");
			phase = "blocked";
			fence();
			if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid retained child pid");
			const processStartTime = operations.captureStartTime(pid);
			if (!processStartTime) throw new Error("retained child birth unavailable");
			const identity = { pid, processGroupId: pid, processStartTime };
			const verification = operations.captureTreeVerification?.(identity);
			if (!verification) throw new Error("retained child anchors unavailable");
			const child = { identity, verification };
			transition((record) => ({ ...record, child }));
			assertLive(child);
			assertLive(supervisor);
			transition((record) => ({ ...record, status: "running" }));
			phase = "released";
		},
	};
}
