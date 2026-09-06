# Plan 111: retrospective cleanup proof

## Pins and chronology

This is retrospective validation, **not** pre-refactor characterization or RED/TDD history. Commit `a6f75ea2` introduced the lifecycle module, its tests, and host migration together. That cannot satisfy the plan's literal requirement to commit/run characterization before refactoring. Reviewer acceptance of retrospective evidence remains necessary; this note does not mark Plan 111 DONE or change its milestone.

- Legacy: `99b8cc4d7e0f73fccd71c94f109903a768077d25`.
- Starting candidate: `cb9d42fd10472351c256f0524679ab1fd6e0a8c5`.
- Verified candidate: `8d36a3525a8da7041abd493edc636b85d313a68e`.
- Identical test in both trees: `src/sumo-tui/rpc/host-cleanup.test.ts`, SHA-256 `769e0703f4c02bbee92221edd937892844d87354f18c5e9003493dd80ebf285f`.

Both revisions were extracted with `git archive` into separate temporary directories, sharing the installed dependencies by symlink. Only the new test was copied into the legacy tree. Its `host.ts` was byte-compared with `git show 99b8cc4:src/sumo-tui/rpc/host.ts`; they matched. No checkout, historical source patch, fake legacy cleanup adapter, or `95e143c3` client substitution was needed. The candidate archive was verified after concurrent client-test edits appeared in the working tree, so those edits are not part of this evidence.

## What the paired test proves

It calls the actual exported `runRpcHost()` in each revision, including the old closure-owned `stop()` and `finally` path. Three behavior cases pass in both:

1. **Runtime start rejects after adoption:** runtime stop → regions dispose → activity unsubscribe → activity dispose → child stop → cache dispose; host returns 1 and reports the injected failure.
2. **SIGINT at adoption:** signals are installed before the adoption callback; no runtime stop is observed in this pre-runtime path; regions/activity → child → cache cleanup precedes one injected exit with 130 and exit-file publication of 130.
3. **SIGTERM at adoption:** the same observable ordering and exit-file behavior, with code 0.

Each case holds child stop pending and asserts cache disposal and injected process exit have not happened. After releasing it, exact finalizer lists exclude duplicate calls, and SIGINT/SIGTERM/unhandledRejection/uncaughtException listener arrays match their pre-run baselines.

This proves the asserted host ordering, not whole-system equivalence. It does not prove terminal escape bytes, actual child reap, readiness, successful natural return, `/quit`, reload 100, fatal-event handling, every partial acquisition, or cache timeout against the legacy host. In particular, the runtime-start-failure test asserts the **host return code**, not the argument to `runtime.stop`: legacy catch invokes `stop(0)` before returning 1, whereas the candidate lifecycle stops with 1. Do not cite this test as equality of those internal arguments or all shutdown timing.

## Interface repair and tradeoffs

`RpcHostExitDependencies.setTimeout` again exports `typeof setTimeout`, exactly as at the legacy pin. The test includes a type-equality assertion checked by candidate `tsc`. The private host-owned adapter retains lifecycle timer cancellation; a local SAFETY assertion documents that `createRpcExitHandler` uses only a zero-argument callback, numeric delay, and the returned timer. It is not a general Node timer implementation and is not exposed to callers. No lifecycle/client ownership repair from `cb9d42fd` was undone.

The historical host exposes injected streams, exit, and adoption callback, but not resource constructors. Rather than modify it or add production interfaces solely for retrospective testing, this one test file uses scoped module mocks for theme, git, runtime, and worker effects, plus prototype spies for child/activity/region effects. The cache drain function remains real. The lint exception for module mocking is bounded to that block. Mock isolation requires a separate file rather than altering the existing broad `host.test.ts`. No real Pi process, PTY, worker, or terminal is started. Temporary proof directories were retained, not cleaned up.

## Reproduce the paired proof

From a checkout containing the verified candidate and installed dependencies:

```bash
repo="$PWD"
legacy=$(mktemp -d /tmp/sumo-plan111-legacy-XXXXXX)
candidate=$(mktemp -d /tmp/sumo-plan111-candidate-XXXXXX)
git archive 99b8cc4d7e0f73fccd71c94f109903a768077d25 | tar -x -C "$legacy"
git archive 8d36a3525a8da7041abd493edc636b85d313a68e | tar -x -C "$candidate"
ln -s "$repo/node_modules" "$legacy/node_modules"
ln -s "$repo/node_modules" "$candidate/node_modules"
cp "$candidate/src/sumo-tui/rpc/host-cleanup.test.ts" "$legacy/src/sumo-tui/rpc/host-cleanup.test.ts"
(cd "$legacy" && pnpm vitest run src/sumo-tui/rpc/host-cleanup.test.ts --maxWorkers=1 --fileParallelism=false)
(cd "$candidate" && pnpm vitest run src/sumo-tui/rpc/host-cleanup.test.ts --maxWorkers=1 --fileParallelism=false)
```

Observed: legacy **4/4 passed** (three behavior cases plus the type-assertion test); candidate **4/4 passed** within the following **191/191** suite. Vitest alone does not check the type assertion; candidate `tsc` below does.

```bash
pnpm exec tsc --noEmit && pnpm build
pnpm exec oxlint src/sumo-tui/rpc/host.ts src/sumo-tui/rpc/host-cleanup.test.ts
pnpm vitest run src/sumo-tui/rpc/host-cleanup.test.ts src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/host-lifecycle.test.ts src/sumo-tui/rpc/runtime.test.ts src/sumo-tui/rpc/client.test.ts --maxWorkers=1 --fileParallelism=false
```

All passed in the candidate archive. No full lint/unit/native, integration, PTY, bundle-build, or visual job was run for this repair while the other owner held the heavy lane.

## Remaining gate

P3 is repaired; P2 now has bounded actual-legacy paired evidence, not the original test-first sequence or the full characterization matrix. After lane release, the owner must disposition that chronology gap and complete the remaining Plan 111 gates. In particular, use the supervised `pnpm test:integration` entry (not an unsupervised PTY invocation) for the existing pre-/post-adoption, protocol-reap, reload, stalled-hydration and `/quit` contracts. Run the full project lint/unit/native and visual gates as required by the parent campaign; no golden promotion is authorized. Broader legacy pairing still needs to be prepared/run if the reviewer requires the entire Step 1 matrix, rather than treating candidate-only integration evidence as retrospective parity.

## Review-ready gate

- **Contract:** bundled `review-ready/contract.md` (no repository override found).
- **Changed seam:** exported timer dependency and caller-facing host cleanup proof; lifecycle ownership remains unchanged.
- **Trace:** `runRpcHost` → adoption/start failure or signal → actual revision's shutdown → delayed child barrier → cache disposal → exit/result and listener cleanup.
- **Four tests:** caller-knowledge — public timer contract restored; deletion — deleting the proof removes evidence, not production ownership; ownership — lifecycle retains timers/reap; test-surface — actual public host, not a fabricated legacy adapter.
- **Simplification pass:** no production constructor-injection API or generic timer wrapper; scoped private assertion instead of imitating Node's complete timer namespace.
- **Verification:** pinned paired proof, 191 targeted tests, typecheck/build, scoped lint, diff whitespace check passed.
- **Exceptions:** historical-effect module mocks and local timer assertion justified above; full gates, full legacy matrix and chronology acceptance remain pending. This is a bounded repair report, not campaign completion.
