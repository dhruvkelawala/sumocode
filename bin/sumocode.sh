#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

export SUMO_TUI="${SUMO_TUI:-1}"

PI_BIN="${ROOT_DIR}/node_modules/.bin/pi"
if [[ ! -x "${PI_BIN}" ]]; then
	PI_BIN="$(command -v pi)"
fi

is_truthy_env_flag() {
	case "${1:-}" in
		1|true|TRUE|yes|YES|on|ON) return 0 ;;
		*) return 1 ;;
	esac
}

pi_main_file() {
	node -e '
const fs = require("node:fs");
const path = require("node:path");
const bin = process.argv[1];
try {
	const resolved = fs.realpathSync(bin);
	const dir = path.dirname(resolved);
	const candidates = [path.join(dir, "main.js"), path.join(dir, "..", "dist", "main.js")];

	// pnpm creates a shell shim at node_modules/.bin/pi that execs
	// ../@mariozechner/pi-coding-agent/dist/cli.js. Resolve that target so we
	// can inspect the adjacent dist/main.js for the Sumo constructor patch.
	const source = fs.readFileSync(resolved, "utf8");
	const marker = "@mariozechner/pi-coding-agent/dist/cli.js";
	const markerIndex = source.indexOf(marker);
	const shimTarget = markerIndex >= 0 ? source.slice(0, markerIndex + marker.length).match(/[^\"\s]+@mariozechner\/pi-coding-agent\/dist\/cli\.js$/)?.[0] : undefined;
	if (shimTarget) {
		const normalizedShimTarget = shimTarget.replace(/^\$basedir\//, "");
		const cliPath = path.resolve(dir, normalizedShimTarget);
		candidates.push(path.join(path.dirname(cliPath), "main.js"));
	}

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			console.log(candidate);
			process.exit(0);
		}
	}
} catch {}
process.exit(1);
' "$1"
}

pi_has_sumo_tui_patch() {
	local main_file
	main_file="$(pi_main_file "$1" 2>/dev/null || true)"
	[[ -n "${main_file}" ]] && grep -q "loadSumoInteractiveMode" "${main_file}"
}

if is_truthy_env_flag "${SUMO_TUI}"; then
	if pi_has_sumo_tui_patch "${PI_BIN}"; then
		if [[ -z "${SUMO_TUI_MODULE:-}" ]]; then
			SUMO_TUI_MODULE="$(node -e 'const { pathToFileURL } = require("node:url"); console.log(pathToFileURL(process.argv[1]).href);' "${ROOT_DIR}/sumo-interactive-mode.js")"
			export SUMO_TUI_MODULE
		fi
	else
		cat >&2 <<EOF
[sumocode] Selected Pi binary is missing the Sumo retained-TUI patch: ${PI_BIN}
[sumocode] Falling back to legacy Pi splash so the empty-state remains visible.
[sumocode] Run 'pnpm install' in ${ROOT_DIR} to use the retained Sumo TUI.
EOF
		export SUMO_TUI=0
		unset SUMO_TUI_MODULE
	fi
fi

exec "${PI_BIN}" -e "${ROOT_DIR}/src/extension.ts" "$@"
