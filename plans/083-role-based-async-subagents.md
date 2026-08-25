# Plan 083: Role-based, fire-and-forget subagents — role presets, spawn queue, and a `/roles` editor

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat d5bd6a3..HEAD -- src/subagents/ src/native-task-config.ts src/background-tasks/visible-spawn.ts src/activity/subagent-adapter.ts src/subagents/index.ts src/extension.ts src/commands/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Implementation state**: BLOCKED — backend complete; RPC strip and worktree-backed visible pane live-verified after reload in the parent tab (`w8:t1`, child `w8:p8`); only a clean full local integration run remains before DONE.
- **Priority**: P2
- **Effort**: L
- **Risk**: MED (Step 4, the queue, is the risky part; Steps 1–3 and 5 are LOW)
- **Depends on**: none (plans 065–070 and 082 are DONE and merged)
- **Category**: direction
- **Planned at**: commit `d5bd6a3`, 2026-08-25

## Why this matters

SumoCode's subagent grammar (`subagent_spawn/send/check/wait/cancel/list`,
plans 065–070) is mechanically async — settled results auto-inject as
follow-up messages with `triggerTurn: true` — but behaviorally synchronous:
the spawn tool's own success text says *"or use subagent_wait to block for
it"*, so the main agent spawns and immediately blocks, defeating the
architecture. Every spawn is also role-less: the model hand-writes the entire
child contract each time, with no reusable definitions for recurring
delegation shapes (research, review, docs, design, implementation).

