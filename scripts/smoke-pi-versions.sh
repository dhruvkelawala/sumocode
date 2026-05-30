#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSIONS=("${@:-0.78.0}")

for VERSION in ${VERSIONS[*]}; do
	WORK_DIR="/tmp/sumo-pi-${VERSION}"
	rm -rf "${WORK_DIR}"
	mkdir -p "${WORK_DIR}"
	PATCH_FILE="${ROOT_DIR}/patches/@earendil-works__pi-coding-agent@${VERSION}.patch"
	if [[ -f "${PATCH_FILE}" ]]; then
		PNPM_PATCH=',
  "pnpm": {
    "patchedDependencies": {
      "@earendil-works/pi-coding-agent@'"${VERSION}"'": "'"${PATCH_FILE}"'"
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
    "@earendil-works/pi-coding-agent": "${VERSION}",
    "@dhruvkelawala/sumocode": "file:${ROOT_DIR}"
  }${PNPM_PATCH}
}
JSON
	(
		cd "${WORK_DIR}"
		pnpm install --silent
		if [[ -f "${PATCH_FILE}" ]]; then
			rg "SUMO_TUI_MODULE|loadSumoInteractiveMode" node_modules/@earendil-works/pi-coding-agent/dist/main.js >/dev/null
			echo "sumocode smoke: ${VERSION} installs with retained-TUI patch"
		else
			echo "sumocode smoke: ${VERSION} installs without a retained-TUI patch"
		fi
		node_modules/.bin/pi --version >"boot.txt" 2>&1
		printf "pi %s boot: %s\n" "${VERSION}" "$(cat boot.txt)"
	)
done
