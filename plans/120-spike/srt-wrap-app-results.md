# Spike 2: app-only srt test isolation

**No-go for enabling all heavy lanes on this workstation.** Moving admission, process inspection, runners and Chromium outside srt removes Spike 1's harness/browser blockers. The app-only canaries and cleanup contract pass, and visual CI completes. Source integration still fails; native reaches 106/107 passing tests but cannot start a terminal without a durable Activity writer. No restrictions were relaxed to repair those failures.

## Scope and local setup

Base: `31749d9a`; branch: `sumo/v08-srt-wrap-app`; worktree: `/Users/sumodeus/code/sumocode.sumo-worktrees/sumo__v08-srt-wrap-app`. macOS arm64, Node 24.15.0, pnpm 10.29.2, local **srt 0.0.78**, local **Bun 1.4.0**. Linux/bubblewrap was not tested; opt-in wrapping explicitly refuses non-macOS.

Dependencies were recreated with the frozen lockfile, ignored install scripts and a worktree-local store/cache. srt and pinned Bun live in `.srt-spike/tooling`; Chromium lives in `.srt-spike/browsers`. The local node-pty prebuilt spawn helper was made executable. Setup/downloads and native compilation stayed outside srt. No package dependencies, product source, launcher runtime selection, global configuration or golden files were changed.

