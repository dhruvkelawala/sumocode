import { spawn } from "node:child_process";
import {
	HARNESS_OWNER_TOKEN_ENV_KEY,
	HARNESS_SIGNATURE,
	HARNESS_SIGNATURE_ENV_KEY,
	HARNESS_SIGNING_KEY_ENV_KEY,
} from "../../../scripts/lib/integration-harness-constants.mjs";

if (process.env[HARNESS_SIGNATURE_ENV_KEY] !== HARNESS_SIGNATURE) throw new Error("missing harness signature");
if (!process.env[HARNESS_OWNER_TOKEN_ENV_KEY]) throw new Error("missing harness owner token");
process.title = "pi";
setTimeout(() => process.exit(0), 60_000);
if (process.argv[2] === "child") {
	process.stdout.write(`${JSON.stringify({
		hasOwnerToken: Boolean(process.env[HARNESS_OWNER_TOKEN_ENV_KEY]),
		hasSignature: process.env[HARNESS_SIGNATURE_ENV_KEY] === HARNESS_SIGNATURE,
		hasSigningKey: Boolean(process.env[HARNESS_SIGNING_KEY_ENV_KEY]),
	})}\n`);
} else {
	const child = spawn(process.execPath, [import.meta.filename, "child"], { stdio: ["ignore", "pipe", "inherit"] });
	child.stdout.once("data", (data) => process.stdout.write(data));
}
setInterval(() => {}, 1_000);
