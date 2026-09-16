# SumoCode TUI audit — September 2026

Method: three independent read-only research passes (render surfaces, functional UX, bible-vs-runtime) + one tooling pass, synthesized here through the Impeccable critique frame in **Operate** mode. Mechanical detector was not run on the runtime (it scans HTML, not ANSI); it runs on the prototype HTML instead. Baseline commit `bfa5462d`. Theme under review: **ultraviolet-core** (user default). Evidence is `file:line` in this repo or a parity scenario id under `docs/visual/out/parity/`.

User profile that shaped priorities: monitors agents with **ledgers expanded**; wants correct spacing, better tool/message frames, top-bar items that earn their place, a practical approval modal, nicer `/resume` `/tree` selectors, and no Memory module.

Prototypes: `scratch/tui-audit/PROTOTYPE_SPEC.md` → `scratch/tui-audit/proto/index.html` (served at `/tui-audit/proto/` on the tailnet).

## Design health

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | Running ledger shows static `▶` + "waiting for output…", no elapsed, no tail; portrait has no streaming cue at all (`shell-adapter.ts:509-524`); queued follow-ups have no count |
| 2 | Match system / real world | 3 | Tool vocabulary is fine; `read` expands to "no output captured" (`activity-renderer.ts:30,306`) — says nothing where a range/size would |
| 3 | User control & freedom | 3 | Esc/Ctrl-C tiers are good (`interrupt.ts:24-45`); Home/End are stolen from the editor for transcript jumps (`chat-scroll-command.ts:13-19`) |
| 4 | Consistency & standards | 1 | Ledgers open on the right, every other frame closed (`activity-renderer.ts:190,210,248`); input frame `┌┐` vs `╭╮` everywhere else (`input-frame.ts:141-177`); `↳` means three things; `• ● ·` three dot vocabularies; keybind casing mixed |
| 5 | Error prevention | 3 | Approval gate is externally owned (Plan 076); n/a-ish for the shell itself |
| 6 | Recognition over recall | 1 | Only `Ctrl+/` is painted anywhere (`input-frame.ts:47`); Ctrl+P, Shift+Tab, Ctrl+O, Alt+Enter, Ctrl+L, Alt+T are invisible; palette is 6 mode rows, not commands (`host-actions.ts:1451-1466`) |
| 7 | Flexibility & efficiency | 3 | Good chord coverage in `editor.ts:599-641`; four of them are declared but unwired (Ctrl+Z, Ctrl+T, Ctrl+N, Ctrl+G) and fail silently |
| 8 | Aesthetic & minimalist | 2 | Top bar right zone is four dead ornaments (ARCHIVE + 2 PUA icons, `recentSessions: []` at `shell-adapter.ts:645`); sidebar has ~9 dead rows and a MEMORY tab that is hardcoded off (`shell-adapter.ts:666`); every transcript interval is 1 row so nothing groups |
| 9 | Error recovery | 2 | Failed ledger note renders in `bodyMuted` — the `✗` glyph is the only failure ink (`activity-renderer.ts:114-122`); child-death notice lives ~750 ms before altscreen restore erases it (`host.ts:885-920`) |
| 10 | Help & documentation | 1 | No `/help`; `/hotkeys` omits ~11 chords and advertises Ctrl+C copy that cannot fire (`host-actions.ts:389-420`) |
| **Total** | | **21/40** | **Acceptable** — solid palette and frame canon, undermined by inconsistency and invisibility |

## Design specificity verdict

Authored, not interchangeable. The Cathedral frames, Scriptorium panels, five-state palette and the ultraviolet role table are a real point of view, and the runtime honours the theme chrome almost everywhere (`chat-message.ts:147-188`, `modal-layer.ts:87-92`, `sidebar-rendering.ts:77-233`). The failures are not taste — they are **the canon applied unevenly**: one surface (tool ledgers) skipped the frame rule, one band (top bar) kept placeholders that never got wired, and the spacing has one value where the canon needs a scale.

## What's working

