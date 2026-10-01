import type { BinaryLike, KeyObject } from "node:crypto";

// Signing serializes this tuple; it does not validate or certify its field values.
interface SpawnRegistrationTuple {
	readonly pid?: unknown;
	readonly pgid?: unknown;
	readonly processStart?: unknown;
	readonly ownerPid?: unknown;
	readonly ownerProcessStart?: unknown;
}

interface AuthenticatedSpawnRegistration extends SpawnRegistrationTuple {
	readonly registrationHmac?: unknown;
}

export function signSpawnRegistration(registration: SpawnRegistrationTuple, runId: string, signingKey: BinaryLike | KeyObject): string;
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This predicate validates untrusted manifest/owner-state inputs; narrowing its parameters would hide that boundary.
export function spawnRegistrationHmacIsValid(registration: AuthenticatedSpawnRegistration | null | undefined, runId: unknown, signingKey: unknown): boolean;
