# Plan 020: Port RPC runtime onto the portable shell

> **Executor instructions:** Replace the RPC full-frame renderer with the shared
> shell from Plan 019. Delete duplicate rendering code only after parity tests
> prove the shared shell is driving RPC.
>
> **Drift check (run first):**
> `git diff --stat HEAD -- src/sumo-tui/rpc src/sumo-tui/shell src/sumo-tui/pi-compat`

## Status

- **Priority:** P0
- **Effort:** L
- **Risk:** HIGH
- **Depends on:** 018, 019
- **Category:** architecture / bug
- **Planned at:** `a3966a7`, 2026-07-02
- **Execution base:** `codex/plan019-retained-shell-exec` at `3d611f3`.
- **Execution status:** DONE, 2026-07-03.
  Executed as stacked worker branches:
  `codex/plan020-portable-rpc-shell-retry` at `2ef5945`, then the narrow
  scroll/cursor follow-up `codex/plan020-scroll-preservation-fix` at `36c18d9`.
  Final advisor verification passed focused RPC/editor/cursor suites,
  integration, runtime visual parity, visual CI, typecheck/build, and branch
  autoreview against `codex/plan019-retained-shell-exec`.

### Execution review notes

Reviewer verification on executor commit `0e10e7c` passed:

```bash
pnpm --config.verify-deps-before-run=false vitest run src/sumo-tui/rpc/editor.test.ts
pnpm --config.verify-deps-before-run=false vitest run src/sumo-tui/rpc/runtime.test.ts
pnpm --config.verify-deps-before-run=false vitest run test/integration/rpc-host-shell.test.ts
pnpm --config.verify-deps-before-run=false exec tsc --noEmit && pnpm --config.verify-deps-before-run=false build
pnpm --config.verify-deps-before-run=false render:bible
pnpm --config.verify-deps-before-run=false visual:review -- --scenario splash-runtime
pnpm --config.verify-deps-before-run=false visual:review -- --scenario active-landscape-runtime
pnpm --config.verify-deps-before-run=false visual:ci
```

Autoreview then found two issues the reviewer accepted:

1. Runtime captures bypass the real RPC prompt path. In the executor commit,
   `src/sumo-tui/rpc/host.ts` short-circuits any submitted prompt when both
   `SUMOCODE_HARNESS=1` and `PI_OFFLINE=1`, injecting
   `completedActiveRpcVisualFixture()` instead of calling `client.send(...)`.
   The runtime capture harness sets both vars in
   `scripts/visual-v2/runtime-capture.mjs`, while
   `src/visual-parity-contract.test.ts` explicitly asserts active runtime
   scenarios do not use `SUMOCODE_VISUAL_RPC_FIXTURE`. Result: active runtime
   screenshots can pass without exercising input submission, RPC client
   transport, or transcript updates.
2. Active state can still mount the splash layout. `RpcShellAdapter` passes
   `state.hasMessages` only into `defaultSplashSnapshot(...)`, but
   `RetainedShellRenderer` chooses splash vs chat from
   `ChatPager.hasMessages()`. `ChatPager.hasMessages()` is false when the
   transcript has no renderable messages, so a snapshot with
   `state.hasMessages === true` and an empty or filtered transcript can render
   active chrome/editor/footer around splash geometry.

The next execution attempt must preserve the real runtime prompt path unless an
explicit fixture opt-in is set, and it must make the shared shell's active/splash
decision honor product session activity without copying owned-shell layout logic
back into RPC.

### Second retry review note

Executor retry commit `2ef5945` passed:

```bash
pnpm vitest run src/sumo-tui/rpc/editor.test.ts
pnpm vitest run src/sumo-tui/rpc/runtime.test.ts
pnpm vitest run src/visual-parity-contract.test.ts
pnpm vitest run test/integration/cursor-visibility.test.ts
pnpm test:integration
pnpm visual:review -- --scenario splash-runtime
pnpm visual:review -- --scenario active-landscape-runtime
pnpm visual:review -- --scenario active-portrait-runtime
pnpm visual:ci
pnpm exec tsc --noEmit && pnpm build
```

`pnpm test` was also run during review and still exited 1 only because of the
known unrelated background-task `output.log` ENOENT after all 1115 assertions
passed.

Final autoreview found and the reviewer accepted this remaining blocker:

- `RpcHostRuntime.update()` always forwards `transcript: this.transcript` to
  `RpcShellAdapter.update()`, even for state-only updates such as 5-second stats
  refreshes, optimistic prompt state, and chrome-only events.
- `RpcShellAdapter.update()` treats any present `transcript` as a replacement
  and calls `ChatPager.replaceViewModels(...)`.
- `ChatPager.replaceViewModels(...)` resets manual scroll/read state. Result:
  routine state-only updates can snap a user reading older chat history back to
  the bottom.

