import { createHmac, timingSafeEqual } from "node:crypto";

function spawnRegistrationPayload(registration, runId) {
	return JSON.stringify([
		registration.pid,
		registration.pgid,
		registration.processStart,
		registration.ownerPid,
		registration.ownerProcessStart,
		runId,
	]);
}

export function signSpawnRegistration(registration, runId, signingKey) {
	return createHmac("sha256", signingKey)
		.update(spawnRegistrationPayload(registration, runId))
		.digest("hex");
}

export function spawnRegistrationHmacIsValid(registration, runId, signingKey) {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- HMAC inputs cross the untrusted manifest boundary
	if (typeof runId !== "string" || runId.length === 0
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- HMAC inputs cross the untrusted owner-state boundary
		|| typeof signingKey !== "string" || signingKey.length === 0
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- the manifest registration is untrusted JSON
		|| typeof registration?.registrationHmac !== "string"
		|| !/^[a-f\d]{64}$/.test(registration.registrationHmac)) return false;
	const expected = Buffer.from(signSpawnRegistration(registration, runId, signingKey), "hex");
	const actual = Buffer.from(registration.registrationHmac, "hex");
	return timingSafeEqual(actual, expected);
}
