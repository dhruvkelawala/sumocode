# Claude Design Prompt — SumoCode Cathedral Direction

> Paste the prompt below into a fresh Claude conversation (with Artifacts on).
> Claude renders interactive HTML+CSS; results are pixel-accurate to a real
> terminal because we can control the DOM directly.

---

## The prompt

```
I want you to design an HTML+CSS prototype of a terminal-native AI coding 
assistant called SumoCode. Render it as a single self-contained HTML 
artifact I can preview. The output must visually represent a 
SCREENSHOT of a real terminal emulator (Ghostty/Kitty/iTerm2) running this 
program — not a web app, not an IDE, not a dashboard. A monospace grid, 
ANSI-rendered, every cell aligned.

═══════════════════════════════════════════════════════════════════════
HARD VISUAL CONSTRAINTS (non-negotiable)
═══════════════════════════════════════════════════════════════════════

1. ENTIRE INTERFACE is monospace. Use `font-family: 'IBM Plex Mono', 
   'Berkeley Mono', 'JetBrains Mono', monospace`. Every character occupies 
   exactly one cell.

2. Terminal grid: render the page as exactly 160 columns × 45 rows. Use 
   `font-size: 13px` and `line-height: 1.4` so the character cell is ~7.8px 
   wide × 18.2px tall, giving a viewport of approximately 1248×819 px. 
   Wrap the entire UI in a single `<pre>` or grid container.

3. NO rounded corners (`border-radius: 0` everywhere). NO shadows. NO 
   gradients. NO transitions. NO hover effects. This is a static screenshot 
   of a terminal — there is no interactivity, no animations.

4. Borders are EXCLUSIVELY box-drawing characters from Unicode (┌ ─ ┐ │ 
   └ ┘ ├ ┤ ┬ ┴ ┼ ╔ ═ ╗ ║ ╚ ╝ ╠ ╣ ╦ ╩ ╬). Never `border: 1px solid`. The 
   borders are CHARACTERS in the DOM, not CSS borders.

5. The interface IS the content. There is no header bar, no nav menu, no 
   logo. The terminal is the whole window. (No "SumoCode" branding text 
   anywhere — the user already knows what they launched.)

6. NO emojis. Use ANSI symbols only: ● for status dots, ◆ ▶ ❧ ★ ✓ ✕ for 
   markers, └ ─ etc for structure.

═══════════════════════════════════════════════════════════════════════
DESIGN SYSTEM: "CATHEDRAL"
═══════════════════════════════════════════════════════════════════════

Mood: A 19th-century scriptorium. The terminal of a senior engineer at 
their mahogany desk. Information-dense without clutter. Warm, 
contemplative, deliberately slow.

PALETTE (use these hexes exactly):
- Background:        #1A1511   (aged walnut)
- Surface:           #241D17   (mahogany — for sidebar bg, code blocks)
- Surface-recess:    #120D0A   (deepest — for input prompt)
- Surface-lifted:    #3A342F   (modal background — slightly lifted)
- Foreground:        #F5E6C8   (warm vellum — primary text)
- Foreground-dim:    #8B7A63   (oxidized paper — secondary text)
- Divider:           #3A2F25   (subtle dividers)
- Hero accent:       #D97706   (burnt orange — for important moments only)

PREATTENTIVE STATE DOTS (single colored ● character, never animated):
- idle:              #7FB069   (sage)
- thinking:          #E8B339   (amber)
- tool-running:      #5B9BD5   (blue-gray)
- needs-approval:    #C1443E   (terracotta)
- learning-write:    #8E7AB5   (dusty violet)

SYNTAX HIGHLIGHTING (when showing code):
- keywords:          #D97706   (burnt orange — const, function, return)
- strings:           #7FB069   (sage)
- numbers:           #E8B339   (amber)
- comments:          #6F5D46   (faded)
- functions:         #E8B339   (amber)

TYPOGRAPHY:
- One size, IBM Plex Mono throughout. Single weight (400) for body text.
- Section headers and emphasis use UPPERCASE WITH LETTER-SPACING 
  (`letter-spacing: 0.15em; text-transform: uppercase`). Never bold, 
  never font-size differences.
- Line height: 1.4 (terminal-tight, NOT generous).

═══════════════════════════════════════════════════════════════════════
LAYOUT TEMPLATE (for ALL 6 screens)
═══════════════════════════════════════════════════════════════════════

Three persistent regions, always visible. Use CSS Grid.

ROW 1 (top, 1 character tall) — TAB BAR:
   Format: ║ ● work-20260424 ║   │ + new
   The active session tab is wrapped in DOUBLE-LINE box-drawing characters
   (║) in burnt orange (#D97706). The sage state dot ● appears inside 
   the active tab. Other tabs use single │ separators in dim foreground.

ROWS 2-43 (middle, 42 rows tall) — SPLIT PANE:
   - LEFT pane (cols 1-110, ~70%) — main chat area. Background: aged walnut.
   - RIGHT pane (cols 112-160, ~30%) — sidebar. Background: mahogany 
     (#241D17). The 1-column gap (col 111) is the same as background.
   - The sidebar contains exactly 3 sections. Each section's title is a 
     decorative banner in burnt orange:
     
     ════════ CONTEXT ════════
     argent-x (main)
     [████████░░░░] 42k/200k
     $0.42
     
     ════════ MCP ════════
     ● stitch        ok
     ● context7      ok
     ● github        ok
     ● railway       idle
     
     ════════ MEMORY ════════
     ❧ prefers TypeScript strict
     ❧ pnpm, not npm
     ❧ based in London
     ❧ Argent · argent-x
     ❧ imperative commits
     11 more · ⌘M
     
   - The MCP dots ● use the state colors (idle #7FB069 for "ok", 
     dim #8B7A63 for "idle", terracotta #C1443E for "down").

ROW 44 (separator) — single line of ─ characters in divider color, 
    spanning full 160 cols.

ROW 45 (footer) — single line, full width:
   ~/argent-x (main) · ↑12k ↓8k · $0.42 · 42%/200k · ● <state-label> · claude-opus-4-7
   
   The state dot ● uses the appropriate state color for the screen we're 
   rendering. The state-label is a single lowercase word: ready, thinking, 
   working, needs you, learning.

═══════════════════════════════════════════════════════════════════════
WHAT GOES IN THE LEFT PANE (varies by screen)
═══════════════════════════════════════════════════════════════════════

Generate 6 separate HTML artifacts, one per screen. Each is a complete 
self-contained HTML page with the layout template above, varying only the 
chat area content and footer state.

──────── SCREEN 1: IDLE ────────
Footer state: ● ready (#7FB069 sage)
Chat area: Mostly empty. Near top, in dim text:
  "Perfection is achieved when there is nothing left to take away."
  — Saint-Exupéry
A vast empty middle. Near the bottom of the chat area, a framed input 
prompt — single-line border:
  ┌──────────────────────────────────────────────────────────────────────┐
  │ > _                                                                  │
  └──────────────────────────────────────────────────────────────────────┘
The cursor `_` should be a solid block █ in burnt orange (#D97706).
That's it. Most of the screen is intentionally empty.

──────── SCREEN 2: STREAMING ────────
Footer state: ● thinking (#E8B339 amber)
Chat area shows a partial assistant response, mid-stream:

  ── APPROACH ──
  
  I'll wire the React Query state into a custom `useArgentBalance` hook 
  that handles the loading and error states cleanly.
  
  ╔══════════════════════════════════════════════════════════════════════╗
  ║ 1  function useArgentBalance(account: string) {                     ║
  ║ 2    return useQuery({                                              ║
  ║ 3      queryKey: ['balance', account],                              ║
  ║ 4      queryFn: () => fetchBalance(account),                        ║
  ║ 5      staleTime: 30_000,                                           ║
  ║ 6    });                                                            ║
  ║ 7  }                                                                ║
  ╚══════════════════════════════════════════════════════════════════════╝
  
  This caches for 30 seconds and re-fetches on focus. We can adjust 
  staleTime based on network latency.

Code keywords (`function`, `return`) in burnt orange. Strings ('balance') 
in sage. Numbers (30_000) in amber. The double-line box framing the code 
block uses divider color. There should be a small "● thinking…" indicator 
at the bottom of the chat area in amber, just above the input zone.

──────── SCREEN 3: TOOL-RUNNING ────────
Footer state: ● working (#5B9BD5 blue-gray)
Chat area shows three tool invocations as decorative chapters:

  ━━━ [read]   src/argent-x/balance.ts            ━━━ ✓
  ━━━ [bash]   pnpm test --filter @argent/sdk     ━━━ ▶ running
  ━━━ [edit]   src/argent-x/balance.ts            ━━━ ✓
  
  ┌── DIFF ─────────────────────────────────────────────────────────────┐
  │ - const balance = await provider.getBalance(account);              │ ← burnt orange
  │ + const balance = await argentClient.fetchBalance(account, {       │ ← sage green
  │ +   blockTag: 'latest',                                            │ ← sage green
  │ + });                                                              │ ← sage green
  └─────────────────────────────────────────────────────────────────────┘

The "▶ running" on the bash row is in blue-gray. The ✓ checks are in 
sage. The diff: removed lines burnt orange (#D97706), added lines sage 
(#7FB069), prefix `-`/`+` matches.

──────── SCREEN 4: APPROVAL ────────
Footer state: ● needs you (#C1443E terracotta)
The full terminal layout (tabs + chat area + sidebar + footer) is visible 
but DIMMED to ~50% opacity (use `opacity: 0.5` on the underlying layout). 
A modal overlays it, centered. Modal frame uses double-line box-drawing in 
terracotta (#C1443E):

  ╔══════════════════════════════════════════════════════════════════╗
  ║                       ◆  APPROVAL REQUIRED                       ║
  ╠══════════════════════════════════════════════════════════════════╣
  ║                                                                  ║
  ║   You are about to execute:                                      ║
  ║                                                                  ║
  ║       rm -rf node_modules/                                       ║
  ║                                                                  ║
  ║   This will remove 234MB and is irreversible.                    ║
  ║                                                                  ║
  ║                                                                  ║
  ║   Proceed?    [Y]es       [N]o       [A]lways                    ║
  ║                                                                  ║
  ╚══════════════════════════════════════════════════════════════════╝

The ◆ marker and "APPROVAL REQUIRED" text in terracotta. The command 
`rm -rf node_modules/` in burnt orange (it's the focal action). Buttons in 
burnt orange. Modal background is surface-lifted (#3A342F). Modal sits at 
about row 18, centered horizontally.

──────── SCREEN 5: MEMORY-EDITOR ────────
Footer state: ● learning (#8E7AB5 dusty violet)
The full terminal layout is visible but DIMMED to ~50% opacity, same as 
approval. Modal overlay, centered, sized larger than approval (covers 
about 80% of the chat area width). Modal styled like a leather-bound 
journal:

  ╔══════════════════════════════════════════════════════════════════════╗
  ║                                                              ● learning ║
  ║                                                                          ║
  ║   ════════ IDENTITY ════════                                            ║
  ║   ❧ You are Dhruv Kelawala, senior engineer at Argent.                 ║
  ║   ❧ Based in London, BST timezone.                                     ║
  ║                                                                          ║
  ║   ════════ PREFERENCES ════════                                         ║
  ║   ❧ TypeScript strict, no any                                          ║
  ║   ❧ pnpm, not npm                                                      ║
  ║   ❧ Prettier: single quotes, no semicolons, 100 cols                  ║
  ║                                                                          ║
  ║   ════════ STACK ════════                                              ║
  ║   ❧ React + Vite + Tailwind v4 (web)                                   ║
  ║   ❧ React Native + Expo (mobile)                                       ║
  ║   ❧ Bun preferred where possible                                       ║
  ║                                                                          ║
  ║   ════════ PROJECTS ════════                                           ║
  ║   ❧ argent-x: Starknet privacy wallet extension                       ║
  ║   ❧ readyx: React Native consumer app                                 ║
  ║                                                                          ║
  ║   ──────────────────────────────────────────────────────────────────   ║
  ║   ⌘S save   ⌘W close   ⌘D delete fact                                  ║
  ╚══════════════════════════════════════════════════════════════════════╝

The "● learning" indicator (top-right corner of the modal) and the ❧ 
markers are dusty violet (#8E7AB5). Section headers in burnt orange.

──────── SCREEN 6: COMMAND-PALETTE ────────
Footer state: ● ready (#7FB069 sage) — palette doesn't change state
The full terminal layout is visible but DIMMED to ~50% opacity. Modal 
overlay centered, narrower than the others (about 60% width). Format:

  ╔══════════════════════════════════════════════════════════╗
  ║                  COMMAND PALETTE                          ║
  ╠══════════════════════════════════════════════════════════╣
  ║                                                          ║
  ║   ┌──────────────────────────────────────────────────┐  ║
  ║   │ ❧ enter command or search...                      │  ║
  ║   └──────────────────────────────────────────────────┘  ║
  ║                                                          ║
  ║   §  session     ►  current: work-20260424              ║
  ║   §  model       ►  current: claude-opus-4-7   ★        ║  ← highlighted row, burnt orange bg
  ║   §  thinking    ►  current: medium                     ║
  ║   §  memory      ►  55 facts                            ║
  ║                                                          ║
  ║   ──────────────────────────────────────────────────    ║
  ║   ↑↓ navigate   ↵ select   esc close                    ║
  ╚══════════════════════════════════════════════════════════╝

The "model" row is the currently-highlighted one — give it a burnt orange 
(#D97706) background with the warm walnut foreground for contrast (color 
inversion). The ★ marks the user's currently-active model.

═══════════════════════════════════════════════════════════════════════
DELIVERABLE
═══════════════════════════════════════════════════════════════════════

Six separate HTML artifacts in your reply, one per screen. Each must:

1. Be a complete self-contained HTML document (not just a snippet).
2. Use the EXACT hex values listed above. No invention.
3. Use box-drawing characters as DOM characters. The borders ARE the 
   content; no `border: ...` CSS rule allowed for the structural framing.
4. Use a single CSS grid or fixed-width <pre> to ensure perfect monospace 
   alignment. If text in the sidebar is shorter than the column width, 
   pad with spaces — never let it auto-flow.
5. Have a fixed terminal-window-shaped viewport (160ch × 45 rows worth of 
   line-height). Wrap in a centered container with the walnut background.
6. Look IDENTICAL to a screenshot of a real terminal — no rounded 
   corners, no shadows, no transitions, no hover effects, no drop caps, 
   no decorative frames around the terminal itself.

After all 6 screens, briefly note any places where the design felt 
constrained or where you'd suggest a deviation — I want your real opinion 
on whether this works.
```

