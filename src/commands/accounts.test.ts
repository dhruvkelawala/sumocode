import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	RENEW_LONG_LIVED,
	SIGN_IN_BROWSER,
	SIGN_IN_LONG_LIVED,
	executeAccountsCommand,
	isAdapterInstalled,
	loadClaudeSubscriptions,
	registerAccountsCommand,
	resolveAccountsConfigPath,
	saveClaudeSubscriptions,
	type AccountsCommandDeps,
	type StoredClaudeCredential,
} from "./accounts.js";
import {
	CLAUDE_SETUP_TOKEN_COMMAND,
	STATIC_CREDENTIAL_EXPIRES,
	staticClaudeCredential,
	type StaticClaudeCredential,
} from "./claude-token.js";
import { isSecretInputTitle } from "../sumo-tui/pi-compat/secret-input.js";
import { CLAUDE_ACCOUNTS_MIGRATION_FIELD } from "./accounts-config.js";

const tempDirs: string[] = [];

afterEach(() => {
	// Restore stubbed env vars even when an assertion fails mid-test.
	vi.unstubAllEnvs();
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
	/** Models Pi reports as selectable; defaults to every registered model. */
	availableModels?: { provider: string; id: string }[];
	currentModel?: { provider: string; id: string };
	onSelect?: (title: string, options: string[]) => string | undefined;
	onConfirm?: (title: string, message: string) => boolean;
	onInput?: (title: string, placeholder?: string) => string | undefined;
	/** Pi's auth runtime double, for flows that reach the credential store. */
	runtime?: AuthRuntimeStub;
	onRefresh?: (options?: { providers?: readonly string[] }) => Promise<void>;
}

interface ModelStub {
	readonly provider: string;
	readonly id: string;
}

interface CredentialStoreStub {
	readonly read: (providerId: string) => Promise<StaticClaudeCredential | undefined>;
	readonly modify: (
		providerId: string,
		fn: (current: StaticClaudeCredential | undefined) => StaticClaudeCredential | undefined,
	) => Promise<StaticClaudeCredential | undefined>;
}

/** The slice of Pi's auth runtime the accounts flow reaches through the compat seam. */
interface AuthRuntimeStub {
	readonly getAvailable: () => Promise<readonly never[]>;
	readonly getProviders: () => readonly never[];
	readonly login: () => Promise<void>;
	readonly credentials: CredentialStoreStub;
}

interface RegistryDouble {
	getProviderAuthStatus(providerId: string): { configured: boolean };
	getAll(): readonly ModelStub[];
	getAvailable(): readonly ModelStub[];
	refresh(options?: { providers?: readonly string[] }): Promise<void>;
	runtime?: AuthRuntimeStub;
}

function makeCtx(options: CtxOptions) {
	const notify = vi.fn();
	const setStatus = vi.fn();
	const setWidget = vi.fn();
	const select = vi.fn(options.onSelect ?? (() => undefined));
	const confirm = vi.fn(options.onConfirm ?? (() => false));
	const input = vi.fn(options.onInput ?? (() => undefined));
	const setModel = vi.fn(async () => true);
	const refresh = vi.fn(options.onRefresh ?? (async () => {}));
	const modelRegistry: RegistryDouble = {
		getProviderAuthStatus: (providerId: string) => ({ configured: options.auth?.[providerId] ?? false }),
		getAll: () => options.models ?? [],
		getAvailable: () => options.availableModels ?? options.models ?? [],
		refresh,
	};
	if (options.runtime) modelRegistry.runtime = options.runtime;
	const ctx = {
		mode: "rpc",
		hasUI: true,
		ui: { select, confirm, input, notify, setStatus, setWidget },
		modelRegistry,
		model: options.currentModel,
	};
	return { ctx, notify, setStatus, setWidget, select, confirm, input, setModel, refresh };
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
		// resolveAgentDir reads process.env.PI_CODING_AGENT_DIR before the homeDir
		// fallback, so clear any inherited value to keep this test sandbox closed.
		vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
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
			currentModel: { provider: "cursor", id: "grok" },
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
		expect(actionOptions).toContain(SIGN_IN_BROWSER);
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
				return options.find((option) => option === SIGN_IN_BROWSER);
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

	it("switching from a non-Claude model prefers a model enabled for the base anthropic provider", async () => {
		const agentDir = tempAgentDir();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: [PINNED_ADAPTER_SOURCE], enabledModels: ["cursor/grok", "anthropic/claude-opus"] }),
			"utf8",
		);
		writeAccounts(agentDir, { subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] });
		const models = [
			{ provider: "cursor", id: "grok" },
			{ provider: "anthropic-2", id: "claude-sonnet" },
			{ provider: "anthropic-2", id: "claude-opus" },
		];
		const { ctx, setModel } = makeCtx({
			agentDir,
			auth: { anthropic: true, "anthropic-2": true },
			models,
			currentModel: { provider: "cursor", id: "grok" },
			onSelect: (title: string, options: string[]) => {
				if (title === "CLAUDE ACCOUNTS") return options[1];
				return options.find((option) => option === "use this account");
			},
		});
		await executeAccountsCommand(extensionApi(setModel), commandContext(ctx), withAgentDir(agentDir));
		expect(setModel).toHaveBeenCalledWith(models[2]);
	});

	it("switching does not resolve a bare model id the model picker treats as ambiguous", async () => {
		const agentDir = tempAgentDir();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: [PINNED_ADAPTER_SOURCE], enabledModels: ["claude-opus"] }),
			"utf8",
		);
		writeAccounts(agentDir, { subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] });
		const models = [
			{ provider: "cursor", id: "grok" },
			{ provider: "openrouter", id: "claude-opus" },
			{ provider: "anthropic-2", id: "claude-sonnet" },
			{ provider: "anthropic-2", id: "claude-opus" },
		];
		const { ctx, setModel } = makeCtx({
			agentDir,
			auth: { anthropic: true, "anthropic-2": true },
			models,
			currentModel: { provider: "cursor", id: "grok" },
			onSelect: (title: string, options: string[]) => {
				if (title === "CLAUDE ACCOUNTS") return options[1];
				return options.find((option) => option === "use this account");
			},
		});
		await executeAccountsCommand(extensionApi(setModel), commandContext(ctx), withAgentDir(agentDir));
		expect(setModel).toHaveBeenCalledWith(models[2]);
	});

	it("ignores an unavailable provider's model id when resolving enabled patterns", async () => {
		const agentDir = tempAgentDir();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: [PINNED_ADAPTER_SOURCE], enabledModels: ["claude-opus"] }),
			"utf8",
		);
		writeAccounts(agentDir, { subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] });
		const models = [
			{ provider: "cursor", id: "grok" },
			{ provider: "openrouter", id: "claude-opus" },
			{ provider: "anthropic-2", id: "claude-sonnet" },
			{ provider: "anthropic-2", id: "claude-opus" },
		];
		const { ctx, setModel } = makeCtx({
			agentDir,
			auth: { anthropic: true, "anthropic-2": true },
			models,
			// openrouter has no credentials, so Pi never offers its model.
			availableModels: [models[0], models[2], models[3]],
			currentModel: { provider: "cursor", id: "grok" },
			onSelect: (title: string, options: string[]) => {
				if (title === "CLAUDE ACCOUNTS") return options[1];
				return options.find((option) => option === "use this account");
			},
		});
		await executeAccountsCommand(extensionApi(setModel), commandContext(ctx), withAgentDir(agentDir));
		expect(setModel).toHaveBeenCalledWith(models[3]);
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

	it("switching picks an available account model when the first registered model is unavailable", async () => {
		const agentDir = tempAgentDir();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: [PINNED_ADAPTER_SOURCE], enabledModels: ["cursor/grok"] }),
			"utf8",
		);
		writeAccounts(agentDir, { subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] });
		const models = [
			{ provider: "anthropic-2", id: "claude-opus" },
			{ provider: "anthropic-2", id: "claude-sonnet" },
		];
		const { ctx, setModel } = makeCtx({
			agentDir,
			auth: { anthropic: true, "anthropic-2": true },
			models,
			// claude-opus is registered for anthropic-2 but not selectable.
			availableModels: [{ provider: "cursor", id: "grok" }, models[1]],
			currentModel: { provider: "cursor", id: "grok" },
			onSelect: (title: string, options: string[]) => {
				if (title === "CLAUDE ACCOUNTS") return options[1];
				return options.find((option) => option === "use this account");
			},
		});
		await executeAccountsCommand(extensionApi(setModel), commandContext(ctx), withAgentDir(agentDir));
		expect(setModel).toHaveBeenCalledWith(models[1]);
	});

	it("does not switch when the account has no available model", async () => {
		const agentDir = tempAgentDir();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: [PINNED_ADAPTER_SOURCE], enabledModels: ["cursor/grok"] }),
			"utf8",
		);
		writeAccounts(agentDir, { subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] });
		const { ctx, setModel, notify } = makeCtx({
			agentDir,
			auth: { anthropic: true, "anthropic-2": true },
			models: [{ provider: "anthropic-2", id: "claude-opus" }],
			availableModels: [{ provider: "cursor", id: "grok" }],
			currentModel: { provider: "cursor", id: "grok" },
			onSelect: (title: string, options: string[]) => {
				if (title === "CLAUDE ACCOUNTS") return options[1];
				return options.find((option) => option === "use this account");
			},
		});
		await executeAccountsCommand(extensionApi(setModel), commandContext(ctx), withAgentDir(agentDir));
		expect(setModel).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("anthropic-2 has no selectable model; reload SumoCode before switching", "warning");
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
		expect(actionOptions).toContain(SIGN_IN_BROWSER);
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
		const refreshAccountStatus = vi.fn();
		await executeAccountsCommand(extensionApi(), commandContext(ctx), { ...withAgentDir(agentDir), refreshAccountStatus });
		expect(loadClaudeSubscriptions(withAgentDir(agentDir))).toEqual([{ provider: "anthropic", index: 2, label: "personal" }]);
		expect(refreshAccountStatus).toHaveBeenCalledOnce();
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

