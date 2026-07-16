# Plan 068: Add the /subagents dashboard, per-agent takeover view, and /ps terminal viewer

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat d4ce41d..HEAD -- src/subagents/ src/background-tasks/ src/memory-editor.ts src/interaction-registry.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/065-subagents-core.md, plans/066-typed-deferred-result-delivery.md, plans/067-background-terminals-regrammar.md
- **Category**: direction
- **Planned at**: commit `d4ce41d`, 2026-07-15
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/306

## Why this matters

Headless children are only acceptable if the human can *see and steer* them.
The decided design (`docs/research/SUMOCODE_ORCHESTRATION_BENCHMARK_2026.md`,
P0 §2, following `davis7dotsh/my-pi-setup` `extensions/subagents/src/ui/`)
gives observability through an in-app dashboard + takeover view instead of
mandatory cmux panes: `/subagents` lists every child with live status; Enter
opens a per-agent transcript view; `x` aborts. `/ps` does the same for
background terminals. This is what lets plan 070 retire the cmux-pane-required
agent runner without losing visibility.

## Current state

- `src/subagents/manager.ts` (plan 065) — sync read model:
  `list()`, `get(id)`, `addChangeListener(fn)`, snapshots carrying
  `status/title/modelLabel/usage/transcript/liveText/liveTools/createdAt/settledAt`.
  `cancel(ids)` for abort.
- `src/background-tasks/task-manager.ts` — `listTasks()` (snapshots sorted by
  `startedAt`), `getTaskOutput(task, maxChars)` (bounded log tail, ~line 585),
  `stopTask(task)`.
- Overlay exemplar: `src/memory-editor.ts` — a full-screen interactive
  Cathedral overlay opened from a slash command and the `Ctrl+M` shortcut; its
  tests (`src/memory-editor.test.ts`) show the harness pattern for driving an
  overlay with fake input. Match its structure: a component with
  `render(width)` + key handling, mounted via the same `ctx.ui.custom`
  overlay seam it uses.
- Slash-command registration goes through the interaction registry:
  `src/interaction-registry.ts` (`registry.install("commands.review", …)` at
  ~line 146 is the exemplar; commands receive `pi` and options). New commands
  must be registered there so ownership diagnostics stay in one seam.
- Footer status exemplar: `src/task-mode.ts:231-259` uses
  `ctx.ui.setStatus(STATUS_KEY, "…")` from event handlers and clears with
  `undefined`.
- Theme/status colors: `activeThemeColors().states` —
  see `src/sumo-tui/transcript/tool-renderer.ts:43-53` (`running` → tool,
  `success` → idle, `error` → approval).
- Conventions: tabs, strict TS, colocated vitest tests, no raw ANSI —
  use `src/sumo-tui/render/primitives.ts` (`span`, `textLine`, `lineToAnsi`)
  per `AGENTS.md:133`.

## Commands you will need

| Purpose   | Command                                            | Expected on success |
|-----------|----------------------------------------------------|---------------------|
| Typecheck | `pnpm typecheck`                                   | exit 0              |
| All tests | `pnpm test`                                        | all pass            |
| One file  | `pnpm vitest run src/subagents/ui/dashboard.test.ts` | all pass          |

## Scope

**In scope**:
- `src/subagents/ui/dashboard.ts` (create) — the `/subagents` list view
- `src/subagents/ui/takeover.ts` (create) — per-agent transcript view
- `src/subagents/ui/transcript-lines.ts` (create) — pure snapshot→lines
- `src/background-tasks/ui/ps.ts` (create) — the `/ps` terminal viewer
- Colocated tests for each of the above (create)
- `src/subagents/index.ts` (register `/subagents`, footer status)
- `src/background-tasks/index.ts` (register `/ps`)
- `src/interaction-registry.ts` (install the two commands)

**Out of scope**:
- Steering input INTO a live child (the pi subprocess backend from plan 065
  cannot receive mid-run messages). The takeover view is **read-only +
  abort** in this plan; render the input affordance as
  `(steering not supported for this backend)` static text. Do not add a
  half-working input.
- The sidebar and portrait sidebar policy — no sidebar changes.
- cmux panes, `cmux_open_terminal`, visible spawns.
- Transcript pump / RPC protocol changes.

## Git workflow

- Branch: `advisor/068-fleet-dashboard-and-takeover`
- Conventional commits, e.g. `feat(subagents): /subagents dashboard + takeover view`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pure transcript-line builder (`src/subagents/ui/transcript-lines.ts`)

`buildTranscriptLines(snapshot, width): string[]` — sanitizes control
chars/ANSI/tabs, then renders:
- user items as accent-prefixed `> ` wrapped lines,
- assistant text wrapped plain; thinking as dim `~ ` lines,
- tool calls as `→ name {argsPreview}` with a one-line dim output/error line,
- the LIVE streaming buffer (`snapshot.liveText`) and `snapshot.liveTools`
  (running/done/error glyph + first output line) at the tail.

Pure function, no Pi imports — this is where most tests live.

