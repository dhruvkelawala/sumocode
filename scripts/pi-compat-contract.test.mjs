import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertCompatibilityContract,
	assertWorkflowContract,
	EXPECTED_HOST_COMMANDS as HOST_COMMANDS,
	EXPECTED_SUMOCODE_EXTENSION_COMMANDS as SUMO_COMMANDS,
	REQUIRED_EVENTS as EVENTS,
	REQUIRED_RPC_COMMANDS as RPC_COMMANDS,
	resolveSupportedMatrix,
} from "./pi-compat-contract.mjs";

const PI_BUILTINS = [
	"settings", "model", "tree", "thinking", "export", "copy", "name", "session", "changelog", "hotkeys", "fork", "clone", "login", "new", "compact", "resume", "quit",
];
function rpcTypes(commands = RPC_COMMANDS) {
	return `export type RpcCommand = ${commands.map((name) => `{ type: "${name}" }`).join(" | ")};\n`
		+ `export type RpcResponse = ${commands.map((name) => `{ command: "${name}" }`).join(" | ")};\n`
		+ `export type RpcExtensionUIRequest = { method: "select" } | { method: "confirm" } | { method: "input" } | { method: "editor" } | { method: "notify" } | { method: "setStatus" } | { method: "setWidget" } | { method: "setTitle" } | { method: "set_editor_text" };\n`
		+ `export type RpcExtensionUIResponse = { type: "extension_ui_response"; value: string } | { type: "extension_ui_response"; confirmed: boolean } | { type: "extension_ui_response"; cancelled: true };`;
}

function eventTypes(events = EVENTS) {
	const core = events.filter((name) => !["agent_settled", "queue_update", "compaction_start", "compaction_end", "session_info_changed", "thinking_level_changed"].includes(name));
	const session = events.filter((name) => !core.includes(name));
	return {
		agentCoreTypesText: `export type AgentEvent = ${core.map((name) => `{ type: "${name}" }`).join(" | ")};`,
		agentSessionTypesText: `export type AgentSessionEvent = AgentEvent | ${session.map((name) => `{ type: "${name}" }`).join(" | ")};`,
	};
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
		...eventTypes(),
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
		const piRoot = realpathSync("node_modules/@earendil-works/pi-coding-agent");
		input.rpcTypesText = readFileSync(`${piRoot}/dist/modes/rpc/rpc-types.d.ts`, "utf8");
		input.agentSessionTypesText = readFileSync(`${piRoot}/dist/core/agent-session.d.ts`, "utf8");
		input.agentCoreTypesText = readFileSync(`${dirname(piRoot)}/pi-agent-core/dist/types.d.ts`, "utf8");
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

	it("reports removed RPC and event members by name", () => {
		const rpc = validInput();
		rpc.rpcTypesText = rpcTypes(RPC_COMMANDS.filter((name) => name !== "get_messages"));
		expect(() => assertCompatibilityContract(rpc)).toThrow("missing RPC commands: get_messages");

		const event = validInput();
		Object.assign(event, eventTypes(EVENTS.filter((name) => name !== "agent_settled")));
		expect(() => assertCompatibilityContract(event)).toThrow("missing Pi events: agent_settled");
	});

	it("reports host, Pi built-in, and extension inventory drift by member name", () => {
		const host = validInput();
		host.hostActionsSource = hostSource(HOST_COMMANDS.filter((name) => name !== "hotkeys"));
		expect(() => assertCompatibilityContract(host)).toThrow(/host command inventory.*hotkeys/);

		const builtin = validInput();
		builtin.builtinCommands = builtin.builtinCommands.filter((entry) => entry.name !== "login");
		expect(() => assertCompatibilityContract(builtin)).toThrow(/Pi-mirrored built-in command inventory.*login/);

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
			{ ai: ["0.84.4", "0.84.3", "0.85.0-beta.1", "0.85.0"], codingAgent: ["0.84.3", "0.84.4", "0.85.0-beta.1"], tui: ["0.84.4", "0.84.3", "0.85.0-beta.1"] },
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
	const workflow = `on:\n  pull_request:\n    paths: [package.json, bin/sumocode.sh, sumo-rpc-host.js, src/extension-entry.ts, src/sumo-tui/rpc/**, src/extension.ts, src/interaction-registry.ts, scripts/smoke-pi-versions.sh, scripts/pi-compat-contract.mjs, scripts/pi-compat-contract.test.mjs, .github/workflows/pi-compat.yml]\n  schedule:\n    - cron: "17 4 * * *"\n  workflow_dispatch:\njobs:\n  pi-compat:\n    timeout-minutes: 20\n    steps:\n      - run: pnpm install --frozen-lockfile\n      - run: scripts/smoke-pi-versions.sh --supported-matrix\n`;

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
