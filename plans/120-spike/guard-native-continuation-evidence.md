# #588 native continuation — phase-0 privacy stop

**2026-09-30: BLOCKED before any app, build, install or test gate.** This is
source-trace evidence, not an observed private read/write, native test failure,
independent code approval, or #588/adoption/release clearance.

## 1. Exact identity and preservation — PASS

Base and inspected head: `0fd30c9406d7a5031b593a740474486024554821`.
Inspected tree: `f4231f7276ba119ff2f9b58e83893c2d2c1aa292`.
Branch: `sumo/v08-guards-native-continuation`.
Worktree: `/Users/sumodeus/code/sumocode.sumo-worktrees/sumo__v08-guards-native-continuation`.
**Tested head: NOT RUN.** The subsequent local evidence commit adds only this
report; its exact head/tree are retained in private `final-identity.json`.

Read own AGENTS/DEV_LOOP, complete `effect-guards.md` and `native-sandbox.md`,
and the two supplied **uncommitted, read-only parent contracts**, at:
`/Users/sumodeus/code/sumocode/plans/120-spike/guard-native-continuation.md` and
`/Users/sumodeus/code/sumocode/plans/120-spike/native-sandbox-review.md`.
Their bytes are hashed privately; no other parent edits were assumed available.

Initial tree was clean. All **589** tracked source/build/launcher/pin files
match reviewed guard `3393198c5f97ae59ba6eed4a600d4377f30bb5ad`; all **1,162**
tracked entries were inventoried (symlinks hashed as link bytes, not followed).
Repair `4400fd949b38fb143fafe9e58d7937bc217f9b22`, guard evidence `5a67dfee`,
fixture implementation `bec2873f33323472f37feb8d16cd248f04dc684b` and fixture
reviewer28 acceptance remain their own provenance, not reproduced test results.
Runtime pins remain SumoCode **0.7.5** / Pi **0.99.1**.

SHA-256 pins:

```text
package.json    fd801f64662fda1405cde5516ba94bc43029886d49e6be58739eb783bb9200ca
pnpm-lock.yaml  d26fa61985b54bb2be474463794ff5d4ded738fef7d6f8e6403a23d99696f048
.bun-version    78b591400c56b7b67b8cb3b2b8a8e65e9093897f02ce0878e6b5405c68620fa7
```

Cached executable/version probes **PASS**: Node **24.15.0**, pnpm **10.29.2**,
Bun **1.4.0**. Private `tool-identities.json` pins their real executable paths,
bytes, commands/exits and hashes. SHA-256 respectively:
`3200fbd9f7fd4410426dd541e10d1ab829d3472f270d743c7fabd1696c03fe32`,
`b276da51dc8ca5b0d3ee3371695b50fc8b3244b281b091c63a3f082a88dadeb9`,
`539598c775882420b9d8deb7dc14d845f20f7d26f5600c50ab067dde6ac3f3bf`.
Initial system probes returned Node26.10.0/Bun1.4.2/pnpm12.6.0; none ran gates.
No global version switch or release-age bypass was used.

## 2. Native final environment — bounded state, BLOCKED privacy

Read the full native fixture, public spawn-env helper, supervisor, outer runner,
preflight, native builder and installer; traced native direct-Pi/RPC entry and
child plans into extension installation and memory observation.

`nativeSpawnEnv` (`native-contract.test.ts:74`) allocates an existing private
fixture root, then calls `buildSpawnEnv` with native mode. The actual policy:

- HOME survives the inherited allowlist; ambient agent/state/config/diagnostics
  do not. Explicit fixture overrides survive, with the 17 owned-path checks.
  Omitted agent defaults owned; state stays unset, selecting `<agent>/state`.
- Outer runner supplies owned run/tmp and run/node-compile-cache. PTY evidence
  subsequently selects owned diagnostics; supervisor copies env, stamps the
  signature, removes signing/run-ID keys and registers the group. These later
  assignments do not change PI/state/config/HOME. Direct calls use owned
  fixture diagnostics/TMPDIR. Native direct Pi copies env; RPC child plans copy
  it and add the child profile. No later memory-root override appears.