This plan makes delegation **role-based** (six built-in roles + user-editable
overrides, applied via pi's real `--append-system-prompt`), **behaviorally
async** (rewritten tool copy that teaches fire-and-forget; a bounded spawn
queue so capacity never forces the orchestrator back into manual retry), and
**operator-configurable** (a `/roles` command that edits role config from
inside SumoCode). Operator decisions already made — do not re-litigate:
queue past capacity (not persistent workers), built-in presets + user config
in `~/.pi/agent` (no project-local roles), an in-app editing interface, and
TWO implementer roles (cheap and smart).

## Current state

All facts verified at `d5bd6a3`. Files and their roles:

- `src/subagents/domain.ts` — snapshot/event domain model.
  `SubagentStatus = "running" | "done" | "error"` (line 3). `SubagentSnapshot`
  has `modelLabel`, `thinkingLabel`, `visible`, `worktree` fields you will
  extend with `roleId`.
- `src/subagents/manager.ts` — `SubagentManager`. `MAX_RUNNING = 4` (line 13).
  `spawn()` returns `AtCapacityDetails` when
  `runningSummaries.length >= MAX_RUNNING`. `isSettled` is defined as:

  ```ts
  // src/subagents/manager.ts:~90
  const isSettled = (snapshot: SubagentSnapshot): boolean => snapshot.status !== "running";
  ```

  `spawn()` does, in order: capacity check → `captureGitContext` → optional
  worktree creation → optional visible placement (`planPlacement` +
  workspace/tab open) → `backendFactory(...)` → snapshot insert → event
  consumption. `settle()` removes the child, builds the completion manifest,
  writes the terminal snapshot, and calls `notify()`.
- `src/subagents/tools.ts` — the six `subagent_*` tools. `subagent_spawn`
  params today: `prompt, name, model, thinking, working_dir, worktree,
  branch, baseRef, visible`. Spawn success text (line ~155):

  ```ts
  return makeToolResult(`Started ${spawned.id} (${spawned.title}). Its result will be delivered to you automatically when it settles, or use subagent_wait to block for it.`, ...
  ```

- `src/subagents/prompt.ts` — `SUBAGENT_PROMPT_GUIDELINES` (array of
  strings), `SUBAGENT_TOOL_DESCRIPTIONS` (spawn/send/check/wait/cancel/list),
  `SUBAGENT_PROMPT_SNIPPET`, `buildSubagentResultMessage`.
- `src/subagents/backend-pi.ts` — headless children. `createPiChildSpawner`
  calls `resolveTaskConfig(...)` then spawns
  `pi [...config.subprocessArgs, ...adapterArgs, options.prompt]`. Children
  run `--no-extensions`; the Claude OAuth adapter is re-injected via `-e`.
- `src/native-task-config.ts` — `buildSubprocessArgs` produces
  `["--mode","json","-p","--no-session","--no-extensions", (--provider/--model),
  "--thinking",..., (--tools|--no-tools)]`. Shared with the native `task`
  tool — **do not change its output for the task path**.
- Pi CLI supports `--append-system-prompt <text>` ("Append to system
  prompt") — see the pi README options table (line ~610 of
  `node_modules/.pnpm/@earendil-works+pi-coding-agent@0.84.1_*/node_modules/@earendil-works/pi-coding-agent/README.md`).
- `src/subagents/backend-pane.ts` + `src/background-tasks/visible-spawn.ts` —
  visible children run `sumocode task [--model][--thinking][--tools|--no-tools]
  --task-dir <dir>` in a terminal-host pane (`buildVisibleAgentCommand`,
  visible-spawn.ts:96). The child prompt is written to a **prompt file** in
  the task dir; there is no system-prompt flag on this path.
- `src/subagents/index.ts` — `installSubagents`. The delivery loop skips
  unsettled snapshots with an **exact status comparison**:

  ```ts
  // src/subagents/index.ts:~117 (onManagerChange)
  if (snapshot.status === "running" || observedSettledIds.has(snapshot.id)) continue;
  ```

  This line treats anything not-"running" as settled. Adding a `queued`
  status without fixing this would auto-deliver queued children as results.
- `src/activity/domain.ts` — `ActivityStatus` **already includes** `"queued"`
  (line 2); the activity/UI contract anticipates this plan.
- `src/activity/subagent-adapter.ts` — maps `SubagentSnapshot` →
  `ActivitySnapshot`; the status mapping function returns `"running"` for
  non-settled (line ~186). Needs a `queued` branch.
- `src/commands/persona.ts` — the exemplar for "open a config file in
  $EDITOR from a command" (`runPersonaCommand`, TTY-defensive, `ctx.ui.notify`).
- `src/compaction-indicator.ts` + `src/compaction-status-row.ts` — the
  exemplar for a small transient status element in the main chat window: a
  PURE renderer module (`renderCompactionStatusRow` — theme tokens via
  `getActiveTheme()`, `span`/`textLine`/`truncateLine`/`lineToAnsi` from
  `src/sumo-tui/render/primitives.js`) mounted with
  `ctx.ui.setWidget(KEY, factory, { placement: "aboveEditor" })` and cleared
  with `ctx.ui.setWidget(KEY, undefined, { placement: "aboveEditor" })`
  (see `src/compaction-indicator.ts:118–136`). Chrome publication over RPC
  exists (plan 022), so `setWidget` is expected to surface in both runtimes —
  Step 6 verifies rather than assumes.
- `src/divine-query.ts` — `showDivineQuery(ctx, title, options: readonly string[]): Promise<string | undefined>`
  (line 237). This is the ONLY selector SumoCode-owned code may use
  (never raw `ctx.ui.select` — see `docs/PI_TOOL_ARCHITECTURE.md`).
- `ctx.ui.input(title, placeholder)` exists and is used at
  `src/question-tool.ts:233` — use it for free-text fields.
- `src/commands/review.ts:196` — command naming convention:
  `pi.registerCommand("sumo:review", ...)`.
- `src/sidebar.ts:54` — agent-dir resolution convention:
  `process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")`. Match it.
- `src/extension.ts:217` — `const subagentManager = installSubagents(pi);`.
  Commands are registered nearby in the same wiring function; match the
  existing `registerXCommand(pi)` pattern.

Conventions that apply (from `AGENTS.md`): tabs in TS, strict TS with
`noUnusedLocals`, tests colocated (`foo.ts` → `foo.test.ts`), voice is
lowercase/terse for product copy (`src/voice.ts`), TTY-defensive UI, user
state NEVER in this repo (role config lives under `~/.pi/agent/`), typebox is
peer-only (import from `typebox`).

**Trust boundary (must honor, from `src/subagents/backend-pi.ts` comments):**
project-scoped config is deliberately excluded from child boot configuration
because a hostile repo could shape child behavior. Role definitions therefore
load ONLY from built-ins and the global agent dir — never from the project.

## Design grounding (external research, 2026-08-25)

Verified against primary docs; the executor does not need to re-research.

- **Converged role format**: Claude Code and GitHub Copilot both define
  subagents as `name`/`description`/`tools`(/`model`) frontmatter + a body
  that becomes the child's system prompt (code.claude.com/docs/en/sub-agents,
  docs.github.com — custom agents). This plan keeps those exact field
  semantics but stores them in `roles.json`, because the `/roles` editor
  (Step 5) must round-trip sparse single-field overlays programmatically —
  markdown frontmatter round-tripping is lossy and error-prone. A markdown
  importer is a possible follow-up, not in scope.
