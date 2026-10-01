# srt test-lane spike: no-go for drop-in heavy lanes on this Mac

**Recommendation:** do not enable `allowLocalBinding` on the owner's workstation. Strict srt protects the tested private files and live Remnic TCP endpoint, but cannot run the existing heavy lanes unchanged. Keep this wrapper experimental; use disposable, secret-free CI runners for heavy tests.

## Environment and scope

- Branch `sumo/v08-srt-spike`; source version 0.7.6. Host reports macOS 27.0 / 26A428, arm64 (host clock: 2026-10-01).
- npm latest resolved to **`@anthropic-ai/sandbox-runtime@0.0.78`**, installed under `.srt-spike/tooling`, not globally. Both its packaged README and upstream README were read. [Upstream](https://github.com/anthropics/sandbox-runtime), [versioned package](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime/v/0.0.78).
- Node **24.15.0** and pnpm **10.29.2**, at the exact npx paths requested. System Bun was 1.4.2; native retry used locally installed **`@oven/bun-darwin-aarch64@1.4.0`**, matching `.bun-version`.
- Repository dependencies installed with `--frozen-lockfile --ignore-scripts` and a worktree-local pnpm store. Playwright 1.59.1 Chromium/headless-shell revision 1217 installed into `.srt-spike/browsers`; node-pty's local prebuilt helper received `chmod u+x`, as in the release workflow. No install scripts, global installs, HOME changes, git-config changes, paid-provider requests, or product-code fixes.
- Read the two context documents **from `/Users/sumodeus/code/sumocode/plans/120-spike/`**, not from another installed copy. Read this checkout's agent/dev instructions, lane entry points, PTY admission, visual contract, and native builder.

## Final policy and wrapper

[`scripts/sandbox/srt-tests.json`](../../scripts/sandbox/srt-tests.json) is the authoritative final policy:

- Read-deny `/Users` and `/Volumes`, with readable carve-outs only for this checkout and the two specified Node/pnpm tool directories. Explicit private-path denies include `~/.pi`, all `~/.config` (including sumocode/gh), `~/.sumocode`, SSH/AWS/npm/netrc/GPG/Kubernetes/Docker/Claude/Codex state, and `~/Library/Keychains`. This also fences private config symlink targets elsewhere under `/Users` or `/Volumes`.
- Write-allow only `.` (including local caches, dependencies, build output, and temp files). Deny `/tmp`, `/private/tmp`, home npm/Claude paths, `.git`, and `scripts/sandbox`. This overrides srt's implicit `/tmp/claude` write allowance. Device/stdio access and PTYs remain srt's necessary exceptions.
- `allowedDomains: []`; deny `127.0.0.1:7749`, `localhost:7749`, `[::1]:7749`; `allowLocalBinding: false`; no Unix socket grants. PTYs enabled. Apple Events and weaker isolation disabled.

[`scripts/sandbox/run-sandboxed.sh`](../../scripts/sandbox/run-sandboxed.sh) anchors cwd to this checkout, requires local srt 0.0.78, passes `--settings` explicitly, preserves argv/exit status, and never downloads tools at test time. It uses the requested `env -u SUMOCODE_NATIVE_DIR -u HERDR_ENV -u HERDR_PANE_ID -u VITEST_MAX_WORKERS -u VITEST_MIN_WORKERS LEFTHOOK=0`, followed by an environment allowlist. Credentials, custom provider endpoints, shell hooks, parent proxies, and other inherited runtime variables are absent. HOME is unchanged; Pi gets an owned offline agent directory.

**Important adjustment:** srt overrides `TMPDIR` to `/tmp/claude` even when the caller sets it. Setting **`CLAUDE_CODE_TMPDIR`** as well as `TMPDIR` keeps the child temp directory inside this checkout. An initial synthetic temp-write probe failed before this correction; it passed afterwards. No outside file was created.

### Reproduction setup (outside the test sandbox; downloads only)

Run from this checkout, using the Node/pnpm paths embedded in the wrapper:

```bash
mkdir -p .srt-spike/{tmp,npm-cache,cache,config,tooling,bin}
touch .srt-spike/empty-user.npmrc .srt-spike/empty-global.npmrc
export PATH="/Users/sumodeus/.npm/_npx/1c56de6e9acc34f8/node_modules/node/bin:$PATH"
export TMPDIR="$PWD/.srt-spike/tmp" XDG_CACHE_HOME="$PWD/.srt-spike/cache"
export XDG_CONFIG_HOME="$PWD/.srt-spike/config" npm_config_cache="$PWD/.srt-spike/npm-cache"
export npm_config_userconfig="$PWD/.srt-spike/empty-user.npmrc"
export npm_config_globalconfig="$PWD/.srt-spike/empty-global.npmrc"
node /Users/sumodeus/.npm/_npx/2a8f335dab1edcb2/node_modules/pnpm/bin/pnpm.cjs install \
  --frozen-lockfile --ignore-scripts --store-dir "$PWD/.srt-spike/pnpm-store"
npm install --prefix "$PWD/.srt-spike/tooling" --ignore-scripts --no-audit --no-fund \
  @anthropic-ai/sandbox-runtime@0.0.78 @oven/bun-darwin-aarch64@1.4.0
chmod u+x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
# macOS only: Seatbelt refuses root-setuid /bin/ps. Copy drops setuid;
# ad-hoc re-signing is required or macOS kills the modified executable.
if [ "$(uname -s)" = Darwin ]; then
  cp /bin/ps .srt-spike/bin/ps
  codesign -s - -f .srt-spike/bin/ps
fi
PLAYWRIGHT_BROWSERS_PATH="$PWD/.srt-spike/browsers" node node_modules/playwright/cli.js install chromium
scripts/sandbox/run-sandboxed.sh node scripts/sandbox/canary.mjs
scripts/sandbox/run-sandboxed.sh pnpm test
```

No `~/.srt-settings.json` was created or used. Paths in the settings/wrapper are intentionally workstation-specific, not a portable CI integration.

## Canary results

[`scripts/sandbox/canary.mjs`](../../scripts/sandbox/canary.mjs) emits only statuses/booleans; exit 0 requires private reads/write-open and external HTTP to be denied, and the daemon connect to be blocked. It never prints file contents. The single outside baseline used `--baseline`: TCP connect/disconnect only, **CONNECTED**, so port 7749 was live. All daemon probes sent **zero application bytes**.

| Probe | Strict/final | Per-port fixture allow | Local binding enabled |
| --- | --- | --- | --- |
| Read `~/.pi/agent/settings.json` | READ_DENIED | READ_DENIED | READ_DENIED |
| Read `~/.config/sumocode/settings.json` | READ_DENIED | READ_DENIED | READ_DENIED |
| Outside write-open | WRITE_DENIED | WRITE_DENIED | WRITE_DENIED |
| Direct TCP `127.0.0.1:7749` | BLOCKED | BLOCKED | **CONNECTED** |
| External HTTP via srt proxy | denied | denied | denied |
| HTTP to owned fixture through proxy | not probed | succeeded | denied |
| Direct TCP to owned fixture | not probed | BLOCKED | CONNECTED |
| Bind own ephemeral TCP server | denied | denied | succeeded; self-connect succeeded |
| Canary exit | 0 | 0 | **1** |

The write probe opens the **existing** config file `O_WRONLY`, without create/truncate or writing bytes; even a broken policy cannot mutate private state during this test. It proves write-open denial, not an exhaustive write/rename/hard-link audit. Additional synthetic checks: owned agent/temp writes succeeded, descendant-process private read was denied, direct external HTTP was denied, argv with spaces/shell metacharacters survived, exit 23 propagated, no-args wrapper exited 2.

### Local fixtures versus 7749

An owned HTTP server on **127.0.0.1:38471** ran outside srt. Temporarily allowing only `127.0.0.1:38471` and `localhost:38471` let `curl --noproxy ''` reach it **through the proxy**, while direct Node TCP to that port and to 7749 stayed blocked. Binding a server inside srt still failed. Therefore a domain `:port` allowance is **not** a Seatbelt direct-TCP/bind allowance; current direct Node fake-provider/MCP servers cannot just use it unchanged.

With `allowedDomains: []` and the same explicit 7749 deny entries, **`allowLocalBinding: true` admitted direct TCP to the real daemon**. The domain denylist only governs proxy traffic; the generated macOS profile grants `(allow network-outbound (remote ip "localhost:*"))`. This mode was used only for connect-only canaries, **never a test lane**, then reverted. It also permits wildcard bind/inbound, not only loopback bind. No permissive fixture setting remains committed.

## Lane results

Wall times include wrapper startup. Every full lane was attempted once initially; native was retried only after correcting the local Bun setup. No heavy lane was run unsandboxed.

| Command | Exit | Seconds | Finding / adjustment |
| --- | ---: | ---: | --- |
| `pnpm test` | 1 | 109.080 | 231 files / 4,241 tests passed; 23 files / 110 tests failed; one unhandled rejection. Mixed failures described below. |
| `pnpm test:integration` | 1 | 0.399 | Preflight refused `spawnSync ps EPERM`; no seam/PTY tests or harness final audit executed. Harness has no representative-file selection option, so full command was attempted. |
| `pnpm visual:ci` | 1 | 0.638 | Checkout's generated Bible renders directory was empty: 30 required PNG paths absent. Real setup/asset failure, not evidence of sandbox-denied PNG reads. Stopped as requested. |
| `pnpm test:native`, system Bun | 1 | 0.473 | Setup failure: pinned 1.4.0 versus system 1.4.2. Installed pin locally, no source pin change. |
| `pnpm test:native`, local Bun 1.4.0 | 1 | 5.863 | Native archive built and ad-hoc signing/verification succeeded; native contract preflight then refused `ps EPERM`. No native contract tests executed. |
| `pnpm build:native`, explicit confirmation | 0 | 3.758 | Full native archive built under strict policy. |
| Compiled host/Pi `--version` | 0 | 1.341 | Both executables launched; versions 0.7.6 / 0.99.1. Not a native interaction-contract substitute. |
| Playwright synthetic screenshot probe | 1 | 1.238 | Chromium SIGTRAP: Mach rendezvous `bootstrap_check_in` permission denied. Already launched with Playwright's default `--no-sandbox`. |
| Same Chromium probe, narrow Mach lookup grant | 1 | 0.362 | `org.chromium.Chromium.MachPortRendezvousServer.*` lookup grant did not fix registration denial; grant reverted. No screenshot produced. |
| `pnpm exec tsc --noEmit` | 0 | 5.664 | Passed. |
| `pnpm build` | 0 | 1.688 | Passed. |
| `pnpm lint` | 0 | 1.401 | Passed. |

**Unit sandbox causes:** global `.gitconfig` read denial; srt's mandatory write denies for synthetic `.mcp.json`; real private accounts-config lookup denial; blocked process-birth inspection causing feed/registry/retained-supervisor assertions to fail. No private read exceptions were added. A configurable write allow cannot override the mandatory `.mcp.json` protection. HOME/git config were not changed to make Git tests pass.

**Other unit findings:** temporary output under this checkout conflicts with startup-comparison's “out must be outside compared checkout” contract; Node 24 rejects an encoded-backslash module entrypoint. The unit run preceded local Bun installation and included its version mismatch. Bounds/timing assertions without explicit permission errors remain **unclassified**, not claimed to be product regressions: no unsafe unsandboxed control suite was run and no product code was fixed.

**Integration/native limitation:** `/bin/ps` is root-setuid on this host; invoking it under srt fails even for a single PID. The published settings expose no process-inspection grant that repairs this. Do not bypass preflight or counterfeit process-birth identity. If addressed upstream, the next known source-level obstacle is `test/integration/harness-admission.ts`: it hardcodes writable `/private/tmp/sumo-admit-*` and Unix sockets outside the allowed worktree. Neither was opened up in this spike.

**Visual limitation:** no `render:bible`, golden promotion, or product visual edits were used to repair the missing assets. The separate minimal Chromium probe reached the browser and proved an additional sandbox blocker. A Mach **lookup** option is not Mach **registration** permission; broad IPC/Apple Events grants were not attempted.

## Process ownership and leftovers

An outside, worktree-owned recorder sampled descendant PID/parent/group/birth identities every 500 ms and ran a filtered `ps` check after **each** lane/probe. Local `.srt-spike/logs/*.result.json` records exit/time and survivor candidates; corresponding `.log` files retain diagnostics. These ignored artifacts are local evidence, not committed generated files.

- **Zero observed owned survivors after every recorded command**, including unit, integration, visual, both native attempts, native build/smoke, Chromium attempts, typecheck/build/lint.
- Some checks saw unrelated integration-harness markers appear during the run, rooted under another `/var/folders/...` harness and outside this recorder's lineage. They were not labelled our leftovers or signalled. This workstation was not globally idle.
- Only the owned fixture-server PID was manually sent SIGTERM; confirmed absent afterwards. No foreign PID/process group was killed, no harness `--fix`/purge was run.
- This is an observed cleanup check, **not** the integration harness's authenticated zero-survivor proof: preflight prevented that audit from running. Sampling can miss short-lived reparenting/title-hidden survivors. macOS srt is not a PID-namespace/process-tree cleanup backstop.

## Decision and remaining gaps

**No-go for wrapping all heavy lanes unchanged on this always-on Mac.** Strict isolation is useful for light checks and the native build, but do not market it as a validated heavy-test wrapper. The decisive incompatibilities are direct local fixtures versus live 7749 isolation, process inspection needed for safe harness admission/cleanup, mandatory protected fixture filenames, and Chromium Mach registration.

Keep heavy lanes on disposable, secret-free runners. A future local adoption needs upstream narrow bind/egress exclusions plus compatible process inspection/Chromium IPC, or a disposable macOS environment; rerun canaries before claiming safety. Linux/bubblewrap on `ubuntu-latest`, IPv6/localhost/LAN aliases of the daemon, Unix-socket daemon transports, keychain/XPC APIs, exhaustive filesystem bypasses, resource exhaustion, malicious test-policy/tool tampering, and crash/SIGKILL cleanup were **not proved** here. The wrapper is an accident fence around trusted checkout tests, not a reviewed hostile-code boundary.

### Review-ready gate

- Contract: `/Users/sumodeus/.pi/agent/skills/review-ready/contract.md` (bundled default).
- Changed seam / trace: `run-sandboxed.sh <argv>` → anchored cwd / local pinned runtime / clean environment → explicit settings → inherited OS restrictions → original exit status. Policy and executable canary live together under `scripts/sandbox`.
- Four tests: caller-knowledge (local setup documented); deletion (otherwise policy/env work spreads to every lane); ownership (one settings file, one wrapper); test-surface (real CLI canaries, not mocked settings assertions).
- Simplification: no product hooks, package dependencies/scripts, policy generator, CI integration, or custom sandbox implementation. Rejected permissive experiments were reverted.
- Verification: final combined `pnpm exec tsc --noEmit && pnpm build && pnpm lint && node scripts/sandbox/canary.mjs` exited 0 in 4.269 s, with zero observed owned survivors; argv/exit/usage checks and Bash syntax passed; full lane failures and gaps reported above.
- Exceptions: this is intentionally a workstation-specific, **no-go spike**, not production integration; heavy-suite green status and exhaustive cleanup/security proof are not claimed.
