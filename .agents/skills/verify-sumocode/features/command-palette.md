# Command palette

The palette opens an overview of model, thinking, session, memory, theme, and settings controls without sending a prompt to the model.

## Sub-features

- `palette-key`: Ctrl+/ opens the palette over the idle editor.
- `palette-slash`: `/sumo:palette` opens the same palette.
- `palette-destination`: choosing a row opens its control. Mapped, unproven by the opening recipe.
- `palette-cancel`: Escape dismisses the palette. Mapped, unproven.

## How to get to it (user POV)

- Press Ctrl+/ in the retained host.
- Type `/sumo:palette` into the editor and press Enter.
- Choose MODEL, THINKING, SESSION, MEMORY, THEME, or SETTINGS inside the palette for its destination.

## Driving it with SumoCode PTY harness

Preconditions: [the baseline](README.md#baseline-preconditions), idle input, healthy owned PTY.

- **Keyboard.** Run `pnpm vitest run --config .agents/skills/verify-sumocode/scripts/vitest.config.mjs -t palette-key`. It sends `\u001f`; the replayed screen must contain `host controls`.
- **Slash command.** Run the same command with `-t palette-slash`. It sends `/sumo:palette\x1b[13u`; the same palette state must appear.
- **Proof.** Both entry points together use `-t palette`. Require 2 passed, nonempty before/after snapshots and action records in the printed `.evidence/` paths, and 0 survivors after cleanup.
- **Coverage gap.** Destination selection/cancellation need additional PTY steps in the helper, followed by waits for the destination or baseline screen. Opening the palette alone proves neither; memory additionally needs its service.

## Gotchas

- Kitty Ctrl+/ also has `\x1b[47;5u`; the pilot uses the legacy `\u001f` encoding. The alternate encoding is unproven here.
- Wait for the owned app readiness before input, not just its alternate-screen escape sequence.
- This is the retained host palette, not Pi's classic selector. The visible `host controls` value is a stable marker, not a claim that every destination works.
