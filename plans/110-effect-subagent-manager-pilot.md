# Plan 110: Evaluate an Effect v4 implementation of the subagent lifecycle

> **Status: DEFERRED outside the current campaign (owner reversal, 2026-09-05); no GO/NO-GO
> verdict recorded.**
> Effect is removed from the current plan wave. This plan is **NOT DONE**, and no GO/NO-GO
> verdict has been recorded: no production Effect dependency or migration is authorized now,
> and the audit campaign does not wait on an Effect verdict. Dhruv will run a separate, deeper
> Effect integration spike later. The pilot code, evidence, and provisional report are preserved
> — untouched and unpublished — on `spike/404-effect-subagent-pilot`, and the draft staged
> adoption-doc revisions stay on `sumo/draft-staged-effect-adoption-plan-revisions`, for that
> future spike. Do not execute this plan inside the current campaign; the steps below — including
> the provisional-recommendation and human GO/NO-GO verdict requirements — are retained as the
> specification for that future spike.

> **Executor instructions**: Follow this plan step by step and run every verification command. This is a contained spike, not authorization for a broad rewrite. Keep production `SubagentManager` as the reference implementation. Use stable Effect core APIs only, pin the tested RC exactly as a devDependency, and produce evidence plus a provisional recommendation for human review. Do not switch production in this plan. When evidence is complete, update this plan's row in `plans/README.md` unless a reviewer says they own the index.
>
> **Drift check (run first)**: `git diff --stat b34bd79..HEAD -- dist/host dist/extension package.json pnpm-lock.yaml src/subagents/manager.test.ts src/spike/effect-subagents docs/research/effect-subagent-pilot.md`
> **Working-tree preflight (run at the same time)**: `git status --short -- dist/host dist/extension package.json pnpm-lock.yaml src/subagents/manager.test.ts src/spike/effect-subagents docs/research/effect-subagent-pilot.md`. If this reports pre-existing work, STOP and preserve it.
> If commit-range drift changes a Current state pilot/reference assumption, STOP and request plan reconciliation.
> **Read-only reference check**: `git diff --stat b34bd79..HEAD -- src/subagents/manager.ts scripts/build-extension.mjs scripts/build-host.mjs docs/research/effect-v4-feasibility.md`. These define the reference/bundle policy but are out of scope; STOP if matching them would require production edits.
> **Dependency check**: Confirm every plan named in **Depends on** is `DONE` in `plans/README.md`. If any is not DONE, STOP; do not recreate or assume its APIs.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/109-contain-subagent-lifecycle-failures.md` (defines the reference lifecycle/failure contract the pilot must match)
- **Category**: direction
- **Milestone**: M4 — Lifecycle
- **Planned at**: commit `b34bd79`, 2026-08-28
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/404

## Why this matters

`SubagentManager` hand-rolls serialized spawn/dequeue Promise tails, settlement de-duplication, timeout races, cancellation, and unowned event consumption. These are a plausible Effect fit, but Effect v4 is release-candidate software and externalized imports measured substantial startup/RSS cost. A controlled off-startup-path pilot should prove lifecycle value before any production dependency or RPC-host migration.

## Current state

`src/subagents/manager.ts` exposes a contained imperative API: `spawn`, `sendTo`, `waitFor`, `cancel`, `close`, `list`, listeners, and `disposeAll`. Internally it uses:
- `visibleSpawnTail`/`dequeueTail` at lines 153-154 and serialized updates around 596/643;
- `settlingPromises`/`settlingOutcomes` maps at lines 156-157 and settlement ownership around 750-759;
- `Promise.race` + timer around line 815 for manifest timeout;
- AbortControllers and event consumers;
- mutable maps for queue/capacity/snapshots.

`src/subagents/manager.test.ts` has broad coverage for capacity, setup cancellation, worktrees, placement, settlement, manifests, and pruning. Current build scripts use esbuild `packages: "external"`. Research measured externalized Effect imports as materially heavier than bundled/tree-shaken imports. Repository convention allows throwaway exploration only under `src/spike/`; production code must not import from it.

## Pilot contract

- Preserve the public manager interface and observable ordering exactly.
- Prototype under `src/spike/effect-subagents/`; no production import.
- Use stable core concepts: `Effect`, `Scope`, `Fiber`, `Semaphore`, `Deferred`, `Ref`/`SynchronizedRef`, `Schedule`, `ManagedRuntime` only where justified.
- Do not use `effect/unstable/rpc`, process, persistence, worker, or CLI APIs.
- One managed runtime per pilot process, lazily created; every scope/fiber must have an explicit finalizer.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Reference | `pnpm vitest run src/subagents/manager.test.ts` | pass |
| Pilot (created Steps 2–3) | `pnpm vitest run src/spike/effect-subagents/*.test.ts` | reference/effect contract suites pass |
| Full repo | `pnpm exec tsc --noEmit && pnpm build && pnpm lint && pnpm test` | exit 0, including spike tests |
| Evidence (created Step 4) | `node src/spike/effect-subagents/measure.mjs --json` | one bounded JSON object with sample count, medians, RSS/import/bundle/complexity fields |

## Committed bundle freshness

Adding the Effect devDependency changes `package.json`/`pnpm-lock.yaml`, which are inputs to both committed bundle manifests even though production imports stay unchanged. Run `pnpm build:host && pnpm build:extension` before `pnpm test` and keep `dist/host/**` plus `dist/extension/**` generated changes in scope.

## Scope

**In scope**:
- `dist/host/**` and `dist/extension/**` generated after package metadata changes.
- `package.json`, `pnpm-lock.yaml` with the current `effect@rc` resolved to one exact prerelease string (for example `4.0.0-rc.N`, with no `^`, `~`, tag, or wildcard) under **devDependencies** only; consumers must not install Effect.
- `src/spike/effect-subagents/contract-suite.ts`, `reference.test.ts`, `effect.test.ts`, pilot implementation/adapter modules, and `measure.mjs` (create).
- `src/subagents/manager.test.ts` only if extracting reusable black-box fixtures without changing existing reference assertions; prefer spike-local contract adapters.
- `docs/research/effect-subagent-pilot.md` (create).
- Test parameterization helpers only if they do not alter production behavior.

**Out of scope**:
- Importing pilot code from production modules.
- Changing `src/subagents/manager.ts` behavior beyond test extraction.
- RPC host, renderer, terminal store, schemas, or Pi interfaces.
- Claiming startup/performance improvement.

## Git workflow

- Future spike starting point, only when Dhruv resumes this deferred work: `spike/404-effect-subagent-pilot`. Base any new working branch on that preserved pilot, not the former `advisor/110-effect-subagent-pilot` target. Reconcile the retained steps and drift checks with its existing code and evidence before continuing; do not restart or publish the old pilot.
- Commit: `spike(effect): evaluate subagent lifecycle`
- A NO-GO result is valid; do not force adoption to justify the spike.

- Do not push or open a PR unless instructed.

## Steps

### Step 1: Pin Effect and read installed guidance

Run `pnpm add --save-dev --save-exact effect@rc`, then resolve the installed package root. If `effect/AGENTS.md` exists, read it completely. If absent, record that fact and read the installed `README.md`, `package.json#exports`, and declaration/docs for every imported module; STOP if neither installed guidance nor declarations establish API stability. Record exact version, Node/TypeScript compatibility, and unstable APIs in the report. Do not use a floating range or add Effect to production `dependencies`/peer dependencies.

**Verify**: `node -e 'const p=require("./package.json"); const v=p.devDependencies?.effect; if(!v || /^[~^*>]/.test(v)) process.exit(1); if(p.dependencies?.effect || p.peerDependencies?.effect) process.exit(1); console.log(v)' && pnpm exec tsc --noEmit` → prints one exact RC and exits 0.

### Step 2: Extract a behavior contract matrix

Create the spike-local `contract-suite.ts` and `reference.test.ts` named in Scope. Run the same adapter contract cases for capacity/queue FIFO, visible serialization, setup cancellation generation, settle de-duplication, async event failure, manifest timeout, wait abort, batch cancel/close, listener ordering, pruning, and finalization. Do not weaken existing manager tests.

**Verify**: `pnpm vitest run src/subagents/manager.test.ts src/spike/effect-subagents/reference.test.ts` → existing suite plus all named reference contract cases pass before Effect implementation exists.

### Step 3: Implement the scoped pilot

Model manager ownership in one scope. Use a semaphore for visible spawn serialization, a queue/fiber for dequeue work, Deferred for wait/settlement, and scoped timeout/finalizers. Keep Git/worktree/terminal-host operations behind existing Promise interfaces with `Effect.tryPromise` adapters and typed expected failures.

Expose only Promise/plain-object methods through an adapter matching the reference interface. No Effect type may cross it.

**Verify**: `pnpm vitest run src/spike/effect-subagents/reference.test.ts src/spike/effect-subagents/effect.test.ts` → identical contract matrix passes for both adapters; forced failure/interruption/scope-close cases report zero live fibers/timers/finalizers afterward.

### Step 4: Measure and compare

Create `src/spike/effect-subagents/measure.mjs`. Use the repository's installed `jiti` to load the TypeScript pilot so the script does not depend on Node type-stripping syntax restrictions. For bundle comparison, invoke esbuild in a temporary output directory twice: once with the current external-package policy and once as a throwaway bundled/tree-shaken arm. Do not edit `scripts/build-extension.mjs` or committed production bundle policy.

Produce repeatable measurements for:
- source/branch complexity (lines, mutable fields, explicit finalizers);
- externalized and bundled import latency;
- RSS after idle/runtime creation and 10/100 synthetic children;
- bundle size/tree-shaking;
- cancellation/finalizer tests;
- full pilot test duration.

Measurements are evidence, not promises. Use at least seven isolated samples per timing/RSS arm, report medians plus Node/platform/architecture, and keep raw arrays bounded in JSON. During this step, write the measurement sections and embedded metrics JSON block into `docs/research/effect-subagent-pilot.md`. Add `--check-report <path>` to validate that block against the current schema; Step 5 then adds the provisional decision table/status.

**Verify**: `node src/spike/effect-subagents/measure.mjs --json > /tmp/effect-subagent-metrics.json && node src/spike/effect-subagents/measure.mjs --check-report docs/research/effect-subagent-pilot.md` → both exit 0 after the report is written; JSON has seven samples/arm and required medians. `/tmp` output is ephemeral and must not enter git.

### Step 5: Produce a provisional recommendation for human verdict

Write `docs/research/effect-subagent-pilot.md` with a fixed decision table: contract pass/fail, leak count, public Effect type count, exact RC/unstable APIs, lazy import evidence, reference-vs-pilot LOC/mutable coordination/finalizer counts, externalized and bundled import/RSS/size medians, and adapter complexity risks. Label the result `PROVISIONAL GO`, `PROVISIONAL NO-GO`, or `EVIDENCE INCOMPLETE` by the explicit mandatory gates (behavior parity, zero leaks/public Effect types/production imports, reproducible measurements). Do not let the executor convert qualitative “locality/clarity” into a final direction decision.

Dhruv's explicit review is required before the recommendation is called GO/NO-GO or cited by a production Effect migration plan. Plan 111 remains independent. This spike has no production import, so do not claim application command-ready improvement/regression.

**Verify**: `pnpm vitest run src/spike/effect-subagents/*.test.ts && node src/spike/effect-subagents/measure.mjs --check-report docs/research/effect-subagent-pilot.md && pnpm exec tsc --noEmit && pnpm build && pnpm lint && pnpm test` → exit 0; `rg -n "PROVISIONAL (GO|NO-GO)|EVIDENCE INCOMPLETE" docs/research/effect-subagent-pilot.md` returns exactly one status line.

## Test plan

The shared matrix must include every lifecycle race named above, plus forced defects proving finalizers run on failure, interruption, and scope close. Add a leak assertion for timers/fibers.

## Done criteria

- [ ] Exact RC pinned and installed guidance followed.
- [ ] Reference and pilot pass one black-box lifecycle matrix.
- [ ] Pilot uses no unstable Effect modules and leaks no public Effect types.
- [ ] Import/RSS/bundle/complexity evidence is reproducible.
- [ ] Report gives an evidence-backed provisional recommendation and explicitly records pending human verdict.
- [ ] Production manager remains the default and startup path is unchanged; full `pnpm test` includes and passes the spike.
- [ ] `git status --short` contains only files listed in Scope plus this plan/index bookkeeping and the ephemeral ignored measurement file is absent from git.
- [ ] Plan 110's `plans/README.md` row is updated to `DONE` for evidence completion, not production adoption.

## STOP conditions

- Commit-range/working-tree/read-only preflight changes a pilot assumption, any verification fails twice after a reasonable fix, or completion requires an out-of-scope file.
- Installed Effect guidance/declarations are absent or cannot establish the imported API stability.
- Required primitives exist only under `effect/unstable/*`.
- Pilot needs Effect types in Pi/tool/renderer public contracts.
- Effect imports enter normal startup despite no subagent use.
- Reference behavior is ambiguous; stop and tighten Plan 109/tests first.

## Maintenance notes

Plan 111's plain-TypeScript RPC lifecycle seam is independent and may proceed on its own prerequisites regardless of this verdict. A GO here authorizes only a separate production Effect migration review/plan. If NO-GO, remove the pilot dependency/code in that follow-up or retain only the report; do not keep a permanent dual implementation without ownership.