- **Frame canon and palette.** `╭ SUMO ─── 11:42 ─╮` with quiet lavender body and violet accents reads instantly; the five states are genuinely preattentive in ultraviolet (all contrast checks pass, unlike cathedral's dim/comment tokens at 2.9–4.4:1).
- **Interrupt tiers.** Esc / Ctrl-C peel one layer at a time (modal → draft → stream → quit) — the best-designed interaction in the shell.
- **Typed render primitives.** `src/sumo-tui/render/primitives.ts` means the fixes below are local; there is no ANSI archaeology needed.

## Priority issues

**[P1] Ledgers break the frame rule and have no rhythm.** Tool ledgers are the user's primary reading surface and they are the one frame that is open on the right (`activity-renderer.ts:190,210,248`). Stacked ledgers are separated by the same 1-row gap as prose↔ledger and turn↔turn (`fixture-tool-ledger-landscape` rows 9–17), so a turn reads as a flat list. *Fix:* close the frame; merge consecutive ledgers into one stack with `├─ … ─┤` dividers (0-row gap); keep 1 row between prose and stack, 0 rows between USER and its SUMO reply, 1 row between turns. Prototype `01-rhythm`.

**[P1] Expanded bodies are lower-information than the collapsed pill.** `read` → "no output captured"; `edit` → one summary line, no hunk; bash → head-only, capped at 25 lines so the pass/fail line is exactly what gets cut (`activity-renderer.ts:24-30,290-306`); running → "waiting for output…" with no elapsed. *Fix (user-chosen):* bash/terminal = pinned `>` invocation + `↑ N earlier lines` fold + live tail + `▶ mm:ss`; read = head peek with line-number gutter + `↓ N more`; edit = first hunk as unified diff (`-` approval, `+` learning); subagent = last 3 activity lines + elapsed. Prototype `02-ledger-states`, `03-streaming`.

**[P1] Chords are invisible.** Twelve real accelerators, one painted. `/hotkeys` is wrong. Palette isn't a command palette. *Fix:* footer right zone shows the 4 most valuable chords (`⌃O ledgers · ⇧⇥ thinking · ⌃P model · ⌃/ commands`); render `/hotkeys` from `APP_KEYBINDING_DEFINITIONS`; alias `/help`; palette footer says "type / for all commands". Prototype `01-rhythm` footer, `08-empty` legend.

**[P2] Top bar carries four dead ornaments.** `ARCHIVE`, terminal icon, gear icon have no handlers; the header comment promises `Ctrl+\` and `Ctrl+,` that don't exist (`top-chrome.ts:1-20,70-72,109-112`); recents are rendered but never populated. *Fix:* cut all three; wire recents from the session list (Plan 089 owns naming). Top bar answers "where am I", nothing else. Prototype `01-rhythm`.

**[P2] Centered modals hide the transcript the user is deciding about.** Divine Query / approval paint a full backdrop over the SUMO frame (`modal-layer.ts` centerRows). `/resume` and `/tree` already dock in the input band (`inline-selector.ts:14-33`) but are visually flat (all-dim rows, no columns, unaligned connectors). *Fix:* dock Divine Query and approval the same way, keeping the Scriptorium chrome (`✾ TITLE ✾`, `❋`, split rule, hint row) on `surface-lifted`; give selectors section headers, aligned metadata columns and a focused row. Prototypes `04`, `04b`, `05`, `06`.

**[P2] Failure is whispered.** Failed notes render dim; `✗` in the far right corner is the only signal. *Fix:* approval ink on the status + note, last stderr lines in fg, `exit N` in the header. Prototype `02-ledger-states`.

**[P3] Sidebar dead space and dead tab.** MEMORY tab is hardcoded off in RPC and the module is unused; ~9 rows sit empty below MCP. *Fix:* delete the memory module and tab row; fill with AGENTS + TERMINALS rosters (live monitoring data, exactly what this user wants). Prototype `01-rhythm` sidebar.

## Persona red flags

**Alex (power user — this is the user).** Runs 3–10 subagents and reads ledgers. Cannot see elapsed time on any running tool; cannot see which subagent is stalled without `subagent_list`; must remember Ctrl+O toggles *all* cards though every pill says "ctrl+o expand" (`chat-pager.ts:521-560`); Home/End jump the transcript when he wanted the line start; Ctrl+T does nothing and says nothing.

**Riley (stress tester).** 500-line bash output: sees lines 1–25, never the summary. Failed test run: `✗` glyph only, note dim, no stderr. RPC child crash: error visible for 750 ms then wiped. Fresh session with sidebar: blank transcript region, no empty state (`empty-chat-quote.ts` never mounted).

**Jordan (first-timer).** Two unlabeled Nerd-Font glyphs in the top bar that render as tofu without a patched font; `/help` → "unknown command"; palette offers SESSION/MODEL/THINKING/MEMORY/THEME/SETTINGS and nothing else.

## Minor observations

- `> > CONTEXT` doubled glyph when `tabActive === sectionGlyphs.context` in ultraviolet (`sidebar-rendering.ts:235-236`, `ultraviolet-core.ts:64,67`).
- `# REGISTRY` sigil declared in theme chrome but the label is hardcoded (`sidebar-rendering.ts:227`).
- Splash version line hardcodes `V0.7.1 · CATHEDRAL · 160 × 45` (`footer.ts:70`) — wrong theme, wrong size in portrait.
- History fold is a fake `╭ SYSTEM ╮` frame (`chat-pager.ts:1560-1566`); should be an unframed `── N earlier messages ──` rule.
- Truncation: pills cut silently, code lines clip at the border with no `…`, sidebar slices by index not cells (`sidebar-rendering.ts:65-69`).
- Harness: styled-cell target grid paints chat interiors `surface-recess` while spec locks transparent (`styled-cell-grid.mjs:206`) — runtime is right, target is wrong; this inflates every fixture diff.
- `docs/ui/stitch/ultraviolet-core/DESIGN.md` still documents the amber tool roles that were replaced.
- Cmd+C copies but never confirms (`shell-adapter.ts:206-213`).
- Notices are last-writer-wins, one slot (`notification.ts:80-101`).

## Questions to consider

- If the ledger stack is the reading surface, should the USER frame shrink to one row (`❯ prompt · 11:42`)? Prototype `01b` shows it.
- Should the SUMO header carry the live turn timer while streaming, so "how long has this been going" never needs the footer?
- What does the sidebar AGENTS roster show when a child is stalled — and is that the moment the footer dot should go amber?

## Removal ledger (housekeeping, not the win)

Memory module: `src/memory*.ts` (+tests), sidebar tab + `Ctrl+1/2` (`sidebar.ts:294-306`, `sidebar-rendering.ts:7-8`), palette MEMORY mode (`command-palette.ts:9,63,301,344`), `/sumo:memory` + editor in `host-actions.ts:13-24,167,694,829,1386-1460`, bible `01-sidebar-*memory*`, `07-memory-editor*`, `scene-memory-scriptorium-overlay`, parity scenario `fixture-memory-scriptorium-overlay`, README inventory count.

Top bar: `ARCHIVE_LABEL`, `ICON_TERMINAL`, `ICON_SETTINGS`, `iconsSegment` in `top-chrome.ts`; bible `02-topbar-*` regenerate.

## Implementation order (after prototype approval)

1. Ledger frame close + stack + spacing scale — `activity-renderer.ts`, `chat-message.ts` (one PR; the harness fixtures will show the diff).
2. Ledger bodies: tail policy + pinned invocation + elapsed; read/edit/subagent bodies — `activity-renderer.ts`, `tool-renderer.ts`.
3. Failure ink — `activity-renderer.ts:114-122`.
4. Top bar cut + recents wiring — `top-chrome.ts`, `shell-adapter.ts:638-648`.
5. Footer chord zone + `/hotkeys` from definitions + `/help` alias — `footer.ts`, `host-actions.ts`.
6. Dock Divine Query/approval; restyle selectors — `extension-ui-responder.ts`, `inline-selector.ts`, `divine-query.ts`.
7. Sidebar: memory removal, AGENTS/TERMINALS rosters, `> >` fix — `sidebar-rendering.ts`, `shell-adapter.ts`.
8. Input frame corners from theme chrome; history fold; empty state; splash version line.
9. Harness target-grid fix so parity diffs go quiet.

## Decisions (grill, 2026-09-15)

Locked with Dhruv, one question at a time, each against a rendered prototype in `scratch/tui-audit/proto/`. These supersede the proposals above where they differ.

| # | Decision |
|---|---|
| 1 | Consecutive tool calls in a SUMO frame merge into one **ledger stack**: `╭─ … ─╮` / `├─ … ─┤` / `╰───╯`, closed on the right. One blank ledger row after each entry's body; header flush to its body. |
| 2 | Bash/terminal ledgers **always** show the `> command` row (full command, wraps ≤ 4 rows), then `↑ N earlier lines`, then the tail. |
| 3 | Tail size: **12 rows running · 4 rows settled-ok · 12 rows failed** (was 29 head-only). |
| 4 | `read` body: **5-line peek** with dim gutter numbers, header carries the range (`✓ lines 120–180 of 340`), peek starts at the range start. |
| 5 | `edit` body: **first hunk, cap 12 rows**, `-` approval / `+` learning / `@@` dim, `↓ N more hunks · M lines`; header `+14 −6 · 3 hunks`. |
| 6 | Failure ink: **border stays violet**; `✗ exit N` + note + failing lines in approval pink. State lives in glyph + ink, never in chrome. |
| 7 | Subagent ledger: headless running = last 3 activity lines + `tokens · $ · elapsed`; **pane running = one row** `⧉ w32:p5 · running in a visible pane · mm:ss`; settled = branch · manifest headline, first line of final message, cost; stalled = `◆ stalled` pink + reason. |
| 8 | SUMO header: `@ mm:ss` (spinner + turn elapsed) while streaming; **`11:43 · 1m 04s`** on settle, elapsed shown when ≥ 10 s. |
| 9 | Thinking **on by default and visible**: `· thinking 1.2k tokens · 4s` header row, reasoning in dim with 2-col indent while streaming; **folds to the header row on settle**, `^O` unfolds. Thinking off: single row `@ Sumo is thinking…` until first token. |
| 10 | USER frame stays **framed** (not compact). Spacing scale: USER→SUMO 0 rows, prose↔stack 1, turn↔turn 1. |
| 11 | Top bar: ARCHIVE and gear **removed**. Right zone = terminal icon: Nerd Font `` when `SUMOCODE_NERD_FONT` (or settings toggle) is declared, else `⧉ shell`; click or `⌃\` splits the Herdr pane 50 % on the longest edge and opens `$SHELL` in the project cwd; hidden outside Herdr. |
| 12 | Top bar left: **3 recent sessions** as dim clickable tabs from the `/resume` list (excluding active), label = session name → first ~24 chars of first prompt → 8-hex id. `^R` opens `/resume`. |
| 13 | Footer right (landscape): `^O ledgers · ⇧⇥ thinking · ^P model · ^/ commands`, lower-case. **`^O` does not fire today — P1 bug** (duplicate `ctrl+o` binding at `editor.ts:640`, Herdr intercept, or tty `discard` char). |
| 14 | Docked panels (Divine Query, approval, `/resume`, `/tree`) render **in the input band at chat width (128)**, sidebar continuous beside them, Scriptorium chrome kept (`✾ TITLE ✾`, `❋`/`·`, split rule, hint row) on `surface-lifted`. Footer `◆ AWAITING` pink during a query. |
| 15 | Approval focus default `allow once`; `⎋` = deny. Divine Query focuses option A. |
| 16 | `/resume`: TODAY / YESTERDAY / OLDER groups, columns `name · branch · N turns · age`, `⇥ scope` kept. `/tree`: ages on user-prompt rows only, connectors in border colour, `●` current node. |
| 17 | Sidebar = **hybrid** (`09e`): `# REGISTRY sumocode · main`, CONTEXT bar, SESSION, then MCP / AGENTS / TERMINALS each with `blank · rule · blank` above and a count on the heading. Headless child = 2 rows (name·elapsed + last activity); pane child = 1 row with `⧉ pane-id`; stalled = `◆` pink + reason. One blank between agent units. No MEMORY tab. Fix `> > CONTEXT`. |
| 18 | Sidebar overflow: **settled children collapse first** (to 1 row, then hidden) with a `· N more` dim row; running/stalled stay full. |
| 19 | Portrait (60×100): no sidebar; footer left gains **`● N agents`**, `◆` pink when any child is stalled. |
| 20 | Splash: **keep today's hint row** (`╰─ model · thinking` / `CTRL+/ · COMMANDS`). Only: live version line (`v0.9.2 · ULTRAVIOLET CORE · 160 × 45`) and `╭╮` corners from theme chrome. No legend, no recents. |
| 21 | `^O` cycles **expanded → settled-collapsed (running/failed stay open) → all collapsed**. |
| 22 | **Home/End → editor; Ctrl+Home/Ctrl+End → transcript.** |
| 23 | Copy: notify `copied · N chars` (2 s) on OSC52; fix `/hotkeys` (no Ctrl+C copy). Ledger focus / `^Y` deferred. |
| 24 | Sticky notices append `· esc to dismiss`. No backlog. |
| 25 | RPC child death: after altscreen restore, print reason + last 20 stderr lines to the real terminal. |
| 26 | Memory removal is **its own PR, first**. |
| 27 | Dependencies: `yoga-wasm-web` → `yoga-layout@3.2.1` (zero geometry drift); hand-rolled highlighter → **Shiki 4.4.3 + Oniguruma engine** (cold path Node 178→102 ms, Bun 1024→109 ms). Both merged to `main` 2026-09-15. |

Not adopted: compact USER rows (`01b`), pink ledger border on failure, chord legend or recent-sessions strip on splash, full-width docked panels, notice backlog, `^Y` ledger copy.
