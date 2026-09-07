import { isDeepStrictEqual } from "node:util";
import type { ProcessTreeOperations } from "../background-tasks/process-tree.js";
import type { PiExecLike, TerminalHost } from "../terminal-host/types.js";
import type { SubagentRecoveryReason, SubagentSnapshot } from "./domain.js";
import type { RegistryControlAuthority, RegistryProcess, RegistryWriter, SubagentRecord, SubagentRegistry } from "./registry.js";
import type { RetainedHeadlessSupervisor } from "./retained-supervisor.js";
import { RetainedResults } from "./retained-results.js";
import { censusRetained } from "./retained-census.js";
import { controlAuthority, retainedControlClient } from "./retained-control.js";
export { controlAuthority } from "./retained-control.js";

/** Controller view over a local supervisor or its private file transport. */
export interface RetainedSubagent {
	readonly registry: SubagentRegistry;
	readonly supervisor?: Pick<RetainedHeadlessSupervisor, "record" | "completion" | "subscribe" | "reserveControl" | "controllerChild">;
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
			const mirror = controller.controllerState(initial.id) === "alive";
			const record = mirror ? initial : initial.status === "settled" && controller.writerState(initial.id) === "dead"
				? controller.handoffController(initial.id, initial.revision, initial.controllerGeneration ?? 0, sessionId, 60_000)
				: controller.recoverControl(initial.id, initial.revision, initial.controllerGeneration ?? 0, sessionId);
			const authority = controlAuthority(record);
			const fence = (): SubagentRecord => {
				const current = controller.get(record.id)!;
				if (record.status === "settled" && current.status === "settled" && current.completionId === record.completionId) return current;
				if (!current.supervisor || !current.child || !sameAnchor(current.supervisor, operations)
					|| !sameAnchor(current.child, operations) || controller.writerState(record.id) !== "alive") throw new Error("retained owner changed");
				return current;
			};
			const supervisor: NonNullable<RetainedSubagent["supervisor"]> = {
				get record() { return fence(); },
				get completion() { return controller.get(record.id)?.status === "settled" ? RetainedResults.read(record.taskDir) : undefined; },
				reserveControl: () => { throw new Error("remote transfer requires dead-controller recovery"); },
				controllerChild: (grant) => {
					if (mirror) throw new Error("persist-only controller");
					fence();
					return retainedControlClient(controller, grant);
				},
				subscribe: (listener) => {
					let revision = record.revision;
					const timer = setInterval(() => {
						try {
							const current = fence();
							if (current.revision !== revision) { revision = current.revision; listener(current); }
							if (current.status === "settled") clearInterval(timer);
						} catch { clearInterval(timer); listener({ ...record, status: "ambiguous" }); }
					}, 250);
					timer.unref();
					return () => { clearInterval(timer); };
				},
			};
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
	return { entry: { ...entry, registry }, classification, reason };
}
