# Plan 094: Steerable visible subagents with silence-based lifecycle and graceful close

> **Reconciliation record**: This plan was originally Plan 088 in PR #382 and
> was implemented by merged PR #381 at `b34bd79`. It is retained as the
> historical design record and renumbered to avoid colliding with the Pi RPC
> audit track. Do not re-execute these instructions against current main.
>
> **Original executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 1ad967b..HEAD -- \
>   src/task-mode.ts src/task-mode.test.ts \
>   src/background-tasks/visible-spawn.ts src/background-tasks/visible-spawn.test.ts \
>   src/subagents/backend-pane.ts src/subagents/backend-pane.test.ts \
>   src/subagents/backend-pi.ts \
>   src/subagents/manager.ts src/subagents/manager.test.ts \
>   src/subagents/tools.ts src/subagents/tools.test.ts \
>   src/subagents/prompt.ts src/subagents/prompt.test.ts \
>   bin/sumocode.sh
> ```
>
> If any of these changed since `1ad967b`, compare the "Current state" excerpts
> below against the live code before proceeding; on a semantic mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (works on the pinned Pi 0.84.1)
- **Category**: bug / feature (subagent orchestration ergonomics)
- **Planned at**: commit `1ad967b`, 2026-08-27
- **Execution status**: DONE — merged as PR #381 at `b34bd79`, 2026-08-27

## Why this matters

Visible subagents are advertised as "watchable and steerable", but today they
are effectively neither for the orchestrator:

1. The child's task mode arms a **10-second** one-shot shutdown after its first
   `agent_end` (`src/task-mode.ts`, `DEFAULT_GRACE_MS = 10_000`). The
   orchestrating agent's next turn usually takes longer than that, so by the
   time it could call `subagent_send`, the child is already dead.
2. `subagent_send` types text into the child's PTY. The child's RPC host queues
   busy input in a host-owned FIFO that only drains after the **entire agent
   run settles** — so "steering" is delivered after the work it was meant to
   steer is finished.
3. Worse: if a steer *does* land during the 10s grace window, the child's
   `input` handler sets `userTookOver = true` **permanently**. The child never
   exits, its exit marker is never written, the subagent never settles, its
   deferred result is never delivered, and a capacity slot stays pinned until a
   manual `subagent_cancel`.
4. PTY-typed input has no acknowledgement and can silently merge with a draft
   in the child's editor or vanish into a dying process.

This plan replaces the PTY typing with a file-based control channel that
injects true Pi steering messages (`pi.sendUserMessage(text, { deliverAs:
"steer" })` — delivered between turns, mid-run), replaces the one-shot 10s
grace with a re-arming 30-second silence window, and adds a `subagent_close`
tool so the orchestrator can gracefully close a visible child on demand.

## Current state

### Files and roles

- `src/task-mode.ts` — child-side task-mode lifecycle: marker-file env capture,
  response persistence, and the auto-exit grace timer. This is where the 10s
  close and the permanent `userTookOver` trap live.
- `src/task-mode.test.ts` — colocated tests; they pass `graceMs: 10_000`
  explicitly, so the default change won't break them, but takeover-semantics
  tests must be updated.
- `src/background-tasks/visible-spawn.ts` — `buildVisibleTaskPaths()` defines
  the task-dir file contract shared by parent and child.
- `src/subagents/backend-pane.ts` — parent-side visible child spawner; owns the
  task dir, writes prompt/log files, polls `exit.code`.
- `src/subagents/backend-pi.ts` — headless spawner; also exports the
  `SpawnedChild` interface both backends implement (lines 104–109).
- `src/subagents/manager.ts` — `SubagentManager`; holds the private
  `children: Map<string, { child: SpawnedChild; ... }>` map (line ~137) and the
  settle machinery.
- `src/subagents/tools.ts` — registers `subagent_spawn/send/check/wait/cancel/list`.
- `src/subagents/prompt.ts` — tool descriptions and orchestrator-facing
  guidelines (`SUBAGENT_TOOL_DESCRIPTIONS`, `SUBAGENT_PROMPT_GUIDELINES`).
- `bin/sumocode.sh` — launcher; the `task --task-dir` branch exports the
  `SUMOCODE_TASK_*` marker env vars (lines ~363–370).

### The task-dir contract today

`src/background-tasks/visible-spawn.ts` (`buildVisibleTaskPaths`):

```ts
const dir = join(root, `${taskId}-${startedAtMs}`);
return {
	logFile: join(dir, "output.log"),
	exitFile: join(dir, "exit.code"),
	markerFile: join(dir, "started.marker"),
	scriptFile: join(dir, "run.sh"),
	metaFile: join(dir, "meta.json"),
	promptFile: join(dir, "prompt.txt"),
	responseFile: join(dir, "response.md"),
	diagFile: join(dir, "diag.jsonl"),
};
```

`bin/sumocode.sh` (task subcommand):

```bash
export SUMOCODE_TASK_RESPONSE_FILE="${TASK_DIR}/response.md"
export SUMOCODE_TASK_EXIT_FILE="${TASK_DIR}/exit.code"
export SUMOCODE_TASK_STARTED_FILE="${TASK_DIR}/started.marker"
export SUMOCODE_TASK_DIAG_FILE="${TASK_DIR}/diag.jsonl"
```

`src/task-mode.ts` captures those env vars at install and scrubs them from
`process.env` (`TASK_MARKER_ENV_KEYS`, `captureAndScrubTaskMarkerEnv`) so
descendant processes cannot clobber the markers. Any new control env var MUST
join that capture-and-scrub list.

### The auto-exit today (`src/task-mode.ts`)

```ts
const DEFAULT_GRACE_MS = 10_000;
// ...
let userTookOver = false;
let armed = false;
// input handler:
if (!armed) return;
if (event.source !== "interactive") return;
if (pending) {
	cancelPending(ctx, "user");            // sets userTookOver = true, forever
	ctx.ui.notify("task auto-exit cancelled — pane will stay open", "info");
}
// agent_end handler:
if (userTookOver) return;
if (armed) return;                          // only the FIRST agent_end arms
armed = true;
// ... 10s countdown, then ctx.shutdown()
```

`persistResponse()` already runs on **every** `agent_end`, so `response.md`
always holds the latest completed turn — the settle path needs no change.

### subagent_send today (`src/subagents/tools.ts`)

```ts
const result = await sendPaneText.call(host, pi, pane, params.text);
if (!result.ok) throw new Error(`Unable to send input to ${params.id}: ${result.error}`);
return makeToolResult(`Sent input to ${params.id} (${snapshot.title}).`, ...);
```

### SpawnedChild today (`src/subagents/backend-pi.ts:104`)

```ts
export interface SpawnedChild {
	readonly events: AsyncIterable<SubagentEvent> | ((emit: (e: SubagentEvent) => void) => void);
	readonly sessionFilePath?: string;
	readonly ready?: Promise<void>;
	interrupt(): void;
}
```

### Pi API this plan relies on (pinned 0.84.1, verified)

`docs/extensions.md` (in the installed `@earendil-works/pi-coding-agent`):
`pi.sendUserMessage(content, options?)` with
`{ deliverAs: "steer", triggerTurn: true }` — queues the message for delivery
after the current assistant turn finishes its tool calls (mid-run), or triggers
a turn immediately when idle. This runs **inside the child process** (task-mode
is a module of the extension the child loads), so no RPC or PTY is involved.

### Conventions

- Tabs for indentation; strict TS with `noUnusedLocals`/`noUnusedParameters`.
- Tests colocate: `foo.ts` → `foo.test.ts`. Model new task-mode tests on the
  existing fake-`pi` harness in `src/task-mode.test.ts` and new pane-backend
  tests on the injected-`fs` pattern in `src/subagents/backend-pane.test.ts`.
- Product copy is lowercase, terse, no exclamation marks (`src/voice.ts`).
- Comments explain *why*; follow the existing commenting density in these files.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused unit tests | `pnpm vitest run src/task-mode.test.ts src/subagents/backend-pane.test.ts src/subagents/manager.test.ts src/subagents/tools.test.ts src/subagents/prompt.test.ts` | all pass |
| Full unit suite | `pnpm test` | all pass |
| **Lint (CI gate)** | `pnpm lint` | exit 0, `Found 0 warnings and 0 errors` |
| Typecheck/build | `pnpm exec tsc --noEmit && pnpm build` | exit 0 |
| Integration suite | `pnpm test:integration` | all pass (pre-existing failures: STOP and report which) |
| Launcher syntax | `bash -n bin/sumocode.sh` | exit 0 |

## Scope

**In scope** (the only files to modify):

- `src/task-mode.ts`, `src/task-mode.test.ts`
- `src/background-tasks/visible-spawn.ts`, `src/background-tasks/visible-spawn.test.ts`
- `src/subagents/backend-pane.ts`, `src/subagents/backend-pane.test.ts`
- `src/subagents/backend-pi.ts` (interface addition only)
- `src/subagents/manager.ts`, `src/subagents/manager.test.ts`
- `src/subagents/tools.ts`, `src/subagents/tools.test.ts`
- `src/subagents/prompt.ts`, `src/subagents/prompt.test.ts`
- `bin/sumocode.sh`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- `src/sumo-tui/rpc/prompt-scheduler.ts` and the host FIFO — that is Plan 090.
- `src/terminal-host/*` — `sendPaneText` stays available for other callers;
  this plan stops *using* it for subagent_send, nothing more.
- Headless steering / `subagent_reply` — deferred direction item (candidate
  plan 090); do not add stdin or RPC transport to `backend-pi.ts`.
- `src/subagents/delivery.ts`, `src/subagents/index.ts` — settle/delivery flow
  is unchanged.
- Any visual golden, keybinding, or Cathedral rendering change.

## Git workflow

- Branch: `advisor/088-subagent-steering-lifecycle`
- Conventional commits, e.g. `feat(subagents): steer visible children via task-dir control files`
- Do not push or open a PR unless the operator requests it.

## Design contract (read before step 1)

**Control directory**: `<taskDir>/control/`, created by the parent at spawn.

- **Steer**: parent writes `steer-<seq>.txt` (monotonic integer `seq`, content
  = raw prompt text, written as `steer-<seq>.txt.tmp` then renamed for
  atomicity). Child polls the directory every 500ms, processes files in
  ascending `seq`, calls
  `pi.sendUserMessage(text, { deliverAs: "steer", triggerTurn: true })`, then
  unlinks the file. **Unlink is the ack.** Files ending in `.tmp` are ignored.
- **Close**: parent writes `close.request` (content irrelevant). Child sees it,
  cancels any countdown, stops the watcher, and calls `ctx.shutdown()`. The
  existing exit-marker/`response.md` machinery then settles the subagent as a
  normal completion.
- **Child env**: `SUMOCODE_TASK_CONTROL_DIR`, exported by `bin/sumocode.sh`
  alongside the other `SUMOCODE_TASK_*` vars, captured-and-scrubbed by
  task-mode like the rest.
- **Parent ack wait**: after writing a steer file, poll every 250ms up to 5s
  for the file to disappear. If `exit.code` gains content first → error
  ("child exited before receiving input"). On timeout → error, but note the
  file remains and may still be consumed.

**Silence-based auto-exit** (replaces the one-shot 10s design):

- `DEFAULT_GRACE_MS` becomes `30_000`.
- **Every** `agent_end` (re)arms a fresh countdown (cancel any previous one
  first). The `armed`-once latch and `userTookOver` flag are removed.
- `agent_start` cancels any pending countdown (a turn is running — never exit
  mid-turn).
- Interactive input (`event.source === "interactive"`) cancels any pending
  countdown; the next `agent_end` re-arms. The pre-first-`agent_end` kickoff
  guard becomes unnecessary: before any `agent_end` there is no countdown to
  cancel, so kickoff input is naturally a no-op.
- Steer injection by the watcher also cancels any pending countdown before
  calling `sendUserMessage` (belt-and-braces: `triggerTurn` will fire
  `agent_start`, but not synchronously).
- Countdown status copy: `task done · exiting in ${remaining}s · type or steer to extend`.
- `SUMOCODE_TASK_KEEP_OPEN=1` still disables auto-exit entirely and must also
  keep the close.request path working (close is explicit, not silence).

This design fixes the pinned-slot bug by construction: any takeover or steer
eventually reaches an `agent_end` + 30s of silence, so the child always exits
and settles unless a human is actively working in it.

## Steps

### Step 1: Add `controlDir` to the task-dir contract

In `src/background-tasks/visible-spawn.ts`, add `controlDir: join(dir, "control")`
to `VisibleTaskPaths` and `buildVisibleTaskPaths()`. Update
`src/background-tasks/visible-spawn.test.ts` (there are existing path-shape
tests; extend them).

In `bin/sumocode.sh`, inside the `if [[ -n "${TASK_DIR}" ]]` block that exports
the other marker vars, add:

```bash
export SUMOCODE_TASK_CONTROL_DIR="${TASK_DIR}/control"
```

**Verify**: `pnpm vitest run src/background-tasks/visible-spawn.test.ts && bash -n bin/sumocode.sh` → pass, exit 0.

### Step 2: Rework task-mode auto-exit to the silence contract

In `src/task-mode.ts`:

1. Add `"SUMOCODE_TASK_CONTROL_DIR"` to `TASK_MARKER_ENV_KEYS`.
2. `DEFAULT_GRACE_MS = 30_000`.
3. Implement the silence contract from the design section: delete
   `userTookOver` and the `armed` latch; re-arm on every `agent_end`; cancel on
   `agent_start` and on interactive input; keep `cancelPending` as the single
   cancellation path; keep `diagLog` events truthful (add
   `timer_rearmed`, `timer_cancelled_input`, `timer_cancelled_agent_start`).
4. Capture the latest `ExtensionContext` from every handler
   (`session_start`, `agent_start`, `agent_end`, `input`) into a module-scoped
   `latestCtx` for the watcher's `ctx.shutdown()` / `ctx.ui.setStatus` needs.
5. Update the countdown copy to
   `` `task done · exiting in ${remaining}s · type or steer to extend` ``.

Behavior that must NOT change: `persistResponse` on every `agent_end`; marker
capture/scrub; `writeTaskExitMarker` / `writeTaskStartedMarker`;
`SUMOCODE_TASK_KEEP_OPEN=1` skipping the auto-exit install;
`session_shutdown` defensive cleanup.

Update `src/task-mode.test.ts`: rewrite the takeover-semantics tests
(permanent cancel → reset semantics), add re-arm-on-second-`agent_end`,
cancel-on-`agent_start`, and kickoff-input-is-noop cases. Use vitest fake
timers as the existing tests do.

**Verify**: `pnpm vitest run src/task-mode.test.ts` → all pass.

### Step 3: Add the control-file watcher to task-mode

In `src/task-mode.ts`, add an internal watcher started by
`installTaskModeAutoExit` when task mode is active and the captured snapshot
has `SUMOCODE_TASK_CONTROL_DIR`:

- `setInterval` 500ms, `unref()`d, stopped on `session_shutdown` and on close.
- Each tick: if `close.request` exists in the dir → `diagLog("close_requested")`,
  cancel countdown, stop watcher, `latestCtx?.shutdown()` (if no ctx captured
  yet, retry next tick — do not throw).
- Else: `readdirSync` the dir (tolerate ENOENT — dir may not exist yet), match
  `/^steer-(\d+)\.txt$/`, sort numerically ascending, and for each: read utf8,
  cancel countdown, `pi.sendUserMessage(text, { deliverAs: "steer",
  triggerTurn: true })`, `unlinkSync` the file, `diagLog("steer_injected",
  { file, bytes })`. Skip and delete empty files. Wrap each file in try/catch
  so one bad file cannot wedge the watcher; log failures via `diagLog`.
- The watcher must run even when `SUMOCODE_TASK_KEEP_OPEN=1` (steer and close
  are independent of auto-exit). Restructure the early-return in
  `installTaskModeAutoExit` accordingly: marker capture + watcher install
  happen for all task-mode sessions; only the countdown wiring is gated by
  `shouldInstallTaskModeAutoExit`.

Add an injectable fs/timer seam if needed for tests, following the
`dependencies` pattern in `backend-pane.ts` (`PaneBackendDependencies`).

Tests (`src/task-mode.test.ts`): steer file → `sendUserMessage` called once
with `deliverAs: "steer"` and the file unlinked; two files processed in seq
order; `.tmp` ignored; `close.request` → `ctx.shutdown()` called and watcher
stopped; ENOENT dir tolerated; keep-open session still honors close.request.

**Verify**: `pnpm vitest run src/task-mode.test.ts` → all pass.

### Step 4: Give the pane backend `send` and `requestClose`

In `src/subagents/backend-pi.ts`, extend `SpawnedChild`:

```ts
export interface SpawnedChild {
	readonly events: AsyncIterable<SubagentEvent> | ((emit: (e: SubagentEvent) => void) => void);
	readonly sessionFilePath?: string;
	readonly ready?: Promise<void>;
	interrupt(): void;
	/** Deliver steering text to a running child. Rejects when unsupported or unconfirmed. */
	send?(text: string): Promise<void>;
	/** Ask the child to persist its response and shut down gracefully. */
	requestClose?(): void;
}
```

The headless backend leaves both undefined (do not touch its spawn logic).

In `src/subagents/backend-pane.ts`:

1. At spawn, `fs.mkdirSync(paths.controlDir, { recursive: true })` next to the
   existing prompt-file mkdir.
2. Extend `PaneBackendFs` with `renameSync` and (for the ack poll) reuse
   `existsSync`; wire `node:fs` implementations.
3. Implement `send(text)`: reject if settled/interrupted; write
   `steer-<seq>.txt.tmp`, rename to `steer-<seq>.txt` (seq = incrementing
   counter per child); then poll per the design contract (250ms interval, 5s
   budget, injectable via `dependencies` for tests). Resolve when the file is
   gone; reject with `child exited before receiving input` if `exit.code`
   gains content first; reject with a timeout message otherwise.
4. Implement `requestClose()`: write `close.request` (plain `"1"`), swallow
   nothing — let write errors throw to the caller.
5. Return both from the spawner alongside `events`/`interrupt`/`ready`.

Tests (`src/subagents/backend-pane.test.ts`, injected-fs pattern): send writes
tmp-then-rename; resolves on deletion; rejects on exit marker; rejects on
timeout; seq increments across sends; requestClose writes the file; send after
settle rejects.

**Verify**: `pnpm vitest run src/subagents/backend-pane.test.ts` → all pass.

### Step 5: Manager seams `sendTo` and `close`

In `src/subagents/manager.ts` add two public methods:

```ts
public async sendTo(id: string, text: string): Promise<SubagentSnapshot>
```

Validation (throw with these exact shapes, matching existing tool error style):
unknown id (include known ids like `waitFor` does); `queued` → cannot receive
input until it starts; settled → already settled; no `child.send` capability →
`headless children cannot receive input — respawn with visible: true`. Then
`await entry.child.send(text)` and return the current snapshot.

```ts
public async close(ids: readonly string[]): Promise<string[]>
```

Mirror `cancel()`'s shape (fire all requests first, then await in parallel):

- unknown → `` `${id} is unknown` ``; already settled → `` `${id} was already done/settled` ``
- `queued` → remove from queue and settle interrupted (same as cancel's queued
  branch) → `` `Cancelled queued ${id}` ``
- running without `requestClose` → `` `${id} is headless — it settles on its own; use subagent_cancel to stop it` `` (no action)
- running with `requestClose` → call it, then `waitForSettle(id, CLOSE_WAIT_MS)`
  with `const CLOSE_WAIT_MS = 15_000`. On settle → `` `Closed ${id}` ``; on
  timeout → `` `close requested for ${id}; still running — check the pane or use subagent_cancel` ``
  (do NOT force a synthetic settle — that is cancel's job).
- Unlike `cancel`, do not pre-mark `consumedIds`; only add the id to
  `consumedIds` when it actually settled during the wait (the tool returns the
  result inline in that case).

Tests (`src/subagents/manager.test.ts`): use the existing fake-backend pattern;
cover every branch above, including close-timeout leaving status `running`.

**Verify**: `pnpm vitest run src/subagents/manager.test.ts` → all pass.

### Step 6: Rewire `subagent_send` and add `subagent_close`

In `src/subagents/tools.ts`:

1. `subagent_send.execute` becomes: `const snapshot = await manager.sendTo(params.id, params.text)`
   and returns
   `` `Sent steering input to ${params.id} (${snapshot.title}). It is delivered after the child's current turn — no ack beyond delivery-to-child is possible.` ``
   with `{ action: "send", id, pane: snapshot.pane }`. Remove the direct
   `sendPaneText` path and its host checks from this tool (the `host` parameter
   stays — `subagent_spawn` still uses it).
