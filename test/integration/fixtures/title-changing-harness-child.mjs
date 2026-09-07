import { spawn } from "node:child_process";
import {
	HARNESS_OWNER_TOKEN_ENV_KEY,
	HARNESS_SIGNATURE,
	HARNESS_SIGNATURE_ENV_KEY,
} from "../../../scripts/lib/integration-harness-constants.mjs";

if (process.env[HARNESS_SIGNATURE_ENV_KEY] !== HARNESS_SIGNATURE) throw new Error("missing harness signature");
if (!process.env[HARNESS_OWNER_TOKEN_ENV_KEY]) throw new Error("missing harness owner token");
process.title = "pi";
if (process.argv[2] === "child") {
	process.stdout.write("ready\n");
} else {
	const child = spawn(process.execPath, [import.meta.filename, "child"], { stdio: ["ignore", "pipe", "inherit"] });
	child.stdout.once("data", () => process.stdout.write("ready\n"));
}
setInterval(() => {}, 1_000);
