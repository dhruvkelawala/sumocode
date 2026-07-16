# Plan 065: Add the subagents core — domain model, manager, pi backend, and five verb tools

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat d4ce41d..HEAD -- src/native-task-tool.ts src/background-tasks/ src/extension.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `d4ce41d`, 2026-07-15

## Why this matters

SumoCode currently exposes three overlapping delegation products to the model
(`task`, `bg_task runner=sumocode`, plus the externally installed `subagent`
extension), each with different lifecycle, waiting, and result contracts. The
decided direction (see `docs/research/SUMOCODE_ORCHESTRATION_BENCHMARK_2026.md`,
"Recommended SumoCode sequence") is **one grammar**: small verb-per-tool
surfaces — `subagent_spawn / subagent_check / subagent_wait / subagent_cancel /
subagent_list` — over a single manager that folds a normalized event stream
into per-child snapshots. This plan builds that core. It is the foundation the
delivery (066), UI (068), worktree/manifest (069), and migration (070) plans
build on. The reference implementation for this shape is
`davis7dotsh/my-pi-setup` `extensions/subagents` (public GitHub repo); this
plan adapts it to SumoCode's conventions and its existing `pi` subprocess
machinery.

## Current state

- `src/native-task-tool.ts` — the existing `task` tool. It already contains
  battle-tested subprocess spawn/parse machinery you will REUSE (read it
  before starting):
  - `runSingleTask` (~line 675) spawns `pi` with JSON-event output and parses
    line-delimited events:

    ```ts
    // src/native-task-tool.ts:718 (approx)
    const proc = spawn("pi", args, {
        cwd: options.defaultCwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stdin.end();
    ```

  - Event parsing (~lines 735–795): handles `message_update` (with
    `assistantMessageEvent.type === "text_delta"`), `tool_execution_start`,
    `tool_execution_update`, `tool_execution_end`, and
    `message_end`/`tool_result_end` carrying a `Message`.
  - `attachAbortSignal` (~line 531): SIGTERM then SIGKILL after 5s.
  - `resolveTaskConfig` (imported from `src/native-task-config.ts`) builds
    `subprocessArgs` (the pi CLI flags) and resolves model/thinking. Reuse it
    rather than hand-rolling flags.
- `src/background-tasks/task-manager.ts` — contains the cooperative
  at-capacity pattern to copy (do NOT import from it; copy the pattern):

  ```ts
  // src/background-tasks/task-manager.ts:107-116
  export class BackgroundTaskCapacityError extends Error {
      public readonly details: AgentCapacityDetails;
      ...
  }
  ```

  and `formatAtCapacity` in `src/background-tasks/background-task-tool.ts:44-56`
  which returns a SUCCESSFUL tool result with `status=at_capacity` prose and
  structured details instead of throwing.
- `src/background-tasks/background-task-tool.ts` — the repo's canonical
  `pi.registerTool({...})` exemplar: `name`, `label`, `description`,
  `promptSnippet`, `promptGuidelines`, typebox `parameters`
  (`Type.Object`, `Type.Optional`, and a local `StringEnum` helper at lines
  29–34), and `async execute(_toolCallId, params, _signal, _onUpdate, ctx)`.
  Match this structure exactly.
- `src/extension.ts` — extension entry. Tools install inside
  `export default function sumocode(pi)` (~line 296 for `taskTool`, ~line 317
  for `installBackgroundTasks`) and inside `installRpcChildProfile` (~lines
  196–217). New installers must be added to BOTH profiles.
- Repo conventions: TypeScript strict, tab indentation, ES modules with `.js`
  import suffixes, colocated `*.test.ts` vitest tests (see
  `src/background-tasks/task-manager.test.ts` for manager-test patterns),
  doc-comments explaining WHY on non-obvious code.

## Commands you will need

| Purpose   | Command                                        | Expected on success |
|-----------|------------------------------------------------|---------------------|
| Typecheck | `pnpm typecheck`                               | exit 0              |
| All tests | `pnpm test`                                    | all pass            |
| One file  | `pnpm vitest run src/subagents/manager.test.ts`| all pass            |