2. Register `subagent_close`:
   - parameters: `ids: Type.Array(Type.String(), { maxItems: 64, description: "Visible subagent ids to close gracefully." })`
   - execute: `const lines = await manager.close(params.ids)`; for each id
     whose snapshot is now settled, `delivery?.consume(id)` and append its
     bounded result via the existing `boundedWaitText` helper; return the
     status lines + results with
     `{ action: "close", ids, subagents: settled.map(cancellationMetadata), activity: ... }`
     following the `subagent_cancel` result shape.

In `src/subagents/prompt.ts`:

- `SUBAGENT_TOOL_DESCRIPTIONS.send` → "Send steering text to a running visible
  subagent. Delivered as a Pi steering message after the child's current turn —
  not typed into its terminal."
- Add `SUBAGENT_TOOL_DESCRIPTIONS.close` → "Gracefully close visible subagents:
  the child saves its final response and exits cleanly, settling with a normal
  completion manifest. Use subagent_cancel only to abort work."
- Update `SUBAGENT_PROMPT_GUIDELINES`: replace the "sends the text followed by
  Enter" line with steering semantics, and add one line: visible children stay
  open while active and auto-close after 30s of silence; use `subagent_close`
  to end one deliberately.

Tests: `tools.test.ts` (send delegates to manager.sendTo and surfaces its
errors; close registered, consumes delivery for settled ids, returns per-id
lines) and `prompt.test.ts` (description snapshot updates).

