# Plan 072: Terminal-host abstraction — make worktrees, splits, and notifications work under herdr and cmux

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9a2f458..HEAD -- src/commands/cmux-split.ts src/commands/worktree.ts src/commands/diff.ts src/commands/review.ts src/background-tasks/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. (Plan 071 touches
> `src/commands/worktree.ts` — if it has landed, port its fresh/reopen modes
> through the new facade too; that is expected drift, not a STOP.)

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/071-on-demand-interactive-worktrees.md (same file: `src/commands/worktree.ts`; land 071 first)
- **Category**: direction
- **Planned at**: commit `9a2f458`, 2026-07-16
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/311

## Why this matters

Every SumoCode surface that opens a pane, closes a pane, or fires a desktop
notification is hardcoded to **cmux** (`CMUX_SURFACE_ID` env probes, `cmux
new-split`/`respawn-pane`/`close-surface`/`notify` CLI calls). The user also
works in **herdr** (herdr.dev, v0.7.0 verified locally) — a terminal
workspace manager for AI agents with a socket API whose CLI covers the same
operations (`pane split/run/close`, `notification show`, plus native
`worktree` and agent-state primitives). Under herdr today, `/sumo:worktree`,
`/sumo:diff`, `/sumo:review` split panes, and visible background tasks all
fail with "requires a cmux surface". This plan introduces a small
terminal-host adapter so those features work under **either** host and
degrade with an honest message under neither.

## Current state

Verified against herdr 0.7.0 with a running server (protocol 14) on this
machine, and repo commit `9a2f458`.

### Herdr facts (verified via `herdr --help` and read-only calls)

- Detection env (set inside herdr panes; see the herdr-installed Pi
  integration at `~/.pi/agent/extensions/herdr-agent-state.ts`):
  `HERDR_ENV === "1"`, `HERDR_SOCKET_PATH`, `HERDR_PANE_ID`.
- CLI responses are JSON on stdout. Example (real output):

  ```json
  {"id":"cli:pane:list","result":{"panes":[{"agent":"codex","agent_status":"idle",
   "cwd":"/Users/…/argent-x","focused":true,"pane_id":"w1:p2","tab_id":"w1:t2",
   "terminal_id":"term_656a2c18546c81","workspace_id":"w1"}],"type":"pane_list"}}
  ```

