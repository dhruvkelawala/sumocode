# OpenTUI vs SumoTUI — Technical Comparison

> Date: 2026-05-01
> OpenTUI: `anomalyco/opentui` v0.2.1, MIT, Bun + Zig native core
> SumoTUI: `src/sumo-tui/` in this repo, Node + jiti, MIT
> Context: OpenCode (canonical agent: `anomalyco/opencode`) uses OpenTUI as its rendering layer. OpenTUI is the rendering library; OpenCode is the agent that consumes it. The rendering-layer analog in our repo is `src/sumo-tui/`.
>
> Companion to: `docs/SUMO_TUI_AUDIT.md`, `docs/SUMO_TUI_AUDIT_V2.md`, `docs/research/sumo-tui-spike/02-opentui.md` (the original 2026-04 spike).
> Historical note: references to the old Pi compatibility fork are descriptive. Plan 014 retired the private activation seam; current interactive SumoCode runs through the RPC host.

## TL;DR

OpenTUI is a substantially larger and more capable kernel — Zig-native cell buffer, threaded render loop, WebGPU/3D, Solid reconciler, full input parser, hit-grid mouse routing. Most of that capability requires Bun + per-platform native binaries and is **not portable** to a single-Node-process Pi extension. But there are ~8 specific patterns from OpenTUI's pure-TS layer that are directly portable, would meaningfully improve SumoTUI's quality, and cost between half a day and a day each.

The single highest-impact port is **lazy frame-start + per-row column-range diff** (~1–1.5 days, saves 50–90% of bytes per streaming tick).

This doc records the comparison so we can decide what to port without re-doing the research. **It does not generate new issues** — per the v2 audit STOP-list. Items below become candidate work only when energy and dogfood data justify them.

---

## Repository fingerprints

| Aspect | OpenTUI | SumoTUI |
|---|---|---|
| Language | TypeScript (~7 kLOC `buffer.ts`/`renderer.ts`) + Zig (~24 kLOC native core) | TypeScript only (~15.2 kLOC total, ~1.85 kLOC for the kernel modules studied) |
| Runtime | Bun ≥ 1.3.0 (FFI + WebGPU) | Node ≥ 22.19.0 + jiti |
| Layout | Yoga (via Zig FFI) | Yoga (yoga-wasm-web) |
| Distribution | Pre-built per-platform `.so`/`.dylib` (`@opentui/core-darwin-arm64`, etc.) | Pure TS, no native deps |
| License | MIT | MIT |
| Cell buffer | Packed FFI memory: `Uint32Array(char) + Uint16Array(fg) + Uint16Array(bg) + Uint32Array(attrs)` (`buffer.ts:74-91`) | `CellBuffer` class with sparse `Map<number, string\|number>` style storage |
| Frame diff | Zig (`zig/renderer.zig:1247-1393`), cell-equality with style-run coalescing | TS (`render/diff.ts`, 114 lines), row-based with scroll detection |
| Render thread | Native thread (`renderer.zig:777 renderThreadFn`) decoupled from JS tick | Single-thread, event-driven `FrameScheduler` |
| Input | `lib/stdin-parser.ts` (1832 lines) — kitty, modifyOtherKeys, CSI-u, OSC, mouse SGR/X10, bracketed paste | `input/mouse.ts` (SGR regex) + `input/key-router.ts` + Pi's keypress where forwarded |
| 3D / WebGPU | `packages/three/WGPURenderer.ts` (292 lines) + Rapier physics | none |
| Test surface | `testing/test-renderer.ts` builds a real `CliRenderer` with a fake stdout (still goes through native code) | `testing/test-backend.ts` (191 lines) mounts Yoga trees directly, no native dep |

---

## A. What OpenTUI does better — *portable* to SumoTUI

Each item below is implementable in pure Node TS with no new deps. Effort estimates assume careful work plus tests.

### A1. Lazy frame-start (no-op suppression)

