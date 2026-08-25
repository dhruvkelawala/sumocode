# Plan 084: Raise subagent capacity to 10 and derive every capacity mention from the constant

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Base branch**: this plan builds ON TOP of
> `advisor/083-role-based-async-subagents` at commit `f49e030` (NOT main —
> the spawn queue this plan touches only exists there).
>
> **Drift check (run first)**:
> `git diff --stat f49e030..HEAD -- src/subagents/ src/subagent-status-row.ts`
> Expected: empty (you branched from `f49e030`). Non-empty → STOP.

## Status

- **Implementation state**: DONE — running capacity 10 and queue depth 16 are constant-derived and covered by the manager/tool/prompt suites.
- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/083-role-based-async-subagents.md (DONE, branch `advisor/083-role-based-async-subagents`)
- **Category**: direction
- **Planned at**: `f49e030` (branch advisor/083), 2026-08-25

## Why this matters

The operator wants up to 10 concurrent subagents (raised from 4) now that
plan 083's queue absorbs bursts safely. The bump itself is one constant; the
real work is removing every place the number 4 is baked in — the
model-facing guidelines copy currently hardcodes "At most 4 subagents", and
the queue tests spawn to capacity with literal loops. After this plan, the
capacity lives in exactly one place and every consumer derives from it, so
the next bump is genuinely a one-line change. Known trade-off, accepted by
the operator: 10 concurrent children multiply provider cost and machine
load; the queue already handled correctness.

## Current state

All facts verified at `f49e030` on branch `advisor/083-role-based-async-subagents`:

- `src/subagents/manager.ts:13-14`:

  ```ts
  const MAX_RUNNING = 4;
  const MAX_QUEUED = 16;
  ```

  `MAX_TRACKED = 64` (line 15) — at 10 running + 16 queued = 26 tracked,
  still comfortably under the prune ceiling; no change needed.
- `src/subagents/prompt.ts` — `SUBAGENT_PROMPT_GUIDELINES` contains the
  hardcoded bullet:

  ```ts
  "At most 4 subagents can run concurrently. If spawn returns status=at_capacity, the queue is full; cancel something or end your turn and respawn later.",
  ```

  `prompt.ts` imports only from `./domain.js` and `./manifest.js`. It must
  NOT import `./manager.js` (that would pull `node:child_process` and the
  worktree machinery into a pure copy module).
- `src/subagents/domain.ts` — pure types module (no runtime imports beyond
  `./manifest.js` types). The right home for shared capacity constants.
- `src/subagents/manager.test.ts` — queue tests use literal loops, e.g.:

  ```ts
  for (let index = 0; index < 4; index += 1) await manager.spawn(makeTask(`running-${index}`));
  ```

  and (queue-full test) an assertion shaped as
  `status: index < 4 ? "running" : "queued"`. All capacity literals in this
  file must become constant-derived.
