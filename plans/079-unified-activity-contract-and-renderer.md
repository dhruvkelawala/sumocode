# Plan 079: Unified Activity contract and universal retained renderer

> **Executor instructions**: Execute this plan in an isolated worktree. Follow the steps and verification in order. Stop on a STOP condition instead of improvising. Do not push, merge, delete files, promote visual goldens, or touch `.pi-subagents/`. This plan establishes the shared contract required by Plans 080–082; do not add execution lifecycle or file-feed infrastructure here.
>
> **Drift check (run first)**:
>
> ```bash
> git fetch origin main
> git diff --stat acf6ae2..origin/main -- \
>   src/sumo-tui/transcript/view-model.ts \
>   src/sumo-tui/transcript/controller.ts \
>   src/sumo-tui/transcript/tool-renderer.ts \
>   src/sumo-tui/transcript/scroll-renderer.ts \
>   src/sumo-tui/widgets/chat-message.ts \
>   src/sumo-tui/widgets/chat-pager.ts \
>   src/sumo-tui/rpc/host.ts
> git status --short
> ```
>
> Reconcile drift against live `origin/main`. Preserve the plaintext/tool wrapping work merged in PR #342. Never use `git reset --hard` or `git clean`.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Category**: retained transcript architecture / UX
- **Depends on**: —
- **Planned at**: `acf6ae2`, 2026-07-22
- **Execution status**: TODO
- **Unblocks**: Plans 080, 081, 082

## Decision

Introduce one renderer-neutral Activity domain and one retained Activity renderer. Tools, native tasks, subagents, and terminals may keep separate execution machinery, but their transcript presentation converges on `ActivitySnapshot` and stable ID-based merging.

Expansion is UI state. It must never be reset by a producer update. Unknown/custom tools must always show bounded, sanitized input/output/error information; the literal `Preview collapsed` / `preview collapsed` is removed from production and tests.

## Product semantics

1. Running Activity cards default expanded and show invocation plus current output/progress.
2. Settled cards preserve the user's current expansion state and show a useful compact result preview.
3. Failed cards auto-expand only if the user has not explicitly chosen an expansion state.
4. Empty running content says `waiting for output…`; empty settled content says `no output captured`.
5. Multiple same-name activities remain distinct through stable IDs.
6. Updates mutate/fold the existing activity block; they never append a second completion card.
7. Generic rendering is terminal-safe and bounded: no raw ANSI/control sequences, unbounded JSON, circular serialization crash, or secret-field dump.

## Target contract

Create `src/activity/domain.ts` with no Pi, TUI, theme, ANSI, filesystem, or process imports:

```ts
export type ActivityKind = "tool" | "task" | "subagent" | "terminal";
export type ActivityStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "lost";
export type ActivityBody =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "source"; readonly text: string; readonly startLine?: number; readonly totalLines?: number }
	| { readonly kind: "diff"; readonly text: string }
	| { readonly kind: "terminal"; readonly command?: string; readonly text: string };

export interface ActivitySnapshot {
	readonly id: string;
	readonly kind: ActivityKind;
	readonly title: string;
	readonly status: ActivityStatus;
	readonly invocation?: unknown;
	readonly subject?: string;
	readonly currentStep?: string;
	readonly outputTail?: string;
	readonly body?: ActivityBody;
	readonly activeTools?: readonly ActivitySnapshot[];
	readonly result?: { readonly summary?: string; readonly error?: string };
	readonly ownerSessionId?: string;
	readonly createdAt?: number;
	readonly updatedAt?: number;
	readonly settledAt?: number;
	readonly model?: string;
	readonly thinking?: string;
	readonly metrics?: { readonly tokensIn?: number; readonly tokensOut?: number; readonly costUsd?: number; readonly turns?: number; readonly elapsedMs?: number };
}
```

Names may be refined if tests demonstrate a clearer deep interface, but the concepts and invariants are fixed. Add:

- `mergeActivitySnapshot(existing, incoming)` — absent incoming fields preserve existing data; child activities merge by ID; terminal state cannot regress to queued/running.
- `sameActivity(existing, incoming)` — match stable ID first; allow an explicit correlation/source ID only where a tool call later learns a canonical task ID.
- bounded/safe value preview helpers with deny-listed secret keys (`token`, `authorization`, `password`, `secret`, `cookie`, `apiKey`, case-insensitive).

## Scope

### 1. Add the domain and Pi projectors

Create:

- `src/activity/domain.ts`
- `src/activity/domain.test.ts`
- `src/activity/pi-projector.ts`
- `src/activity/pi-projector.test.ts`

Project ordinary Pi tool records into Activities:

- `read` / `write` → source body
- `edit` → diff body
- `bash` → terminal body
- unknown/MCP/custom tools → generic text body from error, output, then safe bounded invocation
- status normalization: pending→queued, running→running, success/done→succeeded, error/failed→failed, cancelled→cancelled

Require `toolCallId` for live correlation. For historical records without one, generate deterministic message-and-block-scoped fallback IDs; never use only the tool name.

