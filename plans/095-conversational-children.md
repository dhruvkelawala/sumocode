# Plan 095: Conversational children — live turns for visible panes and `subagent_reply` for settled headless children

> **Reconciliation note**: This plan was originally Plan 090 in PR #382. It
> is renumbered after the Pi RPC audit track and rebased onto merged PR #381
> (`b34bd79`), which supplies the visible-child control channel it requires.
>
> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat b34bd79..HEAD -- \
>   src/subagents/domain.ts \
>   src/subagents/backend-pane.ts src/subagents/backend-pane.test.ts \
>   src/subagents/backend-pi.ts src/subagents/backend-pi.test.ts \
>   src/subagents/manager.ts src/subagents/manager.test.ts \
>   src/subagents/tools.ts src/subagents/tools.test.ts \
>   src/subagents/prompt.ts src/subagents/prompt.test.ts \
>   src/subagents/index.ts src/subagents/index.test.ts
> ```
>
> This plan is based on `b34bd79`, where PR #381 landed the former Plan 088
> (now historical Plan 094). It references Plan 094's control-file channel and
> `sendTo`/`close` seams. On drift in the excerpts below, reconcile before
> proceeding; on a semantic mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 094 (steer channel, silence lifecycle, `manager.sendTo`)
- **Category**: feature (subagent orchestration ergonomics)
- **Planned at**: commit `b34bd79`, 2026-08-28
- **Issue**: [#384](https://github.com/dhruvkelawala/sumocode/issues/384)

## Why this matters

Subagents today are fire-and-forget: you get one prompt in and one result out.
Real orchestration wants a conversation — "clarify point 3", "now also fix the
tests" — without respawning a child and re-paying its entire context. The
deliberate design choice here is to get conversation **without** changing the
headless process model to a long-lived RPC transport (recorded direction
decision: RPC-mode headless is over-engineering for current needs).

Two gaps close that:

1. **Visible children are already almost conversational after Plan 094** — the
   manager settles only on the *process* exit marker, so a child idle between
   turns is still `status: "running"`, and Plan 094's steer channel uses
   `triggerTurn: true`, which starts a new turn when the child is idle. What's
   missing is *observability*: the pane backend emits no transcript events
   (only `run-started`/`pane-attached`/`run-settled`), so `subagent_check`
   shows `(no output yet)` until the process dies — the orchestrator converses
   blind. Task mode already rewrites `response.md` on **every** `agent_end`;
   the parent just never reads it before exit.
2. **Headless children discard their session** — they spawn with
   `--no-session` (`src/native-task-config.ts:27`), so a settled child cannot
   be continued at any price. The repo already contains the exact mechanism
   needed: `native-task-tool.ts:137–161` seeds a session file and spawns
   `pi --session <file> --session-dir <dir>`. Persisting headless sessions and
   adding `subagent_reply` gives reply-after-settle with full prior context at
   the cost of one process startup.

## Current state

All excerpts verified at `1ad967b`; re-verify against the post-094 tree.

### `src/subagents/domain.ts` — event and snapshot contract

```ts
export type SubagentEvent =
	| { kind: "run-started" }
	| { kind: "pane-attached"; pane: SubagentPaneRef }
	| { kind: "assistant-delta"; delta: string }
	| { kind: "tool-start"; ... } | { kind: "tool-update"; ... } | { kind: "tool-end"; ... }
	| { kind: "message-end"; role: "user" | "assistant" | "toolResult"; text: string }
	| { kind: "usage"; ... }
	| { kind: "run-settled"; outcome: RunOutcome };
