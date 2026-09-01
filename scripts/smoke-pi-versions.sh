#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT_CHECKER="${ROOT_DIR}/scripts/pi-compat-contract.mjs"
# pi-mcp-adapter is a disposable compatibility fixture, not a production dependency.
MCP_ADAPTER_VERSION="2.31.0"
TYPEBOX_VERSION="$(node -p "require('${ROOT_DIR}/package.json').devDependencies.typebox")"
TEMP_DIRS=()

cleanup() {
	local dir
	for dir in "${TEMP_DIRS[@]-}"; do
		if [[ -n "${dir}" ]]; then rm -rf "${dir}"; fi
	done
}
trap cleanup EXIT INT TERM

usage() {
	cat <<'EOF'
Usage: scripts/smoke-pi-versions.sh [--supported-matrix | VERSION...]

  --supported-matrix  test every published supported patch in all three Pi peer ranges
  VERSION...          test explicit aligned versions for a pending Pi bump
EOF
}

case "${1:-}" in
	-h|--help)
		usage
		exit 0
		;;
	--supported-matrix)
		if [[ "$#" -ne 1 ]]; then
			echo "--supported-matrix cannot be combined with explicit versions" >&2
			exit 2
		fi
		REGISTRY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sumo-pi-registry.XXXXXX")"
		TEMP_DIRS+=("${REGISTRY_DIR}")
		for package in pi-ai pi-coding-agent pi-tui; do
			if ! pnpm view "@earendil-works/${package}" versions --json >"${REGISTRY_DIR}/${package}.json"; then
				echo "Pi compatibility matrix: BLOCKED — registry resolution failed for @earendil-works/${package}" >&2
				exit 1
			fi
		done
		VERSIONS=()
		while IFS= read -r version; do
			VERSIONS+=("${version}")
		done < <(node "${CONTRACT_CHECKER}" --resolve-matrix \
			"${ROOT_DIR}/package.json" "${REGISTRY_DIR}/pi-ai.json" "${REGISTRY_DIR}/pi-coding-agent.json" "${REGISTRY_DIR}/pi-tui.json")
		;;
	"")
		VERSIONS=("0.84.3")
		;;
	*)
		VERSIONS=("$@")
		;;
esac

if [[ "${#VERSIONS[@]}" -eq 0 ]]; then
	echo "no Pi versions selected" >&2
	exit 1
fi