**Verify**: `pnpm vitest run src/subagents/tools.test.ts src/subagents/prompt.test.ts` → all pass.

### Step 7: Full gates

```bash
pnpm lint
pnpm exec tsc --noEmit && pnpm build
pnpm test
pnpm test:integration
git status --short
```

Expected: exit 0, all suites pass, only in-scope files modified. If
`pnpm test:integration` has pre-existing failures unrelated to these files
(the 083 ledger notes a known local timeout cascade), record exactly which
tests fail and confirm they fail identically on `1ad967b` before proceeding.

Optional operator evidence (not a gate — requires a live Herdr host): spawn a
visible child via `subagent_spawn {visible: true}`, `subagent_send` while it
works, observe mid-run injection in the pane, then `subagent_close` and confirm
the result manifest arrives.

## Test plan

Summarized from the steps; all colocated:

- `task-mode.test.ts` — silence re-arm/cancel matrix, watcher steer/close/seq/
  tmp/ENOENT/keep-open cases.
- `visible-spawn.test.ts` — `controlDir` in the path contract.
- `backend-pane.test.ts` — send ack protocol (resolve/exit/timeout), seq,
  requestClose, mkdir of control dir at spawn.
- `manager.test.ts` — `sendTo` validation branches; `close` branch matrix
  including timeout-leaves-running.
