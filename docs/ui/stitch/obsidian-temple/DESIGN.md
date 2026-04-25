# DESIGN SYSTEM: OBSIDIAN TEMPLE

> "The Alchemist's Console" — a digital priest's working terminal.
> Dystopian sacred-tech: ancient stone meets neon glow.
> NOT literal Egypt. Subtle, polished, slightly Blade Runner.

## Mood
A working terminal for an agent who believes in itself. Sacred but technological. The user is sitting at a polished obsidian altar in a dim chamber, lit by lapis-lazuli neon and warm electrum gold. The body text is calm bronze; the gold and neon accents are punctuation, not fill.

## Palette
- Background `#050308` — deep obsidian, near-black with violet undertone
- Surface `#0D0815` — polished granite
- Panel `#14091F` — sidebar (deep violet stone)
- Deepest `#020104` — input prompt zone (the void)
- Foreground `#D4B896` — aged papyrus / warm bronze (primary text — NOT amber)
- Foreground-2 `#8B7355` — oxidized bronze (secondary)
- Foreground-3 `#4A3F30` — dark sandstone (muted)
- Hero gold `#F0B400` — electrum gold (primary accent)
- Sacred gold `#FFD700` — ceremonial gold (active states, cartouche)
- Lapis blue `#1E40AF` — deep lapis lazuli
- Neon cyan `#00E5FF` — thinking ignition (glows)
- Neon magenta `#FF00AA` — sacred memory writes (glows)
- Sacred green `#00C896` — malachite life / idle / ok
- Burial red `#B91C1C` — carnelian error / urgency
- Border `#2A1F40` — deep violet-purple
- Border sacred `#FFD700` — gold for important frames

## Effects
- CRT scanlines: same as Amber CRT (1px every 3px, rgba(0,0,0,0.25))
- Sacred glow (text-shadow on focal items only):
  - thinking: `0 0 6px #00E5FF, 0 0 16px rgba(0,229,255,0.4)`
  - memory: `0 0 6px #FF00AA, 0 0 16px rgba(255,0,170,0.4)`
  - tool: `0 0 4px #FFAA00`
  - cursor: cyan glow
- Subtle chromatic aberration on left/right edges: 2% magenta gradient (left), 2% cyan gradient (right), mix-blend-mode screen, only 40px wide

## Typography
- IBM Plex Mono primary
- VT323 for boot / system flashes
- Cinzel (serif display) for ceremonial moments only — boot wordmark, modal titles
- Body 13px / line-height 1.5
- UPPERCASE + 0.08em letter-spacing for section banners

## Component vocabulary
- Active tab: cartouche-style oval brackets `⟨ 𓋹 work-20260424 ⟩` — the brackets in sacred gold, ankh glyph in sacred green with glow
- Section banners with sacred glyph prefix:
  - `══════ 𓂀 CONTEXT ══════` (Eye of Horus)
  - `══════ ⚛ MCP ══════` (atom)
  - `══════ 𓏛 MEMORY ══════` (scarab)
- Memory items: `❧` prefix in neon magenta with magenta glow (sacred markers)
- Cursor: `█` block in sacred gold with cyan glow halo
- Status dots: ● with selective glow per state

## Stitch generation
Project: https://stitch.withgoogle.com/projects/2703501899413407623
Generated: 2026-04-24, GEMINI_3_1_PRO

## Notes
Stitch's interpretation went stronger on theatrical "ALCHEMIST_CONSOLE / OBSIDIAN_OS" branding than asked, and brought back a top nav bar (TERMINAL / WORKSPACE / NETWORK / RITUALS) which we explicitly forbade. The aesthetic vocabulary (palette, glow, bronze body text, cartouche tab) is on-spec. Implementation in Pi TUI uses the literal content from PLAN.md.
