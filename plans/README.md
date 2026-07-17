# Plans

Executor-grade, self-contained implementation plans for SumoCode. Four independent tracks:

- **Track A — Pi RPC migration (001–006)**: migrate off the Pi `dist/main.js` InteractiveMode
  patch onto Pi's native `--mode rpc`, with SumoCode as the host. Gated; advisory.
- **Track B — Pi parity fixes (007–013)**: close rendering/affordance gaps where SumoCode's
  transcript renderer drops or degrades message kinds Pi renders natively (the "skill pill"
  family). Independently shippable on the current architecture.
- **Track C — No-seam RPC UX parity (014–017)**: remove the legacy retained-renderer fallback
  entirely, then make RPC UX parity with current SumoCode chrome a reviewer-owned visual gate.
- **Track D — Portable TUI/backend reset (018–025)**: supersedes the Track C shell-parity
  execution. Keep current main TUI as the canonical product surface, extract portable shell/input/
  transcript/region boundaries, and make RPC a backend adapter.

**Written against commit:** `ae03bc0` (SumoCode 0.4.0, Pi 0.79.1 pinned).
**Ledger reconciled:** 2026-07-07 at `86e5062` — Track D statuses corrected against git
history/plan files; 026–039 indexed; audit-loop plans 040–056 added.
**Ledger reconciled:** 2026-07-15 at `eea1ac6` (pre main-merge) — 060 executor lost without
landing (worktree/branch gone, no commits; back to TODO); DF-1 fix verified landed on
`integrate/track-d` as `e055c3b` (remote `fix/sidebar-fill-height` tip is a stale unrelated
commit — branch deletable); Orchestration v2 track 065–071 indexed with issues #303–#309.

> **Track relationship**: The RPC migration (Track A) explicitly **keeps SumoCode's transcript
> view-model engine** — `docs/research/pi-rpc-migration.md` lists "the transcript view-model
> engine" among the host-retained pieces, and plan 002 wires `onEvent → handleAgentEvent` to
> "drive the existing view-model". So Track B's fixes target code the migration preserves and
> reuses; they are **not throwaway** and carry forward under RPC (the doc itself credits 0.4's
> image-block parsing as "reinforcing" RPC readiness). Two plans (009 live compaction insert,
> 013 live tool execution) touch the live event pump that plan 002 also rewires. Track C now
> supersedes the temporary rollback seam from plan 006: remove the fallback first, then require
> explicit UI parity evidence before any user-facing RPC cutover is accepted.

---

## Track A — Pi RPC migration

**Design rationale:** [`docs/research/pi-rpc-migration.md`](../docs/research/pi-rpc-migration.md)
**Prior decision being superseded:** [`docs/SUMO_TUI_PI_PATCH_STRATEGY.md`](../docs/SUMO_TUI_PI_PATCH_STRATEGY.md)

These plans are advisory. They do **not** authorize starting the migration — Phase 0 is a
go/no-go gate; everything after it is contingent on that gate passing.

### Post-spike execution notes

Phase 0 returned **GO with caveats**. Those caveats affect sequencing:

- Phase 1 was executed in
  `codex/rpc-host-shell-002-exec` (`a8643bd`, `1b7a7a4`). The approval-gate issue did
  **not** block the host shell/transcript/chrome slice, because that slice keeps editor and
  custom-overlay flows disabled in RPC.
- Phases 2-4 plus Track B were normalized onto the approved Phase 1 source branch in
  `codex/rpc-precutover-stack-clean-exec` (`c256f6e`, `573248c`). Review verdict: **APPROVE**.
  The first revision was rejected for an unsafe approval skip and unused host-control facades; the
  accepted revision keeps the retained RPC runtime, adds host-owned controls/overlays, and installs
  fail-closed dangerous-command approval in the RPC child profile.
- Phase 5 was accepted in `codex/rpc-cutover-006-exec` (`96a2a0a`). Review verdict:
  **APPROVE**. The launcher now defaults interactive TTY sessions to the RPC host, keeps
  non-interactive Pi paths (`--print`, `--mode`, non-TTY stdout) direct, and keeps
  `SUMO_LEGACY=1` as the patched retained rollback for one release.
- The one-release rollback decision above is superseded for the no-seam feature branch by
  [014](014-remove-legacy-seam-fallback.md). The fallback must be removed completely before
  follow-on parity work begins.
- Do not let approval fail open. Plan 005 now blocks dangerous RPC bash on `No`, cancel,
  timeout, malformed values, thrown prompt errors, and missing UI. Only `Yes` and `Always`
  allow execution; `Always` still records the existing session allow decision.
- Selector implementation note: Plan 003's intent was satisfied with host-owned Cathedral modal
  selectors wired to typed RPC controls rather than directly embedding Pi's selector components.
  This keeps the host split clean while preserving real user-facing model/thinking/session/settings
  controls.
- Treat performance as an observed metric, not a promised win. The spike showed JSONL parsing was
  cheap in a deterministic stream, but the cutover rerun measured default RPC readiness at about
  2033ms and did not demonstrate a guaranteed perf win.
- From Phase 1 onward, every Track A plan needs a repeatable runtime proof. Prefer extending the
  existing `test/integration/spawn-pi-pty.ts` harness so `SUMO_RPC=1 bin/sumocode.sh ...` boots,
  stays alive, and cleans up under node-pty.
- Current caveat: `pnpm test` currently exits 1 after all assertions pass because of the known
  unrelated background-task temp `output.log` ENOENT unhandled error in
  `src/background-tasks/task-manager.test.ts`. Targeted suites, typecheck/build, integration, and
  visual CI are green on the accepted source stacks.

```
001 (Phase 0: spike + go/no-go)   ← MUST pass before any of 002–006
        │
        ▼
002 (Phase 1: host shell + transcript + chrome)
        │
        ▼
003 (Phase 2: extension_ui responder + selectors + controls)
        │
        ├──────────────┐
        ▼              ▼
004 (Phase 3:      005 (Phase 4: overlays + approval rewrite)   ← SECURITY-CRITICAL
     editor)           depends on 003 (extension_ui responder)
        │              │
        └──────┬───────┘
               ▼
006 (Phase 5: cutover — flag flip, smoke matrix, rollback)   ← depends on ALL of 002–005
```

004 and 005 can proceed in parallel once 003 lands. 006 must not start until 002–005 are all
DONE and the security test in 005 is green.

