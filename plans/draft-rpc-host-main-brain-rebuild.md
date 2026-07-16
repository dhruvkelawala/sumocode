# Plan 018: Rebuild the RPC host shell on the SumoTUI main-brain runtime

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat a3966a7..HEAD -- src/sumo-tui/rpc/ src/sumo-tui/widgets/modal.ts src/sumo-tui/widgets/modal-layer.ts src/approval-modal.ts test/integration/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L (multi-day)
- **Risk**: MED
- **Depends on**: none (supersedes the follow-up work implied by plans 014–017)
- **Category**: tech-debt / bug (architecture rework with UX-parity acceptance criteria)
- **Planned at**: commit `a3966a7`, 2026-07-02

## Why this matters

The RPC migration (plans 001–017) got the **backend** right: `pi --mode rpc`
is spawned as a child, the JSONL transport works, and the dangerous-command
approval gate is fail-closed end to end. But the **frontend** was hand-rolled
from scratch in `src/sumo-tui/rpc/runtime.ts` (~600 lines) instead of being
composed from the mature SumoTUI runtime stack that the retired seam runtime
used. The result is that the interactive UX is broken in ways the old runtime
never was: Ctrl-C hard-kills the session (no draft-clear, no abort), there is
no way to interrupt a streaming response at all, mouse scroll is dead (SGR
reporting is enabled but no code parses mouse sequences), extension UI
dialogs use a primitive 3-row modal that clobbers concurrent requests and
truncates approval prompts to one line, autocomplete advertises ~16 commands
that silently become LLM messages, and every streaming token triggers a full
transcript remap and synchronous render.

The architecture target: **Pi RPC stays the backend; the host shell is
rebuilt by reusing the main-brain SumoTUI modules** (frame scheduler, key
router, mouse parser, modal layer, scrollbox/chat pager, splash/sidebar
trees, region registry, terminal controller). Things Pi's InteractiveMode
used to provide in-process (Ctrl-C tiers, quit, slash routing, interrupt) are
re-implemented host-side against RPC commands. This one plan replaces eleven
individually-audited findings; its acceptance criteria enumerate them.

## Current state

### The backend layer (KEEP — harden, don't rewrite)

- `src/sumo-tui/rpc/client.ts` — JSONL transport over child stdio. Request/
  response correlation, event fan-out, `extension_ui_request` dispatch.
- `src/sumo-tui/rpc/controls.ts` — typed wrappers for RPC commands
  (`get_state`, `set_model`, `fork`, `compact`, …). **Has no `abort()`.**
- `src/sumo-tui/rpc/state.ts` — chrome-state store fed by events + stats.
- `src/sumo-tui/rpc/transcript-pump.ts` — maps agent events to
  `TranscriptViewModel` via `createTranscriptViewModelMapper`.
- `src/sumo-tui/rpc/response.ts` — `responseData()` **throws** on error
  responses; every caller must be prepared for that.
- `src/sumo-tui/rpc/host.ts` — composition root (`runRpcHost`).

Known backend defects to fix in place (Step 1):

1. `client.ts:158-165` — a single non-JSON stdout line calls `handleExit`,
   which rejects all pending requests and marks the client dead **but never
   kills the child process** (orphaned `pi` process, session torn down).
2. `client.ts:93-95` — `stderrBuffer` grows unbounded for the process
   lifetime.
3. There is **no `unhandledRejection` handler anywhere** in the repo, and the
   editor submit path void-discards a rejectable promise:

   ```ts
   // src/sumo-tui/rpc/editor.ts:141-143
   this.editor.onSubmit = (text) => {
   	void Promise.resolve(this.onSubmit(text));
   };
   ```

   `host.ts:85-94` awaits `client.send({type:"prompt",…})` +
   `responseData(...)` inside that submit handler; a 30s timeout or error
   response therefore crashes the whole host process. The same pattern exists
   in `host-actions.ts` (`void this.openCommandPalette()` at
   `host-actions.ts:186`; unguarded `client.add/forget/status` memory calls
   at `host-actions.ts:390-412`).