**OpenTUI:** `zig/renderer.zig:1304-1307` — never emits the `\x1b[?2026h … \x1b[?2026l` synchronized-output wrapper if the diff produced zero changes.

**SumoTUI today:** `runtime/terminal-controller.ts:182-190` always wraps patches in `?2026h … ?2026l` plus a cursor-show, even when `patches.length === 0`. ~12+ ANSI bytes plus cursor reposition per idle tick.

**Port:** in `writeFramePatches`, early-return when `patches.length === 0 && !cursorMoved`. Skip cursor restore when its position is unchanged from `lastEmittedCursor` (new cache field).

**Effort:** ~1h. **Trade-off:** trivial.

### A2. Synchronized-output gating by capability

**OpenTUI:** emits `\x1b[?2026h` only after detecting the response (`lib/terminal-capability-detection.ts`).

**SumoTUI today:** sends DECSET 2026 unconditionally; on terminals that don't support it, it's silently ignored — but on a few legacy emulators it can disable bracketed-paste.

**Port:** add a one-shot DECRQM probe in `runtime/lifecycle.ts` startup, cache the result, let `terminal-controller.writeFramePatches` skip the wrapper when unsupported.

**Effort:** ~0.5d. **Trade-off:** minimal; matters only on legacy terms.

### A3. Per-row column-range diff (style run-coalescing)

**OpenTUI:** diff emits SGR + cursor-move only when style changes within a row (`renderer.zig:1331-1349`).

**SumoTUI today:** `ansi-writer.ts:42-64` does within-row coalescing for one row, but `render/diff.ts:39-46` regenerates the **whole row** ANSI even when only one cell changed. Wastes bytes on any frame where one row changes (e.g. cursor blink, single-cell streaming update).

**Port:** add a per-row column-range diff in `diff.ts` producing `{row, startCol, ansi}` patches; widen `FrameDiffPatch`. In `terminal-controller.writeFramePatches`, when `startCol > 0` skip `\x1b[K` and use `\x1b[r;c+1H<ansi>`.

**Effort:** ~1d. **Trade-off:** diff and writer become slightly more complex; tests need to cover partial-row patches. Only worth it if profiling shows ANSI byte volume dominating a stream tick. **This combined with A1 is the highest-leverage port — see §D.**

### A4. Hit-grid for mouse routing

**OpenTUI:** `zig/renderer.zig:154-168` keeps a `Uint32Array(rows*cols)` of renderable IDs; mouse events look up an ID in O(1).

**SumoTUI today:** `render/compositor.ts:118-137` walks the SumoNode tree on every mouse event. For Pi chat sizes (~50 nodes) this is fine; extending to a node-rich Pi mode (inline diffs, dropdowns, code-block hover) starts to matter.

**Port:** rebuild a `Uint32Array(rows*cols)` of node IDs at the end of `composite()`, store a `Map<number, SumoNode>`. Invalidate on layout changes.

**Effort:** ~0.5d. **Trade-off:** needs careful invalidation; only pays off as node count grows.

### A5. Lift OpenTUI's mouse parser

**OpenTUI:** `lib/parse.mouse.ts` (~232 lines, MIT) handles SGR, X10, wheel left/right, drag/move, modifiers, partial buffer fragments, all in one byte-level state machine.