const TOKEN = "sk-ant-oat01-TestToken0123456789_-abcd";

/** First call picks the account row, later calls pick the requested action. */
function pickAccountAction(accountPrefix: string, action: string) {
	return (title: string, options: string[]) => {
		if (title === "CLAUDE ACCOUNTS") return options.find((option) => option.startsWith(accountPrefix));
		return options.find((option) => option.startsWith(action));
	};
}

/** Run with the real diagnostics sink pointed at a temp file, so token leakage is observable. */
async function withDiagnosticsFile(run: (file: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "sumocode-accounts-diag-"));
	const file = join(dir, "diagnostics.jsonl");
	const previous = process.env.SUMO_TUI_DIAG_FILE;
	process.env.SUMO_TUI_DIAG_FILE = file;
	try {
		await run(file);
	} finally {
		if (previous === undefined) delete process.env.SUMO_TUI_DIAG_FILE;
		else process.env.SUMO_TUI_DIAG_FILE = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}

function tokenAccountDeps(agentDir: string, overrides: AccountsCommandDeps = {}): AccountsCommandDeps {
	return {
		...withAgentDir(agentDir),
		acquireToken: async () => ({ status: "ok", token: TOKEN }),
		validateToken: async () => ({ status: "ok", organization: "Acme Org" }),
		storeCredential: async () => {},
		...overrides,
	};
}