### The frontend layer (REPLACE its internals by composing main-brain modules)

`src/sumo-tui/rpc/runtime.ts` (`RpcHostRuntime`) hand-rolls everything. Its
entire input path is:

```ts
// src/sumo-tui/rpc/runtime.ts:484-510
private readonly handleInput = (data: string | Buffer): void => {
	const text = typeof data === "string" ? data : data.toString("utf8");
	if (text.includes("")) {
		this.requestExit(130);          // ← ANY Ctrl-C hard-exits, even mid-stream / mid-modal
		return;
	}
	if (this.modal?.getActiveKind?.()) { … }
	if (this.overlay?.getActiveKind?.()) { … }
	if (this.inputHandler?.handleInput(text)) { … }
	if (this.editor) { this.editor.handleInput?.(text); … }   // ← SGR mouse bytes land here
	…
};
```

No `KeyRouter`, no `parseSgrMouseStream`, no `FrameScheduler` (`update()`
renders synchronously on every agent event), no `SelectionController`, no
`RegionRegistry`. It uses the **primitive** `ModalManager`
(`src/sumo-tui/widgets/modal.ts`) instead of the real `ModalLayer`
(`src/sumo-tui/widgets/modal-layer.ts`).

The primitive `ModalManager` has three defects that break the extension UI
channel:

```ts
// src/sumo-tui/widgets/modal.ts:85-91 — select() overwrites this.active.
// The displaced modal's promise NEVER resolves (a displaced
// extension_ui_request means the child extension awaits forever → agent
// wedged), and its still-armed timeout later calls this.finish(...) which
// dismisses the WRONG (new) modal.
public select(title: string, options: readonly string[], opts?): Promise<string | undefined> {
	return new Promise<string | undefined>((resolve) => {
		const cleanup = this.installDismissal(opts, () => this.finish(undefined));
		this.active = { kind: "select", title, options, selectedIndex: 0, resolve, cleanup };
		…
```

```ts
// src/sumo-tui/widgets/modal.ts:141 — the title is painted as ONE row,
// truncated. RPC approvals arrive as a select whose title is
// "APPROVAL REQUIRED\n\n<command>\n\n<description>" (src/approval-modal.ts:265-270),
// so the user is asked to approve a command they mostly cannot see.
// Control chars / ANSI in the command are painted raw (spoofing vector).
const lines: string[] = [line(border(modalWidth)), line(this.active.title), line(border(modalWidth))];
```

```ts
// src/sumo-tui/widgets/modal.ts:172-176 — input modal accepts single
// printable chars only; pasted text (multi-char chunks / bracketed paste)
// is silently dropped. "Switch session by path" is unusable via paste.
if (data.length === 1 && !/\p{Cc}/u.test(data)) {
	modal.value += data;
```

Other frontend defects this plan must resolve:

- **No interrupt**: Pi's RPC protocol has `{type:"abort"}` (see
  `node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts:31`)
  and `{type:"steer"}`; the host sends neither. `grep -rn "abort" src/sumo-tui/rpc/`
  → zero matches at plan time.
- **Dead slash commands**: `src/sumo-tui/rpc/editor.ts:47-70`
  (`PI_0_79_1_BUILTIN_SLASH_COMMANDS`, 22 entries) feeds autocomplete, but
  `host-actions.ts:192-243` intercepts only `/model /thinking /theme /compact
  /new /clone /fork /sessions /session /settings /sumo:*`. Everything else
  (`/quit`, `/export`, `/copy`, `/resume`, `/share`, `/hotkeys`, `/tree`,
  `/name`, `/login`, …) falls through to `client.send({type:"prompt"})` and
  becomes an LLM message — Pi's `session.prompt` expands only
  skill/template/extension commands, not interactive builtins. **There is no
  quit affordance at all** other than the Ctrl-C hard-kill.