```

`SubagentSnapshot` already has `readonly sessionFilePath?: string` (populated
today only when a backend reports it at spawn — no backend does).

`manager.ts` `fold()` already handles `message-end`: appends to `transcript`,
sets `finalText`, bumps `usage.turns` for assistant messages. The headless
backend emits these from Pi's JSON event stream; the pane backend does not.

### `src/subagents/backend-pane.ts` — poll loop (post-094)

`poll()` runs every 750ms (`RESPONSE_POLL_INTERVAL_MS`) and only inspects
`paths.exitFile`. `paths.responseFile` is read once, at settle. Task mode
(`src/task-mode.ts`, `persistResponse`) overwrites `response.md` with the
latest completed turn on every `agent_end`.

### `src/subagents/backend-pi.ts` — headless spawn

```ts
// native-task-config.ts:27 (shared with the native task tool — do not edit it)
const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
// backend-pi.ts spawn:
const proc = spawnImpl("pi", [...config.subprocessArgs, ...roleArgs, ...adapterArgs, options.prompt], ...);
proc.stdin.end();
```

`spawnPiChild` options today: `prompt, cwd, model, thinking, inherited,
builtInTools, appendSystemPrompt, signal` — no `id`, no session handling.

### `src/native-task-tool.ts:137–161` — the session-continuation exemplar

```ts
const createForkSession = async (sessionFile: string): Promise<ForkSession> => {
	// ...copyFile(sessionFile, seedPath)...
};
// ...
return [...filtered, "--session", session.seedPath, "--session-dir", session.dir];
```

(`filtered` strips `--no-session`.) This proves `pi --session <existing file>`
resumes that session in one-shot `-p` mode — the pattern this plan reuses
*without* the copy (a reply appends to the child's own session, no fork).

### `src/subagents/manager.ts` — spawn/startTask (post-094)

`spawn(task)` owns capacity/queueing and calls `startTask`, which captures git
context, optionally creates a worktree, resolves visible placement, then calls
`backendFactory(...)` and stores the snapshot via `makeInitialSnapshot(task,
id, createdAt, manifestBaseRef, childCwd, worktree, child.sessionFilePath)`.
Terminal state is sticky: `fold()` ignores events after settle.

### `src/subagents/index.ts` — backend factory

Routes `task.visible` to `spawnPane({...})` else `spawnHeadless({...})`,
threading model/thinking inheritance and narrowed built-in tools.

### `src/subagents/tools.ts` — role resolution pattern

`subagent_spawn` resolves `roleLoader()` per call, derives
`appendSystemPrompt: role?.systemPrompt` and `builtInTools` from
`pi.getActiveTools()`. `subagent_reply` reuses this pattern for the resumed
child.

### Conventions

Tabs; strict TS; colocated tests; lowercase terse copy; comments explain why.
Fake-backend manager tests and injected-fs backend tests are the structural
patterns to follow.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Focused units | `pnpm vitest run src/subagents/backend-pane.test.ts src/subagents/backend-pi.test.ts src/subagents/manager.test.ts src/subagents/tools.test.ts src/subagents/prompt.test.ts src/subagents/index.test.ts` | pass |
| **Lint (CI gate)** | `pnpm lint` | exit 0, `Found 0 warnings and 0 errors` |
| Full gates | `pnpm lint && pnpm test && pnpm exec tsc --noEmit && pnpm build` | exit 0 |

`pnpm lint` runs anti-slop oxlint and **blocks CI**. It is strict about the fake-backend
test doubles this plan extends: no explicit anonymous object types on bindings (use a
named type alias or `satisfies`), every `as` assertion needs a `// SAFETY:` comment
stating the checked invariant immediately before it, no conditional spreads that hide
property omission (`...(cond ? { k: v } : {})`), and no bare `unknown` parameters (use a
generic or a named domain type). Run it after every step, not just at the end.
| Integration | `pnpm test:integration` | pass (pre-existing failures: STOP and report) |

## Scope

**In scope**:

- `src/subagents/domain.ts` (one event variant + one snapshot field)
- `src/subagents/backend-pane.ts` (+test)
- `src/subagents/backend-pi.ts` (+test)
- `src/subagents/manager.ts` (+test)
- `src/subagents/tools.ts` (+test)
- `src/subagents/prompt.ts` (+test)
- `src/subagents/index.ts` (+test)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):

- `src/native-task-config.ts` and `src/native-task-tool.ts` — shared with the
  native task tool; the headless backend post-processes `subprocessArgs`
  instead of changing the shared builder.
- Long-lived RPC/stdin transport for headless children (rejected direction).
- Reply-after-close for **visible** children (their session belongs to the
  child SumoCode host; deferred — see Maintenance notes).
- `src/task-mode.ts`, `bin/sumocode.sh` — Plan 094's contract is sufficient.
- Worktree creation logic — replies reuse the original checkout/worktree.

## Git workflow

- Branch: `advisor/095-conversational-children`
- Conventional commits, e.g. `feat(subagents): live pane turns and headless subagent_reply`
- Do not push or open a PR unless the operator requests it.

## Design contract (read before step 1)

