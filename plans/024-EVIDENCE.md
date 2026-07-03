# Plan 024 — Parity Gate Equivalences: Evidence Pack

**Branch:** `codex/parity-gate-equivalences` @ `6886e5a5013a591833357a228d36b8172852a6d5`
**Integration ref:** `integrate/track-d` guarded-updated to `6886e5a` (fast-forward from `00b6637`, ancestry verified).

## Commands run

```bash
git merge-base --is-ancestor 00b6637 6886e5a   # ANCESTOR-OK
git update-ref refs/heads/integrate/track-d 6886e5a 00b6637
git checkout -b codex/parity-gate-equivalences 6886e5a
pnpm install && pnpm render:bible               # 95/95 Bible mockups rendered
pnpm visual:review -- --lane runtime            # fresh candidate capture (this worktree)
pnpm visual:compare -- --baseline-root /tmp/sumocode-main-parity-clean \
  --candidate-root <fresh candidate capture> --lane runtime \
  --out docs/visual/out/parity-main-rpc
pnpm vitest run src/sumo-tui/ src/visual-parity-contract.test.ts
pnpm exec tsc --noEmit && pnpm build
pnpm test:integration
pnpm test
```

Main baseline used: `/tmp/sumocode-main-parity-clean` (pre-existing clean capture at `main` tip `c744cd2`). Candidate capture produced fresh in this worktree via `pnpm visual:review -- --lane runtime`, copied to `/tmp/sumocode-candidate-parity-gate`.

## Gate result

`pnpm visual:compare` — **exit 1** (see STOP note below; 2 of 3 scenarios pass, all their crops pass).

| Scenario | Result | Crops (7/7/6) |
|---|---|---|
| `splash-runtime` | **FAILED** | `full` failed — 2 diff rows OUTSIDE the 5 declared classes (see STOP) |
| `active-landscape-runtime` | **PASSED** | all 7 crops passed (`full`, `top-bar`, `sidebar`, `chat-area`, `input-frame`, `hint-row`, `footer`) |
| `active-portrait-runtime` | **PASSED** | all 6 crops passed (`full`, `top-bar`, `chat-area`, `input-frame`, `hint-row`, `footer`) |

`pnpm visual:review -- --lane runtime`: `splash-runtime` passed; `active-landscape-runtime` / `active-portrait-runtime` FAIL — expected, only against the demoted pre-D1 Bible target (plan 032 debt, per CONTRACT.md line 79 anticipation of this exact gap).

## Equivalence declarations added

Location: `scripts/visual-v2/compare-captures.mjs` — new `KNOWN_EQUIVALENT_REGIONS` table (per-scenario, narrow row/col rectangles with mandatory `targetPattern`/`runtimePattern` content guards), wired into both the full-grid `diffStyledGrids` call and the per-crop `diffStyledGrids`/`comparePngFiles` calls (`cropEquivalentRegions` translates absolute coordinates into crop-local coordinates; `applyPixelMask` carries the same declaration through to the PNG gate by blanking the identical rectangle in both images before `pixelmatch`). This is an extension of the existing `EQUIVALENT_PAIRS` mechanism in `styled-cell-grid.mjs` (same "declare narrow equivalent pairs, suppress from diff" precedent as `--divider-mockup`/`--divider`), not a parallel system — kept in `compare-captures.mjs` because it suppresses main-vs-candidate differences, a different comparison axis than `EQUIVALENT_PAIRS`'s Bible-vs-runtime color pairs.

| Region | Rows / cols | Justification |
|---|---|---|
| Session-id chars (top bar) | landscape row 0 cols 21-22; portrait row 1 cols 21-22 | Random per process (`019f2893` vs `019f28ad`); pattern-guarded on the surrounding `• [0-9a-f]{8} ║` shape. |
| Timestamp minutes (box border) | landscape row 6 cols 123-124; portrait row 8 cols 55-56 | Live capture wall-clock minute; pattern-guarded on `\d{2}:\d{2} ─┐`. |
| Cursor-blink-phase cell (input caret) | landscape row 39 col 4; portrait row 94 col 4; splash row 32 col 54 | fg/bg swap is the blink-phase indicator; timing-dependent which phase lands in a still capture. |
| Working-indicator animation-phase glyph | landscape row 36 col 1 | Spark-frame cycle (`SPARK_FRAMES` in `compaction-indicator.ts`); timing-dependent, same family as cursor-blink-phase. |
| Hint-row cwd/branch segment | landscape row 41 cols 1-130 (static `CTRL+/ · COMMANDS` NOT masked); portrait row 96 cols 1-34 (same) | Capture-environment working dir/branch. On landscape the sidebar is visible, so by design (`AGENTS.md`: "Project/branch live in the sidebar when visible") the candidate's hint row legitimately omits this text while main's older chrome still rendered it there — same root cause, different rendering surface. |
| Sidebar cwd/branch lines | landscape rows 10-11 cols 130-159 | Same capture-environment working-dir/branch variability as the hint row, rendered in the sidebar column instead. |
| D4 deterministic constants (token/cost gauge) | landscape rows 14-18 and row 43 cols 143-158; portrait row 98 cols 43-58 | Candidate freezes `42k/200k · $0.42` under `SUMOCODE_HARNESS=1` visual-capture determinism; main shows whatever its live (non-harness-aware) session state happened to be (`14/128k · $0.00`) in the captured baseline. |
| MCP roster placeholder | landscape rows 24-34 cols 130-159 | Candidate's RPC shell (`src/sumo-tui/rpc/shell-adapter.ts`) added a `SUMOCODE_HARNESS`-gated `PLACEHOLDER_MCP` roster (`github/stitch/context7/chrome-dev`, fixed — see `src/sidebar.ts`) specifically so visual captures don't leak the live per-machine `~/.pi/agent/mcp.json` roster (`src/mcp-config-reader.ts`). Main's sidebar code predates this guard (`src/sumo-tui/rpc/` does not exist on `main`); the clean baseline capture environment simply had no MCP config, so main shows blank rows. Same root-cause family as the D4 constants class: candidate freezes a deterministic placeholder, main is capture-environment-dependent. Traced and confirmed via direct code read of `src/mcp-config-reader.ts` and `src/sumo-tui/rpc/shell-adapter.ts:373-417`. |