**Verify**: `pnpm vitest run src/subagents/ui/transcript-lines.test.ts` → pass
(cases: sanitization strips ESC sequences; live tools render; width wrapping).

### Step 2: Dashboard (`src/subagents/ui/dashboard.ts`)

A list view over `manager.list()`:
- one row per agent: selection marker, status glyph
  (`▶` running / `✓` done / `✗` error, colored via
  `activeThemeColors().states`), title, dim id — right side: model label,
  elapsed (`formatElapsed`), status word;
- scroll window centered on selection with `… N more` markers;
- keys: up/down (and `j`/`k`) select, Enter opens takeover, `x` cancels the
  selected running agent (via `manager.cancel([id])`), Escape closes;
- re-render on `manager.addChangeListener` + a 1Hz ticker for elapsed columns;
  dispose both on close.

### Step 3: Takeover view (`src/subagents/ui/takeover.ts`)

Single-agent view: header line (`sa-N · title · status · elapsed · model`),
fixed-height transcript viewport fed by `buildTranscriptLines`, scroll keys
(up/down ±6 lines, page up/down), `x`/`app.clear` aborts, Escape returns to
the dashboard. Throttle re-renders to ≥50ms (streaming emits per-token
events). Read-only input line per Scope.

### Step 4: `/subagents` command + footer status

In `src/subagents/index.ts`:
- register command `subagents` opening the dashboard loop (notify-and-bail
  with a clear message when there are no subagents, mirroring how
  `/sumo:memory` handles unavailability — see `src/memory-editor.test.ts:360`);
- footer status via `ctx.ui.setStatus("subagents", …)` on every manager
  change: `subagents: 2 running · 1 done · 1 failed · /subagents to view`,
  cleared (`undefined`) when none tracked.
- install through `src/interaction-registry.ts` following the
  `commands.review` exemplar.

**Verify**: `pnpm vitest run src/subagents/ui/dashboard.test.ts` → pass
(fake manager with scripted snapshots: row rendering, selection movement,
`x` calls cancel, Enter switches to takeover, empty-state message).

### Step 5: `/ps` terminal viewer (`src/background-tasks/ui/ps.ts`)

Same dashboard skeleton over `backgroundTaskManager.listTasks()` filtered to
`runner === "shell"`: rows `bg-… [running] "title" (pid, elapsed, exit, cwd)`;
Enter shows a bounded output view (`getTaskOutput(task, 16_384)`, re-polled on
the 1Hz ticker); `x` calls `stopTask`. Register as command `ps` via the
interaction registry.

**Verify**: `pnpm vitest run src/background-tasks/ui/ps.test.ts` → pass.

### Step 6: Wire and full check

Both installers register their commands in BOTH extension profiles (the
interaction-registry seam already runs in both — confirm by reading
`src/extension.ts:217-221` and `:317-327`).

**Verify**: `pnpm typecheck && pnpm test` → exit 0, all pass.

## Test plan

- `transcript-lines.test.ts` — pure rendering (5+ cases incl. sanitization).
- `dashboard.test.ts` / `ps.test.ts` — fake-manager harness modeled on
  `src/memory-editor.test.ts` (drive keys, assert rendered rows and calls).
- `takeover.test.ts` — abort key calls cancel; scroll clamps; throttle
  coalesces two immediate change events into one render (fake timers).
- Extend `src/subagents/index.test.ts` — footer status string transitions
  running→done and clears at zero.

## Done criteria

- [ ] `pnpm typecheck` exits 0; `pnpm test` exits 0
- [ ] `/subagents` and `/ps` registered through `src/interaction-registry.ts`
- [ ] Dashboard `x` cancels; takeover is read-only (no input dispatch code path)
- [ ] Footer status appears with ≥1 subagent and clears at 0 (test-proven)
- [ ] No raw ANSI string concatenation — primitives used (spot-check imports)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- The `ctx.ui.custom` overlay seam used by `src/memory-editor.ts` is not
  available from a slash-command context in the RPC child profile — report
  which profile fails and where it diverges.
- `ctx.ui.setStatus` from manager change listeners has no `ctx` available
  (listeners fire outside command/event contexts) and no equivalent seam
  exists — report; do not cache a stale ctx.
- Rendering the dashboard requires modifying the modal/region layer
  (`src/sumo-tui/widgets/modal*.ts`) — out of scope; report the missing
  capability.
- The 1Hz ticker keeps the process alive after session shutdown (timer not
  unref'd/disposed) and the fix isn't local to your files.

## Maintenance notes

- When a steerable backend lands (in-process pi sessions or a future
  claude/codex harness), the takeover input line is the ONLY place to enable
  send — `manager.send(id, text)` should steer-if-running / new-run-if-idle.
- The dashboard is the natural home for plan 069's worktree/branch column and
  a future cost column — keep row rendering data-driven.
- Portrait: the dashboard is a full-screen overlay, so the portrait sidebar
  policy is unaffected; reviewers should confirm at 40×100 (see
  `test/integration/narrow-width.test.ts` for the harness if evidence asked).
