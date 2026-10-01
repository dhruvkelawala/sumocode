#!/usr/bin/env node
import { spawn } from "node:child_process";
import { wrapTestApp } from "./wrap-app.mjs";

if (process.env.SUMOCODE_TEST_SANDBOX !== "srt" || process.argv.length < 3) {
	process.stderr.write("usage: SUMOCODE_TEST_SANDBOX=srt node scripts/sandbox/run-app.mjs <cmd...> (owned TMPDIR required)\n");
	process.exit(2);
}
const app = wrapTestApp(process.argv[2], process.argv.slice(3));
const child = spawn(app.command, app.args, { env: app.env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", () => { process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
