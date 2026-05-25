import { describe, expect, it, vi } from "vitest";
import { executeSumoSync, formatSyncResults, registerSumoSyncCommand } from "./sync.js";

function ctx() {
	return {
		ui: { notify: vi.fn() },
	};
}

describe("/sumo:sync", () => {
	it("registers the slash command", () => {
		const registerCommand = vi.fn();
		registerSumoSyncCommand({ registerCommand } as never);
		expect(registerCommand).toHaveBeenCalledWith(
			"sumo:sync",
			expect.objectContaining({ description: expect.stringContaining("Pull SumoCode") }),
		);
	});

	it("pulls config, pulls source, then runs bootstrap", async () => {
		const calls: Array<{ file: string; args: readonly string[]; cwd?: string }> = [];
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const context = ctx();
		const results = await executeSumoSync(context as never, {
			env: {},
			homeDir: "/Users/test",
			cwd: "/repo/sumocode/src",
			moduleUrl: "file:///repo/sumocode/src/commands/sync.ts",
			exists: (path) =>
				[
					"/Users/test/.pi/agent/settings.json",
					"/repo/sumocode/package.json",
					"/repo/sumocode/src/extension.ts",
					"/repo/sumocode/.git",
				].includes(path),
			readFile: () => JSON.stringify({ name: "@dhruvkelawala/sumocode" }),
			realpath: () => "/Users/test/sumocode-config/pi-agent/settings.json",
			exec: async (file, args, options) => {
				calls.push({ file, args, cwd: options.cwd });
				return { stdout: "done", stderr: "" };
			},
		});

		expect(results.map((step) => step.label)).toEqual([
			"sumocode-config git pull",
			"sumocode source git pull",
			"sumocode-config bootstrap",
		]);
		expect(calls).toEqual([
			{ file: "git", args: ["pull", "--ff-only"], cwd: "/Users/test/sumocode-config" },
			{ file: "git", args: ["pull", "--ff-only"], cwd: "/repo/sumocode" },
			{ file: "/Users/test/sumocode-config/bootstrap.sh", args: [], cwd: "/Users/test/sumocode-config" },
		]);
		expect(context.ui.notify).toHaveBeenLastCalledWith("SumoCode sync complete — run /sumo:reload if source changed", "info");
		stdout.mockRestore();
	});

	it("reports the first failed step", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const context = ctx();
		const exec = vi.fn(async (file: string) => {
			if (file === "git") throw Object.assign(new Error("dirty tree"), { stderr: "local changes" });
			return { stdout: "", stderr: "" };
		});
		const results = await executeSumoSync(context as never, {
			env: { SUMOCODE_CONFIG_DIR: "/config" },
			cwd: "/tmp",
			moduleUrl: "file:///repo/sumocode/src/commands/sync.ts",
			exists: () => false,
			exec,
		});

		expect(results).toHaveLength(1);
		expect(exec).toHaveBeenCalledTimes(1);
		expect(context.ui.notify).toHaveBeenLastCalledWith(
			"/sumo:sync failed at sumocode-config git pull; inspect terminal output",
			"warning",
		);
		stdout.mockRestore();
	});

	it("formats sync results for terminal output", () => {
		expect(formatSyncResults([{ label: "step", ok: true, output: "Already up to date." }])).toBe(
			"[ok] step\nAlready up to date.\n",
		);
	});
});