The fresh narrow fix must preserve the old runtime contract: only pass
`transcript` into the shell adapter when the caller supplied
`snapshot.transcript`. Add a regression test proving state-only updates do not
call `replaceViewModels` or otherwise reset chat scroll state.

### Final scroll-preservation follow-up review note

Executor follow-up commit `36c18d9` passed:

```bash
pnpm vitest run src/sumo-tui/rpc/runtime.test.ts src/sumo-tui/rpc/editor.test.ts test/integration/rpc-host-shell.test.ts test/integration/cursor-visibility.test.ts
pnpm test:integration
pnpm visual:review -- --scenario splash-runtime
pnpm visual:review -- --scenario active-landscape-runtime
pnpm visual:review -- --scenario active-portrait-runtime
pnpm visual:ci
pnpm exec tsc --noEmit && pnpm build
```

`pnpm test` was also run during final review and still exited 1 only because of
the known unrelated background-task `output.log` ENOENT after all 1119
assertions passed.

Final branch autoreview against `codex/plan019-retained-shell-exec` reported no
accepted/actionable findings. The accepted worker revision fixed the
scroll-preservation blocker and the follow-on active-editor cursor blocker:

- state-only `RpcHostRuntime.update(...)` calls no longer pass a transcript
  replacement into the shell adapter;
- CSI-u Enter handling stays inside the editor path so slash autocomplete can
  accept before submit;
- RPC suppresses terminal hardware cursor leakage while the retained shell
  paints a Cathedral software cursor for live active editor rows.

### Mandatory retry requirements

The fresh execution attempt must satisfy these requirements in addition to the
original plan steps:

1. **No implicit runtime fixture bypass.** `SUMOCODE_HARNESS=1` and
   `PI_OFFLINE=1` are normal runtime-capture conditions, not fixture mode. A
   submitted prompt must still flow through `client.send({ type: "prompt", ... })`
   and the transcript pump. `SUMOCODE_VISUAL_RPC_FIXTURE` remains the only
   acceptable explicit fixture opt-in.
2. **Shared shell owns active/splash choice.** If RPC knows the session is
   active (`state.hasMessages === true`, `messageCount > 0`, pending work, or a
   submitted prompt in flight) but the current transcript has no renderable
   messages yet, the shared shell must mount the chat layout, not splash. Prefer
   a backend-neutral shell contract extension such as an activity predicate over
   any RPC-specific branch in `RetainedShellRenderer`. Preserve current
   owned-shell behavior by defaulting the predicate to `chat.hasMessages()`.
3. **Minimal runtime Enter support is allowed.** Active runtime scenarios send
   CSI-u Enter (`\x1b[13u`). This plan may update `src/sumo-tui/rpc/editor.ts`
   and its tests only to split/coalesce CSI-u Enter into normal text insertion
   plus submit. Broader keybinding, mouse, slash-command, and selection routing
   remains Plan 023.
4. **Runtime visuals must stay real.** `active-landscape-runtime` and
   `active-portrait-runtime` must pass without adding
   `SUMOCODE_VISUAL_RPC_FIXTURE` to those scenarios and without weakening
   rejection patterns, crop thresholds, styled-cell diffs, or geometry specs.
5. **State-only updates must not replace transcript state.** Runtime state-only
   updates must update chrome/footer/sidebar state without calling
   `ChatPager.replaceViewModels(...)` or resetting scroll/read state.

## Why this matters

RPC should be a backend adapter. It should provide session state, transcript
events, controls, extension UI requests, and editor submission callbacks to the
same retained shell that main already uses.

## Scope

**In scope:**

- `src/sumo-tui/rpc/runtime.ts`
- `src/sumo-tui/rpc/host.ts`
- `src/sumo-tui/rpc/editor.ts` and `src/sumo-tui/rpc/editor.test.ts` only for
  the minimal CSI-u Enter handling described above
- small RPC adapter modules under `src/sumo-tui/rpc/`
- `src/sumo-tui/shell/contracts.ts` and
  `src/sumo-tui/shell/retained-shell-renderer.ts` only for a backend-neutral
  active/splash predicate needed by both main and RPC shells
- tests for RPC runtime shell construction
- for the scroll-preservation fix only, keep changes tightly scoped to
  `src/sumo-tui/rpc/runtime.ts`, `src/sumo-tui/rpc/shell-adapter.ts`, and
  `src/sumo-tui/rpc/runtime.test.ts` unless the existing design absolutely
  requires otherwise

**Out of scope:**

- Rewriting transcript folding. That is Plan 021.
- Rewriting extension UI region mounting. That is Plan 022.
- Rewriting stdin routing beyond CSI-u Enter submission. That is Plan 023.
- Adding runtime fixture shortcuts, relaxing visual thresholds, or changing the
  runtime-capture contract so active scenarios stop exercising the real prompt
  path.

