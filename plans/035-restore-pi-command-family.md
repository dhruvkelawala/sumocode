# Plan 035: Restore Pi's interactive command family in the RPC host

> **Executor instructions**: Phased. Do Phase 1 first (highest value, no Pi
> changes). Each command is an independent, shippable slice — commit per
> command. Run every verification. On a STOP condition, stop and report.
> Base worktrees on the current `integrate/track-d` tip; do NOT move that ref
> while the user has it checked out — commit to `feat/pi-command-family` and
> hand the reviewer the SHA for a fast-forward.

## Status

- **Priority**: P1 (core Pi features users depend on; silently dropped by the RPC migration)
- **Effort**: L (phased; Phase 1 alone is M and recovers most value)
- **Depends on**: none for Phase 1; Phase 3 is blocked on upstream Pi
- **Category**: feature parity / migration
- **Planned at**: `549095d`, 2026-07-03
- **Source audit**: workflow findings 2026-07-03 (agent a599174af5d2ba479), evidence inlined below

## Why this matters

On main, SumoCode subclassed Pi's `InteractiveMode` in-process, so every
native slash command — `/resume`, `/tree`, `/fork`, `/export`, `/copy`,
`/trust`, `/hotkeys`, etc. — worked verbatim for free. The RPC migration
replaced in-process inheritance with a JSON-RPC boundary: `pi --mode rpc`
exposes only ~25 command verbs, and everything else has no wire
representation. The host (`src/sumo-tui/rpc/host-actions.ts:257-317`)
hand-reimplemented a subset and silently drops the rest to an "unknown
command" notification. Users lose session navigation (`/tree`, `/resume`),
export/copy, trust, and hotkey reference — features they consider essential.

**The linchpin finding**: `get_state`'s RPC response already includes
`sessionFile` (the absolute path to the current session's `.jsonl`) — see
`node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js:340-354`
and `rpc-types.d.ts:134-147` — but `src/sumo-tui/rpc/state.ts:42-57`
(`hydrateFromRpcState`) does NOT copy it into `RpcHostChromeState`; it's
dropped on the floor (grep confirms zero non-test references to `sessionFile`
in `src/sumo-tui/rpc/`). Threading that one field unlocks host-side session
enumeration and tree reading with no new RPC verb.

## Current state

- RPC host command dispatch: `src/sumo-tui/rpc/host-actions.ts` `handleSubmittedText`,
  handled set at `:257-317`; unknown → notification at `:310-316`.
- `/fork` is present but degraded: `openForkSelector()` (`host-actions.ts:396-414`)
  renders a flat `modals.select()` of `${i+1}. ${text.slice(0,72)}` from
  `get_fork_messages`. Pi's native is a rich searchable `UserMessageSelectorComponent`.
- RPC primitives available (`rpc-types.d.ts:13-419`): `fork`, `get_fork_messages`,
  `switch_session`, `new_session`, `clone`, `set_session_name`, `export_html`,
  `get_messages`, `get_last_assistant_text`, `get_state` (carries `sessionFile`),
  `get_session_stats`, `compact`, `set_model`, `get_commands`, …
- Pi stores sessions on disk (`dist/core/session-manager.js`): dir =
  `join(agentDir, "sessions", "--<encodedCwd>--")` (`:216-232`); files named
  `<isoTimestamp>_<sessionId>.jsonl`; newline-delimited JSON, first line a
  `{type:"session", id, cwd, timestamp}` header (`:280-307`), then `message` /
  `session_info` (name) / `label` / `branch_summary` entries carrying
  `id`/`parentId`/`timestamp`. `buildSessionInfo(filePath)` (`:360-427`)
  streams a file for list metadata; `getTree()` (`:891-923`) walks the
  *current* session's parsed entries (no directory scan) to build the branch graph.
- Convention: tabs, strict TS, colocated tests, no build step. Host-owned
  modal/overlay pattern: follow `openForkSelector` / `openSessionControls` in
  `host-actions.ts`. Voice per `src/voice.ts`.

## Scope

**In scope**: `src/sumo-tui/rpc/state.ts` (thread `sessionFile`),
`src/sumo-tui/rpc/host-actions.ts` (+ new command cases), `src/sumo-tui/rpc/controls.ts`
(+ typed wrappers for `export_html` / `get_last_assistant_text` if absent),
a new host-side session-reader module `src/sumo-tui/rpc/session-reader.ts`
(+ test), a `/hotkeys` and `/changelog` renderer, `src/sumo-tui/rpc/editor.ts`
(add the newly-implemented commands to the honest autocomplete list),
colocated tests.

**Out of scope**: the full-screen palette vs inline autocomplete question
(plan 036 owns it); the RPC transport/client internals; anything requiring an
upstream Pi protocol change (Phase 3 — documented, not built).

## Phase 1 — host-side, no Pi change (do first)

Commit per command. Each ends with: `pnpm exec tsc --noEmit && pnpm build` clean
and its unit test green.

1. **Thread `sessionFile`** — add `sessionFile?: string` to `RpcHostChromeState`
   and copy it in `hydrateFromRpcState`. Prerequisite for #6/#7. Test: state
   store surfaces `sessionFile` from a `get_state` payload.
2. **`/copy`** — `case "/copy":` → `get_last_assistant_text` → write to clipboard
   via the host's existing clipboard path (OSC52 through the terminal owner, as
   the B10 selection copy does — reuse `writeClipboardSequence`). Terse "copied"
   toast. Test: copy calls the primitive and emits the clipboard sequence.