## STOP — genuinely out-of-scope diff (not masked)

`splash-runtime` has 2 diff rows that do **not** fit any of the five declared classes, confirmed by exhaustive cell-by-cell classification of every differing cell across all three scenarios:

- **Row 34** (15 cells): main renders `╰─ unknown · off`; candidate renders `╰─ AWAITING PROMPT`. `AWAITING PROMPT` is the Bible-canonical splash hint (`docs/ui/bible/03-splash.html`, `src/cathedral/input-frame.ts:43`, `docs/visual/parity/BASELINE_REVIEW.md:31`) and `unknown · off` is literally listed as an error-marker string in this same scenario's own `rejectIfFinalScreenMatches` contract (`src/visual-parity-contract.test.ts:117`). Main is stale/incorrect here, not mechanically different.
- **Row 43** (48 cells): candidate renders the Bible-canonical version-line row (`SUMOCODE V0.3.0 · CATHEDRAL · 160 × 45 MONOSPACE`, per `src/footer.ts:46`, `docs/ui/bible/03-splash.html:54`); main's clean baseline capture is missing this row entirely.

Both are the candidate being *more correct* relative to Bible canon, not incidental capture noise — this is a real product difference, outside the five mechanical classes this task authorized, and not something a narrow content mask can honestly express without inventing a sixth "main has a bug/is behind canon" equivalence class. Per plan instructions, this is reported rather than masked. `active-landscape-runtime` and `active-portrait-runtime` have **zero** unclassified cells (verified by scripted cell-diff classification against every declared region) — those two scenarios are fully covered by the five declared classes and pass cleanly, including PNG crop diffs.

Recommendation: either (a) recapture the main baseline root after confirming main's actual current splash render (if `unknown · off` there is itself already fixed upstream and the clean baseline is stale), or (b) get Dhruv's explicit sign-off to add a sixth declared class for "candidate matches Bible canon, main is behind" — scoped only to `splash-runtime` rows 34/43 — before promoting this gate to a hard CI requirement.

## Over-masking guard test

Added to `src/visual-parity-contract.test.ts`, `describe("plan-024 known-equivalent-region declarations (over-masking guard)")`:

1. **"suppresses only the declared plan-024 mechanical regions and still passes"** — synthetic `active-landscape-runtime` baseline/candidate snapshot pair that differs *only* within the declared regions (real column offsets copied from an actual capture) passes `compare-captures.mjs` end-to-end, with the suppression list printed in `styled-cell-diff.txt`.
2. **"does NOT suppress a real content change adjacent to a masked region"** — same fixture, but with sabotaged text one row below the masked sidebar cwd/branch region (row 12, same column band, outside the declared `[10,11]` row range) — the gate still fails, `results.json` marks the scenario `failed`, and the sidebar crop's styled-cell diff no longer reports `MATCH`.
3. **"does NOT suppress a real content change inside the working-indicator row outside its masked column"** — sabotages text at row 36 col 3+ (the masked cell is only col 1) — still fails.

All three pass; full `src/visual-parity-contract.test.ts` suite: 14/14 passed.

## Verification battery

- `pnpm vitest run src/sumo-tui/ src/visual-parity-contract.test.ts` — 1 failed (`runtime.test.ts` sidebar dir-name assert, pre-existing on `6886e5a` before this branch's changes — confirmed via `git stash`), 625 passed.
- `pnpm exec tsc --noEmit && pnpm build` — clean.
- `pnpm test:integration` — 44/44 passed (one isolated rerun needed for `rpc-kitty-release.test.ts`, matching the documented PTY flake protocol; passed clean on full-suite rerun).
- `pnpm test` (full `src/**/*.test.ts`) — 1332/1333 passed; the 1 failure is the same pre-existing `runtime.test.ts` sidebar dir-name assert plus a `background-tasks` ENOENT teardown race, both explicitly on the allowed-failures list.

## Review artifacts

- `docs/visual/out/parity-main-rpc/` — main-vs-candidate compare output (results.json, summary.md, per-scenario raw diffs and crop PNGs).
- `docs/visual/out/parity-main-rpc/*/raw/styled-cell-diff.txt` and `styled-cell-diff-<crop>.txt` — text-level primary gate evidence, including the "Suppressed by declared equivalence" section per scenario.
- `docs/visual/out/parity/` — Bible review pack from `pnpm visual:review -- --lane runtime` (splash passed; landscape/portrait fail only against the demoted pre-D1 Bible target, expected/plan-032 debt).