## Steps

### Step 1: Build an RPC shell adapter

Create an adapter that supplies the shared shell contracts from RPC host state:

- `ChatPager` instance,
- `SplashTree` instance,
- `RpcHostEditorController` as the editor component,
- top chrome component backed by existing `renderTopChromeBlock`,
- footer component backed by existing footer rendering,
- sidebar component backed by the existing sidebar renderer or publication
  provider,
- modal/notification overlay host,
- terminal dimensions and `TerminalSessionOwner`.

The adapter can use RPC state, but the shell should not import from `rpc/`.
If the adapter needs the shell to distinguish "active session but no renderable
messages yet" from true splash, extend the shell contracts with a generic
activity predicate and keep the owned-shell default behavior equivalent to
`chat.hasMessages()`.

### Step 2: Replace `renderRpcFrame`

Stop composing `CellBuffer` manually in `rpc/runtime.ts`. The runtime should:

- start retained terminal session,
- install input listeners,
- create/start the shared shell,
- request shell renders when state/transcript/editor/overlay changes,
- pass through the shell's hardware cursor.

Remove or dead-code-eliminate:

- `renderSplashFrame`,
- `renderActiveFrame`,
- `activeBottomRows`,
- `activeEditorRows`,
- `sidebarLayoutSnapshot` inside runtime,
- direct calls to `renderInputFrame` for shell composition.

### Step 3: Preserve first paint and lifecycle

Ensure RPC still logs boot/readiness diagnostics and exits cleanly on SIGINT and
SIGTERM. The shell should own painting; RPC runtime should own lifecycle.

### Step 4: Prove the old duplicate renderer is gone

Add tests or static assertions that `rpc/runtime.ts` no longer imports product
surface render helpers directly except through the adapter.

### Step 5: Prove the retry blockers are fixed

Add or update tests that fail on the rejected `0e10e7c` behavior:

- a host/runtime test proving `SUMOCODE_HARNESS=1` + `PI_OFFLINE=1` does not
  bypass `client.send({ type: "prompt", ... })` unless
  `SUMOCODE_VISUAL_RPC_FIXTURE` is explicitly set;
- a shell/runtime test where `state.hasMessages === true` but
  `transcript.messages` is empty, asserting the active chat frame mounts instead
  of the splash wordmark;
- an editor test for exact CSI-u Enter and coalesced `text + \x1b[13u` input.
- a runtime or adapter regression proving a state-only update does not replace
  the transcript in `ChatPager` and does not reset scroll/read state.

## Verification

```bash
pnpm vitest run src/sumo-tui/rpc/editor.test.ts
pnpm vitest run src/sumo-tui/rpc/runtime.test.ts
pnpm vitest run test/integration/rpc-host-shell.test.ts
pnpm vitest run src/visual-parity-contract.test.ts
pnpm visual:review -- --scenario splash-runtime
pnpm visual:review -- --scenario active-landscape-runtime
pnpm visual:review -- --scenario active-portrait-runtime
pnpm visual:ci
pnpm exec tsc --noEmit && pnpm build
```

## Done criteria

- [x] RPC runtime uses the shared shell renderer.
- [x] Duplicate RPC full-frame composition functions are removed.
- [x] Cursor handling is preserved: RPC suppresses terminal hardware cursor
  leakage and paints a Cathedral software cursor for live editor rows.
- [x] Existing RPC lifecycle tests still pass.
- [x] The Plan 018 main-vs-branch comparison improves or passes for shell
  geometry.
- [x] Active runtime visual scenarios submit through the real RPC prompt path;
  they do not rely on implicit harness/offline fixture injection.
- [x] A session with `state.hasMessages === true` and an empty renderable
  transcript mounts active chat layout, not splash layout.
- [x] State-only runtime updates do not replace the chat transcript or reset
  retained chat scroll/read state.

## STOP conditions

- The RPC adapter needs to copy owned-shell layout logic.
- Passing tests requires relaxing visual thresholds.
- Shell render cadence fights with RPC event updates or causes frame flicker.
- Real offline active runtime proof cannot produce a deterministic transcript
  without a fixture shortcut. Stop and report the exact RPC/offline limitation
  instead of bypassing the prompt path.

## Git workflow

Create a fresh worktree branch from `codex/plan019-retained-shell-exec`:

```bash
git switch -c codex/plan020-portable-rpc-shell-retry
```

Commit the completed implementation in that worktree. Do not push. Do not update
`plans/README.md`; the reviewer owns the plan index.

The scroll-preservation follow-up was executed on a fresh worktree branch from
the amended retry branch:

```bash
git switch -c codex/plan020-scroll-preservation-fix
```

It produced `36c18d9` on top of `2ef5945`. Do not push until the reviewer asks
for publication or integration.