- In-process provenance fixture explicitly bounds agent/state/config/diag/tmp
  and restores its environment. Installer children inherit raw env, but bind
  writes to their own prefix and do not app-start. This is **app-fixture env
  containment**, not every-spawn coverage or an OS sandbox.

**Decisive blocker:** unchanged terminal-provider case at
`test/integration/native-contract.test.ts:918–926` supplies only an owned agent,
then starts compiled classic Pi with `--print` and a local synthetic provider.
`src/native/main.ts:593–603` loads the classic bundle. Classic installation
unconditionally calls `installMemoryExtraction` (`src/extension.ts:275`).
`src/memory-extraction.ts:69–77` observes user/assistant messages on `agent_end`.
That calls `requestJson` → `defaultTokenProvider`
(`src/memory.ts:85–89,164–169,272–281`), which reads
`homedir()/.sumocode/remnic-auth-token` and POSTs to
`http://127.0.0.1:7749/engram/v1/observe`.

Neither `PI_OFFLINE` nor owned PI/state/config roots guards or redirects this
path. Client construction alone does not read the token; the agent-end request
does. The test drives a real agent turn, so relying on cancellation winning a
race against observation cannot certify privacy. **No supported command-local
env override exists in this memory path.** No token file or daemon was inspected
or contacted to test the hypothesis. No `/sumo:memory` command is necessary.

Minimal required seam: coordinator authorize and independently review an
explicit offline/non-user Remnic policy at the shared installation/client
boundary. An env-only native-helper change cannot redirect this hardcoded client;
production changes, HOME replacement and hidden interception are prohibited in
this slice. No repair was implemented.

## 3. Integration/visual — separate boundaries, not cleared

Full integration retains the existing runner's preflight → private package
snapshot → seam suite → full suite → HMAC/owner/birth-verified zero-survivor audit.
`spawnPiPty` defaults an owned agent, with later owned diagnostics and run temp/cache;
**it does not opt into native-fixture policy**. Source RPC entry still installs
memory observation (`extension-core.ts:145`); broad app verification cannot be
certified by the native fixture approval. Exhaustive broader-lane startup/privacy
certification was stopped after the decisive native escape, not claimed complete.

Additional source paths reviewed, without reading personal files: account labels
can call `loadClaudeSubscriptions` → `resolveAccountsReadPath`, which prefers
HOME-rooted private config unless `SUMOCODE_CONFIG_DIR` survives in the **child**
(`commands/accounts.ts:110–155,253`). Ordinary native calls omit it, and the
public env allowlist drops an outer setting. `top-chrome.ts:267–289,351–367`
reads HOME-rooted tabs config **only when a classic UI header renders a session
with messages**; it is not an unconditional native RPC startup read. This
qualifies the earlier conversational shorthand. Persona's hardcoded
`APPEND_SYSTEM.md` is command-time; registration alone does not read it.
Lovely-web is command-driven at `host-actions.ts:940`, not demonstrated startup
I/O. Absence of these command invocations is not blanket privacy clearance.

Visual was separately read: V2 contract/registry, index, runtime/component/fixture
capture, faux provider, paths and reset lifecycle. `runtime-capture.mjs:57`
uses **raw `node-pty.spawn`**, not `spawnSupervisedPty`/canonical signed admission.
There is no manifest registration or actual zero-survivor audit in that driver.
Its env spreads `process.env`, then assigns only agent isolation and deterministic
terminal flags. Thus outer state/config/diag/cache/TMPDIR can still survive.
Agent is a temporary root or the committed Herdr/Ultraviolet theme fixture;
state defaults under that agent only when no higher-precedence state is inherited.
`index.mjs` resets `docs/visual/out/parity`; runtime attempts also have inherent
retry behavior. None was executed or changed.