# The canonical compatibility gate is --supported-matrix. Explicit versions are
# intentionally retained for a pending bump: scripts/smoke-pi-versions.sh 0.85.0
for VERSION in "${VERSIONS[@]}"; do
	if [[ ! "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
		echo "invalid Pi version: ${VERSION}" >&2
		exit 2
	fi

	WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sumo-pi-${VERSION}.XXXXXX")"
	TEMP_DIRS+=("${WORK_DIR}")
	chmod 700 "${WORK_DIR}"
	cat >"${WORK_DIR}/package.json" <<JSON
{
  "private": true,
  "type": "module",
  "dependencies": {
    "@earendil-works/pi-ai": "${VERSION}",
    "@earendil-works/pi-coding-agent": "${VERSION}",
    "@earendil-works/pi-tui": "${VERSION}",
    "@dhruvkelawala/sumocode": "file:${ROOT_DIR}",
    "pi-mcp-adapter": "${MCP_ADAPTER_VERSION}",
    "typebox": "${TYPEBOX_VERSION}"
  }
}
JSON
	(
		cd "${WORK_DIR}"
		unset SUMOCODE_BG_CHILD SUMOCODE_ROOT_DIR SUMOCODE_LAUNCHER SUMOCODE_RPC_CHILD SUMOCODE_PROJECT_CWD SUMOCODE_INITIAL_PROMPT SUMO_RPC SUMO_TUI
		if ! pnpm install --silent --no-frozen-lockfile; then
			echo "Pi compatibility matrix: BLOCKED — package installation failed for ${VERSION}" >&2
			exit 1
		fi

		SUMO_ROOT="${WORK_DIR}/node_modules/@dhruvkelawala/sumocode"
		PI_ROOT="${WORK_DIR}/node_modules/@earendil-works/pi-coding-agent"
		PI_CORE_ROOT="$(dirname "$(realpath "${PI_ROOT}")")/pi-agent-core"
		PI_CORE_TYPES="${PI_CORE_ROOT}/dist/types.d.ts"
		PI_BIN="${WORK_DIR}/node_modules/.bin/pi"
		SUMO_BIN="${WORK_DIR}/node_modules/.bin/sumocode"
		EXTENSION_ENTRY="${SUMO_ROOT}/src/extension-entry.ts"
		MCP_EXTENSION="${WORK_DIR}/node_modules/pi-mcp-adapter/index.ts"

		actual_version="$("${PI_BIN}" --version)"
		if [[ "${actual_version}" != "${VERSION}" ]]; then
			echo "pi --version returned ${actual_version}, expected ${VERSION}" >&2
			exit 1
		fi

		# Compile production source against this candidate's declarations so request
		# fields and consumed response payloads are checked, not only discriminants.
		node --input-type=commonjs - \
			"${WORK_DIR}/candidate-tsconfig.json" "${ROOT_DIR}" "${PI_ROOT}" \
			"${WORK_DIR}/node_modules/@earendil-works/pi-ai" "${WORK_DIR}/node_modules/@earendil-works/pi-tui" "${PI_CORE_ROOT}" <<'NODE'
const { readdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [output, sumoRoot, codingAgentRoot, aiRoot, tuiRoot, agentCoreRoot] = process.argv.slice(2);
function productionTypeScriptFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? productionTypeScriptFiles(path) : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
	});
}
writeFileSync(output, JSON.stringify({
	extends: `${sumoRoot}/tsconfig.json`,
	compilerOptions: {
		paths: {
			"@earendil-works/pi-coding-agent": [`${codingAgentRoot}/dist/index.d.ts`],
			"@earendil-works/pi-coding-agent/*": [`${codingAgentRoot}/*`],
			"@earendil-works/pi-ai": [`${aiRoot}/dist/index.d.ts`],
			"@earendil-works/pi-ai/*": [`${aiRoot}/*`],
			"@earendil-works/pi-tui": [`${tuiRoot}/dist/index.d.ts`],
			"@earendil-works/pi-tui/*": [`${tuiRoot}/*`],
			"@earendil-works/pi-agent-core": [`${agentCoreRoot}/dist/index.d.ts`],
			"@earendil-works/pi-agent-core/*": [`${agentCoreRoot}/*`],
		},
	},
	files: productionTypeScriptFiles(`${sumoRoot}/src`),
	include: [],
	exclude: [],
}));
NODE
		if ! "${ROOT_DIR}/node_modules/.bin/tsc" --project candidate-tsconfig.json --pretty false; then
			echo "Pi compatibility contract ${VERSION}: candidate typecheck failed" >&2
			exit 1
		fi

		cat >pty-run.py <<'PY'
import os, pty, sys
sumo, pi, output, *args = sys.argv[1:]
os.environ["PI_BIN"] = pi
with open(output, "wb") as target:
    def read(fd):
        data = os.read(fd, 4096)
        target.write(data)
        return data
    status = pty.spawn([sumo, *args], master_read=read)
if os.waitstatus_to_exitcode(status) != 0:
    raise SystemExit(os.waitstatus_to_exitcode(status))
PY
		python3 pty-run.py "${SUMO_BIN}" "${PI_BIN}" mode-rpc.txt --dry-run --mode rpc --offline --no-extensions --no-session >/dev/null
		python3 pty-run.py "${SUMO_BIN}" "${PI_BIN}" print.txt --dry-run --offline --no-extensions --no-session --print hello >/dev/null
		PI_BIN="${PI_BIN}" "${SUMO_BIN}" --dry-run --offline --no-extensions --no-session >non-tty.txt
		python3 pty-run.py "${SUMO_BIN}" "${PI_BIN}" tui-mode.txt --dry-run --offline --no-extensions --no-session --tui-mode fullscreen "compat prompt" >/dev/null
		tr -d '\r' <tui-mode.txt >tui-mode-clean.txt

		cat >compat-probe.mjs <<'PROBE'
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

let turn = 0;
function streamCompatibilityModel(model) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const output = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "pending",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: output });
		if (turn++ === 0) {
			const toolCall = { type: "toolCall", id: "compat-bash", name: "bash", arguments: { command: 'rm -rf /tmp/sumocode-compat-never && printf candidate-bypass > "$HOME/tool-bypass.txt"' } };
			output.content.push(toolCall);
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
			output.stopReason = "toolUse";
		} else {
			output.content.push({ type: "text", text: "done" });
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "done", partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: "done", partial: output });
			output.stopReason = "stop";
		}
		stream.push({ type: "done", reason: output.stopReason, message: output });
		stream.end();
	});
	return stream;
}

