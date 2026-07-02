# Plans

Executor-grade, self-contained implementation plans for SumoCode. Three independent tracks:

- **Track A — Pi RPC migration (001–006)**: migrate off the Pi `dist/main.js` InteractiveMode
  patch onto Pi's native `--mode rpc`, with SumoCode as the host. Gated; advisory.
- **Track B — Pi parity fixes (007–013)**: close rendering/affordance gaps where SumoCode's
  transcript renderer drops or degrades message kinds Pi renders natively (the "skill pill"
  family). Independently shippable on the current architecture.
- **Track C — No-seam RPC UX parity (014–017)**: remove the legacy retained-renderer fallback
  entirely, then make RPC UX parity with current SumoCode chrome a reviewer-owned visual gate.

**Written against commit:** `ae03bc0` (SumoCode 0.4.0, Pi 0.79.1 pinned)

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
```

| # | Plan | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| 014 | [Remove legacy seam fallback](014-remove-legacy-seam-fallback.md) | P0 | M | 006 | DONE — executed in `65f70c0`, stale references retired in `7f71f85`; reviewer verified gates |
| 015 | [RPC UX parity verification harness](015-rpc-ux-parity-verification-harness.md) | P0 | M | 014 | DONE — executed in `dcd99c1`; reviewer verified expected failing RPC parity gates |
| 016 | [Cathedral shell UX parity](016-rpc-cathedral-shell-ux-parity.md) | P0 | L | 014, 015 | DONE — executed in this branch; reviewer verified RPC splash/landscape/portrait runtime parity gates |
| 017 | [Reverify Track B UI parity on RPC](017-reverify-track-b-ui-parity-on-rpc.md) | P1 | M | 014, 015, 016 | TODO |

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
  the current placeholder RPC shell before 016 is accepted. 017 assumes 007–013 are already present
  in the source stack and rechecks them under RPC-default runtime evidence.
- **Cross-track**: 009's live compaction insert and 013's live tool handling both live in
  `chat-viewport-controller.ts`'s event pump, which Track A plan 002 rewires. If 002 lands after
  them, re-point the live inserts at the RPC `onEvent` pump and re-verify dedup. Track C is the
  final cross-track acceptance gate for this: no 1:1 parity sign-off without 017 evidence.

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