**Part A — live turns for visible children**: the pane backend's existing
750ms poll additionally reads `paths.responseFile`; when its content changes
to a new non-empty value (compare by string, not mtime — cheap at this size)
and the child has not settled, emit
`{ kind: "message-end", role: "assistant", text }`. The manager's existing
`fold()` then gives `subagent_check` a live latest-turn preview and accurate
`usage.turns`. On settle, `finalText` comes from the same file, so no
double-counting logic is needed beyond "don't emit `message-end` for content
already emitted".

**Part B — headless session persistence + reply**:

- Headless children get a per-child session dir:
  `join(TMPDIR ?? "/tmp", "sumocode-subagents", `${id}-${createdAt}`, "session")`.
  The backend swaps `--no-session` out of `config.subprocessArgs` for
  `["--session-dir", sessionDir]` (fresh spawn) or
  `["--session", resumeSessionFile, "--session-dir", dirname(resumeSessionFile)]`
  (reply).
- **Discovery**: pi names the session file itself. After process close (before
  emitting `run-settled`), the backend readdirs the session dir; exactly one
  `*.jsonl` → emit new event
  `{ kind: "session-located"; sessionFilePath: string }`. Zero or multiple →
  emit nothing (reply will be unavailable for that child; never guess).
- **Reply**: `subagent_reply(id, text)` targets a **settled headless** child
  with a known `sessionFilePath`. It spawns a **new** subagent (new `sa-N` id
  — terminal snapshots are sticky by manager invariant; never reanimate an id)
  that resumes the session. The new snapshot records `repliesTo: <old id>`.
- **Concurrency guard**: at most one live continuation per session file. A
  session file with a running/queued continuation refuses further replies
  (JSONL append corruption otherwise).
- **Inheritance on reply**: cwd, worktree ref, and baseRef come from the
  original snapshot (cumulative manifest diffs stay anchored to the original
  base); model/thinking from `snapshot.modelLabel`/`thinkingLabel`; role
  system prompt and built-in tools re-resolved in `tools.ts` from
  `snapshot.roleId` exactly like `subagent_spawn` does. Reply children are
  always headless and never create a new worktree.

## Steps

### Step 1: Domain — `session-located` event and `repliesTo` field

In `src/subagents/domain.ts`:

- Add `| { kind: "session-located"; sessionFilePath: string }` to `SubagentEvent`.
- Add `readonly repliesTo?: string;` to `SubagentSnapshot`.