- `dist/extension/` is a TRACKED build artifact with a freshness manifest
  enforced by `scripts/build-extension.test.mjs` ("bundle out of date or
  corrupt"). Any src change requires `pnpm build:bundles` and committing the
  dist diff, or `pnpm test` fails on a fresh checkout. (This bit plan 083's
  executor; do not repeat it.)
- Known flake: `src/sumo-tui/rpc/host-actions.test.ts` can fail in a full
  concurrent run; it passes in isolation. Acceptance rule: if it is the ONLY
  failure, run it twice in isolation — both pass ⇒ proceed.

Conventions: tabs, strict TS, colocated tests, conventional commits
(`feat(subagents): …`).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Subagent suite | `pnpm vitest run src/subagents` | all pass |
| Full unit | `pnpm test` | exit 0 (flake rule above) |
| Bundles | `pnpm build:bundles` | exit 0; only `dist/` modified |

## Scope

**In scope** (only these):
- `src/subagents/domain.ts` (add exported constants)
- `src/subagents/manager.ts` (consume constants)
- `src/subagents/prompt.ts` (derive the copy)
- `src/subagents/manager.test.ts`, `src/subagents/tools.test.ts`,
  `src/subagents/prompt.test.ts`, `src/subagents/index.test.ts` (replace
  capacity literals with the constants — ONLY where the literal means
  "capacity"; ids like `sa-5` that follow from capacity may be computed or
  updated, your choice, but assertions must not silently weaken)
- `src/subagent-status-row.ts` + `src/subagent-status-row.test.ts`
  (scope amendment, 2026-08-25: the capacity bump surfaced a renderer bug —
  at 10 running children the strip truncates before the trailing "N queued"
  segment at 140 columns. Fix: aggregate counts render FIRST
  (`◈ subagents · 10 running · 1 queued · <per-agent detail…>`), per-agent
  segments after, so counts survive truncation at any plausible width. Do
  not widen test widths to mask it.)
- `dist/**` (regenerated via `pnpm build:bundles` only — never hand-edited)

**Out of scope**: everything else. In particular `MAX_TRACKED`, the
`subagent_wait` 64-id cap, terminal-task concurrency, and `src/sumo-tui/`.

## Git workflow

- Branch from `advisor/083-role-based-async-subagents`:
  `git checkout -b advisor/084-raise-subagent-capacity f49e030` (or work on
  the branch your dispatcher created from that ref).
- Commits: `feat(subagents): raise concurrent capacity to 10` and
  `chore(bundles): regenerate prebundled host and extension`.
- Do NOT push.

## Steps

### Step 1: Move capacity constants to domain, bump running to 10

In `src/subagents/domain.ts` add (near the top, above the types):

```ts
/** Concurrent running-children ceiling. Queue absorbs bursts beyond it (plan 083). */
export const SUBAGENT_MAX_RUNNING = 10;
/** Bounded FIFO depth for spawns accepted past the running ceiling. */
export const SUBAGENT_MAX_QUEUED = 16;
```

In `src/subagents/manager.ts`: delete the local `MAX_RUNNING`/`MAX_QUEUED`
constants and import the two from `./domain.js`; replace all usages
(capacity check, queue-full check, `AtCapacityDetails.capacity`, drain
condition). `MAX_QUEUED` stays 16 — queue depth is burst absorption, not
proportional to workers; the operator accepted this.

**Verify**: `pnpm exec tsc --noEmit` → exit 0;
`rg -n "MAX_RUNNING|MAX_QUEUED" src/subagents/manager.ts` → only imports and
usages of the `SUBAGENT_*` names, no local `= 4` / `= 16` definitions.

### Step 2: Derive the guidelines copy

In `src/subagents/prompt.ts`: import `SUBAGENT_MAX_RUNNING` from
`./domain.js` (pure module — allowed) and rewrite the hardcoded bullet as a
template literal:

```ts
`At most ${SUBAGENT_MAX_RUNNING} subagents can run concurrently. If spawn returns status=at_capacity, the queue is full; cancel something or end your turn and respawn later.`,
```

**Verify**: `rg -n "At most 4" src/` → no matches;
`pnpm vitest run src/subagents/prompt.test.ts` → pass.

### Step 3: Make the tests capacity-derived

In the four test files, replace every literal that MEANS capacity with the
imported constants: fill-to-capacity loops become
`for (let index = 0; index < SUBAGENT_MAX_RUNNING; ...)`, the 5th-spawn
tests become "the (MAX_RUNNING+1)th spawn", the queue-full test spawns
`SUBAGENT_MAX_RUNNING + SUBAGENT_MAX_QUEUED + 1` and asserts the last one is
`at_capacity`, and expected ids (`sa-5` etc.) are computed from the constant
where they encode capacity. Do NOT weaken assertions — statuses, FIFO order,
and exact counts must stay exact.

**Verify**: `pnpm vitest run src/subagents` → all pass;
`rg -n "< 4|< 5|sa-5" src/subagents/manager.test.ts` → any remaining match
is demonstrably not a capacity literal (add a short comment if ambiguous).

### Step 4: Bundles + full battery

1. `pnpm build:bundles` → exit 0; `git status --porcelain` shows only
   `dist/` modified besides your committed src changes.
2. `pnpm test` → exit 0 (host-actions flake rule from Current state).
3. Commit src and dist per the git workflow.

**Verify**: `git status --porcelain` → clean;
`git log --oneline f49e030..HEAD` → the two commits.

## Test plan

No new test files. The existing queue/capacity tests are the coverage; the
work is making them derive from the constants without weakening them. One
new assertion worth adding to `manager.test.ts`: the
`AtCapacityDetails.capacity` field equals `SUBAGENT_MAX_RUNNING` (locks the
derivation).

## Done criteria

- [ ] `pnpm exec tsc --noEmit` exit 0; `pnpm test` exit 0 (flake rule)
- [ ] `SUBAGENT_MAX_RUNNING === 10`, defined once in `src/subagents/domain.ts`
- [ ] `rg -n "At most 4" src/` → no matches; guidelines bullet renders "At most 10"
- [ ] `rg -n "= 4" src/subagents/manager.ts` → no capacity definition remains
- [ ] Capacity tests import the constants; 11th spawn queues, (10+16+1)th refuses
- [ ] `dist/` regenerated and committed; worktree clean
- [ ] Only in-scope files modified

## STOP conditions

- Drift check non-empty (base is not `f49e030`).
- Deriving the prompt bullet creates an import cycle or pulls runtime deps
  into `prompt.ts` (check: `prompt.test.ts` still runs without child_process
  mocking).
- Any test failure other than the documented host-actions flake.
- A capacity literal you cannot confidently classify — list it and stop.

## Maintenance notes

- Next capacity change = edit `SUBAGENT_MAX_RUNNING` once; everything else
  derives. If that ever stops being true, this plan failed — fix the leak.
- `MAX_QUEUED` deliberately unscaled (16). Revisit only with evidence of
  queue-full refusals in real use.
- Cost/load exposure at 10 is the operator's accepted trade-off; if a future
  budget guard lands (per-session spawn budget), it belongs in the manager
  next to the capacity check.