## Scope

**In scope** (the only files you should modify/create):
- `src/subagents/domain.ts` (create)
- `src/subagents/manager.ts` (create)
- `src/subagents/backend-pi.ts` (create)
- `src/subagents/tools.ts` (create)
- `src/subagents/prompt.ts` (create)
- `src/subagents/index.ts` (create)
- `src/subagents/manager.test.ts`, `src/subagents/backend-pi.test.ts`,
  `src/subagents/tools.test.ts` (create)
- `src/extension.ts` (wire the installer into both profiles)

**Out of scope** (do NOT touch, even though they look related):
- `src/native-task-tool.ts` and `src/native-task-config.ts` — read and import
  from them; do not modify them. The `task` tool keeps working unchanged
  (migration is plan 070).
- `src/background-tasks/**` — the shell/agent bg_task system stays as is
  (plans 067/070 handle it).
- Result delivery to the parent conversation — plan 066. In this plan a
  settled result is only retrievable via `subagent_wait`/`subagent_check`.
- Any UI (dashboard/takeover/footer) — plan 068.
- Worktrees and structured manifests — plan 069.

## Git workflow

- Branch: `advisor/065-subagents-core`
- Conventional commits, e.g. `feat(subagents): add domain model and manager`
  (repo style: `fix(rpc): …`, `feat(bg_task): …` — see `git log --oneline -10`)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Domain model (`src/subagents/domain.ts`)

Define plain types (no classes needed except errors):

```ts
export type SubagentStatus = "running" | "done" | "error";

export type SubagentEvent =
    | { kind: "run-started" }
    | { kind: "assistant-delta"; delta: string }
    | { kind: "tool-start"; toolId: string; name: string; argsPreview?: string }
    | { kind: "tool-update"; toolId: string; outputPreview?: string }
    | { kind: "tool-end"; toolId: string; name: string; isError: boolean; outputPreview?: string }
    | { kind: "message-end"; role: "user" | "assistant" | "toolResult"; text: string }
    | { kind: "usage"; tokens?: number; contextWindow?: number; costUsd?: number }
    | { kind: "run-settled"; outcome: RunOutcome };

export type RunOutcome =
    | { kind: "completed"; finalText: string }
    | { kind: "failed"; errorText: string; partialText?: string }
    | { kind: "interrupted"; partialText?: string };

export interface SubagentSnapshot {
    readonly id: string;            // "sa-1", "sa-2", … per session
    readonly title: string;
    readonly prompt: string;
    readonly cwd: string;
    readonly status: SubagentStatus;
    readonly createdAt: number;
    readonly settledAt?: number;
    readonly errorText?: string;    // bounded to 4096 chars
    readonly modelLabel?: string;
    readonly sessionFilePath?: string;
    readonly usage: { tokens?: number; contextWindow?: number; costUsd?: number; turns: number };
    readonly transcript: readonly TranscriptItem[];
    readonly liveText: string;      // streaming buffer, cleared on message-end
    readonly liveTools: readonly LiveToolState[];
    readonly finalText: string;     // last completed run's final assistant text
}
```

Plus `TranscriptItem`, `LiveToolState` (id/name/preview/done/isError), and a
`latestText(snap)` helper returning `liveText || finalText`. Previews are
pre-flattened single-line strings (sanitize tabs/ANSI at the backend edge).

**Verify**: `pnpm typecheck` → exit 0

### Step 2: Pi subprocess backend (`src/subagents/backend-pi.ts`)

Export:

```ts
export interface SpawnedChild {
    readonly events: AsyncIterable<SubagentEvent> | ((emit: (e: SubagentEvent) => void) => void);
    readonly sessionFilePath?: string;
    interrupt(): void;              // SIGTERM → SIGKILL after 5s
}
export function spawnPiChild(options: {
    prompt: string; cwd: string;
    model?: string; thinking?: string;
    inherited: { model?: { provider: string; id: string }; thinking?: string };
    signal?: AbortSignal;
}): SpawnedChild;
```

