import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { spawnTestAppSync, wrapTestApp } from "./wrap-app.mjs";

afterEach(() => vi.unstubAllEnvs());

it("leaves argv and environment unchanged when disabled, and refuses unknown modes", () => {
	vi.stubEnv("SUMOCODE_TEST_SANDBOX", "");
	const env = { SYNTHETIC: "kept" };
	expect(wrapTestApp("pi", ["a b", "$(false)"], { env })).toEqual({ command: "pi", args: ["a b", "$(false)"], env });
	vi.stubEnv("SUMOCODE_TEST_SANDBOX", "typo");
	expect(() => wrapTestApp("pi", [])).toThrow("unsupported test sandbox");
});

it.runIf(process.env.SUMOCODE_TEST_SANDBOX === "srt")("pins ports and owned paths without opening local binding or private reads", () => {
	const env = { ...process.env, HTTP_PROXY: "http://untrusted:1234", NO_PROXY: "*" };
	const app = wrapTestApp("pi", ["a b", "$(false)"], { env, ports: [43210] });
	const settings = JSON.parse(readFileSync(app.args[app.args.indexOf("--settings") + 1], "utf8"));
	expect(settings.network).toMatchObject({ allowedDomains: ["127.0.0.1:43210", "localhost:43210"], allowLocalBinding: false, allowUnixSockets: [] });
	expect(settings.network.deniedDomains).toContain("127.0.0.1:7749");
	expect(settings.filesystem.denyRead).toEqual(expect.arrayContaining(["~/.pi", "~/.config", "~/Library/Keychains"]));
	expect(app.args.slice(-3)).toEqual(["pi", "a b", "$(false)"]);
	expect(app.env.PATH).toBe(env.PATH);
	expect(app.env.SUMOCODE_TEST_PS_BIN).toBeUndefined();
	expect(app.args).toContain(`PATH=${join(process.cwd(), ".srt-spike/bin")}:${env.PATH}`);
	expect(app.args).toContain(`SUMOCODE_TEST_PS_BIN=${join(process.cwd(), ".srt-spike/bin/ps")}`);
	expect(app.env.HTTP_PROXY).toBeUndefined();
	expect(app.env.NODE_USE_ENV_PROXY).toBe("1");
	expect(() => wrapTestApp("pi", [], { ports: [7749] })).toThrow("invalid fixture port");
	expect(() => wrapTestApp("pi", [], { cwd: "/" })).toThrow("inside this worktree");
	expect(() => wrapTestApp("pi", [], { env: { ...env, PI_CODING_AGENT_DIR: "/" } })).toThrow("inside this worktree");
	const futureAgent = join(env.TMPDIR, "not-created-agent", "nested");
	expect(wrapTestApp("pi", [], { env: { ...env, PI_CODING_AGENT_DIR: futureAgent } }).env.PI_CODING_AGENT_DIR).toBe(futureAgent);
	const argv = ["a b", "$(false)", "ünïcode 'quoted'"];
	const result = spawnTestAppSync(process.execPath, ["-e", "console.log(JSON.stringify(process.argv.slice(1))); process.exit(23)", "--", ...argv], { encoding: "utf8" });
	expect(result.status).toBe(23);
	expect(JSON.parse(result.stdout)).toEqual(argv);
});

it.runIf(process.env.SUMOCODE_TEST_SANDBOX === "srt")("runs real ps probes and resolves Pi trust from a unique owned fixture inside srt", () => {
	const env = { ...process.env };
	delete env.PI_CODING_AGENT_DIR;
	const first = wrapTestApp("pi", [], { env });
	const second = wrapTestApp("pi", [], { env });
	expect(first.env.PI_CODING_AGENT_DIR).not.toBe(second.env.PI_CODING_AGENT_DIR);
	expect(JSON.parse(readFileSync(join(first.env.PI_CODING_AGENT_DIR, "trust.json"), "utf8"))).toEqual({ [process.cwd()]: true });
	const result = spawnTestAppSync(process.execPath, ["--input-type=module", "-e", `
		import assert from "node:assert/strict";
		import { execFileSync } from "node:child_process";
		import { getAgentDir } from "./node_modules/@earendil-works/pi-coding-agent/dist/config.js";
		import { ProjectTrustStore } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/trust-manager.js";
		assert.equal(getAgentDir(), process.env.PI_CODING_AGENT_DIR);
		assert.equal(new ProjectTrustStore(getAgentDir()).get(process.cwd()), true);
		for (const binary of ["ps", process.env.SUMOCODE_TEST_PS_BIN]) {
			assert.ok(execFileSync(binary, ["-o", "pid=,pgid=,lstart=", "-p", "1"], { encoding: "utf8" }).trim());
			assert.ok(execFileSync(binary, ["-axo", "pid=,pgid=,lstart="], { encoding: "utf8" }).trim().split("\\n").length > 1);
			assert.ok(execFileSync(binary, ["-o", "lstart=,command=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
		}
		console.log("owned trust and process probes passed");
	`], { env, encoding: "utf8" });
	expect(result.stderr).not.toContain("Operation not permitted");
	expect(result.status).toBe(0);
	expect(result.stdout.trim()).toBe("owned trust and process probes passed");
});
