# Prime Agent → SumoCode: strategic synthesis

**Date:** 2026-08-06  
**Question:** Which Prime Agent mechanisms should SumoCode adopt without becoming a Prime Agent fork?  
**Primary-source baseline:** Prime Agent commit [`0e0d233`](https://github.com/PrimeIntellect-ai/prime-agent/tree/0e0d23391bcd879f1aea70dbda4d07dda7970b34); SumoCode working tree at local commit `9f70b8e`.

## Answer first

SumoCode should adopt Prime Agent's **control-plane disciplines**, not its execution engine.

The highest-leverage imports are:

1. **Addressable context objects.** Keep large transcripts, tool outputs, repository snapshots and child artifacts behind stable handles with bounded `meta`, `slice`, `search`, `map`, `reduce` and `materialize` operations. This captures the RLM paper's strongest mechanism without requiring Python.
2. **Durable goals with explicit completion and budgets.** A goal should survive ordinary turns and only finish through an explicit completion transition.
3. **Evidence-gated autonomous continuation.** Continuation should be bounded by turns, tokens, time, and project quality gates—not by the model saying it is done.
4. **A reviewable refinement ledger.** Extend Memory Scriptorium into proposals with evidence, scoped edits, history, and rollback; never allow the agent to rewrite the immutable base persona automatically.
5. **Normalized subagent handles now; retained identity through Pi upstream.** SumoCode already has typed snapshots, worktree isolation, completion manifests, visible panes, wait/cancel/list, and visible-child steering. Improve local observability now, but require public Pi APIs for durable child registries, stable messaging, restored identity, and authoritative usage.
6. **Attachable execution as a later architectural option.** Prime Agent's daemon/worker split is valuable only if users genuinely need work to continue after the terminal closes. It is not a small extension feature.

Do **not** replace Pi's typed tool model with a persistent IPython-only interface. Context objects are an architectural primitive worth prototyping; a persistent REPL is only one implementation and should remain a measured spike.

## What Prime Agent actually ships

### Client/execution separation

Prime Agent separates the client, daemon supervisor, per-root-session worker, `AgentSession`, scheduler, and IPython kernels. The client owns presentation while the supervisor and worker own execution and recovery ([architecture.md lines 3–49](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/docs/architecture.md#L3-L49)). Closing the UI detaches it; the resident worker continues to own the queue, schedules, root session, kernel, and descendants ([long-running-agents.md lines 43–69](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/docs/long-running-agents.md#L43-L69)). The process boundary is lifecycle containment, not a security sandbox.

### Programmatic RLM surface

Prime Agent exposes one built-in model tool, `ipython`. Files, shell commands, skills, and delegation begin in a persistent kernel; Python state survives tool calls and compaction ([rlm.md lines 27–51](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/docs/rlm.md#L27-L51)). Recursive children are admitted through a typed Jupyter `host.request`, but the TypeScript host remains authoritative for provider calls, session state, child lifecycle, scheduling, and policy ([rlm-runtime.md lines 3–32](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/docs/rlm-runtime.md#L3-L32)).

An RLM spawn returns an admission handle immediately, never the answer. Results arrive later through explicit messages or files ([rlm-runtime.md lines 149–183](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/docs/rlm-runtime.md#L149-L183)). This is a sound orchestration contract independent of IPython.

The original RLM paper frames long prompts as variables in a REPL and lets the model inspect or recursively process slices rather than placing the entire prompt directly into every model context ([Zhang, Kraska & Khattab, *Recursive Language Models*, arXiv:2512.24601](https://arxiv.org/abs/2512.24601)). That supports a long-context research hypothesis; it does not by itself prove that an IPython-only interface improves ordinary coding-agent work.

### Persistent goals and bounded continuation

Prime Agent's goal state records status, objective, token budget, tokens used, elapsed time, and continuation count. Only explicit `goal.complete()` represents success; nearing a budget is not completion ([goals.ts lines 10–37, 207–250](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/goals.ts#L10-L37)). Its autonomous mode is separate: it injects bounded continuations until gates pass or a turn/token/time limit is hit; failed gate output is returned for another attempt ([long-running-agents.md lines 199–226](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/docs/long-running-agents.md#L199-L226)).

This separation is the strongest product idea in the repo:

- **Goal:** what remains true across turns.
- **Continuation policy:** whether another turn should be injected.
- **Quality gate:** what external evidence allows stopping.

### Continual Harness

Prime Agent's refinement state supports four supplemental entry kinds—prompt, memory, skill, and subagent—and records evidence, expected outcome, versions, before/after snapshots, local/global scope, and rollback metadata ([refinement.ts lines 21–102](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/refinement/refinement.ts#L21-L102)). Its base system prompt is explicitly immutable; refinement edits supplemental state only ([refinement.ts lines 123–173](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/refinement/refinement.ts#L123-L173)). State writes use temp-file plus rename, and global refinement history is append-only for cross-session rollback ([refinement.ts lines 345–399](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/refinement/refinement.ts#L345-L399)).

The cited Continual Harness paper is [arXiv:2605.09998](https://arxiv.org/abs/2605.09998). The implementation's conservative boundary matters more than the label: small evidence-backed edits, scoped stores, immutable base prompt, recorded history, rollback.

## What SumoCode already has

SumoCode is not starting from zero.

### A real client/runtime seam

The interactive process is already a retained foreground RPC host. It launches Pi in `--mode rpc`; Pi owns the model/agent loop while SumoCode owns rendering and editor input (`src/sumo-tui/rpc/host.ts:614–697`, `src/sumo-tui/rpc/runtime.ts:163–223`). This resembles Prime Agent's client/execution boundary, but execution remains a child of the terminal host. Therefore the missing capability is **detachment and reattachment**, not separation itself.

### A mature subagent control plane

`SubagentManager` already owns capacity, snapshots, worktree isolation, placement, lifecycle folding, wait/cancel, completion evidence, and pruning (`src/subagents/manager.ts:127–175`, `157–319`, `463–589`). Its typed snapshot records identity, status, transcript, live tools, usage, worktree, pane, session path, and completion manifest (`src/subagents/domain.ts:3–73`).

The model-facing surface already includes:

- `subagent_spawn`
- `subagent_send` for visible children
- `subagent_check`
- `subagent_wait`
- `subagent_cancel`
- `subagent_list`

(`src/subagents/tools.ts:89–265`).

The key limitation is structural: headless children are one-shot Pi subprocesses whose stdin closes immediately (`src/subagents/backend-pi.ts:281–330`), so they cannot receive structured follow-ups. Visible-child steering currently writes to a terminal pane (`src/subagents/tools.ts:156–180`), which is useful but not a durable agent protocol.

### Evidence already exists

When a child settles, SumoCode builds a bounded completion manifest before publishing the terminal snapshot (`src/subagents/manager.ts:540–589`). That is the natural substrate for quality gates and evidence-based continuation. Prime Agent's strongest autonomy idea can therefore be added without importing its RLM runtime.

### Durable state primitives already exist

The activity store already uses private per-session state, ownership validation, atomic writes, and cross-process locks (`src/activity/persistence.ts:24–35`, `160–204`, `206–267`, `386–468`). This is a safer foundation for goals/refinement records than inventing another casual JSON file format.

## Recommended import plan

### Tier 1 — build now

#### 1. Goal Ledger

Add a session-owned `GoalState` with objective, status, budget, usage, continuation count, timestamps, and last evidence. Expose `/sumo:goal` plus a narrow `goal_complete` tool. Persist through the existing private activity-state conventions or Pi custom entries.

**Rule:** ordinary assistant text never marks success. Completion must be an explicit transition and must include evidence references.

#### 2. Quality-gated continuation

Add an opt-in `/sumo:autonomous` policy that can inject a follow-up only while a goal is active and within hard limits. Gates should be declared commands such as `pnpm test`, `pnpm typecheck`, or project-defined scripts. Store command, exit code, bounded output hash/tail, workspace revision, and timestamp.

Avoid rerunning an unchanged failed gate. Stop on budget/time/turn limits with status `budget_limited`, not `complete`.

#### 3. Refinement proposals, not silent self-editing

Extend Memory Scriptorium with a **Refinement Ledger**:

- source trajectory/evidence;
- proposed create/update/delete;
- scope: session, project, or personal;
- before/after snapshots;
- expected outcome and validation;
- accept/reject/rollback.

Automatic review may create a proposal. Applying global or executable changes should remain user-controlled. The persona/base system prompt remains immutable.

### Tier 2 — build after Tier 1 proves value

#### 4. Retained headless agents and structured messaging — upstream Pi request

Do not emulate retained sessions in SumoCode. Request public Pi contracts for stable child-session identity, parent/child messaging, restoration after resume, authoritative usage attribution, and tombstones. Preserve the current `SubagentSnapshot` contract as Sumo's presentation adapter. Terminal keystrokes and JSONL scraping are not durable agent protocols.

#### 5. Usage attribution

Attach child token/cost usage to the parent turn that admitted it while retaining separate child accounting. Prime Agent does this explicitly ([rlm-runtime.md lines 195–205](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/docs/rlm-runtime.md#L195-L205)). SumoCode already captures child usage in snapshots (`src/subagents/domain.ts:68`; `src/subagents/manager.ts:510–520`).

### Tier 3 — architectural decision, not feature work

#### 6. Detachable root execution

If field use proves that sessions must survive terminal closure, ask Pi upstream for a resident/attachable RPC lifecycle or externally supervised session API. Do not introduce a Sumo-owned supervisor behind Pi's back: that would make SumoCode a second agent runtime. Until the need is proven, SumoCode's current foreground RPC boundary is simpler and safer.

## Explicitly reject or spike

### Reject: wholesale Prime Agent fork

SumoCode's differentiation is the experience layer and a small Pi integration surface. Importing Prime Agent wholesale would replace Pi ownership, duplicate its TUI/harness, and turn SumoCode into a second full agent runtime.

### Spike only: persistent REPL / context-as-variable

A persistent kernel could help with huge logs, datasets, repository maps, or repeated transformations. But SumoCode should first benchmark an optional `workspace_eval`/notebook capability against Pi's normal tools on:

- total input/output tokens;
- wall time;
- success rate;
- context-compaction count;
- unsafe or irreproducible state failures.

If it wins, ship it as an optional capability. Do not make every file read and shell command pass through IPython.

### Defer: schedules and heartbeats

They become compelling only when root execution survives UI detachment. Before that, they create a false promise: a schedule cannot reliably wake an agent whose owning terminal process is gone.

## Decision table

| Prime mechanism | SumoCode decision | Why |
|---|---|---|
| Persistent goals | **Adopt now** | Small state machine; high completion discipline |
| Bounded autonomous gates | **Adopt now** | Existing completion manifests and RPC queue provide seams |
| Continual Harness ledger | **Adapt now** | Strong fit with Memory Scriptorium; require proposals and rollback |
| Native child handles | **Already present** | Improve durability and attribution, do not replace |
| Direct agent messaging | **Extend** | Visible steering exists; headless structured follow-up does not |
| Daemon-backed root worker | **Defer** | Valuable but architectural; needs attach/recovery protocol |
| Persistent IPython-only tools | **Do not adopt wholesale** | Unproven for normal coding; conflicts with Pi typed-tool foundation |
| Heartbeats/schedules | **Defer with daemon** | Without detached execution they are not reliable |

## Bottom line

Prime Agent's best lesson is not “put Python under the model.” It is: **separate durable intent, continuation policy, evidence, and reusable state into explicit typed mechanisms.** SumoCode already has enough runtime and orchestration structure to import those mechanisms incrementally. The strategic move is to deepen its existing seams—goal ledger, evidence gates, refinement history, retained child identity—while preserving Pi as the agent loop and SumoCode as the owned experience/control layer.
