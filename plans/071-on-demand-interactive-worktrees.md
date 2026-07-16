# Plan 071: Open plain interactive worktree sessions on demand (Codex/T3-style worktree threads)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat d4ce41d..HEAD -- src/commands/worktree.ts src/commands/worktree.test.ts src/git/worktree.ts src/commands/cmux-split.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (independent of 065–070; touches different files)
- **Category**: direction
- **Planned at**: commit `d4ce41d`, 2026-07-15
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/309

## Why this matters

Codex app and T3 Code's headline parallel-work flow is "new thread in a
worktree": a **plain interactive session in an isolated checkout, no prompt
required**. SumoCode's `/sumo:worktree <task>` only supports the *delegated*
variant — it requires a task prompt and launches `sumocode task "<task>"`
(a one-shot kickoff turn in task mode). Bare `/sumo:worktree` prints a usage
error, and there is no way to reopen an existing sumo worktree as a session.
This plan adds the two missing modes — **fresh plain session** and **reopen
existing** — as small extensions of the existing command, keeping the
delegated form and `prune` fully backward compatible.

## Current state

- `src/commands/worktree.ts` — the whole feature today (176 lines; read it
  fully). Key facts:
  - `parseWorktreeArgs` (lines 27–34) recognizes only `prune …` vs
    "everything else is the task prompt":

    ```ts
    export function parseWorktreeArgs(args: string): ParsedWorktreeArgs {
        const trimmed = args.trim();
        if (trimmed === "prune" || trimmed.startsWith("prune ")) {
            return { mode: "prune", task: trimmed.slice("prune".length).trim() };
        }
        return { mode: "open", task: trimmed };
    }
    ```

  - Empty task → usage warning (lines 119–121:
    `"Usage: /sumo:worktree <task> or /sumo:worktree prune <branch-or-path>"`).
  - The pane command (lines 53–57) hardwires the delegated handoff:

    ```ts
    function commandForWorktree(task: string, setupAction: string): string {
        const setup = setupAction.trim();
        const setupPrefix = setup ? `${setup} && ` : "";
        return `${setupPrefix}SUMOCODE_TASK_KEEP_OPEN=1 exec sumocode task ${shellEscape(task)}`;
    }
    ```

  - Flow (lines 123–137): `createWorktree({ repoRoot: ctx.cwd, task, baseRef: "HEAD" })`
    → `chooseDiffSplitDirection(getTerminalSize())` (portrait→down) →
    `buildShellCommand(created.path, …)` → `openCommandInNewSplit`.
  - `handlePrune` (lines 60–92) lists/removes worktrees whose branch starts
    with `sumo/`.
  - All collaborators are injectable via `WorktreeCommandOptions` (lines
    9–17) — tests fake `create`/`list`/`remove`/`openSplit`/`isInCmux`/
    `terminalSize`. Follow that seam for new behavior.
- `src/git/worktree.ts`:
  - `resolveCreateOptions` (line 135): `branch = options.branch ?? "sumo/" + slugifyBranch(options.task ?? "task")`.
  - `slugifyBranch` (line 107).
  - `listWorktrees(repoRoot)` returns `{ path, head?, branch?, detached }`.
  - Git guarantees a branch cannot be checked out in two worktrees — reopening
    must NOT re-create, only re-open a pane at the existing path.
- `src/commands/cmux-split.ts` — `buildShellCommand(cwd, command)` (line 85)
  wraps a `cd <cwd> && <command>` in a login shell for `respawn-pane`.
- `src/commands/worktree.test.ts` — existing harness (fake collaborators,
  asserts `sendMessage` customType `sumo:worktree` and notify strings). Extend
  this file; match its style.
- Conventions: tabs, strict TS, colocated vitest tests.

## Commands you will need

| Purpose   | Command                                          | Expected on success |
|-----------|--------------------------------------------------|---------------------|
| Typecheck | `pnpm typecheck`                                 | exit 0              |
| One file  | `pnpm vitest run src/commands/worktree.test.ts`  | all pass            |
| All tests | `pnpm test`                                      | all pass            |

## Scope

**In scope**:
- `src/commands/worktree.ts`
- `src/commands/worktree.test.ts`

**Out of scope**:
- `src/git/worktree.ts` — no changes needed (`branch`/`task`/`baseRef` options
  already cover everything). If you believe otherwise, STOP.
- `bg_task` / plans 065–070 surfaces.
- Setup-action configuration changes (`SUMOCODE_WORKTREE_SETUP` stays as is).
- Worktree/PR status badges in the sidebar or dashboard (future work).
- The `/sumo:ship` command.

## Git workflow

- Branch: `advisor/071-on-demand-interactive-worktrees`
- Conventional commits, e.g. `feat(worktree): plain interactive and reopen modes`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extend the argument grammar

New `ParsedWorktreeArgs`:

```ts
export interface ParsedWorktreeArgs {
    readonly mode: "fresh" | "reopen" | "delegate" | "prune";
    /** delegate: task prompt · fresh: optional name · reopen/prune: branch-or-path target */
    readonly value: string;
    readonly baseRef?: string;   // from --base <ref>, fresh/delegate modes only
}
```

Grammar (document in the command description):

