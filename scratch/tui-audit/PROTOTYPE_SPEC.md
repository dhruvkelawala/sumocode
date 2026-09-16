# SumoCode TUI — Ultraviolet prototype spec

Prototypes for the 2026-09 TUI audit. Cathedral canon stays (framed messages, Scriptorium panels, five preattentive states, restrained palette). Theme: **ultraviolet-core** only.

Output dir: `scratch/tui-audit/proto/` (served at `https://sumodeuss-mac-mini.tailbc93c6.ts.net/tui-audit/proto/`). NOT the bible — these are explorations; winners get promoted later.

## Spatial thesis

Primary reading path for the user (who monitors agents with ledgers expanded): **newest SUMO frame → its ledger stack → tail lines**. Secondary: SUMO prose. Tertiary: USER prompt. Peripheral: sidebar (who is working), footer (what state), top bar (where am I).

Each chrome band owns one question:

| Band | Question | Content |
|---|---|---|
| Top bar | where am I | `SUMOCODE` · active session `║ • name ║` · recent sessions as dim tabs. **No ARCHIVE, no icons.** Right zone empty. |
| Sidebar | who is working | `# REGISTRY` · hero project/branch · CONTEXT bar · SESSION cost · MCP roster · **AGENTS roster** · **TERMINALS roster**. **No CONTEXT/MEMORY tab row.** |
| Footer | what state | `● READY · gpt-5.5 · medium` left · right: `⌃O ledgers · ⇧⇥ thinking · ⌃P model · ⌃/ commands` (4 items max) |
| Input | what I say | unchanged 3-row frame, but corners `╭╮╰╯` (today `┌┐└┘` — inconsistent) |

## Spacing scale (rows)

| Gap | Rows | Where |
|---|---|---|
| 0 | none | inside a ledger stack (ledgers share edges via `├─ … ┤`); USER frame bottom → its SUMO reply top |
| 1 | one blank | prose paragraph ↔ ledger stack inside SUMO; between turns (SUMO bottom → next USER top) |
| 2 | two blank | never in transcript; sidebar between section groups only |

Today every gap is 1 row so nothing groups. The scale must be visible in the "after" scenes.

## Ledger stack (the hero surface)

Consecutive tool calls in one SUMO frame form ONE frame with `├─ … ─┤` dividers. Closed on the right. Inside surface `#100A1D`, border `#56347A`.

```
╭─ [read] src/auth/session.ts ───────────────────────────── ✓ 340 lines ─╮
│   1  import { z } from "zod";                                           │
│   2  import type { User } from "./user.js";                             │
│   3  import { Result } from "../result.js";                             │
│ ↓ 337 more lines                                                        │
├─ [edit] src/auth/session.ts ──────────────────────────────── ✓ +14 −6 ─┤
│ @@ 41,7 @@ export function getSession                                    │
│ -   return user;                                                        │
│ +   return Result.ok(user);                                             │
│ ↓ 2 more hunks                                                          │
├─ [bash] pnpm test src/auth ──────────────────────────────────── ▶ 00:12 ┤
│ > pnpm test src/auth --reporter=verbose                                 │
│ ↑ 230 earlier lines                                                     │
│ ✓ src/auth/session.test.ts > revoke > idempotent                        │
│  Tests  22 passed (22)                                                  │
╰─────────────────────────────────────────────────────────────────────────╯
```

Rules:
- Header: `[name]` in tool-label violet, target in fg, rule in border, status right-anchored: glyph + summary.
- Status glyphs: `○` queued (dim) · `▶` running (tool amber) + live elapsed `mm:ss` · `✓` settled (fg-idle lavender, quiet) · `✗` failed (approval pink) + `exit N`.
- Only running and failed carry color. Success is quiet.
- Body policy by tool: **read** = head peek (3–6 lines, gutter line numbers dim) + `↓ N more lines`; **edit** = first hunk(s) unified diff, `-` approval pink, `+` learning cyan, `@@` dim; **bash/terminal** = pinned `>` invocation row (full command, wraps ≤4 rows) + `↑ N earlier lines` fold + live tail; **subagent** = `name · role · model` header, body = last 3 activity lines + budget/elapsed row; **write** = path + `N lines written`; **mcp** = server·tool + result peek.
- Fold rows are dim, prefixed `↑`/`↓`. Never `…` alone.
- Failed ledger: header rule stays border color, status `✗ exit 1` in approval pink, body note in approval pink, last 4 stderr lines in fg, e.g. `│ ✗ src/auth/session.test.ts > refresh > rejects expired  AssertionError…`.
- Long targets/commands in the header truncate with `…`; the `>` row carries the full text.

## Message frames

- USER: `╭ USER ───╮` framed (canon), fg text. Variant **01b**: compact single row `❯ run tests` in fg with dim `11:42` right-aligned, no frame — show both.
- SUMO streaming: header right zone shows `@ 00:04` (theme spinner glyph in accent + elapsed) instead of the timestamp; text ends with an accent `▌` cursor cell; a folded thinking row `· thinking 1.2k tokens` in dim above prose.
- SUMO settled: header right `11:42` dim (as today).
- Prose stays fg; inline code in learning cyan.

## Docked panels (replaces centered modals)

Divine Query, approval, /resume, /tree all render **in the input band** (the input frame grows), transcript fully visible above. Keep the Scriptorium chrome the user likes: `✾ TITLE ✾` masthead centered on the top rule, `❋` focus mark, `·` unfocused mark, split-rule `─── · ───`, hint row. Panel bg `surface-lifted #1B102E`, frame `╭╮╰╯` in border. Footer state during a query: `◆ AWAITING` in approval pink.