function companyAccount(agentDir: string): void {
	writeAccounts(agentDir, { subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] });
}

const COMPANY_MODELS = [{ provider: "anthropic-2", id: "claude-opus" }];

describe("stored credential classification", () => {
	it("reads the credential kind through Pi's store, not a file", async () => {
		const agentDir = tempAgentDir();
		companyAccount(agentDir);
		const read = vi.fn(async (providerId: string): Promise<StoredClaudeCredential | undefined> =>
			providerId === "anthropic-2" ? "long-lived-token" : undefined,
		);
		const { ctx, select } = makeCtx({ agentDir, auth: { anthropic: true, "anthropic-2": true }, models: COMPANY_MODELS, onSelect: pickOption("company") });
		await executeAccountsCommand(extensionApi(), commandContext(ctx), { ...withAgentDir(agentDir), readStoredCredential: read });
		expect(read).toHaveBeenCalledWith("anthropic-2");
		expect(selectOptionsAt(select, 0)).toContain("company · token  anthropic-2");
	});

	it("classifies through Pi's store when no reader is injected", async () => {
		const agentDir = tempAgentDir();
		companyAccount(agentDir);
		const { ctx, select } = makeCtx({
			agentDir,
			auth: { anthropic: true, "anthropic-2": true },
			models: COMPANY_MODELS,
			onSelect: pickOption("company"),
			runtime: {
				getAvailable: async () => [],
				getProviders: () => [],
				login: async () => {},
				credentials: {
					read: async () => staticClaudeCredential(TOKEN, 1),
					modify: async () => undefined,
				},
			},
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), withAgentDir(agentDir));
		expect(selectOptionsAt(select, 0)).toContain("company · token  anthropic-2");
		expect(selectOptionsAt(select, 1)).toContain(RENEW_LONG_LIVED);
	});

	it("keeps a stored token account selectable before Pi's snapshot catches up", async () => {
		const agentDir = tempAgentDir();
		companyAccount(agentDir);
		const store = { read: async () => staticClaudeCredential(TOKEN, 1), modify: async () => undefined };
		const { ctx, select, notify } = makeCtx({
			agentDir,
			auth: { anthropic: true, "anthropic-2": false },
			models: COMPANY_MODELS,
			onSelect: pickAccountAction("company", "use this account"),
			runtime: { getAvailable: async () => [], getProviders: () => [], login: async () => {}, credentials: store },
		});
		const setModel = vi.fn(async () => true);
		await executeAccountsCommand(extensionApi(setModel), commandContext(ctx), withAgentDir(agentDir));
		expect(selectOptionsAt(select, 1)).toContain("use this account");
		expect(setModel).toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("must be signed in"), "warning");
	});

	it("logs a credential read failure instead of silently mislabelling the row", async () => {
		const agentDir = tempAgentDir();
		companyAccount(agentDir);
		const { ctx, select } = makeCtx({
			agentDir,
			auth: { anthropic: true, "anthropic-2": true },
			models: COMPANY_MODELS,
			onSelect: pickOption("company"),
			runtime: {
				getAvailable: async () => [],
				getProviders: () => [],
				login: async () => {},
				credentials: {
					read: async () => {
						throw new Error("credential store unavailable");
					},
					modify: async () => undefined,
				},
			},
		});
		await withDiagnosticsFile(async (file) => {
			await executeAccountsCommand(extensionApi(), commandContext(ctx), withAgentDir(agentDir));
			expect(readFileSync(file, "utf8")).toContain("accounts_credential_read_failed");
		});
		expect(selectOptionsAt(select, 0)).toContain("company · signed in  anthropic-2");
	});

	it("degrades to signed in when the store is unavailable", async () => {
		const agentDir = tempAgentDir();
		companyAccount(agentDir);
		const { ctx, select } = makeCtx({ agentDir, auth: { anthropic: true, "anthropic-2": true }, models: COMPANY_MODELS, onSelect: pickOption("company") });
		await executeAccountsCommand(extensionApi(), commandContext(ctx), withAgentDir(agentDir));
		expect(selectOptionsAt(select, 0)).toContain("company · signed in  anthropic-2");
	});
});

