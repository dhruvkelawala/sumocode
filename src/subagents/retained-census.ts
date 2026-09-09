import { systemProcessTree, type ProcessCensusMember, type ProcessTreeOperations } from "../background-tasks/process-tree.js";
import type { RegistryProcess, SubagentRegistry } from "./registry.js";

/** Census hints never become new cleanup anchors, even if their nonce matches. */
export function censusRetained(registry: SubagentRegistry, operations: ProcessTreeOperations = systemProcessTree) {
	const discovered = registry.discover();
	let live: readonly ProcessCensusMember[] | undefined;
	try { live = operations.census?.(); } catch { /* Unknown blocks an empty verdict. */ }
	return discovered.map(({ registry: owner, record }) => {
		const trees = [record.supervisor, record.child].filter((tree): tree is RegistryProcess => tree !== null);
		const members = live?.filter((member) => trees.some((tree) => tree.identity.processGroupId === member.processGroupId)
			|| record.launchIntent?.nonce === member.anchorNonce && member.anchorNonce !== undefined);
		let launch: "never-launched" | "launched-unknown" | "verified" | "empty" | "ambiguous";
		if (!record.child) launch = record.launchIntent === null ? "never-launched" : "launched-unknown";
		else if (!live) launch = "ambiguous";
		else {
			const { identity, verification } = record.child;
			const root = verification.members.find((member) => member.pid === identity.pid);
			const group = live.filter((member) => member.processGroupId === identity.processGroupId);
			if (group.length === 0 && operations.isTreeEmpty(identity, verification)) launch = "empty";
			else if (root && group.some((member) => member.pid === root.pid && member.processStartTime === root.processStartTime)
				&& operations.identityMatches(identity) === "same"
				&& operations.verificationMatches?.(identity, { members: [root] }) === "same") launch = "verified";
			else launch = "ambiguous";
		}
		return { registry: owner, record, launch, members, censusKnown: live !== undefined };
	});
}
