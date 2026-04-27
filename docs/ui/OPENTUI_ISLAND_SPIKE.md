# OpenTUI Island Spike — SumoCode Cathedral UI

Date: 2026-04-27  
Branch: `spike/opentui-island`  
Prototype entrypoint: `src/opentui-spike-extension.ts`  
Reference source: local clone `docs/spike-research/opentui-island/` from `https://github.com/benvinegar/opentui-island` (Dhruv fork available at `https://github.com/dhruvkelawala/opentui-island`)  
Run command:

```bash
ANTHROPIC_API_KEY= ANTHROPIC_OAUTH_TOKEN= \
  pi --offline \
  --model google/gemini-2.5-flash \
  --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-session \
  -e ./src/opentui-spike-extension.ts
```

## Summary

**Recommendation: GO-WITH-CAVEATS.** `opentui-island` is good enough to use for SumoCode's layout-heavy chrome, especially splash centering, a fixed-height shell, and modal overlays. It should **not** be used to wrap or replace Pi's editor, and it does **not** magically solve Pi's global vertical layout by itself: a `PiTuiSurface` is still a fixed-height `pi-tui` component, so footer pinning still requires the host extension to allocate the correct number of rows around Pi's chat/editor/footer stack.

The prototype proves:

- OpenTUI/React islands can mount inside Pi extension `setHeader()` and `setFooter()` without touching Pi internals.
- Splash content can be centered with OpenTUI flex (`justifyContent: "center"`) across landscape and portrait terminal sizes.
- A one-line footer island can render at the last visible row when the header shell reserves the remaining viewport rows.
- Pi's native editor remains untouched; slash autocomplete works (`docs/ui/spike-screenshots/opentui-autocomplete-wide.png`).
- We can avoid altscreen entirely; terminal exit cleanup is clean after `Ctrl+D` (`docs/ui/spike-screenshots/opentui-exit-clean-wide.png`, `docs/ui/spike-screenshots/opentui-exit-clean-portrait.png`).

The prototype also proves the important caveat:

- `opentui-island` surfaces are fixed-height (`height` is stored on the surface), so dynamic viewport ownership is still our job. In the prototype, `src/opentui-spike-extension.ts:218-224` computes the shell island height from `tui.terminal.rows`. That is more robust than manual splash padding, but it is still host-side layout math.

---

## 1. Adapter architecture

### 1.1 Surface → `pi-tui` `Component`

The core bridge is `PiTuiOpenTuiSurface`. It implements `Component` and `Focusable` directly (`docs/spike-research/opentui-island/src/adapters/pi-tui/index.ts:122-124`). Internally it keeps an `OpenTuiIslandController`, a fixed `height`, a cached OpenTUI frame, and cached ANSI lines (`src/adapters/pi-tui/index.ts:126-135`).

Rendering is intentionally synchronous from Pi's perspective. The surface returns cached lines from `render(width)`, and if the width changed or no frame is cached, it starts a background sync (`src/adapters/pi-tui/index.ts:361-365`). The async part happens in `sync(width)`: it collapses width bursts to the latest requested width, calls `controller.syncFrame({ width, height })`, diffs the host frame, converts it to ANSI lines, and calls `requestRender()` only if something changed (`src/adapters/pi-tui/index.ts:193-218`, `src/adapters/pi-tui/index.ts:222-229`).

This shape is exactly what Pi extensions need: Pi sees an ordinary fixed-height component, while the OpenTUI tree runs separately and only hands back terminal lines.

### 1.2 Props, events, and commands

Island props are plain serializable values. `OpenTuiIslandProps` is an index signature over `OpenTuiIslandValue`, which allows `null`, booleans, numbers, strings, arrays, and nested objects (`docs/spike-research/opentui-island/src/core/island.ts:4-21`). The island source includes a module URL, optional export name, and optional props (`src/core/island.ts:17-21`).

Host → island state flow uses `updateProps()`. The host interface exposes `mount()` and `updateProps()` (`src/core/host.ts:10-14`), the controller exposes `updateProps()` and invalidates its cached frame, and the sidecar applies prop updates into React state (`src/sidecar/server.ts:150-169`, `src/sidecar/server.ts:229-239`). The API guide says to use props for host-owned state that should survive remounts (`docs/api.md:106-119`).

