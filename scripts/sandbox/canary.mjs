import { closeSync, constants, openSync, readFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Never print contents or send application data to the owner's daemon.
async function connect(host, port) {
	return new Promise((resolve) => {
		const socket = createConnection({ host, port });
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(result);
		};
		socket.setTimeout(1500, () => finish("TIMEOUT"));
		socket.once("connect", () => finish("CONNECTED"));
		socket.once("error", (error) => finish(
			error.code === "ECONNREFUSED" ? "REFUSED" :
			["EPERM", "EACCES"].includes(error.code) ? "BLOCKED" : "UNKNOWN",
		));
	});
}

const daemon = await connect("127.0.0.1", 7749);
console.log(daemon);
if (process.argv.includes("--baseline")) process.exit(0);
let safe = daemon === "BLOCKED";

for (const relative of [".pi/agent/settings.json", ".config/sumocode/settings.json"]) {
	try {
		readFileSync(join(homedir(), relative));
		console.log("READ_OK");
		safe = false;
	} catch (error) {
		const denied = ["EPERM", "EACCES"].includes(error.code);
		console.log(denied ? "READ_DENIED" : "READ_UNKNOWN");
		safe &&= denied;
	}
}

// Open for writing without truncate/create or writing bytes: even a failed
// isolation boundary cannot modify private state during this canary.
try {
	const fd = openSync(join(homedir(), ".config/sumocode/settings.json"), constants.O_WRONLY);
	closeSync(fd);
	console.log("WRITE_OK");
	safe = false;
} catch (error) {
	const denied = ["EPERM", "EACCES"].includes(error.code);
	console.log(denied ? "WRITE_DENIED" : "WRITE_UNKNOWN");
	safe &&= denied;
}

const external = spawnSync("curl", ["--max-time", "4", "-sS", "-D", "-", "-o", "/dev/null", "http://example.com"], { encoding: "utf8" });
const externalDenied = /X-Proxy-Error: blocked-by-(?:sandbox-runtime|allowlist)/i.test(external.stdout);
console.log(externalDenied);
safe &&= externalDenied;

if (process.argv.includes("--fixture")) {
	const fixture = spawnSync("curl", ["--noproxy", "", "--max-time", "4", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:38471"], { encoding: "utf8" });
	console.log(fixture.status === 0 && fixture.stdout === "200");
	console.log(await connect("127.0.0.1", 38471));
}

const server = createServer((socket) => socket.destroy());
await new Promise((resolve) => {
	server.once("error", () => { console.log(false); resolve(); });
	server.listen(0, "127.0.0.1", async () => {
		console.log(true);
		console.log(await connect("127.0.0.1", server.address().port));
		server.close(resolve);
	});
});
process.exitCode = safe ? 0 : 1;
