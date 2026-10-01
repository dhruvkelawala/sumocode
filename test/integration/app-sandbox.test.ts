import { once } from "node:events";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, it } from "vitest";
import { processRows } from "../../scripts/preflight-integration.mjs";
import { spawnSupervisedApp, type SupervisedProcess } from "./harness-supervisor.js";
import { buildSpawnEnv } from "./spawn-pi-pty.js";

it.runIf(process.env.SUMOCODE_TEST_SANDBOX === "srt")("runs app canaries through admission and reaps the wrapper, app and descendant group", async () => {
	const server = createServer((_request, response) => { response.writeHead(200); response.end(); });
	let active: SupervisedProcess | undefined;
	try {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's TCP/Unix address union is checked at the fixture boundary.
		if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
		const env = buildSpawnEnv(process.env, undefined);
		const canary = spawnSupervisedApp(process.execPath, [join(process.cwd(), "scripts/sandbox/app-canary.mjs"), String(address.port)],
			{ cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] }, [address.port]);
		active = canary;
		let output = "";
		let stderr = "";
		canary.child.stdout!.on("data", (chunk) => { output += String(chunk); });
		canary.child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
		const [code] = await once(canary.child, "exit");
		process.stdout.write(output);
		if (code !== 0) await canary.captureFailure(output, stderr);
		expect(code, stderr).toBe(0);
		expect(output).not.toContain("FAIL");
		await canary.terminate();
		const app = spawnSupervisedApp(process.execPath, ["-e", `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log(JSON.stringify({ app: process.pid, child: child.pid }));
setInterval(() => {}, 1000);
`], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
		active = app;
		const [data] = await once(app.child.stdout!, "data");
		// SAFETY: the synthetic workload above emits exactly these two numeric PID fields.
		const ids = JSON.parse(String(data)) as { app: number; child: number };
		const rows = processRows().rows;
		expect(ids.app).not.toBe(app.pid);
		expect(rows.find((row) => row.pid === ids.app)?.pgid).toBe(app.pgid);
		expect(rows.find((row) => row.pid === ids.child)?.pgid).toBe(app.pgid);
		expect(rows.find((row) => row.pid === app.pid)?.pgid).toBe(app.pgid);
		await app.terminate();
		expect(() => process.kill(-app.pgid, 0)).toThrow();
		process.stdout.write("wrapper-app-descendant-group: PASS\n");
	} finally {
		await active?.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}, 30_000);
