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
export function spawnRegistrationHmacIsValid(registration: AuthenticatedSpawnRegistration | null | undefined, runId: unknown, signingKey: unknown): boolean;
