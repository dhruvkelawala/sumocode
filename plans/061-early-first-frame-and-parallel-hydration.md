# Plan 061: Paint the splash before hydration — pre-spawn the RPC child, parallelize hydration, and keep the splash pixel-faithful via cached chrome

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0dc25c7..HEAD -- sumo-rpc-host.js src/sumo-tui/rpc/ src/sumo-tui/shell/ src/cathedral/input-hints.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/060-startup-perf-baseline-refresh.md (evidence harness)
- **Category**: perf
- **Planned at**: commit `0dc25c7`, 2026-07-08

## Why this matters

Today the terminal stays completely blank for ~3–4 seconds after `sumocode`
is invoked: the host module import (~1s via jiti), the Pi RPC child boot
(~2.2–2.8s), and four hydration round trips all run **serially**, and the
first frame is only painted after all of them. Measured at `0dc25c7`:
host-import 900–1350ms, child first-response 2200–2800ms (identical with and
without the SumoCode extension). After this plan: the child spawns before the
host import begins (the two overlap), the splash paints as soon as the host
is constructed (~1.2s today, ~0.4s once plan 062 lands), the editor accepts
typing immediately, and hydration fills in asynchronously. The splash stays
pixel-faithful: the only child-dependent pixels on it are one hint line
(`╰─ <model> · <thinking>`), which is rendered optimistically from a
host-side cache of the last-known values — byte-identical to today's splash
in the common case.

**UI fidelity is a hard constraint of this plan** (maintainer requirement):
no layout shift, no placeholder chrome that "pops", no new visible loading
states beyond the one dim-rail fallback specified in Step 6 for genuinely
cache-less first runs.

## Current state

### The serial chain

`src/sumo-tui/rpc/host.ts` — `runRpcHost()` try block, lines 812–843:

```ts
await client.start();                       // spawn + fixed 50ms sleep, line 812
const branch = await readGitBranch(cwd);    // local git, fast          line 813
await controls.refreshState(branch);        // get_state — absorbs the FULL child boot (~2.2s)
await editor.configureAutocomplete(controls); // get_commands round trip
const transcript = visualFixture
    ? visualFixture.transcript
    : transcriptPump.replaceFromMessages(responseData(await client.send({ type: "get_messages" }), "get_messages").messages);
const state = visualFixture ? visualFixture.state : stateStore.getSnapshot();
runtime = new RpcHostRuntime({ ... });      // line 820
await runtime.start();                      // line 843 — FIRST FRAME EVER PAINTED
```

`src/sumo-tui/rpc/client.ts:144–182` — `SumoRpcClient.start()` spawns the
child itself and resolves after a fixed 50ms early-crash check:

```ts
const child = spawn(this.options.command, [...this.options.args], { cwd, env, stdio: ["pipe","pipe","pipe"] });
...
await new Promise((resolve) => setTimeout(resolve, 50));
if (this.exited) throw new Error(`RPC child exited during startup. stderr=${this.stderrBuffer}`);
```

The child args are built at `host.ts:502`:

```ts
const client = new SumoRpcClient({
    command: piBinary(env),                 // env.PI_BIN, required
    args: ["--mode", "rpc", "-e", extensionPath, ...argv],   // extensionPath = resolve(root, "src/extension.ts")
    cwd,                                    // resolve(env.SUMOCODE_PROJECT_CWD ?? process.cwd())
    env: childEnv(env),                     // { ...env, SUMOCODE_RPC_CHILD: "1", SUMO_TUI: "0" }
});
```

`sumo-rpc-host.js` (repo root, entire file):

```js
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { moduleCache: true, tryNative: false });
const mod = await jiti.import("./src/sumo-tui/rpc/host.ts");
await mod.main();
```

The ~1s jiti import happens **before** `runRpcHost` runs, so the child boot
cannot overlap it unless the spawn moves into this entry file.

### The readiness events

`src/sumo-tui/rpc/runtime.ts:266–312` — `RpcHostRuntime.start()` emits all
four readiness diagnostics at the same instant, at the end:

```ts
this.render();
for (const event of ["boot_screen_frame", "stable_chrome_ready", "app_ready", "input_ready"]) {
    logDiagnostic(event, { surface: "rpc_host", cols, rows });
}
```

### The one child-dependent splash line

`src/sumo-tui/rpc/shell-adapter.ts:648–656`:

