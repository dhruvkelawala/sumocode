#!/usr/bin/env node
/**
 * End-to-end proof for issue #568: a real headless child Pi process, launched
 * with exactly the argv SumoCode builds for an MCP grant, discovers and calls a
 * local fixture MCP server through the `mcp` gateway, and the fixture's native
 * image block reaches the child's message stream.
 *
 * `node scripts/mcp-capability-proof.mjs` prints a transcript and exits non-zero
 * unless the fixture was actually called and the image block arrived. Model
 * selection comes from MCP_PROOF_PROVIDER / MCP_PROOF_MODEL (default
 * deepseek/deepseek-flash), so this is a live run, not a CI test.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const repo = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const root = realpathSync(mkdtempSync(join(tmpdir(), "sumocode-mcp-proof-")));
const project = join(root, "project");
const stateDir = join(root, "state");
const fixtureLog = join(root, "fixture-calls.jsonl");
const decoyLog = join(root, "decoy-calls.jsonl");
for (const dir of [project, stateDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });

const fixtureServer = join(repo, "test", "integration", "fixtures", "mcp-fixture-server.mjs");
writeFileSync(join(project, ".mcp.json"), JSON.stringify({
	mcpServers: {
		fixture: { command: process.execPath, args: [fixtureServer], env: { MCP_FIXTURE_LOG: fixtureLog } },
		// Present in the project config on purpose: a scoped grant must fence it.
		decoy: { command: process.execPath, args: [fixtureServer], env: { MCP_FIXTURE_LOG: decoyLog } },
	},
}, null, 2));

// The child needs the operator's real agent dir for provider credentials, so
// only the state directory is sandboxed. The project directory (and therefore
// the fixture .mcp.json) is the temp root.
const env = { ...process.env, SUMOCODE_STATE_DIR: stateDir };
if (process.env.MCP_PROOF_ADAPTER) env.SUMOCODE_MCP_ADAPTER = process.env.MCP_PROOF_ADAPTER;

const jiti = createJiti(import.meta.url, { tryNative: false, fsCache: false });
const { resolveMcpLaunchCapability } = await jiti.import(join(repo, "src", "subagents", "mcp-capability.ts"));
const { resolveTaskConfig } = await jiti.import(join(repo, "src", "subagents", "task-config.ts"));
const { mcpLaunchArgs, resolveMcpChildBootstrapEntry, resolvePiBinary } = await jiti.import(join(repo, "src", "subagents", "backend-pi.ts"));

const capability = resolveMcpLaunchCapability({
	gatewayRequested: true, servers: ["fixture"], cwd: project, key: `proof-${Date.now().toString(36)}`, env,
});
if (!capability.ok || !capability.capability) {
	console.log(`FAIL: capability resolution refused the grant: ${capability.ok === false ? capability.error : "no capability"}`);
	process.exit(1);
}
const grant = capability.capability;
const scoped = JSON.parse(readFileSync(grant.configPath, "utf8"));

const model = process.env.MCP_PROOF_MODEL ?? "deepseek/deepseek-flash";
const config = resolveTaskConfig({
	item: { model }, defaultModel: undefined, defaultThinking: "inherit", inheritedThinking: "low",
	ctxModel: undefined, tools: ["read", "bash", "mcp"],
});
if (!config.ok) throw new Error(config.error);
// Production resolves the guard relative to src/subagents/backend-pi.ts; the
// proof passes that same module url so the emitted argv matches the real one.
const backendUrl = pathToFileURL(join(repo, "src", "subagents", "backend-pi.ts")).href;
const denyGrant = process.argv.includes("--deny-grant");
const args = denyGrant
	? config.subprocessArgs
	: [...config.subprocessArgs, ...mcpLaunchArgs(grant, resolveMcpChildBootstrapEntry(env, backendUrl))];

console.log("$ signed-in surface: scoped MCP config written by the capability resolver");
console.log(JSON.stringify(scoped, null, 2).split("\n").map((line) => `  ${line}`).join("\n"));
console.log(`$ argv: ${resolvePiBinary(env)} ${args.map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg)).join(" ")}`);

const prompt = denyGrant
	? "If you have an mcp tool, call it to run the fixture server's image tool. Otherwise reply exactly: no mcp tool available."
	: [
		"Call the mcp tool exactly once to run the fixture server's image tool:",
		'  server "fixture", tool "image", args {}.',
		"Then reply with the tool result's text metadata line, and nothing else.",
	].join("\n");

const child = spawn(resolvePiBinary(env), args, { cwd: project, env: { ...env, MCP_FIXTURE_LOG: fixtureLog }, stdio: ["pipe", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.stdin.end(`${prompt}\n`);
const exitCode = await new Promise((resolve) => child.once("close", resolve));

const lines = stdout.split("\n").filter(Boolean);
const parsed = lines.map((line) => { try { return JSON.parse(line); } catch { return undefined; } }).filter(Boolean);
const toolCalls = parsed.filter((event) => event.type === "tool_execution_start").map((event) => event.toolName);
const imageBlocks = parsed.filter((event) => JSON.stringify(event).includes('"type":"image"'));
const imageText = parsed.filter((event) => JSON.stringify(event).includes("fixture-image-metadata"));
const fixtureCalls = existsSync(fixtureLog) ? readFileSync(fixtureLog, "utf8").trim().split("\n").filter(Boolean) : [];
const decoyCalls = existsSync(decoyLog) ? readFileSync(decoyLog, "utf8").trim().split("\n").filter(Boolean) : [];

console.log(`$ child exit: ${exitCode}`);
console.log(`$ tool calls: ${JSON.stringify(toolCalls)}`);
console.log(`$ fixture server calls: ${JSON.stringify(fixtureCalls)}`);
console.log(`$ decoy server calls (must be zero): ${decoyCalls.length}`);
console.log(`$ image content blocks on the child's message stream: ${imageBlocks.length}`);
console.log(`$ text metadata blocks: ${imageText.length}`);
if (stderr.trim()) console.log(`$ child stderr: ${stderr.trim().split("\n").slice(0, 5).join("\n")}`);

const checks = denyGrant
	? [
		["a child without the MCP grant has no MCP tool", !toolCalls.includes("mcp")],
		["the fixture server was never reached", fixtureCalls.length === 0],
		["the child reported the missing capability instead of pretending", parsed.some((event) => JSON.stringify(event).includes("no mcp tool available"))],
	]
	: [
		["child called the MCP gateway", toolCalls.includes("mcp")],
		["fixture server received a tools/call", fixtureCalls.some((line) => JSON.parse(line).tool === "image")],
		["the unselected decoy server was never reached", decoyCalls.length === 0],
		["the synthetic image arrived as a native image block", imageBlocks.length > 0],
		["the image's text metadata survived", imageText.length > 0],
	];
let failed = false;
for (const [label, ok] of checks) {
	console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
	if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
