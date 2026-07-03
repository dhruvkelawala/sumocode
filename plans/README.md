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
| 019 | [Extract portable owned shell](019-extract-portable-owned-shell.md) | P0 | L | 018 | TODO |
| 020 | [Port RPC runtime to portable shell](020-port-rpc-runtime-to-portable-shell.md) | P0 | L | 018, 019 | TODO |
| 021 | [Extract shared transcript controller](021-extract-shared-transcript-controller.md) | P1 | L | 019, 020 | TODO |
| 022 | [Shared extension regions and chrome publication](022-shared-extension-regions-and-chrome-publication.md) | P1 | M | 019, 020 | TODO |
| 023 | [Shared input routing, keybindings, and selection](023-shared-input-routing-keybindings-and-selection.md) | P0 | M/L | 019, 020, 022 | TODO |
| 024 | [Real runtime UI parity approval gate](024-real-runtime-ui-parity-approval-gate.md) | P0 | M | 018-023, 025 | TODO |
| 025 | [RPC backend hardening and interrupt semantics](025-rpc-backend-hardening-and-interrupt.md) | P0 | M | Part A + B1-B2: none (parallel with 018-019); Part B3-B4: 023 (hard) | TODO |

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
| DF-1 | ✅ FIXED (`e055c3b` on `fix/sidebar-fill-height`, reviewer-verified: tall-window test fails-without/passes-with; before bg=#1a1511 bare → after #241d17 sidebar surface; no crop regressed). The sidebar component already had a `targetRows` pad callback (main feeds it `tui.terminal.rows`); RPC path just never wired it. Sidebar doesn't fill vertically — renders content height (~26 rows) then stops; main renders a full-height column. Root: `ShellRenderable.render(width)` has no height param; `PiComponentLeaf` paints only `min(contentRows, rect.height)`. | FIX IN PROGRESS — `fix/sidebar-fill-height` off 549095d, with a tall-window (160×100) regression test |
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
| DF-5 | ✅ RE-AUDITED (exhaustive, from Pi's canonical `core/slash-commands.js` registry — 22 commands + 3 hidden). Good news: most of Pi's real command set is now Class A (done) thanks to 035 Phase 1. Genuinely still open: `/trust` `/share` (Phase 2, unexecuted), `/fork` fuzzy-filter polish, 2 new `/settings` toggles (`set_steering_mode`/`set_follow_up_mode` — buildable today, just unwired). **`/scoped-models` is DEFINITIVELY BLOCKED upstream** — Pi's scoped-model state is a private in-process field never exposed over RPC (not even readable); not buildable host-side, period. See plan 035's updated Phase 2/3. `/debug` + 2 easter eggs correctly out of scope.
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