```ts
function renderSplashHint(state: RpcHostChromeState, width: number): string {
    const frameWidth = Math.min(width, SPLASH_INPUT_FRAME_WIDTH);
    const modelId = state.modelLabel ? state.modelLabel.split("/").pop()! : "no model";
    const hint = renderInputHints(frameWidth, {
        leftHint: splashInvocationHint(modelId, state.thinkingLevel),
        leftHintStyle: "model-thinking",
    });
    return centerAnsi(hint, width);
}
```

`src/cathedral/input-hints.ts:82–84`:

```ts
export function splashInvocationHint(modelId: string, thinkingLevel: string | undefined): string {
    return `╰─ ${modelId} · ${thinkingLevel ?? "thinking"}`;
}
```

Everything else on the splash frame is host-local: wordmark and layout are
static (`src/sumo-tui/cathedral/splash-tree.ts`), theme is applied host-side
before any frame (`applyStartupTheme({ cwd })`, `host.ts:499`), the
project/branch hint comes from local `readGitBranch`, and sidebar/status
regions are child-published extension regions that already arrive after the
first frame today.

### State store

`src/sumo-tui/rpc/state.ts` — `RpcHostChromeState` has optional `modelLabel`
(line 15) and `thinkingLevel` (line 16). `hydrateFromRpcState(rpcState,
gitBranch)` (line 56) sets both from `get_state`. `applyModelChange` (line
157) patches them optimistically — this is the plan-041 "optimistic apply +
reconcile" house pattern this plan extends to startup.

### Conventions to match