- **Per-token full remap**: `transcript-pump.ts:192-249` — every event
  (including each streaming `message_update`) calls `viewModel()`, which does
  `mapper.reset()` and re-maps **all** committed messages, then
  `runtime.update()` → `ChatPager.replaceViewModels` rebuilds and renders
  synchronously (`host.ts:116-121`). `liveTools`/`taskPartials` maps
  (`transcript-pump.ts:181-197`) are never pruned across turns.

### The main-brain modules to reuse (all exist today, all host-native — no Pi runtime dependency)

| Module | Exported API | Use for |
|---|---|---|
| `src/sumo-tui/runtime/frame-scheduler.ts` | `FrameScheduler({ render })` | coalesced render loop (replaces render-per-event) |
| `src/sumo-tui/input/key-router.ts` | `KeyRouter`, `KeyEvent`, `KeyTarget` | ordered input targets: modal → overlay → host actions → editor |
| `src/sumo-tui/input/mouse.ts` | `parseSgrMouseStream(input)`, `MouseEvent` | split SGR mouse sequences out of the stdin stream |
| `src/sumo-tui/widgets/chat-pager.ts` | `ChatPager.handleMouseEvent(event)`, `.scrollToBottom()` | wheel scroll of the transcript |
| `src/sumo-tui/widgets/chat-scroll-command.ts` | `chatScrollCommandFromInput/FromKey` | keyboard paging (PgUp/PgDn/Shift+↓) |
| `src/sumo-tui/widgets/modal-layer.ts` | `ModalLayer extends ModalManager`, `ModalSurfaceComponent` | real modal surface (extends the primitive manager — the queueing/rendering fixes land in `modal.ts` and benefit both) |
| `src/sumo-tui/input/selection.ts` | `SelectionController`, `createOsc52Sequence` | mouse text selection + OSC52 copy (seam runtime had this; optional, Step 8) |
| `src/sumo-tui/pi-compat/region-registry.ts` | `RegionRegistry.mountWidget` | extension `setWidget` placement (the responder already types against it but the host never constructs one) |
| `src/sumo-tui/runtime/terminal-controller.ts` | `TerminalSessionOwner` | already used — keep |
| `src/sumo-tui/cathedral/splash-tree.ts`, `sidebar-tree.ts` | already used by `runtime.ts` — keep | |
| `src/approval-modal.ts` | `renderApprovalModal`, `updateApprovalSnapshot`, `ApprovalModalSnapshot` | Cathedral approval surface for real RPC approvals (today used only by the `/sumo:approval` preview) |

**Reference composition**: the retired seam runtime shows how these modules
compose. Read it (do not resurrect it — it depends on Pi's in-process
`InteractiveMode`, which does not exist under RPC):

```bash
git show c744cd2:src/sumo-tui/pi-compat/sumo-interactive-mode.ts | less
```

**Explicit non-reuse**: `src/sumo-tui/pi-compat/chat-viewport-controller.ts`
and `installChatViewportBridge` bridge into Pi InteractiveMode internals
(`upstream: unknown`). They are seam-era compatibility code — do NOT try to
wire them into the RPC host. Use `ChatPager`/`ScrollBox` directly.

### Conventions that apply

- Tabs for indentation; TypeScript strict with `noUnusedLocals`/`noUnusedParameters`.
- No build step — Pi runs TS via jiti. Never add bundlers or emit-to-dist.
- Tests colocate: `foo.ts` → `foo.test.ts`. Integration tests in
  `test/integration/` spawn real processes via `test/integration/spawn-pi-pty.ts`
  (`spawnSumocodePty` runs `bin/sumocode.sh` = the RPC host; `spawnPiPty`
  runs classic `pi -e .`).
- New Cathedral rendering must use typed primitives from
  `src/sumo-tui/render/primitives.ts` — read `docs/SUMO_TUI_RENDER_PRIMITIVES.md`
  first. Hand-rolled ANSI is allowed only in the documented exception list.
