import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	executeAccountsCommand,
	isAdapterInstalled,
	loadClaudeSubscriptions,
	registerAccountsCommand,
	resolveAccountsConfigPath,
	saveClaudeSubscriptions,
	type AccountsCommandDeps,
} from "./accounts.js";
import { CLAUDE_ACCOUNTS_MIGRATION_FIELD } from "./accounts-config.js";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

const PINNED_ADAPTER_SOURCE = "git:github.com/dhruvkelawala/pi-claude-oauth-adapter@multi-account";

function tempAgentDir(options: { adapter?: boolean } = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "sumocode-accounts-"));
	tempDirs.push(dir);
	// Default to the adapter being installed: most tests exercise flows past
	// the install gate. Gate tests opt out with { adapter: false }.
	if (options.adapter !== false) {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: [PINNED_ADAPTER_SOURCE] }), "utf8");
	}
	return dir;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- test helper: serializes an arbitrary JSON fixture into the config read boundary.
function writeAccounts(agentDir: string, document: unknown): void {
	writeFileSync(join(agentDir, "claude-accounts.json"), JSON.stringify(document), "utf8");
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- test helper: serializes an arbitrary JSON fixture into the legacy config read boundary.
function writeLegacy(agentDir: string, document: unknown): void {
	writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify(document), "utf8");
}

interface CtxOptions {
	agentDir: string;
	auth?: Record<string, boolean>;
	models?: { provider: string; id: string }[];
	currentModel?: { provider: string; id: string };
	onSelect?: (title: string, options: string[]) => string | undefined;
	onConfirm?: (title: string, message: string) => boolean;
	onInput?: (title: string, placeholder?: string) => string | undefined;
}

function makeCtx(options: CtxOptions) {
	const notify = vi.fn();
	const setStatus = vi.fn();
	const select = vi.fn(options.onSelect ?? (() => undefined));
	const confirm = vi.fn(options.onConfirm ?? (() => false));
	const input = vi.fn(options.onInput ?? (() => undefined));
	const setModel = vi.fn(async () => true);
	const ctx = {
		mode: "rpc",
		hasUI: true,
		ui: { select, confirm, input, notify, setStatus },
		modelRegistry: {
			getProviderAuthStatus: (providerId: string) => ({ configured: options.auth?.[providerId] ?? false }),
			getAll: () => options.models ?? [],
		},
		model: options.currentModel,
	};
	return { ctx, notify, setStatus, select, confirm, input, setModel };
}

function withAgentDir(agentDir: string): AccountsCommandDeps {
	// Keep private-config fallback inside the test sandbox too; otherwise an
	// injected agentDir would still resolve ~/.config/sumocode from the host.
	return {
		agentDir,
		homeDir: agentDir,
		env: { SUMOCODE_CONFIG_DIR: join(agentDir, "private-config") },
		pendingReloadProviders: new Set<string>(),
	};
}

function commandContext(ctx: ReturnType<typeof makeCtx>["ctx"]): ExtensionCommandContext {
	// SAFETY: the double carries every member the accounts command reads (mode, hasUI, ui dialogs, modelRegistry, model); unrelated ExtensionCommandContext members are never touched.
	return ctx as never;
}

function extensionApi(setModel?: ExtensionAPI["setModel"]): ExtensionAPI {
	// SAFETY: the double provides setModel, the only ExtensionAPI member the account flows invoke; switchAccount guards its call sites.
	return { setModel } as never;
}

function selectOptionsAt(select: ReturnType<typeof makeCtx>["select"], callIndex: number): string[] {
	// SAFETY: vitest records each select() invocation as [title, options]; index 1 is always the options string array passed by the command.
	return select.mock.calls[callIndex][1] as string[];
}

const ADD_LABEL = "add Claude account";

function pickOption(expected: string) {
	return (_title: string, options: string[]) => options.find((option) => option.startsWith(expected));
}

