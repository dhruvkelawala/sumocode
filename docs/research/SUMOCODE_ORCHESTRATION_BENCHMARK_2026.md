# Research: SumoCode orchestration benchmark (July 2026)

> **Scope and method.** Snapshot dated **2026-07-14**. This review uses only vendor documentation and vendor-owned source repositories. “Documented” means the linked primary source explicitly describes the behavior; “Inference” is an interpretation for SumoCode, not a vendor claim. Documentation pages without a displayed publication date are marked **living docs**. Product details that are preview/experimental are called out because they are especially volatile.

## Summary

The strongest current orchestrators combine four things that are often treated separately: **isolated worker context, an explicit control plane, isolated code state, and durable human-visible results**. Claude Code has the richest peer-team coordination model (subagents plus experimental Agent Teams, task dependencies, mailboxes, lifecycle hooks); Codex has the broadest end-to-end parallel-work surface (CLI subagents, app worktrees, cloud tasks, automations and review); **Oh My Pi has the most integrated local subprocess-worker design found in this review** (bounded async jobs, typed yields, workspace isolation, durable `agent://`/`history://` artifacts, live-to-parked lifecycle and IRC follow-ups); GitHub Copilot coding agent has the clearest repository-native trust and audit boundary. Cursor supplies a particularly legible “one agent, one machine/worktree/branch” cloud UX.

For SumoCode, the transferable minimum is not merely a `task` tool. It is a typed task record with parent/child identity, dependency and budget fields; bounded parallelism; explicit worker states and events; a resumable result/artifact envelope; conflict-safe worktree policy; and notification/approval policy that remains owned by the parent UI. No reviewed product fully solves dependency-aware scheduling, resource backpressure, crash recovery, merge arbitration, and unified observability at once.

## Findings

### 1. What “OMP” means here

