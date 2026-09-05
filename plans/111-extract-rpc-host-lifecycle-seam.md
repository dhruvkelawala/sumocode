# Plan 111: Extract a plain-TypeScript RPC host lifecycle seam

> **Executor instructions**: Follow this plan step by step and run every verification command. Refactor without changing observable behavior. Add lifecycle characterization first, then move ownership behind one deep module. This plan does not adopt Effect. Run signal, reload, child-exit, readiness, integration, and visual gates; never promote goldens. When done, update this plan's row in `plans/README.md` unless a reviewer says they own the index.
>
> **Drift check (run first)**: `git diff --stat b34bd79..HEAD -- dist/host src/sumo-tui/rpc/host.ts src/sumo-tui/rpc/host-lifecycle.ts src/sumo-tui/rpc/host-lifecycle.test.ts src/sumo-tui/rpc/runtime.ts src/sumo-tui/rpc/runtime.test.ts src/sumo-tui/rpc/client.ts src/sumo-tui/rpc/client.test.ts src/sumo-tui/rpc/chrome-cache-worker-client.ts src/sumo-tui/runtime/terminal-controller.ts test/integration/rpc-host-shell.test.ts`
> **Working-tree preflight (run at the same time)**: `git status --short -- dist/host src/sumo-tui/rpc/host.ts src/sumo-tui/rpc/host-lifecycle.ts src/sumo-tui/rpc/host-lifecycle.test.ts src/sumo-tui/rpc/runtime.ts src/sumo-tui/rpc/runtime.test.ts src/sumo-tui/rpc/client.ts src/sumo-tui/rpc/client.test.ts src/sumo-tui/rpc/chrome-cache-worker-client.ts src/sumo-tui/runtime/terminal-controller.ts test/integration/rpc-host-shell.test.ts`. If this reports pre-existing work, STOP and preserve it; do not layer the refactor on an unknown dirty surface.
> If the commit-range drift reports an in-scope change, compare the Current state excerpts and assumptions with live code. If behavior/signatures differ, STOP and request plan reconciliation.
> **Dependency check**: Confirm every plan named in **Depends on** is `DONE` in `plans/README.md`. If any is not DONE, STOP; do not recreate or assume its APIs.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/094-truthful-command-readiness.md`, `plans/104-terminal-delivery-end-to-end-recovery.md` (Plan 110 is independent evidence; GO or NO-GO does not gate this plain-TypeScript seam)
- **Category**: tech-debt
- **Milestone**: M4 — Effect adoption
- **Planned at**: commit `b34bd79`, 2026-08-28
- **Issue**: https://github.com/dhruvkelawala/sumocode/issues/405

## Why this matters

`runRpcHost()` is a roughly thousand-line coordinator that constructs resources near the top and tears them down hundreds of lines later through mutable closures. Session hydration, terminal ownership, child ownership, timers, signals, worker draining, subscriptions, and readiness are interleaved. A deep lifecycle module makes acquisition/finalization reviewable and creates a safe boundary for any future implementation change; it is valuable even if the Effect pilot returns NO-GO.

## Current state

`src/sumo-tui/rpc/host.ts:852+` currently constructs settings, chrome-cache worker, RPC client, transcript/state/activity stores, subscriptions, region registry, modal/overlay/notification layers, scheduler, editor, timers, signal handlers, runtime, hydration, and final wait in one function.

Teardown is centralized late in the same function:

```ts
const stop = async (code = 0): Promise<void> => {
  stopPromise ??= (async () => {
    // timers/watchers → runtime/terminal → regions/activity → child → cache
  })();
  await stopPromise;
};
```

Important contracts:
- pre-spawned child ownership transfers before entry-owner listeners are removed;
- reload may preserve terminal state and hydrate off-screen;
- all exits funnel through exit-code-file publication;
- terminal cleanup is byte-level and idempotent;
- chrome-cache drain has a bounded grace;
- command readiness follows hydration/action settlement (Plan 094).

## Target module

Create a `RpcHostLifecycle` (or similarly named) deep module that owns:
- acquired resources and reverse-order finalizers;
- startup phase state (`constructing`, `child-owned`, `editor-ready`, `hydrating`, `command-ready`, `stopping`, `stopped`);
- signal/unhandled-error registration and removal;
- one idempotent `start()`, `stop(code, reason)`, and `waitForExit()` boundary.

Keep transcript, scheduler, controls, renderer, and pure state machines in their existing modules. The lifecycle coordinates them; it does not absorb their logic.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Host unit | `pnpm vitest run src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/runtime.test.ts src/sumo-tui/rpc/client.test.ts` | pass |
| Lifecycle | `pnpm vitest run src/sumo-tui/rpc/host-lifecycle.test.ts` | pass |
| Integration | `pnpm vitest run test/integration/rpc-host-shell.test.ts --fileParallelism=false` | pass |
| Full/visual | `pnpm exec tsc --noEmit && pnpm build && pnpm lint && pnpm test && pnpm test:integration && pnpm visual:ci` | exit 0 |

## Committed bundle freshness

After final source edits, run `pnpm build:host` before `pnpm test`; keep the generated `dist/host/**` changes in this plan. Integration tests rebuild committed bundles, so rerun `pnpm build:host` afterward and verify no additional unexpected generated drift.

## Scope

**In scope**:
- `dist/host/**` generated by `pnpm build:host`.
- `src/sumo-tui/rpc/host.ts`
- `src/sumo-tui/rpc/host-lifecycle.ts` and test (create).
- Narrow lifecycle interfaces in runtime/client/chrome-cache/terminal modules, with focused `runtime.test.ts`/`client.test.ts` updates.
- `test/integration/rpc-host-shell.test.ts` characterization/regression updates.

**Out of scope**:
- Effect imports or runtime.
- Changing RPC protocol, prompt queue, renderer composition, session semantics, or readiness meanings.
- Rewriting controls/transcript/activity implementations.
- Visual redesign or golden promotion.

## Git workflow

- Branch: `advisor/111-rpc-host-lifecycle-seam`
- Commit in small moves: characterization, lifecycle owner, caller migration.
- Message: `refactor(rpc): extract host lifecycle owner`

- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add lifecycle order characterization

Instrument injected fakes to capture acquisition/finalizer order for: normal exit, `/quit`, SIGINT, SIGTERM, child exit, startup rejection before/after child adoption, reload exit 100, runtime start failure, and chrome-cache timeout. Assert terminal restoration and listener/timer cleanup.

Also pin phase transitions from Plan 094. Tests must fail if command-ready occurs before hydration or if a finalizer runs twice.

Name the characterization cases with the prefix `characterizes lifecycle order:`.

**Verify**: `pnpm vitest run src/sumo-tui/rpc/host-lifecycle.test.ts -t "characterizes lifecycle order:"` → the named normal/signal/child/startup/reload/cache cases all pass against the pre-refactor adapter before ownership moves.

### Step 2: Define resource/finalizer interfaces

Introduce a small lifecycle-owned registration primitive that records named idempotent finalizers in reverse acquisition order. Separate required finalizers from advisory ones (for example cache flush timeout). Expected shutdown errors become bounded diagnostics; terminal/client cleanup must still run.

Avoid a generic framework: the API should encode this host's phases/resources.

**Verify**: `pnpm vitest run src/sumo-tui/rpc/host-lifecycle.test.ts -t "finalizes"` → reverse-order, duplicate-stop, partial-acquisition, required-error, and advisory-timeout cases pass.

### Step 3: Move ownership, not domain logic

Move signal handlers, unhandled-error handlers, stopPromise/idempotency, timers/watchers/subscription cleanup, runtime/terminal stop, client stop, and cache drain behind the lifecycle module. Keep hydration and action logic in `host.ts`, invoking lifecycle phase transitions at explicit points.

After each move, run targeted tests. Do not perform unrelated rename/format churn.

Add an architecture assertion in `host-lifecycle.test.ts` that parses `runRpcHost()` with the installed TypeScript API and rejects direct `process.on`/`process.once`/`process.removeListener`, `stopPromise`, or resource-specific finalizer declarations there; those owners must occur in `host-lifecycle.ts`. Do not use a whole-file substring check that mistakes imported names/comments for ownership.

**Verify**: `pnpm vitest run src/sumo-tui/rpc/host-lifecycle.test.ts -t "keeps lifecycle ownership behind RpcHostLifecycle"` → one pass, and its forced source fixture containing a direct process listener fails.

### Step 4: Prove reload/adoption boundaries

Run the existing pre-adoption/post-adoption signal fixtures and reload handoff. Confirm one owner always holds child and terminal cleanup responsibility and exit code 100 still reaches the launcher.

**Verify**: `for i in 1 2 3; do pnpm vitest run test/integration/rpc-host-shell.test.ts --fileParallelism=false || exit 1; done` → three consecutive passes including pre-/post-adoption signal and reload cases.

### Step 5: Run full and visual gates

No visual change is expected. If cells differ, STOP rather than promoting a golden.

**Verify**: all command-table gates pass; visual reports show no required drift.

## Test plan

Cover every acquisition cut point, duplicate stop, stop during hydration, signal during pre-spawn adoption, child crash idle, unhandled sync/async error, reload preserve-terminal, cache timeout, and normal exit.

## Done criteria

- [ ] One deep lifecycle module owns resource phases and finalization.
- [ ] `runRpcHost()` retains domain orchestration but not scattered cleanup ownership.
- [ ] Every partial-start and exit path is characterized.
- [ ] Readiness, reload, signal, child, and terminal behavior are unchanged.
- [ ] Full unit/integration/visual gates pass with no golden promotion.
- [ ] `git status --short` contains only files listed in Scope plus this plan/index bookkeeping.
- [ ] Plan 111's `plans/README.md` row is updated to `DONE` with completion evidence.

## STOP conditions

- Commit-range/working-tree preflight changes a Current state assumption, any verification fails twice after a reasonable fix, or completion requires an out-of-scope file.
- Refactor changes terminal bytes, event ordering, session ownership, or readiness semantics.
- A resource cannot be assigned one clear owner/finalizer.
- Scope expands into scheduler/transcript/render redesign.
- Effect becomes necessary to complete the plain-TypeScript seam.

## Maintenance notes

A future Effect host migration may replace the lifecycle implementation only after matching this contract suite. Promise/Pi/RPC/TUI adapters stay at the boundary.

### Review repair against `a6f75ea2`

Clean HEAD was verified as `a6f75ea2b3b7553c14cfc23e600db42bf30ef35e`; issue #405 and this public plan were compared with the actual source, not the review's older line numbers.

- **High 1: partly stale, remaining defect repaired.** `95e143c3` already made fatal client shutdown retain a shared reap promise and kept the post-adoption protocol regression. However, `client.ts:441` still dropped its child reference early, and the reap deadline could resolve while the process was alive after SIGKILL. Ownership now lasts until reap completion; the timeout bounds inherited stdio only after process exit. `client.test.ts:103` covers malformed JSON, oversized frames, and child errors through TERM, delayed KILL/exit, close, and duplicate stop. All three cases failed against the old reference release and again against the live-process deadline, then passed with the repair. Partial setup/adoption rejection is covered at `client.test.ts:232`.
- **High 2: already fixed at the pin.** `host-lifecycle.ts:64–118` rejects pre-adoption fatal events to the entry owner, finalizes host resources, and arms host signals before releasing entry listeners. It does not route pre-adoption fatal events to process exit. The existing two-event rejection tests remain at `host-lifecycle.test.ts:292`; the delayed-child finalizer test at line 246 now covers signals, both adopted fatal events, child crash, and natural return.
- **Medium 3: already fixed at the pin.** `host.ts:1780–1784` passes `options.env ?? process.env` on natural return. `host.test.ts:1383` now exercises `main(options)` via its no-TTY return without spawning Pi; an ambient exit-file sentinel detects the wrong environment. Temporarily restoring the reported faulty call made this test fail; the pinned implementation was restored.
- **Design concern: extraction is genuine, not a class deletion.** `RpcHostLifecycle` owns phases, fatal/signal handlers, idempotency, timer/watcher cleanup, reverse-order view finalizers, terminal fallback, child wait, and advisory cache drain. `runRpcHostSession` still composes domain resources and explicitly hands them over; it does not own their finalization. The AST guard checks both host functions. Moving all domain constructors into the lifecycle would expand this repair without improving cleanup ownership.

**Tradeoffs:** keep the external Promise interface and host-shaped acquisition methods; no Effect or generic resource framework. A process that never reports exit is not declared reaped merely because KILL was sent: shutdown may remain pending rather than falsely report success. Inherited stdio remains bounded after exit. No terminal bytes, rendering, launcher selection, owner-106/112 files, bundles, goldens, or plan index changed. Two arbitrary-error sink annotations and an ignored raw-mode return type were made lint-clean in the extracted module/tests.

**Verification:** focused four-file suite 187/187; RPC plus terminal lifecycle/controller suites 679/679 with one worker; `pnpm exec tsc --noEmit`, `pnpm build`, and `pnpm lint` passed. The first parallel broader run timed out in untouched `session-reader.test.ts`; the complete one-worker rerun passed. Full unit/native, real PTY/integration, and visual gates are deliberately left to the parent-owned heavy lane. Spec-axis review is pending parent relay; this note does not mark the whole plan DONE.