describe("resolveAccountsConfigPath", () => {
	it("prefers the injected agent dir", () => {
		expect(resolveAccountsConfigPath({ agentDir: "/agents/a" })).toBe(join("/agents/a", "claude-accounts.json"));
	});

	it("resolves PI_CODING_AGENT_DIR from the injected env", () => {
		expect(resolveAccountsConfigPath({ env: { PI_CODING_AGENT_DIR: "/agents/b" } })).toBe(
			join("/agents/b", "claude-accounts.json"),
		);
	});

	it("falls back to ~/.pi/agent", () => {
		expect(resolveAccountsConfigPath({ homeDir: "/home/u" })).toBe(join("/home/u", ".pi", "agent", "claude-accounts.json"));
	});
});

describe("loadClaudeSubscriptions", () => {
	it("returns nothing when no config file exists", () => {
		expect(loadClaudeSubscriptions(withAgentDir(tempAgentDir()))).toEqual([]);
	});

	it("returns nothing when the config file is malformed", () => {
		const agentDir = tempAgentDir();
		writeFileSync(join(agentDir, "claude-accounts.json"), "{not json", "utf8");
		expect(loadClaudeSubscriptions(withAgentDir(agentDir))).toEqual([]);
	});

	it("returns nothing when subscriptions is not an array", () => {
		const agentDir = tempAgentDir();
		writeAccounts(agentDir, { subscriptions: "nope" });
		expect(loadClaudeSubscriptions(withAgentDir(agentDir))).toEqual([]);
	});

	it("keeps only well-formed anthropic subscriptions, sorted by index", () => {
		const agentDir = tempAgentDir();
		writeAccounts(agentDir, {
			subscriptions: [
				{ provider: "anthropic", index: 3, label: "third" },
				{ provider: "openai", index: 1, label: "not claude" },
				{ provider: "anthropic", index: 2 },
				{ provider: "anthropic", index: 1 },
				{ provider: "anthropic", index: 1.5 },
				"garbage",
			],
		});
		expect(loadClaudeSubscriptions(withAgentDir(agentDir))).toEqual([
			{ provider: "anthropic", index: 2 },
			{ provider: "anthropic", index: 3, label: "third" },
		]);
	});

	it("falls back to the legacy multi-pass.json when no adapter config exists", () => {
		const agentDir = tempAgentDir();
		writeLegacy(agentDir, { subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] });
		expect(loadClaudeSubscriptions(withAgentDir(agentDir))).toEqual([{ provider: "anthropic", index: 2, label: "company" }]);
	});

	it("prefers the adapter config over the legacy file when both exist", () => {
		const agentDir = tempAgentDir();
		writeAccounts(agentDir, { subscriptions: [{ provider: "anthropic", index: 2, label: "primary" }] });
		writeLegacy(agentDir, { subscriptions: [{ provider: "anthropic", index: 3, label: "legacy" }] });
		expect(loadClaudeSubscriptions(withAgentDir(agentDir))).toEqual([{ provider: "anthropic", index: 2, label: "primary" }]);
	});

	it("does not fall back to legacy once the adapter config exists but has no Claude accounts", () => {
		const agentDir = tempAgentDir();
		writeAccounts(agentDir, { subscriptions: [] });
		writeLegacy(agentDir, { subscriptions: [{ provider: "anthropic", index: 2, label: "legacy" }] });
		expect(loadClaudeSubscriptions(withAgentDir(agentDir))).toEqual([]);
	});
});