Island → host results use bridge events. `OpenTuiBridgeEvent` is `{ type, payload }` (`src/core/bridge.tsx:6-17`), and `useOpenTuiIslandBridge()` exposes `emit()` and `onCommand()` inside the island (`src/core/bridge.tsx:40-58`). The API guide explicitly positions events for save/cancel, selection, export, and validation outcomes (`docs/api.md:121-141`).

Host → island imperative actions use commands. The sidecar buffers early commands until an island subscribes (`src/sidecar/server.ts:80-100`). This matters for modal flows where the host wants to focus a panel immediately after mount.

### 1.3 Ready and sync lifecycle

The controller owns readiness. `waitUntilReady()` resolves once a usable frame has rendered, not merely when `mount()` returns (`src/core/controller.ts:80-84`, `src/core/controller.ts:114-119`). `createIslandController()` can eagerly create a sidecar when `size` is provided and then `syncFrame()` immediately (`src/core/controller.ts:286-315`).

`createPiTuiSurface()` is the convenience wrapper. It creates a controller unless one is supplied, passes the requested width/height into that controller, constructs a `PiTuiOpenTuiSurface`, and returns it (`src/adapters/pi-tui/index.ts:503-546`). The prototype wraps this in `OpenTuiIslandComponent`, because Pi extension factories are synchronous. The wrapper renders blank placeholder rows while the sidecar boots, then calls `tui.requestRender()` when the surface is ready (`src/opentui-spike-extension.ts:124-187`).

### 1.4 Bun sidecar ownership

The sidecar is per controller/surface in the default path. `createOpenTuiSidecarHost()` spawns `bun <sidecar/server.js>` (`src/sidecar/client.ts:474-488`). `createOpenTuiIslandController()` creates a sidecar host when a `size` is present (`src/core/controller.ts:286-295`). Therefore two independent surfaces in the prototype create two Bun processes: one shell island and one footer island.

The sidecar protocol is stdin/stdout JSON lines. The server reads request lines, handles `handshake`, `create`, `mount`, `updateProps`, `resize`, `sendKey`, `sendMouse`, `renderFrame`, and `destroy`, and exits on `destroy` or stdin end (`src/sidecar/server.ts:194-224`, `src/sidecar/server.ts:260-319`). The client kills the child process during `destroy()` (`src/sidecar/client.ts:451-469`).

### 1.5 Mouse routing

Mouse is optional, not inherent to every surface. The adapter defines explicit SGR mouse enable/disable sequences (`src/core/terminal-mouse.ts:3-4`). `attachPiTuiMouseSupport()` enables mouse mode, attaches a terminal input listener, and disables mode on detach (`src/adapters/pi-tui/index.ts:375-399`). `createPiTuiModal()` enables mouse by default unless `enableMouse === false` (`src/adapters/pi-tui/index.ts:427-428`).

The prototype does **not** call `attachPiTuiMouseSupport()` and does **not** use `createPiTuiModal()` for the splash/footer. It calls `createPiTuiSurface()` directly (`src/opentui-spike-extension.ts:169-174`). Result: no SGR mouse mode and no altscreen scroll-wheel-to-history regression.

### 1.6 `setHeader` / `setFooter` support

`opentui-island` examples often show `tui.addChild()` or `ctx.ui.custom()` overlays, but Pi extensions do not need raw `addChild()` for the chrome case. Pi's public extension API lets `setHeader()` and `setFooter()` return a `Component` factory (`node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts:103-109`). Pi's implementation swaps the header component in place (`interactive-mode.js:1467-1503`) and appends the custom footer at the end of the TUI children (`interactive-mode.js:1440-1462`).

This is enough. The prototype mounts the OpenTUI shell through `ctx.ui.setHeader()` and the one-line OpenTUI footer through `ctx.ui.setFooter()` (`src/opentui-spike-extension.ts:208-245`).

### 1.7 Fixed-height limitation

The adapter is fixed-height by design. `PiTuiOpenTuiSurface` stores `private readonly height` (`src/adapters/pi-tui/index.ts:126-128`), normalizes frames to that height (`src/adapters/pi-tui/index.ts:109-119`), and always syncs frames with `{ width, height: this.height }` (`src/adapters/pi-tui/index.ts:211-218`).

