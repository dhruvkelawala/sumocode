#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$root"
if [[ $# -eq 0 ]]; then
	printf 'usage: scripts/sandbox/run-sandboxed.sh <cmd...>\n' >&2
	exit 2
fi

node_bin=/Users/sumodeus/.npm/_npx/1c56de6e9acc34f8/node_modules/node/bin
pnpm_cli=/Users/sumodeus/.npm/_npx/2a8f335dab1edcb2/node_modules/pnpm/bin/pnpm.cjs
state="$root/.srt-spike"
srt="$state/tooling/node_modules/@anthropic-ai/sandbox-runtime"
[[ -f "$srt/dist/cli.js" ]] || { printf 'install local srt 0.0.78 first; see plans/120-spike/srt-spike-results.md\n' >&2; exit 2; }
[[ "$("$node_bin/node" -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).version' "$srt/package.json")" == 0.0.78 ]] || { printf 'srt version must be 0.0.78\n' >&2; exit 2; }
mkdir -p "$state"/{bin,tmp,cache,config,npm-cache,compile-cache,agent}
printf '#!/bin/bash\nexec "%s/node" "%s" "$@"\n' "$node_bin" "$pnpm_cli" > "$state/bin/pnpm"
chmod u+x "$state/bin/pnpm"
touch "$state/empty-user.npmrc" "$state/empty-global.npmrc"

# No inherited credentials, provider endpoints, shell hooks, or parent proxies.
# HOME stays unchanged; all writable state is explicitly worktree-owned.
exec env -u SUMOCODE_NATIVE_DIR -u HERDR_ENV -u HERDR_PANE_ID \
	-u VITEST_MAX_WORKERS -u VITEST_MIN_WORKERS LEFTHOOK=0 \
	env -i HOME="$HOME" USER="${USER:-sumodeus}" LOGNAME="${LOGNAME:-sumodeus}" \
	PATH="$state/bin:$node_bin:$state/tooling/node_modules/@oven/bun-darwin-aarch64/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
	SHELL=/bin/bash LANG=en_US.UTF-8 TERM=xterm-256color LEFTHOOK=0 \
	TMPDIR="$state/tmp" CLAUDE_CODE_TMPDIR="$state/tmp" \
	XDG_CACHE_HOME="$state/cache" XDG_CONFIG_HOME="$state/config" \
	npm_config_cache="$state/npm-cache" npm_config_userconfig="$state/empty-user.npmrc" \
	npm_config_globalconfig="$state/empty-global.npmrc" \
	PLAYWRIGHT_BROWSERS_PATH="$state/browsers" NODE_COMPILE_CACHE="$state/compile-cache" \
	PI_CODING_AGENT_DIR="$state/agent" PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 \
	"$node_bin/node" "$srt/dist/cli.js" --settings "$root/scripts/sandbox/srt-tests.json" -- "$@"
