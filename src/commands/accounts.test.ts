import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	executeAccountsCommand,
	isMultiPassInstalled,
	loadClaudeSubscriptions,
	registerAccountsCommand,
	resolveMultiPassConfigPath,
	saveClaudeSubscriptions,
	type AccountsCommandDeps,
} from "./accounts.js";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "sumocode-accounts-"));
	tempDirs.push(dir);
	return dir;
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
	return { agentDir };
}

function commandContext(ctx: ReturnType<typeof makeCtx>["ctx"]): ExtensionCommandContext {
	// SAFETY: the double carries every member the accounts command reads (mode, hasUI, ui dialogs, modelRegistry, model); unrelated ExtensionCommandContext members are never touched.
	return ctx as never;
}

// SAFETY: the double provides setModel, the only ExtensionAPI member the account flows invoke; switchAccount guards its call sites.
function extensionApi(setModel?: ExtensionAPI["setModel"]): ExtensionAPI {
	// SAFETY: the double provides setModel, the only ExtensionAPI member the account flows invoke; switchAccount guards its call sites.
	return { setModel } as never;
}

function selectOptionsAt(select: ReturnType<typeof makeCtx>["select"], callIndex: number): string[] {
	// SAFETY: vitest records each select() invocation as [title, options]; index 1 is always the options string array passed by the command.
	return select.mock.calls[callIndex][1] as string[];
}

const ADD_LABEL = "add Claude account  install/configure pi-multi-pass";

function pickOption(expected: string) {
	return (_title: string, options: string[]) => options.find((option) => option.startsWith(expected));
}

describe("resolveMultiPassConfigPath", () => {
	it("prefers the injected agent dir", () => {
		expect(resolveMultiPassConfigPath({ agentDir: "/agents/a" })).toBe(join("/agents/a", "multi-pass.json"));
	});

	it("resolves PI_CODING_AGENT_DIR from the injected env", () => {
		expect(resolveMultiPassConfigPath({ env: { PI_CODING_AGENT_DIR: "/agents/b" } })).toBe(
			join("/agents/b", "multi-pass.json"),
		);
	});

	it("falls back to ~/.pi/agent", () => {
		expect(resolveMultiPassConfigPath({ homeDir: "/home/u" })).toBe(join("/home/u", ".pi", "agent", "multi-pass.json"));
	});
});

describe("loadClaudeSubscriptions", () => {
	it("returns nothing when the config file is missing", () => {
		expect(loadClaudeSubscriptions(withAgentDir(tempAgentDir()))).toEqual([]);
	});

	it("returns nothing when the config file is malformed", () => {
		const agentDir = tempAgentDir();
		writeFileSync(join(agentDir, "multi-pass.json"), "{not json", "utf8");
		expect(loadClaudeSubscriptions(withAgentDir(agentDir))).toEqual([]);
	});

	it("returns nothing when subscriptions is not an array", () => {
		const agentDir = tempAgentDir();
		writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify({ subscriptions: "nope" }), "utf8");
		expect(loadClaudeSubscriptions(withAgentDir(agentDir))).toEqual([]);
	});

	it("keeps only well-formed anthropic subscriptions, sorted by index", () => {
		const agentDir = tempAgentDir();
		writeFileSync(
			join(agentDir, "multi-pass.json"),
			JSON.stringify({
				subscriptions: [
					{ provider: "anthropic", index: 3, label: "third" },
					{ provider: "openai", index: 1, label: "not claude" },
					{ provider: "anthropic", index: 2 },
					{ provider: "anthropic", index: 1 },
					{ provider: "anthropic", index: 1.5 },
					"garbage",
				],
			}),
			"utf8",
		);
		expect(loadClaudeSubscriptions(withAgentDir(agentDir))).toEqual([
			{ provider: "anthropic", index: 2 },
			{ provider: "anthropic", index: 3, label: "third" },
		]);
	});
});