That is fine for modals and panels. It is the caveat for global app layout. An island can flex within its rectangle, but `pi-tui` still owns the outer list of components. Pi's base order is header, chat, pending, status, widgets above editor, editor, widgets below editor, footer (`interactive-mode.js:453-460`). Therefore a footer is only on the last visible row if the components above it consume the correct number of rows.

---

## 2. Island topology

### Option I — One mega-island

A mega-island would render the entire Cathedral shell: top chrome, splash, sidebar, active chat region placeholder, footer, and maybe modal portals. Pi would keep the editor outside the island.

Pros:

- One Bun sidecar, so lower process count than multiple islands.
- Global flex layout becomes easier inside the island: top, body, footer can be a single OpenTUI column.
- The splash and footer could be laid out relative to each other without cross-island state.

Cons:

- Pi's chat still lives outside the island unless we replace Pi's message renderer, which we should not do for v1.
- Pi's editor still lives outside the island. That means the mega-island cannot truly own the whole viewport.
- A mega-island risks becoming a fake app shell fighting Pi's real component order.
- State passing becomes broad: messages, tools, approvals, sidebar state, memory state, model state, branch state.

Expected boot delay: one sidecar. Upstream README reports ~121ms cold start on its local example; our real Pi measurement to first `SUMOCODE` frame was much higher because Pi startup is included (median 595.8ms, p95 886.7ms).

Verdict: attractive long-term only if SumoCode eventually owns a separate `pi-agent-core + OpenTUI` frontend. Not right for a Pi extension v1.

### Option II — Multiple targeted islands

This uses independent islands for splash, footer, sidebar, top chrome, palette, memory editor, and approval modal.

Pros:

- Each element is isolated and easier to test.
- We can migrate incrementally.
- Modal islands map cleanly to existing `createPiTuiModal()` patterns.

Cons:

- Every surface creates a Bun sidecar by default. The prototype's two surfaces yielded two Bun children.
- Two sidecars added substantial RSS: Pi 157,744 KiB + Bun 85,344 KiB + Bun 68,032 KiB = 311,120 KiB total, versus 109,904 KiB for baseline Pi without islands.
- Cross-element layout is still host-side. A footer island does not know how tall the splash island, editor, and Pi warnings are.

Expected boot delay: roughly N sidecars. In practice the two-island prototype median to first frame was 595.8ms, p95 886.7ms.

Verdict: okay for low-frequency modals; too expensive for every static chrome element.

### Option III — Hybrid islands for layout-heavy bits

This is what the prototype implemented: a shell island in `setHeader()` and a one-line footer island in `setFooter()`. The editor remains native. No altscreen. No mouse mode. No custom editor wrapper.

Pros:

- Proves the hardest visual problem: splash centering works in OpenTUI flex (`src/opentui/cathedral-shell.island.tsx:72-95`).
- Footer can be rendered through OpenTUI while host-side row reservation places it at the bottom (`src/opentui-spike-extension.ts:218-224`, `src/opentui-spike-extension.ts:230-245`).
- Autocomplete remains native because we never wrap `CustomEditor`.
- We can use `ctx.ui.custom()` / `createPiTuiModal()` for approval, memory, and palette later.

Cons:

- Footer pinning still depends on host-side height math.
- Pi hardcoded warnings still count as rows in `chatContainer`, so production needs either warning suppression, warning measurement, or a full shell/spacer component that accounts for them.
- Two always-on sidecars are probably too expensive; production should collapse shell + footer into one sidecar where possible or leave the one-line footer native.

Recommendation: **Option III, but with one production shell island, not two static islands.** Use OpenTUI for the splash/top/sidebar shell and modal surfaces. Keep the footer either native or inside a shell-owned spacer strategy after we decide how to handle Pi warning rows.

---

## 3. Prototype

### Files added

- `src/opentui-spike-extension.ts` — isolated Pi extension that mounts OpenTUI surfaces through public Pi APIs.
- `src/opentui/cathedral-shell.island.tsx` — OpenTUI/React island with top chrome + flex-centered splash.
- `src/opentui/cathedral-footer.island.tsx` — one-line OpenTUI footer island.
- `scripts/measure-opentui-spike.mjs` — pty-based cold-start measurement.
- `docs/ui/opentui-spike-wide.tape`
- `docs/ui/opentui-spike-portrait.tape`
- `docs/ui/opentui-spike-exit-wide.tape`
- `docs/ui/spike-screenshots/*`

