# DESIGN SYSTEM: THE CATHEDRAL DIRECTION

## 1. Overview & Creative North Star
**Creative North Star: The Digital Scriptorium**

This design system rejects the ephemeral nature of modern web software in favor of the "Interface as Crafted Artifact." It is a terminal-native environment that evokes the weight, silence, and intellectual rigor of a 19th-century monastic library. We are not building a "tool"; we are crafting a mahogany desk upon which the heavy work of logic is performed.

To achieve this, the system moves beyond standard grid-based layouts. It utilizes intentional asymmetry and the rigid geometry of ANSI box-drawing characters to create a sense of architectural permanence. We do not use "modern" crutches like rounded corners or blurs; instead, we find elegance in the precision of the monospace grid and the tonal depth of aged vellum and dark walnut.

---

## 2. Colors & Tonal Depth
The palette is rooted in natural materials—wood, paper, leather, and ink.

### The Palette
- **Background (`surface-dim`):** `#1A1511` (Aged Walnut). The foundational layer.
- **Surface (`surface-container`):** `#241D17` (Mahogany). For primary interaction areas.
- **Foreground (`on-surface`):** `#F5E6C8` (Warm Vellum). High-contrast reading.
- **Dimmed (`on-surface-variant`):** `#8B7A63` (Oxidized Paper). For secondary meta-data.
- **Accent (`primary`):** `#D97706` (Burnt Orange). Reserved for the "Hero" focus.

### Preattentive State Tokens
Status is conveyed through muted, organic tones rather than neon "app" colors:
- **Idle:** `#7FB069` (Sage)
- **Thinking:** `#E8B339` (Amber)
- **Tool-Running:** `#5B9BD5` (Blue-Gray)
- **Needs-Approval:** `#C1443E` (Terracotta)
- **Learning:** `#8E7AB5` (Violet)

### Surface Hierarchy
Nesting is achieved through "Carving." To emphasize a code block or a side-panel, "carve" into the background by using a lower-tier surface color, or "stack" a mahogany surface atop the walnut background.
- **Deepest:** `surface-container-lowest` (`#120d0a`) for terminal input zones.
- **Highest:** `surface-container-highest` (`#3a342f`) for active dialogue windows.

---

## 3. Typography: The Monospace Manuscript
We use **IBM Plex Mono** exclusively. This choice bridges the gap between the mechanical precision of a typewriter and the classic proportions of 19th-century printing.

- **The Small-Caps Rule:** All headers must be implemented in **uppercase with letter-spacing (0.1em)** to mimic the titling of leather-bound volumes.
- **Line Height:** A strict **1.65** ratio must be maintained for body text.

---

## 4. Elevation & Depth: Tonal Layering
In a terminal-native environment, shadows do not exist. Depth is an illusion created by the interplay of value and character-based framing.

Instead of a shadow, a "floating" window is represented by:
1. An ANSI border frame (`#3A2F25`).
2. A background color shift to a higher surface tier (`surface-container-high`).
3. An intentional 1-character "offset" to create an asymmetric margin.

---

## 5. Do's and Don'ts

### Do:
- **Embrace Asymmetry:** Let the terminal text flow naturally.
- **Use "White Space" as Structure:** The absence of characters defines relationships.
- **Treat Characters as Ink:** Use dimmed colors for anything that isn't the primary focus.

### Don't:
- Never use emojis. Use ANSI symbols (`▲`, `▼`, `◆`) if icons are required.
- No gradients or shadows.
- No rounded corners.
- No animations beyond instantaneous or typewriter-style reveals.

---

**Stitch generated screen(s):** https://stitch.withgoogle.com/project/10407008491408344048
