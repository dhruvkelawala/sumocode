import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	assertCompatibilityContract,
	assertWorkflowContract,
	resolveSupportedMatrix,
} from "./pi-compat-contract.mjs";

const HOST_COMMANDS = [
	"settings", "login", "model", "thinking", "theme", "sumo:theme", "compact", "new", "clone", "fork", "sessions", "resume",
	"tree", "session", "name", "copy", "export", "quit", "sumo:memory", "sumo:theme-check", "sumo:palette", "hotkeys", "lovely-web", "changelog",
];
const SUMO_COMMANDS = [
	"login", "sumo:login-cancel", "sumo:rpc-tree-navigate", "fast", "answer", "reload", "sumo:roles", "accounts", "sumo:cursor", "sumo:diff",
	"sumo:query", "exit", "slate", "sumo:persona", "sumo:review", "sumo:ship", "sumo:spinner", "sumo:sync", "sumo:bootstrap", "sumo:tabs",
	"sumo:theme", "sumo:theme-check", "sumo:worktree", "sumo:memory",
];
const PI_BUILTINS = [
	"settings", "model", "tree", "thinking", "export", "copy", "name", "session", "changelog", "hotkeys", "fork", "clone", "login", "new", "compact", "resume", "quit",
];
const RPC_COMMANDS = [
	"prompt", "abort", "new_session", "get_state", "set_model", "cycle_model", "get_available_models", "set_thinking_level", "cycle_thinking_level",
	"get_available_thinking_levels", "compact", "set_auto_compaction", "set_auto_retry", "get_session_stats", "export_html", "switch_session", "fork", "clone",
	"get_fork_messages", "get_entries", "get_last_assistant_text", "set_session_name", "get_commands",
];

function rpcTypes(commands = RPC_COMMANDS) {
	return `export type RpcCommand = ${commands.map((name) => `{ type: "${name}" }`).join(" | ")};\n`
		+ `export type RpcResponse = ${commands.map((name) => `{ command: "${name}" }`).join(" | ")};\n`
		+ `export type RpcExtensionUIRequest = { method: "select" } | { method: "confirm" } | { method: "input" } | { method: "editor" } | { method: "notify" } | { method: "setStatus" } | { method: "setWidget" } | { method: "setTitle" } | { method: "set_editor_text" };\n`
		+ `export type RpcExtensionUIResponse = { type: "extension_ui_response"; value: string } | { type: "extension_ui_response"; confirmed: boolean } | { type: "extension_ui_response"; cancelled: true };`;
}

function hostSource(commands = HOST_COMMANDS) {
	return `export const RPC_HOST_SLASH_COMMANDS = Object.freeze([${commands.map((name) => `{ name: "${name}" }`).join(",")}]);\n`
		+ `export const RPC_HOST_ROUTED_CHILD_COMMANDS = Object.freeze(["mcp", "mcp-auth"] as const);`;
}

function command(name, source = "extension", path = "/repo/src/extension-entry.ts") {
	return { name, source, sourceInfo: { path } };
}

function validInput() {
	return {
		versions: { ai: "0.84.4", codingAgent: "0.84.4", tui: "0.84.4" },
		rpcTypesText: rpcTypes(),
		builtinCommands: PI_BUILTINS.map((name) => ({ name })),
		hostActionsSource: hostSource(),
		extensionSource: "installFastMode(pi); // dormant: installApprovalGate\n",
		interactionRegistrySource: "installSumoInteractions(pi); // dormant: registerApprovalCommand\n",
		rpcCommands: [
			...SUMO_COMMANDS.map((name) => command(name)),
			command("mcp", "extension", "/probe.mjs"),
			command("mcp-auth", "extension", "/probe.mjs"),
			command("template-noise", "prompt", "/prompt.md"),
			command("skill-noise", "skill", "/skill.md"),
		],
		sumocodeExtensionPath: "/repo/src/extension-entry.ts",
		runtime: {
			printBypass: true,
			modeBypass: true,
			nonTtyBypass: true,
			tuiModePositional: true,
			rpcState: true,
			rpcCommands: true,
			toolNames: [
				"terminal_start", "terminal_check", "terminal_wait", "terminal_stop", "terminal_list",
				"subagent_spawn", "subagent_send", "subagent_check", "subagent_wait", "subagent_cancel", "subagent_close", "subagent_list",
			],
		},
	};
}