### Mount strategy

The spike uses Pi's public `ctx.ui.setHeader()` and `ctx.ui.setFooter()` factories. The wrapper class `OpenTuiIslandComponent` is a normal `pi-tui` `Component`; it creates the sidecar asynchronously, renders stable placeholder rows while loading, recreates the surface on height changes, and updates island props when model/state/session values change (`src/opentui-spike-extension.ts:98-187`).

The shell height calculation is explicit:

```ts
const terminalRows = tui.terminal.rows || process.stdout.rows || 40;
return sessionHasMessages(ctx) ? 1 : Math.max(8, terminalRows - 7);
```

That lives at `src/opentui-spike-extension.ts:218-224`. The `-7` accounts for Pi's header-container top/bottom spacer plus the default below-header stack in this isolated prototype: widget-above spacer, default editor, and footer. This is not magic; it is controlled host-side viewport allocation.

The shell island itself uses OpenTUI flex for centering: the splash body has `flexGrow: 1`, `alignItems: "center"`, and `justifyContent: "center"` (`src/opentui/cathedral-shell.island.tsx:72-79`). The footer island uses `justifyContent: "space-between"` to separate left/right zones (`src/opentui/cathedral-footer.island.tsx:21-34`).

The prototype also calls `tui.requestRender(true)` once after the header installs (`src/opentui-spike-extension.ts:208-214`). This clears the launch command without entering altscreen. It avoids the previous mouse-scroll regression while still giving a clean first frame.

### Visual proof

Screenshots generated by `vhs`:

1. `docs/ui/spike-screenshots/opentui-splash-wide.png` — wide landscape splash, centered, footer at bottom.
2. `docs/ui/spike-screenshots/opentui-autocomplete-wide.png` — slash autocomplete works with native Pi editor after typing `/res`.
3. `docs/ui/spike-screenshots/opentui-splash-portrait.png` — portrait/tall splash, centered, footer at bottom.
4. `docs/ui/spike-screenshots/opentui-exit-clean-wide.png` — exited Pi and typed `asd` in shell; shell reports `command not found`, no leaked escape state.
5. `docs/ui/spike-screenshots/opentui-exit-clean-portrait.png` — same cleanup proof in portrait.

The prototype uses a simplified ASCII cat because OpenTUI `text` nodes style segments themselves; the existing chafa ANSI cat is not yet ported into OpenTUI primitives. The layout result, not final logo fidelity, was the target.

---

## 4. Evaluation

### 4.1 Did splash centering work?

**Yes.** The shell island uses OpenTUI flex centering and renders correctly in both landscape and portrait screenshots. The content remains centered between the top chrome and bottom editor/footer stack. Visual proof:

- `docs/ui/spike-screenshots/opentui-splash-wide.png`
- `docs/ui/spike-screenshots/opentui-splash-portrait.png`

Caveat: the production chafa cat logo is not yet ported. The prototype proves layout, not asset fidelity.

### 4.2 Did footer pinning work?

**Partial / yes for the isolated empty-state prototype.** The footer is on the last visible row in both wide and portrait screenshots. But the pinning is achieved by the host-side header height calculation, not by a footer island independently knowing the viewport. This is still better than manual splash top-padding because the island content flexes inside a known rectangle, but it does not remove the need to measure/reserve Pi's other rows.

The biggest remaining risk is Pi-generated noise: extension conflicts, auth warnings, package update banners, and theme warnings are rendered in `chatContainer` between header and editor. Those rows can change. In a non-isolated run with existing user extensions, the extra warning rows pushed the top chrome out of the viewport even though the splash still centered. Production must either suppress known SumoCode conflicts/noise or include a measurement pass.

### 4.3 Cold-start delay

Measured with `node scripts/measure-opentui-spike.mjs` in a 160×45 pseudo-terminal, timing process spawn to first `SUMOCODE` island frame:

```text
run 1: 886.7ms
run 2: 595.8ms
run 3: 569.8ms
run 4: 565.9ms
run 5: 614.7ms
median: 595.8ms
p95: 886.7ms
```

