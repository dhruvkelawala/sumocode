# DESIGN SYSTEM: AMBER CRT

> Aligns SumoCode with Mission Control v3's established amber-phosphor palette.
> Cross-agent visual consistency in the SumoDeus family.

## Mood
Apple II / IBM 5151 phosphor terminal modernized for 2026. Information dense like htop crossed with Bloomberg Terminal. Warm but practical. Sustainable for 8-hour sessions. Nothing theatrical.

## Palette
- Background `#0A0806` — warm dark brown, near-black
- Surface `#14100A`
- Panel `#1F180F`
- Foreground `#FFB000` — amber phosphor (primary text — NOT white)
- Foreground-2 `#CC8C00` — dim amber (secondary)
- Foreground-3 `#805800` — deep amber (muted)
- Accent gold `#FFD700` — active tab frame, focal
- Accent red `#FF5500` — emphasis, sparingly
- Status green `#00FF66` — success / idle
- Status cyan `#00E5FF` — review / info
- Status red `#FF0033` — errors
- Border `#4D3500` — dark amber

## Effects
- Body radial gradient: `radial-gradient(circle at top, #201405, #0A0806 40%)`
- CRT scanlines: 1px-tall darker line every 3px, `rgba(0,0,0,0.25)`, body::before, opacity 0.4
- Soft text-shadow on focal items: `0 0 4px <amber-color>` at 30% intensity

## Typography
- IBM Plex Mono only
- 13px body, line-height 1.5, letter-spacing 0.02em
- UPPERCASE + 0.08em letter-spacing for section headers
- No italic anywhere
- VT323 (retro pixel font) for boot screens / status flashes — opt-in

## Component vocabulary
- Active tab: `║ ● work-20260424 ║` — double-line cartouche in gold, green status dot
- Section banner: `════════ TITLE ════════`
- Memory items: `❧` prefix in gold, body in amber
- Cursor: `█` solid block in gold
- Status dots: ● colored per state, sparingly glowing

## Stitch generation
Project: https://stitch.withgoogle.com/projects/5385606235875789209
Generated: 2026-04-24, GEMINI_3_1_PRO

## Notes
Stitch took creative liberty with sidebar content — generated generic "system stats" instead of literal MCP server list / memory facts I specified. Aesthetic vocabulary is locked correctly. Final implementation in Pi TUI uses the literal content from PLAN.md sidebar specification.
