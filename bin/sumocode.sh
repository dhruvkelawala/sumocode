#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

export SUMO_TUI="${SUMO_TUI:-1}"
if [[ -z "${SUMO_TUI_MODULE:-}" ]]; then
	SUMO_TUI_MODULE="$(node -e 'const { pathToFileURL } = require("node:url"); console.log(pathToFileURL(process.argv[1]).href);' "${ROOT_DIR}/sumo-interactive-mode.js")"
	export SUMO_TUI_MODULE
fi

PI_BIN="${ROOT_DIR}/node_modules/.bin/pi"
if [[ ! -x "${PI_BIN}" ]]; then
	PI_BIN="pi"
fi

exec "${PI_BIN}" -e "${ROOT_DIR}/src/extension.ts" "$@"
