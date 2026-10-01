# App-only srt fixes: process inspection and owned Pi trust

**No-go for making `SUMOCODE_TEST_SANDBOX=srt` the general documented local way to run heavy lanes on this Mac.** Native contracts now pass **107/107**, the focused contract passes **81/81**, and visual CI passes. Source integration still has **13 failures**: **3 sandbox-caused** and **10 reproduced without srt**. The trusted unit suite has 10 setup/timing failures. Keep the switch an opt-in experiment, not a green-suite or security guarantee.

## Scope, setup and tradeoffs

Base: `7a1066b4` (`sumo/v08-srt-wrap-app`); execution branch: `sumo/v08-srt-fixes`. Worktree: `/Users/sumodeus/code/sumocode.sumo-worktrees/sumo__v08-srt-fixes`. macOS arm64 **27.0 / 26A428**, Node **24.15.0**, pnpm **10.29.2**, local Bun **1.4.0**, local srt **0.0.78**. No push, PR, merge, global install/config, policy change or golden promotion.

Dependencies/tools/browser were recreated using [Spike 1's local reproduction commands](srt-spike-results.md#reproduction-setup-outside-the-test-sandbox-downloads-only), including frozen dependencies, ignored install scripts, local store/npm/cache and Playwright Chromium. The macOS setup now includes:

```sh
mkdir -p .srt-spike/bin
if [ "$(uname -s)" = Darwin ]; then
  cp /bin/ps .srt-spike/bin/ps
  codesign -s - -f .srt-spike/bin/ps
fi
```

Linux ps is not setuid; the app-only seam still explicitly refuses unverified non-macOS operation. Copying drops setuid, but re-signing is essential: the coordinator's unsigned-copy probe was killed. This run independently confirms system `/bin/ps` is still refused under the unchanged policy: **exit 126**, `env: /bin/ps: Operation not permitted` (`root-ps.log`). Both PATH `ps` and the explicit copied binary pass single-PID, full census and own-command probes inside srt.

### Product ps selection — `10fb502c`

`resolvePsBinary` centralizes **all seven product ps call sites**, including the two additional visible-wrapper probes found during the caller inventory. Defaults remain absolute `/bin/ps`; an explicit absolute `SUMOCODE_TEST_PS_BIN` is the sole override. Windows PowerShell/taskkill paths, identity comparisons, unknown/fail-closed results and signalling authority are unchanged. The embedded retained anchor receives a JSON-escaped binary chosen through the same helper; shell wrappers shell-escape it.

History checked: `git blame` and introducing commits **`b8306ceb`** (census), **`e2007c17`** (retained anchor), **`26534ba2`** (visible gate), plus Plan 112. Plan 112 explicitly documents a bounded **absolute `/bin/ps` query**; the anchor/gate commits introduced trusted executable/launch boundaries. No commit message explicitly attributes the path to a PATH-spoofing incident. Tradeoff: preserve the documented absolute ownership-probe boundary conservatively, rather than silently broaden it to PATH. The older three PATH probes now use that same default. A focused helper test covers the default, a path containing spaces and refusal of relative/empty overrides.

### Wrapper and trust fixture — `c22b012f`

The wrapper prepends `.srt-spike/bin` to PATH and sets `SUMOCODE_TEST_PS_BIN` **only in the inner `/usr/bin/env`, after srt enters Seatbelt**. Its own environment/PATH and the trusted runner's ps are unchanged. The copy must be a regular executable without setuid/setgid. Disabled wrapping still returns the original command/argv/environment.

Installed checkout-local Pi **0.99.1** resolves trust through:

```txt
dist/main.js: getAgentDir() → new ProjectTrustStore(agentDir)
dist/config.js: PI_CODING_AGENT_DIR, otherwise ~/.pi/agent
dist/core/trust-manager.js: join(resolvePath(agentDir), "trust.json")
```

**XDG_CONFIG_HOME does not select Pi's trust store.** The earlier spike's `~/.config/pi/trust.json` error was a private agent-location symptom, not a reason to allow `~/.config`. No private file contents were inspected or copied.

`buildSpawnEnv` now supplies each run-scoped app lacking an explicit fixture with a unique private agent directory under the run's owned temp root. `trust.json` is 0600 and approves only the canonical current test cwd; the directory is 0700. The run owns cleanup/retention. Explicit per-test fixtures are preserved, including their trust decisions. The srt wrapper supplies the same fixture for sync/standalone launches that omit an agent path and refuses outside agent paths. Explicit future agent leaves are validated through their nearest existing canonical ancestor without creating them; Pi may create them inside the fence. PTY-specific lifetime cleanup remains unchanged.

Tradeoff: tests of SumoCode behavior trust their owned checkout, not arbitrary ancestors or developer config. This is not a test of Pi's interactive trust prompt. Run-owned state may remain as retained failure evidence. The three installed-Pi direct-bash/image prompt tests now pass; no trust-file exception was added.

## Verification method

Heavy lanes ran **one at a time**, with Vitest, harness/admission, ps, builds, Chromium and HTTP fixtures outside srt. Only app seams were wrapped. Node was first on PATH at `/Users/sumodeus/.npm/_npx/1c56de6e9acc34f8/node_modules/node/bin`; pnpm was invoked through `node /Users/sumodeus/.npm/_npx/2a8f335dab1edcb2/node_modules/pnpm/bin/pnpm.cjs`. A local pnpm shim supports nested package scripts; the copied ps directory is **not** on runner PATH.

Every recorded invocation used the requested prefix:

```sh
env -u SUMOCODE_NATIVE_DIR -u HERDR_ENV -u HERDR_PANE_ID \
    -u VITEST_MAX_WORKERS -u VITEST_MIN_WORKERS LEFTHOOK=0
```

The ignored outside recorder `.srt-spike/record.mjs` launches with a benign environment allowlist, unchanged HOME, owned TMPDIR/cache/offline agent paths and `SUMOCODE_TEST_SANDBOX=srt`. Credentials, inherited proxies/endpoints, preload flags and shell hooks are not supplied. Each lane gets a fresh temp namespace. Times below include a one-second post-exit observation. Logs and exit/timing/process sidecars live at `.srt-spike/logs/<lane>.{log,result.json,processes.json}`.

## Final lane results

| Lane / evidence stem | Exit | Wall seconds | Counts / result |
| --- | ---: | ---: | --- |
| App canaries / `canaries` | 0 | 2.370 | 1 test; private reads, descendant read, outside write, daemon 7749, external HTTP/fetch, exact fixture fetches, denied local bind and group cleanup pass. `.aws` absent: denial not proved. |
| Four-file focused suite / `focused-final` | 0 | 12.994 | **81 passed / 4 files**; real ps and installed-Pi trust fixture checks included. |
| `pnpm test:integration` / `integration-final` | 1 | 278.966 | Seam **83/83**; integration **337 passed / 13 failed / 108 skipped**, **43 files passed / 3 failed / 2 skipped**. Authenticated audit: **0 survivors / 173 groups**. |
| `pnpm test:native` / `native-final` | 0 | 36.913 | Build/sign/verify succeeds; **107 passed / 1 file**. Authenticated audit: **0 survivors / 21 groups**. |
| `pnpm render:bible` / `bible` | 0 | 81.741 | Local Bible assets regenerated; 109 PNGs present. No tracked Bible/golden changes. |
| `pnpm visual:ci` / `visual` | 0 | 97.994 | **41 scenarios**, including **6 real-runtime** captures; configured required-crop gates pass. |
| `pnpm test` / `unit` | 1 | 105.575 | **4,345 passed / 10 failed**, **249 files passed / 7 failed**. Failed tests run in the trusted runner, not inside srt. |
| `pnpm exec tsc --noEmit` / `types` | 0 | 2.588 | Pass. |
| `pnpm build` / `build` | 0 | 2.173 | Pass. |
| `pnpm lint` / `lint` | 0 | 2.341 | 0 errors; 4 pre-existing unused-symbol warnings in `scratch/tui-audit/proto/gen.mjs`. |

Focused command:

```sh
pnpm exec vitest run test/integration/app-sandbox.test.ts \
  test/integration/harness-admission.test.ts test/integration/spawn-pi-pty.test.ts \
  scripts/sandbox/wrap-app.test.mjs --fileParallelism=false
```

Before the product commit, the six-file product/process/anchor/backend/Activity check passed **132 tests** in **4.560 s**; typecheck/build passed in **6.243 / 2.204 s**. `git diff --check` passes. No heavy lane was interrupted or timed out at the outer recorder.

Visual evidence: `docs/visual/out/parity/results.json`, `index.html`, per-scenario raw cell/geometry reports and PNGs. All six runtime geometry audits pass. Splash is `passed`; the other five runtime results are `review`, **not universal parity approval**. Bible styled-cell differences remain (45 rows for splash/active landscape; 100 for active portrait). Active-landscape cell/geometry reports were inspected before its runtime PNG; submitted prompt, active provider text, editor and footer are present. No human acceptance or golden promotion is claimed.

## Remaining failure classification

Only the **three failing integration files** were run without srt, as authorized; the full integration/native/visual lanes were never run unsandboxed. Controls retained owned temporary agent fixtures. The supplied baseline is Ubuntu integration green at `109a7690`; this run does not claim a new Linux verification or infer that every local failure is intrinsic to macOS.

| Remaining group | Count | Classification and evidence |
| --- | ---: | --- |
| `rpc-host-shell.test.ts` | 10 | **Real local macOS/runtime-fixture failures, not sandbox-caused.** The exact same 10 tests fail with the switch unset: **29 passed / 10 failed**, exit 1, **83.797 s**, `control-host.log`; focused audit **0 survivors / 39 groups**. Missing PID/git-started markers and one child-exit-before-altscreen failure remain. No permission denial established. OS-only/root-cause attribution is not proved. |
| `subagent-production-retention.test.ts` | 2 | **Sandbox-caused identity-contract incompatibility, not a ps permission denial or timing flake.** Unset-switch control: **2/2 pass**, exit 0, **17.984 s**, `control-retention-final.log`; audit **0 survivors / 4 groups**. Bounded diagnostic: inner owner **PID 98381 / PGID 98372**, `verified:false`, then `retained_entry_failed`. Entry constructs PGID from its own PID, whereas srt retains the registered wrapper group; `captureTreeVerification` correctly refuses it. Parent admission also expects owner.pid to equal the recorded supervisor PID. No fake identity or product authority change made. |
| Busy-owner wake case in `terminal-completion-recovery.test.ts` | 1 | **Confirmed sandbox signalling denial.** Owned `markers/index-diagnostics.jsonl` repeats `natural completion tree disposition unproven; refusing settlement: kill EPERM`; no settlement is fabricated. Unset-switch control: **10/10 pass**, exit 0, **11.871 s**, `control-terminal.log`; audit **0 survivors / 18 groups**. Other nine recovery tests now pass inside srt. |
| Startup comparison output placement (3 tests) + footer outside-repository fixture (1) | 4 | **Sandbox-setup/TMPDIR conflicts, not Seatbelt read denials.** Trusted-runner temp files now live inside the checkout: comparison rejects `--out must be outside the compared checkout`; footer discovers this checkout's branch rather than null. Same class recorded in the preceding spike. No HOME/git config change or outside output repair made. |
| Startup comparison backslash entrypoint | 1 | **Real local Node 24/macOS portability failure outside srt.** `ERR_INVALID_MODULE_SPECIFIER`: encoded backslash in an import URL. No sandbox denial; no portability fix attempted. |
| Task manager, task-store teardown, worktree disposition, retained reconstruction, retained supervisor unit cases | 5 | **Timing/resource failures outside srt.** Test/hook limits reached at **20 / 10 / 15 / 15 / 30 seconds** respectively. No permission errors. Not proved flaky by repeated serial success; underlying resource/product attribution remains open. |

The 10 host failures are: slow bundle-scan pre-spawn; forced-main rejection reap; repeated signals before adoption; import-tail signal; main pre-adoption signal; post-adoption/pre-runtime reload signal; protocol-failure reap; adopted TERM-ignoring child; adopted branch-lookup shutdown; hydration before optional branch metadata. All ten appear in both sandbox and control failure lists. No unrelated host/fixture/product bug was fixed.

Retained-owner diagnostics temporarily captured only owned synthetic child streams and PID/group verification status. Both source/test instrumentation changes were reverted; `SRT-DIAG` is absent from `src` and `test/integration`. Raw evidence remains under `.srt-spike/tmp/retention-identity-2C8xZM/production-retention-OVxDvG/owner-diagnostic.log`. This is a wrapper/ownership seam limitation, so there is **no permission denial to show for it**; calling it denied ps would be incorrect.

### Earlier attempts retained, not final verdicts

Initial focused run: **81/81**, exit 0, **15.200 s** (`focused`). Initial integration: exit 1, **241.614 s**, **332 passed / 18 failed / 108 skipped**, audit **0 survivors / 158 groups** (`integration`). Fifteen failures were caused by the new validation incorrectly requiring explicit future agent leaves to exist; fixing the wrapper, not the policy/product, removes that regression and reveals the original host failures. Final integration above is authoritative.

First native run already passed **107/107**, exit 0, **35.232 s** (`native`); it was repeated after the wrapper correction. First retention control via pnpm failed preflight in **1.692 s** because pnpm injects NODE_PATH. Direct Node/Vitest matches the integration runner's preload-free execution and supplies the valid passing control above. Diagnostic retention runs exited 1 in **61.902 s** (both tests) and **31.915 s** (running case only), with no survivors. Root-ps negative probe exited **126 in 1.152 s** as expected. None is hidden or counted as a passing full lane.

## Ownership, leftovers and remaining gaps

Final integration evidence: `.srt-spike/tmp/integration-final-29nJ9i/sumocode-harness-v2-run-5Q15Ef`. The first failed integration root also remains. Native success roots are removed by the existing harness after their authenticated audits; recorder logs/sidecars remain. Expected refusal/audit-error text from negative harness tests is not the final lane audit.

Every recorder result reports **zero observed owned survivors and zero new worktree-path candidates**. Final read-only census `.srt-spike/logs/final-leftovers.json` rechecks **2,508 recorded PID/birth identities**: **0 survivors / 0 worktree-path candidates**. No manual process kills, foreign-process cleanup, preflight `--fix`, evidence purge or branch/worktree deletion. Local caches/temp/settings/failure artifacts are retained intentionally, not live processes. Sampling every 300 ms can miss short-lived reparenting/title-hidden processes; only the harness's registered-group audit is authenticated cleanup proof.

**Go:** retain the opt-in app-only experiment and its local setup. Re-signed ps and owned Pi trust remove the intended compatibility blockers without a grant. Native and visual lanes have positive evidence on this Mac.

**No-go:** recommend the switch as the general heavy-lane recipe, default-enable it, or claim source integration is sandbox-compatible. Next requirements are a separately reviewed retained-owner PID/PGID seam and a narrow resolution for cross-run terminal signalling; do not solve either by weakening ownership checks or adding broad Seatbelt grants. Independently triage the ten unsandboxed host failures and unit setup/timing cases.

The unchanged policy keeps `allowLocalBinding:false`, no Unix-socket grants, no `~/.config`/`~/.pi` read exceptions, and the original private/7749 restrictions. This remains an accident fence for trusted checkout tests, **not a reviewed hostile-code boundary**: Linux, daemon aliases/IPv6, Unix-socket daemon access, keychain/XPC APIs, exhaustive filesystem/symlink bypasses, tool tampering, resource exhaustion and forced-crash/SIGKILL cleanup are not proved. Directory-open canaries are not exhaustive private-content protection. In particular `.aws` denial is still unproved because it is absent.

## Review-ready gate

**Contract:** bundled `/Users/sumodeus/.pi/agent/skills/review-ready/contract.md`; no repo override found. Changed files were reread and a simplification pass performed.

**Changed seam / trace:** trusted test launch → owned Pi fixture → optional wrapper → inner PATH/explicit ps override → real process/trust probes → existing supervisor/group audit. Product entry points consume one shared ps selector; no launcher runtime selection or renderer branch changed.

### Caller-knowledge

Callers supply owned cwd/temp/explicit fixtures and exact HTTP fixture ports, not private config paths or process identities manufactured for srt. The wrapper owns the inside-only environment transformation.

### Deletion

Removing the ps selector spreads binary policy across seven sites. Removing the owned-agent fixture spreads Pi trust-path/state setup across pipe and sync launches. Existing process supervision and PTY cleanup are reused, not replaced.

### Ownership

Product process-binary choice belongs beside process-tree operations. Test fixture/state transformation belongs in the existing sandbox/harness seam. Pi remains the owner of trust-store resolution and format.

### Test-surface

Focused tests exercise real ps and installed Pi trust APIs inside srt, private-file/network canaries, literal argv/exit semantics and actual supervised cleanup. The environment test proves unique private fixtures and preserved explicit overrides. No private developer state is a fixture.

**Simplification:** one explicit ps override, one reusable owned-agent fixture; no dependencies, global interception, inferred port allowances or identity bypasses. **Verification:** counts/exits above plus whitespace gate. **Exceptions:** source integration and full unit remain red; deliberate absolute ps boundary, explicit-fixture preservation, local-only tooling and incomplete security/cleanup coverage are documented here instead of a PR (publishing was not authorized). Implementation/evidence complete; general heavy-lane adoption is not review-ready.