describe("long-lived token sign-in", () => {
	it("offers the long-lived token ahead of the browser sign-in", async () => {
		const agentDir = tempAgentDir();
		companyAccount(agentDir);
		const { ctx, select } = makeCtx({
			agentDir,
			auth: { anthropic: true },
			models: COMPANY_MODELS,
			onSelect: pickOption("company"),
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), withAgentDir(agentDir));
		const actions = selectOptionsAt(select, 1);
		expect(actions.filter((action) => action === SIGN_IN_LONG_LIVED || action === SIGN_IN_BROWSER)).toEqual([
			SIGN_IN_LONG_LIVED,
			SIGN_IN_BROWSER,
		]);
	});

	it("runs the browser sign-in only when that method is chosen", async () => {
		const agentDir = tempAgentDir();
		companyAccount(agentDir);
		const login = vi.fn(async () => {});
		const { ctx } = makeCtx({
			agentDir,
			auth: { anthropic: true },
			models: COMPANY_MODELS,
			onSelect: pickAccountAction("company", SIGN_IN_BROWSER),
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), tokenAccountDeps(agentDir, { login }));
		expect(login).toHaveBeenCalledWith("anthropic-2", expect.anything());
	});

	it("stores the token the mint captures, without asking for a paste", async () => {
		const agentDir = tempAgentDir();
		companyAccount(agentDir);
		const storeCredential = vi.fn(async () => {});
		const refreshAccountStatus = vi.fn();
		const { ctx, input, notify } = makeCtx({
			agentDir,
			auth: { anthropic: true },
			models: COMPANY_MODELS,
			onSelect: pickAccountAction("company", SIGN_IN_LONG_LIVED),
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), tokenAccountDeps(agentDir, { storeCredential, refreshAccountStatus }));
		expect(input).not.toHaveBeenCalled();
		expect(storeCredential).toHaveBeenCalledWith("anthropic-2", {
			type: "oauth",
			access: TOKEN,
			refresh: "",
			expires: STATIC_CREDENTIAL_EXPIRES,
			mintedAt: expect.any(Number),
		});
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Acme Org"), "info");
		expect(refreshAccountStatus).toHaveBeenCalledOnce();
	});

	it("falls back to the masked paste modal when the CLI is missing", async () => {
		const agentDir = tempAgentDir();
		companyAccount(agentDir);
		const storeCredential = vi.fn(async () => {});
		const { ctx, input, notify, setWidget } = makeCtx({
			agentDir,
			auth: { anthropic: true },
			models: COMPANY_MODELS,
			onSelect: pickAccountAction("company", SIGN_IN_LONG_LIVED),
			onInput: () => TOKEN,
		});
		await executeAccountsCommand(
			extensionApi(),
			commandContext(ctx),
			tokenAccountDeps(agentDir, { acquireToken: async () => ({ status: "unavailable" }), storeCredential }),
		);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining(CLAUDE_SETUP_TOKEN_COMMAND), "warning");
		expect(isSecretInputTitle(input.mock.calls[0][0])).toBe(true);
		expect(setWidget).toHaveBeenCalledWith(
			"sumocode.accounts",
			[expect.stringContaining(CLAUDE_SETUP_TOKEN_COMMAND)],
			{ placement: "aboveEditor" },
		);
		expect(storeCredential).toHaveBeenCalled();
	});

	it("accepts a pasted token on the same terms after a timed-out mint", async () => {
		const agentDir = tempAgentDir();
		companyAccount(agentDir);
		const storeCredential = vi.fn(async () => {});
		const { ctx } = makeCtx({
			agentDir,
			auth: { anthropic: true },
			models: COMPANY_MODELS,
			onSelect: pickAccountAction("company", SIGN_IN_LONG_LIVED),
			onInput: () => TOKEN,
		});
		await executeAccountsCommand(
			extensionApi(),
			commandContext(ctx),
			tokenAccountDeps(agentDir, { acquireToken: async () => ({ status: "timeout" }), storeCredential }),
		);
		expect(storeCredential).toHaveBeenCalled();
	});

	it("rejects a value that is not a Claude long-lived token", async () => {
		const agentDir = tempAgentDir();
		companyAccount(agentDir);
		const storeCredential = vi.fn(async () => {});
		const { ctx, notify } = makeCtx({
			agentDir,
			auth: { anthropic: true },
			models: COMPANY_MODELS,
			onSelect: pickAccountAction("company", SIGN_IN_LONG_LIVED),
			onInput: () => "sk-ant-api03-not-a-setup-token",
		});
		await executeAccountsCommand(
			extensionApi(),
			commandContext(ctx),
			tokenAccountDeps(agentDir, { acquireToken: async () => ({ status: "unavailable" }), storeCredential }),
		);
		expect(storeCredential).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("sk-ant-oat"), "warning");
	});

	it("refuses to store a token Anthropic rejects", async () => {
		const agentDir = tempAgentDir();
		companyAccount(agentDir);
		const storeCredential = vi.fn(async () => {});
		const { ctx, notify } = makeCtx({
			agentDir,
			auth: { anthropic: true },
			models: COMPANY_MODELS,
			onSelect: pickAccountAction("company", SIGN_IN_LONG_LIVED),
		});
		await executeAccountsCommand(
			extensionApi(),
			commandContext(ctx),
			tokenAccountDeps(agentDir, { validateToken: async () => ({ status: "rejected" }), storeCredential }),
		);
		expect(storeCredential).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("rejected"), "error");
	});

	it("stores anyway when the live check cannot reach Anthropic", async () => {
		const agentDir = tempAgentDir();
		companyAccount(agentDir);
		const storeCredential = vi.fn(async () => {});
		const { ctx, notify } = makeCtx({
			agentDir,
			auth: { anthropic: true },
			models: COMPANY_MODELS,
			onSelect: pickAccountAction("company", SIGN_IN_LONG_LIVED),
		});
		await executeAccountsCommand(
			extensionApi(),
			commandContext(ctx),
			tokenAccountDeps(agentDir, { validateToken: async () => ({ status: "unreachable" }), storeCredential }),
		);
		expect(storeCredential).toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("could not be reached"), "warning");
	});

	it("writes through Pi's credential store and refreshes that provider's auth snapshot", async () => {
		const agentDir = tempAgentDir();
		companyAccount(agentDir);
		const modify = vi.fn(
			async (_providerId: string, fn: (current: StaticClaudeCredential | undefined) => StaticClaudeCredential | undefined) =>
				fn(undefined),
		);
		const { ctx, refresh } = makeCtx({
			agentDir,
			auth: { anthropic: true },
			models: COMPANY_MODELS,
			onSelect: pickAccountAction("company", SIGN_IN_LONG_LIVED),
			runtime: {
				getAvailable: async () => [],
				getProviders: () => [],
				login: async () => {},
				credentials: { read: async () => undefined, modify },
			},
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), tokenAccountDeps(agentDir, { storeCredential: undefined }));
		expect(modify).toHaveBeenCalledWith("anthropic-2", expect.any(Function));
		expect(refresh).toHaveBeenCalledWith({ providers: ["anthropic-2"] });
	});

	it("never writes token material into the accounts config", async () => {
		const agentDir = tempAgentDir();
		companyAccount(agentDir);
		const { ctx } = makeCtx({
			agentDir,
			auth: { anthropic: true },
			models: COMPANY_MODELS,
			onSelect: pickAccountAction("company", SIGN_IN_LONG_LIVED),
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), tokenAccountDeps(agentDir));
		const config = readFileSync(join(agentDir, "claude-accounts.json"), "utf8");
		expect(config).not.toContain(TOKEN);
	});

	it("labels a token-backed account and offers a re-mint", async () => {
		const agentDir = tempAgentDir();
		companyAccount(agentDir);
		const { ctx, select } = makeCtx({
			agentDir,
			auth: { anthropic: true, "anthropic-2": true },
			models: COMPANY_MODELS,
			onSelect: pickOption("company"),
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), {
			...withAgentDir(agentDir),
			readStoredCredential: async () => "long-lived-token",
		});
		expect(selectOptionsAt(select, 0)).toContain("company · token  anthropic-2");
		const actions = selectOptionsAt(select, 1);
		expect(actions).toContain(RENEW_LONG_LIVED);
		expect(actions).toContain(SIGN_IN_BROWSER);
		expect(actions.indexOf(RENEW_LONG_LIVED)).toBeLessThan(actions.indexOf(SIGN_IN_BROWSER));
	});

	it("never renders or logs the token value", async () => {
		const agentDir = tempAgentDir();
		companyAccount(agentDir);
		const { ctx, notify } = makeCtx({
			agentDir,
			auth: { anthropic: true },
			models: COMPANY_MODELS,
			onSelect: pickAccountAction("company", SIGN_IN_LONG_LIVED),
		});
		await withDiagnosticsFile(async (file) => {
			await executeAccountsCommand(extensionApi(), commandContext(ctx), tokenAccountDeps(agentDir));
			const logged = readFileSync(file, "utf8");
			expect(logged).not.toContain(TOKEN);
			expect(logged).toContain("accounts_long_lived_token_stored");
		});
		expect(JSON.stringify(notify.mock.calls)).not.toContain(TOKEN);
	});
});