### 2. Add one Activity renderer

Create:

- `src/sumo-tui/transcript/activity-renderer.ts`
- `src/sumo-tui/transcript/activity-renderer.test.ts`

Use typed primitives from `src/sumo-tui/render/primitives.ts`. Preserve current tool-ledger visual roles and budgets:

- maximum 25 source/output rows and 31 total rows
- maximum four invocation-preview rows
- one consolidated truncation marker
- exact requested terminal width
- visible-width-safe wrapping
- sanitized output before measurement

Move/reuse the specialized source, diff, and terminal body behavior from `tool-renderer.ts`. Keep `tool-renderer.ts` and `scroll-renderer.ts` as forwarding compatibility wrappers if still imported; do not delete files.

### 3. Migrate the transcript block and reducer

Modify:

- `src/sumo-tui/transcript/view-model.ts`
- `src/sumo-tui/transcript/view-model.test.ts`
- `src/sumo-tui/transcript/controller.ts`
- `src/sumo-tui/transcript/controller.test.ts`
- `src/sumo-tui/pi-compat/chat-viewport-controller.ts`
- corresponding compatibility tests

Add `{ type: "activity"; activity: ActivitySnapshot }` to `ChatBlock`. Route ordinary tools through it. Replace duplicate tool/delegation matching and terminal-state merge logic with shared Activity helpers.

A temporary `delegation` bridge may remain for fixtures until Plan 082, but new ordinary tool records must use `activity`. Do not alter built-in tool registration or Pi's RPC protocol.

### 4. Make expansion presentation-owned

Modify:

- `src/sumo-tui/widgets/chat-message.ts`
- `src/sumo-tui/widgets/chat-message.test.ts`
- `src/sumo-tui/widgets/chat-pager.ts`
- `src/sumo-tui/widgets/chat-pager.test.ts`
- `src/sumo-tui/rpc/host.ts`
- relevant host/runtime tests

Store per-activity explicit expansion overrides keyed by Activity ID, plus a default policy. Provide a small pager API to get/set/toggle expansion. Reapply overrides during add, replace-last, hydration, and virtualization. Remove the host-local blind expansion boolean.

Required tests:

- running default expanded
- settled update preserves explicit expanded/collapsed state
- failed auto-expands only without explicit state
- same-name/different-ID activities remain independent
- full hydration does not reset state
- replacing the last view model preserves scroll/read state

### 5. Remove contentless fallbacks and update documentation

Update:

- `docs/SUMO_TUI_TRANSCRIPT_MODEL.md`
- `docs/SUMO_TUI_RENDER_PRIMITIVES.md` only if the shared rendering guidance changes
- affected deterministic fixtures/tests

Final search:

```bash
rg -ni 'preview collapsed' src test scripts docs/ui/bible
```

Expected: no matches. Do not replace it with another contentless synonym.

## Tests and evidence

Mandatory cases:

- unknown tool with output, error, safe invocation, empty running, and empty settled states
- cyclic and huge invocation objects
- ANSI, tabs, carriage returns, wide characters, and secret-shaped fields
- stable merge for simultaneous same-name tools
- no terminal-state regression
- child Activity merge by ID
- bounded row count and exact width
- expansion preserved across live update and replay hydration

## Verification

```bash
pnpm vitest run \
  src/activity/domain.test.ts \
  src/activity/pi-projector.test.ts \
  src/sumo-tui/transcript/activity-renderer.test.ts \
  src/sumo-tui/transcript/view-model.test.ts \
  src/sumo-tui/transcript/controller.test.ts \
  src/sumo-tui/widgets/chat-message.test.ts \
  src/sumo-tui/widgets/chat-pager.test.ts
pnpm exec tsc --noEmit && pnpm build
pnpm test
pnpm test:integration
pnpm visual:review -- --scenario fixture-tool-ledger-landscape
pnpm visual:ci
rg -ni 'preview collapsed' src test scripts docs/ui/bible
```

Inspect the scenario's styled-cell and geometry reports. Produce review evidence, but do not run `pnpm visual:promote`.

## STOP conditions

Stop and report if:

1. Pi live/replay records do not provide a stable `toolCallId`, and deterministic correlation cannot be proven.
2. In-place updates require full transcript reconstruction or reset scroll/unread state.
3. Generic fallback cannot guarantee width/row bounds, control stripping, and secret redaction.
4. The implementation requires re-registering a built-in tool, changing Pi internals/RPC protocol, or importing SumoTUI into the domain module.
5. In-scope code materially drifted from `acf6ae2` and the merged behavior cannot be preserved.
6. A file must be deleted or a visual golden promoted; obtain Dhruv's explicit approval first.

## Out of scope

- Terminal tool regrammar or completion policy (Plan 080)
- Durable cross-process Activity feed (Plan 081)
- Subagent/native-task adapters (Plan 082)
- Fleet dashboards, sidebar activity lists, takeover UI, or new Pi RPC commands