describe("saveClaudeSubscriptions", () => {
	it("writes claude-accounts.json, preserving unknown keys and non-Claude subscriptions", () => {
		const agentDir = tempAgentDir();
		writeAccounts(agentDir, {
			subscriptions: [
				{ provider: "openai", index: 4, label: "work" },
				{ provider: "anthropic", index: 2, label: "company" },
				{ note: "unparseable entry" },
			],
			unknownKey: { keep: true },
		});

		saveClaudeSubscriptions([{ provider: "anthropic", index: 5, label: "next" }], withAgentDir(agentDir));

		const saved = JSON.parse(readFileSync(join(agentDir, "claude-accounts.json"), "utf8"));
		expect(saved.unknownKey).toEqual({ keep: true });
		expect(saved.subscriptions).toEqual([
			{ provider: "openai", index: 4, label: "work" },
			{ note: "unparseable entry" },
			{ provider: "anthropic", index: 5, label: "next" },
		]);
	});

	it("creates the adapter config from nothing", () => {
		const agentDir = tempAgentDir();
		saveClaudeSubscriptions([{ provider: "anthropic", index: 2, label: "company" }], withAgentDir(agentDir));
		const saved = JSON.parse(readFileSync(join(agentDir, "claude-accounts.json"), "utf8"));
		expect(saved.subscriptions).toEqual([{ provider: "anthropic", index: 2, label: "company" }]);
		expect(existsSync(join(agentDir, "multi-pass.json"))).toBe(false);
	});

	it.each([
		["malformed JSON", "{not json"],
		["non-object JSON", "[]"],
		["non-array subscriptions", JSON.stringify({ subscriptions: "broken" })],
	])("rejects %s instead of overwriting the primary document", (_name, raw) => {
		const agentDir = tempAgentDir();
		const path = join(agentDir, "claude-accounts.json");
		writeFileSync(path, raw);

		expect(() => saveClaudeSubscriptions([{ provider: "anthropic", index: 2 }], withAgentDir(agentDir))).toThrow(/Invalid accounts config/);
		expect(readFileSync(path, "utf8")).toBe(raw);
	});

	it("seeds the complete primary document from legacy without modifying legacy", () => {
		const agentDir = tempAgentDir();
		const legacy = {
			legacyNote: "keep",
			subscriptions: [
				{ provider: "anthropic", index: 2, label: "company" },
				{ provider: "openai", index: 4, label: "work" },
				{ note: "unparseable entry" },
			],
			pools: [{ name: "pool" }],
			presets: [{ name: "preset" }],
		};
		writeLegacy(agentDir, legacy);
		saveClaudeSubscriptions([{ provider: "anthropic", index: 2, label: "renamed" }], withAgentDir(agentDir));

		expect(JSON.parse(readFileSync(join(agentDir, "multi-pass.json"), "utf8"))).toEqual(legacy);
		expect(JSON.parse(readFileSync(join(agentDir, "claude-accounts.json"), "utf8"))).toEqual({
			...legacy,
			[CLAUDE_ACCOUNTS_MIGRATION_FIELD]: true,
			subscriptions: [
				{ provider: "openai", index: 4, label: "work" },
				{ note: "unparseable entry" },
				{ provider: "anthropic", index: 2, label: "renamed" },
			],
		});
	});
});


