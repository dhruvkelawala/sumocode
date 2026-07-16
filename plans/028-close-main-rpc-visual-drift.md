# Plan 028: Close the remaining main-vs-RPC visual drift

> **Executor instructions:** Work in a dedicated worktree based on
> `codex/plan024-real-runtime-ui-parity-rerun-20260703-092057` (`7d213e9`) —
> NOT on `codex/rpc-migration-no-seam`. Follow the steps; run every
> verification; on a STOP condition, stop and report. Do not update
> `plans/README.md` — the reviewer maintains the index.
>
> **Drift check (run first):** `git log --oneline -3` in your worktree must
> show `7d213e9 test(visual): align portrait active runtime bible target` at
> or near the tip. If not, you are on the wrong base — STOP.

## Status

- **Priority:** P0
- **Effort:** M/L
- **Risk:** MED
- **Depends on:** 018–023, 025, 026, 027 (all DONE); unblocks 024
- **Category:** UX parity / bug
- **Planned at:** `7d213e9` (stack tip), 2026-07-03

## Why this matters

Plan 024's approval gate is BLOCKED: with harness determinism and target
contracts fixed (026, 027), the main-vs-RPC comparison now fails on **real
product-surface drift** — all 3 runtime scenarios, 14 crops. Main is the
canonical product surface (Track D premise, decided by Dhruv); the RPC shell
must render identically. This plan closes exactly the enumerated drift so 024
can be rerun and approved, producing the working SumoCode the user asked for.

## Current state — the exact drift (verified from the plan-024 capture roots)

Plain-text row diffs between `/tmp/sumocode-plan024-main-parity` (baseline,
canonical) and `/tmp/sumocode-plan024-candidate-parity` (RPC candidate), both
captured at contract-MATCH quality. `-` is main (target), `+` is the candidate
(what must change):

### D1 — spurious leading blank row (landscape)

```
- SUMOCODE  ║ • <session> ║        ← main: top bar on row 0
+                                   ← candidate: blank row 0
+ SUMOCODE  ║ • <session> ║        ← candidate: top bar on row 1
```

Everything below shifts by one row (`dimensionMismatch=true` in crops).
Portrait does NOT have this problem (top bar on row 2 in both) — only the
landscape/active composition emits the extra leading row.

### D2 — chat message frame glyphs (landscape + portrait)

```
-╔ USER ══════════════════════════╗     main: double-line box (canon)
-║ review src/auth/session.ts …   ║
-╚═════════════════════════════════╝
+╭ USER ──────────────────────────╮     candidate: rounded box (wrong)
+│ review src/auth/session.ts …   │
+╰─────────────────────────────────╯
```