**SumoTUI today:** `input/mouse.ts` is regex-based, SGR-only, and has had bugs around event batching (see #158 jerky scroll diagnosis).

**Port:** lift `parse.mouse.ts` verbatim into `sumo-tui/input/`, replace the regex parser. License-compatible (MIT → MIT).

**Effort:** ~0.5d. **Trade-off:** carries OpenTUI's mouse-test conventions; minor adaptation for our test backend.

### A6. OSC 52 capability gating

**OpenTUI:** `lib/clipboard.ts` writes only after probing OSC 52 support (`renderer.ts:3252`).

**SumoTUI today:** `terminal-controller.writeClipboardSequence` writes blindly; on terminals without OSC 52 support the BEL-terminated payload can leak as visible bytes.

**Port:** add `isOsc52Supported` flag, set from a startup DA1 / XTGETTCAP probe; gate the write.

**Effort:** ~0.5d. **Trade-off:** modest startup cost, prevents user-visible glitches on Apple Terminal etc.

### A7. macOS-style scroll velocity

**OpenTUI:** `lib/scroll-acceleration.ts` (~80 lines, MIT) tracks intervals between wheel events and multiplies delta when burst-scrolling.

**SumoTUI today:** `widgets/scrollbox.ts` uses a fixed multiplier (`scrollAcceleration` field) that doesn't model native trackpad behaviour.

**Port:** copy the file, feed it into the scroll handler.

**Effort:** ~0.5d. **Trade-off:** subjective tuning; helps with the "jerky scroll then over-scroll" feel reported in #158.

### A8. Focus tree on the node model

**OpenTUI:** `Renderable.ts` (1803 lines) bundles Yoga node + lifecycle + focus + zIndex + theme into one class; widgets extend it. Tab/Shift-Tab traversal is built into the focus tree.

**SumoTUI today:** focus is a single registry slot in `key-router.ts`. Tab cycling between modal fields, sidebar tabs, etc. needs bespoke wiring per-surface.

**Port:** add `focusable: bool`, `focusOrder: number`, and `parent.firstFocusable() / nextFocusable()` traversal to `SumoNode`. Default Tab handling routes through this.

**Effort:** ~1d. **Trade-off:** moderate refactor of any existing focus management; pays off when modals grow.

---

## B. What OpenTUI does better — *not portable*

Don't pursue these. Each requires capabilities or constraints that don't fit a single-Node-process Pi extension.

- **Zig-backed `OptimizedBuffer` + `GraphemePool`** (`zig/grapheme.zig:14-50`). Excellent perf; requires Bun FFI and per-platform native binaries. Doesn't fit jiti-loaded TS.
- **Threaded native render loop** (`renderer.zig:777`). Needs a worker + shared memory; collides with our `worker-runtime` model.
- **WebGPU / Three.js / Rapier 3D** (`packages/three/WGPURenderer.ts`). Genuinely cool; requires Bun's WebGPU backend. Useless inside a Pi tool extension.
- **Tree-sitter highlighting via `web-tree-sitter` worker.** Heavy peer-deps; SumoTUI doesn't render code blocks at that fidelity.
- **`extmarks` + `text-buffer-view` + `EditBufferRenderable`** (1174 lines). Full Neovim-style buffer with rope, history, multi-width display offsets. Out of scope; SumoTUI delegates to Pi's `Editor` via `pi-editor-leaf`.
- **DEC mode `?2026` cursor-state diff cache** layered with the threaded render loop. Worth porting in spirit (item A1) but the layered cursor-state cache requires owning the renderer event loop.

---

## C. What SumoTUI does better than OpenTUI

Honest list. Only items that are genuinely better in SumoTUI's context (Pi extension, Node-native, single-author).

### C1. Single-process Node + jiti, no native binaries
SumoTUI starts in <100ms cold; OpenTUI-core hits FFI ABI checks (`platform/ffi.ts`) and platform-binary resolution. For a Pi extension that loads on every session start, this is meaningful UX. No `npm install` per-platform binary downloads, no Apple-silicon vs Intel forks.

### C2. Pi adapter-first design
Historically, `pi-compat/` let SumoTUI coexist with Pi's existing scrollback, editor, and tool registry. OpenTUI assumes it owns the screen; its "split-footer" mode (`renderer.zig:91, 697-844`) is an after-thought and far more complex than `writeChatViewport`. The old private activation seam is retired; the current product path is the RPC host.

### C3. Honest scroll-detection in pure TS
`render/diff.ts:53-91` actually computes scroll-up/down ANSI and emits region-scroll sequences when they're cheaper than full row repaints. **OpenTUI does not do this** — it always emits per-cell ANSI runs. For a chat-heavy session with 200-row scrollback, this is a real byte-saving in SumoTUI's favour.

### C4. Smaller, reviewable surface
`render/buffer.ts` (375) + `compositor.ts` (157) + `diff.ts` (114) ≈ **650 lines** of TS. OpenTUI's equivalent is 559 TS + 2,509 Zig (`buffer.zig`) + 2,071 Zig (`renderer.zig`). For a single maintainer, SumoTUI's kernel is reviewable in a sitting; OpenTUI's is not.

### C5. Pilot/TestBackend at the SumoNode boundary
`testing/test-backend.ts:40-78` mounts Yoga trees directly. OpenTUI's `testing/test-renderer.ts` constructs a real `CliRenderer` with a fake stdout — and still goes through native code. **You cannot run OpenTUI's tests on a machine without the `.so`/`.dylib`.** SumoTUI's tests run anywhere Node runs.

---

## D. Highest-impact single port

**A1 + A3 combined: lazy frame-start + per-row column-range diff.**

This is the most defensible quality win because it directly attacks SumoTUI's worst case: long streaming sessions where the cursor blinks each tick or where one cell of a chat block updates.

**Implementation sketch** (~1–1.5 days incl. tests):

1. Widen `FrameDiffPatch` in `render/diff.ts` to `{ row, startCol, ansi, type }` by extending row-comparison to return the leftmost and rightmost differing columns.
2. In `runtime/terminal-controller.writeFramePatches`:
   - When `patches.length === 0 && !cursorMoved` → return early (no `?2026h` wrapper, no cursor restore).
   - When a patch has `startCol > 0` → emit `\x1b[r;c+1H<ansi>` (no `\x1b[K`).
3. Add a `lastEmittedCursor` cache field on `TerminalController`.
4. Tests:
   - Extend `diff.test.ts` with a one-cell-change case asserting `startCol > 0`.
   - Extend `terminal-controller.test.ts` with a no-op tick asserting zero writes.

**Saves:** 50–90% of ANSI bytes per streaming tick on typical chat updates. Fully Node-native. No new dependencies.

---

## E. Recommended order (if/when energy returns)

Treat this as a wishlist, not a contract. Pick items only when dogfood pain reaches them.

1. **A1 + A3** (highest impact, ~1.5d) — does the most work for the least friction.
2. **A5** (mouse parser, 0.5d) — likely improves #158 jerky scroll.
3. **A7** (scroll velocity, 0.5d) — perceptual win, tied to A5.
4. **A6** (OSC 52 gating, 0.5d) — eliminates a known visible-glitch class.
5. **A2** (DECRQM probe, 0.5d) — cleanup that pairs with A1.
6. **A4** (hit-grid, 0.5d) — defer until node count justifies it.
7. **A8** (focus tree, 1d) — defer until modals grow beyond current count.

Cumulative: ~4 days of work distributed across the remaining lifetime of the project. Most can land independently. None requires owned-shell mode (#161).

---

## F. What this comparison is not

- Not a roadmap. The v2 audit STOP-list explicitly forbids generating new issues from research. This doc records findings; turning any item into a tracked work unit is a separate decision.
- Not an argument for switching to OpenTUI. The non-portable items in §B are why we built SumoTUI in the first place — they're features for a different deployment shape (standalone Bun TUI with WebGPU, threaded native rendering, full Neovim-buffer editing). That shape is not what SumoCode needs.
- Not exhaustive. OpenTUI has a lot of surface (mouse-event-system.ts at 1100+ lines, terminal-capability-detection.ts, theme.ts, etc.) that the comparison didn't dig into. Items A1–A8 are the ones with clear ROI; further research can add to the list if/when needed.

---

*Sources: OpenTUI source (commit at time of research), SumoTUI repo on `origin/main` HEAD `828e890`, prior research at `docs/research/sumo-tui-spike/02-opentui.md`.*