describe("saveClaudeSubscriptions symlink handling", () => {
	it("preserves the managed private-config symlink and atomically updates its target", () => {
		const agentDir = tempAgentDir();
		const configDir = tempAgentDir();
		const target = join(agentDir, "claude-accounts.json");
		const source = join(configDir, "claude-accounts.json");
		writeFileSync(source, JSON.stringify({ unknownFutureKey: "keep", subscriptions: [] }), { mode: 0o600 });
		symlinkSync(source, target);

		saveClaudeSubscriptions([{ provider: "anthropic", index: 2, label: "company" }], {
			agentDir,
			env: { SUMOCODE_CONFIG_DIR: configDir },
		});

		expect(lstatSync(target).isSymbolicLink()).toBe(true);
		expect(readlinkSync(target)).toBe(source);
		expect(JSON.parse(readFileSync(source, "utf8"))).toEqual({
			unknownFutureKey: "keep",
			[CLAUDE_ACCOUNTS_MIGRATION_FIELD]: true,
			subscriptions: [{ provider: "anthropic", index: 2, label: "company" }],
		});
	});

	it("creates the private source and managed link before /sumo:sync has run", () => {
		const agentDir = tempAgentDir();
		const configDir = tempAgentDir();
		mkdirSync(join(configDir, ".git"));

		saveClaudeSubscriptions([{ provider: "anthropic", index: 2, label: "company" }], {
			agentDir,
			env: { SUMOCODE_CONFIG_DIR: configDir },
		});

		const target = join(agentDir, "claude-accounts.json");
		const source = join(configDir, "claude-accounts.json");
		expect(lstatSync(target).isSymbolicLink()).toBe(true);
		expect(readlinkSync(target)).toBe(source);
		expect(JSON.parse(readFileSync(source, "utf8"))).toEqual({
			[CLAUDE_ACCOUNTS_MIGRATION_FIELD]: true,
			subscriptions: [{ provider: "anthropic", index: 2, label: "company" }],
		});
	});

	it("prefers an existing private source over a divergent regular agent file", () => {
		const agentDir = tempAgentDir();
		const configDir = tempAgentDir();
		mkdirSync(join(configDir, ".git"));
		writeFileSync(join(configDir, "claude-accounts.json"), JSON.stringify({
			unknownFutureKey: "keep",
			subscriptions: [{ provider: "anthropic", index: 2, label: "company" }],
		}));
		writeFileSync(join(agentDir, "claude-accounts.json"), JSON.stringify({
			staleAgentKey: true,
			subscriptions: [{ provider: "anthropic", index: 3, label: "stale" }],
		}));
		const deps = { agentDir, env: { SUMOCODE_CONFIG_DIR: configDir } };

		expect(loadClaudeSubscriptions(deps)).toEqual([{ provider: "anthropic", index: 2, label: "company" }]);
		expect(lstatSync(join(agentDir, "claude-accounts.json")).isSymbolicLink()).toBe(true);
		expect(readlinkSync(join(agentDir, "claude-accounts.json"))).toBe(join(configDir, "claude-accounts.json"));
		saveClaudeSubscriptions([{ provider: "anthropic", index: 2, label: "personal" }], deps);

		expect(lstatSync(join(agentDir, "claude-accounts.json")).isSymbolicLink()).toBe(true);
		expect(JSON.parse(readFileSync(join(configDir, "claude-accounts.json"), "utf8"))).toEqual({
			unknownFutureKey: "keep",
			[CLAUDE_ACCOUNTS_MIGRATION_FIELD]: true,
			subscriptions: [{ provider: "anthropic", index: 2, label: "personal" }],
		});
	});

	it("writes directly when the entire agent directory points at the private config repo", () => {
		const root = tempAgentDir();
		const agentDir = join(root, "linked-agent");
		const configDir = tempAgentDir();
		mkdirSync(join(configDir, ".git"));
		symlinkSync(configDir, agentDir);

		saveClaudeSubscriptions([{ provider: "anthropic", index: 2, label: "company" }], {
			agentDir,
			env: { SUMOCODE_CONFIG_DIR: configDir },
		});

		const source = join(configDir, "claude-accounts.json");
		expect(lstatSync(source).isSymbolicLink()).toBe(false);
		expect(JSON.parse(readFileSync(source, "utf8"))).toEqual({
			[CLAUDE_ACCOUNTS_MIGRATION_FIELD]: true,
			subscriptions: [{ provider: "anthropic", index: 2, label: "company" }],
		});
		expect(JSON.parse(readFileSync(join(agentDir, "claude-accounts.json"), "utf8"))).toEqual({
			[CLAUDE_ACCOUNTS_MIGRATION_FIELD]: true,
			subscriptions: [{ provider: "anthropic", index: 2, label: "company" }],
		});
	});

	it("refuses to write through an unmanaged accounts symlink", () => {
		const agentDir = tempAgentDir();
		const configDir = tempAgentDir();
		const externalDir = tempAgentDir();
		const target = join(agentDir, "claude-accounts.json");
		const external = join(externalDir, "outside.json");
		writeFileSync(external, JSON.stringify({ subscriptions: [] }));
		symlinkSync(external, target);

		expect(() => saveClaudeSubscriptions([{ provider: "anthropic", index: 2 }], {
			agentDir,
			env: { SUMOCODE_CONFIG_DIR: configDir },
		})).toThrow(/unmanaged symlink/);
		expect(readFileSync(external, "utf8")).toBe(JSON.stringify({ subscriptions: [] }));
		expect(lstatSync(target).isSymbolicLink()).toBe(true);
	});
});

