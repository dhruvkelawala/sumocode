# Plan 081: Live ActivityStore and in-place retained cards

> **Executor instructions**: Execute in an isolated worktree based on approved Plans 079 and 080. Follow the steps and verification in order. Stop on a STOP condition. Do not change Pi's RPC protocol/private internals, delete files, touch `.pi-subagents/`, push, merge, or promote visual goldens.
>
> **Drift check (run first)**:
>
> ```bash
> git fetch origin main
> git diff --stat acf6ae2..origin/main -- \
>   src/activity \
>   src/background-tasks \
>   src/subagents \
>   src/sumo-tui/rpc \
>   src/sumo-tui/widgets/chat-pager.ts \
>   src/sumo-tui/transcript
> git status --short
> ```
>
> Confirm the Plan 079 Activity domain and Plan 080 terminal API/state machine exist at the branch base. Preserve newer behavior; never use `git reset --hard` or `git clean`.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Category**: retained runtime / cross-process state
- **Depends on**: Plans 079, 080, 082
- **Planned at**: `acf6ae2`, 2026-07-22
- **Execution status**: TODO
- **Role**: final integration slice

## Decision

Add a session-bound `ActivityStore` read model that gives the retained RPC host immutable, replayable snapshots and drives keyed in-place card updates. Do not append progress records to the Pi session and do not add a custom Pi RPC channel: session entries are append-only, while Activity cards must update in place.

Use a single-writer durable feed per extension runtime and a separate host-owned UI-state document. This preserves activity across RPC host reloads without creating competing writers.

## Architecture

For each session, store under the Pi agent state root (or a configurable SumoCode state root):

```text
sumocode/activity/v1/<sha256(sessionId)>/
  feed.json   # extension-side bridge owns this file
  ui.json     # retained host owns this file
```

Never place raw session IDs in path names. Directories are `0700`; files are `0600`. Writes are temp-file + flush/close + same-directory atomic rename.

`feed.json` contains bounded `ActivitySnapshot` values only. It is a read model, not the source of truth for terminal process lifecycle or subagent execution. `ui.json` contains expansion overrides only.

## Store interface

Create:

- `src/activity/store.ts`
- `src/activity/store.test.ts`
- `src/activity/feed-publisher.ts`
- `src/activity/feed-publisher.test.ts`
- `src/activity/output-tail.ts`
- `src/activity/output-tail.test.ts`

Target API:

```ts
interface ActivityStoreSnapshot {
	readonly ownerSessionId?: string;
	readonly revision: number;
	readonly activities: readonly ActivitySnapshot[];
	readonly expansion: Readonly<Record<string, boolean>>;
}

interface ActivityStore {
	bindSession(ownerSessionId: string | undefined): ActivityStoreSnapshot;
	getSnapshot(): ActivityStoreSnapshot;
	subscribe(listener: (snapshot: ActivityStoreSnapshot) => void): () => void;
	setExpanded(id: string, expanded: boolean): void;
	setAllExpanded(expanded: boolean): void;
	dispose(): void;
}
```

Required behavior:

- `subscribe` immediately replays one complete immutable snapshot.
- Semantic equality suppresses revisions and renders.
- Bind generation ignores stale watcher callbacks from the previous session.
- Corrupt/unknown-schema files retain the last known-good snapshot and emit diagnostics.
- Atomic replacement and initially missing files are both observed.
- Watcher loss is covered by a low-frequency unref'd poll; debounce bursts.
- `dispose` clears watchers, debounce/poll timers, and listeners.

## Limits

- Per-activity output tail: newest 16 KiB and at most 25 lines.
- Feed retention: every running activity plus newest 64 settled activities, no older than seven days.
- Tail reads preserve valid UTF-8 and never split multibyte code points.
- Feed snapshots contain no unbounded transcripts, raw environment, secrets, ANSI, or control sequences.
- Expansion is never producer-owned.

## Implementation steps

### 1. Build and test the durable store

Implement the interfaces and atomic read/write helpers. Test:

- immediate replay
- immutable prior snapshots
- missing feed creation
- atomic replacement
- corrupt/unknown schema
- owner rebind and stale callback rejection
- semantic no-op suppression
- emoji boundary and ANSI/control stripping
- retention and output bounds
- teardown with no live handles

No filesystem watcher may keep the process alive after disposal.

### 2. Publish manager projections from one bridge

Create `src/activity/manager-bridge.ts` and tests. Construct it after terminal and subagent managers exist in `src/extension.ts`.

The bridge is the sole `feed.json` writer. It:

- subscribes to manager changes
- projects terminal and subagent snapshots through Plan 079/082 adapters
- debounces high-frequency subagent deltas
- polls output only while terminals are running
- loads retained settled feed records before first publish
- reconciles dead, unrecoverable running records to `lost`
- publishes old-session terminal updates to their owner feed even while another session is active
- publishes session-shutdown subagents as cancelled/lost according to their manager truth

Add replayable change subscription to the terminal manager if Plan 080 does not already expose one. Use immutable snapshots; do not leak manager internals.

### 3. Bind the retained RPC host lifecycle

Modify and test:

