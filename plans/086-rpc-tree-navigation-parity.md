# Plan 086: Restore long-session-safe Pi `/tree` navigation parity

> **Renumbering note**: this plan was provisionally numbered 083 and became 086 after
> upstream plans 083–085 landed for unrelated roles/subagent work. Execution-evidence
> artifacts below (worktrees, branches, PR #350) retain their original plan-083 names.
>
> **Executor instructions**: Follow this plan in order. Run every verification
> gate and confirm the expected result before continuing. If any STOP condition
> occurs, stop and report evidence; do not patch Pi, raise the JavaScript stack,
> mutate session JSONL directly, or substitute `/fork` for navigation.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 3ca11da..HEAD -- \
>   src/extension.ts \
>   src/sumo-tui/pi-compat \
>   src/sumo-tui/rpc/client.ts \
>   src/sumo-tui/rpc/controls.ts \
>   src/sumo-tui/rpc/editor.ts \
>   src/sumo-tui/rpc/extension-ui-responder.ts \
>   src/sumo-tui/rpc/host-actions.ts \
>   src/sumo-tui/rpc/host.ts \
>   src/sumo-tui/rpc/session-reader.ts \
>   test/integration \
>   docs/ui/bible \
>   docs/visual/parity/scenarios.json \
>   scripts/visual-v2/component-capture.mjs
> ```
>
> If an in-scope file changed, compare the live implementation with this plan's
> excerpts and assumptions. Reconcile compatible changes explicitly. If Pi is
> no longer pinned to `0.83.x`, re-verify the public extension and RPC contracts
> before implementation.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 078's host-owned queued-prompt restoration
- **Supersedes**: Plan 035 Phase 3's obsolete claim that a new Pi RPC verb is required
- **Category**: bug / parity
- **Planned at**: commit `3ca11da`, 2026-08-04
- **Execution status**: IN PROGRESS — implementation complete and published as PR [#350](https://github.com/dhruvkelawala/sumocode/pull/350). Commits `339e462`, `02c8318`, and `c0160f8`; full unit/integration/visual gates pass and final Claude Opus 4.8 autoreview is clean. Awaiting CI and human merge.

## Outcome

`/tree` navigates to a selected point **inside the current Pi session file** and
offers Pi's three branch-summary choices:

1. `No summary`
2. `Summarize`
3. `Summarize with custom prompt`

A 6,000+ entry linear session opens under `/tree` and `/fork` without recursive
stack overflow. `/fork` remains a distinct operation that creates a replacement
session. The repair uses Pi 0.83's public `ExtensionCommandContext.navigateTree()`
and flat/delta RPC data; it does not patch Pi or increase stack limits.

## Why this matters

The reported long session contains 6,042 entries in a 6,036-node parent chain.
Compaction reduced LLM context but did not shorten the append-only parent chain.
SumoCode recursively walks that chain in two places, producing:

```text
RangeError: Maximum call stack size exceeded
```

The visible error is surfaced as `rpc: Maximum call stack reached`. Official Pi
does not solve this by increasing V8's stack. Its tree selector uses an explicit
stack and bounds rendering to the viewport.

SumoCode's current `/tree` also has the wrong meaning: it presents a tree but
calls `fork()`, creating a new session. Pi `/tree` changes the active leaf in
place and can summarize the abandoned branch. Pi `/fork` creates a separate
session and never asks for a branch summary. Those contracts must remain
separate in code and tests.

## Locked architecture decisions

### 1. Bridge through a child command with a correlated outcome

Pi 0.83 does not expose an RPC `navigate_tree` command, but it does expose
`ctx.navigateTree()` to extension command handlers running in the RPC child.
Register one hidden SumoCode compatibility command in the reduced RPC child
profile and invoke it through the documented RPC `prompt` command, matching the
existing `/login` compatibility-command pattern.

RPC `prompt` proves only that extension-command preflight completed. It does not
carry the handler result, and Pi converts a thrown handler error into an
`extension_error` event followed by a successful prompt response. The bridge
must therefore publish a correlated outcome through Pi's existing
`extension_ui` `setStatus` channel:

```ts
interface RpcTreeNavigationRequest {
	readonly requestId: string;
	readonly targetId: string;
	readonly summarize: boolean;
	readonly customInstructions?: string;
}

interface RpcTreeNavigationOutcome {
	readonly requestId: string;
	readonly status: "committed" | "cancelled" | "error";
	readonly leafId: string | null;
	readonly editorText?: string;
}
```

Use reserved key `sumocode.rpc-tree-navigation-result`. The host responder
intercepts that key before ordinary status publication and delivers its
base64url value to a host-owned outcome broker; it must never render or persist
the machine payload. Register the waiter before sending the command so an early
outcome cannot race past the RPC `prompt` response. `controls.navigateTree()`
awaits both prompt completion and the matching outcome; generic
`executeExtensionCommand()` remains unchanged.

The handler must:

- require `ctx.mode === "rpc"` and `ctx.hasUI`;
- decode and strictly validate the payload and reject unknown fields;
- read selected user/custom-message text before navigation, but not call
  `ctx.ui.setEditorText()` itself;
- call `ctx.navigateTree(targetId, { summarize, customInstructions })` without
  `replaceInstructions`, so a custom prompt augments Pi's default prompt exactly
  as official Pi does;
- publish exactly one committed/cancelled/error outcome, including the
  authoritative post-operation `ctx.sessionManager.getLeafId()`;
- catch navigation errors, publish `error`, and notify a terse generic message
  so no `extension_error` is emitted and payload contents never leak.

The host applies returned `editorText` only when its editor is still blank after
queued-draft restoration and hydration. Do not import `AgentSession`, reflect
its private fields, or duplicate Pi's branch-summary/session mutation algorithm.

Use executable validation limits:

- encoded payload: at most 24,576 bytes;
- decoded JSON: at most 18,432 UTF-8 bytes;
- `requestId`: canonical UUID;
- `targetId`: 1–256 UTF-8 bytes after trim, with no control characters;
- `customInstructions`: at most 16,384 UTF-8 bytes and present only when
  `summarize === true`;
- base64url: unpadded `[A-Za-z0-9_-]+` whose decode/re-encode round trip matches;
- exact own keys only; `summarize` must be boolean.

### 2. Keep deep data flat across the process boundary

Do not call RPC `get_tree`. It returns recursively nested children and Pi writes
RPC responses with `JSON.stringify`; a roughly 3,000-level linear tree can fail
before SumoCode receives it.

Do not request full `get_entries` on every tree open either. On the exact
6,042-entry reproduction, the response was 33,865,685 bytes. Preserve the
existing efficient streaming JSONL read, then use:

```ts
{ type: "get_entries", since: lastOnDiskEntryId }
```

This returns only entries appended after the disk scan plus the authoritative
in-memory `leafId`. On the exact reproduction, the steady-state response was
118 bytes. If the session is ephemeral, the file is unavailable, or the cursor
is rejected, fall back to one full flat `get_entries` request. Never fall back
to `get_tree`.

Refactor the disk reader to expose identity and cursor data:

```ts
interface SessionDiskEntries {
	readonly sessionId: string;
	readonly entries: readonly SessionEntryLike[];
	readonly lastEntryId: string | null;
}

interface SessionEntrySnapshot {
	readonly entries: readonly SessionEntryLike[];
	readonly leafId: string | null;
}
```

The `since` cursor is exclusive. A valid response omits the cursor entry and
always includes authoritative `leafId`, even when its delta is empty. Validate
that the disk header session ID matches current `get_state.sessionId`; reject
duplicate IDs when merging.

Use one full flat fallback only for a missing/unreadable file, zero disk
entries, a header/session mismatch, or Pi's specific cursor-not-found response.
Propagate timeouts, child exit, and unrelated RPC errors without issuing a
second 30+ MB request. `/fork` timestamp enrichment is optional: if its
local/delta metadata path fails, show rows without ages rather than requesting
a full fallback solely for decoration.

Build and flatten the tree from the flat snapshot with iterative algorithms.
The same flat entries supply `/fork` timestamp metadata; `/fork` must no longer
build and recursively re-walk a nested disk tree.

### 3. Reconcile an in-place mutation, not a replacement session

`/tree` keeps `sessionId`, `sessionFile`, and the child extension instance. It
must not call `applySessionChange()` as though Pi replaced the session.
Introduce a narrowly named same-session navigation lifecycle that:

1. captures session ID/file, editor text, leaf, and pager state;
2. synchronously restores host-queued prompts with `discardInFlight: true`;
3. awaits `controls.abort()` when streaming;
4. buffers normal AgentSession events without beginning session replacement;
5. executes the correlated hidden command with a named 20-minute
   `TREE_NAVIGATION_TIMEOUT_MS` (do not reuse the login constant);
6. always runs the existing quiet-pass `get_state` + `get_messages` hydration,
   including cancelled/error outcomes;
7. requires refreshed session identity to match the captured identity and a
   committed outcome's `leafId` to match authoritative `get_entries.leafId`;
8. replaces transcript content only for a committed mutation or when messages
   actually differ; otherwise replays the buffered suffix without pager reset;
9. applies returned selected text only when the current editor remains blank;
10. never rebinds scheduler/activity state, restarts the child, or emits
    replacement-session lifecycle events.

If identity unexpectedly changes, route through the existing fail-closed
replacement hydration rather than preserving stale presentation. Use the
existing transcript rehydration seam; do not invent a second transcript
authority. Pi's `session_tree` is an extension event, not a normal RPC
`AgentSessionEvent`, so do not depend on it arriving through the host stream.

While summarized navigation runs, expose a local branch-summary working state
and block concurrent prompts, `/tree`, `/fork`, and session mutations. Escape
and Ctrl-C do not cancel it under Pi 0.83. If the RPC request times out, do not
report success or cancellation: retain the mutation guard, poll
`get_state.isCompacting` until false or child exit, then reconcile
authoritatively.

### 4. Match Pi's choice and cancellation loop

After a non-current tree node is selected, close the tree selector and show
`Summarize branch?` with the three exact choices above.

- Escape from the summary selector reopens the tree with the same node selected.
- Escape from `Custom summarization instructions` returns to the summary choice.
- Selecting the current `leafId` is a no-op and reports `already at this point`.
- A committed navigation refreshes the transcript and reports success only
  after correlated outcome leaf, authoritative `get_entries.leafId`, and
  hydrated messages agree.
- Tree-node filtering, structural indentation, labels, timestamp de-duplication,
  and background-task wake filtering remain behavior-compatible.

Active branch-summary cancellation is explicitly outside the implementation
boundary described below because Pi 0.83 exposes no public RPC/context method
for it.

## Current state at `3ca11da`

### The failing recursion

`src/sumo-tui/rpc/host-actions.ts:450-479` recursively descends once for every
node in a linear chain:

```ts
const visit = (node: SessionTreeNode, depth: number, indent: string, glyphIndent: string, pendingGlyph: string): string => {
	// ...
	if (node.children.length > 1) {
		for (const [index, child] of node.children.entries()) {
			// ...
			visit(child, depth + 1, `${indent}${last ? "   " : "│  "}`, indent, last ? "└─ " : "├─ ");
		}
	} else if (node.children.length === 1) {
		glyph = visit(node.children[0]!, depth, indent, glyphIndent, glyph);
	}
	return glyph;
};
for (const root of roots) visit(root, 0, "", "", "");
```

`src/sumo-tui/rpc/host-actions.ts:500-508` repeats the same failure mode while
adding timestamps to `/fork` rows:

```ts
const visit = (node: SessionTreeNode): void => {
	if (typeof node.entry.id === "string" && typeof node.entry.timestamp === "string") map.set(node.entry.id, node.entry.timestamp);
	for (const child of node.children) visit(child);
};
for (const root of roots) visit(root);
```

`src/sumo-tui/rpc/session-reader.ts:309-335` already links and sorts nodes with
loops and an explicit stack. Do not regress that part back to recursion.

### `/tree` currently forks

`src/sumo-tui/rpc/host-actions.ts:1067-1122` labels the approximation honestly,
but still implements the wrong product contract:

```ts
const selected = await this.inlineSelectors.select("Session tree (fork from a node)", items, {
	initialValue: rows[rows.length - 1]?.node.entry.id,
});
// ...
const result = await this.applySessionChange(
	() => this.controls.fork(row.node.entry.id),
	(current) => { if (current.text) this.editorText?.setText(current.text); },
);
```

`src/sumo-tui/rpc/host-actions.ts:986-1028` independently implements real
`/fork` with Pi's `get_fork_messages` followed by `controls.fork()`. That path
must stay replacement-session behavior.

### The public Pi seam now exists

Pi 0.83's `dist/core/extensions/types.d.ts:274-282` declares:

```ts
navigateTree(targetId: string, options?: {
	summarize?: boolean;
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}): Promise<{
	cancelled: boolean;
}>;
```

Pi's RPC mode binds this context method to the active `AgentSession`, while
`AgentSession.navigateTree()` documents that it stays in the same file, rebuilds
agent context, emits tree lifecycle events, writes a branch summary when
requested, and restores selected user/custom-message text to its caller.

`src/sumo-tui/rpc/controls.ts:206-210` already provides the host-to-extension
command bridge:

```ts
public async executeExtensionCommand(message: string): Promise<void> {
	responseData(await this.client.send({ type: "prompt", message }, LOGIN_TIMEOUT_MS), "prompt");
	this.availableModelsCache = undefined;
}
```

`src/sumo-tui/rpc/extension-ui-responder.ts:128-141` already centralizes child
`setStatus` requests before retained-host publication, which is the narrow seam
for intercepting the reserved correlated outcome key:

```ts
case "setStatus":
	// ... existing login-specific handling ...
	this.statuses.set(request.statusKey, request.statusText);
	this.statusPublication?.setStatus(request.statusKey, request.statusText);
	this.onStatus?.(request.statusKey, request.statusText);
	this.onRenderRequest();
	return undefined;
```

The implementation must intercept only `sumocode.rpc-tree-navigation-result`
before these ordinary status side effects; all other keys retain this behavior.

### Official Pi's UX contract

Pi 0.83's `interactive-mode.js:3865-3890` uses the exact choice/cancellation
loop to port:

```ts
const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
	"No summary",
	"Summarize",
	"Summarize with custom prompt",
]);
if (summaryChoice === undefined) {
	this.showTreeSelector(entryId);
	return;
}
wantsSummary = summaryChoice !== "No summary";
if (summaryChoice === "Summarize with custom prompt") {
	customInstructions = await this.showExtensionEditor("Custom summarization instructions");
	if (customInstructions === undefined) continue;
}
```

It restores queued prompts and aborts an active response before committing tree
navigation. Preserve that sequencing through Plan 078's host-owned scheduler.

## Implementation steps

### Step 1 — Prove the bridge against real Pi before changing host UX

Create:

- `src/sumo-tui/pi-compat/tree-navigation-command.ts`
- `src/sumo-tui/pi-compat/tree-navigation-command.test.ts`

Register `sumo:rpc-tree-navigate` only in `installRpcChildProfile()` and add it
to `HIDDEN_RPC_COMMANDS` in `src/sumo-tui/rpc/editor.ts` so it never appears in
slash completion. Keep payload/outcome codecs in this compatibility module.
Add the correlated outcome broker at the existing extension-UI responder seam;
do not expose a generic custom-RPC channel.

Tests must cover:

- malformed/non-canonical base64, malformed JSON, unknown keys, every executable
  size/ID limit, and custom instructions paired with `summarize: false`;
- rejection outside RPC mode;
- exact forwarding for no summary, default summary, and multiline custom
  instructions;
- `replaceInstructions` is absent;
- exactly one correlated outcome for committed, cancelled, and error paths;
- a stale/wrong request ID cannot resolve a waiter;
- selected text is returned only for successful user/custom-message targets;
- assistant/bookkeeping targets return no editor text;
- thrown navigation errors become a terse notification without payload leakage
  or `extension_error`.

Create `test/integration/rpc-tree-navigation.test.ts` in this step with the
initial direct-Pi bridge/identity probe; extend the same file in Step 6. Launch
Pi with an isolated `PI_CODING_AGENT_DIR`, temporary session directory, and:

```text
--mode rpc --offline --approve --no-extensions
-e ./src/extension.ts
-e ./scripts/visual-v2/runtime-faux-provider.mjs
-e <temporary-tree-hook-extension>
--model sumocode-visual/active-working
--session <synthetic-session-file>
```

Set `SUMOCODE_RPC_CHILD=1`. The temporary hook extension writes only synthetic
lifecycle/tree evidence to a temporary file, returns a fixed summary, and can
veto one deterministic target. Invoke the hidden command over RPC and assert
session ID/file is unchanged. If this contract fails, STOP before host wiring.

### Step 2 — Introduce a flat, iterative session-tree module

Create `src/sumo-tui/rpc/session-tree.ts` and its colocated test. Move pure tree
projection and row flattening out of `host-actions.ts`; leave file I/O in
`session-reader.ts`.

Refactor `session-reader.ts` to expose a flat read result including the final
entry ID. Build labels, parent links, timestamp order, and visible rows from a
flat entry list. Use explicit stack frames that preserve the existing
`pendingGlyph` behavior exactly; a naive push/pop rewrite can consume branch
connectors on hidden nodes or reverse siblings.

Required pure tests:

- 6,001 linear entries flatten without throwing and produce 6,001 visible rows;
- a linear chain has structural depth zero and no `├─`/`└─` glyphs;
- branched siblings keep oldest-first order and correct continuation glyphs;
- hidden tool/bookkeeping nodes do not consume a pending connector;
- labels and label clears match current behavior;
- orphaned/self-parented entries become roots without cycling;
- duplicate IDs are rejected;
- a multi-entry parent cycle cuts one edge deterministically by promoting the
  earliest file-order cycle member to a root; every accepted unique entry is
  visited at most once;
- current selection uses authoritative `leafId`, falling back to its nearest
  visible ancestor when the leaf itself is filtered.

Delete the recursive `entryTimestampsFromTree()`. Build `/fork`'s timestamp map
with one loop over flat entries.

### Step 3 — Add authoritative flat/delta controls

Add a typed `getEntries(since?: string)` wrapper to `RpcHostControls` using Pi's
existing `{ type: "get_entries", since? }` command. Keep the normal 30-second
read timeout; this is not a model operation. Add a distinct
`navigateTree(request)` wrapper using `TREE_NAVIGATION_TIMEOUT_MS = 1_200_000`
and the correlated outcome broker; do not reuse the login constant or generic
`executeExtensionCommand()` return type.

Add a host-side snapshot helper that:

1. streams the current session file and validates its header ID when available;
2. requests `get_entries` since the final on-disk entry (exclusive cursor);
3. appends the returned delta, rejects duplicate IDs, and uses its `leafId`;
4. performs one full fallback only for missing/unreadable/empty disk data,
   identity mismatch, or the specific cursor-not-found response;
5. propagates timeout, child-exit, and unrelated failures;
6. never calls `get_tree` and never serializes a nested tree.

Tests must assert exact command payloads for no cursor and `since`, delta merge
without duplicate cursor entry, leaf divergence after no-summary navigation,
each allowed fallback, and non-fallback failures. The bounded 6,001-entry
assertion is: an unchanged persisted fixture queried with its final disk ID
returns zero delta entries, authoritative leaf, and a serialized response below
4 KiB.

Use this same snapshot for `/tree` and best-effort `/fork` timestamps. If
metadata enrichment fails, `/fork` still opens without ages, matching its
current best-effort contract.

### Step 4 — Replace `/tree`'s fork approximation

Rewrite `openTreeBrowser(initialSelectedId?: string)` as a loop/state machine,
not recursively nested modal callbacks:

1. load the flat authoritative snapshot;
2. build iterative visible rows;
3. open `Session tree` with `leafId` (or nearest visible ancestor) marked and
   preselected;
4. no-op if the selected ID equals `leafId`;
5. show the exact three-option summary selector;
6. collect an optional multiline custom prompt with the exact official title;
7. return to the preceding selector on Escape as specified above;
8. commit through a new `controls.navigateTree()` wrapper that awaits both the
   hidden command and its matching outcome;
9. reconcile state/messages in place, validate outcome leaf against the
   refreshed authoritative leaf, apply returned text only to a blank editor,
   and repaint.

Remove all `fork()` calls and replacement-session wording from `/tree`.
Preserve `/fork`'s `get_fork_messages` → `fork` path unchanged except for the
iterative timestamp source.

When the agent is streaming at commit time, restore queued prompts first and
await ordinary `abort()` before calling the bridge. Do not abort merely to open
or inspect the tree selector.

### Step 5 — Make same-session reconciliation explicit

In `host.ts`, implement the ten-step same-session mutation lifecycle from
Locked Decision 3 by extracting only the quiet-pass state/message hydration
from the replacement path. Keep its event barrier and authoritative transcript
construction, but do not call `runtime.beginSessionReplacement()`,
`scheduler.rebindSession()`, activity-session rebinding, child lifecycle hooks,
or replacement paint/reset behavior.

A committed user/custom-message target does not necessarily make `targetId` the
leaf, and summarized navigation creates a new summary leaf. Validate the
bridge-reported post-operation leaf against refreshed `get_entries.leafId`, not
against the selected ID. For cancelled/error outcomes whose messages did not
change, preserve pager position and replay only buffered events.

Add a local `branchSummary` mutation-busy reason at the existing host action
busy/working-state seam. It must render visible Cathedral working feedback and
prevent concurrent prompt/session mutations until correlated outcome plus
rehydration completes. On an ambiguous timeout, keep the guard and poll
`get_state.isCompacting`; never assume a timeout cancelled Pi's work.

Add diagnostics only when `SUMO_TUI_DIAG_FILE` is set:

- `tree.selector_loaded`
- `tree.navigation_started`
- `tree.navigation_finished`
- `tree.rehydrate_finished`
- `fork.selector_loaded`

Include elapsed time, entry count, summary mode, outcome status, and success.
Never log message text, custom instructions, session content, payloads, or
credentials.

### Step 6 — Add deterministic host and real-Pi regressions

Extend `src/sumo-tui/rpc/host-actions.test.ts` with:

- 6,001-entry `/tree` opens, renders the latest/current point, and escapes
  without mutation or `RangeError`;
- 6,001-entry `/fork` opens and selects a real user entry without recursive
  timestamp traversal;
- no-summary tree navigation never calls `fork`;
- default/custom summary options preserve exact arguments;
- current-leaf selection is a no-op;
- Escape behavior returns to the correct selector with selection preserved;
- streaming commit restores queued drafts before abort;
- same-session rehydration occurs once after completion;
- `/fork` still uses session replacement and selected-message editor restore.

Extend the `test/integration/rpc-tree-navigation.test.ts` bridge probe created
in Step 1. Generate synthetic fixtures only—never copy the user's session.

The integration test must prove:

- a 6,001-entry no-summary navigation keeps the same session ID and file while
  changing `leafId` and active messages;
- the extension instance does not shut down/restart for `/tree`;
- a deterministic `session_before_tree` extension observes default and exact
  custom instructions and returns a fixed summary without network credentials;
- `get_entries` contains the resulting `branch_summary` and `get_messages`
  contains the branch-summary message;
- an extension veto (`{ cancel: true }`) leaves leaf/messages unchanged;
- no `extension_error` event is emitted;
- ordinary `/fork` still changes session ID/file and replacement lifecycle.

Do not assert that `session_tree` appears on the RPC AgentSession event stream;
assert that the temporary extension observed it through Pi's extension event
hook.

### Step 7 — Produce exact project visual evidence

Update `docs/ui/bible/scene-session-selectors.html` so `/tree` no longer
canonizes `SESSION TREE (FORK FROM A NODE)`. Add dedicated single-terminal Bible
targets:

- `docs/ui/bible/scene-tree-selector.html`
- `docs/ui/bible/scene-tree-summary-choice.html`
- `docs/ui/bible/scene-tree-custom-summary-editor.html`

Extend `scripts/visual-v2/component-capture.mjs` with deterministic component
kinds `tree-selector`, `tree-summary-choice`, and
`tree-custom-summary-editor`. Add matching component-lane scenarios:

- `tree-selector-component`
- `tree-summary-choice-component`
- `tree-custom-summary-editor-component`

Reuse `fixture-track-b-transcript-landscape` for the completed branch-summary
pill; do not add a duplicate fixture. Use existing inline selector,
scriptorium/modal, and transcript primitives; read
`docs/SUMO_TUI_RENDER_PRIMITIVES.md` and
`docs/cathedral/SCRIPTORIUM_CHROME.md` before visual edits. Do not create a new
Cathedral overlay style or promote runtime goldens without explicit approval.

## Verification gates

Run in order; stop on the first failure.

### Gate 1 — compatibility bridge

```bash
pnpm vitest run \
  src/sumo-tui/pi-compat/tree-navigation-command.test.ts \
  src/sumo-tui/rpc/controls.test.ts \
  test/integration/rpc-tree-navigation.test.ts
