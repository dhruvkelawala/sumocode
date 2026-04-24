# DESIGN SYSTEM: THE ORACLE DIRECTION

## 1. Overview & Creative North Star
**Creative North Star: The Sovereign Terminal**

The "ORACLE" direction is a departure from the soft, approachable interfaces of modern web apps. It is a high-fidelity, terminal-native environment that prioritizes technical authority and "The Sovereign Terminal" aesthetic.

This system treats the code editor as a sacred, brutalist archive. It rejects the "gloss" of consumer software in favor of extreme precision, intentional density, and the rhythmic beauty of monospace characters. Asymmetry is achieved through "The Shift" — offsetting blocks of data to create focal points within the terminal's strict boundaries.

---

## 2. Colors & Tonal Logic
The palette is rooted in a deep-space obsidian base, punctuated by high-albedo text and ritualistic accents (Gold and Violet).

### The Palette
- **Background (`background`):** `#0A0D12` (deep navy-black)
- **Working surface (`surface`):** `#11151B`
- **Active overlays (`surface_container_highest`):** `#32353B`
- **Foreground (`on_surface`):** `#E8E6E1` (warm off-white)
- **Dim text (`on_surface_variant`):** `#7A7B7F`
- **Hero accent (`primary`):** `#FFD700` (Zeus gold) — used ONLY for thinking/cognition moments
- **Sacred (`secondary`):** `#B388FF` (violet) — used ONLY for memory-write events

### Preattentive State Tokens
- **Idle:** `#7EE787` (ready green)
- **Thinking:** `#FFD700` (Zeus gold)
- **Tool-Running:** `#4FC3F7` (sky blue)
- **Needs-Approval:** `#FF5252` (alert red)
- **Learning-Write:** `#B388FF` (sacred violet)

### Surface Hierarchy
- **Root:** `background` `#0A0D12` — the empty void
- **Working:** `surface` `#11151B` — primary editor and terminal area
- **Floating:** `surface_container_highest` `#32353B` — command palettes, modals

---

## 3. Typography: The Monospace Mandate
- **Display/Headline:** Berkeley Mono or Commit Mono in **Bold UPPERCASE**
- **Body/Labels:** Regular weight, mixed case
- **Syntax highlighting:** keywords #D4A5FF, strings #A5D6A7, numbers #FFB74D, functions #64B5F6, comments #546E7A

---

## 4. Architectural Depth
In the absence of shadows, depth is a game of "Z-axis Tones."

- **Layering:** Place `surface_container_lowest` (#0B0E13) blocks behind code to inset; place `surface_bright` (#36393F) status bars to lift toward user.
- **Zero shadows.** Modals wrap in double-line box-drawing (`╔══╗`).
- **Zero rounded corners.** Every element 0px radius.

---

## 5. Components

### The "ANSI" Button
Buttons look like status indicators, not buttons.
- **Primary:** `[ Y ] ES` with gold background, dark text, brackets visible.
- **Secondary:** No background, foreground text.

### Box-Drawing Containers
Use `┌──┐ │ │ └──┘` for structural framing instead of CSS borders.

### Tabs
Active tab gets a gold dot `●` prefix; inactive tabs are dim.

---

**Stitch project:** https://stitch.withgoogle.com/project/7454153769354064080
**Generated screen:** Approval prompt (Permission required modal)