- Voice (`src/voice.ts`): state labels uppercase Cathedral verbs; product copy
  lowercase, terse, no exclamation marks.
- Modal/overlay painting contract: `docs/cathedral/SCRIPTORIUM_CHROME.md` —
  read before touching any overlay.
- Peer deps only for Pi-bundled packages (`@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui`, `typebox`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck (both) | `pnpm exec tsc --noEmit && pnpm build` | exit 0 |
| Unit tests | `pnpm test` | all pass |
| One file | `pnpm vitest run src/sumo-tui/rpc/client.test.ts` | all pass |
| Integration | `pnpm test:integration` | all pass (spawns real Pi via node-pty) |
| Visual gate | `pnpm visual:ci` | exit 0 |
| Manual run | `bin/sumocode.sh -d .` | RPC host boots; diagnostics to `/tmp/sumocode-manual.jsonl` |
| Diag summary | `bin/sumocode.sh diag` | summarizes the JSONL |

Repo root is `/Volumes/SumoDeus NVMe/code/sumocode` — **the path contains a
space; always quote it.**

## Scope

**In scope** (the only files you should modify or create):

- `src/sumo-tui/rpc/*.ts` and their colocated tests
- `src/sumo-tui/widgets/modal.ts`, `src/sumo-tui/widgets/modal-layer.ts` + tests
- `src/approval-modal.ts` + `src/approval-modal.test.ts` (RPC prompt marker only — do not touch the gate logic)
- `test/integration/rpc-host-shell.test.ts` and new `test/integration/rpc-*.test.ts` files
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):

- `bin/sumocode.sh` runtime-selection logic, `SUMO_RPC`, `SUMO_TUI`,
  `sumo-rpc-host.js` — AGENTS.md forbids casual changes; the launcher works.
- The approval gate decision logic (`installApprovalGate`,
  `normalizeApprovalChoice`, `isDangerousBashCommand`) — it is fail-closed
  and reviewed; only the *presentation* of the RPC prompt may change.
- The classic extension layer (`src/footer.ts`, `src/top-chrome.ts`,
  `src/sidebar.ts` render functions) — the host reuses them read-only.