- `tools.test.ts` / `prompt.test.ts` — tool wiring and copy.

## Done criteria

- [ ] `pnpm lint` exits 0 (anti-slop oxlint is a blocking CI gate)
- [ ] `pnpm exec tsc --noEmit && pnpm build` exit 0
- [ ] `pnpm test` passes with the new cases present
- [ ] `grep -n "userTookOver" src/task-mode.ts` returns nothing
- [ ] `grep -n "DEFAULT_GRACE_MS = 30_000" src/task-mode.ts` matches
- [ ] `grep -n "sendPaneText" src/subagents/tools.ts` returns nothing
- [ ] `grep -n "subagent_close" src/subagents/tools.ts` matches
- [ ] `grep -n "SUMOCODE_TASK_CONTROL_DIR" bin/sumocode.sh src/task-mode.ts` matches in both
- [ ] No files outside Scope modified (`git status --short`)
- [x] Plan 094 row recorded in `plans/README.md`

## STOP conditions

- The pinned Pi's `pi.sendUserMessage` does not accept
  `{ deliverAs: "steer", triggerTurn: true }` (check
  `node_modules/.../@earendil-works/pi-coding-agent/docs/extensions.md`).
- Task-mode cannot observe `agent_start` as an extension event (the silence
  design needs it to avoid exiting mid-turn).