3. **`/export`** (HTML) — `case "/export":` → `export_html` → notify with the
   written path. `.jsonl` variant is Phase 3 (no RPC verb). Test.
4. **`/hotkeys`** — host-native overlay listing the RPC host's OWN keymap (the
   host owns input routing, so this lists SumoCode's bindings, not Pi's —
   source it from the key-router/interrupt/command bindings). Model the overlay
   on `openThemeCheck`'s `LinesOverlayComponent`. (Coordinate with plan 031's
   keybinding matrix — that enumerates the same bindings; reuse its table if
   031 has landed.) Test.
5. **`/changelog`** — read + render SumoCode's changelog (or Pi's via the
   packaged path) as an overlay; pure local file read. Test.
6. **`/resume`** — build a session picker from the on-disk directory:
   `dirname(sessionFile)` → `readdir` sibling `.jsonl` → parse each header +
   latest `session_info` name + message count via the new `session-reader.ts`
   (port `buildSessionInfo`'s streaming parse — self-contained, `fs`/`readline`
   only, no Pi imports) → present a searchable modal → load via existing
   `switch_session`. Test: reader parses a fixture `.jsonl` dir; picker loads
   the chosen path.
7. **`/tree` (browse/preview only)** — read the CURRENT session's `.jsonl`
   (`sessionFile`) via `session-reader.ts`, reconstruct the parent/child branch
   graph (port `getTree()`'s walk), render a navigable tree overlay. The
   "jump to node" action is Phase 3 (needs `navigate_tree`); for now, offer
   `fork`-from-node via the existing `fork(entryId)` primitive and clearly
   label it as forking (behaviorally: creates a branch, not leaf-repositioning).
   Test: graph build from a branched fixture matches expected structure.
8. **`/fork` polish** — upgrade `openForkSelector` from a flat list to a
   searchable/preview modal against the same `get_fork_messages` data. Test.
9. **`/session` panel** — render the full `get_session_stats` payload as a
   multi-line panel instead of a one-line toast. Test.

## Phase 2 — host-side, more involved

10. **`/trust`** — instantiate a host-side trust store against the agent dir
    (`~/.pi/agent/trust.json`; import `ProjectTrustStore` from
    `@earendil-works/pi-coding-agent/dist/core/trust-manager.js` IF it's a
    public export, else port the ~20-line read/write). Show the same
    "restart pi for this to take effect" caveat Pi shows. Test.
11. **`/share`** — host-side: `export_html` → shell `gh` (gist) from the host
    process (it has bash capability), mirroring Pi's `handleShareCommand`.
    Detect `gh` + auth; graceful message if absent. Test the non-gh path.
12. **`/settings` richness gap** (found by the 2026-07-03 exhaustive command
    audit, agent a9b39209aaddc2311) — Pi's real settings menu has ~9 toggles;
    the host's has 4 (auto-compaction, auto-retry). Two more are buildable
    TODAY with existing RPC verbs and were simply never wired: `set_steering_mode`
    and `set_follow_up_mode` (`rpc-types.d.ts:57-64`). Add both to the settings
    selector. The remaining Pi toggles (image handling, transport, timeouts)
    have no RPC verb — document the settings menu as intentionally partial,
    don't fake the rest. Test: both new toggles round-trip through the RPC verb.
13. **`/fork` polish, restated with an exact mechanism** — the audit confirmed
    this is still flat (plan 035 step 8 above, not yet executed) and named the
    fix precisely: add a fuzzy filter over the label list using pi-tui's
    `fuzzyFilter` (already imported elsewhere in this tree) — no new RPC verb
    needed, `get_fork_messages` already returns everything required.

## Phase 3 — BLOCKED on upstream Pi (do NOT build; document as asks)

Record these in the report as upstream requests; do not attempt host-side
hacks that fake them:

- **`/scoped-models`** — DEFINITIVE VERDICT (2026-07-03 exhaustive audit,
  agent a9b39209aaddc2311, evidence chain fully traced): genuinely blocked,
  no host-side workaround is honest. Pi's scoped-model state
  (`_scopedModels`) is a **private in-process field on `AgentSession`**
  (`agent-session.js:64,120,589-594`), seeded only from the `--models` CLI
  flag at construction and consulted internally by `cycleModel()`
  (`agent-session.js:1113-1141`). The RPC protocol's 28-verb command union
  has `set_model`/`cycle_model`/`get_available_models` and nothing else
  model-related — no `get_scoped_models`/`set_scoped_models` pair exists, so
  the host cannot even READ the current scope, let alone write it. A
  host-side "fake scoping" UI would silently diverge from Pi's real semantics
  (session-only persistence, per-scoped-model thinking-level override,
  provider-auth filtering) and wouldn't touch Pi's actual Ctrl+P binding at
  all. Needs a new RPC verb pair upstream. Do not build a client-side
  imitation — file the upstream ask and leave `/scoped-models` notifying
  "unknown command" until Pi exposes it.

- **`/login` / `/logout`** — needs new OAuth RPC verbs (`login_start`,
  `login_poll`, `logout`, `get_auth_providers`); no `extension_ui` method
  fits a device-code flow. Interim: users run bare `pi` once for auth (creds
  persist to shared `auth.json`). 
- **`/import`** (arbitrary external `.jsonl` replace) — needs an `import_jsonl` verb.
- **`/tree` "navigate to node"** (leaf repositioning with summarize-on-branch)
  — needs a `navigate_tree` verb; `fork` is behaviorally different.
- **`/reload`** — needs a child respawn / `reload_extensions` contract.
- **`/export .jsonl`** — needs `export_jsonl` (only `export_html` exists).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm exec tsc --noEmit && pnpm build` | exit 0 |
| Unit | `pnpm vitest run src/sumo-tui/rpc/` | pass |
| Integration | `pnpm test:integration` | pass |
| Manual | `bin/sumocode.sh -d .` then try `/resume`, `/tree`, `/copy` | works |

## Done criteria (Phase 1)

- [ ] `grep -n "sessionFile" src/sumo-tui/rpc/state.ts` → present in `RpcHostChromeState` + hydrate
- [ ] `/copy`, `/export`, `/hotkeys`, `/changelog`, `/resume`, `/tree` (browse), `/fork` (polished), `/session` (panel) all handled in `host-actions.ts` — no longer fall through to "unknown command"
- [ ] `session-reader.ts` parses a fixture session dir + a branched session file, unit-tested against the documented format
- [ ] The newly-implemented commands appear in the editor autocomplete (`editor.ts`) and unknown ones still notify (no dead advertising)
- [ ] `pnpm exec tsc --noEmit && pnpm build` exit 0; `pnpm test:integration` exit 0
- [ ] Only in-scope files modified

## STOP conditions

- The on-disk session format differs from the audit's documented shape at the
  pinned Pi version (verify against a real `~/.pi/agent/sessions/**/*.jsonl`
  before porting the parser) — report the delta.
- `switch_session` after a disk-read pick fails or corrupts state — report; do
  not work around by writing session files from the host.
- A Phase-1 command turns out to need a Pi primitive that doesn't exist —
  reclassify it to Phase 3 and report, don't fake it.
- Any verification fails twice.

## Maintenance notes

- The session-reader depends on Pi's on-disk `.jsonl` format, which is stable
  because Pi's `SessionManager` is the sole writer — but it's a coupling: add
  it to the Pi-version-bump checklist (re-verify the header/entry schema).
- The Phase-3 upstream asks are the honest boundary of what the RPC model can
  do alone; surface them to Pi maintainers as concrete protocol requests.
- Plan 036 (slash UX) and this plan share the invocation surface — land 036's
  inline-autocomplete decision before polishing per-command entry UX so they
  don't fight.