| # | Plan | Phase | Size | Depends on | Status | Issue |
|---|---|---|---|---|---|---|
| 001 | [RPC fidelity spike + go/no-go](001-rpc-fidelity-spike.md) | 0 | M | — | DONE — GO with caveats in [verdict](001-VERDICT.md) | [#289](https://github.com/dhruvkelawala/sumocode/issues/289) |
| 002 | [Host shell + transcript + chrome on RPC](002-host-shell-transcript-chrome.md) | 1 | M | 001 PASS | DONE — executed in `codex/rpc-host-shell-002-exec` (`a8643bd`, `1b7a7a4`) | [#290](https://github.com/dhruvkelawala/sumocode/issues/290) |
| 003 | [extension_ui responder + selectors + controls](003-extension-ui-responder-selectors.md) | 2 | M | 002 | DONE — accepted in `codex/rpc-precutover-stack-clean-exec` (`c256f6e`, `573248c`) | [#291](https://github.com/dhruvkelawala/sumocode/issues/291) |
| 004 | [Editor internalization](004-editor-internalization.md) | 3 | L | 003 | DONE — accepted in `codex/rpc-precutover-stack-clean-exec` (`c256f6e`, `573248c`) | [#292](https://github.com/dhruvkelawala/sumocode/issues/292) |
| 005 | [Overlays + approval-gate rewrite](005-overlays-approval-rewrite.md) | 4 | L | 003 | DONE — fail-closed approval verified in `codex/rpc-precutover-stack-clean-exec` (`c256f6e`, `573248c`) | [#293](https://github.com/dhruvkelawala/sumocode/issues/293) |
| 006 | [Cutover](006-cutover.md) | 5 | M | 002–005 | DONE — RPC default accepted in `codex/rpc-cutover-006-exec` (`96a2a0a`) | [#294](https://github.com/dhruvkelawala/sumocode/issues/294) |

---

## Track B — Pi parity fixes

Found via a verified Pi↔SumoCode parity audit (2026-06-30): SumoCode re-implements Pi's transcript
rendering but only classifies a subset of Pi's message kinds, so the rest drop to raw text / empty
boxes or degrade. All fixes are **box-compatible** (the per-message box frame is a hard design
constraint — never removed). Each reuses a Pi export where possible.

Recommended order: **007 → 008 → 009 → 010 → 011 → 012 → 013.** 007–010 are mostly independent
content-recovery fixes; 012 depends on 007 + 009 (it toggles/labels their new block kinds); 013 is
the highest-risk and gated on its own Step 0 investigation.

```
007 skill pill ─┐
008 edit diff   ├─ independent content-recovery (land in any order)
009 br/compact ─┤
010 ext labels ─┘
        │
        ▼
011 markdown (independent; visual-golden approval gate)
        │
        ▼
012 keybinding hints + expand-all   ← depends on 007 (skill content) + 009 (summary block)
013 live tool execution             ← independent, HIGH risk, Step-0 gated
```

| # | Plan | Priority | Effort | Risk | Depends on | Status | Issue |
|---|---|---|---|---|---|---|---|
| 007 | [Skill envelope → [skill] pill](007-skill-envelope-pill.md) | P1 | S | LOW | — | DONE — included in `codex/rpc-precutover-stack-clean-exec` (`c256f6e`) | [#295](https://github.com/dhruvkelawala/sumocode/issues/295) |
| 008 | [Render the edit diff Pi already computes](008-edit-diff-rendering.md) | P1 | S | LOW | — | DONE — included in `codex/rpc-precutover-stack-clean-exec` (`c256f6e`) | [#296](https://github.com/dhruvkelawala/sumocode/issues/296) |
| 009 | [Branch + compaction summary boxes](009-branch-compaction-summaries.md) | P2 | M | MED | — | DONE — included in `codex/rpc-precutover-stack-clean-exec` (`c256f6e`) | [#297](https://github.com/dhruvkelawala/sumocode/issues/297) |
| 010 | [Label custom (extension) messages](010-extension-message-renderers.md) | P2 | M | MED | — | DONE — included in `codex/rpc-precutover-stack-clean-exec` (`c256f6e`) | [#298](https://github.com/dhruvkelawala/sumocode/issues/298) |
| 011 | [Render markdown via pi-tui Markdown](011-adopt-pi-markdown.md) | P1 | M | MED | — | DONE — code accepted; visual evidence via `pnpm visual:ci`; no golden promotion | [#299](https://github.com/dhruvkelawala/sumocode/issues/299) |
| 012 | [Dynamic key hints + expand-all](012-keybinding-hints-and-expand-all.md) | P2 | S | LOW | 007, 009 | DONE — included in `codex/rpc-precutover-stack-clean-exec` (`c256f6e`) | [#300](https://github.com/dhruvkelawala/sumocode/issues/300) |
| 013 | [Live tool execution for all tools](013-live-tool-execution.md) | P2 | M | HIGH | — | DONE — included in `codex/rpc-precutover-stack-clean-exec` (`c256f6e`); visual CI review pack produced | [#301](https://github.com/dhruvkelawala/sumocode/issues/301) |

---

## Track C — No-seam RPC UX parity

Track C starts from the accepted RPC-default source stack (`96a2a0a`) but rejects the temporary
legacy seam. The executor must remove the fallback first, then make the runtime visual harness
strict enough to fail the current placeholder RPC shell, then restore 1:1 SumoCode UX parity on
RPC, and finally re-verify Track B's 007–013 UI work under that stricter harness.

```
006 RPC default cutover
        │
        ▼
014 remove legacy seam fallback
        │
        ▼
015 RPC UX parity verification harness
        │
        ▼
016 Cathedral shell UX parity
        │
        ▼
017 reverify Track B UI parity on RPC
        │
        ▼
018-025 portable TUI/backend reset
```

| # | Plan | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| 014 | [Remove legacy seam fallback](014-remove-legacy-seam-fallback.md) | P0 | M | 006 | DONE — executed in `65f70c0`, stale references retired in `7f71f85`; reviewer verified gates |
| 015 | [RPC UX parity verification harness](015-rpc-ux-parity-verification-harness.md) | P0 | M | 014 | DONE — executed in `dcd99c1`; reviewer verified expected failing RPC parity gates |
| 016 | [Cathedral shell UX parity](016-rpc-cathedral-shell-ux-parity.md) | P0 | L | 014, 015 | REJECTED — restored shell appearance by duplicating composition in RPC runtime instead of making the existing retained shell portable |
| 017 | [Reverify Track B UI parity on RPC](017-reverify-track-b-ui-parity-on-rpc.md) | P1 | M | 014, 015, 016 | REJECTED — depends on rejected 016 evidence; Track B must be reverified after Track D |

---

## Track D — Portable TUI/backend reset

Track D is based on the audit in
[`docs/research/rpc-portable-tui-audit.md`](../docs/research/rpc-portable-tui-audit.md).
It accepts the user's direction: the current main branch retained TUI is good enough; the work is
to make TUI and backend portable, not to keep reimplementing shell details in RPC.

```
018 canonical main-TUI baseline and duplicate-RPC rejection      025A + 025B1-B2 hardening,
        │                                                         abort control, tier module
        ▼                                                         (parallel, no shell dep)
019 extract backend-neutral retained shell
        │
        ▼
020 port RPC runtime onto portable shell
        │
        ├──────────────┬──────────────┐
        ▼              ▼              ▼
021 transcript      022 extension    023 input/keybinding/  ──▶ 025B3-B4 wire interrupt
    controller          regions +        mouse/selection +       tiers into 023's router
        │               modal fixes  │   slash honesty           (hard dep on 023)
        └──────────────┴──────────────┘
                       ▼
024 real-runtime UI parity approval gate (incl. behavioral PTY evidence)
```

| # | Plan | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| 018 | [Canonical TUI baseline and RPC rejection](018-canonical-tui-baseline-and-rpc-rejection.md) | P0 | M | 014 | DONE — compatible main-code baseline captured under `/tmp/sumocode-main-visual-plan018-contract/parity`; clean duplicate-shell branch capture under `/tmp/sumocode-branch-visual-plan018-contract/parity`; `pnpm visual:compare -- --baseline-root /tmp/sumocode-main-visual-plan018-contract/parity --candidate-root /tmp/sumocode-branch-visual-plan018-contract/parity --lane runtime` correctly fails the duplicate RPC shell with reports in `docs/visual/out/parity-main-rpc/` |
| 019 | [Extract portable owned shell](019-extract-portable-owned-shell.md) | P0 | L | 018 | DONE — `3d611f3` (refactor: extract backend-neutral retained shell) |
| 020 | [Port RPC runtime to portable shell](020-port-rpc-runtime-to-portable-shell.md) | P0 | L | 018, 019 | DONE — `2ef5945` + scroll-state follow-up `36c18d9` |
| 021 | [Extract shared transcript controller](021-extract-shared-transcript-controller.md) | P1 | L | 019, 020 | DONE — `94d92ce` (refactor: share rpc transcript ingestion) |
| 022 | [Shared extension regions and chrome publication](022-shared-extension-regions-and-chrome-publication.md) | P1 | M | 019, 020 | DONE — `3b4d8c0` + modal sanitization follow-up `457ca33` |
| 023 | [Shared input routing, keybindings, and selection](023-shared-input-routing-keybindings-and-selection.md) | P0 | M/L | 019, 020, 022 | DONE — `d1982eb` (fix: share terminal input routing) |
| 024 | [Real runtime UI parity approval gate](024-real-runtime-ui-parity-approval-gate.md) | P0 | M | 018-023, 025 | EVIDENCE READY — [024-EVIDENCE.md](024-EVIDENCE.md): main-vs-RPC runtime compare green (3/3 scenarios, 14/14 crops); golden promotion awaits Dhruv's explicit approval; the "main-is-stale splash rows" equivalence expires when main absorbs this branch |
| 025 | [RPC backend hardening and interrupt semantics](025-rpc-backend-hardening-and-interrupt.md) | P0 | M | Part A + B1-B2: none; Part B3-B4: 023 (hard) | DONE — `93e1449` (Implement RPC hardening and interrupt semantics) |

### Track D follow-on plans (026–039)

Indexed 2026-07-07 (previously tracked only in the dogfood ledger below).

| # | Plan | Status |
|---|---|---|
| 026 | [Deterministic active-runtime reachability](026-deterministic-active-runtime-reachability.md) | DONE — 2026-07-03, per plan file |
| 027 | [Align active-runtime bible contract](027-align-active-runtime-bible-contract.md) | DONE — 2026-07-03, per plan file |
| 028 | [Close main-RPC visual drift](028-close-main-rpc-visual-drift.md) | DONE — evidenced by 024-EVIDENCE.md runtime compare green (`ef4c550`, `549095d`) |
| 029 | [Filter kitty key-release events](029-filter-kitty-release-events.md) | DONE — merged `e094811` (`17091ed`) |
| 030 | [Adopt pi-tui input pipeline](030-adopt-pi-tui-input-pipeline.md) | TODO — no landing commit found; verify before dispatch |
| 031 | [Keybinding matrix audit](031-keybinding-matrix-audit.md) | TODO — DF-4 instrumentation landed (`138ed98`); awaiting a real user capture |
| 032 | [Bible demotion and regeneration](032-bible-demotion-and-regeneration.md) | TODO — status not recorded in plan file; verify before dispatch |
| 033 | [Track D integration branch](033-track-d-integration-branch.md) | DONE — `integrate/track-d` is this branch |
| 034 | [Legacy cleanup](034-legacy-cleanup.md) | TODO — approval-gated; do not start until APPROVED-TO-RUN (Dhruv) |
| 035 | [Restore Pi command family](035-restore-pi-command-family.md) | IN PROGRESS — Phase 1 DONE (`9405422`); Phase 2 (/trust, /share, 2 settings toggles) pending; Phase 3 blocked upstream |
| 036 | [Inline selector parity](036-inline-selector-parity.md) | DONE — `7b77b94`, merged |
| 037 | [Cathedral selector styling](037-cathedral-selector-styling.md) | DONE — `4383f37`, merged `149f58c` |
| 038 | [Wire app.* action keybindings](038-wire-app-action-keybindings.md) | DONE — merged `fcd2224` (incl. cycleBackward fix `a20532e`) |
| 039 | [Selector search-as-you-type](039-selector-search-as-you-type.md) | DONE — `7fbc0c9` |

## Audit-loop plans (040–056) — 2026-07-07 deep branch audit

Written against `86e5062` from the 2026-07-07 deep audit of `integrate/track-d`
(28 vetted findings; two user-reported). Executed via dispatched executor
worktrees on `advisor/NNN-*` branches; the reviewer maintains this table.
Wave-2/3 plans STACK on their parent's branch — merge order below.

```
wave 1 (parallel, base 86e5062):
  040 test-gate   041 optimistic-chrome   042 selector-values   043 replace-semantics
  044 input-router   046 extension-ui   049 renderer-tests   052 test-honesty   054 contract-env
wave 2 (each stacks on its parent):
  045 diag-hardening ← 044      047 streaming-perf ← 043     048 resume-bounded ← 042
  050 indicator-repaint ← 049   051 approval-tests ← 046     053 hardening-batch ← 042
wave 3:  055 agent-end-reconcile ← 047
last:    056 claude-oauth-401 (user-deferred to end)
```

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 040 | [Fix unit-test exit gate](040-fix-unit-test-exit-gate.md) | P1 | S | — | DONE (reviewer-approved) — `advisor/040-fix-unit-test-exit-gate` `6734ff5`; `pnpm test` exits 0 twice (1419 tests); also made the sidebar runtime test hermetic |
| 041 | [Optimistic model/thinking chrome](041-optimistic-model-thinking-chrome.md) | P1 | M | — | DONE (reviewer-approved) — `advisor/041-optimistic-model-thinking-chrome` `4a0c9f0`; optimistic apply + reconcile + error-rollback push, model-list cache, hydration reset; 101 tests |
| 042 | [Stable session selector values](042-stable-session-selector-values.md) | P1 | S | — | DONE (reviewer-approved) — `advisor/042-stable-session-selector-values` `de9c7cd`; /resume, /tree, /fork by stable id + duplicate-label regressions; scope amended to include openForkSelector |
| 043 | [Transcript replace semantics](043-transcript-replace-semantics.md) | P1 | M | — | DONE (reviewer-approved) — `advisor/043-transcript-replace-semantics` `8914623`; expansion + timestamp survive replace; 60 tests |
| 044 | [Input router interrupt fixes](044-input-router-interrupt-fixes.md) | P2 | M | — | DONE (reviewer-approved) — `advisor/044-input-router-interrupt-fixes` `eabbf5a`; paste-then-Ctrl-C fixed; Apple Terminal Shift+Enter via guarded lazy pi-tui native probe (case a) with fallback stub |
| 045 | [Diagnostics file hardening](045-diagnostics-file-hardening.md) | P2 | S | 044 | DONE (reviewer-approved) — `advisor/045-diagnostics-file-hardening` `392648a`; 0600 trace file, selection previews dropped |
| 046 | [extension_ui protocol hardening](046-extension-ui-protocol-hardening.md) | P1 | M | — | DONE (reviewer-approved) — `advisor/046-extension-ui-protocol-hardening` `ffeae01`; multiline editor(), overlays.drain() on teardown, logged handler errors; 91 tests |
| 047 | [Streaming pipeline perf](047-streaming-pipeline-perf.md) | P2 | M | 043 | DONE (reviewer-approved) — `advisor/047-streaming-pipeline-perf` `12bb229`; WeakMap key memo + op-hint diff + bounded archive dispose |
| 048 | [/resume bounded metadata](048-resume-bounded-metadata.md) | P2 | M | 042 | DONE (reviewer-approved) — `advisor/048-resume-bounded-metadata` `22d4303`; byte-capped scan + N+ labels + concurrency 8 |
| 049 | [Renderer characterization tests](049-renderer-characterization-tests.md) | P2 | M | — | DONE (reviewer-approved) — `advisor/049-renderer-characterization-tests` `144acce`; 6 mutation-tested renderer contracts |
| 050 | [Indicator narrow invalidation](050-indicator-narrow-invalidation.md) | P2 | M | 049 | DONE (reviewer-approved) — `advisor/050-indicator-narrow-invalidation` `7d2dbff`; scoped repaintRegion, no relayout on tick, overlay/selection fallback, frame convergence proven |
| 051 | [Approval dismissal tests](051-approval-dismissal-tests.md) | P1 | S | 046 | DONE (reviewer-approved) — `advisor/051-approval-dismissal-tests` `6999b88`; five dismissal paths pinned deny-equivalent; no bypass found |
| 052 | [Test honesty fixes](052-test-honesty-fixes.md) | P3 | M | — | DONE (reviewer-approved) — `advisor/052-test-honesty-fixes` `f2d1124`; real-dispatch invariant (probe-proven), PTY sleeps → screen predicates; 0 dead-advertised commands found |
| 053 | [Small hardening batch](053-small-hardening-batch.md) | P3 | S | 042 | DONE (reviewer-approved) — `advisor/053-small-hardening-batch` `cb47187`; 100KB OSC52 cap, per-query selector filter memo, 2s git timeout |
| 054 | [Visual contract env alignment](054-visual-contract-env-alignment.md) | P3 | S | — | DONE (reviewer-approved) — `advisor/054-visual-contract-env-alignment-v2` `f2da097`; v2 coordinated 4-surface SUMO_TUI=0 flip; capture smoke inert |
| 055 | [agent_end suffix reconcile](055-agent-end-suffix-reconcile.md) | P2 | M | 047 | DONE (reviewer-approved) — `advisor/055-agent-end-suffix-reconcile` `6d29d16`; Step 0 proved by-design (Pi always carries mid-run followUp in agent_end.messages); pinned with test + evidence comment |
| 056 | [OAuth auth-failure surfacing](056-oauth-auth-failure-surfacing.md) | P1 | M | 041 | DONE (reviewer-approved) — `advisor/056-oauth-retry` `a9b656`; root-caused live (user's anthropic OAuth token expired ~19d, refresh not recovering, Pi fails at auth resolution before any provider request — adapter blameless). Renders the stdout auth error in-transcript with a `/login` hint + adds a `sumocode doctor` expiry check (flagged the live expired token, exit 70) |

### Model-UX + splash parity (057–059, 2026-07-07 — second user-reported batch)

Reported live by Dhruv after the first merge. All reviewer-approved and merged into `integrate/track-d`.

| Plan | Title | Status |
|------|-------|--------|
| 057 | [Scope model cycling to enabledModels](057-enabled-models-scope.md) | DONE (approved) — `advisor/057-enabled-models-scope` `17f529e`; forward `cycle_model` already respected `enabledModels` (child scope-seeded), but cycle-backward + `/model` selector used the full 531. New dependency-free `enabled-models.ts` (off-disk `enabledModels` + faithful resolveModelScope-subset glob/exact filter); forward+backward+selector now share one enabled ring; empty→full fallback; 113 tests |
| 058 | [Remove action-confirmation toasts](058-remove-action-confirmation-toasts.md) | DONE (approved) — `advisor/058-remove-action-confirmation-toasts` `243744e`; dropped the 8 SumoCode-self info toasts (model/thinking/draft/abort/session-resumed/approval-allow) that main never showed; kept warning/error feedback, the quit hint, and the extension_ui notify path; approval deny → terse `command blocked` warning |
| 059 | [Splash live-model footer + bible](059-splash-live-model-footer-and-bible.md) | DONE (approved) — `advisor/059-splash-live-model-footer-and-bible` `f476412`; RPC splash footer now renders live `╰─ <model> · <thinking>` (was static `AWAITING PROMPT`); bible `03-splash*` regenerated (live-model footer, version line removed); `splash-runtime` visual scenario passes. GOLDEN NOTE: splash-runtime golden promotion is Dhruv's call after reviewing the review pack; active-landscape/portrait-runtime `visual:ci` fail on PRE-EXISTING golden/theme-palette drift (`#1A1511`→`#050308`), unrelated to this change |
| fix | editor.test fake controls (`getEnabledModels`) | DONE (approved) — `advisor/fix-editor-fake` `db76dce`; cross-plan fixture gap: 052's dispatcher-invariant fake lacked 057's new `getEnabledModels`; full `pnpm test` back to green |

## Startup-perf plans (060–063) — 2026-07-08 performance & startup audit

Written against `0dc25c7` from a focused performance/startup audit of `integrate/track-d`.
Measured reality at that commit: bash launcher ~50ms → host module import via jiti
~900–1350ms (~650–900ms of it pure jiti resolver/stat overhead; all 94 files fsCache
hits; `tryNative: true` measured no better) → Pi RPC child boot ~2200–2800ms
(extension-independent) → serial hydration round trips → **first frame only after all
of it** (`runtime.ts:309` emits all four readiness events at one instant). Net: a
blank terminal for ~3–4s. The committed `docs/perf/startup.md` baseline predates the
RPC cutover and measures the retired retained runtime.

Design constraint accepted from Dhruv: the early splash must not compromise UI
fidelity — 061 renders the one child-dependent splash line (`╰─ <model> · <thinking>`)
optimistically from a host-side last-known cache (plan-041 pattern), byte-identical to
today's splash in the common case; a dim bare rail only on genuinely cache-less first runs.

```
060 baseline & phase instrumentation   (first — evidence harness for the rest)
        │
        ▼
061 pre-spawn child + splash-before-hydration + parallel hydration + chrome cache
        │
        ▼
062 esbuild-bundled host entry (jiti stays as dev fallback)   ← rewrites sumo-rpc-host.js after 061

063 Pi child-boot profile spike (independent; read-only; most valuable after 061)
```

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 060 | [Startup perf baseline refresh](060-startup-perf-baseline-refresh.md) | P1 | S | — | TODO — prior executor `bg-mrbyfbqj-qtdmsd` lost (worktree `advisor/060-startup-perf-baseline-refresh` gone, no commits landed); re-dispatch from current HEAD |
| 061 | [Early first frame + parallel hydration](061-early-first-frame-and-parallel-hydration.md) | P1 | M | 060 | TODO |
| 062 | [Pre-bundled RPC host entry](062-prebundled-rpc-host-entry.md) | P2 | M | 061 | TODO |
| 063 | [Pi child boot profile spike](063-pi-child-boot-profile-spike.md) | P2 | S | — (read-only) | TODO |

Dependency notes: 060 first so 061/062 have provable before/after numbers. 061 and 062
both rewrite `sumo-rpc-host.js` (061 adds the pre-spawn contract 062 must preserve) —
strict order. 063 changes no code and can run anytime; its outcome is a
`docs/research/` doc plus an upstream issue **draft** (filing needs Dhruv's approval).
Expected end state: first paint ~0.4–0.5s (post-062), fully interactive bounded by the
Pi child boot (~2.3s) which 063 investigates.

## Chat feature plans (064) — 2026-07-08 live smoke session

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 064 | [Inline images in the retained renderer](064-inline-images-in-retained-renderer.md) | P2 | L | — (coordinate with renderer perf work) | TODO |

Context: the retained CellBuffer renderer strips Kitty/iTerm2 graphics escapes, so
images can't render inline (verified empirically — blank rows, no APC in patches).
Tier-1 mitigation is ALREADY LANDED outside this plan: tool-result image blocks map
into the transcript and `runRpcHost` pins pi-tui image capabilities off so the
`[Image: …]` fallback chip renders deterministically. Plan 064 is the real feature:
a post-patch graphics pass with placement tracking and Kitty image lifecycle.

Startup-perf findings considered and rejected (2026-07-08, so nobody re-audits them):

- **jiti fsCache misconfigured / cold**: rejected — verified warm, 94/94 cache hits,
  transpile ~0.1ms/file; the cost is jiti's resolution machinery, hence 062's bundle.
- **`tryNative: true` as a cheap win**: rejected — measured ~equal (~905–968ms).
- **5s `get_session_stats` poll as a perf drag**: rejected — guarded by `statsInFlight`,
  cheap, post-startup only.
- **SumoCode extension slows the child**: rejected — child boot measured identical with
  and without `-e src/extension.ts`; the cost is Pi itself (→ 063).
- **Streaming/resume pipeline perf**: already handled (plans 047/048, DONE).

### Audit findings not planned (2026-07-07, for the record)

- README/AGENTS/DEV_LOOP stale patch-story mentions + knip entrypoint gaps:
  already inventoried for plan 034 (2026-07-03 audit); knip false-dead leads
  re-confirmed live at `86e5062` — 034's executor must fix knip config first.
- Approval gate re-verified end-to-end at `86e5062` across all new dismissal
  paths: no bypass found (plan 051 adds the guarding tests).
- `visual-parity-contract.test.ts` "declared equivalences" pattern verified
  NOT assert-nothing (sabotage guards exist) — no action.

### Archived single-plan draft

The 2026-07-02 branch audit of `codex/rpc-migration-no-seam` (at `a3966a7`) found the RPC backend
sound (fail-closed approvals, working transport) but the hand-rolled host shell in
`src/sumo-tui/rpc/runtime.ts` broken across the board: no interrupt/abort (Ctrl-C hard-exits, even
mid-modal), no mouse scroll (SGR bytes leak into the editor), modal clobbering that can wedge the
child extension, one-row truncated approval prompts, unhandled-rejection process crashes, an
orphaned child on transport errors, ~16 dead advertised slash commands with no `/quit`, and a full
transcript remap per streaming token. Verdict: architecture rework, not point fixes — Pi RPC stays
the backend; the host shell is rebuilt by composing the mature SumoTUI modules (FrameScheduler,
KeyRouter, mouse parser, ModalLayer, ChatPager/ScrollBox, RegionRegistry) that the retired seam
runtime already proved out. One plan carries all eleven audit findings as acceptance criteria.

| # | Plan | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| draft | [Rebuild the RPC host shell on the SumoTUI main-brain runtime](draft-rpc-host-main-brain-rebuild.md) | P0 | L | 014-017 | REJECTED — superseded by the 018-025 split because it mixes baseline, shell, input, modal, transcript, and acceptance work into one execution plan. Its behavioral content was reconciled into Track D: hardening + interrupt → 025; modal fixes + Cathedral approval routing → 022 (Steps 3b/3c); pump perf requirements → 021; slash honesty → 023 (Step 4); behavioral PTY evidence → 024 (Step 1b). Keep the file as the audit-evidence source those plans cite. |

## Dogfood findings (2026-07-03, live on integrate/track-d @ 549095d)

Real-window testing surfaced parity gaps the fixed-size (45/100-row) captures never exercised:

| # | Finding | Status |
|---|---|---|
| DF-1 | ✅ FIXED (`e055c3b` on `fix/sidebar-fill-height`, reviewer-verified: tall-window test fails-without/passes-with; before bg=#1a1511 bare → after #241d17 sidebar surface; no crop regressed). The sidebar component already had a `targetRows` pad callback (main feeds it `tui.terminal.rows`); RPC path just never wired it. Sidebar doesn't fill vertically — renders content height (~26 rows) then stops; main renders a full-height column. Root: `ShellRenderable.render(width)` has no height param; `PiComponentLeaf` paints only `min(contentRows, rect.height)`. | LANDED — `e055c3b` on `integrate/track-d` (2026-07-15 verify: commit is ancestor of HEAD; remote `fix/sidebar-fill-height` tip `e07c3d0` is an old unrelated commit — branch deletable) |
| DF-2 | Stray `mcp: MCP: 0/5 servers` line above the editor — `ExtensionStatusPublication.render` (region-registry.ts:126, RPC-only class not on main) dumps every `setStatus(key,text)` as a literal `key: text` row; redundant with the sidebar MCP list. | QUEUED — dogfood parity polish batch |
| DF-3 | Keybinding capture RESOLVED as not-a-decode-bug: pi-tui `parseKey` correctly decodes the user's real Kitty bytes (arrow `[1;1:1C`→"right"; `:3` releases flagged). Any residual nav issue is router→editor wiring → plan 030 fixes, plan 031's matrix catches. | UNDERSTOOD — folded into 030/031 |
| AUDIT-A | ✅ PHASE 1 DONE — 035 P1 executed (`9405422`, merged): `/copy`, `/export`(HTML), `/resume` (on-disk session reader + switch_session), `/tree` (browse, fork-only), `/hotkeys`, `/changelog`, `/session` panel, `/theme` in-place. session-reader verified vs REAL session files. Blocked (still honestly notify): /login /import /reload /export-jsonl /tree-navigate = Phase 3 upstream-Pi asks. Phase 2 (/trust /share) pending. Missing/degraded Pi command family: /resume, /tree NOT handled (and blocked — RPC protocol has no session-list/tree primitive); /fork present but degraded (basic modal vs Pi's rich Session Tree); /export, /copy buildable from primitives (export_html, get_last_assistant_text) but not built. | AUDITING — findings → plan 035 |
| AUDIT-B | ✅ AUDITED → [plan 036](036-inline-selector-parity.md). CORRECTION: inline autocomplete already WORKS (matches Pi byte-for-byte) and the Ctrl+/ palette is fine (floating). The real culprit is `/model /thinking /sessions /settings /fork` routing through the full-screen `ModalLayer` backdrop instead of Pi's in-place editor-region selector swap. | ✅ DONE — 036 executed (`7b77b94`, merged to integrate/track-d): /model /thinking /sessions /settings /fork now render in-place (transcript stays visible); executor caught+fixed an interrupt-tier landmine (Ctrl-C/Esc now dismiss the selector). Follow-up: /theme still full-screen → fold into 035. |

## Keybindings root-caused (2026-07-03, from a real diagnostic capture)

The user ran `sumocode -d .` and captured `/tmp/sumocode-manual.jsonl`. Decoded the raw
`raw_key_input`/`route_verdict` trace directly: user pressed Shift+Tab and Ctrl+Shift+P repeatedly,
both correctly decoded by pi-tui as CSI-u sequences, both routed to `target: "editor"` — and produced
**zero visible effect**. Root cause, traced to the exact source line: Pi's `CustomEditor.handleInput`
(`custom-editor.js`) only dispatches actions registered via `editor.onAction(name, handler)` — and
`grep -rn "\.onAction(" src/sumo-tui/rpc/` returns **zero matches**. Plans 035/036 built a full
11-action mirrored keybindings table (for KeybindingsManager matching + `/hotkeys` display) but only
ever wired 2 of them (`app.exit`, `app.interrupt`) to a real handler, via the dedicated
`onCtrlD`/`onEscape` properties. The other 9 — including `app.thinking.cycle` (Shift+Tab) and
`app.model.cycleBackward` (Shift+Ctrl+P), the user's exact repro — are declared-but-inert: the chord
is recognized, matches nothing in the (empty) action-handler map, falls through to pi-tui's base
editor, which has no meaning for it either. Total silence, no error, no garbage inserted — this is
what "keybindings don't work" has meant all along.

→ [plan 038](038-wire-app-action-keybindings.md), P0. ✅ DONE — merged (`fcd2224` on `integrate/track-d`, `--no-ff` since 039 had landed in between on disjoint files). Executor wired 5 of 9: `app.model.cycleForward` (Ctrl+P), `app.model.select` (Ctrl+L), `app.thinking.cycle` (Shift+Tab — one of the user's two exact repro chords), `app.tools.expand` (Ctrl+O), all via new `editor.onAction(...)` hooks threaded through `host.ts`. `app.clear` correctly pinned N/A with a positive test (Ctrl+C is consumed by the router's interrupt tier before the editor's actionHandlers loop ever runs — verified exhaustive over every `decideRpcInterrupt` state). `app.suspend` stays out of scope (needs a runtime pause/resume pair). `app.thinking.toggle`/`app.session.toggleNamedFilter` left unwired — no clean host-side equivalent without new transcript/sidebar state, matching the plan's own STOP conditions. Regression guard confirmed: an unbound key still inserts as plain text.

**Independent review caught a real bug before merge**: the executor's `app.model.cycleBackward` (Shift+Ctrl+P — the *other* exact repro chord) implemented "cycle backward" as calling the forward-only `cycle_model` RPC command `(N-1)` times, reasoning in its own commit message that "provider model lists are realistically small" and that this was the plan's explicit "STOP if fragile" condition, "and it wasn't." That reasoning contradicted evidence already in this same session — the user's own `/model` screenshot showed 531 entries — so this would have fired ~530 sequential RPC round-trips on every press, i.e. a multi-second freeze standing in for the original silent no-op. Fixed (`a20532e`, folded into the merge commit) by computing the previous model locally from the already-fetched list (`RpcModelOption` carries `provider`/`id`/`active`) and applying it with one `setModel()` call — O(1) regardless of list size. Added a 531-entry regression test pinning "single call, not a loop." Full battery reverified post-fix and post-merge: 260/260 unit (`src/sumo-tui/rpc/`), 44/44 integration, `tsc --noEmit` + `pnpm build` clean.

**Also spotted this round (screenshot, /model with 531 entries, no filtering):** → [plan 039](039-selector-search-as-you-type.md) — 037's rewrite bypassed SelectList's rendering but never added its filter-as-you-type capability. Exact working pattern already exists in this codebase (`command-palette.ts`'s searchQuery/filterPaletteRows). Dispatched in parallel with 038 (disjoint files). ✅ DONE — merged (`7fbc0c9`). Chose `fuzzyFilter` over substring after empirically testing both on a 540-item fixture: substring returned ZERO results for realistic queries like "seed16" (missing literal separators); fuzzyFilter found them via its alpha/digit-swap heuristic. Same utility editor.ts already uses for model autocomplete — no new dependency.

## Dogfood round 2 findings (2026-07-03, on integrate/track-d @ 9405422)

**All four executable items from this round landed and are merged** (`fix/mcp-status-line` fa8f056, `feat/cathedral-selector-styling` 4383f37 — merged via `--no-ff` since 037 branched before the MCP fix landed; full battery reverified post-merge: 678/678 unit, 43/44 integration with the one failure confirmed as the known full-suite PTY-concurrency flake — passes 2/2 in isolation, matches the documented signature from earlier in this session, not a regression). Real checkout confirms the sidebar dir-name "allowed failure" was purely a worktree-naming artifact — doesn't reproduce here.

| # | Finding | Status |
|---|---|---|
| DF-4 | Keybindings still reported broken after 029; no ground-truth capture existed (diagnostics logged byte COUNTS, not bytes). ADDED: unconditional `raw_key_input` + `route_verdict` diagnostic tracing in `shared-input-router.ts` (`138ed98`, committed directly — reviewed, tested, low-risk instrumentation-only). Run `sumocode -d .`, reproduce the broken key, `sumocode diag` or grep the diag file for `raw_key_input`/`route_verdict`. | INSTRUMENTED — awaiting a real capture from the user to ground-truth the fix |
| DF-2 (retry) | ✅ FIXED (`fa8f056`, merged). Confirmed main's `setStatus` is a TOTAL no-op — SumoCode's own `installFooter` replaces Pi's default footer and never reads `getExtensionStatuses()`, and main's adapter never wires an `onStatus` callback. `ExtensionStatusPublication.render()` now returns `[]` to match; bookkeeping (`getStatuses()`) kept intact for other readback paths, not deleted.
| DF-5 | ✅ RE-AUDITED (exhaustive, from Pi's canonical `core/slash-commands.js` registry — 22 commands + 3 hidden). Good news: most of Pi's real command set is now Class A (done) thanks to 035 Phase 1. Genuinely still open: `/trust` `/share` (Phase 2, unexecuted), `/fork` fuzzy-filter polish, 2 new `/settings` toggles (`set_steering_mode`/`set_follow_up_mode` — buildable today, just unwired). **`/scoped-models` re-verdict 2026-07-15: buildable host-side** — the private `_scopedModels` field is still unreadable over RPC, but plan 057's host-authority ring (`enabled-models.ts` + `set_model`) proved the pattern; make the ring session-mutable, move forward Ctrl+P off `cycle_model`, reimplement session persistence + per-model thinking overrides host-side. See plan 035 Phase 2 for the build plan; upstream `get/set_scoped_models` verbs demoted to nice-to-have. `/debug` + 2 easter eggs correctly out of scope.
| DF-6 | ✅ DONE — 037 executed (`4383f37`, merged). Selector rebuilt on `scriptorium-chrome.ts` panel chrome (bg fill, ❈/· Cathedral glyphs, ✦ header, footer hint, description/current-value column, ● current marker where real state exists). `SelectList` bypassed entirely rather than forked (its row-prefix had no override hook); scroll/selection math reimplemented to match; `getKeybindings()` still used for input parity. 8 new styling-regression tests assert real SGR/glyphs, not substrings.
| DF-7 | ✅ FIXED (`021004d`). After 038 landed, dogfooding found the newly-wired model/thinking keybindings "not optimistic" — footer sat on the stale value for a few seconds. Root cause: `RpcHostControls.setModel`/`cycleModel`/`setThinkingLevel`/`cycleThinkingLevel` each sent the real mutating RPC command, then threw away its response and issued a *second* `get_state` round-trip just to read back the same thing — `set_model`/`cycle_model`/`cycle_thinking_level`'s own responses already carry the resulting model/level inline (`rpc-types.d.ts`). Added `RpcHostStateStore.applyModelChange`/`applyThinkingLevel` to patch the store directly from the first response; `refreshState()` (boot, `/resume`, etc.) is untouched. Halves the round-trips on every affected keybinding.
| DF-8 | ✅ FIXED (`175eae3`). User reported the above-editor "Working…" indicator "stops when streaming or thinking, or animates weird." Root cause: `RpcShellAdapter.renderWorkingIndicator` advanced its own animation tick every time it was CALLED, not on a wall-clock cadence — render frequency tracks agent activity, which is bursty (many renders/sec while streaming deltas arrive → animation raced ahead; near-zero renders while waiting on a tool call/first token → animation froze solid). Added a real `setInterval` (`workingIndicatorTimer`, keyed to the active theme's `intervalMs`) started/stopped on idle↔busy transitions, mirroring classic Pi's `WorkingIndicatorComponent`; `RpcShellAdapterOptions` gained a `requestRender` callback (wired from `RpcHostRuntime.scheduleRender`) so the timer can trigger its own repaint instead of piggybacking on renders that may not happen. 5 new regression tests with fake timers pin: ticks with zero renders in between, doesn't race under a render burst, stops immediately on going idle, calls `requestRender` every tick, and the timer is cleared on `dispose()`.

## Verification gates

```bash
pnpm exec tsc --noEmit && pnpm build   # always
pnpm test                              # unit
pnpm test:integration                  # PTY/real-Pi integration (Track A; Track B 009/013)
pnpm visual:ci                         # V2 visual parity gate (008/011/013 affect captures)
```

Track B note: 011 and 013 change captured visual surfaces. Per `AGENTS.md`, golden promotion
requires Dhruv's explicit approval — executors produce review evidence (`pnpm visual:review`) and
STOP; they never run `pnpm visual:promote`.

Track C note: UI parity is a required reviewer responsibility, not an executor assertion. Executors
must provide runtime captures, crop diffs, styled-cell reports, geometry audits, and a concise
manual comparison against the current SumoCode splash/footer/sidebar/input behavior. Golden
promotion still requires Dhruv's explicit approval.

## Dependency notes

- **Track A**: 002 requires 001 PASS; 003 requires 002; 004 and 005 require 003; 006 requires 002–005.
  The approval caveat is accepted for starting 002, but not for final cutover.
- **Track B**: 012 requires 007 (uses the skill `content` field + `renderSkillRows`) and 009 (toggles
  the `summary` block kind). 013 has no plan dependency but is gated on its own Step 0 investigation.
- **Track C**: 014 intentionally removes rollback plumbing before additional UI work. 015 must fail
  the current placeholder RPC shell before 016 is accepted. 016/017 are now rejected by the
  2026-07-02 portable TUI audit because they left a duplicated RPC shell and synthetic runtime
  evidence.
- **Track D**: 018 must run before further UI implementation so future executors have a main-vs-RPC
  rejection harness. 019 and 020 put RPC on the shared shell; 021-023 close behavior gaps; 024 is
  the approval evidence gate. 025 Part A (client hardening, crash-proofing) and B1-B2 (abort
  control + pure tier module) have no shell dependency and can run in parallel with 018-019 — they
  protect live sessions immediately. 025 Part B3-B4 (tier wiring + integration test) **hard-depends
  on 023**: 023 exposes a pre-editor interception point in the shared router; 025 wires the tiers
  there. Wiring interrupts into the legacy runtime handler and re-homing later is explicitly
  disallowed (both plans say so). 023 does not depend on 025. 022 must fix the base `ModalManager` (Step 3b)
  before routing extension dialogs into it, or concurrent `extension_ui_request`s keep wedging the
  child. 019's dual-backend question is **decided (Dhruv, 2026-07-02): main-as-reference** — no
  live in-process adapter on this branch; the Pi adapter stays compiling/contract-tested only, RPC
  is the sole live consumer (014 removed the in-process host). 021's Pi-bridge delegation is scoped
  down accordingly.
- **Cross-track**: 009's live compaction insert and 013's live tool handling both live in
  `chat-viewport-controller.ts`'s event pump, which Track A plan 002 rewires. If 002 lands after
  them, re-point the live inserts at the RPC `onEvent` pump and re-verify dedup. Track C is the
  final cross-track acceptance gate for this: no 1:1 parity sign-off without 017 evidence.

## Orchestration v2 — one grammar for subagents and background work (065–070)

**Design rationale:** [`docs/research/SUMOCODE_ORCHESTRATION_BENCHMARK_2026.md`](../docs/research/SUMOCODE_ORCHESTRATION_BENCHMARK_2026.md)
(primary-source benchmark of Claude Code, Codex, Oh My Pi, OpenCode, Cursor, Copilot coding
agent + the `davis7dotsh/my-pi-setup` reference implementation). Decided shape: verb-per-tool
surfaces (`subagent_spawn/check/wait/cancel/list`, `bg_start/bg_status/bg_kill/bg_list`), typed
deferred result delivery with consumed-tracking (no fake-user prose), an in-app dashboard +
takeover view instead of mandatory cmux panes, worktree isolation + host-derived completion
manifests, then retirement of the `bg_task` mega-tool and delegation routing ambiguity.

**Planned at:** `d4ce41d`, 2026-07-15.

| Plan | Title | Priority | Effort | Depends on | Issue | Status |
|------|-------|----------|--------|------------|-------|--------|
| 065 | [Subagents core: domain, manager, pi backend, five verb tools](065-subagents-core.md) | P1 | L | — | [#303](https://github.com/dhruvkelawala/sumocode/issues/303) | TODO |
| 066 | [Typed deferred result delivery](066-typed-deferred-result-delivery.md) | P1 | M | 065 | [#304](https://github.com/dhruvkelawala/sumocode/issues/304) | TODO |
| 067 | [Background terminals verb regrammar](067-background-terminals-regrammar.md) | P2 | M | 066 | [#305](https://github.com/dhruvkelawala/sumocode/issues/305) | TODO |
| 068 | [/subagents dashboard, takeover view, /ps](068-fleet-dashboard-and-takeover.md) | P2 | L | 065, 066, 067 | [#306](https://github.com/dhruvkelawala/sumocode/issues/306) | TODO |
| 069 | [Worktree isolation + completion manifest](069-worktree-isolation-and-manifest.md) | P2 | M | 065, 066 | [#307](https://github.com/dhruvkelawala/sumocode/issues/307) | TODO |
| 070 | [Migration: retire bg_task + routing guidance](070-orchestration-migration.md) | P3 | M | 065–069 + operator gate | [#308](https://github.com/dhruvkelawala/sumocode/issues/308) | TODO |
| 071 | [On-demand interactive worktrees (fresh/reopen)](071-on-demand-interactive-worktrees.md) | P2 | S | — (independent) | [#309](https://github.com/dhruvkelawala/sumocode/issues/309) | DONE |
| 072 | [Terminal-host abstraction: herdr + cmux](072-terminal-host-abstraction-herdr.md) | P2 | M | 071 (same file) | [#311](https://github.com/dhruvkelawala/sumocode/issues/311) | TODO |

### Dependency notes

- 066 needs 065's manager/consumed-set; 067 reuses 066's delivery buffer and flusher.
- 068 needs 067 only for `/ps`; the `/subagents` half can start after 066 if sequencing demands.
- 069 is parallel to 067/068 (different files) — coordinate only on `src/subagents/index.ts`.
- 070 is gated on explicit operator confirmation of real-work parity — it deletes working
  functionality (`bg_task` tool, `runner=sumocode` spawn path, `notifyOnExit` prose wake).
- 072 makes every pane/notification surface (worktree, diff, review, visible bg tasks) work under
  herdr (herdr.dev) as well as cmux via a `TerminalHost` facade; land after 071 (shared
  `worktree.ts`). Herdr-native worktree workspaces and `wait agent-status` orchestration hooks
  are recorded follow-ups, not v1 scope.
- 071 is fully independent (touches only `src/commands/worktree.ts` + test) and can run first
  — it extends the existing `/sumo:worktree` with Codex/T3-style plain interactive sessions
  (bare/`new [name]`/`--base <ref>`) and `open <branch-or-path>` reopen, keeping the delegated
  `<task>` form and `prune` back-compatible.
- Deliberately deferred (recorded in 065/068/069/070/071 maintenance notes): durable subagent
  recovery across reloads, claude/codex harness backends, steering into live children, cmux
  panes as optional task views, the diff→apply/discard result loop, worktree pruning UI/status
  badges, and local⇄worktree handoff.

## Theme expansion — Herdr Terminal (073)

**Planned at:** `933f33d`, 2026-07-17.

| Plan | Title | Priority | Effort | Depends on | Issue | Status |
|------|-------|----------|--------|------------|-------|--------|
| 073 | [Herdr Terminal theme](073-herdr-terminal-theme.md) | P2 | M | — (independent; coordinate with 072 only on naming/docs) | [#312](https://github.com/dhruvkelawala/sumocode/issues/312) | TODO |

### Scope note

- 073 adds the first-party `herdr` visual theme and makes OSC background/cursor painting follow the
  active theme. It does **not** implement Plan 072's external terminal-host adapter; “Herdr Terminal”
  here is a visual identity, while 072 targets the separate `herdr` terminal application API.
- The first three registry entries remain pinned; Herdr appends fourth. Existing Cathedral Bible
  targets and approved runtime goldens are not rewritten or promoted by this plan.

## Status values

TODO | IN PROGRESS | DONE | BLOCKED (with one-line reason) | REJECTED (with one-line rationale)

## Findings considered and rejected

- **Remove the per-message box frame for a borderless stream** (from the broader UX audit): rejected
  by design — the box is the signature UX. All density/fidelity work stays box-compatible.
- **Add a `custom` channel to Pi's RPC protocol** (Track A): rejected — requires forking Pi, the exact
  thing the migration exists to escape. Use host-render + `extension_ui` value round-trip (see 005).
- **Revert to in-process public extension chrome (no patch, no RPC)** (Track A): rejected previously in
  `SUMO_TUI_PI_PATCH_STRATEGY.md`; loses retained chat-viewport control.
- **Keep `SUMO_LEGACY=1` as a one-release rollback** (Track C): rejected for the no-seam feature
  branch. Plan 014 removes the fallback completely while preserving supported direct Pi paths for
  non-interactive execution.
- **"Visual parity gates are toothless — golden check excludes runtime crops"** (2026-07-02 branch
  audit): rejected — `scripts/visual-v2/index.mjs:203-217` gates required crops against the Bible
  target before golden promotion and exits 1 on failure; the unit test's golden-existence filter
  intentionally covers only promoted scenarios (promotion needs Dhruv's approval per AGENTS.md).
- **"Approval fails open under RPC"** (pre-migration landmine): verified closed — cancel, timeout,
  malformed values, thrown errors, and missing UI all normalize to "no" and block
  (`src/approval-modal.ts` `showRpcApprovalPrompt` + `installApprovalGate`). Track D may change
  presentation or region mounting, but must not weaken the gate logic.
- **Reuse `chat-viewport-controller` / `installChatViewportBridge` in the RPC host** (2026-07-02
  audit): rejected as a direct import because it bridges into Pi InteractiveMode internals that do
  not exist under RPC. Track D instead extracts shared transcript/input behavior from it and adapts
  RPC through backend-neutral contracts.
- **Point-fix plans for the 2026-07-02 audit findings**: superseded by decision — the active Track D
  split handles the findings as boundary work across 018-025 instead of one-off UI patches.
  Reconciled 2026-07-02: the behavioral findings that the structural split did not cover are now
  explicit — backend hardening + interrupt semantics (025), modal queueing/legibility/sanitization
  and Cathedral approval routing (022 Steps 3b/3c), transcript-pump performance requirements (021),
  slash-command honesty (023 Step 4), and behavioral PTY acceptance evidence (024 Step 1b).
  Evidence lives in [draft-rpc-host-main-brain-rebuild.md](draft-rpc-host-main-brain-rebuild.md).