```

Expected: bridge payloads/options, correlated outcomes/selected-text metadata,
in-place identity, and deterministic summary behavior pass with no network
credentials.

### Gate 2 — iterative data path and host actions

```bash
pnpm vitest run \
  src/sumo-tui/rpc/session-reader.test.ts \
  src/sumo-tui/rpc/session-tree.test.ts \
  src/sumo-tui/rpc/inline-selector.test.ts \
  src/sumo-tui/rpc/host-actions.test.ts \
  src/sumo-tui/rpc/host.test.ts
```

Expected: both 6,001-entry selectors open without stack growth; `/tree` never
forks; `/fork` still replaces the session.

### Gate 3 — related integration contracts

```bash
pnpm vitest run \
  test/integration/rpc-tree-navigation.test.ts \
  test/integration/extension-instance-lifecycle.test.ts \
  test/integration/rpc-session-switch.test.ts \
  test/integration/rpc-queued-message-undo.test.ts
```

Expected: tree navigation preserves session/extension identity and queued draft
semantics; fork/switch replacement behavior remains intact.

### Gate 4 — type/build and full suites

```bash
pnpm exec tsc --noEmit && pnpm build
pnpm test
pnpm test:integration
```

Expected: all commands exit zero.

### Gate 5 — visual evidence

```bash
pnpm render:bible
pnpm visual:review -- --scenario tree-selector-component
pnpm visual:review -- --scenario tree-summary-choice-component
pnpm visual:review -- --scenario tree-custom-summary-editor-component
pnpm visual:review -- --scenario fixture-track-b-transcript-landscape
pnpm visual:ci
```

Inspect the styled-cell and geometry reports under
`docs/visual/out/parity/<scenario>/raw/` for all four scenarios.

Expected: required geometry/styled-cell gates pass. Review captures are attached
for operator approval. No golden promotion is run.

### Gate 6 — manual exact-shape smoke

Create a disposable synthetic 6,001-entry session plus the same deterministic
temporary tree-hook extension used by integration tests, then launch with the
non-secret faux provider/model:

```bash
./bin/sumocode.sh -d --offline --no-extensions \
  -e <temporary-tree-hook-extension> \
  -e ./scripts/visual-v2/runtime-faux-provider.mjs \
  --model sumocode-visual/active-working \
  --session <synthetic-session.jsonl>