This includes Pi startup plus two sidecars. It is acceptable for a spike but high enough that production should avoid many always-on islands.

### 4.4 Memory footprint

Measured after booting the two-island prototype:

```text
pi pid RSS:        157,744 KiB
bun sidecar RSS:    85,344 KiB
bun sidecar RSS:    68,032 KiB
total:            311,120 KiB
```

Baseline Pi with the same flags and no extension:

```text
pi RSS:           109,904 KiB
bun sidecars:          0
```

Delta: about +201 MiB RSS for the two-island prototype. This is the strongest reason not to scatter static chrome across many sidecars.

### 4.5 Disk install delta

Baseline install measured from `HEAD` package/lock in a temp directory:

```text
baseline node_modules: 240M
current node_modules:  368M
```

Delta: about +128M in `node_modules` after adding `opentui-island`, `@opentui/core`, `@opentui/react`, and `react`.

Direct followed-symlink package sizes:

```text
node_modules/opentui-island  196K
node_modules/@opentui         11M
node_modules/react           252K
```

The larger 128M delta comes from transitive dependencies and pnpm virtual store content.

### 4.6 Bun process count

The prototype has two always-on surfaces and produced two Bun children:

```text
82242 bun .../opentui-island/dist/sidecar/server.js
82247 bun .../opentui-island/dist/sidecar/server.js
```

This confirms the per-surface/per-controller sidecar behavior.

### 4.7 Cursor and autocomplete

**Pass.** The prototype never wraps `CustomEditor`; it leaves Pi's editor untouched. Typing `/res` shows slash command suggestions (`docs/ui/spike-screenshots/opentui-autocomplete-wide.png`). This directly avoids the prior cursor/autocomplete regressions from replacing or wrapping editor rows.

### 4.8 Mouse scroll

**Pass by construction.** The prototype does not enter altscreen and does not call `enablePiTuiMouseMode()` / `attachPiTuiMouseSupport()`. Since ordinary terminal scrollback remains in normal mode, mouse wheel input is not translated into editor history navigation by altscreen. Modal islands that opt into mouse later need stricter teardown tests because `createPiTuiModal()` enables mouse by default unless `enableMouse === false` (`src/adapters/pi-tui/index.ts:427-428`).

### 4.9 Exit cleanup

**Pass with `Ctrl+D` empty-editor exit.** Screenshots show `asd` is typed into the shell after Pi exits and zsh handles it normally:

- `docs/ui/spike-screenshots/opentui-exit-clean-wide.png`
- `docs/ui/spike-screenshots/opentui-exit-clean-portrait.png`

No kitty keyboard garbage, no bracketed paste leak, no altscreen trap.

---

## 5. Migration plan

### Element 1 — Sidebar

Decision: **candidate, but not first.** Sidebar has independent layout and could benefit from OpenTUI flex: tabs, sections, progress bars, MCP lists, memory lists. However, the current sidebar is already pi-tui native and has a separate dock-width issue. The bigger issue is not React rendering; it is Pi's outer chat/sidebar split. Keep the static sidebar dock native until the shell strategy is stable, then consider a sidebar island inside the right column only.

Phase: 3.  
Effort: 1-2 days.  
Blockers: avoid extra always-on sidecar; maybe share controller with shell or leave native.

### Element 2 — Top chrome

Decision: **convert with shell.** The shell island already renders a minimal top chrome. Production should make top chrome part of the shell island so the splash and top row share one layout root. It should still receive state from Pi via props.

Phase: 1.  
Effort: 0.5-1 day.  
Blockers: restore recents/archive/icons and terminal width truncation rules.

### Element 4 — Input frame

Decision: **do not wrap Pi editor.** The input frame regression came from touching editor rows and cursor markers. Pi's editor owns autocomplete, multiline input, cursor positioning, IME, bracketed paste, and slash commands. OpenTUI should not be inserted around it.

Use native Pi editor. Add safe chrome only as separate widgets if needed, but avoid side borders that change cursor columns.

Phase: 0 / guardrail.  
Effort: immediate revert/fix.  
Blockers: none.

### Element 6 — Approval modal

Decision: **good island candidate.** Approval is modal, bounded, and keyboard-focused. `createPiTuiModal()` exists specifically for this shape (`src/adapters/pi-tui/index.ts:402-499`), and the example result editor shows a save/cancel island returning data to Pi (`examples/pi/result-editor.ts:43-121`).