describe("isAdapterInstalled", () => {
	it("detects the exact pinned source in string-form packages entries", () => {
		const agentDir = tempAgentDir({ adapter: false });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: ["git:github.com/dhruvkelawala/pi-claude-oauth-adapter@multi-account"] }),
			"utf8",
		);
		expect(isAdapterInstalled(withAgentDir(agentDir))).toBe(true);
	});

	it("detects the exact pinned source in object-form packages entries", () => {
		const agentDir = tempAgentDir({ adapter: false });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: [{ source: "npm:something-else" }, { source: "git:github.com/dhruvkelawala/pi-claude-oauth-adapter@multi-account" }] }),
			"utf8",
		);
		expect(isAdapterInstalled(withAgentDir(agentDir))).toBe(true);
	});

	it("rejects source variants that merely contain the package name or words", () => {
		const agentDir = tempAgentDir({ adapter: false });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: [
					"git:github.com/dhruvkelawala/pi-claude-oauth-adapter@not-multi-account",
					"/Users/x/code/pi-claude-oauth-adapter-multi-account-backup",
					"npm:pi-claude-oauth-adapter",
					{ source: "git:github.com/minzique/pi-claude-oauth-adapter@main" },
				],
			}),
			"utf8",
		);
		expect(isAdapterInstalled(withAgentDir(agentDir))).toBe(false);
	});

	it("returns false when missing, malformed, or unrelated", () => {
		const agentDir = tempAgentDir({ adapter: false });
		expect(isAdapterInstalled(withAgentDir(agentDir))).toBe(false);
		writeFileSync(join(agentDir, "settings.json"), "{bad", "utf8");
		expect(isAdapterInstalled(withAgentDir(agentDir))).toBe(false);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-multi-pass"] }), "utf8");
		expect(isAdapterInstalled(withAgentDir(agentDir))).toBe(false);
	});
});