describe("saveClaudeSubscriptions", () => {
	it("preserves pools, chains, presets, unknown keys, and non-Claude subscriptions", () => {
		const agentDir = tempAgentDir();
		writeFileSync(
			join(agentDir, "multi-pass.json"),
			JSON.stringify({
				subscriptions: [
					{ provider: "openai", index: 4, label: "work" },
					{ provider: "anthropic", index: 2, label: "company" },
					{ note: "unparseable entry" },
				],
				pools: [{ name: "pool" }],
				chains: [{ name: "chain" }],
				presets: [{ name: "preset" }],
				unknownKey: { keep: true },
			}),
			"utf8",
		);

		saveClaudeSubscriptions([{ provider: "anthropic", index: 5, label: "next" }], withAgentDir(agentDir));

		const saved = JSON.parse(readFileSync(join(agentDir, "multi-pass.json"), "utf8"));
		expect(saved.unknownKey).toEqual({ keep: true });
		expect(saved.pools).toEqual([{ name: "pool" }]);
		expect(saved.chains).toEqual([{ name: "chain" }]);
		expect(saved.presets).toEqual([{ name: "preset" }]);
		expect(saved.subscriptions).toEqual([
			{ provider: "openai", index: 4, label: "work" },
			{ note: "unparseable entry" },
			{ provider: "anthropic", index: 5, label: "next" },
		]);
	});

	it("creates pools, chains, and presets keys when missing", () => {
		const agentDir = tempAgentDir();
		saveClaudeSubscriptions([{ provider: "anthropic", index: 2, label: "company" }], withAgentDir(agentDir));
		const saved = JSON.parse(readFileSync(join(agentDir, "multi-pass.json"), "utf8"));
		expect(saved.pools).toEqual([]);
		expect(saved.chains).toEqual([]);
		expect(saved.presets).toEqual([]);
		expect(saved.subscriptions).toEqual([{ provider: "anthropic", index: 2, label: "company" }]);
	});
});