describe("Pi compatibility contract", () => {
	it("accepts the current ownership-separated contract with prompt/skill noise", () => {
		expect(assertCompatibilityContract(validInput())).toEqual({ version: "0.84.4", hostCommands: 24, extensionCommands: 24 });
	});

	it("accepts the current repository and installed Pi contract surfaces", () => {
		const input = validInput();
		input.rpcTypesText = readFileSync("node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts", "utf8");
		input.builtinCommands = [...readFileSync("node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js", "utf8").matchAll(/\bname:\s*"([^"]+)"/g)]
			.map((match) => ({ name: match[1] }));
		input.hostActionsSource = readFileSync("src/sumo-tui/rpc/host-actions.ts", "utf8");
		input.extensionSource = readFileSync("src/extension.ts", "utf8");
		input.interactionRegistrySource = readFileSync("src/interaction-registry.ts", "utf8");
		expect(assertCompatibilityContract(input)).toMatchObject({ hostCommands: 24, extensionCommands: 24 });
	});

	it("rejects misaligned Pi package versions", () => {
		const input = validInput();
		input.versions.tui = "0.84.3";
		expect(() => assertCompatibilityContract(input)).toThrow("aligned Pi package versions");
	});

	it("reports a removed RPC member by name", () => {
		const input = validInput();
		input.rpcTypesText = rpcTypes(RPC_COMMANDS.filter((name) => name !== "get_commands"));
		expect(() => assertCompatibilityContract(input)).toThrow("missing RPC commands: get_commands");
	});

	it("reports host and extension inventory drift by member name", () => {
		const host = validInput();
		host.hostActionsSource = hostSource(HOST_COMMANDS.filter((name) => name !== "hotkeys"));
		expect(() => assertCompatibilityContract(host)).toThrow(/host command inventory.*hotkeys/);

		const extension = validInput();
		extension.rpcCommands = extension.rpcCommands.filter((entry) => entry.name !== "accounts");
		expect(() => assertCompatibilityContract(extension)).toThrow(/SumoCode extension command inventory.*accounts/);
	});

	it("rejects a failed bounded RPC or tool probe", () => {
		const rpc = validInput();
		rpc.runtime.rpcState = false;
		expect(() => assertCompatibilityContract(rpc)).toThrow("runtime check failed: rpcState");
		const tools = validInput();
		tools.runtime.toolNames = tools.runtime.toolNames.filter((name) => name !== "subagent_spawn");
		expect(() => assertCompatibilityContract(tools)).toThrow("missing SumoCode tools: subagent_spawn");
	});

	it("rejects a reintroduced active approval gate or route", () => {
		for (const [field, source] of [
			["extensionSource", "installApprovalGate(pi);"],
			["interactionRegistrySource", "registerApprovalCommand(pi);"],
			["hostActionsSource", `${hostSource()}\ncase "/sumo:approval":`],
		]) {
			const input = validInput();
			input[field] = source;
			expect(() => assertCompatibilityContract(input)).toThrow("approval gate is active");
		}
	});
});

describe("supported matrix resolution", () => {
	it("returns every satisfying published patch in semantic order", () => {
		expect(resolveSupportedMatrix(
			{ ai: "~0.84.3", codingAgent: "~0.84.3", tui: "~0.84.3" },
			{ ai: ["0.84.4", "0.84.3", "0.85.0"], codingAgent: ["0.84.3", "0.84.4"], tui: ["0.84.4", "0.84.3"] },
		)).toEqual(["0.84.3", "0.84.4"]);
	});

	it("supports a one-patch range and rejects divergent or unavailable sets", () => {
		expect(resolveSupportedMatrix(
			{ ai: "~0.84.3", codingAgent: "~0.84.3", tui: "~0.84.3" },
			{ ai: ["0.84.3"], codingAgent: ["0.84.3"], tui: ["0.84.3"] },
		)).toEqual(["0.84.3"]);
		expect(() => resolveSupportedMatrix(
			{ ai: "~0.84.3", codingAgent: "~0.84.3", tui: "~0.84.3" },
			{ ai: ["0.84.3", "0.84.4"], codingAgent: ["0.84.3"], tui: ["0.84.3", "0.84.4"] },
		)).toThrow("satisfying version sets diverge");
		expect(() => resolveSupportedMatrix(
			{ ai: "~0.84.3", codingAgent: "~0.84.3", tui: "~0.84.3" },
			{ ai: [], codingAgent: [], tui: [] },
		)).toThrow("no published satisfying versions");
	});
});

describe("workflow contract", () => {
	const workflow = `on:\n  pull_request:\n    paths: [package.json, bin/sumocode.sh, src/sumo-tui/rpc/**, src/extension.ts, scripts/smoke-pi-versions.sh, scripts/pi-compat-contract.mjs, .github/workflows/pi-compat.yml]\n  schedule:\n    - cron: "17 4 * * *"\n  workflow_dispatch:\njobs:\n  pi-compat:\n    timeout-minutes: 20\n    steps:\n      - run: scripts/smoke-pi-versions.sh --supported-matrix\n`;

	it("requires qualifying PR paths, daily/manual triggers, timeout, and one canonical invocation", () => {
		expect(assertWorkflowContract(workflow)).toBe(true);
	});

	it("accepts the committed workflow", () => {
		expect(assertWorkflowContract(readFileSync(".github/workflows/pi-compat.yml", "utf8"))).toBe(true);
	});

	it("rejects an unbounded or non-fresh workflow", () => {
		expect(() => assertWorkflowContract(workflow.replace("timeout-minutes: 20\n", ""))).toThrow("timeout-minutes");
		expect(() => assertWorkflowContract(workflow.replace("  schedule:\n", "  ignored:\n"))).toThrow("schedule");
	});
});
