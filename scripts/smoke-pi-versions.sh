#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT_CHECKER="${ROOT_DIR}/scripts/pi-compat-contract.mjs"
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
		pnpm view @earendil-works/pi-ai versions --json >"${REGISTRY_DIR}/ai.json"
		pnpm view @earendil-works/pi-coding-agent versions --json >"${REGISTRY_DIR}/coding-agent.json"
		pnpm view @earendil-works/pi-tui versions --json >"${REGISTRY_DIR}/tui.json"
		VERSIONS=()
		while IFS= read -r version; do
			VERSIONS+=("${version}")
		done < <(node "${CONTRACT_CHECKER}" --resolve-matrix \
			"${ROOT_DIR}/package.json" "${REGISTRY_DIR}/ai.json" "${REGISTRY_DIR}/coding-agent.json" "${REGISTRY_DIR}/tui.json")
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
    "typebox": "1.1.33"
  }
}
JSON
	(
		cd "${WORK_DIR}"
		unset SUMOCODE_BG_CHILD SUMOCODE_ROOT_DIR SUMOCODE_LAUNCHER SUMOCODE_RPC_CHILD SUMOCODE_PROJECT_CWD SUMOCODE_INITIAL_PROMPT SUMO_RPC SUMO_TUI
		pnpm install --silent

		SUMO_ROOT="${WORK_DIR}/node_modules/@dhruvkelawala/sumocode"
		PI_ROOT="${WORK_DIR}/node_modules/@earendil-works/pi-coding-agent"
		PI_BIN="${WORK_DIR}/node_modules/.bin/pi"
		SUMO_BIN="${WORK_DIR}/node_modules/.bin/sumocode"
		EXTENSION_ENTRY="${SUMO_ROOT}/src/extension-entry.ts"

		node --input-type=module - "${VERSION}" <<'NODE'
import { readFileSync } from "node:fs";
const expected = process.argv[2];
const packages = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];
for (const name of packages) {
	const actual = JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version;
	if (actual !== expected) throw new Error(`${name} resolved ${actual}, expected ${expected}`);
}
NODE
		actual_version="$(${PI_BIN} --version)"
		if [[ "${actual_version}" != "${VERSION}" ]]; then
			echo "pi --version returned ${actual_version}, expected ${VERSION}" >&2
			exit 1
		fi

		PI_BIN="${PI_BIN}" "${SUMO_BIN}" --dry-run --mode rpc --offline --no-extensions --no-session >mode-rpc.txt
		rg "exec .*node_modules/.bin/pi -e .*src/extension-entry.ts --mode rpc" mode-rpc.txt >/dev/null
		PI_BIN="${PI_BIN}" "${SUMO_BIN}" --dry-run --offline --no-extensions --no-session --print hello >print.txt
		rg "exec .*node_modules/.bin/pi -e .*src/extension-entry.ts .*--print hello" print.txt >/dev/null
		PI_BIN="${PI_BIN}" "${SUMO_BIN}" --dry-run --offline --no-extensions --no-session >non-tty.txt
		rg "exec .*node_modules/.bin/pi -e .*src/extension-entry.ts --offline" non-tty.txt >/dev/null
		if rg "sumo-rpc-host.js" mode-rpc.txt print.txt non-tty.txt >/dev/null; then
			echo "direct Pi bypass unexpectedly used the foreground RPC host" >&2
			exit 1
		fi

		python3 - "${SUMO_BIN}" "${PI_BIN}" "${WORK_DIR}/tui-mode.txt" <<'PY'
import os, pty, sys
sumo, pi, output = sys.argv[1:]
env = os.environ.copy()
env["PI_BIN"] = pi
argv = [sumo, "--dry-run", "--offline", "--no-extensions", "--no-session", "--tui-mode", "fullscreen", "compat prompt"]
old = os.environ.copy()
os.environ.clear(); os.environ.update(env)
with open(output, "wb") as target:
    def read(fd):
        data = os.read(fd, 4096)
        target.write(data)
        return data
    status = pty.spawn(argv, master_read=read)
os.environ.clear(); os.environ.update(old)
if os.waitstatus_to_exitcode(status) != 0:
    raise SystemExit(os.waitstatus_to_exitcode(status))
