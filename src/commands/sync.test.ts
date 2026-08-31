import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CLAUDE_ACCOUNTS_MIGRATION_FIELD } from "./accounts-config.js";
import { executeSumoBootstrap, executeSumoSync, formatSyncResults, registerSumoSyncCommand } from "./sync.js";

function ctx() {
	return {
		ui: { notify: vi.fn() },
	};
}

function sumocodeRepoExists(path: string): boolean {
	return ["/repo/sumocode/package.json", "/repo/sumocode/src/extension.ts", "/repo/sumocode/.git"].includes(path);
}

describe("/sumo:sync", () => {
	it("registers both slash commands", () => {
		const registerCommand = vi.fn();
		// SAFETY: test double only exercises the members this test asserts on.
		registerSumoSyncCommand({ registerCommand } as never);
		expect(registerCommand).toHaveBeenCalledWith(
			"sumo:sync",
			expect.objectContaining({ description: expect.stringContaining("Pull SumoCode") }),
		);
		expect(registerCommand).toHaveBeenCalledWith(
			"sumo:bootstrap",
			expect.objectContaining({ description: expect.stringContaining("First-time") }),
		);
	});

	it("pulls config repo, refreshes symlinks, and pulls source", async () => {
		const calls: Array<{ file: string; args: readonly string[]; cwd?: string }> = [];
		const linkConfig = vi.fn(() => ({ label: "config symlinks", ok: true, output: "linked" }));
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const context = ctx();
		// SAFETY: ctx double only carries the fields executeSumoSync reads (cwd/ui/env).
		const results = await executeSumoSync(context as never, {
			env: { SUMOCODE_CONFIG_DIR: "/config" },
			homeDir: "/Users/test",
			cwd: "/repo/sumocode/src",
			moduleUrl: "file:///repo/sumocode/src/commands/sync.ts",
			exists: (path) => path === "/config/.git" || sumocodeRepoExists(path),
			readFile: () => JSON.stringify({ name: "@dhruvkelawala/sumocode" }),
			linkConfig,
			exec: async (file, args, options) => {
				calls.push({ file, args, cwd: options.cwd });
				return { stdout: "done", stderr: "" };
			},
		});

		expect(results.map((step) => step.label)).toEqual([
			"config repo git pull",
			"config symlinks",
			"sumocode source git pull",
		]);
		expect(calls).toEqual([
			{ file: "git", args: ["pull", "--ff-only"], cwd: "/config" },
			{ file: "git", args: ["pull", "--ff-only"], cwd: "/repo/sumocode" },
		]);
		expect(linkConfig).toHaveBeenCalledWith("/config", "/Users/test/.pi/agent");
		expect(context.ui.notify).toHaveBeenLastCalledWith(
			"SumoCode sync complete — run /reload if source changed",
			"info",
		);
		expect(stdout).not.toHaveBeenCalled();
		stdout.mockRestore();
	});

	it("resolves the package root from a flattened extension bundle", async () => {
		const calls: Array<{ file: string; cwd?: string }> = [];
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		// SAFETY: ctx double only carries the fields executeSumoSync reads (cwd/ui/env).
		await executeSumoSync(ctx() as never, {
			env: { SUMOCODE_CONFIG_DIR: "/config" },
			homeDir: "/Users/test",
			cwd: "/outside/project",
			moduleUrl: "file:///repo/sumocode/dist/extension/sumocode-extension.bundle.mjs",
			exists: (path) => path === "/config/.git" || sumocodeRepoExists(path),
			readFile: () => JSON.stringify({ name: "@dhruvkelawala/sumocode" }),
			linkConfig: () => ({ label: "config symlinks", ok: true, output: "linked" }),
			exec: async (file, _args, options) => {
				calls.push({ file, cwd: options.cwd });
				return { stdout: "done", stderr: "" };
			},
		});

		expect(calls.at(-1)).toEqual({ file: "git", cwd: "/repo/sumocode" });
		stdout.mockRestore();
	});

	it("defaults config repo to ~/.config/sumocode", async () => {
		const calls: Array<{ file: string; args: readonly string[]; cwd?: string }> = [];
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const context = ctx();
		// SAFETY: ctx double only carries the fields executeSumoSync reads (cwd/ui/env).
		await executeSumoSync(context as never, {
			env: {},
			homeDir: "/Users/test",
			cwd: "/repo/sumocode",
			moduleUrl: "file:///repo/sumocode/src/commands/sync.ts",
			exists: (path) => path === "/Users/test/.config/sumocode/.git" || sumocodeRepoExists(path),
			readFile: () => JSON.stringify({ name: "@dhruvkelawala/sumocode" }),
			linkConfig: () => ({ label: "config symlinks", ok: true, output: "linked" }),
			exec: async (file, args, options) => {
				calls.push({ file, args, cwd: options.cwd });
				return { stdout: "done", stderr: "" };
			},
		});

		expect(calls[0]?.cwd).toBe("/Users/test/.config/sumocode");
		stdout.mockRestore();
	});

	it("reports error when config repo is not present", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const context = ctx();
		// SAFETY: ctx double only carries the fields executeSumoSync reads (cwd/ui/env).
		const results = await executeSumoSync(context as never, {
			env: {},
			homeDir: "/Users/test",
			cwd: "/repo/sumocode",
			moduleUrl: "file:///repo/sumocode/src/commands/sync.ts",
			exists: (path) => !path.includes(".config/sumocode/.git") && sumocodeRepoExists(path),
			readFile: () => JSON.stringify({ name: "@dhruvkelawala/sumocode" }),
			exec: async () => ({ stdout: "", stderr: "" }),
		});

		expect(results[0]?.ok).toBe(false);
		expect(results[0]?.label).toBe("config repo git pull");
		expect(results[0]?.output).toContain("No git repo");
		expect(context.ui.notify).toHaveBeenLastCalledWith("/sumo:sync failed at config repo git pull", "warning");
		expect(stdout).not.toHaveBeenCalled();
		stdout.mockRestore();
	});

	it("reports the first failed git step and stops", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const context = ctx();
		const exec = vi.fn(async (file: string) => {
			if (file === "git") throw Object.assign(new Error("dirty tree"), { stderr: "local changes" });
			return { stdout: "", stderr: "" };
		});
		const linkConfig = vi.fn(() => ({ label: "config symlinks", ok: true, output: "linked" }));
		// SAFETY: ctx double only carries the fields executeSumoSync reads (cwd/ui/env).
		const results = await executeSumoSync(context as never, {
			env: { SUMOCODE_CONFIG_DIR: "/config" },
			cwd: "/tmp",
			moduleUrl: "file:///repo/sumocode/src/commands/sync.ts",
			exists: (path) => path === "/config/.git",
			linkConfig,
			exec,
		});

		expect(results).toHaveLength(1);
		expect(results[0]?.ok).toBe(false);
		expect(results[0]?.label).toBe("config repo git pull");
		expect(exec).toHaveBeenCalledTimes(1);
		expect(linkConfig).not.toHaveBeenCalled();
		expect(context.ui.notify).toHaveBeenLastCalledWith("/sumo:sync failed at config repo git pull", "warning");
		expect(stdout).not.toHaveBeenCalled();
		stdout.mockRestore();
	});

	it("creates and links the private accounts source when the config repo does not have one yet", async () => {
		const home = mkdtempSync(join(tmpdir(), "sumocode-sync-"));
		const configRepo = join(home, ".config", "sumocode");
		const agentDir = join(home, ".pi", "agent");
		mkdirSync(join(configRepo, ".git"), { recursive: true });

		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		// SAFETY: ctx double only carries the fields executeSumoSync reads (cwd/ui/env).
		await executeSumoSync(ctx() as never, {
			env: {},
			homeDir: home,
			cwd: "/repo/sumocode",
			moduleUrl: "file:///repo/sumocode/src/commands/sync.ts",
			exists: (path) => path === join(configRepo, ".git") || sumocodeRepoExists(path),
			readFile: () => JSON.stringify({ name: "@dhruvkelawala/sumocode" }),
			exec: async () => ({ stdout: "", stderr: "" }),
		});

		const source = join(configRepo, "claude-accounts.json");
		const target = join(agentDir, "claude-accounts.json");
		expect(JSON.parse(readFileSync(source, "utf8"))).toEqual({
			[CLAUDE_ACCOUNTS_MIGRATION_FIELD]: true,
			subscriptions: [],
		});
		expect(statSync(source).mode & 0o777).toBe(0o600);
		expect(lstatSync(target).isSymbolicLink()).toBe(true);
		expect(readlinkSync(target)).toBe(source);
		stdout.mockRestore();
	});

	it("refuses to overwrite malformed private account state during migration", async () => {
		const home = mkdtempSync(join(tmpdir(), "sumocode-sync-"));
		const configRepo = join(home, ".config", "sumocode");
		const agentDir = join(home, ".pi", "agent");
		mkdirSync(join(configRepo, ".git"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const source = join(configRepo, "claude-accounts.json");
		writeFileSync(source, "{not json");
		writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify({
			subscriptions: [{ provider: "anthropic", index: 2, label: "company" }],
		}));

		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		// SAFETY: ctx double only carries the fields executeSumoSync reads (cwd/ui/env).
		const results = await executeSumoSync(ctx() as never, {
			env: {},
			homeDir: home,
			cwd: "/repo/sumocode",
			moduleUrl: "file:///repo/sumocode/src/commands/sync.ts",
			exists: (path) => path === join(configRepo, ".git") || sumocodeRepoExists(path),
			readFile: () => JSON.stringify({ name: "@dhruvkelawala/sumocode" }),
			exec: async () => ({ stdout: "", stderr: "" }),
		});

		expect(results.map((step) => [step.label, step.ok])).toEqual([
			["config repo git pull", true],
			["config symlinks", false],
		]);
		expect(results[1]?.output).toContain("Invalid private accounts config");
		expect(readFileSync(source, "utf8")).toBe("{not json");
		expect(existsSync(join(agentDir, "claude-accounts.json"))).toBe(false);
		stdout.mockRestore();
	});

	it("refuses to normalize a non-array private subscriptions field", async () => {
		const home = mkdtempSync(join(tmpdir(), "sumocode-sync-"));
		const configRepo = join(home, ".config", "sumocode");
		const agentDir = join(home, ".pi", "agent");
		mkdirSync(join(configRepo, ".git"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const source = join(configRepo, "claude-accounts.json");
		const invalid = JSON.stringify({ privateNote: "keep", subscriptions: "broken" });
		writeFileSync(source, invalid);

		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		// SAFETY: ctx double only carries the fields executeSumoSync reads (cwd/ui/env).
		const results = await executeSumoSync(ctx() as never, {
			env: {},
			homeDir: home,
			cwd: "/repo/sumocode",
			moduleUrl: "file:///repo/sumocode/src/commands/sync.ts",
			exists: (path) => path === join(configRepo, ".git") || sumocodeRepoExists(path),
			readFile: () => JSON.stringify({ name: "@dhruvkelawala/sumocode" }),
			exec: async () => ({ stdout: "", stderr: "" }),
		});

		expect(results.map((step) => [step.label, step.ok])).toEqual([
			["config repo git pull", true],
			["config symlinks", false],
		]);
		expect(results[1]?.output).toContain("expected an array");
		expect(readFileSync(source, "utf8")).toBe(invalid);
		expect(existsSync(join(agentDir, "claude-accounts.json"))).toBe(false);
		stdout.mockRestore();
	});

	it("seeds the private accounts source from legacy multi-pass subscriptions", async () => {
		const home = mkdtempSync(join(tmpdir(), "sumocode-sync-"));
		const configRepo = join(home, ".config", "sumocode");
		const agentDir = join(home, ".pi", "agent");
		mkdirSync(join(configRepo, ".git"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const legacy = `${JSON.stringify({ subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] }, null, 2)}\n`;
		writeFileSync(join(agentDir, "multi-pass.json"), legacy);

		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		// SAFETY: ctx double only carries the fields executeSumoSync reads (cwd/ui/env).
		await executeSumoSync(ctx() as never, {
			env: {},
			homeDir: home,
			cwd: "/repo/sumocode",
			moduleUrl: "file:///repo/sumocode/src/commands/sync.ts",
			exists: (path) => path === join(configRepo, ".git") || sumocodeRepoExists(path),
			readFile: () => JSON.stringify({ name: "@dhruvkelawala/sumocode" }),
			exec: async () => ({ stdout: "", stderr: "" }),
		});

		const source = join(configRepo, "claude-accounts.json");
		const target = join(agentDir, "claude-accounts.json");
		expect(JSON.parse(readFileSync(source, "utf8"))).toEqual({
			[CLAUDE_ACCOUNTS_MIGRATION_FIELD]: true,
			subscriptions: [{ provider: "anthropic", index: 2, label: "company" }],
		});
		expect(lstatSync(target).isSymbolicLink()).toBe(true);
		expect(readlinkSync(target)).toBe(source);
		stdout.mockRestore();
	});

	it("imports legacy subscriptions into an existing empty private account source", async () => {
		const home = mkdtempSync(join(tmpdir(), "sumocode-sync-"));
		const configRepo = join(home, ".config", "sumocode");
		const agentDir = join(home, ".pi", "agent");
		mkdirSync(join(configRepo, ".git"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(configRepo, "claude-accounts.json"), JSON.stringify({ privateNote: "keep", subscriptions: [] }));
		writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify({
			subscriptions: [{ provider: "anthropic", index: 2, label: "company" }],
		}));

		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		// SAFETY: ctx double only carries the fields executeSumoSync reads (cwd/ui/env).
		await executeSumoSync(ctx() as never, {
			env: {},
			homeDir: home,
			cwd: "/repo/sumocode",
			moduleUrl: "file:///repo/sumocode/src/commands/sync.ts",
			exists: (path) => path === join(configRepo, ".git") || sumocodeRepoExists(path),
			readFile: () => JSON.stringify({ name: "@dhruvkelawala/sumocode" }),
			exec: async () => ({ stdout: "", stderr: "" }),
		});

		const source = join(configRepo, "claude-accounts.json");
		expect(JSON.parse(readFileSync(source, "utf8"))).toEqual({
			privateNote: "keep",
			[CLAUDE_ACCOUNTS_MIGRATION_FIELD]: true,
			subscriptions: [{ provider: "anthropic", index: 2, label: "company" }],
		});
		expect(readlinkSync(join(agentDir, "claude-accounts.json"))).toBe(source);
		stdout.mockRestore();
	});

	it("merges additional agent and legacy accounts before marking a partial private source migrated", async () => {
		const home = mkdtempSync(join(tmpdir(), "sumocode-sync-"));
		const configRepo = join(home, ".config", "sumocode");
		const agentDir = join(home, ".pi", "agent");
		mkdirSync(join(configRepo, ".git"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(configRepo, "claude-accounts.json"), JSON.stringify({
			privateNote: "keep",
			[CLAUDE_ACCOUNTS_MIGRATION_FIELD]: true,
			subscriptions: [{ provider: "anthropic", index: 2, label: "private" }],
		}));
		writeFileSync(join(agentDir, "claude-accounts.json"), JSON.stringify({
			agentNote: "keep",
			subscriptions: [
				{ provider: "anthropic", index: 2, label: "stale-duplicate" },
				{ provider: "anthropic", index: 3, label: "agent" },
			],
		}));
		writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify({
			legacyNote: "keep",
			subscriptions: [{ provider: "anthropic", index: 4, label: "legacy" }],
		}));

		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		// SAFETY: ctx double only carries the fields executeSumoSync reads (cwd/ui/env).
		await executeSumoSync(ctx() as never, {
			env: {},
			homeDir: home,
			cwd: "/repo/sumocode",
			moduleUrl: "file:///repo/sumocode/src/commands/sync.ts",
			exists: (path) => path === join(configRepo, ".git") || sumocodeRepoExists(path),
			readFile: () => JSON.stringify({ name: "@dhruvkelawala/sumocode" }),
			exec: async () => ({ stdout: "", stderr: "" }),
		});

		expect(JSON.parse(readFileSync(join(configRepo, "claude-accounts.json"), "utf8"))).toEqual({
			legacyNote: "keep",
			agentNote: "keep",
			privateNote: "keep",
			[CLAUDE_ACCOUNTS_MIGRATION_FIELD]: true,
			subscriptions: [
				{ provider: "anthropic", index: 2, label: "private" },
				{ provider: "anthropic", index: 3, label: "agent" },
				{ provider: "anthropic", index: 4, label: "legacy" },
			],
		});
		stdout.mockRestore();
	});

	it("does not restore legacy accounts after a completed migration intentionally becomes empty", async () => {
		const home = mkdtempSync(join(tmpdir(), "sumocode-sync-"));
		const configRepo = join(home, ".config", "sumocode");
		const agentDir = join(home, ".pi", "agent");
		mkdirSync(join(configRepo, ".git"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const source = join(configRepo, "claude-accounts.json");
		writeFileSync(source, JSON.stringify({
			[CLAUDE_ACCOUNTS_MIGRATION_FIELD]: true,
			subscriptions: [],
		}));
		symlinkSync(source, join(agentDir, "claude-accounts.json"));
		writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify({
			subscriptions: [{ provider: "anthropic", index: 2, label: "company" }],
		}));

		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		// SAFETY: ctx double only carries the fields executeSumoSync reads (cwd/ui/env).
		await executeSumoSync(ctx() as never, {
			env: {},
			homeDir: home,
			cwd: "/repo/sumocode",
			moduleUrl: "file:///repo/sumocode/src/commands/sync.ts",
			exists: (path) => path === join(configRepo, ".git") || sumocodeRepoExists(path),
			readFile: () => JSON.stringify({ name: "@dhruvkelawala/sumocode" }),
			exec: async () => ({ stdout: "", stderr: "" }),
		});

		expect(JSON.parse(readFileSync(join(configRepo, "claude-accounts.json"), "utf8"))).toEqual({
			[CLAUDE_ACCOUNTS_MIGRATION_FIELD]: true,
			subscriptions: [],
		});
		stdout.mockRestore();
	});

	it("preserves the complete adapter document when seeding an existing empty private source", async () => {
		const home = mkdtempSync(join(tmpdir(), "sumocode-sync-"));
		const configRepo = join(home, ".config", "sumocode");
		const agentDir = join(home, ".pi", "agent");
		mkdirSync(join(configRepo, ".git"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(configRepo, "claude-accounts.json"), JSON.stringify({
			privateNote: "keep",
			subscriptions: [{ provider: "openai", index: 4, label: "private-work" }],
		}));
		writeFileSync(join(agentDir, "claude-accounts.json"), JSON.stringify({
			adapterMetadata: { revision: 3 },
			unknownArray: ["preserve"],
			subscriptions: [
				{ provider: "openai", index: 4, label: "work" },
				{ provider: "anthropic", index: 2, label: "company" },
			],
		}));

		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		// SAFETY: ctx double only carries the fields executeSumoSync reads (cwd/ui/env).
		await executeSumoSync(ctx() as never, {
			env: {},
			homeDir: home,
			cwd: "/repo/sumocode",
			moduleUrl: "file:///repo/sumocode/src/commands/sync.ts",
			exists: (path) => path === join(configRepo, ".git") || sumocodeRepoExists(path),
			readFile: () => JSON.stringify({ name: "@dhruvkelawala/sumocode" }),
			exec: async () => ({ stdout: "", stderr: "" }),
		});

		const source = join(configRepo, "claude-accounts.json");
		expect(JSON.parse(readFileSync(source, "utf8"))).toEqual({
			adapterMetadata: { revision: 3 },
			unknownArray: ["preserve"],
			privateNote: "keep",
			[CLAUDE_ACCOUNTS_MIGRATION_FIELD]: true,
			subscriptions: [
				{ provider: "openai", index: 4, label: "private-work" },
				{ provider: "anthropic", index: 2, label: "company" },
			],
		});
		expect(readlinkSync(join(agentDir, "claude-accounts.json"))).toBe(source);
		stdout.mockRestore();
	});

	it("migrates readable accounts through an existing symlink before relinking", async () => {
		const home = mkdtempSync(join(tmpdir(), "sumocode-sync-"));
		const configRepo = join(home, ".config", "sumocode");
		const agentDir = join(home, ".pi", "agent");
		const externalDir = mkdtempSync(join(tmpdir(), "sumocode-accounts-external-"));
		mkdirSync(join(configRepo, ".git"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const external = join(externalDir, "claude-accounts.json");
		const existing = `${JSON.stringify({ subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] }, null, 2)}\n`;
		writeFileSync(external, existing);
		symlinkSync(external, join(agentDir, "claude-accounts.json"));

		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		// SAFETY: ctx double only carries the fields executeSumoSync reads (cwd/ui/env).
		await executeSumoSync(ctx() as never, {
			env: {},
			homeDir: home,
			cwd: "/repo/sumocode",
			moduleUrl: "file:///repo/sumocode/src/commands/sync.ts",
			exists: (path) => path === join(configRepo, ".git") || sumocodeRepoExists(path),
			readFile: () => JSON.stringify({ name: "@dhruvkelawala/sumocode" }),
			exec: async () => ({ stdout: "", stderr: "" }),
		});

		const source = join(configRepo, "claude-accounts.json");
		const target = join(agentDir, "claude-accounts.json");
		expect(JSON.parse(readFileSync(source, "utf8"))).toEqual({
			[CLAUDE_ACCOUNTS_MIGRATION_FIELD]: true,
			subscriptions: [{ provider: "anthropic", index: 2, label: "company" }],
		});
		expect(readFileSync(external, "utf8")).toBe(existing);
		expect(lstatSync(target).isSymbolicLink()).toBe(true);
		expect(readlinkSync(target)).toBe(source);
		stdout.mockRestore();
	});

	it("migrates an existing regular accounts file into the private source before linking", async () => {
		const home = mkdtempSync(join(tmpdir(), "sumocode-sync-"));
		const configRepo = join(home, ".config", "sumocode");
		const agentDir = join(home, ".pi", "agent");
		mkdirSync(join(configRepo, ".git"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const existing = `${JSON.stringify({ subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] }, null, 2)}\n`;
		writeFileSync(join(agentDir, "claude-accounts.json"), existing);

		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		// SAFETY: ctx double only carries the fields executeSumoSync reads (cwd/ui/env).
		await executeSumoSync(ctx() as never, {
			env: {},
			homeDir: home,
			cwd: "/repo/sumocode",
			moduleUrl: "file:///repo/sumocode/src/commands/sync.ts",
			exists: (path) => path === join(configRepo, ".git") || sumocodeRepoExists(path),
			readFile: () => JSON.stringify({ name: "@dhruvkelawala/sumocode" }),
			exec: async () => ({ stdout: "", stderr: "" }),
		});

		const source = join(configRepo, "claude-accounts.json");
		const target = join(agentDir, "claude-accounts.json");
		expect(JSON.parse(readFileSync(source, "utf8"))).toEqual({
			[CLAUDE_ACCOUNTS_MIGRATION_FIELD]: true,
			subscriptions: [{ provider: "anthropic", index: 2, label: "company" }],
		});
		expect(lstatSync(target).isSymbolicLink()).toBe(true);
		expect(readlinkSync(target)).toBe(source);
		stdout.mockRestore();
	});

	it("does not rewrite config files when ~/.pi/agent itself points at the config repo", async () => {
		const home = mkdtempSync(join(tmpdir(), "sumocode-sync-"));
		const configRepo = join(home, ".config", "sumocode");
		const piDir = join(home, ".pi");
		const agentDir = join(piDir, "agent");
		mkdirSync(join(configRepo, ".git"), { recursive: true });
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(configRepo, "settings.json"), "{}\n");
		symlinkSync(configRepo, agentDir);

		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const context = ctx();
		// SAFETY: ctx double only carries the fields executeSumoSync reads (cwd/ui/env).
		const results = await executeSumoSync(context as never, {
			env: {},
			homeDir: home,
			cwd: "/repo/sumocode",
			moduleUrl: "file:///repo/sumocode/src/commands/sync.ts",
			exists: existsSync,
			readFile: () => JSON.stringify({ name: "@dhruvkelawala/sumocode" }),
			exec: async () => ({ stdout: "", stderr: "" }),
		});

		expect(results.map((step) => step.label)).toEqual([
			"config repo git pull",
			"config symlinks",
			"sumocode source git pull",
		]);
		expect(lstatSync(agentDir).isSymbolicLink()).toBe(true);
		expect(readlinkSync(agentDir)).toBe(configRepo);
		expect(lstatSync(join(configRepo, "settings.json")).isSymbolicLink()).toBe(false);
		expect(stdout).not.toHaveBeenCalled();
		stdout.mockRestore();
	});

	it("reports symlink refresh failure and stops before source pull", async () => {
		const calls: Array<{ file: string; cwd?: string }> = [];
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const context = ctx();
		// SAFETY: ctx double only carries the fields executeSumoSync reads (cwd/ui/env).
		const results = await executeSumoSync(context as never, {
			env: { SUMOCODE_CONFIG_DIR: "/config" },
			cwd: "/repo/sumocode",
			moduleUrl: "file:///repo/sumocode/src/commands/sync.ts",
			exists: (path) => path === "/config/.git" || sumocodeRepoExists(path),
			readFile: () => JSON.stringify({ name: "@dhruvkelawala/sumocode" }),
			linkConfig: () => ({ label: "config symlinks", ok: false, output: "permission denied" }),
			exec: async (file, _args, options) => {
				calls.push({ file, cwd: options.cwd });
				return { stdout: "", stderr: "" };
			},
		});

		expect(results.map((step) => step.label)).toEqual(["config repo git pull", "config symlinks"]);
		expect(calls).toEqual([{ file: "git", cwd: "/config" }]);
		expect(context.ui.notify).toHaveBeenLastCalledWith("/sumo:sync failed at config symlinks", "warning");
		expect(stdout).not.toHaveBeenCalled();
		stdout.mockRestore();
	});
});

describe("/sumo:bootstrap", () => {
	it("clones config repo, pulls, links, then prints next step", async () => {
		const calls: Array<{ file: string; args: readonly string[]; cwd?: string }> = [];
		const linkConfig = vi.fn(() => ({ label: "config symlinks", ok: true, output: "linked" }));
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const context = ctx();
		// SAFETY: ctx double carries cwd/ui, the members executeSumoBootstrap reads.
		const results = await executeSumoBootstrap(context as never, {
			env: {},
			homeDir: "/Users/test",
			cwd: "/repo/sumocode",
			exists: () => false,
			linkConfig,
			exec: async (file, args, options) => {
				calls.push({ file, args, cwd: options.cwd });
				return { stdout: "ok", stderr: "" };
			},
		});

		expect(calls).toEqual([
			{ file: "git", args: ["clone", "git@github.com:dhruvkelawala/sumocode-config.git", "/Users/test/.config/sumocode"], cwd: undefined },
			{ file: "git", args: ["pull", "--ff-only"], cwd: "/Users/test/.config/sumocode" },
		]);
		expect(linkConfig).toHaveBeenCalledWith("/Users/test/.config/sumocode", "/Users/test/.pi/agent");
		expect(results.map((r) => r.label)).toEqual([
			"clone sumocode-config",
			"pull latest config",
			"config symlinks",
			"next step",
		]);
		expect(results[3]?.output).toContain("Keep PI_CODING_AGENT_DIR unset");
		expect(context.ui.notify).toHaveBeenLastCalledWith(
			"SumoCode bootstrap complete — restart; keep PI_CODING_AGENT_DIR unset",
			"info",
		);
		expect(stdout).not.toHaveBeenCalled();
		stdout.mockRestore();
	});

	it("fails clearly when config path exists but is not a git repo", async () => {
		const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const context = ctx();
		// SAFETY: ctx double carries cwd/ui, the members executeSumoBootstrap reads.
		const results = await executeSumoBootstrap(context as never, {
			env: {},
			homeDir: "/Users/test",
			cwd: "/repo/sumocode",
			exists: (path) => path === "/Users/test/.config/sumocode",
			exec,
		});

		expect(results).toHaveLength(1);
		expect(results[0]?.ok).toBe(false);
		expect(results[0]?.label).toBe("clone sumocode-config");
		expect(results[0]?.output).toContain("already exists but is not a git repo");
		expect(exec).not.toHaveBeenCalled();
		expect(context.ui.notify).toHaveBeenLastCalledWith("/sumo:bootstrap failed at clone sumocode-config", "warning");
		expect(stdout).not.toHaveBeenCalled();
		stdout.mockRestore();
	});

	it("skips clone when config repo is already present", async () => {
		const calls: Array<{ file: string }> = [];
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const context = ctx();
		// SAFETY: ctx double carries cwd/ui, the members executeSumoBootstrap reads.
		await executeSumoBootstrap(context as never, {
			env: {},
			homeDir: "/Users/test",
			cwd: "/repo/sumocode",
			exists: (path) => path === "/Users/test/.config/sumocode/.git",
			linkConfig: () => ({ label: "config symlinks", ok: true, output: "linked" }),
			exec: async (file) => {
				calls.push({ file });
				return { stdout: "", stderr: "" };
			},
		});

		expect(calls).toEqual([{ file: "git" }]); // git pull, not clone
		expect(stdout).not.toHaveBeenCalled();
		stdout.mockRestore();
	});
});

describe("formatSyncResults", () => {
	it("formats sync results for terminal output", () => {
		expect(formatSyncResults([{ label: "step", ok: true, output: "Already up to date." }])).toBe(
			"[ok] step\nAlready up to date.\n",
		);
	});

	it("marks failed steps", () => {
		expect(formatSyncResults([{ label: "fail", ok: false, output: "error msg" }])).toBe(
			"[failed] fail\nerror msg\n",
		);
	});
});