Implementation: mirror `runSingleTask` in `src/native-task-tool.ts` — spawn
`pi` with args from `resolveTaskConfig` (import it from
`./native-task-config.js`; pass `builtInTools` the same way `taskTool` does),
append the prompt as the final positional arg, `proc.stdin.end()`, parse
line-delimited JSON stdout, and translate each parsed event into a
`SubagentEvent`:

- `message_update` + `text_delta` → `assistant-delta`
- `tool_execution_start/update/end` → `tool-start/update/end` (previews:
  first line of stringified args/output, max ~160 chars)
- `message_end`/`tool_result_end` with a `Message` → `message-end`; for
  assistant messages also emit `usage` (mirror `applyAssistantUsage`,
  src/native-task-tool.ts:571-581)
- process `close` → `run-settled` with `completed` (exit 0, non-empty final
  assistant text), `failed` (nonzero exit or stopReason `error`), or
  `interrupted` (aborted via signal/interrupt) — mirror `isTaskError`
  (src/native-task-tool.ts:523-525).

Prefer the callback-emitter shape (`(emit) => void`) over an async iterable —
it is simpler and matches how the manager consumes it in Step 3.

**Verify**: `pnpm vitest run src/subagents/backend-pi.test.ts` → tests pass.
Test with a fake `spawn` seam (inject a function returning a scripted
`EventEmitter`-based fake process; see how `src/background-tasks/` tests fake
processes) — do NOT spawn real `pi` in unit tests.

### Step 3: Manager (`src/subagents/manager.ts`)

`export class SubagentManager` with:

- `spawn(task): SubagentSnapshot | AtCapacityDetails` — ids `sa-N` from a
  monotonically increasing counter; enforce `MAX_RUNNING = 4` with a
  synchronous check-and-reserve BEFORE any await (parallel tool calls must not
  race past the cap). Over cap returns structured details (copy the
  `AgentCapacityDetails` shape from `src/background-tasks/task-manager.ts:96-105`)
  instead of throwing.
- Event folding: subscribe to the backend's emitter; fold every event into a
  fresh immutable `SubagentSnapshot`; notify change listeners.
- `get(id)`, `list()` — sync snapshot reads.
- `addChangeListener(fn): () => void` and `nextChange(signal): Promise<void>`.
- `waitFor(ids, signal, onPending?)` — resolves when all listed ids are
  settled; keeps a per-id `waitInterest` refcount; any child that settles
  while `waitInterest > 0` is marked **consumed** (`consumedIds: Set<string>`;
  plan 066 reads this to skip auto-delivery). Rejects with `Error` listing
  known ids when an id is unknown. Respects the `AbortSignal`.
- `cancel(ids)` — mark consumed first, then `interrupt()`, wait for
  settlement (bounded 5s + force), report per-id outcome strings.
- `disposeAll()` — interrupt all running children; called from
  `session_shutdown` (children are session-scoped in this plan; durable
  reattach is explicitly deferred — see Maintenance notes).
- Pruning: `MAX_TRACKED = 64`; prune oldest settled, non-wait-interested
  entries.

**Verify**: `pnpm vitest run src/subagents/manager.test.ts` → tests pass
(use a stub backend factory injected into the manager constructor; cover: cap
enforcement under parallel spawns, fold-to-snapshot, waitFor + consumed
marking, cancel of running and already-settled ids, prune).

### Step 4: Tools (`src/subagents/tools.ts` + `src/subagents/prompt.ts`)

All model-facing strings live in `prompt.ts` (mirror
`src/background-tasks/background-task-tool.ts` structure). Register FIVE
tools via `pi.registerTool` — no action enums:

