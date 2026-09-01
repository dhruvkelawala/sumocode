#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const EXPECTED_HOST_COMMANDS = Object.freeze([
	"settings", "login", "model", "thinking", "theme", "sumo:theme", "compact", "new", "clone", "fork", "sessions", "resume",
	"tree", "session", "name", "copy", "export", "quit", "sumo:memory", "sumo:theme-check", "sumo:palette", "hotkeys", "lovely-web", "changelog",
]);
const PI_MIRRORED_HOST_COMMANDS = Object.freeze([
	"settings", "login", "model", "thinking", "compact", "new", "clone", "fork", "resume", "tree", "session", "name", "copy", "export", "quit", "hotkeys", "changelog",
]);
const HOST_OWNED_COMMANDS = Object.freeze(["theme", "sumo:theme", "sessions", "sumo:memory", "sumo:theme-check", "sumo:palette", "lovely-web"]);
const EXPECTED_ROUTED_CHILD_COMMANDS = Object.freeze(["mcp", "mcp-auth"]);
export const EXPECTED_SUMOCODE_EXTENSION_COMMANDS = Object.freeze([
	"login", "sumo:login-cancel", "sumo:rpc-tree-navigate", "fast", "answer", "reload", "sumo:roles", "accounts", "sumo:cursor", "sumo:diff",
	"sumo:query", "exit", "slate", "sumo:persona", "sumo:review", "sumo:ship", "sumo:spinner", "sumo:sync", "sumo:bootstrap", "sumo:tabs",
	"sumo:theme", "sumo:theme-check", "sumo:worktree", "sumo:memory",
]);
export const REQUIRED_RPC_COMMANDS = Object.freeze([
	"prompt", "abort", "new_session", "get_state", "set_model", "cycle_model", "get_available_models", "set_thinking_level", "cycle_thinking_level",
	"get_available_thinking_levels", "compact", "set_auto_compaction", "set_auto_retry", "get_session_stats", "export_html", "switch_session", "fork", "clone",
	"get_fork_messages", "get_entries", "get_last_assistant_text", "set_session_name", "get_commands", "get_messages",
]);
export const REQUIRED_EVENTS = Object.freeze([
	"agent_start", "agent_end", "turn_end", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update",
	"tool_execution_end", "agent_settled", "queue_update", "compaction_start", "compaction_end", "session_info_changed", "thinking_level_changed",
]);
const REQUIRED_UI_METHODS = Object.freeze(["select", "confirm", "input", "editor", "notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);
const REQUIRED_TOOLS = Object.freeze([
	"terminal_start", "terminal_check", "terminal_wait", "terminal_stop", "terminal_list",
	"subagent_spawn", "subagent_send", "subagent_check", "subagent_wait", "subagent_cancel", "subagent_close", "subagent_list",
]);
const REQUIRED_RUNTIME_RECORDS = Object.freeze(["printBypass", "modeBypass", "nonTtyBypass", "tuiModePositional", "rpcState", "rpcCommands"]);

function uniqueSorted(values) {
	return [...new Set(values)].sort();
}

function assertInventory(label, expected, actual) {
	const missing = expected.filter((name) => !actual.includes(name));
	const extra = actual.filter((name) => !expected.includes(name));
	if (missing.length === 0 && extra.length === 0) return;
	const details = [missing.length ? `missing: ${missing.join(", ")}` : "", extra.length ? `extra: ${extra.join(", ")}` : ""].filter(Boolean).join("; ");
	throw new Error(`${label} drift (${details})`);
}

function stringLiterals(text, property) {
	return uniqueSorted([...text.matchAll(new RegExp(`\\b${property}\\s*:\\s*["']([^"']+)["']`, "g"))].map((match) => match[1]));
}

function typeDeclaration(text, name) {
	const start = text.indexOf(`export type ${name} =`);
	if (start < 0) return "";
	const rest = text.slice(start);
	const next = rest.slice(1).search(/\nexport (?:type|interface|declare)\s/);
	return next < 0 ? rest : rest.slice(0, next + 1);
}

function extractHostCommands(source) {
	const block = source.match(/RPC_HOST_SLASH_COMMANDS[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
	return [...block.matchAll(/\bname:\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

function extractRoutedCommands(source) {
	const block = source.match(/RPC_HOST_ROUTED_CHILD_COMMANDS[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]/)?.[1] ?? "";
	return [...block.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

function withoutComments(source) {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function assertApprovalGateDisabled(input) {
	const extension = withoutComments(input.extensionSource ?? "");
	const interactions = withoutComments(input.interactionRegistrySource ?? "");
	const host = withoutComments(input.hostActionsSource ?? "");
	if (/\binstallApprovalGate\s*\(/.test(extension)
		|| /\bregisterApprovalCommand\s*\(/.test(interactions)
		|| /["']\/?sumo:approval["']/.test(`${extension}\n${interactions}\n${host}`)
		|| /approval(?:Overlay|Route)/.test(host)) {
		throw new Error("approval gate is active");
	}
}

export function assertCompatibilityContract(input) {
	const versions = Object.values(input.versions ?? {});
	if (versions.length !== 3 || new Set(versions).size !== 1) throw new Error("expected aligned Pi package versions");

	const rpcTypes = input.rpcTypesText ?? "";
	const commandMembers = stringLiterals(typeDeclaration(rpcTypes, "RpcCommand"), "type").filter((name) => REQUIRED_RPC_COMMANDS.includes(name));
	const responseMembers = stringLiterals(typeDeclaration(rpcTypes, "RpcResponse"), "command").filter((name) => REQUIRED_RPC_COMMANDS.includes(name));
	const missingCommands = REQUIRED_RPC_COMMANDS.filter((name) => !commandMembers.includes(name) || !responseMembers.includes(name));
	if (missingCommands.length) throw new Error(`missing RPC commands: ${missingCommands.join(", ")}`);
	const uiMethods = stringLiterals(typeDeclaration(rpcTypes, "RpcExtensionUIRequest"), "method");
	const missingUi = REQUIRED_UI_METHODS.filter((name) => !uiMethods.includes(name));
	if (missingUi.length || !typeDeclaration(rpcTypes, "RpcExtensionUIResponse").includes('type: "extension_ui_response"')) {
		throw new Error(`missing RPC extension UI members: ${missingUi.join(", ") || "extension_ui_response"}`);
	}
	const events = uniqueSorted([
		...stringLiterals(typeDeclaration(input.agentCoreTypesText ?? "", "AgentEvent"), "type"),
		...stringLiterals(typeDeclaration(input.agentSessionTypesText ?? "", "AgentSessionEvent"), "type"),
	]);
	const missingEvents = REQUIRED_EVENTS.filter((name) => !events.includes(name));
	if (missingEvents.length) throw new Error(`missing Pi events: ${missingEvents.join(", ")}`);

	assertInventory("host command inventory", EXPECTED_HOST_COMMANDS, extractHostCommands(input.hostActionsSource ?? ""));
	assertInventory("host command ownership classification", EXPECTED_HOST_COMMANDS, [...PI_MIRRORED_HOST_COMMANDS, ...HOST_OWNED_COMMANDS]);
	if (PI_MIRRORED_HOST_COMMANDS.some((name) => HOST_OWNED_COMMANDS.includes(name))) throw new Error("host command ownership classification overlaps");
	assertInventory("routed child command inventory", EXPECTED_ROUTED_CHILD_COMMANDS, extractRoutedCommands(input.hostActionsSource ?? ""));
	const builtinNames = uniqueSorted((input.builtinCommands ?? []).map((entry) => entry.name).filter((name) => PI_MIRRORED_HOST_COMMANDS.includes(name)));
	assertInventory("Pi-mirrored built-in command inventory", PI_MIRRORED_HOST_COMMANDS, builtinNames);

	const rpcCommands = input.rpcCommands ?? [];
	const sumocodeCommands = rpcCommands
		.filter((entry) => entry.source === "extension" && (entry.sourceInfo?.path === input.sumocodeExtensionPath || entry.sourceInfo?.path?.endsWith("/src/extension-entry.ts")))
		.map((entry) => entry.name);
	if (sumocodeCommands.length === 0) {
		const sources = uniqueSorted(rpcCommands.filter((entry) => entry.source === "extension").map((entry) => `${entry.name}@${entry.sourceInfo?.path ?? "unknown"}`));
		throw new Error(`SumoCode extension command inventory unavailable (extension commands: ${sources.join(", ") || "none"})`);
	}
	assertInventory("SumoCode extension command inventory", EXPECTED_SUMOCODE_EXTENSION_COMMANDS, sumocodeCommands);
	const extensionNames = uniqueSorted(rpcCommands.filter((entry) => entry.source === "extension").map((entry) => entry.name));
	const missingRouted = EXPECTED_ROUTED_CHILD_COMMANDS.filter((name) => !extensionNames.includes(name));
	if (missingRouted.length) throw new Error(`routed child command inventory drift (missing: ${missingRouted.join(", ")})`);

	assertApprovalGateDisabled(input);
	for (const record of REQUIRED_RUNTIME_RECORDS) {
		if (input.runtime?.[record] !== true) throw new Error(`runtime check failed: ${record}`);
	}
	const toolNames = input.runtime?.toolNames ?? [];
	const missingTools = REQUIRED_TOOLS.filter((name) => !toolNames.includes(name));
	if (missingTools.length) throw new Error(`missing SumoCode tools: ${missingTools.join(", ")}`);

	return { version: versions[0], hostCommands: EXPECTED_HOST_COMMANDS.length, extensionCommands: EXPECTED_SUMOCODE_EXTENSION_COMMANDS.length };
}

function parseVersion(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	return match ? match.slice(1).map(Number) : undefined;
}

function satisfiesTilde(version, range) {
	const match = /^~(\d+)\.(\d+)\.(\d+)$/.exec(range);
	if (!match) throw new Error(`unsupported peer range: ${range}`);
	const parsed = parseVersion(version);
	if (!parsed) return false;
	const [major, minor, patch] = parsed;
	return major === Number(match[1]) && minor === Number(match[2]) && patch >= Number(match[3]);
}

function compareVersions(left, right) {
	const a = parseVersion(left);
	const b = parseVersion(right);
	if (!a || !b) return left.localeCompare(right);
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function resolveSupportedMatrix(ranges, published) {
	const rangeValues = Object.values(ranges);
	if (rangeValues.length !== 3 || new Set(rangeValues).size !== 1) throw new Error("Pi peer ranges diverge");
	const sets = Object.keys(ranges).map((key) => uniqueSorted((published[key] ?? []).filter((version) => satisfiesTilde(version, ranges[key]))).sort(compareVersions));
	if (sets.some((set) => set.length === 0)) throw new Error("a Pi peer range has no published satisfying versions");
	const canonical = JSON.stringify(sets[0]);
	if (sets.some((set) => JSON.stringify(set) !== canonical)) throw new Error("Pi peer satisfying version sets diverge");
	return sets[0];
}

export function assertWorkflowContract(text) {
	for (const required of ["pull_request:", "schedule:", "cron:", "workflow_dispatch:", "timeout-minutes:", "pnpm install --frozen-lockfile", "scripts/smoke-pi-versions.sh --supported-matrix"]) {
		if (!text.includes(required)) throw new Error(`workflow is missing ${required}`);
	}
	const invocationCount = text.split("scripts/smoke-pi-versions.sh --supported-matrix").length - 1;
	if (invocationCount !== 1) throw new Error(`workflow must contain one canonical matrix invocation, found ${invocationCount}`);
	for (const path of ["package.json", "bin/sumocode.sh", "sumo-rpc-host.js", "src/extension-entry.ts", "src/sumo-tui/rpc/**", "src/extension.ts", "src/interaction-registry.ts", "scripts/smoke-pi-versions.sh", "scripts/pi-compat-contract.mjs", "scripts/pi-compat-contract.test.mjs", ".github/workflows/pi-compat.yml"]) {
		if (!text.includes(path)) throw new Error(`workflow PR paths are missing ${path}`);
	}
	return true;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

async function main(args) {
	if (args[0] === "--resolve-matrix") {
		const [packagePath, aiPath, codingPath, tuiPath] = args.slice(1);
		const packageJson = readJson(packagePath);
		const ranges = {
			ai: packageJson.peerDependencies["@earendil-works/pi-ai"],
			codingAgent: packageJson.peerDependencies["@earendil-works/pi-coding-agent"],
			tui: packageJson.peerDependencies["@earendil-works/pi-tui"],
		};
		const matrix = resolveSupportedMatrix(ranges, { ai: readJson(aiPath), codingAgent: readJson(codingPath), tui: readJson(tuiPath) });
		process.stdout.write(`${matrix.join("\n")}\n`);
		return;
	}
	if (args[0] === "--check-workflow") {
		assertWorkflowContract(readFileSync(args[1], "utf8"));
		process.stdout.write("Pi compatibility workflow contract: PASS\n");
		return;
	}
	const input = args[0] ? readJson(args[0]) : JSON.parse(readFileSync(0, "utf8"));
	const result = assertCompatibilityContract(input);
	process.stdout.write(`Pi compatibility contract ${result.version}: PASS\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