describe("executeAccountsCommand", () => {
	it("warns outside RPC mode", async () => {
		const { ctx, notify, select } = makeCtx({ agentDir: tempAgentDir() });
		ctx.mode = "print";
		await executeAccountsCommand(extensionApi(), commandContext(ctx), {});
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("/accounts requires"), "warning");
		expect(select).not.toHaveBeenCalled();
	});

	it("reports signed-in accounts as signed in when the session is on a non-Claude model", async () => {
		const agentDir = tempAgentDir();
		writeAccounts(agentDir, { subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] });
		const { ctx, select } = makeCtx({
			agentDir,
			auth: { anthropic: true, "anthropic-2": false },
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), withAgentDir(agentDir));
		const options = selectOptionsAt(select, 0);
		expect(options[0]).toContain("default account · signed in");
		expect(options[0]).not.toContain("inactive");
		expect(options[1]).toContain("company · sign in required");
		expect(options[1]).toContain("anthropic-2");
	});

	it("marks the account backing the current model as in use", async () => {
		const agentDir = tempAgentDir();
		writeAccounts(agentDir, { subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] });
		const { ctx, select } = makeCtx({
			agentDir,
			auth: { anthropic: true, "anthropic-2": true },
			currentModel: { provider: "anthropic-2", id: "claude-opus" },
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), withAgentDir(agentDir));
		const options = selectOptionsAt(select, 0);
		expect(options[0]).toContain("default account · signed in");
		expect(options[1]).toContain("company · in use");
	});

	it("does not offer switching to the account already in use", async () => {
		const agentDir = tempAgentDir();
		writeAccounts(agentDir, { subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] });
		const { ctx, select } = makeCtx({
			agentDir,
			auth: { anthropic: true, "anthropic-2": true },
			models: [{ provider: "anthropic-2", id: "claude-opus" }],
			currentModel: { provider: "anthropic-2", id: "claude-opus" },
			onSelect: pickOption("company"),
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), withAgentDir(agentDir));
		const actionOptions = selectOptionsAt(select, 1);
		expect(actionOptions).not.toContain("use this account");
		expect(actionOptions).toContain("sign in again");
	});

	it("passes the exact provider id to the injected login flow", async () => {
		const agentDir = tempAgentDir();
		writeAccounts(agentDir, { subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] });
		const login = vi.fn(async () => {});
		const { ctx } = makeCtx({
			agentDir,
			auth: { anthropic: true },
			models: [{ provider: "anthropic-2", id: "claude-opus" }],
			onSelect: (title: string, options: string[]) => {
				if (title === "CLAUDE ACCOUNTS") return options[1];
				return options.find((option) => option === "sign in");
			},
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), { ...withAgentDir(agentDir), login });
		expect(login).toHaveBeenCalledWith("anthropic-2", expect.anything());
	});

	it("reloads a provider whose account was added after registry startup", async () => {
		const agentDir = tempAgentDir();
		writeAccounts(agentDir, { subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] });
		const login = vi.fn(async () => {});
		const reload = vi.fn(async () => {});
		const { ctx, select, notify } = makeCtx({
			agentDir,
			auth: { anthropic: true },
			onSelect: pickOption("company"),
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), {
			...withAgentDir(agentDir),
			login,
			reload,
			pendingReloadProviders: new Set(["anthropic-2"]),
		});
		expect(reload).toHaveBeenCalledTimes(1);
		expect(login).not.toHaveBeenCalled();
		expect(select).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith("anthropic-2 is not registered in this session. Reloading SumoCode…", "info");
	});

	it("offers repair instead of reloading when adapter registration failed during startup", async () => {
		const agentDir = tempAgentDir();
		writeAccounts(agentDir, { subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] });
		const installAdapter = vi.fn(async () => {});
		const reload = vi.fn(async () => {});
		const { ctx, confirm, notify } = makeCtx({
			agentDir,
			onSelect: pickOption("company"),
			onConfirm: () => false,
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), { ...withAgentDir(agentDir), installAdapter, reload });
		expect(confirm).toHaveBeenCalledWith(
			"REPAIR MULTI-ACCOUNT CLAUDE",
			"anthropic-2 failed to register during startup. Reinstall the adapter and reload?",
		);
		expect(installAdapter).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("anthropic-2 remains unavailable until the adapter is repaired", "warning");
	});

	it("reinstalls and reloads when adapter repair is accepted", async () => {
		const agentDir = tempAgentDir();
		writeAccounts(agentDir, { subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] });
		const installAdapter = vi.fn(async () => {});
		const reload = vi.fn(async () => {});
		const { ctx } = makeCtx({
			agentDir,
			onSelect: pickOption("company"),
			onConfirm: () => true,
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), { ...withAgentDir(agentDir), installAdapter, reload });
		expect(installAdapter).toHaveBeenCalledTimes(1);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("switching preserves the current model id on the target provider", async () => {
		const agentDir = tempAgentDir();
		writeAccounts(agentDir, { subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] });
		const models = [
			{ provider: "anthropic", id: "claude-opus" },
			{ provider: "anthropic-2", id: "claude-sonnet" },
			{ provider: "anthropic-2", id: "claude-haiku" },
		];
		const { ctx, setModel } = makeCtx({
			agentDir,
			auth: { anthropic: true, "anthropic-2": true },
			models,
			currentModel: { provider: "anthropic", id: "claude-sonnet" },
			onSelect: (title: string, options: string[]) => {
				if (title === "CLAUDE ACCOUNTS") return options[1];
				return options.find((option) => option === "use this account");
			},
		});
		await executeAccountsCommand(extensionApi(setModel), commandContext(ctx), withAgentDir(agentDir));
		expect(setModel).toHaveBeenCalledWith(models[1]);
	});

	it("switching falls back to the first model of the provider", async () => {
		const agentDir = tempAgentDir();
		writeAccounts(agentDir, { subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] });
		const models = [
			{ provider: "anthropic", id: "claude-opus" },
			{ provider: "anthropic-2", id: "claude-sonnet" },
		];
		const { ctx, setModel } = makeCtx({
			agentDir,
			auth: { anthropic: true, "anthropic-2": true },
			models,
			currentModel: { provider: "anthropic", id: "claude-opus" },
			onSelect: (title: string, options: string[]) => {
				if (title === "CLAUDE ACCOUNTS") return options[1];
				return options.find((option) => option === "use this account");
			},
		});
		await executeAccountsCommand(extensionApi(setModel), commandContext(ctx), withAgentDir(agentDir));
		expect(setModel).toHaveBeenCalledWith(models[1]);
	});

	it("does not offer switching for unsigned accounts", async () => {
		const agentDir = tempAgentDir();
		writeAccounts(agentDir, { subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] });
		const { ctx, select } = makeCtx({
			agentDir,
			auth: { anthropic: true, "anthropic-2": false },
			models: [{ provider: "anthropic-2", id: "claude-opus" }],
			onSelect: pickOption("company"),
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), withAgentDir(agentDir));
		const actionOptions = selectOptionsAt(select, 1);
		expect(actionOptions).not.toContain("use this account");
		expect(actionOptions).toContain("sign in");
	});

	it("add flow confirms adapter install, writes config, then requests reload", async () => {
		const agentDir = tempAgentDir({ adapter: false });
		const installAdapter = vi.fn(async () => {});
		const reload = vi.fn(async () => {});
		const pendingReloadProviders = new Set<string>();
		const { ctx, confirm, input } = makeCtx({
			agentDir,
			onSelect: pickOption(ADD_LABEL),
			onConfirm: () => true,
			onInput: () => "company",
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), {
			...withAgentDir(agentDir),
			installAdapter,
			reload,
			pendingReloadProviders,
		});

		expect(installAdapter).toHaveBeenCalledTimes(1);
		expect(confirm).toHaveBeenCalledTimes(2);
		expect(input).toHaveBeenCalledWith("ACCOUNT LABEL", "company");
		expect(loadClaudeSubscriptions(withAgentDir(agentDir))).toEqual([
			{ provider: "anthropic", index: 2, label: "company" },
		]);
		expect(pendingReloadProviders).toContain("anthropic-2");
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("installing with migrated accounts reloads before offering actions", async () => {
		const agentDir = tempAgentDir({ adapter: false });
		writeLegacy(agentDir, { subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] });
		const installAdapter = vi.fn(async () => {});
		const reload = vi.fn(async () => {});
		const { ctx, input } = makeCtx({
			agentDir,
			onSelect: pickOption("company"),
			onConfirm: () => true,
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), { ...withAgentDir(agentDir), installAdapter, reload });
		expect(installAdapter).toHaveBeenCalledTimes(1);
		expect(reload).toHaveBeenCalledTimes(1);
		expect(input).not.toHaveBeenCalled();
	});

	it("add flow picks the next free index and migrates legacy accounts forward", async () => {
		// Adapter already installed (post-reload): the legacy file still feeds
		// the account list until the next save migrates it into the new config.
		const agentDir = tempAgentDir();
		writeLegacy(agentDir, { subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] });
		const reload = vi.fn(async () => {});
		const { ctx, input } = makeCtx({
			agentDir,
			auth: { anthropic: true },
			onSelect: pickOption(ADD_LABEL),
			onConfirm: () => true,
			onInput: () => "second",
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), { ...withAgentDir(agentDir), reload });
		expect(input).toHaveBeenCalledWith("ACCOUNT LABEL", "Claude account 3");
		expect(reload).toHaveBeenCalledTimes(1);
		// Both the migrated legacy account and the new one now live in the adapter config.
		expect(loadClaudeSubscriptions(withAgentDir(agentDir))).toEqual([
			{ provider: "anthropic", index: 2, label: "company" },
			{ provider: "anthropic", index: 3, label: "second" },
		]);
		expect(existsSync(join(agentDir, "claude-accounts.json"))).toBe(true);
	});

	it("add flow skips install when the adapter is already present", async () => {
		const agentDir = tempAgentDir({ adapter: false });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: ["git:github.com/dhruvkelawala/pi-claude-oauth-adapter@multi-account"] }),
			"utf8",
		);
		const installAdapter = vi.fn(async () => {});
		const reload = vi.fn(async () => {});
		const { ctx, confirm, input } = makeCtx({
			agentDir,
			onSelect: pickOption(ADD_LABEL),
			onConfirm: () => true,
			onInput: () => "company",
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), { ...withAgentDir(agentDir), installAdapter, reload });
		expect(installAdapter).not.toHaveBeenCalled();
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(input).toHaveBeenCalledWith("ACCOUNT LABEL", "company");
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("add flow reports installer failure visibly and writes nothing", async () => {
		const agentDir = tempAgentDir({ adapter: false });
		const installAdapter = vi.fn(async () => {
			throw new Error("network down");
		});
		const { ctx, notify, confirm } = makeCtx({
			agentDir,
			onSelect: pickOption(ADD_LABEL),
			onConfirm: () => true,
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), { ...withAgentDir(agentDir), installAdapter });

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Unable to install pi-claude-oauth-adapter: network down"), "error");
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(existsSync(join(agentDir, "claude-accounts.json"))).toBe(false);
	});

	it("add flow still installs when only the upstream adapter is present", async () => {
		const agentDir = tempAgentDir();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-claude-oauth-adapter"] }), "utf8");
		const installAdapter = vi.fn(async () => {});
		const reload = vi.fn(async () => {});
		const { ctx, input } = makeCtx({
			agentDir,
			onSelect: pickOption(ADD_LABEL),
			onConfirm: () => true,
			onInput: () => "company",
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), { ...withAgentDir(agentDir), installAdapter, reload });
		expect(installAdapter).toHaveBeenCalledTimes(1);
		expect(input).toHaveBeenCalledWith("ACCOUNT LABEL", "company");
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("add flow does nothing when install is declined", async () => {
		const agentDir = tempAgentDir({ adapter: false });
		const installAdapter = vi.fn(async () => {});
		const { ctx, input } = makeCtx({
			agentDir,
			onSelect: pickOption(ADD_LABEL),
			onConfirm: () => false,
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), { ...withAgentDir(agentDir), installAdapter });
		expect(installAdapter).not.toHaveBeenCalled();
		expect(input).not.toHaveBeenCalled();
		expect(existsSync(join(agentDir, "claude-accounts.json"))).toBe(false);
	});

	it("add flow does nothing when the label prompt is cancelled", async () => {
		const agentDir = tempAgentDir();
		const reload = vi.fn(async () => {});
		const { ctx } = makeCtx({
			agentDir,
			onSelect: pickOption(ADD_LABEL),
			onConfirm: () => true,
			onInput: () => undefined,
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), { ...withAgentDir(agentDir), reload });
		expect(reload).not.toHaveBeenCalled();
		expect(existsSync(join(agentDir, "claude-accounts.json"))).toBe(false);
	});

	it("rename updates only the target subscription label", async () => {
		const agentDir = tempAgentDir();
		writeAccounts(agentDir, {
			subscriptions: [
				{ provider: "openai", index: 4, label: "work" },
				{ provider: "anthropic", index: 2, label: "company" },
			],
		});
		const { ctx } = makeCtx({
			agentDir,
			auth: { anthropic: true },
			models: [{ provider: "anthropic-2", id: "claude-opus" }],
			onSelect: (title: string, options: string[]) => {
				if (title === "CLAUDE ACCOUNTS") return options[1];
				return options.find((option) => option === "rename account");
			},
			onInput: () => "personal",
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), withAgentDir(agentDir));
		expect(loadClaudeSubscriptions(withAgentDir(agentDir))).toEqual([{ provider: "anthropic", index: 2, label: "personal" }]);
		const saved = JSON.parse(readFileSync(join(agentDir, "claude-accounts.json"), "utf8"));
		expect(saved.subscriptions).toContainEqual({ provider: "openai", index: 4, label: "work" });
	});
});

describe("registerAccountsCommand", () => {
	it("registers the /accounts slash command", () => {
		const registerCommand = vi.fn();
		// SAFETY: the double provides registerCommand, the sole ExtensionAPI member registerAccountsCommand calls.
		registerAccountsCommand({ registerCommand } as never);
		expect(registerCommand).toHaveBeenCalledWith(
			"accounts",
			expect.objectContaining({
				description: expect.any(String),
				handler: expect.any(Function),
			}),
		);
	});

	it("handler delegates to executeAccountsCommand", async () => {
		const registerCommand = vi.fn();
		// SAFETY: the double provides registerCommand, the sole ExtensionAPI member registerAccountsCommand calls.
		registerAccountsCommand({ registerCommand } as never);
		// SAFETY: registerAccountsCommand registers exactly one command whose handler receives the command context double below.
		const handler = registerCommand.mock.calls[0][1].handler as (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		const { ctx, select } = makeCtx({ agentDir: tempAgentDir() });
		await handler("", commandContext(ctx));
		expect(select).toHaveBeenCalled();
	});
});
