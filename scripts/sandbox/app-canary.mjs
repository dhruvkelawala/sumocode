import { closeSync, constants, openSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let safe = true;
function status(name, pass) {
	console.log(`${name}: ${pass ? "PASS" : "FAIL"}`);
	safe &&= pass;
}
function deniedOpen(path, flags) {
	try {
		closeSync(openSync(path, flags));
		return false;
	} catch (error) {
		if (error.code === "ENOENT") return null;
		return ["EPERM", "EACCES"].includes(error.code);
	}
}
for (const path of [".pi/agent/settings.json", ".config/sumocode/settings.json", ".sumocode", ".ssh", ".aws", ".npmrc", "Library/Keychains"]) {
	const denied = deniedOpen(join(homedir(), path), constants.O_RDONLY);
	if (denied === null) console.log(`private-read-${path}: ABSENT (not proved)`);
	else status(`private-read-${path}`, denied);
}
const descendant = spawnSync(process.execPath, ["-e", `
try { require('node:fs').closeSync(require('node:fs').openSync(require('node:path').join(require('node:os').homedir(), '.pi/agent/settings.json'), 'r')); process.exit(1); }
catch (error) { process.exit(['EPERM', 'EACCES'].includes(error.code) ? 0 : 2); }
`]);
status("descendant-private-read", descendant.status === 0);
// No create, truncate, or write: a failed fence still cannot mutate this file.
status("outside-write", deniedOpen(join(homedir(), ".config/sumocode/settings.json"), constants.O_WRONLY));
await new Promise((resolve) => {
	const socket = createConnection({ host: "127.0.0.1", port: 7749 });
	socket.setTimeout(1500, () => { status("daemon-7749", false); socket.destroy(); resolve(); });
	socket.once("connect", () => { status("daemon-7749", false); socket.destroy(); resolve(); });
	socket.once("error", (error) => { status("daemon-7749", ["EPERM", "EACCES"].includes(error.code)); resolve(); });
});
const external = spawnSync("curl", ["--max-time", "4", "-sS", "-D", "-", "-o", "/dev/null", "http://example.com"], { encoding: "utf8" });
status("external-http", /X-Proxy-Error: blocked-by-(?:sandbox-runtime|allowlist)/i.test(external.stdout));
try {
	const response = await fetch("http://example.com", { signal: AbortSignal.timeout(4000) });
	status("external-fetch", response.status === 403);
} catch (error) {
	// Node 24 collapses refused CONNECT to cancellation; curl above proves proxy 403.
	status("external-fetch", error.cause?.code === 0 && error.cause?.message === "Request was cancelled.");
}
for (const host of ["127.0.0.1", "localhost"]) {
	try {
		const response = await fetch(`http://${host}:${process.argv[2]}`, { signal: AbortSignal.timeout(4000) });
		status(`fixture-fetch-${host}`, response.status === 200);
	} catch {
		status(`fixture-fetch-${host}`, false);
	}
}
await new Promise((resolve) => {
	const server = createServer();
	server.once("error", (error) => { status("local-bind-denied", ["EPERM", "EACCES"].includes(error.code)); resolve(); });
	server.listen(0, "127.0.0.1", () => { status("local-bind-denied", false); server.close(resolve); });
});
process.exitCode = safe ? 0 : 1;