```

The long fixture has one version-3 header and 6,001 minimal entries in a linear
parent chain with deterministic unique IDs. Use a smaller branched synthetic
fixture for summary flows if needed; the 6,001-entry fixture is mandatory for
selector/no-summary transport safety.

Verify:

1. `/tree` opens quickly with bounded viewport rendering.
2. No-summary navigation keeps the displayed session identity and restores a
   selected user prompt when appropriate.
3. Default/custom summary flows complete and render a branch-summary pill.
4. `/fork` opens and creates a distinct session.
5. `bin/sumocode.sh diag` shows all bounded stages and no stack error.

Do not use or modify the user's original reproduction session for this gate.

## Acceptance criteria

- [ ] A 6,001-entry linear tree is built, flattened, filtered, and timestamped
      without recursion or `RangeError`.
- [ ] `/tree` uses in-place `ctx.navigateTree()` and never `fork()`.
- [ ] `/fork` still creates a replacement session and does not summarize.
- [ ] The three official summary choices and custom multiline instructions work.
- [ ] Current-leaf and all pre-commit cancellation paths are safe no-ops.
- [ ] User/custom-message target text is restored without clobbering a queued
      draft.
- [ ] Session ID/file and extension instance remain unchanged across `/tree`.
- [ ] Full nested `get_tree` is never requested; steady-state long sessions use
      flat delta retrieval.
- [ ] Real-Pi summary tests are deterministic and credential-free.
- [ ] Relevant unit, integration, typecheck/build, full, and visual gates pass.
- [ ] Visual evidence is reviewed; no golden is promoted without approval.

## Explicit non-goals

- Active Escape/Ctrl-C cancellation of an already-running branch summary.
- Pi tree filter-mode preference persistence, clipboard actions, or label editing.
- Changing summary prompts, branch-summary token settings, or model selection.
- Changing `/compact`, `/resume`, `/sessions`, launcher mode selection, or the
  RPC wire protocol.
- Importing Pi's interactive `TreeSelectorComponent` into SumoTUI.
- Editing `node_modules`, adding a private Pi patch, or increasing V8 stack size.
- Mutating session JSONL from the host.
- Visual golden promotion.

## STOP conditions

Stop and report evidence if any condition occurs:

1. The pinned Pi version no longer exposes public
   `ExtensionCommandContext.navigateTree()` or its behavior no longer preserves
   session ID/file.
2. Real Pi cannot deliver exactly one correlated outcome for every command
   path, or the host cannot register the waiter before an outcome can arrive.
3. A correct implementation requires private `AgentSession` reflection, direct
   JSONL mutation, a custom Pi RPC verb, or `get_tree`.
4. The 6,001-entry delta path repeatedly falls back to a full 30+ MB response or
   exceeds the existing RPC transport timeout twice; diagnose the cursor/race
   contract instead of raising limits.
5. Same-session navigation loses queued editor text, restarts the child, changes
   session identity, or cannot authoritatively rehydrate the selected branch.
6. Summary integration cannot be tested with a deterministic temporary
   extension; do not use live credentials.
7. Product acceptance expands to require Escape/Ctrl-C cancellation during an
   active summary. Pi 0.83 exposes `abortBranchSummary()` internally but neither
   RPC nor `ExtensionCommandContext` exposes it. Request an upstream public
   capability instead of adding a private seam.
8. Any visual diff requires golden promotion to pass. Capture evidence and ask
   Dhruv; do not promote automatically.

## Rejected alternatives

- **Raise `--stack_size`** — hides one recursive traversal and leaves nested RPC
  serialization plus future deep traversals unsafe.
- **Use RPC `get_tree`** — Pi can overflow while serializing the nested response.
- **Make `/tree` call `/fork`** — behaviorally wrong; changes session identity and
  omits branch summarization.
- **Load a second `AgentSession` in the host** — creates two authorities over the
  same file and breaks the RPC process boundary.
- **Reimplement navigation in the host** — bypasses Pi's context rebuild,
  lifecycle events, extension veto/summary hooks, usage accounting, and model
  settings.
- **Request full `get_entries` every time** — stack-safe but transfers roughly
  33.9 MB for the known 6,042-entry case when a 118-byte delta request suffices.
- **Fake active-summary cancellation with ordinary RPC `abort`** — Pi's `abort()`
  aborts the agent loop, not its separate branch-summary controller.

## Execution outcome — 2026-08-04

**Verdict: APPROVED FOR PR — ship the full three-commit stack, not `339e462` alone.**

Preserved worktree:

```text
/Users/dhruvkelawala/development/sumocode.sumo-worktrees/sumo__execute-plan-083-tree-parity-v2
```

Branch `sumo/execute-plan-083-tree-parity-v2` contains:

- committed implementation `339e462 fix(rpc): restore in-place tree navigation parity`;
- committed recovery hardening in `02c8318`, addressing outcome-promise rejection, bounded large-message outcomes, local request validation, retry/busy cleanup, post-abort leaf rebasing, interrupt blocking, cursor matching, and integration isolation;
- committed bounded compaction recovery in `c0160f8`, closing the final autoreview liveness finding.

Final evidence:

- `pnpm exec tsc --noEmit && pnpm build` — pass;
- `pnpm test` — 2,218 tests pass;
- `pnpm test:integration` — 65 tests pass;
- focused tree/host recovery suites — 115 tests pass;
- real-Pi tree-navigation integration — 4 tests pass;
- Bible render, four Plan 086 visual reviews (executed under provisional numbering 083), and `pnpm visual:ci` — pass;
- final `/apr` review: Claude Opus 4.8, branch mode against `origin/main`, clean with no accepted/actionable findings after fixing one P2 liveness issue;
- ready-for-review PR: [#350](https://github.com/dhruvkelawala/sumocode/pull/350).

No visual goldens were promoted. Manual interactive Gate 6 remains the human
canary before merge if desired.

## Maintenance note

On every future Pi bump, re-check:

- `ExtensionCommandContext.navigateTree()` options/result;
- RPC `get_entries` cursor and `leafId` semantics;
- whether RPC gains native `navigate_tree` or `abort_branch_summary` commands;
- official tree selector summary labels/cancellation flow;
- the hidden command filter and direct-Pi bypass.

If Pi adds a native RPC navigation command, replace the compatibility command
rather than maintaining two navigation paths.