- Pi child behavior, `docs/ui/bible/*` targets, `scenarios.json` geometry
  specs, and golden promotion (requires Dhruv's explicit approval).
- `src/sumo-tui/pi-compat/chat-viewport-controller.ts`,
  `pi-interactive-adapter.ts`, `retained-shell-transition.ts`,
  `owned-shell-renderer.ts` — seam-era code; leave untouched (separate
  cleanup decision, not this plan).

## Git workflow

- Branch off `codex/rpc-migration-no-seam`: `codex/rpc-host-main-brain-018`.
- Conventional commits matching the log style (`fix:`, `refactor:`, `test:`,
  e.g. `3b6ba9d fix: restore cathedral shell in rpc runtime`). One commit per
  step below.
- Do NOT push, merge, or open a PR — Dhruv reviews locally.

## Steps

### Step 1: Harden the backend session layer

All in `src/sumo-tui/rpc/`:

1. `client.ts` — in `handleExit`, if `this.child` is still set, call
   `child.kill("SIGTERM")` (and a 2s `SIGKILL` fallback mirroring `stop()`)
   before clearing it, so a fatal transport error never orphans the Pi child.
2. `client.ts` — cap `stderrBuffer` at 64 KiB (keep the tail: on append,
   `if (buf.length > 65536) buf = buf.slice(-65536)`).
3. `client.ts` — on a JSON parse failure in `handleLine`, do NOT tear down the
   session on the first bad line. Log the offending line to stderr via a new
   optional `onProtocolError` callback and skip it; only call `handleExit`
   after 3 consecutive unparseable lines (a genuinely corrupt stream).
4. New `src/sumo-tui/rpc/safe-send.ts` (or a method on `RpcHostControls`):
   a `notifyOnError` wrapper used by every fire-and-forget call site —
   `try { await fn() } catch (e) { notifications.notify(message(e), "error") }`.
   Rewire: the editor `onSubmit` closure in `host.ts`, every `void`-called
   async in `host-actions.ts` (`openCommandPalette`, memory `add/forget/status`),
   so no user action can produce an unhandled rejection.
5. `host.ts` — install `process.on("unhandledRejection", …)` at the top of
   `runRpcHost` that writes the error to stderr **after** restoring the
   terminal (`runtime?.stop(1)`), then exits 1 — a last-resort guard, not the
   primary path.
6. `transcript-pump.ts` — prune `liveTools` and `taskPartials` on `agent_end`
   (the authoritative `messages` array replaces them), and stop re-mapping
   committed messages on every event: cache the mapped `ChatMessageViewModel[]`
   for `committedMessages` and invalidate only when `committedMessages`
   changes (i.e. on `message_end` / `agent_end` / `replaceFromMessages`).
   `message_update` events then re-map only the draft message + live tools.

**Verify**:
`pnpm vitest run src/sumo-tui/rpc/client.test.ts src/sumo-tui/rpc/transcript-pump.test.ts` → pass, including the new tests from the Test plan section (orphan-kill, stderr cap, skip-bad-line, prune-on-agent-end).
`pnpm exec tsc --noEmit && pnpm build` → exit 0.

### Step 2: Add `abort` to controls and wire real Ctrl-C / Esc semantics

1. `controls.ts` — add `abort(): Promise<void>` sending `{ type: "abort" }`
   (the command exists in Pi's `RpcCommand` union; if TypeScript rejects it,
   that is a STOP condition — the pinned Pi version may differ).
2. Replace the raw `handleInput` in `runtime.ts` with a `KeyRouter`
   composition (`src/sumo-tui/input/key-router.ts`). Target order:
   modal layer → overlay → host actions → chat scroll commands → editor.
3. Implement Ctrl-C tiers in a new `src/sumo-tui/rpc/interrupt.ts` (unit
   testable, no I/O):
   - modal or overlay active → dismiss it (deny/cancel semantics — for a
     displaced approval this resolves to "no", which the gate treats as deny);
   - editor has non-empty draft → clear the draft;
   - agent streaming (`state.isStreaming`) → send `abort`;
   - otherwise → arm a 1.5s "press Ctrl-C again to quit" notification; second
     Ctrl-C within the window exits cleanly (exit code 130).
   Esc (when no modal/overlay/autocomplete is open and the agent is
   streaming) → send `abort`.
   The repo's own contract for the classic layer is
   `test/integration/ctrl-c-input.test.ts:20` ("clears a draft and keeps the
   process alive") — the RPC host must now satisfy the same expectations.
4. Route renders through `FrameScheduler` (`src/sumo-tui/runtime/frame-scheduler.ts`):
   `runtime.update()` and `requestRender()` call `scheduler.requestRender()`;
   the scheduler invokes the existing private `render()`.

**Verify**:
`pnpm vitest run src/sumo-tui/rpc/interrupt.test.ts src/sumo-tui/rpc/runtime.test.ts` → pass.
Manual: `bin/sumocode.sh -d .` → type a draft, Ctrl-C clears it and the app stays alive; Ctrl-C twice on an empty editor exits with the terminal restored.

### Step 3: Mouse scroll and keyboard paging

1. In the runtime input path (before the editor target), run incoming chunks
   through `parseSgrMouseStream` (`src/sumo-tui/input/mouse.ts`). Feed
   `MouseEvent`s with wheel buttons to the transcript `ChatPager`
   (`this.chat.handleMouseEvent(event)` — the pager instance lives in
   `RpcTranscriptFrameRenderer`; expose a narrow `handleMouse(event)` method
   on the renderer rather than the whole pager). Non-mouse remainder text
   continues down the key router.
2. Wire `chatScrollCommandFromInput` (`src/sumo-tui/widgets/chat-scroll-command.ts`)
   for keyboard paging, and render the scrolled-up banner
   (`src/sumo-tui/widgets/scrolled-up-banner.ts`) when the pager is not at
   bottom — match how the Bible active scene shows it (see
   `docs/visual/parity/CONTRACT.md` lanes).
3. On new transcript content, only auto-`scrollToBottom()` when the pager was
   already at bottom (standard follow-output behavior — check `ScrollBox`
   state via its `ScrollBoxStateChange`).

**Verify**:
`pnpm vitest run src/sumo-tui/rpc/runtime.test.ts` → pass (new tests: wheel event scrolls, mouse bytes never reach the editor).
`pnpm test:integration` → the new `rpc-mouse-scroll` test (Test plan) passes.

### Step 4: Replace the primitive modal usage with a queued, legible ModalLayer

All modal fixes go in `src/sumo-tui/widgets/modal.ts` (the base class) so
`ModalLayer` inherits them:

1. **Queueing**: `select/confirm/input` must never clobber. If a modal is
   active, enqueue the request (FIFO) and present it when the current one
   finishes. The displaced-timer bug disappears once nothing is displaced;
   also make `installDismissal`'s timer handle belong to the specific modal
   entry, not the manager.
2. **Multi-line titles**: split `title` on `\n` and render each line, wrapped
   to the modal width (use `visibleWidth` from `@earendil-works/pi-tui` for
   width math). The full approval command must be visible.
3. **Sanitization**: strip ANSI/control sequences from title, message, and
   option strings before painting (reuse the `ANSI_PATTERN` approach from
   `runtime.ts:85` — move it to a small shared helper; also strip remaining
   `\p{Cc}` control chars except `\n`).
4. **Paste**: in `handleInputModal`, accept multi-char printable chunks and
   bracketed-paste payloads (strip the `[200~` / `[201~` markers),
   filtering control characters.
5. Switch the host composition (`host.ts`) from `ModalManager` to `ModalLayer`
   (`src/sumo-tui/widgets/modal-layer.ts`) so modals paint through the real
   surface component. Read `docs/cathedral/SCRIPTORIUM_CHROME.md` first.
6. **Cathedral approvals**: in `src/approval-modal.ts`, export a stable marker
   constant (e.g. `RPC_APPROVAL_TITLE_PREFIX = "APPROVAL REQUIRED"` — it is
   already the first line built at `approval-modal.ts:265-270`). In
   `extension-ui-responder.ts`, when a `select` request's title starts with
   that marker and its options equal the approval options, render the
   Cathedral approval component (`renderApprovalModal` + `updateApprovalSnapshot`,
   the same pair the `/sumo:approval` preview uses in `host-actions.ts:137-159`)
   via the overlay manager, and map the result (`yes`/`no`/`always`) back to
   the select response value. Fallback: any mismatch → generic (now legible)
   select modal. Do not change the child-side gate.

**Verify**:
`pnpm vitest run src/sumo-tui/widgets/modal.test.ts src/sumo-tui/rpc/extension-ui-responder.test.ts` → pass, including: two concurrent selects both resolve in order; timeout of a queued modal dismisses only itself; multi-line title fully rendered; ANSI stripped; paste works.
`pnpm test` → pass (approval-modal tests unchanged — gate untouched).

### Step 5: Honest slash-command surface + quit

1. In `src/sumo-tui/rpc/editor.ts`, stop advertising Pi interactive builtins
   the host cannot honor. Build the autocomplete list from: (a) the host's own
   command table, (b) `get_commands` results from the child (extension/skill/
   template commands — these DO work through `prompt`). Delete
   `PI_0_79_1_BUILTIN_SLASH_COMMANDS` entries that map to nothing; keep and
   host-implement the cheap ones: `/quit` (clean shutdown), `/name` (alias of
   rename), `/session` (stats via `get_session_stats` → notification or
   overlay). If an advertised builtin is neither host-implemented nor
   child-executable, it must not autocomplete.
2. In `host-actions.ts`, unknown `/commands` that are NOT in the child's
   `get_commands` list should show a "unknown command" notification instead of
   being sent to the LLM as a message.
3. Add `/quit` to `handleSubmittedText` → clean shutdown path (same as
   double-Ctrl-C tier from Step 2).

**Verify**:
`pnpm vitest run src/sumo-tui/rpc/editor.test.ts src/sumo-tui/rpc/host-actions.test.ts` → pass (new tests: `/quit` exits; unknown command notifies, does not prompt; autocomplete contains no dead entries).

### Step 6: Extension widget/status surfaces via RegionRegistry

`extension-ui-responder.ts` already accepts a `regionRegistry` option and
types against `Pick<RegionRegistry, "mountWidget">`, but `host.ts` never
constructs one, so extension `setWidget` calls are stored in a map and never
painted. Construct a `RegionRegistry`
(`src/sumo-tui/pi-compat/region-registry.ts`) in the host composition, pass
it to the responder, and composite its mounted widgets into the frame
(above-editor / below-header placements per `WidgetPlacement`). `setStatus`
strings should surface in the footer's status zone — keep within the footer
contract (right zone is context/window + cost only; use the hint row for
status text, per AGENTS.md "Current layout decisions").

**Verify**:
`pnpm vitest run src/sumo-tui/rpc/extension-ui-responder.test.ts src/sumo-tui/rpc/runtime.test.ts` → pass (new test: a `setWidget` request paints lines into the frame snapshot).

### Step 7: Restore the lost integration coverage on the RPC path

Port the behaviors whose tests were deleted at the migration
(`git show c744cd2:test/integration/<name>` to read the originals:
`runtime-chat-scroll.test.ts`, `session-switch-retained-lifecycle.test.ts`,
`splash-centering.test.ts`) as **RPC-host** tests using `spawnSumocodePty`
(model after `test/integration/rpc-host-shell.test.ts`):

- `rpc-ctrl-c.test.ts` — draft cleared on first Ctrl-C, process alive; double
  Ctrl-C exits with cleanup sequence (`TERMINAL_CLEANUP_SEQUENCE`).
- `rpc-mouse-scroll.test.ts` — send SGR wheel sequences; transcript scrolls;
  editor draft unchanged.
- `rpc-session-switch.test.ts` — `/new` does not leave altscreen; chrome
  updates.
- `rpc-splash-centering.test.ts` — splash content vertically centered at
  100×30 (reuse the deleted test's row-math assertions).

**Verify**: `pnpm test:integration` → all pass, including the 4 new files.

### Step 8 (optional, only if Steps 1–7 are green and time remains): Selection + OSC52 copy

Wire `SelectionController` (`src/sumo-tui/input/selection.ts`) into the mouse
path (drag-select over the cell buffer selection metadata that
`paintBuffer`/`setSelectionMeta` already propagate in `runtime.ts:153-164`)
and emit `createOsc52Sequence` on copy, mirroring the seam runtime's usage
(see the `c744cd2` reference file, `SelectionController` construction around
line 197). If this exceeds a day, skip and note it in the maintenance section
of your report.

## Test plan

New unit tests (colocated, model after the existing files they extend):

- `client.test.ts`: fatal error kills child (spy on `kill`); stderr capped;
  single bad JSON line skipped + `onProtocolError` fired; 3 consecutive bad
  lines → exit.
- `transcript-pump.test.ts`: committed messages mapped once across N
  `message_update` events (spy on mapper); `liveTools` empty after
  `agent_end`.
- `interrupt.test.ts` (new): the four Ctrl-C tiers as a pure decision table.
- `modal.test.ts`: queueing, per-modal timers, multi-line wrap, sanitization,
  paste.
- `editor.test.ts` / `host-actions.test.ts`: autocomplete honesty, `/quit`,
  unknown-command notify.
- `extension-ui-responder.test.ts`: approval marker → Cathedral overlay
  route; queued concurrent requests both answered.

Integration: the four new files from Step 7.

Full verification: `pnpm exec tsc --noEmit && pnpm build && pnpm test && pnpm test:integration && pnpm visual:ci` → all exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm exec tsc --noEmit && pnpm build` exit 0
- [ ] `pnpm test` exit 0
- [ ] `pnpm test:integration` exit 0, including `rpc-ctrl-c`, `rpc-mouse-scroll`, `rpc-session-switch`, `rpc-splash-centering`
- [ ] `pnpm visual:ci` exit 0 (no regression on required crops)
- [ ] `grep -rn '"abort"' src/sumo-tui/rpc/controls.ts` → at least one match
- [ ] `grep -n 'includes("\\u0003")' src/sumo-tui/rpc/runtime.ts` → no match (raw Ctrl-C check replaced by the tiered handler)
- [ ] `grep -n "PI_0_79_1_BUILTIN_SLASH_COMMANDS" src/sumo-tui/rpc/editor.ts` → the list, if still present, contains only host-implemented or child-executable commands (no `/export`, `/share`, `/copy`, `/login`, `/logout`, `/trust`, `/import`, `/scoped-models`, `/changelog`, `/hotkeys`, `/tree`, `/resume`, `/reload` entries)
- [ ] `grep -rn "parseSgrMouseStream" src/sumo-tui/rpc/` → at least one match
- [ ] `grep -rn "FrameScheduler" src/sumo-tui/rpc/` → at least one match
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row for 018 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The pinned Pi version's `RpcCommand` union has no `abort` member, or a live
  `abort` send during a streaming response does not stop the stream (test
  manually with `bin/sumocode.sh -d .`). The interrupt design depends on it.
- `ModalLayer` cannot be composited into the RPC frame without pulling in
  seam-era dependencies (`PiComponentLeaf`, `retained-shell-transition`) — in
  that case do the queueing/legibility fixes in `ModalManager` only and
  report the layering conflict instead of forcing the swap.
- The `extension_ui_request` for approvals stops matching the
  `RPC_APPROVAL_TITLE_PREFIX` marker (Pi changed the forwarding shape after a
  version bump) — AGENTS.md requires re-verifying the RPC contract on Pi
  bumps; do not guess a new matching rule.
- Fixing the transcript-pump caching requires changing
  `createTranscriptViewModelMapper` semantics in
  `src/sumo-tui/transcript/view-model.ts` (task-metadata enrichment is
  order-dependent across messages) — that file is Track B territory; report
  instead of editing it.
- Any step's verification fails twice after a reasonable fix attempt.
- `pnpm visual:ci` fails on a crop your change plausibly affected — never
  promote goldens yourself; capture the review pack and report.

## Maintenance notes

- **Pi version bumps**: AGENTS.md already mandates re-verifying the RPC
  contract (`rpc-types.d.ts`), the builtin slash list, and the approval
  regression test. Step 5 shrinks the builtin list, and Step 4.6 adds the
  approval-marker coupling — both belong on that bump checklist.
- **Reviewer focus**: (1) the Ctrl-C tier decision table — an off-by-one
  there either re-introduces the hard-kill or blocks exit entirely; (2) modal
  queueing — a queued extension request must still respect its own timeout
  from enqueue time, or a stuck modal wedges the child; (3) the pump cache
  invalidation — a stale cache renders ghost messages after `/new` or fork
  (`replaceFromMessages` must drop the cache).
- **Deferred, deliberately**: seam-era `pi-compat` cleanup
  (`chat-viewport-controller`, `owned-shell-renderer`,
  `retained-shell-transition`, `pi-interactive-adapter` are now largely
  unreachable — deleting them is a separate decision); `steer`-on-Esc-then-type
  UX (Pi RPC supports `steer`; natural follow-up once `abort` works); a real
  session picker to replace "switch session by path" (needs a session-list
  source); `scratch/rpc-spike/` removal (tracked but now git-ignored — 26
  files; ask Dhruv, AGENTS.md forbids file removal without approval).
