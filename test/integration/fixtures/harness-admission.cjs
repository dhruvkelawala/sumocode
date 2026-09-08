const net = require("node:net");
const { verify } = require("node:crypto");

// Do not execute the workload until its parent has durably registered this PID.
const connection = net.createConnection(process.argv[2]);
let grant = "";
connection.setEncoding("utf8");
connection.on("data", (chunk) => {
	grant += chunk;
	if (grant.length > 88) connection.destroy(new Error("invalid admission"));
});
connection.on("error", () => { process.exitCode = 1; });
connection.on("end", () => {
	const key = { key: Buffer.from(process.argv[3], "base64"), type: "spki", format: "der" };
	if (!verify(null, Buffer.from(String(process.pid)), key, Buffer.from(grant, "base64"))) {
		process.exitCode = 1;
		return;
	}
	if (!process.execve) {
		// Without exec, PID/group identity could not be preserved; refuse loudly
		// instead of silently running the workload in this bootstrap process.
		process.stderr.write("harness admission bootstrap requires process.execve (Node >= 23.11)\n");
		process.exit(125);
	}
	// env performs PATH lookup with exec, preserving the registered PID/group.
	process.execve("/usr/bin/env", ["env", "--", ...process.argv.slice(4)], process.env);
});