- **Descriptions drive routing**: Claude Code delegates by matching the
  `description` field to the task and recommends "use proactively…" phrasing.
  Role `description` fields must therefore say WHEN to use the role, not what
  it is (e.g. research: "use proactively for read-only investigation and
  evidence gathering"), and Step 2 must surface the id + description of every
  loaded role inside the `subagent_spawn` tool description so the model can
  route.
- **Anti-retry wording works**: Claude Code's concurrency-limit error
  literally tells the model not to retry, and its docs state background
  results arrive as later-turn notifications so the parent "doesn't need to
  poll". Steps 3–4 copy must use the same explicit imperative style
  ("do not retry, do not wait — you will be woken").
- **Cheap models pair with restricted tools**: every system that documents
  cost routing (Claude Code Explore-on-Haiku, Amp Oracle, CrewAI
  `function_calling_llm`) puts cheap models on read-only roles and makes the
  expensive model explicit opt-in — supporting this plan's
  research/review-as-narrowed-roles and implement-cheap/implement-smart split.
- **oh-my-pi (omp, can1357/oh-my-pi) — the closest prior art, Pi-based**
  (recon of `docs/task-agent-discovery.md`, `docs/agent-hub.md`,
  `src/modes/running-subagent-badge.ts`, `src/prompts/tools/task-async-contract.md`
  at HEAD, 2026-08-25):
  - Agent definitions are frontmatter markdown with `name`/`description`/
    `systemPrompt` required; bundled roles include `scout`, `designer`,
    `reviewer`, `security-reviewer`, `librarian` — independent convergence
    with this plan's role set (designer and reviewer roles are not exotic).
  - **Async is the default; blocking is per-agent opt-in** (`blocking: true`
    "makes the parent wait even when async task execution is enabled") — the
    exact inversion this plan performs on the tool copy.
  - Its async contract prompt opens with the three words this plan's copy
    should echo: **"No polling needed."** Results arrive as follow-up
    messages; a child-side yield submitted before a late job result is
    explicitly superseded.
  - **Model roles indirection**: agent frontmatter says `model: "@review"`;
    `modelRoles.review: openai/gpt-5.4:high` in user config resolves it.
    Repointing one mapping re-routes every agent using the alias without
    editing definitions. Deliberately NOT adopted in this plan (one more
    indirection than six roles need) — recorded as the natural v2 of
    `roles.json` model config in Maintenance notes.
  - **Small-UI precedent**: omp's main chat shows a status-line subagent
    count (`statusLine.setSubagentCount(count)` — running `sub`-kind agents
    only) and reserves the full roster for an Agent Hub overlay (Alt+A:
    status/model/age/usage per agent, steer, kill, revive). Step 6's strip
    sits between the two: richer than a bare count, far short of a Hub.
  - Discovery is first-wins dedup with per-file failure isolation ("one bad
    custom agent file does not abort discovery") — same defensive-loader
    semantics Step 1 specifies. omp DOES load project-local `.omp/agents/`;
    SumoCode's global-only decision is a consciously stricter trust posture,
    not an oversight.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit && pnpm build` | exit 0, no errors |
| Unit tests | `pnpm test` | all pass |
| One file | `pnpm vitest run src/subagents/roles.test.ts` | all pass |
| Subagent suite | `pnpm vitest run src/subagents` | all pass |
| Integration | `pnpm test:integration` | all pass (1 known PTY-concurrency flake may occur; passes in isolation) |

## Scope

**In scope** (the only files you should modify or create):
- `src/subagents/roles.ts` + `src/subagents/roles.test.ts` (create)
- `src/subagents/domain.ts`, `src/subagents/manager.ts` (+ tests)
- `src/subagents/tools.ts`, `src/subagents/prompt.ts` (+ tests)
- `src/subagents/backend-pi.ts`, `src/subagents/backend-pane.ts` (+ tests)
- `src/subagents/index.ts` (+ test)
- `src/activity/subagent-adapter.ts` (+ test)
- `src/commands/roles.ts` + `src/commands/roles.test.ts` (create)
- `src/subagent-status-row.ts` + `src/subagent-status-row.test.ts` (create)
- `src/extension.ts` (wiring only)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):
- `src/native-task-config.ts` / `src/native-task-tool.ts` — the native `task`
  tool stays role-less; do not add role params or change `buildSubprocessArgs`
  output. If you need extra args, append them in `backend-pi.ts` after
  `config.subprocessArgs`.
- `src/background-tasks/` (except reading `visible-spawn.ts`) — `bg_*`
  terminals are a different product.
- `src/sumo-tui/` — no retained-renderer changes; activity cards already
  render `queued` via the existing `ActivityStatus` contract.
- The `sumocode task` wrapper (`src/task-mode.ts`) — visible children get the
  role prompt via prompt-file preamble, not a new wrapper flag (deferred, see
  Maintenance notes).
- Any persistence/durable-registry work — children still die on
  `session_shutdown` (recorded deferral in plan 065).

## Git workflow

- Branch: `advisor/083-role-based-async-subagents`
- Conventional commits, one per step (repo style: `feat(subagents): …`,
  `fix(transcript): …` — see `git log --oneline -10`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create the roles module with six built-in presets and global user overrides

Create `src/subagents/roles.ts`:

```ts
export interface SubagentRole {
	readonly id: string;               // stable slug: "research"
	readonly label: string;            // "Research"
	readonly description: string;      // one line, shown in tool docs + /roles
	readonly systemPrompt: string;     // appended to the child's system prompt
	readonly model?: string;           // provider/modelId; undefined = inherit parent.
	                                   // EVERY role's model is operator-configurable via
	                                   // /roles; "inherit" is always one of the choices.
	readonly thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	readonly tools?: readonly string[];      // built-in allowlist; undefined = inherit parent's
	readonly defaultWorktree?: boolean;      // spawn default when call omits worktree
	readonly defaultVisible?: boolean;       // spawn default when call omits visible
}
```

Built-in presets (export as `BUILT_IN_ROLES: readonly SubagentRole[]`). The
system prompts below are the starting copy — keep the intent, match
`src/voice.ts` tone (lowercase, terse):

1. **research** — tools `["read", "grep", "find", "ls", "bash"]` (no
   edit/write), no worktree. Prompt: read-only investigator; never modify
   files; answer with evidence (`file:line` or URLs); state what was NOT
   checked; findings only, no fixes.
2. **review** — tools `["read", "grep", "find", "ls", "bash"]`, no worktree.
   Prompt: review like a tech lead; verify claims by opening cited code; report
   findings ordered by severity with `file:line` evidence; never edit files;
   flag out-of-scope diff hunks explicitly.
3. **documentor** — full tool inherit, `defaultWorktree: true`. Prompt: write
   or update documentation only; match the repo's existing doc voice and
   structure; never change source code semantics; list every file touched.
4. **designer** — full tool inherit, `defaultWorktree: true`. Prompt: UI/UX
   work; read the repo's design conventions and visual specs before changing
   any surface; produce capture/review evidence for visual changes; never
   promote goldens.
5. **implement-cheap** — full tool inherit, `defaultWorktree: true`,
   `thinking: "low"`. Prompt: implement exactly the specified slice; smallest
   diff that passes verification; run the named verification commands; if the
   spec is ambiguous, stop and report instead of improvising.
6. **implement-smart** — full tool inherit, `defaultWorktree: true`,
   `thinking: "high"`, model inherit. Prompt: implement with judgment; keep
   scope tight; document tradeoffs made; run full relevant verification.

All six presets ship with `model` unset (= inherit). None of them is
special-cased: the operator can point ANY role at a specific model via
`/roles`, and can return any role to inherit the same way.

User overrides: single JSON file at
`join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sumocode", "roles.json")`
(export a `resolveRolesPath()` — match `src/sidebar.ts:54`). Shape:
`{ "roles": [ <partial SubagentRole with required id> ] }`. Semantics:

- Merge by `id` over built-ins (user fields win, field-by-field); unknown ids
  become NEW roles (require `systemPrompt` + `label` for new roles).
- `model` accepts the literal string `"inherit"` in `roles.json`, normalized
  to `undefined` at load. This matters for the sparse-overlay semantics: an
  ABSENT field means "don't override the built-in", so if a built-in preset
  ever ships with a model set, the only way an overlay can force
  inherit-from-parent is to say so explicitly. (Claude Code's `model:
  inherit` is the same convention — see Design grounding.)
- Validate defensively: bounded file size (reject > 256 KB), unknown fields
  ignored, invalid entries skipped with a collected warning list (return
  `{ roles, warnings }` from `loadRoles(deps)`), never throw on bad JSON —
  fall back to built-ins with a warning.
- `loadRoles` takes injectable deps (`readFile`, `env`) for tests, and is
  called fresh per use (spawn-time and `/roles`) — no cache, so edits apply
  without a reload. The file is small; this is fine.
- Tool lists are validated against `BUILT_IN_TOOLS` from
  `src/native-task-config.ts` (import it); invalid tool names are dropped
  with a warning.

**Verify**: `pnpm vitest run src/subagents/roles.test.ts` → all pass;
`pnpm exec tsc --noEmit` → exit 0.

### Step 2: Thread roles through spawn (both backends)

1. `src/subagents/tools.ts` — add optional `role` string param to
   `subagent_spawn`. The param description must enumerate each loaded role as
   `id — description` (call `loadRoles()` once at registration for the
   static description; spawn-time resolution still loads fresh) and state
   that explicit params override role defaults. Role descriptions are the
   routing signal — keep them "use when…" shaped (see Design grounding). On spawn: `loadRoles()`, resolve
   the role by id; unknown role → return an inline error listing known role
   ids (do NOT throw; mirror the at-capacity "expected, not a failure" shape).
   Resolution precedence, explicit call param > role field > inherited:
   - `model`: `params.model ?? role.model ?? undefined` (undefined = inherit, existing behavior)
   - `thinking`: `params.thinking ?? role.thinking ?? undefined`
   - `worktree`: `params.worktree ?? role.defaultWorktree`
   - `visible`: `params.visible ?? role.defaultVisible`
   - tools: intersect `role.tools` (when set) with the parent's
     `pi.getActiveTools()` built-ins — a role may only NARROW, never broaden
     (same fail-closed principle documented in `src/subagents/index.ts`).
2. `src/subagents/manager.ts` — `SpawnSubagentTask` gains
   `readonly roleId?: string` and `readonly appendSystemPrompt?: string`;
   copy `roleId` onto the snapshot (`domain.ts`: add
   `readonly roleId?: string` to `SubagentSnapshot`;
   `makeInitialSnapshot` threads it).
3. `src/subagents/backend-pi.ts` — when `appendSystemPrompt` is set, append
   `["--append-system-prompt", text]` AFTER `config.subprocessArgs` (do not
   touch `native-task-config.ts`).
4. `src/subagents/backend-pane.ts` — visible children have no system-prompt
   flag; when `appendSystemPrompt` is set, prepend a delimited preamble to
   the prompt written to the prompt file:
   `role instructions (follow these for this entire session):\n<systemPrompt>\n---\n<original prompt>`.
   Add a comment noting the headless/visible asymmetry and the deferred
   wrapper flag (Maintenance notes).
5. `src/subagents/tools.ts` `formatSnapshotLine` + `src/subagents/index.ts`
   `settledPayload` — include the role id when present (e.g.
   `sa-2 [running] "…" (research, provider/model, 34s, /cwd)`).

**Verify**: `pnpm vitest run src/subagents` → all pass, including new tests:
role narrows tools but never broadens; unknown role returns the inline error;
`--append-system-prompt` appears in headless spawn args exactly when a role
has a system prompt; pane prompt file carries the preamble.

### Step 3: Rewrite the delegation copy for fire-and-forget

The operator's core complaint: the main agent calls `subagent_wait`
immediately after spawning. Fix the copy that causes it —
`src/subagents/prompt.ts` and the spawn result text in `tools.ts`:

1. Spawn success text: delete "or use subagent_wait to block for it".
   Replace with (adjust wording to voice, keep the semantics):
   `Started ${id} (${title}). No polling needed — continue other work or END YOUR TURN; the result will be delivered to you and wake you automatically when it settles. Only call subagent_wait if you cannot take a single further step without this result.`
   ("No polling needed" leads deliberately — it is omp's proven async-contract
   opener; see Design grounding.)
2. `SUBAGENT_TOOL_DESCRIPTIONS.wait` — demote: "Block until subagents settle.
   Last resort: results deliver automatically on settlement; prefer ending
   your turn. Use only when nothing can proceed without the result."
3. `SUBAGENT_PROMPT_GUIDELINES` — replace the "After spawning, keep working;
   call subagent_wait only when the result is required to proceed." bullet
   with an explicit contract, and add the roles: 
   - "delegation is fire-and-forget: after spawning, continue other work or end
     your turn. settled results arrive as automatic follow-up messages that
     wake you. do NOT call subagent_wait right after subagent_spawn."
   - "spawn with a role for recurring shapes: research, review, documentor,
     designer, implement-cheap, implement-smart. the role sets the child's
     system prompt, tool limits, and defaults; your prompt supplies the
     concrete objective and stop conditions."
   - "if spawn returns status=queued, the child starts automatically when a
     slot frees — do not retry, do not wait." (this bullet lands with Step 4;
     include it now, it is forward-compatible.)
   Keep the existing trust-model and worktree bullets unchanged.

**Verify**: `pnpm vitest run src/subagents/prompt.test.ts src/subagents/tools.test.ts`
→ pass; `grep -n "block for it" src/subagents/` → no matches.

### Step 4: Bounded spawn queue (accepted → queued → running)

The at-capacity refusal is the last synchronous point: it forces the
orchestrator to babysit slots. Replace refusal with a bounded FIFO queue.

1. `src/subagents/domain.ts` — `SubagentStatus` adds `"queued"`:
   `"queued" | "running" | "done" | "error"`.
2. `src/subagents/manager.ts`:
   - `isSettled` becomes `status !== "running" && status !== "queued"`.
   - Then audit EVERY status comparison in the subagents + activity + index
     files: `rg -n '=== "running"|!== "running"' src/subagents src/activity`
     and fix each site to be queued-aware. Known critical site:
     `src/subagents/index.ts` `onManagerChange` must skip
     `snapshot.status === "running" || snapshot.status === "queued"`.
   - New constant `MAX_QUEUED = 16`. `spawn()` when at running capacity:
     if queued count `>= MAX_QUEUED` return the existing `AtCapacityDetails`
     (now meaning "queue full"; `retryHint` becomes "queue is full — do NOT
     retry in a loop; cancel something or end your turn and respawn later");
     else store
     the full `SpawnSubagentTask` in a FIFO, insert a snapshot with
     `status: "queued"` (baseRef `"HEAD"` placeholder), and return it.
     **All deferred work — `captureGitContext`, worktree creation, visible
     placement, backend spawn — happens at DEQUEUE time**, not enqueue time,
     so the worktree branches from HEAD as of start, and a closed terminal
     host fails the child at start (recorded as a normal spawn failure on the
     existing `recordSpawnFailure` path).
   - Dequeue trigger: at the end of `settle()` and in `cancel()` after a
     running child settles, start the next queued task if a slot is free.
     Extract the current spawn body (post-capacity-check) into a private
     `startTask(task, id, createdAt)` so both `spawn()` (immediate) and the
     dequeue path share it. Dequeue must be serialized (reuse the
     `visibleSpawnTail` promise-chain pattern already in the file) so two
     settles cannot double-start one queued task.
   - `cancel()` of a queued id: remove from the FIFO, settle the snapshot as
     `interrupted` without touching `children`.
   - `waitFor` works unchanged once `isSettled` is fixed (a queued child is
     pending). `prune()` works unchanged (only prunes settled).
3. `src/activity/subagent-adapter.ts` — map snapshot `queued` →
   `ActivityStatus "queued"` (the union already has it; find the status
   mapping near line 186 and add the branch). Check the `output`/`currentStep`
   sites near lines 259/291 that compare `=== "running"`.
4. `src/subagents/tools.ts` — spawn result text for a queued child:
   `Queued ${id} (${title}) at position N — starts automatically when a slot frees. Do not retry or wait.`

**Verify**: `pnpm vitest run src/subagents/manager.test.ts` → all pass,
including new tests: 5th spawn queues (not refused); queued starts on settle
in FIFO order; cancel of queued removes it and never starts it; 21st
(4 running + 16 queued + 1) returns at_capacity; queued snapshot is NOT
delivered as a result by `installSubagents` (test in
`src/subagents/index.test.ts` — assert no `sendMessage` for a queued
snapshot); adapter maps queued (test in
`src/activity/subagent-adapter.test.ts`). Then full `pnpm test` → pass.

### Step 5: `/roles` command — in-app role editor

Create `src/commands/roles.ts` with `registerRolesCommand(pi)`; wire it in
`src/extension.ts` next to the other `registerXCommand` calls;
`pi.registerCommand("sumo:roles", ...)` (appears in the command palette
automatically like `sumo:review`).

Flow (all selectors via `showDivineQuery(ctx, title, options)` from
`src/divine-query.ts`; free text via `ctx.ui.input(title, placeholder)`;
follow `src/commands/persona.ts` for TTY-defense and `$EDITOR` launching):

1. Top level: list roles as `"<id> · <label> · <model ?? "inherit"> · <thinking ?? "inherit">"`
   plus two actions: `"open roles.json in $EDITOR"` and `"reset a role to built-in"`.
2. Picking a role → field selector: `model`, `thinking`, `tools`,
   `default worktree`, `default visible`, `system prompt`.
   - `model` → two-stage, identical for every role: first a selector
     `inherit (use parent session's model)` / `set a specific model…`;
     picking the latter → `ctx.ui.input("model (provider/modelId)", current)`.
     Choosing inherit writes the explicit `"model": "inherit"` overlay value
     (see Step 1 normalization) so it round-trips even if a built-in later
     gains a default model.
   - `thinking` → selector over `inherit, off, minimal, low, medium, high, xhigh, max`
   - `tools` → selector over `inherit parent` / `read-only (read, grep, find, ls, bash)` / `full built-in set` (three curated presets; arbitrary lists go through the JSON file)
   - `default worktree` / `default visible` → selector `inherit default / true / false`
   - `system prompt` → write current effective prompt into `roles.json` for
     that role if absent, then open `roles.json` in `$EDITOR` (persona
     pattern) — long-form text does not belong in a one-line input.
3. Every edit round-trips through `roles.json`: read (via Step 1's loader
   deps), apply the single field change as a partial-role entry (create the
   file and `sumocode/` dir if absent), write pretty-printed JSON. Never
   write built-in defaults into the file except the edited field — the file
   stays a sparse overlay.
4. Cancel (`undefined` from any selector) exits silently. Non-TTY / no-UI:
   `ctx.ui.notify`-or-stdout the roles.json path with edit instructions
   (persona's `instructions` result kind).
5. After a successful write: `ctx.ui.notify("role updated — applies to the next spawn", "info")`
   (no reload needed; Step 1 loads fresh per spawn).

Keep `roles.ts` logic pure/testable like `persona.ts`: a `runRolesCommand`
style function taking injected deps (`loadRoles`, `writeRolesFile`,
`select`, `input`, `openEditor`, `isTTY`) with the pi wiring thin.

**Verify**: `pnpm vitest run src/commands/roles.test.ts` → all pass (field
edit writes a sparse overlay; unknown file → created; non-TTY prints path;
cancel writes nothing). Manual smoke: `bin/sumocode.sh -d .` → `/roles` →
edit `implement-cheap` model → confirm `~/.pi/agent/sumocode/roles.json`
contains only the overlay.

### Step 6: Running-subagents strip in the main chat window

A small, always-current element in the chat window showing which subagents
are running, so the human can see delegation state without asking the model
for `subagent_list`. Follow the compaction indicator exemplar exactly.

1. Create `src/subagent-status-row.ts` — a PURE renderer mirroring
   `src/compaction-status-row.ts` (same imports: `getActiveTheme`,
   `span`/`textLine`/`truncateLine`/`lineToAnsi` from
   `src/sumo-tui/render/primitives.js`):

   ```ts
   export function renderSubagentStatusRow(options: {
   	readonly width: number;
   	readonly running: readonly { id: string; roleId?: string; title: string; ageMs: number }[];
   	readonly queuedCount: number;
   }): string[]
   ```

   One line, lowercase voice (match `src/voice.ts` tone), truncated to
   width, e.g.:
   `◈ subagents · sa-2 research 4m · sa-5 implement-cheap 40s · 1 queued`.
   Role id when present, else a bounded title prefix. No animation ticker —
   static glyph; re-render is driven by manager change events (age drift
   between events is acceptable; do NOT add a timer just for ages).
2. Wire it in `installSubagents` (`src/subagents/index.ts`) — it already has
   `latestContext` and the manager change listener. In `onManagerChange`
   (and on `session_start`): compute running + queued snapshots; when
   non-empty and `latestContext?.hasUI`, call
   `ctx.ui.setWidget("sumocode-subagents", factory, { placement: "aboveEditor" })`;
   when the count drops to zero, clear with `undefined` (compaction pattern,
   `src/compaction-indicator.ts:118–136`). Clear on `session_shutdown` too.
   The widget must NEVER appear when there are zero running/queued subagents
   — an empty ambient strip is chrome noise.
3. TTY/RPC defensiveness: guard every call behind `ctx.hasUI`; never throw
   from the listener (wrap the setWidget call — a UI failure must not break
   settlement delivery).

**Verify**: `pnpm vitest run src/subagent-status-row.test.ts src/subagents/index.test.ts`
→ pass (renderer: truncation, zero-queued omits queue segment, role fallback
to title; index: widget set on spawn, cleared when last child settles, never
set without UI). Manual smoke in BOTH runtimes: `bin/sumocode.sh -d .` (owned
shell) and the RPC cathedral shell — spawn a subagent, confirm the strip
appears above the editor and disappears on settlement. If the widget does
not surface in RPC mode, STOP and report (do not improvise a shell-adapter
mirror — that is plan-022 territory).

### Step 7: Full battery + index

Run the full battery. Because Step 6 adds chat-window chrome, also run the
visual contract: `pnpm visual:ci` — if the subagent strip changes any
existing golden, STOP and report (the strip should only add a widget row
while subagents run; goldens are captured with none running). Then update
`plans/README.md`: add row
`| 083 | Role-based fire-and-forget subagents | P2 | L | — | <status> |` in
the subagents section (after the 079–082 rows).

**Verify**: `pnpm exec tsc --noEmit && pnpm build && pnpm test` → exit 0;
`pnpm test:integration` → pass (the known single PTY-concurrency flake is
acceptable if it passes in isolation); `pnpm visual:ci` → green (required
because Step 6 adds chat-window chrome — goldens are captured with zero
subagents running, so the strip must cause no drift).

## Test plan

- `src/subagents/roles.test.ts` (new): built-ins well-formed (unique ids, all
  six present, tools ⊆ BUILT_IN_TOOLS, no built-in sets a model); merge
  semantics (field override, new role requires prompt+label, invalid entries
  skipped with warnings, >256 KB rejected, bad JSON falls back);
  `"model": "inherit"` normalizes to undefined; `resolveRolesPath` honors
  `PI_CODING_AGENT_DIR`.
- `src/subagents/tools.test.ts` (extend): role resolution precedence;
  narrowing-only tool intersection; unknown-role inline error; queued spawn
  message; new spawn copy contains "END YOUR TURN" semantics and not
  "block for it".
- `src/subagents/manager.test.ts` (extend): queue FIFO lifecycle, cancel of
  queued, queue-full at_capacity, dequeue serialization (two settles, one
  queued task → starts once). Model after the existing fake-backend tests in
  that file.
- `src/subagents/index.test.ts` (extend): queued snapshot not delivered.
- `src/subagents/backend-pi.test.ts` (extend): append-system-prompt arg
  placement; `src/subagents/backend-pane.test.ts`: preamble in prompt file.
- `src/activity/subagent-adapter.test.ts` (extend): queued mapping.
- `src/commands/roles.test.ts` (new): model after `src/commands/persona.test.ts`.
- `src/subagent-status-row.test.ts` (new): model after
  `src/compaction-status-row` tests — width truncation, segment composition,
  zero-queued omission, role-id fallback.
- `src/subagents/index.test.ts` (extend): widget lifecycle — set while
  running/queued, cleared at zero, cleared on shutdown, no-op without UI.

## Done criteria

ALL must hold:

- [ ] `pnpm exec tsc --noEmit && pnpm build` exits 0
- [ ] `pnpm test` exits 0; all new tests listed above exist and pass
- [ ] `grep -rn "block for it" src/subagents/` → no matches
- [ ] `subagent_spawn` accepts `role`; `pi` headless spawn args include
      `--append-system-prompt` iff the resolved role has a system prompt
- [ ] 5th concurrent spawn returns a `queued` snapshot, not `at_capacity`;
      queue-full still returns `at_capacity`
- [ ] `rg -n '=== "running"' src/subagents src/activity` — every remaining
      match is provably queued-safe (comment or test)
- [ ] `/roles` lists six built-in roles and writes only a sparse overlay to
      `~/.pi/agent/sumocode/roles.json`; nothing role-related is written
      inside the repo
- [ ] Every role's model is editable via `/roles`, with `inherit` offered as
      an explicit choice; `"model": "inherit"` in `roles.json` resolves to
      parent-model inheritance at spawn
- [ ] The `sumocode-subagents` widget appears above the editor iff ≥1
      subagent is running or queued (owned shell verified; RPC verified or
      STOP-reported), and clears on settlement and shutdown
- [ ] `pnpm visual:ci` green (no golden drift from the strip)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts don't match the live code (drift).
- `pi --append-system-prompt` combined with `--mode json -p` errors or is
  ignored (verify once manually:
  `pi --mode json -p --no-session --no-extensions --append-system-prompt "reply with the word banana" "what word?"`
  → output contains banana). If it fails, STOP — do not fall back to prompt
  concatenation for headless children without operator sign-off.
- Queued-status changes require touching `src/sumo-tui/` rendering to avoid
  a broken UI — that is out of scope; report what renders wrong instead.
- The dequeue path deadlocks or double-starts under test — report rather
  than adding locks beyond the serialized-tail pattern.
- `registerCommand("sumo:roles")` does not appear in the command palette —
  investigate `src/command-palette.ts` read-only and report; do not modify it.
- The `aboveEditor` widget does not render in the RPC cathedral shell —
  report; do not add a shell-adapter mirror or touch `src/sumo-tui/`.
- `pnpm visual:ci` shows golden drift from the strip — report; never promote
  goldens (repo rule).

## Maintenance notes

- **Visible-child asymmetry**: visible children get the role prompt as a
  prompt-file preamble, not a true system prompt. Follow-up (deferred): add
  `--append-system-prompt` to `sumocode task` (`src/task-mode.ts`) and thread
  it through `buildVisibleAgentCommand`.
- **No built-in role hardcodes a model** (all inherit until the operator sets
  one via `/roles`) — deliberate: hardcoding model names in a public repo
  rots and leaks preference into the wrong layer. implement-cheap only
  becomes "cheap" once the operator assigns it a cheap model.
- **Queue vs. shutdown**: queued tasks die with the session like running
  children (plan 065's no-durable-registry deferral). If a durable registry
  lands, the queue must be persisted too.
- **Reviewer scrutiny**: the `isSettled` redefinition (Step 4) is the
  highest-risk hunk — every consumer of "not running" semantics changed
  meaning. Check the grep audit in the PR description.
- The role system deliberately does not gate WHICH role may use worktrees or
  visibility — roles set defaults, calls may override. Revisit if roles ever
  become a security boundary (they are not one today).
- **Deferred, operator-requested (2026-08-25): raise `MAX_RUNNING` 4 → 10.**
  Apply AFTER this plan's first execution round is reviewed and merged — a
  mid-flight constant change would invalidate the queue tests being written
  against capacity 4. When applying: (1) change the constant in
  `src/subagents/manager.ts`; (2) make every model-facing mention of the
  capacity DERIVE from `MAX_RUNNING` (the prompt-guidelines bullet currently
  hardcodes "At most 4"); (3) re-check queue tests that spawn to capacity —
  they should reference the constant, not the literal 4 (flag in review if
  the executor hardcoded it); (4) consider whether `MAX_QUEUED` (16) should
  scale too. Trade-off to accept knowingly: 10 concurrent children multiply
  provider cost and machine load; the queue already absorbs bursts, so the
  bump buys parallelism, not correctness.
- **Deferred, from omp recon** (see Design grounding):
  - *Model-role aliases*: let `roles.json` model values reference a named
    mapping (e.g. `"@cheap"` → `modelAliases.cheap`) so one edit repoints
    every role sharing the alias. Adds a second config surface — wait until
    the operator actually has 3+ roles pinned to the same model.
  - *Agent Hub-style roster overlay*: full-screen subagent roster (status,
    model, age, usage, steer/cancel per row) as the strip's drill-in. The
    strip is the count-and-glance layer; a Hub is its natural v2 once
    role-based delegation is in daily use.
  - *Per-role `blocking` flag* was considered and REJECTED: whether to wait
    is the caller's per-task decision (`subagent_wait`), not a property of
    the role — a blocking-by-definition role would quietly reintroduce the
    synchronous behavior this plan removes.
