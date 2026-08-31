# SumoCode ↔ Pi RPC deep audit

**Status:** implementation audit and future-main migration plan
**Audited:** 2026-08-27
**SumoCode commit:** `1ad967bf09acb5f59293e1e526f0e9ca61c6daa8`
**Pinned Pi:** `@earendil-works/pi-coding-agent` `0.84.1`
**Future target:** Pi `main` at [`4e494929998d6bc4fccf75e0a233f727db4b70ee`](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee)
**Upstream inventory:** [PI_RPC_MAIN_SPEC_RESEARCH.md](./PI_RPC_MAIN_SPEC_RESEARCH.md)

## Executive verdict

SumoCode made the right architectural choice by making Pi's RPC process the interactive runtime seam. The subprocess lifecycle, strict LF-only JSONL parser, request correlation, transcript hydration/reconciliation, tool-event projection, and extension UI bridge are all substantial and generally faithful implementations.

The weakness is above that transport layer. SumoCode has rebuilt several pieces of Pi session policy in the host instead of treating Pi as the authority:

1. The host owns its own prompt/follow-up queue and only uses Pi's native steering queue as an escape hatch. Pi already owns `steer`, `follow_up`, queue modes, `queue_update`, and—on unreleased main—`clear_queue`.
2. Chrome state treats `agent_end` as the idle boundary even though the RPC contract says only `agent_settled` means no retry, compaction retry, or queued continuation remains.
3. Direct RPC bash, native image payloads, retry/summarization lifecycle presentation, and extension-error presentation are missing.
4. `get_state` is used, but several policy fields are discarded, so SumoCode cannot truthfully present the child session's queue and auto-compaction settings.

The recommended direction is not a new runtime or an in-process `AgentSession`. Keep the RPC subprocess and custom client, but make Pi authoritative for delivery queues and lifecycle. The unreleased `clear_queue` command is the natural compatibility boundary for that simplification, but it is not yet sufficient for lossless image-queue recovery or atomic promotion of one follow-up into steering.

## Baseline and version delta

