# SumoCode — DESIGN.md

> Canonical design system for the SumoCode Pi extension.
> Format: [awesome-claude-design](https://github.com/VoltAgent/awesome-claude-design) 9-section template.
> Direction: **Cathedral** (the digital scriptorium).
>
> **How to use this file:**
> 1. Open https://claude.ai/design
> 2. Either:
>    - Create a new design system → upload this file under "Add assets", or
>    - In a project chat, attach this file and say "Create a design system from this DESIGN.md"
> 3. Claude scaffolds the full UI kit with tokens, components, and preview cards.

---

## 1. Visual Theme & Atmosphere

**Creative North Star:** *The Digital Scriptorium.*

SumoCode is a terminal-native AI coding assistant designed to feel like working at a 19th-century mahogany desk in a monastic library. It is the visual opposite of the "soft" SaaS web — no rounded corners, no shadows, no gradients, no animations. The interface is a **crafted artifact**, not a product.

**Mood adjectives:** warm, contemplative, deliberate, dense, authoritative. Information dense without being cluttered. Every character earns its position on the monospace grid.

**Density:** High. The interface displays significant data simultaneously (chat, code, sidebar with context/MCP/memory, footer with model/cost/state). But the typography and color discipline keep it readable.

**Reference aesthetic vocabulary:**
- Terminal-native: ANSI-rendered, monospace grid, box-drawing characters as structural glyphs (┌ ─ ┐ │ └ ┘ ╔ ═ ╗ ║)
- Editorial: section headers in UPPERCASE LETTER-SPACED, decorative banners (════ TITLE ════)
- Material: aged walnut backgrounds, warm vellum text, burnt orange accents — the palette of natural materials, not pixel-perfect synthetic surfaces
- Restraint: color appears only when it carries meaning (preattentive state signals, hero accents at moments of cognition or memory)

**What this is NOT:** a code editor (no file tree, no minimap), a chat interface (no avatars, no message bubbles), a dashboard (no charts, no widgets). It is a *terminal* — flat, character-aligned, dense.

**Where it should be used:** AI coding agents, terminal-first developer tools, CLIs with long-running interactive sessions, dev tools where the user wants to feel like a craftsman rather than a consumer.

---

## 2. Color Palette & Roles

All hex values are absolute. No light-mode variant in v1 (terminal aesthetic is dark-first by definition).

### Surfaces
| Token | Hex | Role |
|---|---|---|
| `--background` | `#1A1511` | Aged walnut. The foundational canvas. The terminal's main background. |
| `--surface` | `#241D17` | Mahogany. Slightly elevated panels — sidebar background, code blocks. |
| `--surface-recess` | `#120D0A` | Deepest. Carved-into surfaces — input prompt zone. |
| `--surface-lifted` | `#3A342F` | Modal background — slightly lifted from main canvas. |
| `--divider` | `#3A2F25` | Subtle dividers between sections. Used very sparingly. |

### Text
| Token | Hex | Role |
|---|---|---|
| `--foreground` | `#F5E6C8` | Warm vellum. Primary text. High contrast on `--background`. |
| `--foreground-dim` | `#8B7A63` | Oxidized paper. Secondary metadata, timestamps, line numbers, hints. |

### Accent (use sparingly)
| Token | Hex | Role |
|---|---|---|
| `--accent` | `#D97706` | Burnt orange. Hero color. Used ONLY for: section banner ornaments (════), active tab frames, code keywords, focused buttons, the cursor block. |

**Rule of thumb:** if more than ~5% of any visible screen is `--accent`, the design is wrong. The accent is a punctuation, not a fill.

### Preattentive State Tokens

These are the 5 named state colors. Each is a single character (●) in the footer or sidebar. They convey state at sub-250ms recognition speed.

| State | Token | Hex | When it appears |
|---|---|---|---|
| Idle / Ready | `--state-idle` | `#7FB069` | Sage. Agent is ready, waiting for input. |
| Thinking | `--state-thinking` | `#E8B339` | Amber. LLM is generating a response. |
| Tool-running | `--state-tool` | `#5B9BD5` | Blue-gray. Tool execution (bash, edit, read) in progress. |
| Needs approval | `--state-approval` | `#C1443E` | Terracotta. Permission prompt or question. |
| Learning / Memory-write | `--state-learning` | `#8E7AB5` | Dusty violet. Memory is being extracted/written. |

**Animation:** none in v1. State dots are static. The only visual change is the *color* swap when state changes. (Optional v2: pulse for thinking, blink for needs-approval.)

### Syntax Highlighting

Used inside framed code blocks. Warm and literary, not neon.

| Element | Hex | Notes |
|---|---|---|
| Keywords (`const`, `function`, `return`, `if`, `await`) | `#D97706` | Same as `--accent` — keywords ARE the focal points |
| Strings | `#7FB069` | Sage. Same as `--state-idle`. |
| Numbers | `#E8B339` | Amber. Same as `--state-thinking`. |
| Comments | `#6F5D46` | Faded brown. Recedes. |
| Functions | `#E8B339` | Amber. Same as numbers. |
| Operators / Punctuation | `#F5E6C8` | Same as `--foreground`. |

---

## 3. Typography Rules

**Single typeface. Single size.** All hierarchy comes from case, letter-spacing, and color.

### Font

```css
font-family: 'IBM Plex Mono', 'Berkeley Mono', 'Commit Mono',
             'JetBrains Mono', monospace;
```

**Why IBM Plex Mono:** it bridges the mechanical precision of a typewriter with the proportions of 19th-century book printing. Available free via Google Fonts.

**Substitutes** (in order of preference if Plex Mono unavailable):
1. Berkeley Mono (commercial, perfect fit)
2. Commit Mono (free, Plex-adjacent)
3. JetBrains Mono (free, slightly more modern)

**Never use:** sans-serif, serif, anything with ligatures enabled by default.

### Size & Line Height

- **Font size:** 13px (or 14px for accessibility).
- **Line height:** 1.4. Terminal-tight — NOT generous web spacing. Every line is a row of cells.
- **Letter spacing (default):** 0 (monospace already has fixed advance).

### Hierarchy via Case + Letter-spacing

There is **no font-size hierarchy**. Headers differ from body only via:
1. UPPERCASE: `text-transform: uppercase`
2. Letter-spacing: `letter-spacing: 0.15em`
3. Sometimes: color shift (to `--accent` for section banners)

```css
.heading {
  text-transform: uppercase;
  letter-spacing: 0.15em;
  color: var(--accent);  /* optional */
}

.body {
  /* defaults — no transform, no spacing, foreground color */
}

.dim {
  color: var(--foreground-dim);
}
```

### Decorative Banners

Section titles use ASCII banners (not CSS dividers):

```
════════ CONTEXT ════════
════════ PREFERENCES ════════
════════ APPROVAL REQUIRED ════════
```

Always uppercase, always centered within their container. The `═` characters use `--accent` color; the inner title also uses `--accent`.

---

## 4. Component Stylings

### Button

Buttons do not look like buttons. They look like cased text.

```html
<button class="btn">[ Y ]es</button>
```

```css
.btn {
  font-family: inherit;
  background: transparent;
  border: none;
  border-radius: 0;
  color: var(--accent);
  padding: 0;
  letter-spacing: 0.05em;
}

.btn:hover { background: var(--accent); color: var(--background); }
.btn[disabled] { color: var(--foreground-dim); }
```

**Button variants:**
- `[Y]es` — focal/primary action, accent color
- `[N]o` — secondary, foreground color
- `[A]lways` — tertiary, dim color

### Input Field

```html
<div class="input-frame">
  ┌──────────────────────────────────────┐
  │ &gt; <span class="cursor">█</span>    │
  └──────────────────────────────────────┘
</div>
```

The input is a single row of monospace text inside ASCII box-drawing characters. The cursor is a solid `█` character in `--accent` color. No CSS borders.

```css
.input-frame { background: var(--surface-recess); color: var(--foreground); }
.cursor { color: var(--accent); }
```

### Card / Section

Sections use decorative ASCII banners as their headers. No CSS borders.

```html
<section>
  <h2>════════ CONTEXT ════════</h2>
  <p>argent-x (main)</p>
  <p>[████████░░░░] 42k/200k</p>
  <p>$0.42</p>
</section>
```

The `█` and `░` in the progress bar inherit foreground colors. The `═` border characters are `--accent`.

### List

Use `❧` (or `›`) prefix for memory facts, em-dash `—` for less-emphatic items.

```
❧ prefers TypeScript strict
❧ pnpm, not npm
❧ based in London
```

The prefix character takes `--accent` color. Body text takes `--foreground`. Never use `<ul><li>` semantics with bullet points — bullets are visual noise.

### Tab Bar

Active session tab is wrapped in **double-line** box-drawing (`║`). Inactive tabs separated by single `│`.

```
║ ● work-20260424 ║   │ + new
```

The `●` inside the active tab is `--state-idle` (or whatever the current state is). The `║` characters are `--accent`. The `│` separators are `--foreground-dim`.

### Modal

Modal frame is double-line box-drawing in either `--accent` (informational) or `--state-approval` (terracotta, when needs-approval). Background of modal: `--surface-lifted`. Background of underlying terminal is dimmed to ~50% opacity.

```
╔══════════════════════════════════════════════╗
║              ◆ APPROVAL REQUIRED              ║
╠══════════════════════════════════════════════╣
║                                              ║
║  You are about to execute:                   ║
║                                              ║
║      rm -rf node_modules/                    ║
║                                              ║
║  This will remove 234MB and is irreversible. ║
║                                              ║
║  Proceed?  [Y]es   [N]o   [A]lways           ║
║                                              ║
╚══════════════════════════════════════════════╝
```

### Status Footer

Single line, full width, dot-separated:

```
~/argent-x (main) · ↑12k ↓8k · $0.42 · 42%/200k · ● <state-label> · claude-opus-4-7
```

The `●` color matches the current preattentive state. The state-label is one lowercase word.

### Tool Pill

Tools (read, bash, edit) appear as decorative chapters in the chat area:

```
━━━ [read]  src/argent-x/balance.ts            ━━━ ✓
━━━ [bash]  pnpm test                          ━━━ ▶ running
━━━ [edit]  src/argent-x/balance.ts            ━━━ ✓
```

The `[name]` tag uses `--accent`. The `✓` is `--state-idle`. The `▶` is `--state-tool`. The `━` decorations are `--divider`.

---

## 5. Layout Principles

**Grid:** monospace character grid. 1 cell ≈ 7.8px wide × 18.2px tall (at 13px IBM Plex Mono, line-height 1.4).

**Standard wide-desktop terminal viewport:** 160 columns × 45 rows.

**Two-pane layout:**
- Left pane (chat area): cols 1–110 (~70%)
- Right pane (sidebar): cols 112–160 (~30%)
- The 1-column gap (col 111) inherits the background — no visible divider.

**Persistent regions (always visible):**
- Row 1: tab bar
- Rows 2–43: split-pane content
- Row 44: separator (────...)
- Row 45: status footer

**Modal overlays:**
- Dim the entire terminal underneath to ~50% opacity (`opacity: 0.5`).
- Modal sits centered, around row 18 vertically.
- Modal width varies by content: ~50% for approval, ~80% for memory editor, ~60% for command palette.

**Section spacing within the sidebar:**
- One blank row between sections.
- Section titles always banner-formatted: `════════ TITLE ════════`.

**Whitespace:** generous within sections (let breathing happen between paragraphs); tight between cells (no extra space inside the monospace grid). Whitespace is character columns, not CSS margin/padding.

---

## 6. Depth & Elevation

**There is no concept of "elevation" via shadows.** SumoCode's depth is achieved through **tonal recess** and **character-based framing**.

### Tonal Layering

Stack from deepest to highest:
1. `--surface-recess` (#120D0A) — input prompt area, code blocks (carved INTO the canvas)
2. `--background` (#1A1511) — main canvas
3. `--surface` (#241D17) — sidebar, panels (sitting ON the canvas)
4. `--surface-lifted` (#3A342F) — modals (floating over the canvas)

### The "Floating Modal" Pattern

Modals do not float via `box-shadow`. They float via:
1. ASCII border frame (double-line `╔══╗`).
2. Background color shift to `--surface-lifted`.
3. Underlying terminal dimmed to `opacity: 0.5`.
4. Optional 1-character offset to suggest physical placement on top.

### What is FORBIDDEN

- ❌ `box-shadow` (any value)
- ❌ `border-radius` (any value > 0px)
- ❌ `filter: blur(...)` (no glassmorphism)
- ❌ `background: linear-gradient(...)` (no gradients)
- ❌ Hover state animations (no transitions)
- ❌ Fade-in / slide-in entrance animations
- ❌ Drop caps, pull quotes, decorative imagery

---

## 7. Do's and Don'ts

### Do
- **Treat every character as a structural unit.** Align by column.
- **Use box-drawing as architecture.** ┌ ─ ┐ │ └ ┘ are walls and corners, not decoration.
- **Reserve color for meaning.** Burnt orange = focus. State dots = state. That's it.
- **Embrace whitespace as separator.** Empty rows between sections > visual dividers.
- **Keep one weight, one size, one font.** Hierarchy is case + spacing + color.
- **Truncate when needed.** Use `…` and elide rather than wrap.
- **Show the agent's state at all times.** The state dot in the footer is non-negotiable.
- **Be terse.** "Remembered." not "Got it, I've saved that to memory!"

### Don't
- ❌ Add a logo, app name banner, or branding inside the terminal viewport.
- ❌ Use emojis as content. Box-drawing and ANSI symbols only.
- ❌ Animate state changes with transitions.
- ❌ Use color to "decorate" — only to convey meaning.
- ❌ Add hover effects. This is a terminal — nothing hovers.
- ❌ Apply `box-shadow`, `border-radius`, or gradients anywhere.
- ❌ Use sans-serif fonts for any element.
- ❌ Write apologetic copy. "Sorry, I can't do that" → "Cannot."

---

## 8. Responsive Behavior

SumoCode lives in a terminal emulator that the user can resize. The design must adapt at three breakpoints by **terminal column count**, not pixel width.

### Wide (≥ 120 columns) — default

Full layout: chat area + sidebar visible. Sidebar shows all 3 sections (Context, MCP, Memory).

### Medium (80–119 columns)

Sidebar **hidden**. Main chat area expands to full width. Footer still shows full status line. Memory access via `/sumo:memory show` slash command brings it up as a modal overlay.

### Narrow (< 80 columns)

Single-column layout. Footer compresses to just `branch · cost · ● state · model` (no token gauge). All overlays still work but expand to fill available width.

### Implementation note

The sidebar visibility is gated by Pi's `ctx.ui.custom({ overlay: true, visible: (termWidth) => termWidth >= 120 })` callback — so it auto-adapts in real-time as the user resizes their terminal.

---

## 9. Agent Prompt Guide

Use these phrases to direct Claude (or any AI coding agent) to produce SumoCode-on-system output.

### When asking for new screens

> "Render this as a terminal-native screen in SumoCode style. Follow the Cathedral DESIGN.md: 160×45 monospace grid, IBM Plex Mono, aged walnut background `#1A1511`, burnt orange accents `#D97706` only at focal points, state dot in the footer, ASCII box-drawing borders (no CSS borders), no rounded corners, no shadows."

### When asking for code blocks

> "Use the Cathedral syntax highlighting palette: keywords `#D97706` burnt orange, strings `#7FB069` sage, numbers `#E8B339` amber, comments `#6F5D46` faded brown. Frame the code block in double-line box-drawing characters."

### When asking for status states

> "Add a `●` state dot in the footer. Use `--state-idle #7FB069` for ready, `--state-thinking #E8B339` for thinking, `--state-tool #5B9BD5` for tool-running, `--state-approval #C1443E` for needs-approval, `--state-learning #8E7AB5` for memory writes. Pair the dot with one lowercase word: ready, thinking, working, needs you, learning."

### When asking for copy

> "SumoCode product voice rules: one word when possible. Confident, never apologetic. Ambient, stays out of the way. No exclamation marks. Present tense preferred. No emoji. UPPERCASE LETTER-SPACED for section titles, regular case for body."

### When asking for components

> "Use the existing component vocabulary: tab bar (`║ ● tab-name ║ │ + new`), section banners (`════════ TITLE ════════`), tool pills (`━━━ [name] target ━━━ status`), input frame (single-line box-drawing), modal (double-line box-drawing centered with dimmed background)."

### Anti-patterns to flag

If any of these appear in agent output, reject and re-prompt:
- Web-app navigation menus (EDITOR | TERMINAL | SETTINGS — wrong)
- Logo or branding inside the viewport (no SUMOCODE banner — wrong)
- Modal-only views without surrounding terminal context (wrong)
- Bullet lists with `•` or hyphens (wrong — use `❧` or `—` em-dash)
- Hover states or fade-in transitions (wrong — terminal has none)
- `border-radius`, `box-shadow`, `linear-gradient` in the CSS (wrong)
- Apologetic copy ("Sorry, I wasn't able to…") — replace with terse direct statement.

---

*Last updated: 2026-04-24 · v0.1.0 · Direction: Cathedral.*
*Source for this format: [awesome-claude-design](https://github.com/VoltAgent/awesome-claude-design) 9-section template.*