---

## Why this prompt works better than Stitch's

- Stitch interprets "AI coding tool" through its trained "modern editor app" template — it adds web-app navigation menus, fictional product names, and editor-style sidebars no matter how strongly we specify "terminal."
- Claude Design renders **literal HTML/CSS**, so we can lock the DOM structure exactly. The box-drawing characters become DOM nodes, not CSS borders. The grid is enforced by the artifact's actual measurements.
- We can be much more specific about what's *not* in the design (no header, no logo, no nav menu) — Claude follows negation rules, Stitch doesn't.
- Iteration is real-time: paste prompt, look at artifact, give feedback, see new artifact.

## Suggested workflow

1. Start a fresh Claude conversation (Sonnet 4 or Opus, with Artifacts enabled).
2. Paste the prompt above as a single message.
3. Review the 6 artifacts. Resize the artifact pane wide so the 160-col 
   layout doesn't wrap.
4. Iterate by replying with specific changes — e.g., "the terracotta 
   modal frame on screen 4 is too saturated, dim it 20%" — Claude updates 
   the artifact in place.
5. When happy, save each artifact's HTML source to 
   `sumocode/docs/ui/claude-design/<screen>.html` in this repo.
6. Take a screenshot of each artifact at full resolution → save to 
   `sumocode/docs/ui/claude-design/<screen>.png`.
7. Commit and push to `dhruvkelawala/sumocode`.

The HTML artifacts will then serve as the **canonical visual reference** 
for translating to Pi TUI implementation.

---

*Generated 2026-04-24 — by Zeus, in the Temple of SumoDeus, after watching 
Stitch fight us for an hour.*
