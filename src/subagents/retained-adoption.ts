import { isDeepStrictEqual } from "node:util";
import type { ProcessTreeOperations } from "../background-tasks/process-tree.js";
import type { PiExecLike, TerminalHost } from "../terminal-host/types.js";
import type { SubagentSnapshot } from "./domain.js";
import type { RegistryControlAuthority, RegistryProcess, RegistryWriter, SubagentRecord, SubagentRegistry } from "./registry.js";
import type { RetainedHeadlessSupervisor } from "./retained-supervisor.js";

/** The in-process owner boundary also permits retained visible supervisors. */
export interface RetainedSubagent {
	readonly registry: SubagentRegistry;
	readonly supervisor?: Pick<RetainedHeadlessSupervisor, "record" | "completion" | "subscribe" | "reserveControl" | "controllerChild">;
	readonly snapshot: SubagentSnapshot;
	readonly authority: RegistryControlAuthority;
}

export function controlAuthority(record: SubagentRecord): RegistryControlAuthority {
	if (!record.controlLease) throw new Error("subagent has no control owner");
	return { id: record.id, ownerSessionId: record.ownerSessionId,
		controllerSessionId: record.controllerSessionId, controllerGeneration: record.controllerGeneration,
		generation: record.controlLease.generation, owner: record.controlLease.owner, head: record.controlHead };
}

function sameAnchor(process: RegistryProcess, operations: ProcessTreeOperations): boolean {
	const root = process.verification.members.find((member) => member.pid === process.identity.pid);
	return root !== undefined && operations.identityMatches(process.identity) === "same"
		&& operations.verificationMatches?.(process.identity, { members: [root] }) === "same";
}

/** No effects or identity recapture: pane numbers alone never establish ownership. */
export async function verifyRetained(record: SubagentRecord, operations: ProcessTreeOperations, host?: TerminalHost, pi?: PiExecLike): Promise<"verified" | "lost" | "ambiguous"> {
	if (!record.child) return "lost";
	const { identity, verification } = record.child;
	if (!sameAnchor(record.child, operations)) return operations.identityMatches(identity) === "different" && operations.isTreeEmpty(identity, verification) ? "lost" : "ambiguous";
	if (record.backend === "visible") {
		if (!record.pane?.paneId || !host?.inspectPane || host.kind === "none" || !pi) return "ambiguous";
		const pane = await host.inspectPane(pi, { ...record.pane, paneId: record.pane.paneId, host: host.kind });
		if (!pane.ok || pane.foregroundProcessGroupId !== identity.processGroupId
			|| !pane.foregroundPids.includes(identity.pid) || !sameAnchor(record.child, operations)) return "ambiguous";
	}
	return "verified";
}

export async function acquireRetained(
	entry: RetainedSubagent, successor: RegistryWriter, sessionId: string,
	operations: ProcessTreeOperations, host?: TerminalHost, pi?: PiExecLike,
): Promise<{ entry: RetainedSubagent; classification: "adopted" | "lost" | "ambiguous" }> {
	const registry = entry.registry.forController(successor);
	let record = registry.get(entry.snapshot.id);
	if (!record) throw new Error("owned subagent record missing");
	let classification: "adopted" | "lost" | "ambiguous" = "ambiguous";
	try {
		const verified = await verifyRetained(record, operations, host, pi);
		if (verified !== "verified") classification = verified;
		else if (registry.writerState(record.id) === "alive" && entry.supervisor && record.supervisor?.identity.pid === process.pid) {
			if (!sameAnchor(record.supervisor, operations)) throw new Error("retained supervisor identity unverified");
			if (!isDeepStrictEqual(entry.supervisor.record, registry.get(record.id))) throw new Error("retained owner record changed");
			const reserved = entry.supervisor.reserveControl(entry.authority, { owner: successor, sessionId });
			record = registry.acquireControl(record.id, reserved.revision, reserved.writerLease!.generation, reserved.controlHead, successor, 60_000, sessionId);
			return { entry: { ...entry, registry, authority: controlAuthority(record) }, classification: "adopted" };
		} else if (registry.writerState(record.id) === "dead") {
			// Death + expiry are enforced together by the existing generation CAS.
			// A new writer cannot reconstruct the former parser's pipes.
			record = registry.handoffController(record.id, record.revision, record.controllerGeneration ?? 0, sessionId, 60_000);
			record = registry.transition(record.id, record.revision, record.writerLease!.generation, (r) => ({ ...r, status: "lost" }));
			classification = "lost";
		}
	} catch {
		// The manager records refusal without editing a live writer's status.
		classification = "ambiguous";
	}
	return { entry: { ...entry, registry }, classification };
}
