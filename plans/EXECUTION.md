# Plan execution contract

Use this contract when implementing plans 091–115. The plan file is the execution authority; the linked GitHub issue is coordination metadata.

## 1. Select only ready work

1. Read the plan completely.
2. Confirm every **Depends on** row is `DONE` in `plans/README.md`.
3. For Plan 115, additionally confirm every non-rejected Plan 091–114 row is `DONE`; this final-wave gate is mandatory even when the plan's direct API dependencies are complete.
4. Run the plan's commit-range drift check and working-tree preflight before editing.
5. If either preflight or a dependency/final-wave contract fails, mark the row `BLOCKED` with evidence. Do not recreate dependency APIs.

Completion criterion: the selected plan is `TODO`, all dependencies and any final-wave gate are `DONE`, and both preflights are clean.

## 2. Isolate one plan per worktree

Branch from the committed planning baseline into one isolated worktree. Keep one plan per branch; shared-surface plans follow the integration order in `plans/README.md`. Execute only the plan's **In scope** paths plus its own plan/index bookkeeping. Build committed host/extension bundles exactly when the plan requires them.

Do not push, open a PR, promote visual goldens, delete records/worktrees/branches, or broaden scope without explicit operator approval.

Completion criterion: `git status --short` contains only scoped implementation, generated bundle, and plan/index status files.

## 3. Route model strength by risk

The 2026-08-28 Plan-105 trial used `zai/glm-5.3-flash` in an isolated worktree. It stayed in scope, produced a coherent regression, passed targeted/type/build/lint checks, reproduced unrelated suite failures against pristine baseline, and stopped instead of weakening gates. It also proved Plan 105's expected red premise false: Vitest already filters the integration invocation to 30 integration-only files. Plan 105 is therefore rejected, and the trial does **not** justify cheap execution across this backlog.

- **Cheap implementation with smart review:** Plans 103 and 115 only. The cheap child may produce a bounded candidate branch; a smart reviewer must verify wait semantics or documentation authority before integration.
- **Smart implementation:** Plans 091–102, 104, and 106–114. This includes every P0/P1, security, persistence, lifecycle, Git mutation, retained-renderer, RPC-host, and Effect plan.
- **Human gate:** visual golden promotion, dependency-security disposition, worktree apply/prune, final Effect GO/NO-GO, push, and PR publication.

A cheap child may still perform a precisely scoped mechanical subtask inside smart-owned work, but it does not own the plan verdict, scope changes, or final integration.

## 4. Hand off local-only security plans

Full plans 092, 097–100, and 102 are intentionally ignored in this public repository. Their sanitized briefs under `plans/issues/` are not implementation specifications.

Do not give the path to `subagent_spawn`, an ordinary Pi session, or any other recorded child and tell it to read the file: the read result would become durable transcript content. Do not read a full private plan through tools in the public campaign/orchestrator session.

For one of these plans:

1. Create the isolated implementation worktree from the committed public baseline.
2. Invoke the approved private non-recording runner with only the absolute ignored-plan path and isolated-worktree path visible to the orchestrator. The runner itself lives outside this public repository.
3. The runner must use a smart model with Pi session persistence disabled, deliver plan content through private mode-0600 stdin/file input rather than process argv, disable diagnostics, and capture raw stdout/stderr to mode-0600 storage outside the repository. It may return only an allowlisted summary: exit state, commit/head, changed paths, named gate pass/fail, and a generic blocker category.
4. Before the first security implementation, run the private runner's contract test and prove: no Pi/SumoCode session or task transcript was created; process metadata contained no prompt/plan content; no diagnostics/public artifact contained private text; and the orchestrator received only the allowlisted summary. If the pinned Pi/runtime cannot satisfy this, mark the security wave `BLOCKED` instead of falling back to an ordinary child.
5. Run the independent smart security review through the same non-recording boundary. Never inject its raw review/tool output into the campaign transcript; only the allowlisted verdict/summary may return.
6. Keep the full plan and detailed evidence out of commits, issues, PRs, ordinary agent transcripts, terminal/task records, diagnostics, and build artifacts. Public issue/PR text uses only the sanitized brief and sanitized status.

Completion criterion: both implementation and security-review runner contract tests pass; the implementation branch contains no ignored plan/evidence content; the orchestrator transcript contains no private plan/tool output; and the public issue receives only sanitized status information.

## 5. Verify and record

Run every step gate and final command in the plan under its declared expected-result contract.

### Load-sensitive unit-suite adjudication

Expected workstation load is not a poisoned-environment condition and does not justify waiting for an idle machine. When a plan explicitly adopts this policy, a failing default-parallel `pnpm test` may be adjudicated on the exact same head only when **all** of these conditions hold:

1. The plan's changed-path focused tests, typecheck, build, and lint are green.
2. Every default-parallel failure is confined to untouched tests and is timeout/timing-shaped or varies across retries; deterministic assertion failures are not eligible.
3. No production or test code is changed in response to the parallel failure.
4. Every failed file passes by itself with file parallelism disabled.
5. The complete suite passes on the same commit with `VITEST_MAX_WORKERS=1 pnpm test` (or the repository's equivalent fully serial command).
6. The plan and index record both the default failure and the serial evidence; they must not claim that the unqualified default command passed.

A changed-path failure, a deterministic failure, or any serial failure is immediately blocking and is never eligible for this adjudication. Two bounded repair attempts may address an understood defect, but retries cannot convert an ineligible failure into a load-sensitive pass. This adjudication changes only local workstation scheduling; current-head CI must still be green before the PR can become `STACK_READY`.

After success:

1. Rerun required bundle builders after integration tests.
2. Confirm no out-of-scope changes.
3. Update the plan's row in `plans/README.md` to `DONE` with commit/test evidence.
4. Leave issue/PR synchronization to the operator unless explicitly instructed.

If a verification fails twice after a reasonable fix or fails the adjudication contract above, preserve evidence and mark the plan `BLOCKED`; do not improvise around the gate.