1. **The evidence supports interpreting OMP as Oh My Pi.** The official repository is titled **Oh My Pi**, describes itself as an AI coding agent, and uses `omp` as its product/CLI identity. The acronym alone is ambiguous in the wider software ecosystem, but in a Pi/terminal-coding-agent benchmark this is the direct, first-party match. [Oh My Pi repository](https://github.com/can1357/oh-my-pi)
2. **Do not conflate Oh My Pi with OpenCode, OpenAI’s Codex, or upstream Pi.** Oh My Pi is a distinct fork/product repository. Its source is the authoritative evidence for its bundled tools and runtime; claims below are intentionally limited where the repository does not publish a stable orchestration contract. [Oh My Pi source tree](https://github.com/can1357/oh-my-pi/tree/main/packages/coding-agent)

### 2. Claude Code: strongest explicit in-session coordinator

3. **Subagents are context-isolated workers with configurable capabilities.** A subagent has its own context window, system prompt, tool access and model; it returns a result to the caller rather than adding its entire transcript to the parent. Definitions can be project- or user-scoped, and the parent can invoke them automatically or explicitly. This is the cleanest documented form of delegation as a reusable role API. [Claude Code subagents, living docs](https://code.claude.com/docs/en/sub-agents)
4. **Foreground and background execution have different intervention/trust semantics.** Foreground subagents block the main conversation and can surface permission or clarification interactions; background subagents run concurrently, cannot ask interactive questions in the same way, and require permissions to be settled up front. Claude Code supports resuming a subagent, preserving its prior context rather than starting over. [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
5. **Agent Teams add a real coordination plane, not just parallel tool calls.** The experimental feature creates a team lead plus independent teammates, each with a separate context. They share a task list, can claim work, can express task dependencies, and can message one another through a mailbox. Users may interact with teammates directly; the lead remains responsible for coordination and synthesis. [Claude Code Agent Teams, experimental, living docs](https://code.claude.com/docs/en/agent-teams)
6. **Team lifecycle and limits are explicit.** The lead creates the team, assigns or lets workers claim tasks, requests teammate shutdown, and cleans up the team. The docs call out constraints including one team per session and no nested teams; teammates do not automatically inherit the lead’s conversation context. Agent Teams are token-expensive because each teammate is a separate Claude instance. [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)
7. **Hooks expose orchestration events to external policy and notification systems.** Claude Code documents lifecycle hooks including `SubagentStart`, `SubagentStop`, `TeammateIdle`, `TaskCompleted`, and `Notification`, with hook matchers and command/HTTP/prompt/agent handlers depending on the event. This enables deterministic logging, quality gates, notifications, and blocking decisions outside the model’s prose. [Hooks reference, living docs](https://code.claude.com/docs/en/hooks) [Hooks guide](https://code.claude.com/docs/en/hooks-guide)
8. **Background shell work is user-visible and recoverable within the session UX.** Commands may be moved to the background, the user can continue working, and task output can be revisited from the interactive task controls. Completion notifications and the `Notification` hook provide both in-terminal and external notification seams. [Interactive mode, living docs](https://code.claude.com/docs/en/interactive-mode) [Common workflows](https://code.claude.com/docs/en/common-workflows)
9. **Important boundary:** separate contexts are not separate filesystems. Claude’s subagents/teammates operating in the same checkout can collide unless the workflow itself provisions worktrees or partitions files. Agent Teams documents coordination, but not automatic per-worker git worktree isolation. **Inference:** SumoCode should not equate context isolation with write isolation.

### 3. OpenAI Codex: strongest parallel execution and code-isolation portfolio

10. **Codex CLI multi-agent is a parent-controlled delegation API.** The experimental multi-agent feature lets Codex spawn specialized agents in parallel, send them follow-up input, wait for results, and close them. Roles are configurable, and the parent agent coordinates/synthesizes returned work. Configuration includes limits such as concurrent threads and nesting/depth, making capacity a first-class runtime concern rather than prompt advice. [Codex multi-agent, living docs](https://developers.openai.com/codex/multi-agent)
11. **The CLI exposes worker status rather than hiding all activity behind one spinner.** The multi-agent documentation describes inspecting agent activity/status and waiting on worker completion. The control model is closer to a bounded worker pool than an autonomous peer team: child-to-child coordination and a shared dependency graph are not documented. [Codex multi-agent](https://developers.openai.com/codex/multi-agent)
12. **The Codex app makes git worktrees a product primitive.** Threads can operate in isolated worktrees so agents work on the same repository without sharing a mutable checkout. Users can review changes and move/apply work back to their local branch. This directly addresses edit collision and makes each task’s patch a durable artifact. [Codex app worktrees, living docs](https://developers.openai.com/codex/app/worktrees)
13. **Local, background, and cloud work share a review-oriented app surface.** OpenAI positions the Codex app as a command center for multiple agents running in parallel, with separate threads and worktrees, reviewable diffs, and skills/automations. The launch post is dated **2026-02-02** and therefore represents the 2026 app generation rather than the original 2025 cloud preview. [Introducing the Codex app, 2026-02-02](https://openai.com/index/introducing-the-codex-app/)
14. **Cloud tasks provide durable remote execution.** A Codex cloud task runs in an isolated environment associated with a repository, executes setup/configuration, and produces changes that can be reviewed and turned into a pull request. Network access is configurable/restricted, separating execution capability from the repository approval boundary. [Codex cloud, living docs](https://developers.openai.com/codex/cloud) [Codex security](https://developers.openai.com/codex/security)
15. **Automations supply persistence and an inbox, but are not a general DAG scheduler.** Codex app automations run prompts on a schedule in the background, with results surfaced for review. They are useful for repeated maintenance and recovery from “user is not watching,” but the docs do not describe arbitrary inter-task dependencies, merge arbitration, or transactional restart of a multi-agent graph. [Codex automations, living docs](https://developers.openai.com/codex/automations)
16. **Trust is layered by execution venue.** Local CLI/app permissions and sandboxing differ from cloud environment/network policy; a generated patch or PR remains a review artifact rather than implicit authorization to merge. [Codex security](https://developers.openai.com/codex/security)

### 4. Oh My Pi (OMP): strongest integrated local-worker mechanics

17. **Oh My Pi is source-led, but it now publishes a detailed task-tool contract.** At pinned commit [`3047c27`](https://github.com/can1357/oh-my-pi/commit/3047c27c332c5629c8e063283d349384c10c9a56) (repository version 16.5.0), `task` supports one worker or a `tasks[]` batch, synchronous or async execution, per-item agent roles, and a session-scoped semaphore. Each background spawn is registered as a job and streams coalesced progress into the original tool block; completion is injected into the parent conversation. [OMP task tool contract](https://github.com/can1357/oh-my-pi/blob/3047c27c332c5629c8e063283d349384c10c9a56/docs/tools/task.md)
18. **Results are typed, addressable artifacts rather than prose-only harvests.** A child must finish through a hidden `yield` tool; agent definitions can supply an output schema; `SingleResult` records status, duration, token/request counts, output paths, patch/branch metadata and extracted tool data. Full output is written behind `agent://<id>`, JSON fields can be addressed through the same URL, and a concise live or parked transcript is available through `history://<id>`. This is the most transferable OMP pattern for SumoCode. [OMP task outputs and artifacts](https://github.com/can1357/oh-my-pi/blob/3047c27c332c5629c8e063283d349384c10c9a56/docs/tools/task.md#outputs)
19. **OMP unifies task execution with an explicit worker lifecycle.** Non-isolated finished workers become `idle`, then park after an idle TTL while retaining a revivable session; `irc` messages can wake and continue them. Isolated workers are terminal because their workspace is merged and cleaned. The registry distinguishes `running | idle | parked | aborted`, while `job` provides wait/cancel for async execution. [OMP task flow](https://github.com/can1357/oh-my-pi/blob/3047c27c332c5629c8e063283d349384c10c9a56/docs/tools/task.md#flow) [OMP IRC](https://github.com/can1357/oh-my-pi/blob/3047c27c332c5629c8e063283d349384c10c9a56/docs/tools/irc.md) [OMP job](https://github.com/can1357/oh-my-pi/blob/3047c27c332c5629c8e063283d349384c10c9a56/docs/tools/job.md)
20. **Code isolation and resource limits are first-class.** `isolated: true` chooses from an isolation PAL (APFS/Btrfs/ZFS/reflink/overlay/ProjFS/copy fallback), captures a patch or commits a branch, and cleans the temporary workspace. Concurrency, recursion depth, soft request budget, wall-clock runtime, output bytes/lines and idle TTL are bounded settings. [OMP isolation and limits](https://github.com/can1357/oh-my-pi/blob/3047c27c332c5629c8e063283d349384c10c9a56/docs/tools/task.md#limits--caps)
21. **OMP still is not a dependency-aware peer team.** It has parent/child and IRC coordination plus a session todo list, but the reviewed contract does not expose Claude-Team-style task dependencies, self-claiming peers or a durable cross-restart DAG. Its process-global registry and parked sessions are strong local lifecycle primitives, not a repository-native audit boundary like GitHub PRs. **Inference:** SumoCode should borrow OMP’s job/artifact/lifecycle decomposition without copying its entire bundled harness.

### 5. OpenCode: simple role delegation with a useful permission model

22. **OpenCode separates primary agents from subagents.** Agents are configured with prompts, models, tools, descriptions and a `mode`; primary agents are directly selectable while subagents are invoked by the primary agent through the task tool or explicitly by the user. Built-in general-purpose and exploration roles demonstrate the pattern. [OpenCode agents, living docs](https://opencode.ai/docs/agents/)
23. **The task tool is the delegation seam.** It starts a subagent with a supplied description/prompt and returns the result to the caller, keeping exploratory work out of the parent context. Tool availability can be controlled per agent. The documented model is parent/child delegation, not a peer team with mailboxes or a shared DAG. [OpenCode tools, living docs](https://opencode.ai/docs/tools/)
24. **Permissions are explicit and pattern-addressable.** OpenCode supports `allow`, `ask`, and `deny` rules, including tool- and command-specific patterns; rules can be specialized by agent. This is a strong basis for least-privilege workers. [OpenCode permissions, living docs](https://opencode.ai/docs/permissions/)
25. **Client/server separation is a persistence and observability seam.** OpenCode documents a server API used by clients, making sessions/events addressable independently of a single terminal rendering process. However, the agent/task docs do not promise automatic per-child worktrees, task dependencies, bounded global concurrency, or crash-replay semantics. [OpenCode server, living docs](https://opencode.ai/docs/server/)

### 6. Adjacent solution A — Cursor: clearest isolated background-agent mental model

26. **Cursor cloud/background agents run remotely in isolated environments.** Each agent works against a repository in its own remote machine/environment and branch, can run commands, and produces reviewable code changes. Users can continue other work while it runs and later inspect/follow up on the result. [Cursor cloud agents, living docs](https://cursor.com/docs/cloud-agent)
27. **Parallelism is expressed as separate agents/workspaces, not a model-managed task graph.** Cursor’s app/product materials emphasize running multiple agents in parallel and isolating their changes with worktrees. This is excellent user-level concurrency and poor evidence for dependency-aware parent orchestration: no shared DAG or child mailbox is documented. [Cursor 2.0 announcement](https://cursor.com/blog/2-0) [Cursor worktrees](https://cursor.com/docs/configuration/worktrees)
28. **Remote execution makes trust controls crucial.** Cursor documents repository access and environment/security considerations for cloud agents. **Inference:** its easy parallel UX is transferable only if SumoCode also shows where code executes, what credentials/network it can use, and what action still requires human approval.

### 7. Adjacent solution B — GitHub Copilot coding agent: strongest repository-native audit/approval boundary

29. **Delegation is an issue/PR workflow.** A user assigns work to Copilot coding agent; it operates in an ephemeral GitHub Actions-powered environment, creates a branch and draft pull request, records progress, and requests review. The durable artifact is a normal GitHub PR with commits, logs, checks and conversation. [About Copilot coding agent, living docs](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)
30. **Intervention happens through familiar durable channels.** Users can follow the session and steer the agent via comments/follow-up instructions on the pull request/session. This is slower than direct terminal steering but survives client disconnects and gives reviewers an auditable history. [Track Copilot sessions, living docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/track-copilots-sessions)
31. **Trust boundaries are repository policy, not merely model prompts.** Copilot’s generated pull request is review-gated; branch protections, required checks, repository permissions and workflow restrictions continue to apply. GitHub documents security controls and limitations around workflows created/changed by the agent to reduce privilege escalation. [Coding agent security, living docs](https://docs.github.com/en/copilot/concepts/agents/coding-agent/coding-agent-security)
32. **Custom agents package role context and tools, while the platform remains task-oriented.** Repository-scoped custom agent profiles let teams specialize behavior. GitHub’s agent management surfaces multiple agent sessions, but the documented coding-agent model does not expose a parent-controlled child API, arbitrary dependency graph, or automatic multi-PR merge arbitration. [Custom agents configuration, living docs](https://docs.github.com/en/copilot/customizing-copilot/custom-agents/configuring-custom-agents-for-copilot-coding-agent)

## Capability matrix

Legend: **Yes** = first-class documented; **Partial** = possible or present with meaningful limits; **No doc** = not found in the reviewed official contract. “No doc” is not proof that an implementation has no internal support.

| Capability | Claude Code | Codex CLI/app/cloud | Oh My Pi | OpenCode | Cursor | GitHub Copilot coding agent |
|---|---|---|---|---|---|---|
| Parent delegation API | Yes: Agent/subagents | Yes: experimental multi-agent | **Yes: typed task/batch** | Yes: task tool | Partial: user launches agents | No: repository task, not child API |
| Context isolation | Yes | Yes | Yes | Yes | Yes | Yes |
| Shared task graph/dependencies | **Yes: Agent Teams** | No doc | No doc (todo phases only) | No doc | No doc | No doc |
| Worker lifecycle controls | spawn/resume/stop; team cleanup | spawn/send/wait/close | **spawn/job wait+cancel/IRC revive/park** | invoke/result | launch/follow up/stop UX | assign/steer/close PR |
| Typed lifecycle events/hooks | **Yes** | Partial: status/events | **Yes: event/progress/lifecycle + job details** | Partial: server/events | Partial: UI status | Yes: GitHub events/checks/logs |
| Mid-flight steering | parent/user; direct teammates | send input/app follow-up | **Yes: IRC to live/parked agents** | follow-up session/task | Yes | Yes, comments |
| Durable artifacts/results | transcript/result; weaker code isolation | **diff/worktree/cloud task/PR** | **typed yield + agent:// + history:// + patch/branch** | session/result | branch/diff | **branch/draft PR/logs/checks** |
| Automatic worktree/code isolation | No | **Yes in app** | **Yes: multi-backend isolated workspace** | No doc | Yes | Branch + ephemeral environment |
| Resource budgets/backpressure | Agent Teams limits/cost warning; limited budgeting | **thread/depth limits** | **concurrency/depth/time/request/output limits** | Permission controls, no scheduler budget | Product limits, no DAG budget | Platform quotas/actions limits |
| Persistence/recovery | Resume subagent; team/session limits | Cloud/app tasks and automations durable | Partial: idle→parked revival; process-local registry | Sessions/server seam | Remote agent/task history | **PR/session durable** |
| Observability UI | terminal task/team views + hooks | **multi-thread app/status/inbox** | **live progress + registry/Agent Hub + internal URLs** | clients/session UI | **agent dashboard/diffs** | **PR/session logs/checks** |
| User notifications | terminal + Notification hooks | app/inbox notifications | async result injection/job state | client/event seam | app/cloud notifications | GitHub notifications |
| Approval/trust boundary | permissions/sandbox/hooks | sandbox/network/review | scoped child tools + isolation; no repo review boundary | **allow/ask/deny patterns** | cloud credentials/review | **repo permissions/protections/review** |

## Transferable patterns for SumoCode

1. **Make delegation a typed protocol, not a clever prompt.** A task request should include `taskId`, `parentTaskId`, role, objective, context/artifact references, dependencies, allowed tools/paths, execution venue, budget and desired result schema. A result should include status, summary, artifacts, changed paths/commits, validation, residual risks and resumable worker identity. Claude/OpenCode demonstrate role/tool scoping; Codex demonstrates lifecycle operations.
2. **Separate three kinds of isolation in the UI.** Show distinct badges for **context** (separate model history), **process** (separate runtime/sandbox), and **code** (worktree/branch). Products frequently provide one or two, and users can otherwise assume all three.
3. **Use bounded execution.** Enforce global and per-parent concurrency, depth, token/time/tool-call budgets, output-size limits and cancellation propagation. Overflow policy must be explicit—cooperative reject-with-state is safer than a queue until liveness is proven. Codex’s thread/depth settings and OMP’s semaphore/budgets are useful starting points; none is a complete cross-engine budget system.
4. **Adopt a small durable state machine.** Suggested states: `queued → blocked → running → awaiting-input|awaiting-approval → succeeded|failed|cancelled|lost`, with attempt number and timestamps. Append typed events (`worker.started`, `progress`, `artifact.created`, `approval.requested`, `worker.completed`, `worker.lost`) to a session journal. Claude hooks and GitHub’s audit trail show why events outlive prose.
5. **Let the parent own synthesis, but let the user steer workers.** Parent-to-worker messages should be durable and ordered. The UI should allow inspect, message, pause, cancel, retry/resume, and “promote result to parent context.” Direct worker steering should be visible to the parent to prevent divergent plans.
6. **Treat patches as artifacts, not side effects.** Default write-capable parallel workers to worktrees; read-only researchers can share a checkout. Record base commit, worktree, changed paths and validation. Provide explicit apply/cherry-pick/merge/discard actions and detect overlapping write sets before synthesis.
7. **Dependencies need scheduler semantics.** A task with unmet dependencies stays `blocked`; failure policy must be explicit (`cancel descendants`, `continue`, or `ask`). Dynamic child creation should be depth- and fan-out-limited. Claude Teams proves the UX value of dependencies, but SumoCode should make transitions deterministic rather than relying on teammates to poll/claim correctly.
8. **Notifications should be policy-driven and deduplicated.** Terminal indicators are for progress; cmux/macOS notifications should fire on approval needed, failure/lost worker, and completion while unfocused—not every tool call. Include parent/task identity and a focus action. Claude’s Notification hook is the best direct analogue.
9. **Approval authority must not silently transfer.** Child workers may request privileges but should not broaden their own tool/network/path policy. Background workers that cannot interact must pause at `awaiting-approval`, not auto-deny ambiguously or inherit blanket approval. GitHub’s PR boundary and OpenCode’s patterned rules are good models.
10. **Recovery is a product feature.** On restart, reconcile journaled `running` workers with real processes/cloud jobs; mark missing workers `lost`; preserve logs/artifacts; offer retry from the same base or resume when supported. Never present a terminal-process PID alone as durable identity.

## Current SumoCode assessment

SumoCode is further along than its older v0.4 research notes imply. The current `BackgroundTaskManager` already has versioned metadata, startup recovery, real-exit completion, PID identity checks, log caps/GC, an agent capacity ceiling, cmux references, worktree tracking, passive notifications and opt-in parent wakes (`src/background-tasks/task-manager.ts`, `task-types.ts`, and `background-task-tool.ts`). `task-mode.ts` safely harvests the latest assistant response and distinguishes child exit from the first `agent_end`. The retained transcript already has a strong stable-ID delegation model for the native `task` tool (`src/sumo-tui/transcript/view-model.ts` and `controller.ts`).

The main deficit is **product fragmentation**:

- `subagent`, native `task`, shell `bg_task`, and visible-agent `bg_task` make the model choose among overlapping orchestration products.
- Each path has a different lifecycle, persistence, waiting, result and rendering contract.
- `bg_task` requires `list`/`log` polling and injects completion as prose user input.
- `response.md` is unstructured final prose rather than a trustworthy result artifact.
- Background state is not represented in the same retained task UI as native delegation.
- Worktrees exist, but there is no integrated result → diff → validate → apply/discard loop.
- Historical docs still describe already-fixed gaps, degrading future agent planning.

The target should be **one public task system**, not multiple executors plus routing guidance. Internal implementations may differ, but neither the model nor the user should know or choose between them.

## Recommended SumoCode sequence

### P0 — make `task` the only orchestration system

1. **One tool, one registry, one lifecycle.** Promote the existing `task` surface because it already owns Cathedral delegation rendering and single/parallel/chain semantics. Fold shell jobs and visible agents into the same task manager. Deprecate and then remove `bg_task`; disable the external `subagent` tool once required capabilities are native. Update private skills/config to call `task`.
2. **One system means one grammar and one delivery contract — not one mega-tool or one registry schema.** The strongest working reference reviewed is [davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup) (`extensions/subagents`, `extensions/background-terminals`, `extensions/workflows` and `extensions/subagents/docs/design-plan.md`). Its calls supersede the earlier `task`/`task_ctl` sketch:
   - **Verb-per-tool, no action enums anywhere.** `subagent_spawn/check/wait/cancel/list` and `terminal_start/check/wait/stop/list` are tiny single-purpose schemas. Agents and terminals stay separate domains — they differ genuinely (transcript/steering/harness vs process-group/stdout/exit, no stdin) — while using explicit lifecycle verbs.
   - **Auto-delivery with consumed-tracking is the waiting model.** Settled results go into a deferred buffer and flush when the parent is idle, delivered as a typed custom message (`customType: "subagent-result"`, `deliverAs: "followUp"`, `triggerTurn: true`) with its own collapsed-card renderer. `wait` marks results consumed to prevent double delivery; `check` peeks without consuming. Prompt guidance: keep working after spawn; block only when the result is required.
   - **A normalized event model replaces pane dependence.** Backends translate native streams into one `SubagentEvent` union; a manager folds events into per-child snapshots; a sync read-model feeds a dashboard plus a Takeover view (live transcript, streaming text, live tools, input line — steer while streaming, new run when idle, abort). For SumoCode’s retained renderer this in-app takeover surface largely obsoletes mandatory cmux panes; panes become optional views.
   - **Harness is a spawn axis.** `harness: "pi" | "claude" | "codex"` behind one backend interface (`spawn → { events, send, interrupt, awaitSettled }`, scoped teardown) with a shared `off→max` effort scale. Workers are not limited to child SumoCode sessions.
   - **Dynamic fan-out is a separate, user-gated escape hatch** (sandboxed `phase()/agent()/parallel()` workflow scripts with schema-validated structured outputs), not part of the everyday surface.
   SumoCode should keep its own advantages on top: durable registry/recovery across reloads, worktree isolation as a spawn option, structured completion manifests, and cooperative at-capacity responses instead of thrown cap errors.
3. **Use one identity and ownership model.** Every task gets a stable ID, `parentTaskId`, `groupId`, `ownerSessionId`, project/repository identity, owner lease and explicit orphan adoption. Eliminate the global-owner ambiguity in `$TMPDIR/sumocode-bg` before migration.
4. **Use one state machine and event journal.** `queued → starting → running → awaiting_input|awaiting_approval|interactive → completed|failed|cancelled|lost`, with typed progress/artifact/activity/takeover events. Bridge it across the RPC child/retained-host seam and deduplicate recovery delivery.
5. **Use one control API.** The same `task` tool handles `spawn`, `list`, `inspect`, `wait(any|all|id)`, cursor-based `tail`, `message`, `cancel`, `focus`, `retry`, and `clear`. Unsupported operations depend on task state/kind, not which tool launched it. Eliminate polling guidance.
6. **Use one completion manifest.** Agent tasks finish through a task-mode `yield_result`; command tasks produce the same envelope from host-observed process data. Include status, summary, artifacts, changed paths, base/head commits, validation, risks, next actions, duration/model/usage and transcript pointer. Host-derived git/process evidence overrides model claims.
7. **Use one scheduler and budget boundary.** One global/per-parent concurrency gate, cancellation tree, runtime/request/output/depth limits and cooperative at-capacity response. Do not add a queue until measured demand justifies it.
8. **Use one approval boundary.** Every task may request approval, but only the human can grant authority. Runtime completion events are typed machine messages, never fake user messages.

### P1 — make the single system usable

1. **One fleet UI.** Existing transcript scrolls remain task history; a compact `Ctrl+T` overlay shows every active/recent task with kind, state, activity, isolation, branch, model/cost, pane and attention reason. It must work without a sidebar in portrait.
2. **One production result loop.** Task result → diff → overlap detection → validation/review → apply/cherry-pick/discard → conflict/safe-prune state. Preserve human gates for push/PR/merge.
3. **One quality-gate mechanism.** Attach acceptance criteria to the task; completion is visibly incomplete when required evidence is absent.
4. **One follow-up model.** `message` continues an idle/revivable agent task; terminal tasks reject it clearly. Human pane takeover becomes `interactive`, not an invisible special case.
5. **One artifact namespace.** Give compact results addressable full outputs/transcripts, borrowing OMP’s `agent://`/`history://` principle.
6. **Correct documentation drift.** Mark old v0.4 findings historical/implemented and publish a generated current capability ledger.

### P2 — only after the single system is proven

- Dependency-aware groups/barriers and saved workflows inside `task`.
- Queueing/fair scheduling after measured capacity pain.
- Scheduled/context-resuming tasks and optional peer messaging.
- cmux layout balancing, resource metrics and remote/cloud execution backends.

### Explicit non-goals

- No separate model-facing `subagent`, `bg_task`, `job`, `workflow`, or `team` systems.
- No terminal-pane scraping as the lifecycle protocol.
- No automatic merge, push, PR, dirty-worktree prune, or delegated approval authority.
- No Claude-style autonomous peer team before the single parent/task model is reliable.

## Priority gaps in the market

- **Unified DAG + code isolation:** Claude documents dependencies but not automatic worktrees; Codex/Cursor provide worktrees but not a documented shared dependency graph.
- **Real resource accounting:** concurrency caps exist, but user-visible token/cost/time budgets, queue pressure and fair scheduling across parents remain weak.
- **Deterministic merge arbitration:** products expose diffs/PRs, yet overlapping worker patches still require human or parent-agent judgment.
- **Cross-restart local recovery:** cloud/PR systems are durable; local subprocess teams generally have weaker documented crash reconciliation.
- **Portable event contracts:** Claude hooks are strong but product-specific. A stable, typed event journal connecting terminal UI, cmux notifications, logs and external automation would differentiate SumoCode.
- **Trust-aware background UX:** most systems explain permissions and backgrounding separately. The UI should show *why* a worker is blocked, which capability it requests, and whether approval applies once, to that worker, or to the parent tree.

## Recommended SumoCode v1 orchestration contract

A focused v1 should expose only `task`: one durable registry, identity/ownership model, state machine, event journal, scheduler, control API, completion manifest, artifact namespace and fleet UI. Agent versus command, async versus blocking, pane versus headless, and shared checkout versus worktree are task properties. Migrate native task execution and current background-task durability behind that contract, then remove `bg_task` and the external `subagent` surface. Defer queues, peer teams, dependency DAGs and automatic merges until the single system is reliable.

## Sources

### Kept

- [Claude Code: Create custom subagents](https://code.claude.com/docs/en/sub-agents) — primary contract for context, configuration, foreground/background execution and resume.
- [Claude Code: Orchestrate teams of Claude Code sessions](https://code.claude.com/docs/en/agent-teams) — primary contract for experimental teams, task list/dependencies, mailbox and lifecycle.
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks) and [hooks guide](https://code.claude.com/docs/en/hooks-guide) — lifecycle, policy and notification event evidence.
- [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode) — task/background interaction UX.
- [Codex multi-agent](https://developers.openai.com/codex/multi-agent) — primary CLI delegation and limit configuration.
- [Codex app worktrees](https://developers.openai.com/codex/app/worktrees) — code-isolation workflow.
- [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/) — dated first-party description of the parallel-agent app.
- [Codex cloud](https://developers.openai.com/codex/cloud), [automations](https://developers.openai.com/codex/automations), and [security](https://developers.openai.com/codex/security) — durable execution, scheduled work and trust controls.
- [Oh My Pi official repository](https://github.com/can1357/oh-my-pi), pinned [task tool contract](https://github.com/can1357/oh-my-pi/blob/3047c27c332c5629c8e063283d349384c10c9a56/docs/tools/task.md), [IRC](https://github.com/can1357/oh-my-pi/blob/3047c27c332c5629c8e063283d349384c10c9a56/docs/tools/irc.md), and [job](https://github.com/can1357/oh-my-pi/blob/3047c27c332c5629c8e063283d349384c10c9a56/docs/tools/job.md) — identity plus version-pinned execution, lifecycle, artifacts, isolation and coordination evidence.
- [davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup) — working Pi reference implementation: multi-harness subagents with normalized event model and takeover UI (`extensions/subagents`, incl. `docs/design-plan.md`), background terminals with deferred typed result delivery (`extensions/background-terminals`), and gated sandboxed workflow fan-out (`extensions/workflows`).
- [OpenCode agents](https://opencode.ai/docs/agents/), [tools](https://opencode.ai/docs/tools/), [permissions](https://opencode.ai/docs/permissions/), and [server](https://opencode.ai/docs/server/) — role delegation, policy and session architecture.
- [Cursor cloud agents](https://cursor.com/docs/cloud-agent), [worktrees](https://cursor.com/docs/configuration/worktrees), and [Cursor 2.0](https://cursor.com/blog/2-0) — remote isolation and parallel-agent UX.
- [GitHub Copilot coding agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent), [session tracking](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/track-copilots-sessions), and [security](https://docs.github.com/en/copilot/concepts/agents/coding-agent/coding-agent-security) — repository-native execution, steering, artifacts and approval boundary.

### Dropped

- Vendor comparison blogs, third-party tutorials, Reddit/Hacker News posts and SEO “best agent” roundups — excluded because the task requires primary sources.
- Unofficial “OMP” expansions — excluded because they do not match the Pi coding-agent context or an official project identity.
- Benchmarks based only on subjective task success — excluded because this report evaluates orchestration contracts and UX, not model coding quality.
- Product claims visible only in social posts or unsourced screenshots — excluded as insufficiently stable or auditable.

## Gaps and evidence cautions

- Many cited pages are living documentation and expose no page-level publication date. The snapshot date is recorded, but exact feature-introduction dates cannot be stated confidently unless the source itself is dated.
- Preview/experimental behavior—especially Claude Agent Teams and Codex CLI multi-agent—can change without compatibility guarantees.
- Oh My Pi evidence is pinned to commit `3047c27` / repository version 16.5.0 because its fast-moving `main` branch and living tool docs can change. Exact behavior should be rechecked before implementation parity work.
- “No doc” entries mean no first-class promise was identified in the kept official sources; they are not proofs of nonexistence.
- This is a qualitative architecture/UX benchmark, not a latency, token-cost or task-success benchmark. A quantitative follow-up should pin product versions, repository fixtures, model settings and approval modes.