- Steering messages injected via `sendUserMessage` do not appear in the child's
  visible transcript (would make the pane lie to the human watching it).
- The control watcher requires touching `src/subagents/index.ts` or the
  delivery flow.
- A step's focused verification fails twice after a reasonable in-scope fix.

## Maintenance notes

- **Plan defect, recorded 2026-08-27**: the original command table omitted `pnpm lint`.
  The executor followed the listed gates faithfully and CI still failed on 6 anti-slop
  oxlint errors (anonymous object types on test doubles, missing `SAFETY:` justifications,
  a conditional spread, and an `unknown` parameter). Fixed in a follow-up commit; the lint
  row above was added afterwards. Every future plan must list `pnpm lint` as a gate.
- **Known limitation**: a human composing a long message in the child pane for
  >30s *after* an `agent_end` without submitting can be shut down mid-draft;
  the visible countdown ("type or steer to extend") is the mitigation. If this
  bites, the next step is an editor-activity signal, not a longer default.
- The control-file protocol is now a **three-party contract**
  (`bin/sumocode.sh` env, `visible-spawn.ts` paths, `task-mode.ts` watcher,
  `backend-pane.ts` writer). Reviewers should check all four move together.
- Plan 090 (native Pi queue) changes how *typed* input queues in the child's
  own UI; it does not replace this channel — `sendUserMessage` already bypasses
  the host FIFO.
- Deferred by design: steering headless children and continuing settled
  children (`subagent_reply`) — direction item "conversational children"
  (candidate plan 090) in `plans/README.md`.
