# Plan 023: Share input routing, keybindings, mouse, paste, and selection

> **Executor instructions:** Treat terminal input as a single product subsystem.
> RPC should delegate through the same parser/router as the retained TUI, with
> backend-specific callbacks only at the edges.

## Status

- **Priority:** P0
- **Effort:** M/L
- **Risk:** HIGH
- **Depends on:** 019, 020, 022. (Plan 025 Part B3–B4 depends on THIS plan — the router must expose a pre-editor interception point for it; see done criteria.)
- **Category:** correctness / UX parity
- **Planned at:** `a3966a7`, 2026-07-02
- **Execution:** DONE in `codex/plan023-shared-input-router-exec` at `d1982eb`.
- **Review:** APPROVED after two revision rounds. Revise #1 fixed split-ESC mouse input dispatching bare Escape too early; Revise #2 fixed retained/Pi delayed bare-Escape delivery and trailing Escape after coalesced mouse input.

## Why this matters

Reported issues include broken keybindings and duplicated editor input. The
current RPC runtime handles stdin locally while the retained path already has
hardened behavior for SGR mouse, scroll, paste, selection, and rewritten input.

## Scope

**In scope:**

- `src/sumo-tui/pi-compat/chat-viewport-controller.ts` input handling logic
- `src/sumo-tui/rpc/runtime.ts`
- `src/sumo-tui/rpc/host-actions.ts`
- `src/sumo-tui/rpc/editor.ts` (builtin slash list / autocomplete build)
- editor/keybinding tests
- PTY integration tests

**Out of scope:**

- Changing command palette design.
- Adding new keybindings.
- Reworking model/provider command semantics.

## Steps

### Step 1: Extract shared input router

Move terminal input logic into a backend-neutral router that handles:

- SGR mouse sequence parsing and partial-byte buffering,
- chat scroll keys,
- selection copy keys,
- raw multiline paste normalization,
- modal/overlay focus routing,
- editor forwarding,
- submit callback,
- global shortcuts such as Ctrl+/.

### Step 2: Define backend callbacks

The router should call backend-provided callbacks for:

- submit prompt,
- open command palette,
- request render,
- exit request,
- forward data to Pi when needed.

RPC and Pi in-process can then use different callbacks without different input
parsers.

### Step 3: Reuse keybinding manager behavior

Stop relying on ad hoc string checks where Pi already exposes key matching. Keep
tests for terminal variants:

- `\u001f`,
- CSI-u Ctrl+/ if emitted by the terminal,
- Enter and CSI-u Enter,
- Shift+Enter/multiline input,
- paste chunks containing newlines.

### Step 4: Make the slash-command surface honest

The autocomplete list (`PI_0_79_1_BUILTIN_SLASH_COMMANDS`,
`src/sumo-tui/rpc/editor.ts:47-70`) advertises 22 Pi interactive builtins, but
the host intercepts only ~8 (`host-actions.ts:192-243`); the rest (`/quit`,
`/export`, `/copy`, `/resume`, `/share`, `/hotkeys`, `/tree`, `/name`,
`/login`, …) fall through to `client.send({type:"prompt"})` and become LLM
messages — Pi's `session.prompt` expands only skill/template/extension
commands, not interactive builtins (evidence in
`plans/draft-rpc-host-main-brain-rebuild.md`).

- Build autocomplete from (a) the host's own command table and (b) the child's
  `get_commands` results (those DO execute through `prompt`). An advertised
  command must be either host-implemented or child-executable — delete the
  rest from the builtin list.
- Host-implement the cheap ones: `/name` (alias of rename), `/session` (stats
  via `get_session_stats`).
- Do not advertise `/quit` in this plan unless it is already host-implemented.
  Plan 025 adds `/quit` back to the host command table when it wires interrupt
  tiers into the shared router.
- An unknown `/command` not in the child's `get_commands` list shows an
  "unknown command" notification instead of being sent to the model.

### Step 5: Restore cursor ownership

Ensure editor cursor position comes from `PiEditorLeaf` and the shell composite
result, not from manually painted cursor cells in RPC. `writeFramePatches` should
receive the shell cursor unless an overlay intentionally hides it.

## Verification

```bash
pnpm vitest run src/sumo-tui/rpc/host-actions.test.ts
pnpm vitest run src/sumo-tui/rpc/editor.test.ts
pnpm vitest run src/sumo-tui/pi-compat/chat-viewport-controller.test.ts
pnpm vitest run test/integration/rpc-host-shell.test.ts
pnpm test:integration
pnpm exec tsc --noEmit && pnpm build
```

Reviewer reran the closeout gates against `codex/plan023-shared-input-router-exec`
at `d1982eb`:

```bash
pnpm vitest run src/sumo-tui/pi-compat/chat-viewport-controller.test.ts src/sumo-tui/rpc/runtime.test.ts
pnpm vitest run src/sumo-tui/rpc/host-actions.test.ts src/sumo-tui/rpc/editor.test.ts test/integration/rpc-host-shell.test.ts test/integration/cursor-visibility.test.ts
pnpm vitest run src/sumo-tui/widgets/modal.test.ts src/sumo-tui/rpc/extension-ui-responder.test.ts src/approval-modal.test.ts
pnpm test:integration
pnpm visual:review -- --scenario splash-runtime
pnpm visual:review -- --scenario active-landscape-runtime
pnpm visual:review -- --scenario active-portrait-runtime
pnpm visual:ci
pnpm exec tsc --noEmit && pnpm build
python3 /Users/sumo-deus/.codex/skills/autoreview/scripts/autoreview --mode branch --base codex/plan022-modal-label-sanitization-fix --engine codex --prompt "<Plan 023 final review context>"
```

Results: all targeted suites, integration tests, runtime visual reviews, visual CI,
and type/build passed. Final branch autoreview was clean with no accepted/actionable
findings. `pnpm test` remains affected by the known unrelated background-task
`output.log` ENOENT after assertions pass.

## Done criteria

- [x] RPC and retained paths share one input parser/router.
- [x] Ctrl+/ opens the same command palette path in PTY tests.
- [x] Editor input is not duplicated in active runtime captures.
- [x] Splash cursor is owned by the editor cursor path.
- [x] Mouse scroll and selection tests still pass.
- [x] Autocomplete contains no advertised command that is neither
  host-implemented nor child-executable (unit test over the built list).
- [x] An unknown slash command notifies instead of prompting the LLM
  (unit test in `host-actions.test.ts`).
- [x] The router exposes a pre-editor interception point for Ctrl-C/Esc
  (unit-tested with a stub handler) — Plan 025 Part B wires its interrupt
  tier module there. Do not implement the tiers in this plan.

## STOP conditions

- Input behavior requires terminal-specific hacks outside the shared router.
- Fixing RPC breaks existing retained mouse/selection behavior.
