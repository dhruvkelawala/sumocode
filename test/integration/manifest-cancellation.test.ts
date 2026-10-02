import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { spawnSupervisedApp } from "./harness-supervisor.js";

it.each(["timeout", "dispose"])("%s terminates every manifest Git process before completion, with no stale publication", async (mode) => {
	const directory = mkdtempSync(join(tmpdir(), "sumocode-manifest-cancel-"));
	const home = join(directory, "home");
	mkdirSync(home);
	const launched = spawnSupervisedApp(process.execPath, [resolve(import.meta.dirname, "fixtures/manifest-cancellation.mjs"), directory, mode], {
		cwd: directory, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: home, XDG_CONFIG_HOME: home },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	launched.child.stdout!.on("data", (chunk) => { stdout += String(chunk); });
	launched.child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
	try {
		const exit = await new Promise<{ code: number | null; signal: string | null }>((resolveExit, rejectExit) => {
			launched.child.once("error", rejectExit);
			launched.child.once("close", (code, signal) => resolveExit({ code, signal }));
		});
		if (exit.code !== 0) await launched.captureFailure(stdout);
		expect(exit, stderr).toEqual({ code: 0, signal: null });
		expect(JSON.parse(stdout.trim())).toEqual({ mode, gitProcesses: 3, survivors: 0, stalePublication: false });
		expect(existsSync(join(directory, "late"))).toBe(false);
		const evidence = JSON.parse(readFileSync(join(directory, "evidence.jsonl"), "utf8"));
		expect(evidence.survivors).toBe(0);
		expect(evidence.children).toHaveLength(3);
	} finally { await launched.terminate(); }
}, 20_000);
