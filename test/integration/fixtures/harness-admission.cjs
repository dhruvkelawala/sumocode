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
	// env performs PATH lookup with exec, preserving the registered PID/group.
	process.execve("/usr/bin/env", ["env", "--", ...process.argv.slice(4)], process.env);
});
