# Prime Agent architecture: implementation findings and mechanisms transferable to SumoCode

**Research snapshot.** Prime Agent `0.7.0` at commit [`0e0d23391bcd879f1aea70dbda4d07dda7970b34`](https://github.com/PrimeIntellect-ai/prime-agent/tree/0e0d23391bcd879f1aea70dbda4d07dda7970b34), compared with SumoCode commit [`9f70b8e44843daa8ed20921495e168d611014514`](https://github.com/dhruvkelawala/sumocode/tree/9f70b8e44843daa8ed20921495e168d611014514). Findings below privilege executable source over README prose. “Shipped” means a source path is wired into the running agent; it does not mean every failure/recovery path was exercised in this research.

## Answers first

1. **Prime Agent is not “an LLM inside a notebook.”** Its durable unit is an `AgentSession`. Each session owns a persistent IPython kernel, transcript/session artifacts, goal and refinement state, and (in daemon mode) a process-isolated worker. The notebook kernel is a programmable control plane connected back to the TypeScript host by typed comm requests; policy and lifecycle remain host-side.
2. **Its RLM mechanism is full-agent recursion, not a single recursive model call.** `await rlm("task")` admits a child and returns a handle immediately. The child is another `AgentSession`, with its own kernel, session directory, tools, context, model selection, nested children, cancellation, and messaging. Results arrive asynchronously through direct agent messages or artifacts.
3. **“Context as a variable” is partly architecture and partly modeling practice.** The implementation gives the model a persistent Python namespace in which it can name, transform, and retain arbitrary values. It does **not** automatically place the entire user prompt or transcript in a canonical `context` variable. A child prompt is still an explicit string. The transferable mechanism is a persistent typed workspace plus compact handles—not a magical replacement for context windows.
4. **Long-running behavior is decomposed into distinct mechanisms:**
   - goals persist an objective and usage accounting and inject continuation context;
   - autonomous mode injects bounded continuations and optionally runs verifier commands;
   - cron/heartbeats persist future prompts and wake sessions;
   - daemon workers isolate and recover live sessions.
   Treating these as one “autonomy” feature would lose important semantics.
5. **`/refine` is the most reusable idea after the kernel.** It converts trajectory evidence into small create/update/delete edits over an explicit harness schema (`prompt`, `memory`, `skill`, `subagent`), supports session-local and global scopes, records rollback information, writes atomically, and rebuilds the system prompt. It does not self-modify Prime Agent source.
6. **SumoCode should transfer the contracts, not Prime’s stack wholesale.** SumoCode already has a foreground RPC seam, subprocess subagents, durable background-task records, activity projections, and persistent memory. The lowest-risk route is to add a session-scoped workspace service and an orchestration state store behind Pi extension tools, then add goals/refinement, and only later add a scheduler/daemon if restart-surviving unattended work is genuinely required.

### Recommended order for SumoCode

| Priority | Mechanism to transfer | Why now | Avoid copying yet |
|---|---|---|---|
| P0 | Session workspace + typed host bridge | Enables persistent variables, reusable handles, and future refinement without changing Pi’s agent loop | Prime’s ZeroMQ/Jupyter transport as a requirement |
| P0 | Durable orchestration record schema | SumoCode subagent snapshots are currently manager-memory, while terminal tasks already demonstrate safe persistence | A full daemon supervisor |
| P1 | Goal state machine + continuation hook | Small, auditable, and orthogonal to UI | Calling it autonomous scheduling |
| P1 | Harness state + `/refine` plan/apply/rollback | Converts repeated behavior into explicit inspectable state | Direct source or persona rewriting |
| P1 | Family-scoped agent inbox | Better coordination than terminal-pane keystrokes | Arbitrary all-to-all messaging |
| P2 | Persistent schedules/heartbeats | Only after ownership, wake-up, and idempotency are defined | In-process timers presented as durable |
| P3 | Per-session worker daemon | Needed only for crash isolation, passivation, and unattended recovery | Replacing SumoCode’s foreground RPC host immediately |

---

## 1. Actual runtime boundaries

### Shipped implementation

Prime Agent’s runtime separates four concerns:

```text
client / TUI / print mode
          │ public daemon protocol
          ▼
daemon supervisor
  worker catalog, routing, leases, restart/recovery, snapshots
          │ authenticated worker socket + private framing
          ▼
per-session daemon worker
  AgentSession(s), cron dispatch, transcript/session artifacts
          │ typed kernel comm requests
          ▼
persistent IPython kernel
  Python namespace, RLM helper, harness helper, skill imports
```

The architecture document describes an `AgentSession` as the central stateful object, but the stronger evidence is the daemon implementation. The supervisor starts a **detached daemon process per worker**, injects a random authentication token, stable active-session identity, supervisor socket, recovery/orphan journals, and session lease owner, persists a descriptor while the worker is still behind a startup gate, then authenticates and subscribes after creation succeeds ([`daemon-supervisor.ts:L2087-L2259`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/modes/daemon/daemon-supervisor.ts#L2087-L2259)). The worker-side daemon creates its own socket server and scheduler; ordinary on-disk sessions are deliberately **not** all restored at daemon startup ([`daemon-mode.ts:L524-L626`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/modes/daemon/daemon-mode.ts#L524-L626)).

This is more than client/server UI separation. The supervisor owns routing and recovery metadata; a worker owns mutating session state; a kernel owns Python execution state. The typed protocol codifies a large public command/event boundary rather than sharing `AgentSession` objects across processes ([`daemon-worker-protocol.ts:L1-L170`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/modes/daemon/daemon-worker-protocol.ts#L1-L170)).

### README/doc claim versus source

The README’s “background daemon” wording is accurate but underspecified. The shipped implementation is not one immortal process holding every session: it is a supervisor plus resident workers, persistent descriptors/journals, authenticated local sockets, startup fencing, and explicit recovery/passivation behavior. Conversely, the source explicitly says saved sessions are restored only through resume/agent views, not eagerly at worker start.

### Transfer to SumoCode

SumoCode already has one valuable half of this boundary: its interactive launcher runs Pi in RPC mode while a foreground host owns rendering and input ([`README.md:L111-L128`](https://github.com/dhruvkelawala/sumocode/blob/9f70b8e44843daa8ed20921495e168d611014514/README.md#L111-L128)). That is a **presentation/runtime seam**, not yet a durable agent supervisor. Preserve it.

Transfer these contracts first:

- stable `runtimeId`, `sessionId`, and owner identity are different fields;
- one mutation owner per session;
- commands have admission IDs and idempotency keys;
- workers publish snapshots/events, not internal objects;
- recovery metadata is persisted before a worker is declared ready;
- startup, ready, draining, passive, lost, and terminal states are explicit.

Do not add a daemon merely to host a Python process. A session workspace can initially be a child service owned by SumoCode’s RPC child profile. Add the supervisor only when unattended restart recovery or multi-client attachment is a product requirement.

---

## 2. Persistent IPython kernel

### Shipped implementation

`KernelManager` starts an external IPython kernel through `python -m prime_agent_runtime`, stores connection details in a private runtime directory, communicates over Jupyter ZeroMQ channels, waits for kernel readiness, executes multiple cells against the same process, and shuts down/cleans up explicitly ([`kernel/index.ts:L130-L195`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/kernel/index.ts#L130-L195), [`kernel/index.ts:L1078-L1199`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/kernel/index.ts#L1078-L1199)).

The `ipython` agent tool:

- rejects empty cells;
- executes against the persistent manager;
- relays stdout, stderr, rich display data, errors, and host-bridge messages;
- captures the cell source so RLM children can show their spawn origin;
- marks timeout/abort as tool failure while the kernel manager retains lifecycle authority ([`tools/ipython.ts:L44-L197`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/tools/ipython.ts#L44-L197)).

Prime also has an **optional namespace snapshot**, not full process checkpointing. It asks Python to select user variables that can be JSON encoded, excludes modules/callables/internal names, bounds the payload, and restores by executing generated assignments in a fresh kernel ([`kernel/state-snapshot.ts:L1-L196`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/kernel/state-snapshot.ts#L1-L196)). Open sockets, iterators, class instances, imported module state, and arbitrary Python objects are not durably snapshotted.

### Persistent RLM environment

The runtime package injects helpers such as `rlm`, `agent_message`, `goal`, `refine`, and harness access into the kernel environment. Python calls do not directly mutate host state. They send typed request payloads over a comm bridge, and `AgentSession` installs the corresponding handlers ([`agent-session.ts:L8660-L8762`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/agent-session.ts#L8660-L8762)). This keeps recursion limits, model auth, session state, messaging reach, scheduling, and refinement policy in TypeScript.

### Transfer to SumoCode

The transferable abstraction is:

```ts
interface SessionWorkspace {
  execute(code: string, signal: AbortSignal): AsyncIterable<WorkspaceEvent>;
  requestHost<T>(method: HostMethod, payload: unknown): Promise<T>;
  snapshot(): Promise<JsonNamespaceSnapshot>;
  restore(snapshot: JsonNamespaceSnapshot): Promise<void>;
  dispose(): Promise<void>;
}
```

Implementation choices can be Jupyter, a long-lived Python JSON-RPC process, or a sandboxed JavaScript worker. Jupyter’s protocol is valuable if rich displays and scientific Python compatibility matter; it is not essential to the architecture. SumoCode should put a narrow allowlisted bridge in front of any host mutation and treat all workspace output as untrusted data.

---

## 3. “Context as a variable”

### What is actually shipped

The persistent Python namespace means this works across tool calls:

```python
requirements = parse(raw_spec)
failed_cases = []
child = await rlm(render_child_prompt(requirements, failed_cases), name="edge-audit")
```

The model can keep large values out of prose, refer to them by name, transform them incrementally, and pass only a compressed projection to a child. The kernel snapshot can preserve the JSON-safe subset across kernel replacement.

However, the source does **not** establish a canonical `context`, `prompt`, or transcript object in `user_ns`. `rlm.run` requires a concrete string `prompt`, validates kwargs, and forwards the spawning cell’s source only as metadata ([`rlm-runtime.ts:L150-L198`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/rlm-runtime.ts#L150-L198)). The Python helper also sends exactly the prompt supplied by the caller. Therefore:

- **shipped:** persistent named computational state;
- **shipped:** compact child handles and artifact paths;
- **model convention:** choosing what context to store and under which variable name;
- **not found:** automatic transcript-to-variable virtualization that removes context-window costs.

### Transfer to SumoCode

Do not market a workspace as infinite context. Instead, expose explicit primitives:

- `workspace.put(name, JSONValue | BlobRef)` and `workspace.get(name)`;
- immutable artifact/blob references for large values;
- a short per-turn inventory (name, type, size, updated time), not full values;
- optional provenance (`sourceMessageId`, `toolCallId`, hash);
- bounded, inspectable namespace snapshots.

The prompt should teach the model to keep raw evidence in workspace variables/artifacts and return distilled summaries to the conversation. This is an information-management discipline layered on persistence, not persistence alone.

---

## 4. RLM and subagents

### Shipped implementation

RLM is wired as a kernel-to-host request. `AgentSession` checks recursion depth, validates a sibling-scoped session name, resolves only authenticated models, creates a unique child artifact directory, records a queued run, and returns a `RlmSpawnHandle` ([`agent-session.ts:L9584-L9687`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/agent-session.ts#L9584-L9687)). Runtime creation is intentionally detached from the call: admission returns while startup and task execution continue ([`agent-session.ts:L9689-L9723`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/agent-session.ts#L9689-L9723)).

A child is a full `AgentSession`, not an LLM completion. It inherits a constrained set of models, active/allowed tools, custom tools, thinking level, service tier, goal/compaction capability, and incremented RLM depth ([`agent-session.ts:L8909-L8946`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/agent-session.ts#L8909-L8946), [`rlm-runtime.ts:L201-L242`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/rlm-runtime.ts#L201-L242)). The parent tracks live writing/tool activity, child usage attribution, session directory, completion and cleanup; the initial task is represented as a custom message with parent identity ([`agent-session.ts:L9724-L9837`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/agent-session.ts#L9724-L9837)).

If a child finishes without explicitly replying, the host sends a terminal notice and preview to the parent. This makes missing explicit communication observable rather than silently treating the child’s last prose as a synchronous return value.

### Contrast with SumoCode today

SumoCode already ships useful delegation mechanics:

- `subagent_spawn/check/wait/cancel/list`, bounded result delivery, model/thinking/tool inheritance, optional git worktrees, and visible terminal panes ([`subagents/tools.ts:L89-L265`](https://github.com/dhruvkelawala/sumocode/blob/9f70b8e44843daa8ed20921495e168d611014514/src/subagents/tools.ts#L89-L265));
- detached Pi subprocesses with JSONL event parsing, process-group cancellation, and a deliberate `--no-extensions` trust boundary ([`subagents/backend-pi.ts:L281-L390`](https://github.com/dhruvkelawala/sumocode/blob/9f70b8e44843daa8ed20921495e168d611014514/src/subagents/backend-pi.ts#L281-L390));
- an in-process manager for capacity, snapshots, worktree creation, waiting, cancellation, and completion manifests ([`subagents/manager.ts:L127-L319`](https://github.com/dhruvkelawala/sumocode/blob/9f70b8e44843daa8ed20921495e168d611014514/src/subagents/manager.ts#L127-L319)).

The key gap is lifetime and addressability: SumoCode’s authoritative child maps and IDs are manager-memory; headless children are one-shot subprocesses; `subagent_send` is limited to visible pane keystrokes. Prime children are durable agent sessions with stable family identity, host-routed inboxes, and artifact directories.

### Transfer design

Evolve without replacing the existing backend:

1. Persist an `AgentRunRecord` before spawn: stable UUID, parent ID, generation, task, cwd/worktree, model/tool policy, state, session file, artifact dir, and delivery cursor.
2. Keep `SubagentManager` as the live adapter, but rehydrate records and reconcile PIDs/session files on startup.
3. Add a host-routed inbox independent of terminal visibility.
4. Return an admission handle immediately; make completion a state transition/event, never an overloaded return value.
5. Preserve SumoCode’s process-group cancellation and worktree isolation—they are stronger implementation details than a naive in-process child.
6. Only promote a one-shot child to a resident agent session when follow-up messaging, nested delegation, or scheduled wake-up is requested.

---

## 5. Direct agent messaging

### Shipped implementation

Prime defines stable endpoints, sender identity, parent/sibling/child relationships, receipts, queued versus delivered state, and safety controls. Reach is explicitly limited to the agent family, with bounded message length, pending count, and token-bucket rate limits ([`agent-messages.ts:L7-L25`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/agent-messages.ts#L7-L25), [`agent-messages.ts:L112-L172`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/agent-messages.ts#L112-L172)). Family rosters are derived from parent identity and recursion depth, not merely arbitrary global names ([`agent-messages.ts:L200-L249`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/agent-messages.ts#L200-L249)).

Kernel helpers call host handlers. A child reply to its parent updates reply tracking, while observation APIs are separate read-only operations with bounded recent-message output ([`agent-session.ts:L8705-L8757`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/agent-session.ts#L8705-L8757)). This separation avoids using unrestricted transcript access as a messaging mechanism.

### Transfer to SumoCode

Add a durable `agent_inbox` store with:

- `messageId`, sender, receiver, relationship, body hash/body, created time;
- states `accepted → queued → delivered → acknowledged | failed`;
- receiver generation to prevent delivery to a reused local ID;
- an idempotency key for retries;
- family-scoped authorization and limits;
- `steer` versus `follow_up` as explicit delivery policy.

Reuse the Activity feed as a **projection** of message/run state, not as the source of truth. SumoCode’s activity store already has session binding, immutable snapshots, filesystem watch/poll reconciliation, bounded UI state, locks, and private atomic writes ([`activity/store.ts:L22-L177`](https://github.com/dhruvkelawala/sumocode/blob/9f70b8e44843daa8ed20921495e168d611014514/src/activity/store.ts#L22-L177), [`activity/store.ts:L239-L358`](https://github.com/dhruvkelawala/sumocode/blob/9f70b8e44843daa8ed20921495e168d611014514/src/activity/store.ts#L239-L358)).

---

## 6. Goals

### Shipped implementation

A goal is a session state machine: `idle`, `active`, `paused`, `budget_limited`, `complete`, or `error`, with objective, token/time usage, and continuation count ([`goals.ts:L4-L26`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/goals.ts#L4-L26)). Goal state is stored as custom session entries and restored when `AgentSession` is constructed; a CLI-provided initial goal only seeds a clean top-level branch ([`agent-session.ts:L1320-L1348`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/agent-session.ts#L1320-L1348)).

An active goal does not rely on the model remembering it. The host injects structured goal context and continues turns until completion or a terminal/budget condition. User input arrival epochs prevent a stale autonomous/goal continuation from racing with newly arrived human input ([`agent-session.ts:L3162-L3228`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/agent-session.ts#L3162-L3228)). Completion is a host transition invoked through `await goal.complete()`, preserving accounting ([`agent-session.ts:L3123-L3160`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/agent-session.ts#L3123-L3160)).

### Transfer to SumoCode

Implement goals before broad autonomy. It needs only:

- one persisted goal record per Pi session branch;
- explicit state transitions and accounting;
- a Pi continuation hook or extension-injected follow-up;
- a generation/arrival epoch so user input wins;
- an inspectable UI badge and pause/resume/clear actions.

Do not infer completion from final assistant prose. Make `goal.complete` an explicit, auditable action and optionally require evidence references.

---

## 7. Autonomous mode

### Shipped implementation

Autonomous mode is a bounded continuation policy, not a clock scheduler. It tracks continuations, turns, non-cache-read token usage, elapsed time, verifier command attempts, and last gate failure. Defaults are three continuations, twelve turns, 80k tokens, and 30 minutes ([`autonomous.ts:L10-L78`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/autonomous.ts#L10-L78)).

At the end of an assistant turn, it runs configured quality-gate commands. Passing stops continuation; a retryable failure produces a user-role continuation containing bounded verifier evidence; limits stop the loop ([`autonomous.ts:L196-L280`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/autonomous.ts#L196-L280)). `AgentSession` snapshots autonomous counters before queuing a continuation and rolls them back if human input arrived first ([`agent-session.ts:L2721-L2755`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/agent-session.ts#L2721-L2755)).

### Transfer to SumoCode

A SumoCode autonomous loop should be a policy over goals:

```text
assistant turn ends
  → evaluate limits
  → run declared verifier(s) in cancellable background runtime
  → if passed: stop / propose goal completion
  → if failed and budget remains: inject bounded evidence as follow-up
  → if human input arrived: cancel stale continuation
```

Use SumoCode’s existing process-tree cancellation and durable terminal task machinery for verifiers. Never let “autonomous” imply permission escalation; tool/approval policy must remain unchanged.

---

## 8. Heartbeats and schedules

### Shipped implementation

Prime’s scheduler persists jobs with schedule kind (`once`, `cron`, `interval`), source (`cron`, `heartbeat`, `rlm_heartbeat`), target session identity/path, prompt, next/last run, run count, and error/skip data. Heartbeats add an explicit busy-session delivery mode: `steer` or `follow_up` ([`cron-jobs.ts:L15-L83`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/cron-jobs.ts#L15-L83)). Stores can be global or colocated with session artifacts; interrupted dispatch claims are recovered under file locks ([`cron-jobs.ts:L168-L248`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/cron-jobs.ts#L168-L248)).

RLM heartbeats are a separate host API scoped to the active session, with list/create/update/delete and pause/resume behavior ([`agent-session.ts:L2961-L3048`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/agent-session.ts#L2961-L3048)). The daemon starts the scheduler after its socket is ready ([`daemon-mode.ts:L618-L625`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/modes/daemon/daemon-mode.ts#L618-L625)).

### Contrast and transfer

SumoCode’s terminal tasks already have a strong durable record with revisions, private files, canonical paths, process identity, completion delivery states, and `lost` reconciliation ([`background-tasks/task-store.ts:L49-L213`](https://github.com/dhruvkelawala/sumocode/blob/9f70b8e44843daa8ed20921495e168d611014514/src/background-tasks/task-store.ts#L49-L213)). That is the right quality bar for schedules. What is missing is a durable scheduler and session wake-up owner.

Add scheduling only with:

- persisted `scheduledFor` plus a dispatch claim before execution;
- at-least-once wake-up plus idempotent prompt admission;
- timezone/DST policy;
- missed-run/coalescing policy;
- busy-session delivery mode;
- session existence/lease validation;
- explicit permission to run when no UI is attached.

An in-process `setTimeout` is acceptable for UI refresh, not as a durable heartbeat implementation.

---

## 9. `/refine` and continual harness state

### Shipped implementation

Prime’s harness is an explicit JSON schema. Entries are categorized as `prompt`, `memory`, `skill`, or `subagent`, carry stable IDs, content, path, references/argument contracts, metadata, source, timestamps, and version. Refinement events record trigger, changes, evidence, and outcome ([`refinement.ts:L21-L121`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/refinement/refinement.ts#L21-L121)). The base system prompt is declared immutable; prompt edits are supplemental notes ([`refinement.ts:L123-L173`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/refinement/refinement.ts#L123-L173)).

There are two scopes:

- **local:** under the current persisted session’s artifact directory;
- **global:** under the agent directory.

Global and local states merge for reading, with local conflicts retaining scope-qualified identity. Saves use a temporary file and rename ([`refinement.ts:L269-L358`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/refinement/refinement.ts#L269-L358)). The Python harness helper uses the same state file, detects out-of-process host rewrites by mtime, and reloads before an in-kernel save to avoid clobbering host edits ([`prime-agent-runtime/src/rlm/harness.py:L77-L90`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/prime-agent-runtime/src/rlm/harness.py#L77-L90), [`harness.py:L141-L196`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/prime-agent-runtime/src/rlm/harness.py#L141-L196)).

`/refine` is split into:

1. a background LLM planning phase using current messages, merged harness, and refinement history;
2. a short quiescent application phase;
3. re-read of target state immediately before apply;
4. atomic save and history/session entry;
5. system-prompt rebuild and runtime reconnect.

Concurrent refines are serialized; planning can overlap an active turn, but application waits for idle and event/compaction queues to settle ([`agent-session.ts:L7571-L7678`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/agent-session.ts#L7571-L7678), [`agent-session.ts:L7701-L7863`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/agent-session.ts#L7701-L7863)). An agent-callable `refine.run` schedules work for a turn boundary rather than awaiting idle from inside its own tool call, which would deadlock ([`agent-session.ts:L2894-L2958`](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/src/core/agent-session.ts#L2894-L2958)).

### What `/refine` does not do

- It does not edit Prime Agent source files.
- It does not rewrite the immutable base system prompt.
- A model proposal is not free-form persistence; it is normalized into a constrained edit schema.
- Local refinement requires a persisted session; ephemeral sessions cannot silently write global state.
- “Automatic refine” is gated review plus the same plan/apply machinery, not arbitrary self-modification.

### Transfer to SumoCode

SumoCode already has Remnic memory CRUD and observation APIs ([`memory.ts:L57-L82`](https://github.com/dhruvkelawala/sumocode/blob/9f70b8e44843daa8ed20921495e168d611014514/src/memory.ts#L57-L82), [`memory.ts:L188-L270`](https://github.com/dhruvkelawala/sumocode/blob/9f70b8e44843daa8ed20921495e168d611014514/src/memory.ts#L188-L270)). Do not overload Remnic facts with executable prompt/skill/subagent specs. Add a separate versioned harness document, while allowing memory entries to reference Remnic IDs.

Recommended schema:

```ts
type HarnessKind = "prompt_note" | "memory_ref" | "procedure" | "agent_spec";
type Scope = { kind: "session"; sessionId: string }
           | { kind: "project"; repoId: string }
           | { kind: "global" };

interface HarnessEdit {
  op: "create" | "update" | "delete";
  kind: HarnessKind;
  id?: string;
  expectedVersion?: number;
  content?: string;
  toolPolicy?: string[];
  evidence: Array<{ sessionId: string; messageId?: string; artifact?: string }>;
  reason: string;
}
```

Plan while the agent is active; apply only at a Pi session boundary. Use optimistic versions plus atomic rename/locking. Show the proposed diff and scope in SumoTUI. Default to session-local; require explicit approval for project/global writes. Keep a rollback event containing before/after values.

---

## 10. Integration sketch for SumoCode

### Preserve existing ownership

```text
SumoTUI foreground host
  ├─ presentation + input + activity projection (unchanged)
  └─ Pi RPC child
       ├─ Pi agent loop/session/provider/tools (unchanged)
       ├─ Sumo orchestration service
       │    ├─ AgentRunStore + InboxStore + GoalStore
       │    ├─ existing SubagentManager adapter
       │    └─ optional ScheduleStore
       └─ SessionWorkspace child
            ├─ persistent namespace
            ├─ typed host requests
            └─ harness helper
```

### New modules

| Module | Responsibility | Reuse |
|---|---|---|
| `src/workspace/session-workspace.ts` | lifecycle, execute stream, JSON-safe snapshot, host request router | `WorkerRuntime` cancellation conventions |
| `src/orchestration/run-store.ts` | durable agent records, revisions, recovery reconciliation | terminal `task-store.ts` private/atomic/lock patterns |
| `src/orchestration/inbox-store.ts` | family-scoped messages and idempotent delivery | activity feed as projection |
| `src/goals/store.ts` | one goal state machine per Pi session | Pi session custom entries if available, else private JSON |
| `src/harness/store.ts` | scoped/versioned entries and rollback log | private atomic persistence helpers |
| `src/harness/refine.ts` | plan, validate, quiescent apply, prompt rebuild | Pi extension lifecycle hooks |
| `src/schedules/store.ts` + `scheduler.ts` | future prompts and dispatch claims | only after a long-lived owner exists |

### Host method allowlist

Start with a small discriminated union:

```ts
type WorkspaceHostRequest =
  | { method: "agent.spawn"; prompt: string; name?: string; model?: string }
  | { method: "agent.send"; target: string; message: string }
  | { method: "agent.list" }
  | { method: "goal.get" }
  | { method: "goal.complete"; evidence?: string[] }
  | { method: "refine.schedule"; instructions?: string; scope?: "session" | "project" }
  | { method: "artifact.put"; mediaType: string; bytes: string };
```

Validate payloads in the host, bind every request to the calling session/agent identity, and never expose a generic “invoke arbitrary SumoCode method” bridge.

### Delivery and projection

Use one authoritative orchestration event log/store; derive:

- Activity feed rows;
- subagent tool snapshots;
- inbox badges;
- goal progress;
- schedule status.

The UI must tolerate replay and duplicate events. Every completion/message should have a stable ID and delivery cursor. Do not derive authority from whether a row is currently rendered or expanded.

### Staged delivery

**Phase A — workspace spike**

- one workspace per Pi session;
- execute, interrupt, dispose, namespace inventory;
- JSON-only snapshot with explicit limits;
- two read-only host calls (`agent.list`, `goal.get`);
- tests for session switch, Ctrl-C, child crash, malformed output, and stale response generation.

**Phase B — durable orchestration**

- persist child admission before subprocess spawn;
- recover/reconcile running children and session files;
- add agent inbox and stable UUIDs;
- project existing activity rows from authoritative records.

**Phase C — goals and refine**

- goal state machine/continuation arbitration;
- harness plan validator, local scope, atomic apply, rollback;
- SumoTUI diff/approval for broader scopes.

**Phase D — unattended runtime (conditional)**

- durable schedules and dispatch claims;
- a launchd-managed owner or per-session worker daemon;
- leases, passivation, recovery journals, and multi-client routing only if demanded by product behavior.

---

## 11. Open risks and unanswered questions

### Security and trust

1. **The kernel is code execution.** A persistent Python process has the permissions of SumoCode unless separately sandboxed. The typed host bridge narrows SumoCode API access but does not sandbox filesystem/network/process access.
2. **Subagent policy mismatch already exists.** SumoCode headless children intentionally run without extensions, including the parent approval gate ([`backend-pi.ts:L296-L307`](https://github.com/dhruvkelawala/sumocode/blob/9f70b8e44843daa8ed20921495e168d611014514/src/subagents/backend-pi.ts#L296-L307)). Making children resident or message-addressable increases the importance of a non-interactive child policy.
3. **Harness poisoning.** Model-generated global prompt/procedure edits can create persistent behavioral regressions or prompt-injection persistence. Scope defaults, evidence, schema validation, review, and rollback are mandatory.
4. **Secrets in snapshots.** JSON-safe does not mean safe to persist. Namespace snapshots need secret-pattern redaction, allow/deny controls, private modes, and an inventory UI.

### Correctness and lifecycle

5. **Exactly-once is unrealistic across crashes.** Schedules and messages should be at-least-once with idempotent admission and explicit receipts.
6. **Session identity must survive restarts without ID reuse.** SumoCode’s `sa-1` style local IDs are presentation identifiers, not durable routing identities.
7. **Workspace and transcript can diverge.** Compaction, session fork, rewind, and resume need declared behavior for workspace snapshots and harness scope.
8. **Cancellation is multi-layered.** A tool abort, Python execution abort, child-agent cancellation, process-tree kill, and schedule cancellation are different operations. Prime’s complexity here is evidence that one `AbortController` is not a complete durable lifecycle.
9. **Local/global concurrent writes.** Prime mitigates host-versus-kernel clobbering with mtime reload and re-read-before-apply. SumoCode should use explicit revisions/compare-and-swap in addition to atomic file replacement.

### Product and cost

10. **Persistent compute has idle cost and cleanup burden.** Define passivation thresholds and whether variable snapshots are opt-in.
11. **Recursive agents multiply spend.** Enforce family-wide concurrency, depth, token/cost budgets, and model policy; do not only enforce per manager process.
12. **Autonomy needs visible stop conditions.** Goals, gate commands, schedules, and wake permissions must be inspectable and cancellable from SumoTUI.
13. **A daemon changes the product’s failure surface.** launchd installation, upgrades, socket permissions, stale workers, logs, and recovery become user-facing operations. Delay it until the benefit exceeds this burden.

### Questions to resolve before implementation

- Does SumoCode want Python specifically, or merely a persistent programmable workspace?
- Should workspace state follow a Pi session fork, and if so at which snapshot boundary?
- Is unattended execution permitted by default, per project, or per schedule?
- Is Remnic the source of global declarative memory while the harness stores only references, or may harness-local memory duplicate facts?
- Which Pi extension hooks can safely inject a continuation and rebuild prompt resources without private API patches?
- Can existing Pi session files provide stable custom entries for goals/refinement, or should SumoCode own a sidecar keyed by canonical session path?
- What approval policy should headless children use when they cannot display an interactive prompt?

---

## Bottom line

Prime Agent’s transferable advantage is not any single feature. It is the **composition of explicit durable contracts**:

- a persistent programmable workspace;
- host-owned typed mutations;
- full-session child agents with asynchronous handles;
- family-scoped messaging;
- goals and bounded continuation as separate state machines;
- persistent scheduling with dispatch recovery;
- a constrained, scoped, rollbackable refinement store;
- and process isolation only where long-lived ownership requires it.

SumoCode already has strong primitives for subprocess isolation, terminal-task persistence, activity projection, RPC presentation separation, and memory. The pragmatic path is to deepen those primitives into durable orchestration and add a workspace/harness layer behind Pi—not to clone Prime Agent’s daemon and kernel stack wholesale.