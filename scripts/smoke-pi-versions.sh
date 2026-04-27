#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSIONS=("${@:-0.70.0 0.70.1 0.70.2}")

for VERSION in ${VERSIONS[*]}; do
	WORK_DIR="/tmp/sumo-pi-${VERSION}"
	rm -rf "${WORK_DIR}"
	mkdir -p "${WORK_DIR}"
	if [[ "${VERSION}" == "0.70.2" ]]; then
		PNPM_PATCH=',
  "pnpm": {
    "patchedDependencies": {
      "@mariozechner/pi-coding-agent@0.70.2": "'"${ROOT_DIR}"'/patches/@mariozechner__pi-coding-agent@0.70.2.patch"
    }
  }'
	else
		PNPM_PATCH=""
	fi
	cat >"${WORK_DIR}/package.json" <<JSON
{
  "private": true,
  "type": "module",
  "dependencies": {
    "@mariozechner/pi-coding-agent": "${VERSION}",
    "@dhruvkelawala/sumocode": "file:${ROOT_DIR}"
  }${PNPM_PATCH}
}
JSON
	(
		cd "${WORK_DIR}"
		pnpm install --silent
		if [[ "${VERSION}" == "0.70.2" ]]; then
			rg "SUMO_TUI_MODULE|loadSumoInteractiveMode" node_modules/@mariozechner/pi-coding-agent/dist/main.js >/dev/null
		else
			echo "sumocode smoke: ${VERSION} installs; fork activation patch is intentionally pinned to 0.70.2"
		fi
		node_modules/.bin/pi --version >"boot.txt" 2>&1
		printf "pi %s boot: %s\n" "${VERSION}" "$(cat boot.txt)"
	)
done