PY
		tr -d '\r' <tui-mode.txt >tui-mode-clean.txt
		rg "SUMOCODE_INITIAL_PROMPT=compat prompt" tui-mode-clean.txt >/dev/null
		rg "exec node .*sumo-rpc-host.js --offline --no-extensions --no-session --tui-mode fullscreen" tui-mode-clean.txt >/dev/null

		cat >compat-probe.mjs <<'PROBE'
export default function compatibilityProbe(pi) {
	pi.registerCommand("mcp", { description: "compatibility probe", handler: async () => undefined });
	pi.registerCommand("mcp-auth", { description: "compatibility probe", handler: async () => undefined });
	pi.registerCommand("sumo:compat-tools", {
		description: "compatibility probe",
		handler: async (_args, ctx) => ctx.ui.setStatus("sumocode.compat-tools", JSON.stringify(pi.getActiveTools())),
	});
}
PROBE
		cat >rpc-probe.mjs <<'NODE'
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [pi, extension, probe, output, home] = process.argv.slice(2);
const child = spawn(pi, ["--mode", "rpc", "-e", extension, "-e", probe, "--offline", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"], {
	env: { ...process.env, HOME: home, SUMOCODE_RPC_CHILD: "1", SUMOCODE_NATIVE_TASK: "1" },
	stdio: ["pipe", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
child.stdin.end([
	JSON.stringify({ id: "tools", type: "prompt", message: "/sumo:compat-tools" }),
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
if (!state || !commands || !tools) throw new Error(`RPC probe responses incomplete: ${stdout.slice(-4000)}`);
writeFileSync(output, JSON.stringify({ state: true, commands: commands.data.commands, toolNames: JSON.parse(tools.statusText) }));
NODE
		mkdir -m 700 rpc-home
		if ! node rpc-probe.mjs "${PI_BIN}" "${EXTENSION_ENTRY}" "${WORK_DIR}/compat-probe.mjs" "${WORK_DIR}/rpc-result.json" "${WORK_DIR}/rpc-home" >rpc-probe.log 2>&1; then
			tail -c 200000 rpc-probe.log >&2
			exit 1
		fi

		node --input-type=module - \
			"${VERSION}" "${PI_ROOT}/package.json" "${PI_ROOT}/dist/modes/rpc/rpc-types.d.ts" "${PI_ROOT}/dist/core/slash-commands.js" \
			"${SUMO_ROOT}/src/sumo-tui/rpc/host-actions.ts" "${SUMO_ROOT}/src/extension.ts" "${SUMO_ROOT}/src/interaction-registry.ts" \
			"${EXTENSION_ENTRY}" "${WORK_DIR}/rpc-result.json" "${WORK_DIR}/contract-input.json" <<'NODE'
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [version, packagePath, rpcTypesPath, slashPath, hostPath, extensionPath, registryPath, extensionEntry, rpcResultPath, outputPath] = process.argv.slice(2);
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
const slash = await import(pathToFileURL(slashPath));
const rpc = JSON.parse(readFileSync(rpcResultPath, "utf8"));
writeFileSync(outputPath, JSON.stringify({
	versions: { ai: version, codingAgent: packageJson.version, tui: version },
	rpcTypesText: readFileSync(rpcTypesPath, "utf8"),
	builtinCommands: slash.BUILTIN_SLASH_COMMANDS,
	hostActionsSource: readFileSync(hostPath, "utf8"),
	extensionSource: readFileSync(extensionPath, "utf8"),
	interactionRegistrySource: readFileSync(registryPath, "utf8"),
	rpcCommands: rpc.commands,
	sumocodeExtensionPath: rpc.commands.find((command) => command.source === "extension" && command.name === "accounts")?.sourceInfo?.path ?? realpathSync(extensionEntry),
	runtime: {
		printBypass: true, modeBypass: true, nonTtyBypass: true, tuiModePositional: true,
		rpcState: rpc.state, rpcCommands: true, toolNames: rpc.toolNames,
	},
}));
NODE
		node "${CONTRACT_CHECKER}" contract-input.json
		echo "sumocode Pi compatibility ${VERSION}: PASS"
	)
done