In `src/subagents/manager.ts` `fold()`, before the `isSettled(current)` sticky
check would matter (the backend emits it pre-settle, but be defensive): handle
`session-located` by setting `sessionFilePath` on the current snapshot and
`notify()`. In `settle()`, confirm the spread of `latest` preserves
`sessionFilePath` (it does — verify, don't assume).

**Verify**: `pnpm exec tsc --noEmit` → exit 0 (wiring lands in later steps).

### Step 2: Part A — pane backend emits per-turn `message-end`

In `src/subagents/backend-pane.ts`:

- Track `let lastEmittedResponse = "";` per child.
- In `poll()`, before the exit-file check: read `paths.responseFile` (reuse
  `readText`); if non-empty, different from `lastEmittedResponse`, and not
  settled/interrupted → `lastEmittedResponse = text;
  emitEvent?.({ kind: "message-end", role: "assistant", text: text.trim() })`.
- Order matters: do the response check **before** the exit check in the same
  tick so the final turn is emitted even when response and exit appear
  between the same two polls (harmless duplication with settle's `finalText`
  is fine; a *missed* final turn in the transcript is not).

Tests (`backend-pane.test.ts`, injected fs + `pollIntervalMs`): response
content appears → one `message-end`; unchanged content → no re-emit; content
changes twice → two events in order; response+exit in one tick → `message-end`
then `run-settled` with matching `finalText`.

**Verify**: `pnpm vitest run src/subagents/backend-pane.test.ts` → pass.

### Step 3: Part B — headless session persistence and discovery

In `src/subagents/backend-pi.ts`, extend `spawnPiChild` options with
`id: string`, `createdAt: number`, and `resumeSessionFile?: string`, and:

1. Compute `sessionDir` per the design contract (skip when resuming — derive
   from `dirname(resumeSessionFile)`).
2. `mkdirSync(sessionDir, { recursive: true })` before spawn.
3. Build args: start from `config.subprocessArgs`, remove `"--no-session"`
   (mirror the `filtered` approach at `native-task-tool.ts:161`), append the
   session flags per the design contract. Do not touch
   `native-task-config.ts`.
4. In the `close` handler, **before** emitting any `run-settled`: readdir
   `sessionDir`; exactly one `*.jsonl` entry → emit
   `{ kind: "session-located", sessionFilePath: join(sessionDir, entry) }`.
   Wrap in try/catch — discovery failure must never affect settle outcome.

In `src/subagents/index.ts`, thread `id: task.id`, `createdAt` (use
`Date.now()` at factory call — or thread the manager's `createdAt` if the
factory signature allows without contortion), and
`resumeSessionFile: task.resume?.sessionFilePath` into `spawnHeadless`.

Tests (`backend-pi.test.ts`, fake `spawnImpl` capturing args): fresh spawn args
contain `--session-dir` and not `--no-session`; resume args contain
`--session <file>`; `session-located` emitted before `run-settled` when the
dir holds one jsonl; not emitted for zero/two files; discovery error swallowed.

**Verify**: `pnpm vitest run src/subagents/backend-pi.test.ts src/subagents/index.test.ts` → pass.

### Step 4: Manager — `resume` spawn path and `reply()`

In `src/subagents/manager.ts`:

1. Add to `SpawnSubagentTask`:
   `readonly resume?: { readonly sessionFilePath: string; readonly repliesTo: string; readonly worktree?: SubagentWorktreeRef; readonly baseRef?: string };`
2. In `startTask`, when `task.resume` is set: skip worktree creation entirely
   (reject `task.worktree`/`task.branch` combined with `resume` as a spawn
   failure — contradictory request), use `task.cwd` as-is, set
   `worktree = task.resume.worktree` and
   `manifestBaseRef = task.resume.baseRef ?? gitContext.baseRef ?? "HEAD"`.
   Set `repliesTo` on the initial snapshot via `makeInitialSnapshot` (extend
   its signature or set after construction — match local style).
3. Add:

```ts
public async reply(id: string, text: string): Promise<SubagentSnapshot | AtCapacityDetails>
```

Validation (throw with descriptive messages listing known ids where the
existing tools do): unknown id; visible child →
`` `${id} is a visible child — it converses live via subagent_send while open; reply-after-close is not supported` ``;
not settled → `` `${id} is still ${status} — steer it with subagent_send (visible) or wait for it to settle` ``;
settled without `sessionFilePath` →
`` `${id} has no captured session (spawned before session persistence, or discovery failed) — respawn instead` ``;
another tracked snapshot with the same `sessionFilePath` in `running`/`queued`
→ `` `a reply to ${id} is already in flight (${otherId})` ``.
Then delegate to `this.spawn({...})` with: `prompt: text`,
`title: original.title` prefixed `re: ` once (do not stack `re: re: `),
`cwd/model/thinking/roleId/appendSystemPrompt/builtInTools` passed by the
caller (tools layer), `visible: undefined`, and
`resume: { sessionFilePath, repliesTo: id, worktree: original.worktree, baseRef: original.baseRef }`.
Capacity/queue behavior is inherited from `spawn` unchanged.

Tests (`manager.test.ts`, fake backend): every validation branch; resume
spawn skips worktree creation and carries `worktree`/`baseRef`/`repliesTo`;
in-flight-reply guard covers queued continuations too; `session-located` fold
updates a running snapshot and survives settle.

**Verify**: `pnpm vitest run src/subagents/manager.test.ts` → pass.

### Step 5: Tools and prompt surface

In `src/subagents/tools.ts`, register `subagent_reply`:

- Parameters: `id: Type.String(...)`, `text: Type.String({ description: "Follow-up prompt continuing the settled child's session." })`,
  optional `model`/`thinking` overrides mirroring spawn's enums.
- Execute: resolve the original snapshot (`manager.get`); re-resolve role
  system prompt and `builtInTools` from `snapshot.roleId` using the same
  `roleLoader`/`getActiveTools` code path `subagent_spawn` uses (extract a
  small shared helper inside `tools.ts` rather than duplicating); call
  `manager.reply` via a task assembled with model/thinking =
  explicit param ?? snapshot label; handle `at_capacity` with
  `formatAtCapacity`; success text:
  `` `Started ${newId} continuing ${id}'s session. Same fire-and-forget contract: the result is delivered when it settles.` ``
  with `{ action: "reply", id: newId, repliesTo: id, subagent, activity }`.
- Update `subagent_check`/`subagent_list` line formatting to append
  `· re: ${repliesTo}` when present (`formatSnapshotLine`).

In `src/subagents/prompt.ts`:

- Add `SUBAGENT_TOOL_DESCRIPTIONS.reply`: "Continue a settled headless
  subagent's conversation in a new child that resumes its session — full prior
  context, no re-prompting. Visible children converse live via subagent_send
  instead."
- Add one guideline line: prefer `subagent_reply` over respawning with a
  re-pasted context when iterating on a settled child's output; note visible
  children take `subagent_send` while open.

Tests: `tools.test.ts` (registration, validation error surfacing, at-capacity,
role re-resolution threading), `prompt.test.ts` (description updates).

**Verify**: `pnpm vitest run src/subagents/tools.test.ts src/subagents/prompt.test.ts` → pass.

### Step 6: Full gates

```bash
pnpm lint
pnpm test
pnpm exec tsc --noEmit && pnpm build
pnpm test:integration
git status --short
```

Expected: exit 0; only in-scope files modified. Optional operator evidence
(live, not a gate): spawn a headless child, let it settle, `subagent_reply`
with a question about its own earlier output, and confirm the answer proves
context carry-over; `subagent_check` on a visible child mid-conversation shows
its latest turn.

## Test plan

Per-step above. Structural patterns: `backend-pane.test.ts` injected-fs
harness (Part A), `backend-pi.test.ts` fake-`spawnImpl` arg capture (Part B),
`manager.test.ts` fake-backend lifecycle tests (resume/reply), existing
`subagent_spawn` tests for tool-layer role threading.

## Done criteria

- [ ] `pnpm lint`, `pnpm test`, `tsc --noEmit`, `pnpm build` all exit 0
- [ ] `grep -n "no-session" src/subagents/backend-pi.ts` shows only the
      removal/filter logic, and captured spawn args in tests assert
      `--session-dir` presence
- [ ] `grep -n "session-located" src/subagents/domain.ts src/subagents/manager.ts src/subagents/backend-pi.ts` matches in all three
- [ ] `grep -n "subagent_reply" src/subagents/tools.ts src/subagents/prompt.ts` matches in both
- [ ] Pane backend test proves a mid-run `message-end` reaches the manager
      snapshot (live `subagent_check` preview)
- [ ] Reply-concurrency guard test exists and passes
- [ ] No files outside Scope modified; Plan 095 row updated in `plans/README.md`

## STOP conditions

- PR #381's `b34bd79` control-channel/lifecycle seams are absent or have been
  semantically replaced without an equivalent `sendTo`/`close` contract.
- `pi --mode json -p --session <existing file>` does not resume the session
  (verify against the pinned Pi's CLI docs / `native-task-tool.ts` behavior
  before step 3; if the fork path works but direct resume does not, report —
  do not silently switch to copy-then-resume, which would orphan the reply
  chain).
- Pi writes more than one session file into a fresh `--session-dir` per run
  (discovery contract broken).
- The resume path cannot skip worktree creation without restructuring
  `startTask` beyond the single branch described in step 4.
- Reply requires touching `native-task-config.ts` or `native-task-tool.ts`.
- A step's focused verification fails twice after a reasonable in-scope fix.

## Maintenance notes

- **Reply chains**: each reply appends to the same session JSONL, so `sa-9`
  replying to `sa-4` leaves both snapshots pointing at one file; the
  concurrency guard keys on the file, not the id. Reviewers should check the
  guard covers queued continuations, not just running ones.
- **Session dirs are never cleaned up** — same policy as worktrees and task
  dirs. They join the existing "worktree loop closure" direction item in
  `plans/README.md` if disk pressure becomes real.
- **Deferred**: reply-after-close for visible children (their session lives
  inside the child SumoCode host's own session store; continuing it means
  `sumocode task --session` passthrough — a launcher change out of this
  plan's scope). Also deferred: `subagent_reply` targeting a *running*
  headless child (that is mid-run steering; if it becomes necessary, that is
  the RPC-transport conversation, revisit the rejected direction with
  evidence).
- If Plan 090 lands, nothing here changes: `sendUserMessage` steering and
  session resume are both below the host-FIFO layer it removes.