**Visual BLOCKED independently** by the required supervisor/admission/audit
contract, irrespective of memory privacy. Minimal separate seam: authorize V2
runtime capture to use existing canonical supervision and its final audit, with
owned final env. No wrapper, custom runner, filtered visual substitute, retries,
output resets or golden promotion were used here.

## 4. Gate ledger and artifacts

**PASS:** exact-base/clean-tree/source/pin inventory; cached tool version probes;
fresh output absence. `dist` (including archive, build copy and both metafiles)
and `docs/visual/out/parity` were absent; no prior output evidence was removed.
`node_modules` was absent. No native bytes/build metadata/signatures/checksums
were produced; no installed archive was selected. Build ordering/guards/signing
were read, not exercised. Import guards do not imply dependency-security clearance.

**BLOCKED:** phase-0 native privacy; full integration clearance after native stop;
visual signed admission/audit. No runtime test failure was produced.

**NOT RUN:** frozen install; 100-test guard suite; six loader tests; filtered
fixture-env regression; `pnpm exec tsc --noEmit && pnpm build`; lint;
`pnpm build:native`; canonical `pnpm test:native`; integration preflight and
`pnpm test:integration`; `pnpm visual:ci`. The contract orders these gates after
safe phase 0, so none was silently run past the stop. Native diagnostics activation,
unchanged chmod/content/precedence assertions, and user/default-tmp isolation in
an actual run remain **NOT VERIFIED**, not inferred from helper tests.

Default/serial full units were not repeated: old default35 failures and revised
Node24 default five untouched-file timeouts / serial4,363 pass remain historical,
not fresh current-head green. Supplementary integration typing was not repeated;
its 11 identical baseline/current errors and tsconfig exclusion remain recorded
in fixture evidence. Compiler budget/perf/Pi matrix, dependency audit,
visual-recap validator, dead-code, Bible regeneration/export and legacy visual
smoke are NOT RUN/outside this continuation after the stop. No #611/MCP/consumer
or production-Effect scope was added.

The intended (unexecuted) gate prefix remains flags-first:
`env -u SUMOCODE_NATIVE_DIR -u HERDR_ENV -u HERDR_PANE_ID LEFTHOOK=0 CI=1`,
with cached Node24/pnpm10 PATH and pinned `BUN_BIN`. No HOME/Git override,
`GIT_CONFIG_COUNT` assignment or blanket credential/config unset was applied.

## 5. Evidence, completion gate and settlement

Private evidence root: `/tmp/sumocode-588-continuation-stop-w0847ctb` (0700), files
0600. It holds initial/final tracked hashes, source/tool/parent contract identities,
environment **names/status only**, gate ledger and final evidence identity.
An earlier metadata-collection attempt failed on a tracked directory symlink;
its own root and error record were preserved, and a new root used. This was a
collector failure, not a test result; no output was overwritten to hide it.
Read/grep inventory misses similarly are not failed verification suites.

Read verify/review-ready/commit skills and the full default review-ready contract
`/Users/sumodeus/.pi/agent/skills/review-ready/contract.md`; no project override
found. **Review-ready design gate not applicable:** this report changes no
behavior seam. Tradeoff: honor the privacy stop rather than obtain partial green
by excluding unchanged native cases or inventing a sandbox. Report-only local
commit uses command-local `LEFTHOOK=0`; no push, config edit, cleanup, process kill,
branch/worktree removal, parent edit, pin/oracle/golden edit or publication.

**Actual runtime namespaces: 0; app/PTY/RPC groups launched: 0; signed
registrations: 0; native/integration/visual zero-survivor audit: NOT RUN.** A
read-only scan is not substituted for any mandatory audit. All synchronous
inspection/version/hash/commit commands settled; no owned verification jobs
remain. The exclusive heavy lease is released only after final metadata/commit
settlement. #588 verification is incomplete; no adoption/final-clearance claim.

**Next action:** coordinator authorize the bounded offline Remnic seam before
reacquiring the lease on a newly reviewed head; visual admission remains a separate
prerequisite before any canonical visual app capture.
