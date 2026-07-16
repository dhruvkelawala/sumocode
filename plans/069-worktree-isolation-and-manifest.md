# Plan 069: Add worktree isolation and a host-derived completion manifest to subagent spawns

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat d4ce41d..HEAD -- src/subagents/ src/git/worktree.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/065-subagents-core.md, plans/066-typed-deferred-result-delivery.md
- **Category**: direction
- **Planned at**: commit `d4ce41d`, 2026-07-15

## Why this matters

Two SumoCode advantages must survive the move to the new subagent grammar
(`docs/research/SUMOCODE_ORCHESTRATION_BENCHMARK_2026.md`, P0 §2 closing
paragraph): **code isolation** (a write-capable child works on its own named
branch in a git worktree, so parallel children never stomp the parent
checkout) and **trustworthy results** (a completion carries host-observed
evidence — changed paths, base/head commits, exit status — not just model
prose; the model's own claims cannot override what git says). Without this,
the retirement of `bg_task runner=sumocode worktree=true` (plan 070) would
lose capability.

## Current state

- `src/git/worktree.ts` — the shared typed worktree module. Reuse as-is:
  - `resolveCreateOptions({ repoRoot, branch?, baseRef?, task })` → derives
    `sumo/<slug>` branch + sibling `<repo>.sumo-worktrees/<branch>` path
  - `createWorktree(options)` (~line 159) → `{ ok, … } | { ok: false, message }`
  - `isClean(path)` (~line 237), `headAdvanced(path, baseRef)` (~line 247)
  - `removeWorktreeSync` exists but worktrees are NEVER auto-removed
    (decision D3, `docs/research/worktree-fanout-grilling.md`) — this plan
    must not call it.
  - All git calls go through `execFile` (no shell strings) — match this for
    any new git reads.
- `src/subagents/manager.ts` + `backend-pi.ts` (plan 065) — `spawn` takes
  `cwd`; the backend spawns `pi` in that cwd. Snapshot has
  `sessionFilePath/finalText/errorText`.
- `src/subagents/delivery.ts` + `index.ts` (plan 066) — settled results are
  delivered as `customType: "subagent-result"` with
  `details: { id, title, status }`.
- Worktree-in-task-record precedent (shape to mirror, do not import):
  `src/background-tasks/task-types.ts:20-26`:

  ```ts
  export interface BackgroundTaskWorktreeRef {
      path: string;
      branch: string;
      baseRef: string;
      repoRoot: string;
  }
  ```

- Conventions: tabs, strict TS, colocated vitest tests;
  `src/git/worktree.test.ts` shows how worktree behavior is tested against a
  real temp git repo fixture.

## Commands you will need

| Purpose   | Command                                          | Expected on success |
|-----------|--------------------------------------------------|---------------------|
| Typecheck | `pnpm typecheck`                                 | exit 0              |
| All tests | `pnpm test`                                      | all pass            |
| One file  | `pnpm vitest run src/subagents/manifest.test.ts` | all pass            |

## Scope

**In scope**:
- `src/subagents/manifest.ts` (create) + `src/subagents/manifest.test.ts`
- `src/subagents/domain.ts` (extend: `worktree?` ref + `manifest?` on snapshot)
- `src/subagents/manager.ts` (spawn creates the worktree; settle builds manifest)
- `src/subagents/tools.ts` + `prompt.ts` (spawn param `worktree?`, `branch?`;
  check/wait/list render manifest facts)
- `src/subagents/index.ts` (delivery payload includes the manifest)

**Out of scope**:
- Removing/pruning worktrees — never automatic; a prune command is future work.
- Apply/cherry-pick/merge/diff-review UX (the "result loop") — explicitly
  deferred; this plan only produces the evidence the future loop consumes.
- `src/background-tasks/**` and its worktree path — untouched until plan 070.
- Child-side structured `yield` tooling — the manifest here is HOST-derived
  only; a child-reported section can be added later without breaking shape.

## Git workflow

- Branch: `advisor/069-worktree-isolation-and-manifest`
- Conventional commits, e.g. `feat(subagents): worktree spawns + completion manifest`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Manifest builder (`src/subagents/manifest.ts`)

```ts
export interface CompletionManifest {
    readonly baseRef: string;          // commit the child started from
    readonly headRef?: string;         // child worktree HEAD at settle
    readonly branch?: string;          // sumo/<slug> when isolated
    readonly worktreePath?: string;
    readonly changedPaths: readonly string[];  // from git status --porcelain + diff vs base
    readonly dirty: boolean;           // uncommitted changes present
    readonly commits: number;          // commits ahead of baseRef
    readonly exit: "completed" | "failed" | "interrupted";
    readonly durationMs: number;
}
export async function buildCompletionManifest(options: {
    cwd: string; baseRef: string; outcome: RunOutcome; startedAt: number;
}): Promise<CompletionManifest>;
```

Implement with `execFile("git", [...])` reads only (`rev-parse HEAD`,
`status --porcelain`, `diff --name-only <base>..HEAD`,
`rev-list --count <base>..HEAD`), mirroring the style of
`src/git/worktree.ts:63-77`. Every git failure degrades to a partial manifest
(never throws into the settle path). For non-worktree spawns, build the
manifest against the spawn `cwd` with `baseRef` captured at spawn time
(`git rev-parse HEAD`), and `changedPaths` from `status --porcelain` only
(diffing the shared checkout against base would blame the child for parent
edits — record `changedPaths: []` plus `dirty` in that case and note it in a
doc comment).

**Verify**: `pnpm vitest run src/subagents/manifest.test.ts` → pass (temp git
repo fixture as in `src/git/worktree.test.ts:57`; cases: clean completion,
commits ahead, dirty tree, git failure degrades gracefully).

### Step 2: Worktree spawn option

In `src/subagents/tools.ts`, add to `subagent_spawn`:
- `worktree?: boolean` — "Run the child in an isolated git worktree on a new
  `sumo/<slug>` branch from HEAD. Its edits never touch your checkout. The
  worktree is preserved after completion; it is never auto-removed."
- `branch?: string` — optional branch override.

In the manager spawn path: when `worktree` is set, call
`resolveCreateOptions` + `createWorktree` BEFORE spawning; on create failure
return a failed spawn result with the worktree error (do not spawn a child
into the parent checkout as a fallback). Store the ref
(`{ path, branch, baseRef, repoRoot }`) on the snapshot; child `cwd` becomes
the worktree path. Capture `baseRef` for non-worktree spawns too.

**Verify**: `pnpm vitest run src/subagents/manager.test.ts` → new cases pass
(worktree create failure → spawn fails without child process; snapshot
carries the ref; injected fake `createWorktree` — do not hit real git in
manager tests).

### Step 3: Manifest on settle + rendering

On `run-settled`, the manager awaits `buildCompletionManifest` (bounded: race
with a 5s timeout → partial manifest `{ exit, durationMs }`) and stores it on
the snapshot BEFORE notifying change listeners (delivery reads it).

Render the manifest facts everywhere results surface:
- delivery payload (plan 066): append a fenced block to the content —

  ```
  branch: sumo/fix-scroll · base a1b2c3d · +3 commits · 5 files changed · clean
  files: src/a.ts, src/b.ts, …
  worktree: /path/repo.sumo-worktrees/sumo-fix-scroll (preserved)
  ```

  and include the structured manifest in `details.manifest`.
- `subagent_check` / `subagent_wait` output: same summary line.
- `subagent_list`: append ` · sumo/<branch>` for isolated children.

**Verify**: `pnpm vitest run src/subagents/index.test.ts` → delivery payload
contains `details.manifest.changedPaths`; tools tests assert the summary line.

### Step 4: Full check

**Verify**: `pnpm typecheck && pnpm test` → exit 0, all pass.

## Test plan

- `manifest.test.ts` — real temp-repo fixture (4 cases in Step 1).
- `manager.test.ts` — worktree failure short-circuits; baseRef captured;
  manifest stored before listener notify (assert ordering with a listener spy).
- `index.test.ts` / tools tests — rendering assertions (Step 3).
- Pattern exemplars: `src/git/worktree.test.ts` (fixture),
  `src/background-tasks/task-manager.test.ts` (manager harness).

## Done criteria

- [ ] `pnpm typecheck` exits 0; `pnpm test` exits 0
- [ ] `subagent_spawn` accepts `worktree`/`branch`; failure path proven
- [ ] Manifest is host-derived (no model text parsed into it) — code inspection
- [ ] `rg -n "removeWorktree" src/subagents/` returns no matches
- [ ] Delivery `details.manifest` present for both isolated and shared spawns
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `src/git/worktree.ts` exports differ from the Current state list.
- Building the manifest at settle requires child cooperation (e.g. the child
  session must report its HEAD) — the design requires host-only derivation.
- The 5s manifest timeout is insufficient in the test fixture (evidence of
  git commands hanging) — report; do not raise the bound blindly.
- Plans 065/066 landed with a different snapshot/delivery shape.

## Maintenance notes

- The manifest is the input contract for the future "result loop"
  (diff review → apply/cherry-pick/discard) and for overlap detection across
  parallel children (`changedPaths` intersection) — do not rename fields
  casually; treat it as a versionable schema.
- A future child-side `yield_result` (validation commands, residual risks)
  should EXTEND the manifest under a `reported` key, never overwrite
  host-derived fields.
- Worktrees accumulate under `<repo>.sumo-worktrees/` by design; a
  prune-eligibility command (`isClean` + `headAdvanced` are already available)
  is deliberate follow-up work.
