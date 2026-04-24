# DESIGN SYSTEM: THE OBSIDIAN DIRECTION

## 1. Overview & Creative North Star
**Creative North Star: The Brutalist Ledger**

This system treats the screen not as a window, but as a high-precision instrument. It rejects the "soft" web — moving away from rounded, colorful abstractions of modern SaaS — and returns to the raw, uncompromising authority of the terminal.

It achieves a "High-End Editorial" feel through the masterful use of whitespace, intentional asymmetry, and the rhythmic repetition of monospace characters. Depth is not made with shadows — it is *carved* from tonal contrast in the void.

It is a system designed for focus, where the only thing that matters is the logic of the code.

---

## 2. Colors

### Core Palette
- **Background (`surface-dim`):** `#000000` — the absolute void
- **Surface (`surface-container`):** `#0C0C0C` — subtle elevation
- **Divider (`outline-variant`):** `#1F1F1F`
- **Foreground (`on-surface`):** `#FAFAFA`
- **Dim (`on-surface-variant`):** `#6B6B6B`
- **Hero accent:** *NONE.* The interface is monochrome by design.

### Functional State Dots
The only "chromatic" moments in the UI. Treat them like physical LEDs on a vintage server rack.
- **Idle:** `#8FB28C` (Muted Sage)
- **Thinking:** `#D4B76A` (Ochre)
- **Tool-Running:** `#7FA8C9` (Steel Blue)
- **Needs-Approval:** `#C97070` (Dusty Rose)
- **Learning-Write:** `#9A8FBA` (Muted Lavender)

### The "No-Line" Rule
Prohibit standard borders. Use background shifts instead. A code block sits on `surface-container-lowest` (#0E0E0E) against `background` (#000000). If a line is strictly required, use a single horizontal box-drawing character (`─`) in the divider color.

---

## 3. Typography
Hierarchy is the primary driver. Single weight (400), single typeface — manipulate **case** and **letter-spacing** for importance.

- **Typeface:** Monaspace Neon or JetBrains Mono
- **Body:** Mixed case, standard tracking
- **Section Headers:** `UPPERCASE` with `0.15em` letter-spacing
- **Hierarchy through indentation:** 2-4 spaces, never font-size changes
- **Syntax:** pure grayscale (#FAFAFA keywords, #6B6B6B strings, #1F1F1F comments)

---

## 4. Elevation & Depth
Depth via **Tonal Recess**, not shadows.

- Base: `#000000` (workspace)
- Interactive: `#0C0C0C` (focused panel)
- Active element: background inversion (`bg #FAFAFA`, `text #000000`)
- Modals: 1px solid border using `outline` `#919191`, BIOS-window aesthetic

---

## 5. Components

### Buttons
Commands, not buttons.
- **Primary:** Inverted (black text on `#FAFAFA`)
- **Secondary:** `[ EXECUTE ]` with brackets
- **Tertiary:** Dim text with em-dash prefix `— cancel`

### State Indicators (Dots)
6×6px square (0px radius), accompanied by label in dim color.

### Input Fields
Single-pixel underline in divider color. Cursor is a solid block `█`.

### Lists
- No bullets. Use em-dash `—`.
- Selection: trailing `_` or `#1F1F1F` background highlight.
- Nesting: exactly 2-character indent.

---

## 6. Do's and Don'ts

### Do
- Embrace asymmetry. Align actions to far right or left.
- Use box-drawing characters sparingly to frame critical AI responses.
- Maximize whitespace. At least 24px between major logical sections.
- Keep syntax highlighting strictly grayscale.

### Don't
- No rounded corners. Even 2px ruins the monolith.
- No emojis. Use text indicators (`[ERROR]`, `[SUCCESS]`).
- No gradients. Hard color steps only.
- No transitions. Instant or typewriter-style only.

---

**Stitch project:** https://stitch.withgoogle.com/project/17040355726862303555
**Generated screen:** Approval prompt (REQUIRED-APPROVAL)