| Tool | Params | Behavior |
|---|---|---|
| `subagent_spawn` | `prompt` (req), `name` (req), `model?`, `thinking?` (enum off/minimal/low/medium/high/xhigh), `working_dir?` | Fire-and-forget; returns id + "result will be delivered when it settles" text (delivery lands in plan 066 — until then the text says to use `subagent_wait`). At capacity → the cooperative `status=at_capacity` result, never a throw. |
| `subagent_check` | `id` | Non-blocking peek: one status line + up to 2KB/20 lines of `latestText`. Does not consume. |
| `subagent_wait` | `ids` (array, max 64) | Blocks until all settle (respect tool `AbortSignal`; stream `Waiting for …` via `onUpdate`). Output budgets: 48KB total, 16KB per agent. Marks consumed. |
| `subagent_cancel` | `ids` | Cancels; reports `Cancelled sa-N` / `sa-N was already done`. |
| `subagent_list` | — | One line per agent: `sa-1 [running] "title" (model, 2m10s, cwd)`. |

Description/guidelines (put in `prompt.ts`): children are headless, have their
own context, cannot see this conversation, cannot ask the user, and cannot
spawn subagents; prompts must be self-contained; after spawning, keep working
— only wait when the result is required to proceed. Max 4 concurrent.

Export `installSubagents(pi): SubagentManager` from `src/subagents/index.ts`
that constructs the manager, registers the five tools, and hooks
`session_shutdown` → `disposeAll()`.

**Verify**: `pnpm vitest run src/subagents/tools.test.ts` → tests pass
(fake `pi` object with `registerTool`/`on` vi.fn()s — copy the harness style
from `src/background-tasks/background-task-tool.test.ts`).

### Step 5: Wire into `src/extension.ts`

Add `installSubagents(pi)` next to `installBackgroundTasks(pi)` in BOTH
`installRpcChildProfile` (~line 217) and the main `sumocode` entry (~line 317).
Keep the returned manager in a local for later plans.

**Verify**: `pnpm typecheck && pnpm test` → exit 0, all pass.

## Test plan

- `manager.test.ts`: cap race (two synchronous spawns at 3 running → exactly
  one at_capacity), fold produces streaming `liveText` then clears on
  `message-end`, waitFor consumes, cancel semantics, prune at 65 tracked.
- `backend-pi.test.ts`: JSON-line translation for each event type; abort →
  `interrupted` outcome; nonzero exit → `failed` with stderr in errorText.
- `tools.test.ts`: five tools registered with expected names; spawn returns
  id; at-capacity result contains `status=at_capacity` and running list;
  check does not consume; wait errors on unknown id listing known ids.
- Pattern exemplar: `src/background-tasks/task-manager.test.ts`.

## Done criteria

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0; new test files exist and pass
- [ ] `rg -n "registerTool" src/subagents/tools.ts` shows exactly 5 registrations
- [ ] `rg -n "installSubagents" src/extension.ts` shows 2 call sites
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `resolveTaskConfig` cannot be reused without modifying
  `src/native-task-config.ts` (out of scope) — report what minimal export
  change would be needed instead of making it.
- The `pi` subprocess JSON event shapes in `runSingleTask` do not match what a
  live `pi` emits (event names drifted with the Pi 0.80 upgrade).
- Registering a tool named `subagent_spawn` collides with an
  externally-installed extension in the runtime (duplicate tool names are
  fatal in Pi) — report; do not rename unilaterally.
- The cap race cannot be closed synchronously (evidence of an await before
  reservation).

## Maintenance notes

- **Deferred by design**: durable recovery of subagents across `/reload`
  (bg_task-style meta.json reconciliation), a `harness` spawn axis
  (claude/codex backends), steering into a live child, worktree isolation
  (plan 069), and result auto-delivery (plan 066). The backend interface
  (`SpawnedChild`) is the seam for all of these — keep it narrow.
- Reviewers should scrutinize: the synchronous cap reservation, that
  `waitFor` cannot deadlock when a child settles between the check and the
  listener attach, and that `disposeAll` kills process groups, not just pids.
