#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSIONS=("${@:-0.79.1}")

for VERSION in ${VERSIONS[*]}; do
	WORK_DIR="/tmp/sumo-pi-${VERSION}"
	rm -rf "${WORK_DIR}"
	mkdir -p "${WORK_DIR}"
	cat >"${WORK_DIR}/package.json" <<JSON
{
  "private": true,
  "type": "module",
  "dependencies": {
    "@earendil-works/pi-coding-agent": "${VERSION}",
    "@dhruvkelawala/sumocode": "file:${ROOT_DIR}"
  }
}
JSON
	(
		cd "${WORK_DIR}"
		pnpm install --silent
		echo "sumocode smoke: ${VERSION} installs without a private Pi patch"
		node_modules/.bin/pi --version >"boot.txt" 2>&1
		printf "pi %s boot: %s\n" "${VERSION}" "$(cat boot.txt)"

		PI_BIN="${WORK_DIR}/node_modules/.bin/pi" node_modules/.bin/sumocode --dry-run --mode rpc --offline --no-extensions --no-session >"mode-rpc.txt"
		rg "exec .*node_modules/.bin/pi -e .*src/extension.ts --mode rpc" "mode-rpc.txt" >/dev/null
		PI_BIN="${WORK_DIR}/node_modules/.bin/pi" node_modules/.bin/sumocode --dry-run --offline --no-extensions --no-session --print hello >"print.txt"
		rg "exec .*node_modules/.bin/pi -e .*src/extension.ts .*--print hello" "print.txt" >/dev/null
		if rg "sumo-rpc-host.js" "mode-rpc.txt" "print.txt" >/dev/null; then
			echo "sumocode smoke: direct Pi bypass unexpectedly used the foreground RPC host" >&2
			exit 1
		fi
		echo "sumocode smoke: ${VERSION} direct-Pi bypass dry-runs passed"
	)
done