describe("isMultiPassInstalled", () => {
	it("detects string-form packages entries", () => {
		const agentDir = tempAgentDir();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-multi-pass"] }), "utf8");
		expect(isMultiPassInstalled(withAgentDir(agentDir))).toBe(true);
	});

	it("detects object-form packages entries", () => {
		const agentDir = tempAgentDir();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: [{ source: "npm:something-else" }, { source: "npm:pi-multi-pass" }] }),
			"utf8",
		);
		expect(isMultiPassInstalled(withAgentDir(agentDir))).toBe(true);
	});

	it("returns false when missing, malformed, or unrelated", () => {
		const agentDir = tempAgentDir();
		expect(isMultiPassInstalled(withAgentDir(agentDir))).toBe(false);
		writeFileSync(join(agentDir, "settings.json"), "{bad", "utf8");
		expect(isMultiPassInstalled(withAgentDir(agentDir))).toBe(false);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:other"] }), "utf8");
		expect(isMultiPassInstalled(withAgentDir(agentDir))).toBe(false);
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

	it("lists base and extra accounts with signed-in status", async () => {
		const agentDir = tempAgentDir();
		writeFileSync(
			join(agentDir, "multi-pass.json"),
			JSON.stringify({ subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] }),
			"utf8",
		);
		const { ctx, select } = makeCtx({
			agentDir,
			auth: { anthropic: true, "anthropic-2": false },
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), withAgentDir(agentDir));
		const options = selectOptionsAt(select, 0);
		expect(options[0]).toContain("anthropic · signed in");
		expect(options[1]).toContain("company");
		expect(options[1]).toContain("anthropic-2 · sign in required");
	});

	it("passes the exact provider id to the injected login flow", async () => {
		const agentDir = tempAgentDir();
		writeFileSync(
			join(agentDir, "multi-pass.json"),
			JSON.stringify({ subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] }),
			"utf8",
		);
		const login = vi.fn(async () => {});
		const { ctx } = makeCtx({
			agentDir,
			auth: { anthropic: true },
			onSelect: (title: string, options: string[]) => {
				if (title === "CLAUDE ACCOUNTS") return options[1];
				return options.find((option) => option === "sign in");
			},
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), { ...withAgentDir(agentDir), login });
		expect(login).toHaveBeenCalledWith("anthropic-2", expect.anything());
	});

	it("switching preserves the current model id on the target provider", async () => {
		const agentDir = tempAgentDir();
		writeFileSync(
			join(agentDir, "multi-pass.json"),
			JSON.stringify({ subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] }),
			"utf8",
		);
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
		writeFileSync(
			join(agentDir, "multi-pass.json"),
			JSON.stringify({ subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] }),
			"utf8",
		);
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
		writeFileSync(
			join(agentDir, "multi-pass.json"),
			JSON.stringify({ subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] }),
			"utf8",
		);
		const { ctx, select } = makeCtx({
			agentDir,
			auth: { anthropic: true, "anthropic-2": false },
			onSelect: pickOption("company"),
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), withAgentDir(agentDir));
		const actionOptions = selectOptionsAt(select, 1);
		expect(actionOptions).not.toContain("use this account");
		expect(actionOptions).toContain("sign in");
	});

	it("add flow confirms install, writes config, then requests reload", async () => {
		const agentDir = tempAgentDir();
		const installMultiPass = vi.fn(async () => {});
		const reload = vi.fn(async () => {});
		const { ctx, confirm, input } = makeCtx({
			agentDir,
			onSelect: pickOption(ADD_LABEL),
			onConfirm: (title) => title !== "",
			onInput: () => "company",
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), { ...withAgentDir(agentDir), installMultiPass, reload });

		expect(installMultiPass).toHaveBeenCalledTimes(1);
		expect(confirm).toHaveBeenCalledTimes(2);
		expect(input).toHaveBeenCalledWith("ACCOUNT LABEL", "company");
		expect(loadClaudeSubscriptions(withAgentDir(agentDir))).toEqual([
			{ provider: "anthropic", index: 2, label: "company" },
		]);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("add flow picks the next free index", async () => {
		const agentDir = tempAgentDir();
		writeFileSync(
			join(agentDir, "multi-pass.json"),
			JSON.stringify({ subscriptions: [{ provider: "anthropic", index: 2, label: "company" }] }),
			"utf8",
		);
		const installMultiPass = vi.fn(async () => {});
		const reload = vi.fn(async () => {});
		const { ctx, input } = makeCtx({
			agentDir,
			auth: { anthropic: true },
			onSelect: pickOption(ADD_LABEL),
			onConfirm: () => true,
			onInput: () => "second",
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), { ...withAgentDir(agentDir), installMultiPass, reload });
		expect(installMultiPass).toHaveBeenCalledTimes(1);
		expect(input).toHaveBeenCalledWith("ACCOUNT LABEL", "Claude account 3");
		expect(reload).toHaveBeenCalledTimes(1);
		expect(loadClaudeSubscriptions(withAgentDir(agentDir))).toEqual([
			{ provider: "anthropic", index: 2, label: "company" },
			{ provider: "anthropic", index: 3, label: "second" },
		]);
	});

	it("add flow skips install when pi-multi-pass is already present", async () => {
		const agentDir = tempAgentDir();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-multi-pass"] }), "utf8");
		const installMultiPass = vi.fn(async () => {});
		const reload = vi.fn(async () => {});
		const { ctx, confirm } = makeCtx({
			agentDir,
			onSelect: pickOption(ADD_LABEL),
			onConfirm: () => true,
			onInput: () => "company",
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), { ...withAgentDir(agentDir), installMultiPass, reload });
		expect(installMultiPass).not.toHaveBeenCalled();
		expect(reload).toHaveBeenCalledTimes(1);
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it("add flow reports installer failure visibly and writes nothing", async () => {
		const agentDir = tempAgentDir();
		const installMultiPass = vi.fn(async () => {
			throw new Error("network down");
		});
		const { ctx, notify, confirm } = makeCtx({
			agentDir,
			onSelect: pickOption(ADD_LABEL),
			onConfirm: () => true,
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), { ...withAgentDir(agentDir), installMultiPass });

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Unable to install pi-multi-pass: network down"), "error");
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(existsSync(join(agentDir, "multi-pass.json"))).toBe(false);
	});

	it("add flow does nothing when install is declined", async () => {
		const agentDir = tempAgentDir();
		const installMultiPass = vi.fn(async () => {});
		const { ctx, input } = makeCtx({
			agentDir,
			onSelect: pickOption(ADD_LABEL),
			onConfirm: () => false,
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), { ...withAgentDir(agentDir), installMultiPass });
		expect(installMultiPass).not.toHaveBeenCalled();
		expect(input).not.toHaveBeenCalled();
		expect(existsSync(join(agentDir, "multi-pass.json"))).toBe(false);
	});

	it("rename updates only the target subscription label", async () => {
		const agentDir = tempAgentDir();
		writeFileSync(
			join(agentDir, "multi-pass.json"),
			JSON.stringify({
				subscriptions: [
					{ provider: "openai", index: 4, label: "work" },
					{ provider: "anthropic", index: 2, label: "company" },
				],
			}),
			"utf8",
		);
		const { ctx } = makeCtx({
			agentDir,
			auth: { anthropic: true },
			onSelect: (title: string, options: string[]) => {
				if (title === "CLAUDE ACCOUNTS") return options[1];
				return options.find((option) => option === "rename account");
			},
			onInput: () => "personal",
		});
		await executeAccountsCommand(extensionApi(), commandContext(ctx), withAgentDir(agentDir));
		expect(loadClaudeSubscriptions(withAgentDir(agentDir))).toEqual([{ provider: "anthropic", index: 2, label: "personal" }]);
		const saved = JSON.parse(readFileSync(join(agentDir, "multi-pass.json"), "utf8"));
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