export default function compatibilityProbe(pi) {
	pi.registerProvider("sumocode-compat", {
		name: "SumoCode compatibility probe",
		baseUrl: "http://127.0.0.1",
		apiKey: "compat",
		api: "sumocode-compat",
		models: [{ id: "tool-bypass", name: "Tool bypass", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256 }],
		streamSimple: streamCompatibilityModel,
	});
	pi.registerCommand("sumo:compat-tools", {
		description: "compatibility probe",
		handler: async (_args, ctx) => ctx.ui.setStatus("sumocode.compat-tools", JSON.stringify(pi.getActiveTools())),
	});
}
PROBE
		cat >rpc-probe.mjs <<'NODE'
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const [pi, extension, mcpExtension, probe, output, home] = process.argv.slice(2);
const child = spawn(pi, ["--mode", "rpc", "-e", probe, "-e", extension, "-e", mcpExtension, "--offline", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"], {
	env: { ...process.env, HOME: home, SUMOCODE_RPC_CHILD: "1", SUMOCODE_NATIVE_TASK: "1" },
	stdio: ["pipe", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
let closing = false;
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	stdout += chunk;
	if (!closing && stdout.includes('"type":"tool_execution_end"') && stdout.includes('"id":"state"') && stdout.includes('"id":"commands"')) {
		closing = true;
		child.stdin.end();
	}
});
child.stderr.on("data", (chunk) => { stderr += chunk; });
const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
child.stdin.write([
	JSON.stringify({ id: "tools", type: "prompt", message: "/sumo:compat-tools" }),
	JSON.stringify({ id: "model", type: "set_model", provider: "sumocode-compat", modelId: "tool-bypass" }),
	JSON.stringify({ id: "tool-bypass", type: "prompt", message: "run the compatibility tool" }),
	JSON.stringify({ id: "state", type: "get_state" }),
	JSON.stringify({ id: "commands", type: "get_commands" }),
].join("\n") + "\n");
const [code] = await new Promise((resolve) => child.once("close", (...args) => resolve(args)));
clearTimeout(timer);
if (code !== 0) throw new Error(`RPC child exited ${code}: ${stderr.slice(-4000)}`);
const messages = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
const state = messages.find((message) => message.id === "state" && message.command === "get_state" && message.success === true);
const commands = messages.find((message) => message.id === "commands" && message.command === "get_commands" && message.success === true);
const tools = messages.find((message) => message.type === "extension_ui_request" && message.method === "setStatus" && message.statusKey === "sumocode.compat-tools");
const toolExecution = messages.find((message) => message.type === "tool_execution_end" && message.toolCallId === "compat-bash" && message.toolName === "bash");
if (!state || !commands || !tools || !toolExecution) throw new Error(`RPC probe responses incomplete: ${stdout.slice(-4000)}`);
writeFileSync(output, JSON.stringify({
	state,
	commands: commands.data.commands,
	toolNames: JSON.parse(tools.statusText),
	toolBypass: readFileSync(`${home}/tool-bypass.txt`, "utf8") === "candidate-bypass" && toolExecution.isError === false,
}));
NODE
		mkdir -m 700 rpc-home
		if ! node rpc-probe.mjs "${PI_BIN}" "${EXTENSION_ENTRY}" "${MCP_EXTENSION}" "${WORK_DIR}/compat-probe.mjs" "${WORK_DIR}/rpc-result.json" "${WORK_DIR}/rpc-home" >rpc-probe.log 2>&1; then
			tail -c 200000 rpc-probe.log >&2
			exit 1
		fi

		node --input-type=module - \
			"${WORK_DIR}/node_modules/@earendil-works/pi-ai/package.json" "${PI_ROOT}/package.json" "${WORK_DIR}/node_modules/@earendil-works/pi-tui/package.json" \
			"${PI_ROOT}/dist/modes/rpc/rpc-types.d.ts" "${PI_ROOT}/dist/core/agent-session.d.ts" \
			"${PI_CORE_TYPES}" "${PI_ROOT}/dist/core/slash-commands.js" \
			"${SUMO_ROOT}/src/sumo-tui/rpc/host-actions.ts" "${SUMO_ROOT}/src/extension.ts" "${SUMO_ROOT}/src/interaction-registry.ts" \
			"${EXTENSION_ENTRY}" "${WORK_DIR}/rpc-result.json" "${WORK_DIR}/contract-input.json" <<'NODE'
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [aiPackagePath, codingPackagePath, tuiPackagePath, rpcTypesPath, agentSessionTypesPath, agentCoreTypesPath, slashPath, hostPath, extensionPath, registryPath, extensionEntry, rpcResultPath, outputPath] = process.argv.slice(2);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const slash = await import(pathToFileURL(slashPath));
const rpc = readJson(rpcResultPath);
const modeText = readFileSync("mode-rpc.txt", "utf8");
const printText = readFileSync("print.txt", "utf8");
const nonTtyText = readFileSync("non-tty.txt", "utf8");
const tuiModeText = readFileSync("tui-mode-clean.txt", "utf8");
writeFileSync(outputPath, JSON.stringify({
	versions: { ai: readJson(aiPackagePath).version, codingAgent: readJson(codingPackagePath).version, tui: readJson(tuiPackagePath).version },
	rpcTypesText: readFileSync(rpcTypesPath, "utf8"),
	agentSessionTypesText: readFileSync(agentSessionTypesPath, "utf8"),
	agentCoreTypesText: readFileSync(agentCoreTypesPath, "utf8"),
	builtinCommands: slash.BUILTIN_SLASH_COMMANDS,
	hostActionsSource: readFileSync(hostPath, "utf8"),
	extensionSource: readFileSync(extensionPath, "utf8"),
	interactionRegistrySource: readFileSync(registryPath, "utf8"),
	rpcCommands: rpc.commands,
	sumocodeExtensionPath: rpc.commands.find((command) => command.source === "extension" && command.name === "accounts")?.sourceInfo?.path ?? realpathSync(extensionEntry),
	runtime: {
		printBypass: /exec .*node_modules\/\.bin\/pi -e .*src\/extension-entry\.ts .*--print hello/.test(printText) && !printText.includes("sumo-rpc-host.js"),
		modeBypass: /exec .*node_modules\/\.bin\/pi -e .*src\/extension-entry\.ts --mode rpc/.test(modeText) && !modeText.includes("sumo-rpc-host.js"),
		nonTtyBypass: /exec .*node_modules\/\.bin\/pi -e .*src\/extension-entry\.ts --offline/.test(nonTtyText) && !nonTtyText.includes("sumo-rpc-host.js"),
		tuiModePositional: tuiModeText.includes("SUMOCODE_INITIAL_PROMPT=compat prompt") && /exec node .*sumo-rpc-host\.js .*--tui-mode fullscreen/.test(tuiModeText),
		rpcState: rpc.state?.success === true && rpc.state.command === "get_state",
		rpcCommands: Array.isArray(rpc.commands),
		toolBypass: rpc.toolBypass === true,
		toolNames: rpc.toolNames,
	},
}));
NODE
		node "${CONTRACT_CHECKER}" contract-input.json
		echo "sumocode Pi compatibility ${VERSION}: PASS"
	)
done