- `src/sumo-tui/rpc/host.ts`
- `src/sumo-tui/rpc/host.test.ts`
- `src/sumo-tui/rpc/runtime.ts`
- `src/sumo-tui/rpc/runtime.test.ts`
- `src/sumo-tui/rpc/shell-adapter.ts`
- `src/sumo-tui/rpc/shell-adapter.test.ts`
- `src/sumo-tui/rpc/state.ts`
- `src/sumo-tui/rpc/state.test.ts`

Required order after host boot/session change:

1. refresh authoritative RPC state
2. rebind prompt scheduler
3. bind ActivityStore to `sessionId`
4. rehydrate transcript
5. apply one combined runtime update

Subscribe before first paint. Reject snapshots whose owner differs from current `sessionId`. An activity-only resumed session bypasses the splash. Dispose ActivityStore before stopping the RPC client.

Do not modify Pi RPC types, `src/sumo-tui/rpc/controls.ts`, or Pi internals.

### 4. Reconcile keyed cards in ChatPager

Modify and test:

- `src/sumo-tui/widgets/chat-pager.ts`
- `src/sumo-tui/widgets/chat-pager.test.ts`
- `src/sumo-tui/widgets/chat-message.ts`
- `src/sumo-tui/transcript/view-model.ts`
- add `src/sumo-tui/transcript/activity-view-model.ts` and tests if needed

Use Activity IDs as keyed node identity. Requirements:

- first sight appends one card at chronological arrival
- update mutates/replaces that card in place and adjusts height
- object/node identity, read state, manual scroll state, unread count, and expansion override survive
- completion custom messages claim/update the same card instead of appending a duplicate
- feed and transcript ownership are tracked separately; expiry from the feed must not delete a transcript-owned historical completion
- only currently live feed cards are exempt from the normal transcript virtualization limit

Do not use full `replaceViewModels()` for each feed update.

### 5. Wire expansion persistence

Connect Plan 079 pager expansion APIs to `ui.json`:

- individual toggles write only that activity ID
- global Ctrl+O updates all currently known activity IDs and the default policy
- producer updates never write expansion
- restart/rebind reloads expansion before first card paint

### 6. Integration and visual evidence

Create/modify:

- `test/integration/rpc-activity-cards.test.ts`
- `test/integration/rpc-child-fixture.ts`
- session-switch integration coverage
- `scripts/visual-v2/fixture-capture.mjs`
- `scripts/gen-bible-scene-active.mjs`
- `docs/visual/parity/scenarios.json`
- `docs/visual/parity/FIXTURE_STATES_REVIEW.md`
- `docs/SUMO_TUI_TRANSCRIPT_MODEL.md`
- `docs/ui/CATHEDRAL_UX_SPEC_V2.md`

Required runtime proofs:

- feed creation displays a card without another RPC event
- same ID moves running→output update→completed with one node
- Ctrl+O state survives host restart
- session A→B hides A; updates to A remain invisible; resume A restores cards
- activity-only session bypasses splash
- host exit leaves no watchers/timers
- output remains bounded under a noisy command

Add deterministic landscape and 60×100 portrait scenes with running subagent, running terminal, completed terminal, failure, and collapsed/expanded examples. Portrait remains no-sidebar. Review text-level reports before PNGs.

## Verification

```bash
pnpm vitest run \
  src/activity/output-tail.test.ts \
  src/activity/store.test.ts \
  src/activity/feed-publisher.test.ts \
  src/activity/manager-bridge.test.ts \
  src/sumo-tui/rpc/state.test.ts \
  src/sumo-tui/rpc/host.test.ts \
  src/sumo-tui/rpc/runtime.test.ts \
  src/sumo-tui/rpc/shell-adapter.test.ts \
  src/sumo-tui/widgets/chat-pager.test.ts
pnpm exec tsc --noEmit && pnpm build
pnpm test
pnpm test:integration
pnpm render:bible
pnpm visual:review -- --scenario fixture-activity-cards-landscape
pnpm visual:review -- --scenario fixture-activity-cards-portrait
pnpm visual:ci
```

Inspect each scenario's `raw/styled-cell-diff.txt` and `raw/geometry-audit.txt`. Do not run `pnpm visual:promote` without Dhruv's explicit approval.

## STOP conditions

Stop and report if:

1. Host `get_state.sessionId` and extension `ctx.sessionManager.getSessionId()` disagree in a real PTY run.
2. Correctness requires multiple writers to `feed.json` or `ui.json`, unsafe lock stealing, or a custom Pi RPC protocol.
3. Keyed reconciliation changes unrelated transcript messages or resets scroll/read state.
4. Any previous-session activity is visible after a session switch.
5. UTF-8/control stripping or size/row bounds cannot be guaranteed.
6. Watchers/timers keep the host alive after dispose.
7. The work expands into a fleet dashboard, sidebar registry, or takeover UI.
8. A file deletion, Pi private patch, or visual golden promotion becomes necessary.

## Out of scope

- New execution tools or terminal semantics
- Full subagent transcript persistence
- Sidebar/fleet dashboard, takeover, filtering, or search
- Pi RPC changes, built-in tool re-registration, or unbounded logs
- Golden promotion
