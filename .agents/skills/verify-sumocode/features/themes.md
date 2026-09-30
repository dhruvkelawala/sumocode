# Theme selector

The theme selector lists SumoCode themes and marks the current choice. Choosing a theme changes the live palette and persists the name for the next launch; cancelling leaves it unchanged.

## Sub-features

- `theme-slash`: `/theme` opens the selector.
- `theme-sumo-slash`: `/sumo:theme` opens the same selector.
- `theme-apply`: a name argument or selector confirmation applies and persists the choice. Mapped, unproven.
- `theme-cycle`: Ctrl+Shift+T or Alt+T cycles the theme. Mapped, unproven.
- `theme-preview`: `/sumo:theme-check` previews theme tokens. Mapped, unproven.

## How to get to it (user POV)

- Submit `/theme` or `/sumo:theme` without an argument.
- Choose THEME in the command palette.
- Submit `/theme amber-crt` or `/sumo:theme amber-crt` to apply a name directly.
- Press Ctrl+Shift+T or Alt+T to cycle; submit `/sumo:theme-check` to preview tokens.

## Driving it with SumoCode PTY harness

Preconditions: [the baseline](README.md#baseline-preconditions), isolated agent config, healthy owned PTY.

- **Primary command.** Run `pnpm vitest run --config .agents/skills/verify-sumocode/scripts/vitest.config.mjs -t theme-slash`. It submits `/theme\x1b[13u` and waits for `CHOOSE SUMOCODE THEME`.
- **Alias.** Use `-t theme-sumo-slash` for `/sumo:theme\x1b[13u`. The same heading and choices appear.
- **Proof.** Inspect `after.txt` for the theme list and current-choice dot. Require 1 passed per invocation and the final 0-survivor audit. No theme is applied by these recipes.
- **Coverage gap.** Palette entry, direct-name application, cycling, preview, and cancellation need helper extensions through real PTY input. To prove persistence, apply `amber-crt`, inspect `<agentDir>/sumocode.json` read-only for `themeName`, relaunch with that same isolated profile, and capture the current-choice marker. Keep all state outside the checkout. Colours require the visual capture pipeline, not this text assertion.

## Gotchas

- Rendered selector titles are uppercase; handler text `Choose SumoCode theme` is not the screen matcher.
- The current dot and highlighted row are different. Opening the list does not mean its first row is the saved theme.
- A successful visual change alone does not prove persistence. A failed config write can change the palette but warn that it was not persisted.
- `list` is not a special retained-host theme argument; verify known names, not classic-command assumptions.