Phase: 2.  
Effort: 1 day.  
Blockers: set `enableMouse: false` unless we explicitly test mouse cleanup.

### Element 7 — Memory editor

Decision: **good island candidate.** Memory editor is another bounded modal/panel. React state and OpenTUI flex would make sections, editing forms, and confirmation flows cleaner than hand-rendered string arrays.

Phase: 2.  
Effort: 1-2 days.  
Blockers: bridge events for save/forget, validation, and maybe async memory daemon state.

### Element 8 — Command palette

Decision: **good island candidate, but watch focus.** Command palette is bounded and searchable; OpenTUI/React is a natural fit. It must not fight Pi's built-in Ctrl+P conflicts until keybinding strategy is fixed.

Phase: 2.  
Effort: 1 day.  
Blockers: shortcut conflict with Pi model selection; use command invocation first.

### Elements 9 + 10 — Tool pills and code blocks

Decision: **do not migrate yet.** These live inside Pi's chat/message renderer. Replacing them with islands would either create many tiny sidecars or require replacing Pi's message rendering path. Keep theme/native renderers for v1.

Phase: deferred.  
Effort: unknown.  
Blockers: Pi controls chat scrollback and tool result rendering.

---

## 6. Recommendation

**GO-WITH-CAVEATS.** Use `opentui-island` in SumoCode, but only where the island boundary matches the product boundary:

1. A production shell island for top chrome + splash layout, possibly with native footer retained until row measurement is solved.
2. Modal islands for approval, memory editor, and command palette.
3. No OpenTUI wrapping of the editor.
4. No blanket mouse mode. If a modal needs mouse, enable it only while the modal is open and test teardown.
5. Avoid more than one always-on sidecar until memory/cold-start is acceptable. The two-island prototype added about 201 MiB RSS.

The fork at `github.com/dhruvkelawala/opentui-island` is useful as an escape hatch. No fork patch was needed for this spike. Start with published `opentui-island@0.4.0`; pin to Dhruv's fork only if we need shared-controller, dynamic-height, or mouse-mode changes.

### Follow-up issue 1

```md
## Replace Cathedral splash padding with OpenTUI shell island

### Goal
Use `opentui-island` for the empty-state Cathedral shell: top chrome + vertically-centered splash content. Remove manual splash padding constants.

### Scope
- Add `opentui-island`, `@opentui/core`, `@opentui/react`, `react` dependencies.
- Add a production `cathedral-shell.island.tsx`.
- Mount through `ctx.ui.setHeader()` using a safe async `Component` wrapper.
- Use `tui.requestRender(true)` once on startup instead of altscreen.
- Keep Pi editor native.
- Port the real chafa cat logo or create an OpenTUI-native equivalent.

### Acceptance
- `pnpm exec tsc --noEmit && pnpm test`
- `vhs` screenshots for wide + portrait splash
- Slash autocomplete still works
- Mouse scroll does not cycle prompt history
```

### Follow-up issue 2

```md
## Build OpenTUI modal foundation for approval, memory, and palette

### Goal
Introduce one shared modal helper around `createPiTuiModal()` for SumoCode overlays.

### Scope
- Add wrapper that defaults `enableMouse: false`.
- Implement bridge event typing for `confirm`, `cancel`, `save`, `forget`, `select`.
- Port approval modal first.
- Then port memory editor and command palette.

### Acceptance
- Keyboard-only operation
- Escape/cancel path works
- Sidecar destroyed on close
- Terminal cleanup verified by screenshot/tape
```

### Follow-up issue 3

```md
## Remove unsafe editor wrapping and define native-editor boundary

### Goal
Stop corrupting Pi editor cursor behavior. Document and enforce that SumoCode does not wrap `CustomEditor.render()` rows.

### Scope
- Revert Cathedral editor row wrapping.
- Keep placeholder/hints only if they do not alter cursor row/column math.
- Add regression tests around autocomplete pass-through where possible.
- Document OpenTUI boundary: shell/modals yes, editor no.

### Acceptance
- Cursor movement normal in cmux/Ghostty
- `/res` autocomplete visible
- Mouse scroll behaves as terminal scroll, not prompt history
- No altscreen dependency
```