Setup commands are recorded in [Spike 1's reproduction section](srt-spike-results.md#reproduction-setup-outside-the-test-sandbox-downloads-only), including the macOS-only `.srt-spike/bin/ps` copy and ad-hoc re-sign (Linux ps is not setuid). The follow-up wrapper prepends that directory to PATH only **inside** srt and sets the explicit `SUMOCODE_TEST_PS_BIN` override there; the trusted runner continues using system ps. Product probes retain `/bin/ps` as their default because Plan 112's process census documented an absolute query. Pi 0.99.1 resolves trust as `getAgentDir()` → `PI_CODING_AGENT_DIR` → `trust.json`, not via XDG config. Run-scoped pipe apps now receive unique owned agent directories with a checkout-only trust fixture; explicit test agent fixtures remain untouched. The srt wrapper also supplies owned agent state to sync launches that omit it, rejects outside agent paths, and never copies private state. These are follow-up changes; the results below remain the original spike's evidence. Do **not** use its `run-sandboxed.sh` around these lanes: that would sandbox the trusted runner again. This spike used an outside recorder with an environment allowlist, owned TMPDIR/cache/offline agent paths and:

```sh
env -u SUMOCODE_NATIVE_DIR -u HERDR_ENV -u HERDR_PANE_ID \
    -u VITEST_MAX_WORKERS -u VITEST_MIN_WORKERS LEFTHOOK=0
```

Node was first on PATH at `/Users/sumodeus/.npm/_npx/1c56de6e9acc34f8/node_modules/node/bin`; pnpm was invoked through `node /Users/sumodeus/.npm/_npx/2a8f335dab1edcb2/node_modules/pnpm/bin/pnpm.cjs`. Bun's local binary directory was also on PATH. HOME was unchanged. Credentials, custom endpoints and inherited proxies were not supplied to the lane runner.

## The seam

One switch: **`SUMOCODE_TEST_SANDBOX=srt`**. Without it, app command, argv and environment are unchanged and the existing supervised launch is used. Unknown modes fail rather than silently running unsandboxed.

[`wrap-app.mjs`](../../scripts/sandbox/wrap-app.mjs) owns local version validation, owned cwd/TMPDIR validation, policy resolution, owner-only per-launch settings and app argv/environment transformation. Its declaration exposes only the explicit-argv synchronous call shapes used here.

- **Pipe apps:** `spawnSupervisedApp` wraps the workload, then uses the existing supervisor. Generic `spawnSupervisedProcess` remains outside for trusted probes/infrastructure.
- **PTY apps:** the existing supervised PTY seam wraps Pi, the retained host and native apps. Admission-only PTY tests explicitly remain outside. Launcher sync/standalone PTY contracts and visual runtime capture use the same helper.
- **Trusted infrastructure:** preflight, Ed25519 admission, PID/birth/HMAC registration, `ps`, cleanup, Vitest, native builds, fake HTTP servers, ANSI replay and Playwright remain outside. The existing admission bootstrap registers first, then execs the app wrapper. Signing keys are still stripped from workloads.
- **Owned paths:** app cwd and temp paths must resolve inside this worktree. Settings are generated under `.srt-spike/settings/app-*` with owner-only access. Native doctor gets an owned diagnostics path only in sandbox-mode tests; no production defaults changed.

The registered PID is now an outer wrapper, not necessarily Pi/the native host. Its PGID remains the cleanup identity. The canary proves wrapper, app and descendant occupy that registered group and disappear on group termination. The native reload test identifies the actual host from the held synthetic child, verifies its command and wrapper PGID using trusted `ps`, then checks all reloads retain that same host parent. It does not replace the registered PID with an invented identity.

### Strict policy and exact fixture ports

[`srt-tests.json`](../../scripts/sandbox/srt-tests.json) retains Spike 1's private read/write restrictions, denies 7749 for both loopback names and IPv6, keeps **`allowLocalBinding: false`**, and grants **no Unix sockets**. Added write denies protect `.srt-spike/tooling` and `.srt-spike/settings`; no filesystem/network/IPC grant was broadened.

The trusted caller passes an explicit list of required fixture ports. Generated `allowedDomains` contains only `127.0.0.1:<port>` and `localhost:<port>`; invalid ports and 7749 are rejected. No inferred port discovery or blanket localhost allowance exists. The committed policy's allowlist remains empty.

App proxy variables are cleared before srt initializes. Inside the sandbox, srt's localhost `NO_PROXY` exemption is cleared and Node receives `NODE_USE_ENV_PROXY=1`. This enables HTTP fixture fetches **through** srt's proxy without enabling direct TCP or local binding. The helper does not independently sanitize every environment variable: callers still own the trusted environment allowlist.

### Narrow path corrections

Darwin AF_UNIX addresses are limited to 104 bytes. Two independent path problems initially prevented launch:

1. srt's own proxy socket exceeded the limit with a nested harness TMPDIR. Only the outside srt process uses short worktree-local `.srt-spike` TMPDIR; `CLAUDE_CODE_TMPDIR` restores the run-owned temp path inside the app.
2. Admission sockets must remain worktree-owned in opt-in mode. The trusted server binds a relative address; the bootstrap connects by basename after temporarily changing cwd, restoring the original cwd on connection before workload execution. The bootstrap uses this connection technique even when a trusted probe's child environment omits the switch. Default socket placement and workload cwd remain unchanged. The forged-endpoint test uses relative binding too.

Neither correction required a socket grant, `/private/tmp` write allowance or process-inspection bypass.

## Canary and focused contract evidence

Final focused command, run **outside** srt with the switch set:

```sh
pnpm exec vitest run test/integration/app-sandbox.test.ts \
  test/integration/harness-admission.test.ts test/integration/spawn-pi-pty.test.ts \
  scripts/sandbox/wrap-app.test.mjs --fileParallelism=false
```

**Exit 0; 13.105 s; 79 tests passed across four files.** Focused audits report zero survivors, including the 51-group PTY contract set. The outside recorder observed 49 processes and found no leftovers.

[`app-canary.mjs`](../../scripts/sandbox/app-canary.mjs) emits statuses, never private contents. Private probes only open/close file descriptors; the write probe does not create, truncate or write bytes.

- **Private reads denied:** `.pi/agent/settings.json`, `.config/sumocode/settings.json`, `.sumocode`, `.ssh`, `.npmrc`, `Library/Keychains`; descendant private-read denial also passes. **`.aws` is absent: denial not proved.** Directory opens do not prove protection of every contained file or keychain API.
- **Outside write-open denied; direct daemon 7749 connect denied** with EPERM/EACCES, not merely a refused connection. No application bytes were sent to the daemon.
- **External HTTP denied:** curl observes the explicit blocked-by-allowlist proxy header. Node 24 fetch collapses the refused CONNECT to `Request was cancelled.` with cause code 0; the final canary accepts only that specific cancellation, not arbitrary errors/timeouts. Curl supplies the independent explicit denial evidence.
- **Exact allowed fixture fetch succeeds** through the proxy for both `127.0.0.1` and `localhost`; binding a TCP server inside the app remains denied. The HTTP fixture server stays outside srt.
- **Literal argv/exit/group contracts pass:** spaces, shell-looking text and Unicode survive; exit 23 propagates; wrapper/app/descendant share the registered PGID and group cleanup succeeds. Disabled-mode and unknown-mode checks pass.

## Complete lane results

Times are recorder wall seconds, including its one-second post-exit observation. These commands did not wrap the whole runner; only the named app seams opted into srt.

| Command | Exit | Seconds | Result |
| --- | ---: | ---: | --- |
| `pnpm test:integration`, initial | 1 | 403.642 | 27 failed tests; authenticated final audit: zero survivors. |
| `pnpm test:integration`, last complete run | 1 | 370.767 | 323 passed / 26 failed / 108 skipped; 40 files passed / 6 failed / 2 skipped. Audit: zero survivors across 166 groups. |
| `pnpm test:native`, attempts 1 / 2 | 1 / 1 | 6.151 / 5.244 | Native build succeeded; preflight refused another worktree's live processes. They were not killed. |
| `pnpm test:native`, attempt 3 | 1 | 62.283 | 104/107 passed; doctor path, terminal lifecycle and wrapper-vs-host PID assertions failed. |
| `pnpm test:native`, final | 1 | 66.715 | **106/107 passed** after test-only path/PID corrections; terminal lifecycle still fails. Audit: zero survivors across 21 groups. |
| `pnpm render:bible` | 0 | 83.968 | Generated required review assets locally; no golden promotion. |
| `pnpm visual:ci` | 0 | 136.704 | **41 scenarios**, including six real-runtime scenarios; no observed leftovers. |
| `pnpm test` | 1 | 117.097 | Trusted runner outside srt: 4,343 passed / 10 failed, 248 files passed / 7 failed. |
| Final `pnpm exec tsc --noEmit && pnpm build && pnpm lint` | 0 | 4.500 | Passed after final code/declaration changes; existing lint warnings remain. `git diff --check` also passes. |

Visual exit 0 means the configured CI gate passed, **not** universal visual parity/approval. Runtime splash is `passed`; the other five runtime scenarios are `review`. The reviewed active-landscape geometry report passes; splash's Bible styled-cell report still records differences across all 45 rows. Review HTML/PNGs, masks, cell reports and geometry reports are under `docs/visual/out/parity/`. No human approval or golden promotion is claimed.

### Failure classification

The last complete integration run's 26 failures split as follows:

| Group | Count | Classification / evidence |
| --- | ---: | --- |
| Direct bash + native-image RPC prompts | 3 | **Confirmed sandbox denial:** EACCES for protected `~/.config/pi/trust.json`. No private trust-file exception added. |
| Terminal-completion recovery + retained subagent production retention | 10 + 2 | **Sandbox-dependent process-identity paths; causal attribution incomplete per assertion.** Terminal tasks do not acquire the expected fixture markers; retained children remain starting. Product code invokes protected `ps` for process births/retained identity. Harness inspection is outside, but moving product inspection outside would exceed this spike's seam. |
| Retained RPC host-shell contracts | 10 | **Unresolved fixture/runtime failures**, not all established sandbox denials. One retained stderr shows `require is not defined in ES module scope`; held pre-spawn/adoption markers time out. Wrapper PID/process-tree assumptions also need care. No product fix or speculative policy grant added. |
| RPC durable Activity-card UI | 1 | **Unresolved screen timeout.** Compatible with missing Activity writer, but not independently proved to have that cause. |

The remaining native failure is explicit: `terminal_start result did not contain an id: activity unavailable: this session has no active durable Activity feed writer`. `src/activity/manager-bridge.ts` derives its writer identity through `captureProcessBirthTime`; `src/background-tasks/process-tree.ts` invokes `ps`. Spike 1 established that this Mac's root-setuid `ps` fails under srt. This is a concrete sandbox/product compatibility blocker, **not** a failure of outside harness admission or its audit. No fabricated birth identity, writer grant or process-inspection bypass was introduced.

The unit suite is **not sandboxed**, so its failures are not srt permission-denial results: four startup-comparison assertions encounter inside-checkout output restrictions / Node 24 encoded-backslash behavior; `resolveGitBranch` expects a non-repository temp directory but owned TMPDIR is inside this repository; five task/store/worktree/retained tests fail timing or bounds assertions. Their underlying product-versus-resource cause remains unproved. No unrelated product regressions were declared fixed.

Setup/verification corrections were confined to the seam: initial socket launch failures, the forged socket test, owned doctor diagnostics and the actual-host reload assertion. An initial lint run found two new-test violations; boundary/safety comments resolved them. These are not evidence that broad sandbox grants are needed.

### Supplementary attempts, including an interrupted run

The first five canary attempts exited 1 in 2.439 / 2.963 / 2.115 / 1.782 / 1.852 s while the socket paths were being corrected; `canaries-6` exited 0 in 2.101 s. The earlier four-file focused run also passed 79 tests in 13.236 s.

A later supplementary invocation incorrectly passed test-selection argv to `run-integration-harness.mjs`, which does **not** support that selection. It therefore started the full lane and exceeded the tool's 180-second timeout. The recorder/outer runner ended; its detached Vitest continued and eventually printed 322 passed / 27 failed / 108 skipped. The additional failure was an overly specific external-fetch error-message matcher, not permitted egress. Node 24 reports cancellation rather than a 403-containing message; the final focused run verifies the corrected narrow matcher.

That interrupted invocation has **no complete recorder timing/exit record and no authenticated final harness audit**. It is not counted as a successful audited run. Earlier stale `seam-final` sidecars were preserved under `seam-final-earlier.*`, not paired with the overwritten log. A subsequent outside ancestry/birth observer saw the remaining owned Vitest descendants finish naturally and recorded **zero survivors** in `seam-final-timeout-observation.json`. No manual process signals were needed. Complete integration/native/visual lanes were not rerun after the final canary matcher change; the final focused run and type/build/lint checks were.

## Ownership, evidence and leftovers

Local ignored evidence: `.srt-spike/logs/<lane>.log`, `.result.json` and `.processes.json`. The outside recorder samples descendant PID/parent/PGID/birth identity every 300 ms, then checks observed identities and new worktree-path candidates. Sampling is observational and can miss fast reparenting/title-hidden processes; it is not a macOS PID namespace.

- **Complete integration:** `.srt-spike/tmp/sumocode-harness-v2-run-SzPVim`; 556 observed processes; authenticated audit zero survivors across 166 groups; recorder also finds none. Earlier evidence remains at `sumocode-harness-v2-run-vNmCE8`.
- **Final native:** `.srt-spike/tmp/sumocode-harness-v2-run-K3Zlgm`; 137 observed processes; authenticated audit zero survivors across 21 groups; recorder also finds none. Attempt-3 evidence remains at `sumocode-harness-v2-run-zlvrjM`.
- **Visual and unit:** 205 / 497 observed processes respectively; no observed owned survivors or new worktree-path candidates after completion. Short synchronous app launches and visual PTYs retain their existing lifecycle rather than gaining separate admission; no hostile daemonization cleanup proof is claimed for them.
- **Concurrent metadata checks:** initial type/build checks saw worktree path candidates from overlapping owned verification. These were not their descendant survivors and were not killed. Later serial gate checks find none. Foreign-worktree preflight poison was left untouched; no `--fix`, purge or unrelated-process cleanup was performed.
- **Final inventory:** `final-leftovers.json` checks recorded birth identities plus worktree command paths. The final refresh after all verification reports zero observed owned survivors and zero worktree-path candidates. Evidence/temp directories intentionally remain local; they are not live processes.

## Decision and limits

**Go:** keep the app-only seam as an opt-in experiment. Trusted harness inspection/admission and Chromium work outside srt; explicit proxy HTTP fixture access, private-path/7749 denial and registered-group cleanup are demonstrated.

**No-go:** enable it as the default or claim all heavy suites are sandbox-compatible. Product process-birth inspection and private Pi trust access remain blockers; unresolved host/Activity failures and the non-green trusted unit suite also prevent a production-readiness claim.

This is an accident fence for trusted checkout tests, not a reviewed hostile-code boundary. Linux, daemon aliases/IPv6 transports, Unix-socket daemon access, keychain/XPC APIs, exhaustive filesystem/symlink bypasses, ungranted-port live-server negative coverage, resource exhaustion and forced-crash/SIGKILL cleanup are not proved. Do not infer those guarantees from the positive HTTP fixture or private directory-open checks.

## Review-ready gate

**Contract:** `/Users/sumodeus/.pi/agent/skills/review-ready/contract.md` (bundled default; no repository override found).

**Changed seam / trace:** test app launch → optional `wrapTestApp` → explicit local policy/proxy setup → existing trusted admission and registration → sandboxed app/descendants → original supervisor/group cleanup. Visual/sync paths retain their existing lifecycle. No runtime product branch was added.

### Caller-knowledge

Callers identify app versus trusted infrastructure and supply only owned paths/environment and explicit required HTTP fixture ports. They do not know srt settings layout, shell quoting, proxy initialization or Darwin socket workarounds.

### Deletion

Removing the helper would duplicate version/path/policy/proxy transformation across pipe, PTY, native and visual launch sites. Existing lifecycle/admission remains owned by the harness, not reimplemented in the helper.

### Ownership

Sandbox policy/transformation belongs under `scripts/sandbox`; admission/PID/auth belongs to the existing integration harness; application code is unchanged. The additional adapters represent actual sync/PTY/pipe call boundaries, not speculative provider abstractions.

### Test-surface

Actual supervised apps exercise private denial, HTTP proxy use, local-binding denial, admission, real PID/group membership and termination. Shared-helper tests cover opt-out/invalid mode, declarative port policy, owned paths and literal argv/exit behavior. The declaration was narrowed to the call shapes the adapters actually implement.

**Simplification pass:** one opt-in switch and one transformation; no global spawn interception, environment-derived port discovery, package dependency changes, extra policy grants or product identity shims. Only test expectations that confused wrapper with host or used an outside diagnostics path were corrected.

**Verification:** final focused 79 tests pass; final typecheck/build/lint and whitespace checks pass. Full integration/native/unit failures, visual review statuses and the interrupted supplemental invocation are reported above.

**Exceptions:** intentionally a workstation-specific no-go spike, locally committed without a PR. Whole-lane green status and exhaustive security/cleanup proof are not satisfied; this report completes the experiment, not the production-adoption gate. No publishing, default enablement or policy loosening is authorized by these results.