- Tabs, TypeScript strict, heavily doc-commented modules explaining *why*
  (match the tone of `host.ts`'s existing comments).
- Dependency-injected, unit-testable factories (see
  `createRpcExitHandler` / `createRpcHostInterruptHandler` in `host.ts` —
  new logic should be factored the same way).
- `~/.sumocode/` is the existing host-side data dir convention
  (`src/memory.ts:82`: `join(homedir(), ".sumocode", "remnic-auth-token")`).
- Test files sit next to sources (`foo.ts` / `foo.test.ts`), vitest.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck/build | `pnpm exec tsc --noEmit && pnpm build` | exit 0 |
| Unit tests (scoped) | `pnpm vitest run src/sumo-tui/rpc/` | all pass |
| Full unit tests | `pnpm test` | exit 0 |
| Integration (PTY, real Pi) | `pnpm test:integration` | all pass (one known PTY-concurrency flake passes in isolation) |
| Visual gate | `pnpm visual:ci` | exit 0 for splash scenarios you touched |
| Perf evidence | `pnpm perf:startup` | exit 0, regenerated docs/perf/ |

## Scope

**In scope** (the only files you should modify/create):
- `sumo-rpc-host.js` (pre-spawn wiring)
- `src/sumo-tui/rpc/spawn-child.mjs` (create — plain JS, shared spawn-arg builder)
- `src/sumo-tui/rpc/host.ts`
- `src/sumo-tui/rpc/client.ts` (accept a pre-spawned child)
- `src/sumo-tui/rpc/runtime.ts` (split readiness events)
- `src/sumo-tui/rpc/state.ts` (add `hydrated` flag)
- `src/sumo-tui/rpc/shell-adapter.ts` (splash hint pre-hydration fallback)
- `src/sumo-tui/rpc/chrome-cache.ts` (create) + `chrome-cache.test.ts` (create)
- Matching test files: `host.test.ts`, `client.test.ts`, `runtime.test.ts`, `state.test.ts`, `shell-adapter.test.ts`
- `test/integration/` (one new PTY test file or extension of an existing one)
- `docs/perf/startup.json`, `docs/perf/startup.md` (regenerated evidence)

**Out of scope** (do NOT touch, even though they look related):
- `bin/sumocode.sh` — the launcher contract (env vars, exit-code file, respawn
  loop) is unchanged; the pre-spawn lives in `sumo-rpc-host.js`, not bash.
- `src/cathedral/input-hints.ts` — `splashInvocationHint` is shared with the
  extension side; change the RPC call site (`shell-adapter.ts`), not the shared helper.
- `src/extension.ts` and anything only the RPC **child** runs.
- Golden promotion (`pnpm visual:promote`) — NEVER run it; produce review
  evidence and stop (AGENTS.md rule: promotion requires Dhruv's approval).
- Pi packages under `node_modules/`.

## Git workflow

- Branch: `advisor/061-early-first-frame`
- Conventional commits per step, e.g. `perf(rpc): pre-spawn the RPC child before host import`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Shared spawn-arg builder + pre-spawn in the entry file

Create `src/sumo-tui/rpc/spawn-child.mjs` — **plain JS with no imports from
the TS tree** (it must be natively importable by `sumo-rpc-host.js` without
jiti). Export:

```js
export function buildChildSpawnPlan(env, argv) {
    // Mirrors host.ts: piBinary/childEnv/extensionPath/hostCwd — returns
    // { command, args, cwd, env } or undefined when env.PI_BIN is unset.
}
```

using exactly the logic quoted in "Current state" (`host.ts:502` block). Keep
`node:path`'s `resolve` as the only import.

In `sumo-rpc-host.js`, before the jiti import: when
`process.stdout.isTTY === true` and a spawn plan is available, spawn the child
(`node:child_process` `spawn`, stdio `["pipe","pipe","pipe"]`) and pass it to
`main({ preSpawnedChild: child })`. Guards:

- **No TTY → no pre-spawn** (runRpcHost exits 70 on non-TTY; a pre-spawned
  child there would be orphaned).
- Wrap in try/catch: on any pre-spawn failure, fall through to
  `main()` with no pre-spawned child (current behavior).
- If the jiti import itself throws, kill the pre-spawned child
  (`SIGTERM`) before rethrowing.

Update `host.ts`: `RpcHostMainOptions` gains
`preSpawnedChild?: ChildProcessWithoutNullStreams`; `main()` forwards it to
`runRpcHost`; `runRpcHost` passes it into the `SumoRpcClient` constructor
options. `host.ts` must now build its args via `buildChildSpawnPlan` too
(single source of truth — delete the inline duplication at line 502, keep
`piBinary`'s "PI_BIN required" error for the no-plan case).

In `client.ts`: `SumoRpcClientOptions` gains
`preSpawnedChild?: ChildProcessWithoutNullStreams`; `start()` uses it instead
of spawning when present (everything else — listener wiring, the 50ms
early-crash check — identical; note the crash check still works because a
child that died pre-import fires `exit` as soon as listeners attach).

**Verify**: `pnpm exec tsc --noEmit` → exit 0.
`pnpm vitest run src/sumo-tui/rpc/client.test.ts` → pass (add a test: start()
with a fake pre-spawned child does not call spawn — inject via a stubbed
`ChildProcessWithoutNullStreams`-shaped EventEmitter, following the existing
fake-child pattern in `client.test.ts`).

### Step 2: Chrome cache module

Create `src/sumo-tui/rpc/chrome-cache.ts`:

- Path: `join(homedir(), ".sumocode", "chrome-cache.json")` (overridable via
  an options arg for tests — no env var needed).
- Shape: `{ version: 1, byCwd: { [cwd]: { modelLabel?: string, thinkingLevel?: string, savedAt: number } } }`,
  capped at 20 cwd entries (evict oldest `savedAt`).
- `readCachedChrome(cwd)` → `{ modelLabel?, thinkingLevel? } | undefined`;
  tolerate missing file, unparseable JSON, wrong version (all → `undefined`,
  never throw).
- `writeCachedChrome(cwd, chrome)` → best-effort, `mkdir -p` the dir,
  write-file; swallow all errors (cache is an optimization, never a failure).

**Verify**: `pnpm vitest run src/sumo-tui/rpc/chrome-cache.test.ts` → pass
(cases: round trip, corrupt file, missing file, eviction at 21 entries,
write failure swallowed).

### Step 3: Split the readiness events in the runtime

In `runtime.ts`, change the `start()` loop (line 309) to emit only
`boot_screen_frame` and `input_ready`. Add:

```ts
public markChromeStable(): void   // emits app_ready + stable_chrome_ready once (idempotent)
```

with the same `logDiagnostic(event, { surface: "rpc_host", cols, rows })`
payload. Guard so calling it twice emits nothing the second time, and calling
after `stop()` is a no-op.

**Verify**: `pnpm vitest run src/sumo-tui/rpc/runtime.test.ts` → pass, with
new tests pinning: start() emits exactly `boot_screen_frame` + `input_ready`;
`markChromeStable()` emits exactly `app_ready` + `stable_chrome_ready`;
idempotent.

### Step 4: Reorder `runRpcHost` — early start, parallel hydration

Rework the try block (`host.ts:812–843`) to:

```ts
await client.start();                                      // unchanged position
// EARLY FIRST FRAME: construct + start the runtime immediately with
// optimistic state and an empty (or fixture) transcript.
const cachedChrome = visualFixture ? undefined : readCachedChrome(cwd);
if (cachedChrome) stateStore.seedChrome(cachedChrome);      // new method, see below
const initialTranscript = visualFixture ? visualFixture.transcript : transcriptPump.replaceFromMessages([]);
const initialState = visualFixture ? visualFixture.state : stateStore.getSnapshot();
runtime = new RpcHostRuntime({ ...existing options, initialState, initialTranscript });
await runtime.start();                                     // splash paints HERE
if (!visualFixture) {
    // PARALLEL HYDRATION — all independent round trips at once. get_state
    // waits on the child boot; the others queue behind it on the same pipe.
    const branchPromise = readGitBranch(cwd);
    const [state, , messages] = await Promise.all([
        (async () => controls.refreshState(await branchPromise))(),
        editor.configureAutocomplete(controls),
        (async () => responseData(await client.send({ type: "get_messages" }), "get_messages").messages)(),
    ]);
    const transcript = transcriptPump.replaceFromMessages(messages);
    runtime.update({ state, transcript, transcriptRevision: transcriptPump.getRevision() });
    writeCachedChrome(cwd, { modelLabel: state.modelLabel, thinkingLevel: state.thinkingLevel });
}
runtime.markChromeStable();
if (!visualFixture) {
    await submitInitialPromptFromEnv(env, submitFromEditor); // AFTER hydration, as today
    await refreshStats();
    statsTimer = setInterval(() => { void refreshStats(); }, 5_000);
}
return await runtime.waitForExit();
```

Details that matter:

- `stateStore.seedChrome({ modelLabel, thinkingLevel })` — add to
  `RpcHostStateStore` (`state.ts`): patches only those two fields, does NOT
  set `hydrated` (Step 5). Doc-comment it as startup-only optimistic seed,
  referencing the plan-041 pattern.
- Hydration round trips need a **generous timeout**: the default `send`
  timeout is 30s (`client.ts:205`) — leave it; do not shorten.
- Live events can now arrive during hydration (the `client.onEvent` handler
  already `runtime?.update`s, and `runtime` exists). That's correct — after
  the `Promise.all`, the `replaceFromMessages` snapshot supersedes them; the
  transcript pump's replace semantics (plan 043) already handle replace-over-live.
- Fixture mode (`visualFixture`) must end pixel-identical to today: fixture
  state/transcript go into the constructor exactly as before, hydration is
  skipped, `markChromeStable()` still fires (captures wait on stability).
- **Error path**: the catch block currently writes to stderr while the
  altscreen may now be active. Reorder it: `await stop()` FIRST (restores the
  terminal), then write the error lines, then `return 1`. Keep the `finally`
  `stop()` (it's idempotent via `stopPromise`).

**Verify**: `pnpm vitest run src/sumo-tui/rpc/host.test.ts` → pass.
`pnpm exec tsc --noEmit` → exit 0.

### Step 5: `hydrated` flag + splash hint fallback

- `state.ts`: add optional `readonly hydrated?: boolean` to
  `RpcHostChromeState`. Set `hydrated: true` in `hydrateFromRpcState` (and
  nowhere else — `seedChrome` and `applyModelChange` must not set it).
- `shell-adapter.ts` `renderSplashHint` (line 648): when
  `state.modelLabel` is undefined AND `state.hydrated !== true`, render the
  hint with the bare rail — pass `leftHint: "╰─"` (same
  `leftHintStyle: "model-thinking"`, same frame width, same centering) instead
  of `╰─ no model · thinking`. When `hydrated === true` and there is genuinely
  no model, keep today's `no model` rendering unchanged.

This fallback is only ever visible on a cache-less first run (or after cache
eviction) for the ~1–2s before `get_state` lands. With a warm cache the
splash is byte-identical to today's from the first frame.

**Verify**: `pnpm vitest run src/sumo-tui/rpc/shell-adapter.test.ts src/sumo-tui/rpc/state.test.ts` →
pass, with new tests: (a) unhydrated + no model → hint contains `╰─` and does
NOT contain `no model`; (b) unhydrated + cached model label → identical output
to hydrated with same label; (c) hydrated + no model → today's `no model` output.

### Step 6: Integration + visual evidence

- New PTY integration test (extend the existing harness pattern in
  `test/integration/` — see `spawn-pi-pty.ts` usage): boot
  `bin/sumocode.sh --offline --no-session` under node-pty, assert
  (a) altscreen enter (`\x1b[?1049h`) appears, (b) **typing works before
  hydration**: send `hello` bytes immediately after the first frame and assert
  the characters echo in the editor region within 2s, (c) clean exit via
  Ctrl-C Ctrl-C.
- Run `pnpm visual:ci`. The splash scenarios use fixture state (hydrated,
  model label present) and must be pixel-unchanged. If any splash crop
  changed, that's a bug in your Step 5 condition — fix it; do not promote
  goldens.
- Re-run `pnpm perf:startup` (plan 060's harness) and commit the regenerated
  `docs/perf/` baseline. Expected shape: `boot-screen-frame` well below
  `app-ready` (the gap is the now-overlapped hydration), `first-frame`
  roughly `host-import` + small constant, no longer `host-import` +
  `child-first-response` + round trips.

**Verify**: `pnpm test:integration` → pass. `pnpm visual:ci` → exit 0.
`pnpm perf:startup` → exit 0 with `boot-screen-frame` avg at least 500ms below
`app-ready` avg (report the numbers in your summary; the reviewer judges the
absolute values).

## Test plan

- `chrome-cache.test.ts` (new): round trip, corruption, eviction, swallowed
  write errors.
- `client.test.ts`: pre-spawned child is used, not re-spawned; early-crash
  check still fires for a dead pre-spawned child.
- `runtime.test.ts`: event split + `markChromeStable` idempotence (pattern:
  existing diag-event assertions in that file).
- `host.test.ts`: `seedChrome` seeding; hydration failure path restores
  terminal before writing stderr (assert call order via injected fakes,
  pattern: existing `createRpcExitHandler` tests).
- `state.test.ts` / `shell-adapter.test.ts`: `hydrated` semantics + splash
  hint matrix (Step 5's three cases).
- Integration: the PTY boot/type-early/exit test (Step 6).
- Verification: `pnpm test` exit 0, `pnpm test:integration` pass,
  `pnpm visual:ci` exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm exec tsc --noEmit && pnpm build` exit 0
- [ ] `pnpm test` exits 0 (including all new tests above)
- [ ] `pnpm test:integration` passes (known PTY-concurrency flake allowed only if it passes in isolation, matching the documented signature in plans/README.md)
- [ ] `pnpm visual:ci` exits 0 with zero splash-scenario diffs and NO golden promotion
- [ ] `pnpm perf:startup` regenerated `docs/perf/startup.md` committed; `boot-screen-frame` avg ≥ 500ms below `app-ready` avg
- [ ] `grep -n "await client.start()" src/sumo-tui/rpc/host.ts` still matches exactly once (spawn path not duplicated)
- [ ] No files outside the in-scope list modified (`git status --short`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `host.ts` try block no longer matches the "Current state" excerpt
  (lines shifted is fine; different *logic* is drift).
- Hydration-during-live-events produces duplicated or dropped transcript
  messages in the integration test — the replace semantics assumption
  (plan 043) doesn't hold for this window. Do not band-aid with sleeps.
- The splash visual scenario diffs and the cause is not your Step 5
  condition — the splash pixels are a maintainer-owned contract.
- Typing before hydration crashes the child or wedges the editor —
  the "stdin pipe buffers early prompt sends" assumption is false.
- You find yourself wanting to modify `bin/sumocode.sh` or
  `src/cathedral/input-hints.ts`.

## Maintenance notes

- The chrome cache is a **UX optimization with reconcile** — anything that
  changes model selection semantics (e.g. plan 057's enabledModels scope)
  should keep writing the cache only from `hydrateFromRpcState`-derived
  state, never from optimistic values.
- Reviewers should scrutinize: the non-TTY/orphan guard in
  `sumo-rpc-host.js`; the error path (terminal restored before stderr); and
  that fixture mode is bit-identical (visual CI is the proof).
- Deferred, deliberately: streaming a "child boot progress" indicator into
  the splash (rejected — new visible chrome, contradicts the fidelity
  constraint); shortening the 50ms crash check (immaterial once overlapped).
- Plan 062 (bundled host entry) rewrites `sumo-rpc-host.js`'s import path —
  it depends on this plan and must preserve the pre-spawn ordering
  (spawn STILL happens before the module import, whichever loader is used).