Divine Query (04):
```
╭─────────────────────────── ✾ DIVINE QUERY ✾ ───────────────────────────╮
│ Should I rename `getUser` to `fetchUser` across the auth module?         │
│                                                                          │
│ ❋ A) Yes, rename it everywhere                                           │   ← focused row: fg text, ❋ accent, row bg surface-recess? no — keep flat, ❋ is enough
│ · B) No, leave it as-is                                                  │
│ · C) Use a different name                                                │
│ ───────────────────────────────── · ──────────────────────────────────── │
│ ↑↓ wander   ⏎ answer   ⎋ retreat                                         │
╰──────────────────────────────────────────────────────────────────────────╯
```

Approval (04b) — same shell, title `✾ APPROVAL · bash ✾`, command in a recess box (`surface-recess` bg) inside the panel, options `allow once / allow for session / deny`, deny row in approval pink when focused.

/resume (05): title `✾ RESUME ✾`, right of masthead rule `12 sessions` dim; search row `❯ type to search…`; section headers `TODAY` / `YESTERDAY` / `OLDER` in dim tracked caps; rows = `name` fg (dim when unfocused) · `branch` dim · `N turns` dim · age right-aligned; focused row gets `❋` and fg. Hint row `↑↓ choose  ⏎ select  ⇥ scope  ⎋ cancel`.

/tree (06): title `✾ SESSION TREE ✾`; tree connectors `│ ├ └` in border color, aligned; `▷` user prompts fg, `✦` assistant replies dim, current node `●` accent; age column right-aligned; same hint row.

## Sidebar (30 cols, no memory)

```
  # REGISTRY
  ──────────────────────────
  sumocode
  on main

  > CONTEXT
  ▉▉▉▉▉░░░░░░░░░░░░░░░░░
  42k / 200k

  ~ SESSION
  $0.42 · 3.4M cumul
  ──────────────────────────
  * MCP
  ● github              idle
  ● stitch                ok

  ● AGENTS
  ▶ audit-render   research  4:12
  ▶ audit-ux       research  3:58
  ✓ bible-tooling  research
  ──────────────────────────
  ▶ TERMINALS
  ▶ pnpm dev            :8797
```
Section glyphs stay ASCII (`# > ~ * ●`). Active tab row and MEMORY removed; that frees 2 rows. AGENTS/TERMINALS fill the dead space with monitoring data. Fix `> > CONTEXT` (never double the glyph).

## Scenes to produce (160×45 unless noted)

| id | file | content |
|---|---|---|
| 00 | `00-baseline.html` | TODAY's ultraviolet runtime, faithfully: open-right ledgers, `> > CONTEXT`, MEMORY tab, ARCHIVE+icons, `┌┐` input, 1-row gaps everywhere. Use the fixture-tool-ledger transcript (2 turns). This is the "before". |
| 01 | `01-rhythm.html` | Same transcript, all "after" chrome + spacing scale + ledger stack. |
| 01b | `01b-rhythm-compact-user.html` | 01 with compact USER rows. |
| 02 | `02-ledger-states.html` | One long SUMO frame: ledger stack showing read / edit / write / bash running / bash failed / subagent running / subagent settled / mcp / terminal. Footer `● TOOL`. |
| 03 | `03-streaming.html` | Mid-turn: thinking fold, prose with `▌`, running bash tail, `@ 00:04` header, working indicator row, footer `◐ THINKING`. |
| 04 | `04-divine-query-docked.html` | Transcript from 01 + docked Divine Query. |
| 04b | `04b-approval-docked.html` | Transcript + docked approval for `rm -rf node_modules && pnpm install`. |
| 05 | `05-resume-docked.html` | Transcript + docked /resume, 8 sessions across TODAY/YESTERDAY/OLDER. |
| 06 | `06-tree-docked.html` | Transcript + docked /tree (use the tree from `docs/visual/out/parity/tree-selector-component/runtime-full.png`). |
| 07 | `07-portrait.html` | 60×100, no sidebar, 01's transcript with ledger stack wrapping, footer with ctx/cost, portrait streaming cue. |
| 08 | `08-empty.html` | Fresh session after splash: empty transcript with centered dim quote + 4-line hotkey legend; sidebar with AGENTS/TERMINALS empty states (`no agents running` dim). |

Plus `index.html`: gallery, each scene = title, one-line intent, PNG at full width, link to HTML. 00 vs 01 shown side by side at the top.

## Build

- One generator `scratch/tui-audit/proto/gen.mjs`, self-contained. Copy helpers (`rep`, `visibleLen`, `padRight`, `esc`, `gridLine`, `frameMessage`, `buildInputFrameRows`, `buildFooterRow`, scene skeleton + CSS var block) from `scripts/gen-bible-theme-ultraviolet-core.mjs`. Same `.term/.grid/.box-fill` structure so it matches the bible pipeline byte-for-byte in conventions.
- Copy `docs/ui/bible/_assets/` → `scratch/tui-audit/proto/_assets/` (tokens.css + fonts) and reference as `_assets/tokens.css`.
- Renderer `scratch/tui-audit/proto/render.mjs`: Playwright, viewport 1800×1200, DPR 2, `[data-render-rect]` screenshot, `document.fonts.ready` + 120 ms settle. Use `executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell"` (default headless shell 1217 is missing locally).
- All cell arithmetic must be exact: `visibleLen` counts 1 cell per char; every `box-fill` span carries an explicit `width: Nch`. Glyphs used are all single-cell (`╭╮╰╯─│├┤▉░●▶✓✗○❋✾✦▷↑↓❯▌◆◐@`). Do not use `⚙` or Nerd-Font PUA glyphs.
- Verify by rendering all scenes and viewing the PNGs; fix misaligned right borders before finishing.
