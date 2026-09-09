import { signalVerifiedProcessTree, type ProcessTreeIdentity, type ProcessTreeOperations, type ProcessTreeVerification, type ProcessIdentityStatus, type ProcessTreeSignalResult } from "../../../src/background-tasks/process-tree.js";

export interface OwnedTree { identity: ProcessTreeIdentity; verification: ProcessTreeVerification }
interface CleanupObservation {
	identity: ProcessTreeIdentity;
	verification?: ProcessTreeVerification;
	signal?: "SIGTERM" | "SIGKILL";
	empty?: boolean;
	identityStatus?: ProcessIdentityStatus;
	verificationStatus?: ProcessIdentityStatus;
	result?: ProcessTreeSignalResult;
	emptyAfterRefusal?: boolean;
}

// Keep the launch-time anchors: recapturing after the leader exits loses the
// authority to stop surviving descendants. A refused signal is never retried
// without verification; only independently proven group emptiness is success.
export async function cleanupOwnedTree(operations: ProcessTreeOperations, tree: OwnedTree, record: (value: CleanupObservation) => void): Promise<boolean> {
	const { identity, verification } = tree;
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		const empty = operations.isTreeEmpty(identity, verification);
		record({ identity, verification, signal, empty, identityStatus: operations.identityMatches(identity), verificationStatus: operations.verificationMatches?.(identity, verification) });
		if (empty) return true;
		const result = await signalVerifiedProcessTree(operations, identity, signal, verification);
		record({ identity, signal, result });
		if (!result.ok && !result.forceRequired) {
			const emptyAfterRefusal = await operations.waitForTreeEmpty(identity, 2000, verification);
			record({ identity, emptyAfterRefusal });
			return emptyAfterRefusal;
		}
		if (await operations.waitForTreeEmpty(identity, signal === "SIGTERM" ? 500 : 2000, verification)) return true;
	}
	return false;
}