- Relevant commands:
  - `herdr pane split [--pane ID|--current] --direction right|down [--cwd PATH] [--env K=V] [--focus|--no-focus]`
  - `herdr pane run <pane_id> <command>` (command text + Enter into the pane's shell)
  - `herdr agent start <name> [--cwd PATH] [--split right|down] [--env K=V] -- <argv...>` (spawn argv directly)
  - `herdr pane close <pane_id>` · `herdr pane focus` · `herdr pane read <pane_id> [--lines N]`
  - `herdr notification show <title> [--body TEXT] [--sound none|done|request]`
  - `herdr worktree create/open/list/remove` (native, git-aware — NOT used in v1, see Out of scope)

### SumoCode's cmux coupling (the seam to abstract)

- `src/commands/cmux-split.ts` — the plumbing:
  - `isInCmux()` (line 3): probes `CMUX_SURFACE_ID`/`CMUX_WORKSPACE_ID` env
  - `SplitDirection` (line 29): `"left" | "right" | "up" | "down"`
  - `buildShellCommand(cwd, command)` (line 85): login-shell `cd && …` wrapper
  - `openCommandInNewSplitWithRefs(pi, direction, command)` (line 208):
    identify → snapshot panes → `new-split` → diff panes → `respawn-pane`;
    returns `{ ok, workspaceRef, surfaceRef } | { ok: false, error }`
  - `openCommandInNewSplit` (line 266): ref-less wrapper
- Consumers (Step 1 re-inventories; known today):
  - `src/commands/worktree.ts` — `isInCmux` guard + `openCommandInNewSplit`
    (lines 113–137; error text `"/sumo:worktree requires a cmux surface"`)
  - `src/commands/diff.ts` / `src/commands/review.ts` — hunk/review panes via
    the same helpers (`chooseDiffSplitDirection` lives in diff.ts)
  - `src/background-tasks/task-manager.ts` —
    `spawnTask` visible guard (~line 536: `if (visible && !isInCmux()) throw …`),
    `spawnVisibleTask` → `openCommandInNewSplitWithRefs`,
    `stopTask` → `cmux close-surface` (~line 1126),
    `fireCmuxNotify` → `cmux notify` (~line 1008)
  - `src/background-tasks/task-types.ts` —
    `cmux?: { workspaceRef, surfaceRef }` on the task record;
    `BACKGROUND_TASK_META_SCHEMA_VERSION = 2`
- Conventions: tabs, strict TS, typed `{ ok } | { ok:false }` results (match
  `cmux-split.ts` and `git/worktree.ts`), colocated vitest tests with
  injected exec fns (see `src/commands/cmux-split.test.ts` and
  `src/spike/cmux-background/cmux-adapter.test.ts` for the fake-exec pattern).

## Commands you will need

| Purpose   | Command                                              | Expected on success |
|-----------|------------------------------------------------------|---------------------|
| Typecheck | `pnpm typecheck`                                     | exit 0              |
| All tests | `pnpm test`                                          | all pass            |
| One file  | `pnpm vitest run src/terminal-host/herdr.test.ts`    | all pass            |
| Recon     | `herdr status` / `herdr pane list`                   | JSON output (read-only) |

## Scope

**In scope**:
- `src/terminal-host/types.ts`, `detect.ts`, `cmux.ts`, `herdr.ts`,
  `index.ts` (create) + colocated tests
- `src/commands/worktree.ts`, `src/commands/diff.ts`,
  `src/commands/review.ts` (port to the facade)
- `src/background-tasks/task-manager.ts` + `task-types.ts` (facade + pane-ref
  generalization with schema back-compat)
- `src/commands/cmux-split.ts` (becomes the cmux implementation's guts; keep
  its exports working so untouched callers don't break)

**Out of scope**:
- `herdr worktree create/open` native integration — v1 keeps
  `src/git/worktree.ts` as the single source of truth for worktree layout
  (`sumo/<slug>` branches, sibling dirs, never-auto-remove) and opens plain
  panes on both hosts. A follow-up may add herdr-native worktree workspaces;
  record it, don't build it.
- `herdr agent send`/`wait agent-status` orchestration hooks (future
  Orchestration-v2 synergy; see Maintenance notes).
- `src/commands/tabs.ts` and any other cmux-tab-specific command found in
  Step 1: leave cmux-only with its existing guard; list it in the report.
- The `cmux_open_terminal`-style user tooling outside this repo.
- Removing cmux support or changing cmux behavior in any observable way.

## Git workflow

- Branch: `advisor/072-terminal-host-abstraction`
- Conventional commits, e.g. `feat(terminal-host): herdr + cmux adapter seam`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Inventory + herdr recon (read-only)

1. `rg -n "isInCmux|openCommandInNewSplit|cmux notify|close-surface|CMUX_" src/ --type ts`
   — classify every hit: port here / cmux-only-by-design / out of scope.
2. Recon the two mutation commands' stdout shapes IN A THROWAWAY herdr
   session (`herdr --session sumocode-072-recon`, then `herdr session` docs;
   never mutate the user's live session): run `herdr pane split --current
   --direction right --cwd /tmp` and `herdr agent start recon-test --cwd /tmp
   --split down -- sleep 5`, capture stdout, close the panes, kill the recon
   session. Record: does each return JSON containing the new `pane_id`?
   Choose the spawn primitive accordingly (prefer `agent start -- bash -lc
   '<command>'` if it returns the pane id — one call, argv-exact; otherwise
   `pane split` + `pane run`).

**Verify**: classification list + captured JSON shapes attached to the Step-2
commit body.

### Step 2: The facade (`src/terminal-host/`)

```ts
// types.ts
export type TerminalHostKind = "cmux" | "herdr" | "none";
export interface PaneRef { host: Exclude<TerminalHostKind, "none">; paneId: string; workspaceId?: string }
export type HostResult<T> = ({ ok: true } & T) | { ok: false; error: string };
export interface TerminalHost {
    readonly kind: TerminalHostKind;
    openCommandInSplit(pi: PiExecLike, direction: "right" | "down", options: { cwd: string; shellCommand: string }): Promise<HostResult<{ pane: PaneRef }>>;
    closePane(pi: PiExecLike, pane: PaneRef): Promise<HostResult<object>>;
    notify(pi: PiExecLike, title: string, body: string, pane?: PaneRef): Promise<void>; // best-effort, never throws
    focusPane?(pi: PiExecLike, pane: PaneRef): Promise<HostResult<object>>;
}
```

- `detect.ts`: `detectTerminalHost(env = process.env): TerminalHostKind` —
  `HERDR_ENV === "1" && HERDR_PANE_ID` → `"herdr"`; else
  `CMUX_SURFACE_ID || CMUX_WORKSPACE_ID` → `"cmux"`; else `"none"`.
  Innermost host wins (herdr before cmux) because the env of the pane you
  are IN is the host that can split next to you.
- `cmux.ts`: implement by delegating to the existing
  `openCommandInNewSplitWithRefs`/`close-surface`/`notify` code paths in
  `src/commands/cmux-split.ts` — move code only if it stays
  behavior-identical; map `{workspaceRef, surfaceRef}` into `PaneRef`.
- `herdr.ts`: implement with `pi.exec("herdr", [...])` using the primitive
  chosen in Step 1; parse the JSON envelope (`{"id","result":{...}}`);
  `notify` → `herdr notification show <title> --body <body> --sound done`.
  All calls take an injected exec fn for tests (match
  `cmux-adapter.test.ts`'s `CmuxExecFn` pattern).
- `index.ts`: `getTerminalHost(env?)` returning a memoized instance, plus a
  `"none"` host whose operations return
  `{ ok: false, error: "requires a terminal host (cmux or herdr)" }`.

**Verify**: `pnpm vitest run src/terminal-host/detect.test.ts
src/terminal-host/herdr.test.ts src/terminal-host/cmux.test.ts` → pass
(detection precedence incl. both-envs-set; herdr JSON parse happy/malformed;
cmux impl parity via the existing fake-exec fixtures).

### Step 3: Port the command surfaces

- `src/commands/worktree.ts`: replace the `isInCmux()` guard +
  `openCommandInNewSplit` with the facade; error text becomes
  `"/sumo:worktree requires a terminal host (cmux or herdr)"`. If plan 071
  landed, port fresh/reopen modes identically. Update tests (the injected
  `openSplit`/`isInCmux` seams become an injected `TerminalHost`).
- `src/commands/diff.ts` and `src/commands/review.ts`: same mechanical port.
  `chooseDiffSplitDirection` is host-independent — unchanged.

**Verify**: `pnpm vitest run src/commands/worktree.test.ts
src/commands/diff.test.ts src/commands/review.test.ts` → pass; new cases:
herdr host opens split via herdr exec; none host warns with the new message.

### Step 4: Port background tasks + generalize the pane ref

- `src/background-tasks/task-types.ts`: add
  `pane?: { host: "cmux" | "herdr"; workspaceRef?: string; surfaceRef: string }`;
  keep the legacy `cmux?` field READABLE. Bump
  `BACKGROUND_TASK_META_SCHEMA_VERSION` to 3; `parseRecoveredTask` accepts
  version 2 (mapping `cmux` → `pane {host:"cmux"}`) and version 3.
- `src/background-tasks/task-manager.ts`: `spawnTask`'s visible guard checks
  `detectTerminalHost() !== "none"`; `spawnVisibleTask`, `stopTask`'s
  close path, and `fireCmuxNotify` (rename `fireHostNotify`) go through the
  facade. The visible-shell `run.sh` wrapper and marker files are
  host-independent — untouched.

**Verify**: `pnpm vitest run src/background-tasks/task-manager.test.ts` →
existing tests pass; new tests: v2 meta with `cmux` recovers into `pane`;
visible spawn under fake-herdr env stores a herdr `PaneRef` and stop closes
via `herdr pane close`.

### Step 5: Live smoke + docs

- Manual smoke inside a real herdr session (operator-visible, throwaway
  worktree): `/sumo:worktree smoke-test` opens a pane; `bg_task`-visible
  shell task opens, completes, fires a herdr notification, and `stop` closes
  the pane. Capture the transcript in the PR/commit body.
- Update `docs/PI_TOOL_ARCHITECTURE.md`'s cmux mentions to "terminal host
  (cmux or herdr)".

**Verify**: `pnpm typecheck && pnpm test` → exit 0, all pass.

## Test plan

- `detect.test.ts` — precedence table (herdr, cmux, both, neither).
- `herdr.test.ts` — JSON envelope parse, split/run or agent-start arg
  construction, close, notify args, malformed-output error path.
- `cmux.test.ts` — behavior parity with pre-refactor `cmux-split` fixtures.
- Ported command/manager tests per Steps 3–4.
- Pattern exemplars: `src/spike/cmux-background/cmux-adapter.test.ts`
  (fake exec), `src/background-tasks/task-manager.test.ts` (recovery).

## Done criteria

- [ ] `pnpm typecheck` exits 0; `pnpm test` exits 0
- [ ] `rg -n "isInCmux\(" src/commands/worktree.ts src/commands/diff.ts src/commands/review.ts src/background-tasks/` → no matches (facade only)
- [ ] v2 meta.json (with `cmux` ref) recovery test passes
- [ ] Live herdr smoke evidence captured (Step 5)
- [ ] cmux behavior unchanged (existing cmux-split fixtures pass unmodified)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- Step-1 recon shows neither `pane split` nor `agent start` returns a
  machine-readable pane id — file the herdr feature ask instead of scraping
  `pane list` diffs.
- Herdr's `pane run` echoes the full command into the shell in a way that
  breaks the visible-task `run.sh` contract (exit markers not written).
- The `openCommandInNewSplitWithRefs` cmux flow cannot be wrapped without
  behavior change (its no-guessing surface-discovery must be preserved).
- Schema-v3 recovery cannot read v2 metadata losslessly.
- Plan 071 landed with a shape that conflicts with the facade port.

## Maintenance notes

- **Deferred follow-ups** (record, don't build): herdr-native
  `worktree create/open --label` for first-class workspace labeling;
  `herdr pane report-metadata` to label SumoCode panes; using
  `herdr agent wait --status idle` / `wait agent-status` as an
  orchestrator-side liveness signal for visible workers (pairs with
  Orchestration v2 plans 065–070 — herdr's installed Pi integration
  `~/.pi/agent/extensions/herdr-agent-state.ts` already reports Pi
  idle/working state per pane, so SumoCode children get fleet visibility in
  herdr for free); `focusPane` wiring for plan 068's dashboard focus action.
- Herdr protocol is young (v0.7.0, protocol 14): pin assumptions to the JSON
  envelope shape captured in Step 1 and keep all herdr arg-building in
  `herdr.ts` so upstream CLI changes stay one-file fixes.
- Reviewers should scrutinize: detection precedence (a herdr pane inside a
  cmux session must pick herdr), and that `notify` never throws into
  finalize paths.