Same for the `SUMO` box (including the ` 09:NN ═╗` timestamp segment in the
top border). The per-message box frame is a hard design constraint ("boxes are
the soul") — the double-line style is the canonical one that main renders.

### D3 — missing working indicator (landscape active-working)

Main shows, above the editor, a working block ending in:

```
- ▄ Working…
```

The candidate renders nothing there. The deterministic active-working state
must paint the above-editor working indicator rows like main.

### D4 — footer + hint row show wrong data source

```
- sumocode-plan024-main-contract (detached)      main hint row: cwd (branch)
+                                                 candidate: blank (landscape)
+ sumocode (main)                                 candidate portrait: its own cwd/branch — OK per env
- ● MEDITATING · active-working · off        14/128k · $0.00     ← main: live deterministic session
+ ● READY · gpt-5.5 · medium                 42k/200k · $0.42    ← candidate: RPC visual FIXTURE data
```

The candidate footer/top-chrome/sidebar surfaces are populated from the
`rpcVisualFixtureFromEnv` fixture (`gpt-5.5`, `42k/200k`, `$0.42`,
`019f271b`-style fixture session) or from an idle state, instead of the live
deterministic child session (model `active-working`, `14/128k`, `$0.00`,
state MEDITATING while streaming). The landscape hint row is entirely blank
where main shows `cwd (branch)`.

### D5 — splash drift

```
-                    ╰─ unknown · off              ← main: model · thinking in the frame-bottom hint
+                    ╰─ AWAITING PROMPT            ← candidate: placeholder text
+ SUMOCODE V0.3.0 · CATHEDRAL · 160 × 45 MONOSPACE ← candidate adds a version row main does not render
```

(45 styled-cell diff rows on splash per the reviewer summary.)

### D6 — colors

The reviewer report also records color drift on sidebar rows/markers, the
input frame, and footer cells. The per-crop styled-cell reports with exact
`{char, fg, bg}` mismatches are in
`/tmp/sumocode-plan024-candidate-parity/<scenario>/raw/styled-cell-diff-*.txt`
— treat those files as the authoritative cell-level spec.

### Nondeterministic identifiers

Session ids (`019f271d` vs `019f271b`) and capture timestamps (`09:34` vs
`09:32`) legitimately differ between the two roots. If they contribute to
crop failures, handle them with the harness's **existing** declared-equivalence
/ masking mechanism (see `docs/visual/parity/CONTRACT.md` — "known intentional
differences are declared as equivalent pairs and suppressed"). Do NOT invent a
new normalization layer and do NOT widen thresholds.

## Where to look (leads, not gospel — verify in your worktree)

- D1: the active-frame composition in the shared shell / RPC adapter (Plan
  019/020 moved this from `rpc/runtime.ts` `activeTopRows` which returned
  `["", topChrome, ""]` — a leading blank row main does not have).
- D2: the chat message box border style in
  `src/sumo-tui/widgets/chat-message.ts` (or a theme/border constant it
  reads). Compare against `main`'s renderer:
  `git show main:src/sumo-tui/widgets/chat-message.ts | grep -n "╔\|╭"`.
- D3: main's shell reserves above-editor working-indicator rows (Plan 019
  preserved "above-editor working indicator rows" in the extracted shell) —
  the RPC adapter likely never publishes the working state into that region.
- D4: the RPC host's footer/top-chrome/sidebar snapshot mapping — find where
  the deterministic capture env still routes fixture state
  (`SUMOCODE_VISUAL_RPC_FIXTURE` / `rpcVisualFixtureFromEnv`) into chrome, or
  where live `get_state`/`get_session_stats` data fails to reach the footer
  during the captured active-working moment. The hint row's `cwd (branch)`
  rendering exists (`renderActiveHint`) but produces blank in landscape.
- D5: splash frame-bottom hint should render `model · thinking`
  (`unknown · off` before a model is set), and the version row must not be
  painted in this scenario (main does not show it).

## Commands you will need

Worktree setup (from the main checkout root — path has a space, quote it):

```bash
cd "/Volumes/SumoDeus NVMe/code/sumocode"
git worktree add "$TMPDIR/sumocode-plan028" -b codex/plan028-close-visual-drift 7d213e9
cd "$TMPDIR/sumocode-plan028" && pnpm install
```

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm exec tsc --noEmit && pnpm build` | exit 0 |
| Unit | `pnpm test` | assertions pass (known unrelated `task-manager.test.ts` `output.log` ENOENT exits 1 — record, don't chase) |
| Integration | `pnpm test:integration` | pass |
| Behavioral PTY | `pnpm vitest run test/integration/rpc-ctrl-c.test.ts test/integration/rpc-mouse-scroll.test.ts test/integration/rpc-session-switch.test.ts test/integration/rpc-splash-centering.test.ts` | pass (must stay green) |
| Runtime lane | `pnpm visual:review -- --lane runtime` | exit 0 |
| **The gate** | `pnpm visual:compare -- --baseline-root /tmp/sumocode-plan024-main-parity --candidate-root <fresh candidate root> --lane runtime --out docs/visual/out/parity-main-rpc` | **exit 0, all 3 scenarios / 14 crops pass** |

The main baseline root `/tmp/sumocode-plan024-main-parity` already exists and
was reviewer-validated (contract MATCH). Reuse it. If it is missing, rebuild
it exactly the way Plan 024's Step 2 did (disposable `main` worktree +
normalized capture) — do not substitute anything else as baseline.
Regenerate the candidate root from YOUR worktree after each fix iteration.

## Scope

**In scope:**

- `src/sumo-tui/shell/**` (the portable shell from 019/020)
- `src/sumo-tui/rpc/**` (adapters, state/chrome mapping, visual fixtures)
- `src/sumo-tui/widgets/chat-message.ts` + test (frame glyphs only)
- `src/sumo-tui/cathedral/**` (splash/sidebar/footer trees) — only where a
  drift item above requires it
- scenario/harness files ONLY for the declared-equivalence mechanism on
  session-id/timestamp cells (`docs/visual/parity/scenarios.json`,
  `scripts/visual-v2/styled-cell-grid.mjs`) — nothing else in the harness
- colocated tests for everything you change

**Out of scope:**

- Thresholds, crop definitions, Bible HTML targets (027 settled them)
- Golden promotion (never — Dhruv approves goldens)
- The approval gate logic, `bin/sumocode.sh`, launcher selection
- Any behavioral change to input routing / interrupts (023/025 are approved;
  their tests must pass untouched)

## Git workflow

- Branch `codex/plan028-close-visual-drift` off `7d213e9` (created in setup).
- Conventional commits (`fix:`, `test:`), one commit per drift class or
  logical unit. Do not push.

## Steps

1. **Reproduce**: build a fresh candidate root from your unmodified worktree,
   run the gate command, confirm the same 3/14 failures. This proves your
   loop works before you change code.
2. **D1** leading blank row → fix, re-capture landscape, confirm
   `dimensionMismatch` clears on landscape crops.
3. **D2** frame glyphs → match main's double-line set exactly (compare with
   `git show main:src/sumo-tui/widgets/chat-message.ts`); update the widget
   test expectations that encode the rounded style.
4. **D3 + D4** working indicator, footer/hint/top-chrome data source → the
   deterministic active-working capture must render live-session-derived
   chrome (MEDITATING dot, `active-working` model, `14/128k`, `$0.00`,
   cwd+branch hint) exactly as main does.
5. **D5** splash hint + version row.
6. **D6** remaining color cells per the styled-cell reports, then
   session-id/timestamp equivalences if (and only if) they are the last
   failing cells.
7. Full verification battery (table above) + the behavioral PTY suite.

Each step: re-run the gate, record the failing-crop count going down. If a
step's fix does not reduce failures, revert it and reassess rather than
stacking speculative changes.

## Done criteria

- [ ] `pnpm visual:compare` against `/tmp/sumocode-plan024-main-parity` exits
  0 — all 3 scenarios, 14/14 crops pass, no threshold or crop-definition
  changes in the diff
- [ ] `pnpm visual:review -- --lane runtime` exit 0
- [ ] `pnpm exec tsc --noEmit && pnpm build` exit 0
- [ ] `pnpm test:integration` exit 0, including the 4 behavioral PTY files
- [ ] `git diff 7d213e9 --stat` touches only in-scope files
- [ ] No changes under `docs/visual/parity/approved-runtime/` (no promotion)

## STOP conditions

- A drift item can only be closed by changing thresholds, crop definitions,
  Bible targets, or by suppressing cells that carry real product content —
  report which item and why instead.
- Matching main requires changing behavior that plans 023/025 tests pin
  (input routing, interrupt tiers) — report the conflict.
- The baseline root is missing and cannot be rebuilt per Plan 024 Step 2.
- The gate still fails after all six drift classes are addressed — report the
  residual diff verbatim.
- Any verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Once 024 approves, the runtime goldens should be promoted (by Dhruv) so
  future drift is caught against goldens instead of live main captures.
- The declared-equivalence entries (if any were added for session id /
  timestamp) must be re-checked on Pi version bumps.