| Input | Mode |
|---|---|
| `/sumo:worktree` | `fresh` (generated name) |
| `/sumo:worktree new` / `new fix-scroll` | `fresh` (optional name) |
| `/sumo:worktree open sumo/fix-scroll` (or a path) | `reopen` |
| `/sumo:worktree prune [target]` | `prune` (unchanged) |
| `/sumo:worktree --base origin/main new x` | `fresh` from ref |
| `/sumo:worktree <anything else>` | `delegate` (unchanged back-compat) |

Parse `--base <ref>` anywhere in the arg string; reject it for
`reopen`/`prune` with a warning. Keep `parseWorktreeArgs` pure and exported.

**Verify**: `pnpm vitest run src/commands/worktree.test.ts` → new parse cases
pass (bare, `new`, `new name`, `open target`, `--base` combos, back-compat
task text, `prune`).

### Step 2: Fresh plain sessions

In the handler, `fresh` mode:

- Branch name: `sumo/<slugifyBranch(name)>` when a name was given, else a
  generated `wt-<Date.now().toString(36)>` slug passed as `task` to
  `createWorktree` (it already slugs and prefixes). Pass
  `baseRef: parsed.baseRef ?? "HEAD"`.
- Pane command — plain interactive, NO task mode:

  ```ts
  function commandForFreshWorktree(setupAction: string): string {
      const setup = setupAction.trim();
      const setupPrefix = setup ? `${setup} && ` : "";
      return `${setupPrefix}exec sumocode`;
  }
  ```

  (No `SUMOCODE_TASK_KEEP_OPEN`, no `task` subcommand — the pane boots the
  normal splash/interactive shell in the worktree cwd.)
- Same cmux/UI guards, split-direction choice, and success notify as today;
  notify text: `` opened <branch> (fresh session) in <direction> split · setup: … ``.

**Verify**: new test — bare invocation calls `create` with a generated slug,
opens a split whose command contains `exec sumocode` and does NOT contain
`sumocode task`, and notifies `fresh session`.

### Step 3: Reopen existing worktrees

`reopen` mode:

- `listWorktrees(ctx.cwd)`; match `target` against `branch` or `path` among
  `sumo/`-prefixed entries (same matching as `handlePrune`, lines 80–83 —
  extract a shared `findSumoWorktree(listed, target)` helper instead of
  duplicating).
- No match → warning listing available sumo branches.
- Match → do NOT create anything; open a split with
  `buildShellCommand(match.path, commandForFreshWorktree(setupAction))`.
  Skip the setup action here? No — run it (idempotent installs are the T3
  convention), but allow `SUMOCODE_WORKTREE_SETUP=""` to disable globally as
  today.
- Notify: `` reopened <branch> in <direction> split ``.

**Verify**: new tests — reopen matches by branch and by path; unknown target
warns and lists candidates; no `create` call in reopen mode.

### Step 4: Delegate mode regression + docs

- `delegate` mode must behave byte-for-byte as today (existing tests
  untouched and passing) except it now honors `--base <ref>`.
- Update the `registerCommand` description string to the new grammar and the
  usage warning text (Step 1 table, one line).

**Verify**: `pnpm typecheck && pnpm test` → exit 0, all pass; the
pre-existing test `"creates a named worktree and opens an interactive
sumocode pane with setup"` passes unmodified.

## Test plan

Extend `src/commands/worktree.test.ts` (existing fake-collaborator harness):

- parse: 7 grammar cases from Step 1.
- fresh: generated vs named branch; `--base origin/main` forwarded to
  `create`; command excludes `sumocode task`.
- reopen: by branch, by path, unknown target, `--base` rejected.
- delegate: unchanged behavior (existing tests) + `--base` forwarded.
- guards: non-cmux and non-UI warnings still fire for fresh/reopen.

## Done criteria

- [ ] `pnpm typecheck` exits 0; `pnpm test` exits 0
- [ ] Bare `/sumo:worktree` opens a plain interactive session (test-proven,
      command contains `exec sumocode`, not `sumocode task`)
- [ ] `open <branch>` reopens without creating (no `create` call, test-proven)
- [ ] Existing delegate/prune tests pass unmodified
- [ ] Only the two in-scope files are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `exec sumocode` inside the split does not boot an interactive session from
  a worktree directory (e.g. the launcher's duplicate-extension dedup or
  `SUMOCODE_BG_CHILD` guard misfires in the pane) — report which guard fired;
  do not weaken guards.
- The current-state excerpts of `worktree.ts` don't match (file drifted).
- Honoring `--base` for delegate mode requires touching `src/git/worktree.ts`.
- Reopen requires cmux surface tracking that doesn't exist (it shouldn't —
  it's a plain `new-split`).

## Maintenance notes

- This command is the human-interactive lane; plan 069's `subagent_spawn
  worktree:true` is the delegated lane. Both share `src/git/worktree.ts` and
  the never-auto-remove rule — keep them behaviorally consistent.
- Future (deliberately deferred): a worktree list UI with dirty/ahead/PR
  status (T3's thread sidebar; `isClean`/`headAdvanced` already exist),
  `/sumo:ship` integration hints in the fresh-session notify, and moving work
  between local and worktree checkouts (Codex's handoff).
- If a `name-generator` lands for subagents (plan 065 family), reuse it for
  fresh-worktree names instead of the timestamp slug.
