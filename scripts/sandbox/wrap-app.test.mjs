import { readFileSync } from "node:fs";
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
	expect(app.env.HTTP_PROXY).toBeUndefined();
	expect(app.env.NODE_USE_ENV_PROXY).toBe("1");
	expect(() => wrapTestApp("pi", [], { ports: [7749] })).toThrow("invalid fixture port");
	expect(() => wrapTestApp("pi", [], { cwd: "/" })).toThrow("inside this worktree");
	const argv = ["a b", "$(false)", "ünïcode 'quoted'"];
	const result = spawnTestAppSync(process.execPath, ["-e", "console.log(JSON.stringify(process.argv.slice(1))); process.exit(23)", "--", ...argv], { encoding: "utf8" });
	expect(result.status).toBe(23);
	expect(JSON.parse(result.stdout)).toEqual(argv);
});