SumoCode declares `~0.84.1` peers and exact `0.84.1` development packages in [`package.json`](../../package.json#L27-L39). Current Pi main still identifies its package as `0.84.3`, but its changelog places `clear_queue` under **Unreleased**. Planning must therefore target a release that contains the researched main commit, not published `0.84.3` merely by version number.

There are only three material RPC-stream changes from the pin to the future target:

| First available | Change | SumoCode impact |
|---|---|---|
| `0.84.2` | `message_update.usage` carries cumulative provider usage. | Feature-detect it and update live footer accounting; retain the existing stats refresh as reconciliation. |
| `0.84.3` | `toolcall_start` carries `id` and `toolName`. | Optionally seed activity identity earlier; keep `tool_execution_*` and `toolcall_end` authoritative. |
| Unreleased main | `clear_queue` returns and removes `{steering, followUp}`. | Enables native Pi queue ownership while preserving Escape/Alt+Up “restore queued drafts” UX. |

There are no other RPC command additions between `0.84.1` and the researched main. Current main has 33 commands; the pin has 32.

Upstream source also exposes compatibility details not stated accurately in `rpc.md`: `get_commands` uses `sourceInfo`; three session events are undocumented; several optional values serialize as absent rather than `null`; and the documented attachment shape is obsolete. These are recorded in the [upstream research note](./PI_RPC_MAIN_SPEC_RESEARCH.md#current-rpcmd-versus-current-source-compatibility-hazards).

## Architecture assessment

### Keep these parts

- **RPC subprocess boundary.** [`spawn-child.mjs`](../../src/sumo-tui/rpc/spawn-child.mjs#L27-L41) launches the public CLI with `--mode rpc` and an explicit SumoCode extension entry. The launcher still bypasses the retained host for print mode, explicit Pi modes, and non-TTY output. That preserves Pi CLI compatibility and crash/process isolation.
- **Custom client.** [`client.ts`](../../src/sumo-tui/rpc/client.ts#L124-L451) adds extension UI requests, pre-spawn adoption, stderr retention, child-exit ownership, request timeouts, and host lifecycle behavior that the small upstream `RpcClient` does not cover. Replacing it wholesale would regress required SumoCode behavior.
- **Framing and correlation.** The client splits on LF rather than Node `readline`, emits a unique id for every request, matches replies by id, and tolerates CRLF through outer whitespace trimming ([`client.ts`](../../src/sumo-tui/rpc/client.ts#L292-L377)). This matches Pi's strict JSONL contract.
- **Hydration and session replacement.** The `get_state` + `get_messages` quiet-loop, event barrier, identity checks, and suffix replay in [`host.ts`](../../src/sumo-tui/rpc/host.ts#L1221-L1365) correctly address response/event ordering races.
- **Transcript reconstruction.** [`TranscriptController`](../../src/sumo-tui/transcript/controller.ts#L400-L530) reconstructs indexed streaming text/thinking deltas and treats `message_end.message` as authoritative. Its `agent_end` handling correctly understands that `messages` is the current run's suffix, not the full session.
- **Tool lifecycle.** Stable `toolCallId`-based handling of `tool_execution_start/update/end` is correct, including accumulated partial replacement and task-specific partials ([`controller.ts`](../../src/sumo-tui/transcript/controller.ts#L207-L268)).
- **Extension UI bridge.** All four dialogs and all five fire-and-forget methods are implemented in retained UI surfaces ([`extension-ui-responder.ts`](../../src/sumo-tui/rpc/extension-ui-responder.ts#L88-L194)). RPC-specific fallbacks for `custom()` are already present in important SumoCode commands.
- **Session entry access.** `get_entries` plus the disk/session reconciliation in [`session-snapshot.ts`](../../src/sumo-tui/rpc/session-snapshot.ts#L45-L94) is a strong use of the append-only API and should remain available even if presentation begins using `get_tree`.

### Change the ownership model

Today there are two delivery authorities:

```text
editor → SumoCode PromptScheduler queue → prompt
                         └ force → prompt(streamingBehavior="steer") → Pi steering queue

Pi also owns: steering queue + follow-up queue + queue modes + automatic continuation
```

The result is a 390-line host scheduler with generation counters, dispatch barriers, synthetic ownership, and separate restore semantics ([`prompt-scheduler.ts`](../../src/sumo-tui/rpc/prompt-scheduler.ts#L93-L269)). SumoCode then composes its queue with any Pi queue in chrome, while explicitly admitting that Pi-owned entries cannot be restored ([`state.ts`](../../src/sumo-tui/rpc/state.ts#L30-L36), [`host.ts`](../../src/sumo-tui/rpc/host.ts#L573-L587)).

The future target should be:

```text
idle submit          → prompt
busy Enter           → prompt(streamingBehavior=<selected delivery mode>)
busy deferred submit → prompt(streamingBehavior="followUp")
queue display        ← queue_update
Escape / dequeue     → clear_queue → restore text → abort when needed
fully idle           ← agent_settled
```

This removes duplicated session policy while retaining SumoCode-owned editor history, draft presentation, keybindings, and notifications.

### Queue steering specifically

SumoCode currently has steering, but only as a narrow “force the next host-owned item” path:

1. A normal submit while busy is appended to `DefaultRpcPromptScheduler.queue`; Pi sees nothing yet.
2. The explicit follow-up action uses that same host queue with `forceQueue:true`.
3. The force-send action removes the first host item and sends `prompt(..., streamingBehavior:"steer")`.
4. SumoCode then watches `queue_update.steering` to infer whether Pi accepted ownership.

That means SumoCode does **not** normally use Pi's steering queue and never projects its active steering mode. The current force path uses the right Pi primitive but only after placing the message in the wrong queue.

Classic Pi's default delivery behavior is reproducible exactly for ordinary submissions. Its interactive Enter handler calls `session.prompt(text, { streamingBehavior: "steer" })` while streaming—not `session.steer()` ([upstream interactive mode](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3145-L3152)). RPC's `prompt` command forwards the same option into the same `AgentSession.prompt()` method ([upstream RPC mode](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L394-L414)). This form is important because it preserves extension-command execution, input interception, skill expansion, and prompt-template expansion before Pi decides whether to enqueue the result. The surrounding clients are not literally identical: SumoCode must continue routing builtin slash commands and bash itself, and input extensions see source `"rpc"` rather than `"interactive"`.

The exact key mapping should therefore be:

- **Delivery-mode toggle:** SumoCode owns a visible `steer` / `follow-up` toggle for busy submissions. It defaults to `steer`. This is not Pi's `steeringMode` setting: that setting chooses `one-at-a-time` versus `all` *within* the steering queue, whereas this toggle chooses which queue receives Enter.
- **Enter:** after SumoCode-owned builtin-command handling, send `prompt()` with the selected streaming behavior. With the default toggle this is `prompt(..., streamingBehavior:"steer")`, exactly matching classic Pi. When Pi is idle the option is ignored; when Pi is streaming it enters the selected native queue. Supplying the option in both states also removes a host-state race.
- **Alt+Enter:** send `prompt(..., streamingBehavior:"followUp")`; when idle it behaves like Enter, and while streaming it enters Pi's deferred queue, matching [classic Pi's handler](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4108-L4137).
- **Alt+Up:** call `clear_queue`, then restore steering messages followed by follow-ups into the editor, matching classic Pi's restoration order ([upstream interactive mode](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4369-L4387)).
- **Escape while streaming:** perform the same clear-and-restore first, then `abort`.
- **During compaction/summarization:** retain a small, explicitly local client queue and flush it after `compaction_end`; classic Pi applies this policy to its broad `isCompacting` state (manual compaction, automatic compaction, and branch summarization), while `AgentSession.prompt()` itself explicitly rejects manual compaction.

This gives exact default **steering delivery**. It does not make the complete clients identical. The remaining cancellation blockers are Escape during compaction and branch summarization: classic Pi calls dedicated `abortCompaction()`/`abortBranchSummary()` methods, while current RPC exposes neither and generic `abort` cancels neither operation. Builtin slash commands also remain host-owned, and extensions intentionally observe RPC rather than interactive/TUI input context. These differences do not block Enter-to-steer parity.

Pi's two steering modes matter:

- `one-at-a-time` delivers one steering item at each completed assistant-turn boundary.
- `all` delivers every pending steering item at the next boundary.

Both Pi queue-drain modes default to `one-at-a-time`, and the RPC child loads the same settings. SumoCode should hydrate and display those modes rather than hard-code them. With SumoCode's delivery toggle at its `steer` default, several rapid Enter submissions are delivered one per assistant-turn boundary, exactly as in classic Pi. Switching the delivery toggle to `follow-up` is a deliberate SumoCode enhancement: subsequent busy Enter submissions wait for the active run to finish.

The existing SumoCode “force the oldest queued message” action should disappear after the cut-over; Enter already sends directly to the selected Pi queue. Pi cannot move, remove, or reclassify one particular existing queue entry atomically. Implementing promotion as `clear_queue` followed by steer + requeue creates a race and changes ordering if new work arrives.

There is a second upstream limitation: `queue_update` and `clear_queue` expose only `string[]`. Although `steer` and `follow_up` accept images, clearing such a queue returns the text and discards the queued `ImageContent` from the client-visible result. Lossless queued-image restore therefore requires structured queue entries/stable ids upstream or a deliberately limited host attachment-retention layer.

## Complete command audit

Coverage labels:

- **Good** — used in a production path with contract-correct semantics.
- **Partial** — used, but important fields or lifecycle semantics are missing.
- **Absent** — supported by the target RPC contract but has no SumoCode production path.
- **Future** — unavailable on pinned `0.84.1`; plan against unreleased main.
- **Intentional** — a local alternative is justified, but the divergence must remain explicit.

| RPC command | Coverage | Current implementation | Audit result |
|---|---|---|---|
| `prompt` | Partial | Normal text, initial prompts, and child extension commands use it. Busy force-send uses `streamingBehavior:"steer"`. | This is the exact classic-Pi primitive. Use `streamingBehavior:"steer"` for Enter and `"followUp"` for Alt+Enter; ordinary busy submissions must stop being held in the host queue. Add native `images`. |
| `steer` | Intentional | No direct command; force-send calls `prompt(..., streamingBehavior:"steer")`. | Do not use for the normal Enter path: unlike `prompt`, the standalone command rejects extension commands and bypasses input interception. Keep it only if SumoCode later needs an explicitly command-free steering API. |
| `follow_up` | Intentional | Host `PromptScheduler` currently reproduces FIFO settlement behavior and dispatches a later plain `prompt`. | Delete that host delivery queue, but use `prompt(..., streamingBehavior:"followUp")` for classic-Pi input parity. Reserve the standalone command for explicitly command-free callers. |
| `abort` | Partial | Ctrl-C/Escape and tree navigation call it. | Correct for active agent cancellation, and Pi's implementation also cancels retry delay. It does not clear queued continuations; future Escape must `clear_queue` first. |
| `clear_queue` | Future | Not typed or called on the pin. | Adopt as soon as the containing release is pinned. It closes text-draft recovery, but returns no ids or images and cannot reclassify one queued entry. |
| `new_session` | Good | Wrapper supports `parentSession`; `/new` uses the unparented form and rehydrates. | Correct. Optional parent lineage is available but not exposed by current UX. |
| `get_state` | Partial | Used at startup, replacement, navigation, and recovery. | Model/thinking/session/streaming fields are projected, but `steeringMode`, `followUpMode`, and `autoCompactionEnabled` are discarded. |
| `get_messages` | Good | Used for initial hydration and every session/branch replacement. | Correct authoritative conversation snapshot use. |
| `set_model` | Good | Used by selectors and forward/backward enabled-model cycling; response updates chrome immediately. | Correct, including rollback through `get_state` on error. |
| `cycle_model` | Intentional | Wrapper exists, but production cycling computes over SumoCode's enabled-model filter and calls `set_model`. | Do not force use: Pi's command is forward-only and its scope is not SumoCode's filtered ring. Remove the unused wrapper or document it as a test/compatibility helper. |
| `get_available_models` | Good | Cached for model selectors and filtered cycling. | Correct. Cache invalidation is handled after model-affecting child commands. |
| `set_thinking_level` | Good | Used by `/thinking`; optimistic state with rollback. | Correct. |
| `cycle_thinking_level` | Good | Used by the thinking hotkey and no-argument command. | Correct. |
| `get_available_thinking_levels` | Good | Used by thinking selector. | Correct. |
| `set_steering_mode` | Absent | No wrapper, state, or setting. | Required once Pi owns queues. Default `one-at-a-time` should be explicit and visible; `all` may be optional UX. |
| `set_follow_up_mode` | Absent | No wrapper, state, or setting. | Same gap as steering mode. |
| `compact` | Partial | `/compact` sends optional instructions with a suitable long timeout. | Command use is correct, but the returned result and `compaction_end.errorMessage/willRetry` are not presented consistently. |
| `set_auto_compaction` | Partial | `/settings` can enable or disable it. | The mutation is correct, but `get_state.autoCompactionEnabled` is discarded, so settings cannot show the current value. |
| `set_auto_retry` | Partial | `/settings` can enable or disable it. | The mutation is correct. Upstream `get_state` does not expose the current value, so SumoCode needs a documented local settings source or an upstream field. |
| `abort_retry` | Absent | Generic `abort` is used. | Not a blocking gap because Pi's generic abort calls `abortRetry()`. Add only if the UI needs a retry-specific cancel that does not imply broader cancellation. |
| `bash` | Absent | `!command` falls through as an ordinary agent prompt; no direct-bash state exists. | Major lost interactive feature. RPC already streams all output and persists a `BashExecutionMessage` for the next prompt. |
| `abort_bash` | Absent | No direct bash path to cancel. | Implement with direct bash; the interrupt action (Escape by Pi default) must route to this while bash is active. |
| `get_session_stats` | Good | Polled every five seconds and used in `/stats`. | Correct reconciliation source. From `0.84.2`, streaming usage can make the footer immediate while stats remains authoritative. |
| `export_html` | Good | `/export` calls it and reports the path. | Correct. |
| `switch_session` | Good | `/resume`, `/sessions`, and explicit paths use it with replacement hydration. | Correct. Direct session-file listing remains local because RPC has no list-sessions command. |
| `fork` | Good | Uses a selected entry and replacement hydration. | Correct. |
| `clone` | Good | `/clone` plus replacement hydration. | Correct. |
| `get_fork_messages` | Good | Populates fork selection. | Correct purpose-built use. |
| `get_entries` | Good | Drives tree snapshots, cursors, navigation reconciliation, and disk fallback. | Strong implementation. Preserve it even if `get_tree` is adopted for topology. |
| `get_tree` | Intentional | Not called; SumoCode builds a local tree from entries and navigates through a hidden extension command. | `get_tree` cannot navigate and does not replace cursor needs. Use it as a topology oracle/cross-check or simplify presentation, not as a wholesale replacement for `get_entries`. |
| `get_last_assistant_text` | Good | Used by copy-last-response. | Correct. |
| `set_session_name` | Good | `/name` applies the response optimistically to chrome. | Correct. |
| `get_commands` | Good | Merged with SumoCode host commands for autocomplete and child routing. | Correctly compensates for Pi omitting built-in TUI commands. Current-main `sourceInfo` is ignored; that is fine until provenance is displayed. |

## Complete event audit

| RPC event | Current consumption | Audit result |
|---|---|---|
| `agent_start` | State marks streaming; scheduler marks busy; transcript records run boundary. | Good. |
| `agent_end` | Transcript reconciles the current-run suffix correctly. State marks idle and replaces total message count with `event.messages.length`. | **Incorrect state semantics.** It is a low-level boundary, not settlement, and its messages are not the full session. |
| `agent_settled` | Scheduler releases/drains its host queue; state only records `lastEventType` through the default arm. | Partial. This must become the authoritative transition to idle. |
| `turn_start` | Ignored outside generic event tracking. | Acceptable; no UI currently needs it. Preserve it for diagnostics. |
| `turn_end` | Scheduler counts it for force-steer acceptance. | Partial but sufficient for the existing scheduler; likely unnecessary after native queue migration. |
| `message_start` | Transcript starts/upserts user or assistant draft and scheduler detects injected user boundaries. | Good. |
| `message_update` | Text and thinking deltas are rebuilt by `contentIndex`. Tool-call deltas and future top-level usage are ignored. | Good for pinned text streaming; partial for `0.84.2+` accounting and `0.84.3+` early tool identity. |
| `message_end` | Final message is committed authoritatively and assistant streaming presentation ends. | Good. |
| `bash_execution_update` | No handler. | Absent with direct bash. |
| `tool_execution_start` | Creates a live tool keyed by `toolCallId`. | Good. |
| `tool_execution_update` | Replaces accumulated partial result; task partials also feed activity state. | Good. |
| `tool_execution_end` | Commits success/error tool state pending authoritative message reconciliation. | Good. |
| `queue_update` | State displays Pi queues; scheduler watches steering appends for force-send ownership. | Partial. It should become the only queue snapshot after migration. |
| `compaction_start` | State and transcript track reason/busy. | Good. |
| `compaction_end` | Clears busy and may add a summary message. | Partial. Failure, abort, `willRetry`, and summarizer usage are not surfaced as lifecycle state. |
| `auto_retry_start` | Only `lastEventType` changes. | Absent UX. Delay/attempt/error should be visible and cancellable. |
| `auto_retry_end` | Only `lastEventType` changes. | Absent UX. Final failure should be shown without pretending the session settled early. |
| `summarization_retry_scheduled` | Only `lastEventType` changes. | Absent UX and diagnostics. |
| `summarization_retry_attempt_start` | Only `lastEventType` changes. | Absent UX and diagnostics. |
| `summarization_retry_finished` | Only `lastEventType` changes. | Absent UX and diagnostics. |
| `extension_error` | Dispatched as a generic event; no notification or durable diagnostic is produced by the state/transcript path. | Major observability gap. Extension failures can be invisible to the user. |
| `entry_appended` *(source, undocumented)* | Only generic tracking. | Acceptable today; useful for cursor/tree invalidation after the upgrade. Decoder must preserve it. |
| `session_info_changed` *(source, undocumented)* | Updates the session name. | Good and more complete than `rpc.md`. |
| `thinking_level_changed` *(source, undocumented)* | Updates thinking level. | Good and more complete than `rpc.md`. |

The concrete state bug is in [`state.ts`](../../src/sumo-tui/rpc/state.ts#L150-L201): `agent_end` sets `isStreaming:false` and uses the run-local array length as global `messageCount`. The scheduler itself correctly waits for `agent_settled` ([`prompt-scheduler.ts`](../../src/sumo-tui/rpc/prompt-scheduler.ts#L186-L231)), so delivery is mostly protected, but the footer/working state and message count can be false until the next stats refresh. Existing assertions in [`state.test.ts`](../../src/sumo-tui/rpc/state.test.ts#L144-L156) and [`host.test.ts`](../../src/sumo-tui/rpc/host.test.ts#L308-L334) currently codify the incorrect count/idle projection and must change with the fix.

## Extension UI protocol audit

| Method | SumoCode implementation | Result |
|---|---|---|
| `select` | Retained selector/modal, timeout passed through, auth-specific cancellation support. | Good. |
| `confirm` | Retained confirm dialog, timeout passed through. | Good. |
| `input` | Retained input dialog with secret masking and auth details. | Good; local enrichment beyond the base protocol. |
| `editor` | Standalone multiline modal; deliberately preserves the chat draft. | Good. |
| `notify` | Notification center. | Good. |
| `setStatus` | Keyed status publication; one private key also carries correlated tree-navigation outcome. | Good, though the private control channel should remain namespaced and tested. |
| `setWidget` | Region registry above/below editor. | Good. |
| `setTitle` | Terminal title. | Good. |
| `set_editor_text` | Replaces the live host editor text. | Good. |

One protocol-cleanliness issue remains. For fire-and-forget methods, the responder returns `void`, but [`client.ts`](../../src/sumo-tui/rpc/client.ts#L403-L421) still sends a synthetic cancelled response. Pinned Pi ignores unknown response ids, so this is harmless today, but the spec says responses are for dialogs only. Classify request methods in the client and emit no response for the five fire-and-forget variants.

Pi's direct-TUI methods (`custom`, header/footer/editor component replacement, theme APIs, raw input, autocomplete providers, and related methods) do not cross RPC. SumoCode correctly owns its chrome in the host and has RPC fallbacks for major child commands. Continue auditing every newly installed child extension for `ctx.mode === "rpc"`; `ctx.hasUI` alone is insufficient because Pi intentionally sets it to true in RPC mode.

## Prioritized findings

### RPC-01 — Pi is not the queue authority

**Impact:** high complexity, split ownership, incomplete undo/cancel semantics, and duplicated race handling.

Evidence:

- Busy submissions enter `DefaultRpcPromptScheduler.queue` rather than `follow_up` ([`prompt-scheduler.ts`](../../src/sumo-tui/rpc/prompt-scheduler.ts#L122-L143)).
- Force-send changes one host item into `prompt(streamingBehavior:"steer")` and then infers Pi ownership from events ([`prompt-scheduler.ts`](../../src/sumo-tui/rpc/prompt-scheduler.ts#L145-L183)).
- The UI composes host and Pi queues, but only the host queue can be restored ([`state.ts`](../../src/sumo-tui/rpc/state.ts#L30-L36)).
- Dequeue reports “queued messages are owned by pi” rather than restoring them ([`host.ts`](../../src/sumo-tui/rpc/host.ts#L580-L587)).

`clear_queue` was added upstream specifically for interactive Escape: clear, restore returned text, then abort. Route normal submissions through `prompt` with Pi's classic `steer`/`followUp` streaming behaviors and delete the general host delivery queue after parity tests pass. Retain only the narrow compaction queue that classic Pi itself needs. Before deleting all other host queue metadata, resolve the protocol's text-only recovery of queued images.

### RPC-02 — `agent_end` is projected as settled

**Impact:** incorrect footer/working state during retry, compaction retry, and queued continuation; incorrect message counts until stats reconciliation.

Move only the session-busy transition to `agent_settled`. Keep `agent_end` for run-suffix transcript reconciliation and run-local cleanup. Never derive total session messages from `agent_end.messages`.

### RPC-03 — direct bash is missing

**Impact:** RPC-host users lose Pi's immediate shell workflow; `!command` is sent to the model instead of executed locally.

Implement `bash`, `bash_execution_update`, and `abort_bash` as a separate host activity lifecycle. Support the Pi interactive conventions for inclusion/exclusion from next-prompt context. A direct bash command may be arbitrarily long, so do not use the client's current 30-second default timeout for the final response.

### RPC-04 — image drafts are text paths, not RPC images

**Impact:** pasted images are not attached to the first multimodal model request.

The editor persists clipboard bytes to a temp file and collapses the path to `[Image N]` ([`clipboard-paste.ts`](../../src/sumo-tui/rpc/clipboard-paste.ts#L95-L119), [`editor-draft-state.ts`](../../src/cathedral/editor-draft-state.ts#L21-L56)). Submission expands the token back to a path string; [`sendRpcPrompt`](../../src/sumo-tui/rpc/host.ts#L470-L484) only accepts `message:string`. Pi's native `prompt`, `steer`, and `follow_up` all accept `ImageContent[]` and place those blocks in the user message.

Use the existing attachment list to load, MIME-validate, and base64-encode images at dispatch. Queue structured `{text, images}` values, not path-expanded strings. Keep the human-readable token in the editor/history and avoid logging base64 payloads.

### RPC-05 — retry, compaction failure, and extension errors are invisible

**Impact:** the host can appear idle or simply silent while Pi retries, and child extension failures may have no user-facing evidence.

Project retry attempt/delay into the working state, show final failures, log bounded extension path/event/error diagnostics, and give `extension_error` a visible notification. Generic `abort` already cancels Pi's retry controller; `abort_retry` is optional targeted control rather than a prerequisite.

### RPC-06 — child policy state is discarded

**Impact:** settings can issue commands without knowing or displaying the current state.

Add `steeringMode`, `followUpMode`, and `autoCompactionEnabled` to `RpcHostChromeState` and hydrate them from `get_state`. Pi does not expose `autoRetryEnabled`; either persist SumoCode's mutation in its settings layer and label it as local last-known state, or propose the missing field upstream.

### RPC-07 — current-main stream enrichments are unused

**Impact:** footer cost/context remains poll-lagged and tool identity cannot appear at the earliest stream point.

Feature-detect `message_update.usage` and `toolcall_start.id/toolName`. Do not make either required while `0.84.1` compatibility exists. Continue treating stats, `message_end`, `toolcall_end`, and `tool_execution_*` as authoritative reconciliation sources.

### RPC-08 — the decoder is forward-tolerant but shallow

**Impact:** any object-shaped stdout line that is neither response nor UI request is cast to an event; malformed responses are recognized only by `type:"response"` before typed access.

Keep forward extensibility, but validate the minimum discriminants and correlated response fields at the wire boundary. Accept unknown event types and fields, missing-versus-null optional values, new message roles, and new content blocks. Do not turn a schema hardening pass into a closed-world decoder.

### RPC-09 — tree topology is duplicated, but RPC lacks navigation

**Impact:** local tree construction can drift from Pi's topology/label rules; the hidden extension-command bridge remains necessary because the protocol has no navigate-to-entry command.

Use `get_tree` as a topology oracle in tests and consider it for display. Retain `get_entries` for durable cursors, abandoned/pre-compaction history, and navigation reconciliation. Keep the extension navigation bridge until upstream adds a command.

### RPC-10 — private Pi imports enlarge upgrade risk

**Impact:** clipboard image support resolves `dist/utils/clipboard-image.js` by physical path. Pi `0.84.3` changed public CLI/RPC entrypoint packaging, demonstrating that private `dist` layout is not stable.

This is not an RPC protocol defect, but it belongs in the Pi upgrade gate. Prefer a public upstream clipboard helper when available; until then, test the deep import against the target package tarball and keep its existing fail-soft behavior.

## Intentional non-use and upstream gaps

Not every unused RPC surface is misuse:

- **In-process `AgentSession`:** not recommended for SumoCode. It would collapse the chosen CLI/process isolation seam and does not eliminate retained-host work.
- **Upstream `RpcClient`:** useful as a reference and conformance oracle, but it does not replace SumoCode's extension UI and process-ownership behavior.
- **`cycle_model`:** SumoCode needs backward traversal and its own enabled-model filter; `get_available_models` + `set_model` is appropriate.
- **Built-in slash commands:** `get_commands` deliberately omits TUI-only commands, so SumoCode must own `/settings`, `/hotkeys`, `/sessions`, and similar retained surfaces.
- **Session listing:** RPC can switch a known path but cannot list sessions. SumoCode's local session-file discovery is justified.
- **Tree navigation:** `get_tree` reads topology but cannot select a leaf. The child extension bridge is justified.
- **Direct-TUI extension APIs:** these cannot be fixed client-side without new protocol methods. Host-native equivalents and RPC dialog fallbacks are the correct pattern.

Useful upstream proposals are:

1. Add protocol capability/version negotiation rather than inferring support from a package version.
2. Expose `autoRetryEnabled` in `get_state`.
3. Return structured queue entries with stable ids and images from `queue_update`/`clear_queue`; optionally add remove/reclassify-one operations.
4. Add `abort_compaction` and `abort_branch_summary` so RPC clients can reproduce classic Escape during those operations.
5. Add `list_sessions` and a session/tree navigation command.
6. Document `entry_appended`, `session_info_changed`, and `thinking_level_changed`.
7. Correct `get_commands.sourceInfo`, optional/absent values, message roles, and image examples in `rpc.md`.
7. Export clipboard-image reading through a stable public API if custom RPC UIs are expected to match Pi's paste experience.

## Phased implementation plan

### Phase 0 — protocol contract gate

Target both pinned `0.84.1` and the exact future release containing `clear_queue`.

- Add checked protocol fixtures for every command response, all 21 documented events, the three source-only events, and all nine UI request methods.
- Add a generated/checked command exhaustiveness test so a Pi upgrade fails when `RpcCommand["type"]` gains a member without an explicit SumoCode classification.
- Add compatibility fixtures for missing/null optional fields, legacy/current command provenance, `0.84.1` deltas, `0.84.2` usage, and `0.84.3` tool-call start identity.
- Assert the child version/capability at startup. Until Pi exposes negotiation, use a version probe or launcher-owned capability flag and fail closed for `clear_queue` use.
- Verify the public CLI/`rpc-entry` packaging and the private clipboard import against the target tarball.

**Exit:** the same host decoder runs the pin and future fixtures, while target-only commands are capability-gated.

### Phase 1 — lifecycle correctness on the current pin

- Keep `isStreaming`/session busy true across `agent_end`; clear it at `agent_settled`.
- Stop assigning `event.messages.length` to global `messageCount`; update counts from message commits, `get_state`, or stats reconciliation.
- Add explicit retry/summarization/extension-error state and notifications.
- Surface `compaction_end` failure, abort, `willRetry`, and usage details.
- Hydrate `steeringMode`, `followUpMode`, and `autoCompactionEnabled`.

**Exit:** retry → compaction → continuation traces never render false idle, and totals do not regress at `agent_end`.

### Phase 2 — direct bash on the current pin

- Route the interactive shell prefix to `bash`; map the context-exclusion form to `excludeFromContext:true`.
- Correlate `bash_execution_update` by command id and render one live activity card.
- Route the interrupt action (Escape by Pi default) to `abort_bash` while direct bash is active.
- Reconcile the final `BashResult`/session message without waiting for an unrelated next prompt.
- Give long-running bash a cancellable request without the generic 30-second response timeout.

**Exit:** streaming, cancellation, truncation/full-output paths, context inclusion, and session resume all have integration coverage.

### Phase 3 — native image payloads on the current pin

- Change draft submission from a string to `{text, images}`.
- Resolve existing image tokens to bounded `ImageContent` values at dispatch.
- Send images through `prompt`, and later through native `steer`/`follow_up`.
- Preserve tokens and attachment metadata through history; never persist base64 in diagnostics. Treat lossless native queue/dequeue recovery as blocked on structured upstream queue entries or an explicit, narrowly scoped host-retention design.
- Test supported and unsupported model behavior, multiple images, deleted temp files, whitespace paths, and session hydration.

**Exit:** the first user message received from Pi contains image content blocks, not only filesystem path text.

### Phase 4 — native Pi queue cut-over on the future release

- Add a visible, key-addressable SumoCode delivery toggle with values `steer` and `follow-up`; initialize it to `steer`. Keep this state separate from Pi's `one-at-a-time`/`all` queue-drain modes.
- Make Enter use `prompt(streamingBehavior:<selected mode>)` and keep Alt+Enter as an explicit one-shot `prompt(streamingBehavior:"followUp")`, including when the host currently believes Pi is idle; `AgentSession` ignores the option while idle, which closes the idle/streaming observation race.
- Add `clear_queue`, `set_steering_mode`, and `set_follow_up_mode` controls; keep direct `steer`/`follow_up` wrappers optional rather than using them for editor submission.
- Make `queue_update` the sole pending-queue snapshot.
- Match classic Pi by default: Enter steers, Alt+Enter defers, Alt+Up restores, and Escape restores then aborts. When the SumoCode toggle is set to `follow-up`, only busy Enter changes to deferred delivery. Avoid clear-and-requeue promotion tricks that create new races.
- Preserve only a compaction/summarization-local queue and flush it after `compaction_end`, mirroring the classic client's broad `isCompacting` special case.
- Treat compaction/branch-summary Escape as explicit upstream-blocked parity items until RPC exposes dedicated cancellation commands; generic `abort` is not equivalent.
- Gate queued images until their clear/restore behavior is lossless, or land an upstream structured-queue response first.
- Clear Pi queues before session replacement and abort where user intent is to recover drafts.
- Delete host queue ownership, force-steer ownership inference, generation counters, and composed host/Pi queue state once parity tests pass.

**Exit:** no host code decides when queued prompts become new Pi runs; Pi owns delivery and SumoCode owns only draft/editor presentation.

### Phase 5 — main stream enrichments and topology cleanup

- Apply `message_update.usage` opportunistically to footer totals, then reconcile with final messages/stats.
- Use `toolcall_start.id/toolName` to seed early activity only when present.
- Consume `entry_appended` for tree/cursor invalidation.
- Cross-check local topology against `get_tree`; simplify only where it does not weaken cursor or navigation recovery.
- Stop sending responses for fire-and-forget UI methods.

**Exit:** both old and new event shapes render correctly, and every retained local divergence has an explicit reason.

## Verification matrix

The upgrade should not be considered complete with unit types alone. Add or retain these contracts:

| Area | Required evidence |
|---|---|
| Transport | LF-only/U+2028/U+2029 fixtures; correlation; late response after timeout; unknown event; malformed response; child exit; stderr bounds. |
| Lifecycle | Real Pi traces for success, abort, automatic retry success/failure, threshold compaction, overflow compaction retry, summarization retry, and queued continuation. |
| Queue | Default toggle state is `steer`; toggling changes busy Enter to follow-up without affecting idle Enter; Alt+Enter remains explicit follow-up; ordering for both Pi queue-drain modes; queue updates; clear/restore before abort; compaction queue flush preserves selected delivery; session switch with pending queues; queued-image recovery or an intentional gate; explicit compaction-cancel capability gate. |
| Bash | Streaming chunks beyond final truncation, cancellation, non-zero exit, exclusion from context, next-prompt conversion, and resume. |
| Images | Clipboard and pasted paths become `ImageContent`; token/history preservation; no base64 diagnostics; missing file errors. |
| Extension UI | Four dialogs, five fire-and-forget requests, timeout, unknown method, auth secret masking, and no extra response for fire-and-forget. |
| Session | New/switch/fork/clone hydration barriers; entries cursor; local tree versus `get_tree`; hidden navigation command failure/cancellation. |
| Upgrade | Compile/typecheck against the target Pi release; exact command/event/UI fixture inventory; hardcoded built-in slash list review; tool-bypass/security regression; direct-Pi launcher bypass. |

For code changes, the repository's required final gate remains:

```bash
pnpm exec tsc --noEmit
pnpm build
pnpm test
pnpm test:integration
pnpm visual:ci
```

Visual golden promotion still requires explicit human approval.

## Audit method and primary sources

This audit compared:

- Pi's pinned `0.84.1` package/tarball and RPC implementation at [`53fa77ccd8a279eb87e92294ef3687b03ff80112`](https://github.com/earendil-works/pi/tree/53fa77ccd8a279eb87e92294ef3687b03ff80112).
- Pi current main's [RPC documentation](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md), [wire types](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-types.ts), [dispatcher](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-mode.ts), [JSON event transform](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/json-event.ts), and [official client](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/modes/rpc/rpc-client.ts).
- SumoCode's RPC client, controls, host, scheduler, state, editor, extension UI responder, transcript controller, session snapshots, host actions, spawn plan, and related unit/integration tests.

This is a read-only design audit. No runtime behavior, dependency version, or visual golden was changed.
