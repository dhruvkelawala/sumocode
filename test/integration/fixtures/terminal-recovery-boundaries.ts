import { signalVerifiedProcessTree, type ProcessTreeIdentity, type ProcessTreeOperations, type ProcessTreeVerification, type ProcessIdentityStatus, type ProcessTreeSignalResult } from "../../../src/background-tasks/process-tree.js";
export { atomicWritePrivateJson as publishMarker } from "../../../src/activity/persistence.js";

export interface OwnedTree {
	readonly identity: ProcessTreeIdentity;
	readonly verification?: ProcessTreeVerification;
}
interface CleanupObservation {
	identity: ProcessTreeIdentity;
	verification?: ProcessTreeVerification;
	signal?: "SIGTERM" | "SIGKILL";
	empty?: boolean;
	result?: ProcessTreeSignalResult;
	emptyAfterRefusal?: boolean;
	identityStatus?: ProcessIdentityStatus;
	verificationStatus?: ProcessIdentityStatus;
}

// Plan 112's f4623fe8 cleanup proof, retaining the terminal fixture's 100ms TERM
// grace and optional legacy anchors. Never recapture authority after a crash.
export async function cleanupOwnedTree(operations: ProcessTreeOperations, tree: OwnedTree, record: (value: CleanupObservation) => void = () => {}): Promise<boolean> {
	const { identity, verification } = tree;
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		const empty = operations.isTreeEmpty(identity, verification);
		record({ identity, verification, signal, empty, identityStatus: operations.identityMatches(identity), verificationStatus: verification && operations.verificationMatches?.(identity, verification) });
		if (empty) return true;
		const result = await signalVerifiedProcessTree(operations, identity, signal, verification);
		record({ identity, signal, result });
		if (!result.ok && !result.forceRequired) {
			const emptyAfterRefusal = operations.isTreeEmpty(identity, verification);
			record({ identity, emptyAfterRefusal });
			return emptyAfterRefusal;
		}
		if (await operations.waitForTreeEmpty(identity, signal === "SIGTERM" ? 100 : 2000, verification)) return true;
	}
	return false;
}
