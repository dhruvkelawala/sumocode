# Plan 113: Add an explicit inspect, apply, dismiss, and prune loop for subagent worktrees

> **Executor instructions**: Follow this plan step by step and run every verification command. Preserve every worktree and branch by default. No action may commit, merge, push, open a PR, delete a branch, or remove a worktree without the explicit human choice defined below. Conflict paths must restore the parent checkout and keep the child worktree intact. When done, update this plan's row in `plans/README.md` unless a reviewer says they own the index.
>
> **Drift check (run first)**: `git diff --stat b34bd79..HEAD -- dist/host dist/extension src/git/worktree.ts src/git/worktree.test.ts src/git/worktree-disposition.ts src/git/worktree-disposition.test.ts src/subagents/manifest.ts src/subagents/manifest.test.ts src/subagents/registry.ts src/subagents/registry.test.ts src/commands/worktree.ts src/commands/worktree.test.ts src/interaction-registry.ts src/interaction-registry.test.ts src/activity/subagent-adapter.ts src/activity/subagent-adapter.test.ts scripts/visual-v2/fixture-capture.mjs docs/visual/parity/scenarios.json`
> **Working-tree preflight (run at the same time)**: `git status --short -- dist/host dist/extension src/git/worktree.ts src/git/worktree.test.ts src/git/worktree-disposition.ts src/git/worktree-disposition.test.ts src/subagents/manifest.ts src/subagents/manifest.test.ts src/subagents/registry.ts src/subagents/registry.test.ts src/commands/worktree.ts src/commands/worktree.test.ts src/interaction-registry.ts src/interaction-registry.test.ts src/activity/subagent-adapter.ts src/activity/subagent-adapter.test.ts scripts/visual-v2/fixture-capture.mjs docs/visual/parity/scenarios.json`. If this reports pre-existing work, STOP and preserve it.
> If commit-range drift changes a Current state behavior/signature, STOP and request plan reconciliation.
> **Dependency check**: Confirm every plan named in **Depends on** is `DONE` in `plans/README.md`. If any is not DONE, STOP; do not recreate or assume its APIs.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/109-contain-subagent-lifecycle-failures.md`, `plans/112-durable-subagent-registry.md` (stable result identity/disposition persistence)
- **Category**: direction
- **Milestone**: M5 — Product durability
- **Planned at**: commit `b34bd79`, 2026-08-28
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/407

## Why this matters

Isolated children return a host-observed completion manifest, but the parent still hand-writes Git commands to inspect and apply it, and preserved worktrees accumulate without disposition. The product should turn manifest evidence into a safe, human-gated result loop while keeping commit/push/merge/PR and destructive cleanup explicit.

## Current state

- `src/subagents/manifest.ts` reports base/head refs, branch, worktree path, changed paths, dirty state, commit count, exit, and duration.
- `src/git/worktree.ts` creates/lists/removes worktrees and already has `isClean()`/`headAdvanced()` helpers.
- `/sumo:worktree` supports fresh/reopen/delegate/prune, but no completed-subagent result selection. `parseWorktreeArgs()` in `src/commands/worktree.ts:31-59` sends every unrecognized prefix to `delegate`; therefore `result abc` currently launches a delegated prompt unless a `result` mode is inserted before that catch-all.
- `/sumo:ship` operates only on the current checkout and human-gates commit, push, and PR.
- Worktrees are intentionally never auto-removed; repository rules prohibit branch deletion/destructive cleanup without explicit approval.

## Product contract

A settled isolated result has dispositions:
- **inspect**: show bounded diff/stat/base/dirty/commit evidence and optionally open the worktree/diff;
- **apply**: explicit confirmation, committed child changes only, safe preflight, apply to current checkout, restore the exact pre-action state on conflict;
- **dismiss**: hide/mark handled; no filesystem or branch deletion;
- **prune**: separate explicit confirmation; remove only a proven clean worktree, preserve branch by default.

No automatic merge, push, PR, branch deletion, force removal, or dirty-worktree deletion.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Git/worktree | `pnpm vitest run src/git/worktree.test.ts src/commands/worktree.test.ts` | pass |
| Subagent/tools | `pnpm vitest run src/subagents/manifest.test.ts src/subagents/tools.test.ts` | pass |
| Command/Activity | `pnpm vitest run src/commands/worktree.test.ts src/interaction-registry.test.ts src/activity/subagent-adapter.test.ts src/divine-query.test.ts` | pass |
| Full/visual | `pnpm exec tsc --noEmit && pnpm build && pnpm lint && pnpm test && pnpm test:integration && pnpm visual:review -- --scenario fixture-worktree-result-disposition-landscape && pnpm visual:ci` | exit 0; card/modal capture exists |

## Committed bundle freshness

After final source/UI edits, run `pnpm build:host && pnpm build:extension` before `pnpm test`; keep `dist/host/**` and `dist/extension/**` generated changes in scope. Rerun builders after integration and before visual verification.

## Scope

**In scope**:
- `dist/host/**` and `dist/extension/**` generated by the committed bundle builders.
- `src/git/worktree-disposition.ts` and `src/git/worktree-disposition.test.ts` (create), plus required helpers/tests in `src/git/worktree.ts`.
- `src/subagents/manifest.ts` and Plan-112 registry schema/tests needed for stable result identity/disposition persistence.
- `src/commands/worktree.ts` and test: an explicit `/sumo:worktree result <id>` parser/handler path before the delegate catch-all.
- `src/interaction-registry.ts` and test to inject the subagent registry/result service into the command.
- `src/activity/subagent-adapter.ts` and test for result-card hint/status integration.
- Existing `showDivineQuery()` confirmation surface as a read-only pattern/API.
- `scripts/visual-v2/fixture-capture.mjs` and `docs/visual/parity/scenarios.json` for one deterministic review-only 160×45 result-card + disposition-modal fixture. Use the existing activity-cards Bible target only as a comparison baseline; do not alter Bible/runtime goldens.

**Out of scope**:
- Changes to `src/divine-query.ts`; if the existing confirmation API is insufficient, STOP and split that UI work.
- Automatic merge/push/PR.
- Deleting branches.
- Force-removing dirty worktrees.
- Applying uncommitted child changes automatically.
- Rewriting `/sumo:ship` into a general release system.
- Bible HTML/PNG targets, parity runtime goldens/status, required crops, or golden promotion.

## Git workflow

- Branch: `advisor/113-worktree-result-loop`
- Commits: read-only inspect, apply service, disposition/UI.
- Message: `feat(worktrees): add result disposition flow`

- Do not push or open a PR unless instructed.

## Steps

### Step 1: Define stable result/disposition state

Associate a settled subagent ID/completion manifest with `unreviewed | inspected | applied | dismissed | pruned`. Persist it through the Plan-112 registry but keep it separate from Git truth. Recompute Git preflight at action time; never trust stale manifest cleanliness/head values. Extend `ParsedWorktreeArgs` with `mode: "result"` and parse `result <id>` before the delegate fallback; missing IDs produce usage and never spawn a child.

**Verify**: `pnpm vitest run src/git/worktree-disposition.test.ts src/commands/worktree.test.ts -t "result disposition|parses result"` → transition tests reject invalid backward/destructive transitions, and parser tests prove `result abc` selects result mode while ordinary free text still delegates.

### Step 2: Implement read-only inspection

Using `execFile` Git arguments and bounded buffers/timeouts, produce stat/name-status/commit list from captured base to current worktree HEAD plus dirty status. Detect missing worktree, rewritten base, detached/unrelated history, and unknown dirty state. Add an action to open the worktree/diff through the terminal-host facade without focusing/destructive changes unless requested.

Name inspection cases with the prefix `inspects result:`.

**Verify**: `pnpm vitest run src/git/worktree-disposition.test.ts -t "inspects result:"` → committed, dirty, empty, rewritten-base, missing, unrelated-history, timeout/buffer, and path-with-spaces cases pass using captured `execFile` argv rather than shell strings.

### Step 3: Apply committed changes with one specified operation

V1 refuses every dirty parent; there is no non-overlap exception. Allow apply only when child and parent `git status --porcelain=v1 -z` are empty, commit count is positive, base is an ancestor of child HEAD, parent branch/repository are known, and the child range contains no merge commit. Resolve the ordered commit list with `git rev-list --reverse <base>..<child-head>` and show exact commits/files in `showDivineQuery()` before confirmation.

After explicit confirmation, invoke exactly `git cherry-pick --no-commit <ordered-commit>...` through `execFile` arguments. This applies committed child changes to the parent index/worktree while leaving parent HEAD unchanged and creating no commit/merge/push/PR. Capture pre-action HEAD and porcelain bytes. `--no-commit` does not provide one reliable abort path: a single conflicting commit may create no sequence, while a later conflict in a multi-commit operation may leave `.git/sequencer`. On conflict/failure, first invoke `git restore --source=<pre-action-head> --staged --worktree -- .` from the repository root, then invoke `git cherry-pick --quit` to clear any remaining sequencer (`--quit` is a no-op success when no sequence exists). Verify parent HEAD and porcelain bytes equal the pre-action snapshot and that neither `CHERRY_PICK_HEAD` nor the sequencer path reported by `git rev-parse --git-path` remains. Never use `reset --hard`, `clean`, merge, squash, or branch deletion. If restoration/sequencer cleanup cannot be proven, leave evidence intact, report the started/restore/quit commands, and STOP for manual recovery. The child branch/worktree is never mutated.

**Verify**: `pnpm vitest run src/git/worktree-disposition.test.ts -t "applies linear commits|restores failed cherry-pick"` → clean one/multi-commit ranges leave HEAD unchanged with expected staged patch; dirty parent/merge range refuse before Git mutation; single-commit and later multi-commit conflicts invoke the exact restore-then-quit sequence (never `cherry-pick --abort`), restore exact pre-state including removal of newly added paths, leave no sequencer, allow a subsequent apply, and leave child HEAD/status unchanged.

### Step 4: Add dismiss and conservative prune

Dismiss changes only disposition. Prune requires a second explicit confirmation naming path/branch, rechecks worktree cleanliness, and calls non-force `git worktree remove`. Preserve the branch. Dirty or unknown worktrees refuse pruning.

**Verify**: `pnpm vitest run src/git/worktree-disposition.test.ts src/commands/worktree.test.ts -t "dismiss|prune"` → cancel/dismiss issue no remove command; confirmed clean prune issues one non-force `git worktree remove`; dirty/unknown refuse; captured Git argv contains no branch-delete/force flag.

### Step 5: Surface the loop in Activity/command UX

Add a terse result-card hint and a command/modal showing evidence/actions. Use existing Cathedral modal primitives and voice. Do not add ad hoc ANSI. Keep actions keyboard accessible.

Add fixture `worktree-result-disposition` with a settled, unreviewed worktree result card containing deterministic commit/file/cleanliness evidence and overlay `result-disposition`, rendered through the same Divine Query primitive with inspect/apply/dismiss/prune choices and apply focused. Register review-only scenario `fixture-worktree-result-disposition-landscape` at 160×45, compared against the existing activity-cards Bible target. The capture must show both the underlying result card and centered modal.

**Verify**: `pnpm vitest run src/commands/worktree.test.ts src/interaction-registry.test.ts src/activity/subagent-adapter.test.ts src/divine-query.test.ts && pnpm visual:review -- --scenario fixture-worktree-result-disposition-landscape && pnpm visual:ci` → exit 0; command tests prove `result` never reaches delegation and confirmation cancellation performs no Git mutation; review output contains candidate full/chat-area PNGs plus styled-cell/geometry reports for the card/modal; `git status --short docs/ui/bible docs/visual/parity/approved-runtime` is empty.

### Step 6: Run all gates

**Verify**: all command-table gates pass.

## Test plan

Use temporary Git repos/worktrees. Cover zero/one/multiple commits, dirty child, dirty parent, overlap, diverged base, conflict restoration after a partially applied multi-commit range, missing path, inspect/open, dismiss, prune confirmation/cancel, and path shell safety.

## Done criteria

- [ ] Settled worktree results have inspect/apply/dismiss/prune flow.
- [ ] Apply is human-confirmed, committed-only, and conflict-restoring.
- [ ] Dismiss is non-destructive.
- [ ] Prune is clean-only, non-force, confirmed, and branch-preserving.
- [ ] No automatic push/merge/PR/branch deletion exists.
- [ ] Deterministic visual review evidence captures the settled result card and disposition modal together.
- [ ] Full unit/integration/visual gates pass with review evidence.
- [ ] `git status --short` contains only files listed in Scope plus this plan/index bookkeeping.
- [ ] Plan 113's `plans/README.md` row is updated to `DONE` with completion evidence.

## STOP conditions

- Commit-range/working-tree preflight changes a Current state assumption, any verification fails twice after a reasonable fix, or completion requires an out-of-scope file.
- Parent checkout cannot be restored exactly after a failed apply, or restore/quit cannot prove the pre-action HEAD/porcelain snapshot and clear all cherry-pick sequencer state.
- Applying requires force, branch deletion, or automatic merge.
- Manifest evidence is stale and cannot be revalidated from Git.
- UI requires a new overlay outside the shared Cathedral modal contract.
- Capturing the result flow would require changing a Bible target, required crop, runtime golden/status, or promoting a golden.

## Maintenance notes

Git truth is checked at action time. A future `/sumo:ship` integration may start only after apply completes and must retain its separate commit/push/PR confirmations.
