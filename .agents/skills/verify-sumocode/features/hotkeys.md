# Hotkeys overlay

The hotkeys overlay explains retained-host shortcuts for global controls, interrupts, transcript scrolling, and the selector/editor. A key dismisses it without sending an agent prompt.

## Sub-features

- `hotkeys-slash`: `/hotkeys` shows the host shortcut guide.
- `hotkeys-dismiss`: a key closes the guide. Mapped, unproven by the opening recipe.
- `hotkeys-interrupt`: the guide distinguishes dismissal, draft clearing, response abort, and double-Ctrl-C quit. Described from source, not individually driven here.

## How to get to it (user POV)

- Type `/hotkeys` in the retained editor and press Enter.
- Read the overlay, then press a key to close it.

## Driving it with SumoCode PTY harness

Preconditions: [the baseline](README.md#baseline-preconditions), idle input, healthy owned PTY.

- **Open.** Run `pnpm vitest run --config .agents/skills/verify-sumocode/scripts/vitest.config.mjs -t hotkeys-slash`. It sends `/hotkeys\x1b[13u` and waits for `Open the command palette` in the replayed screen.
- **Proof.** Inspect the resulting `after.txt` for `SUMOCODE RPC HOST HOTKEYS` and the shortcut rows. Require 1 passed and 0 survivors; the action and raw stream are captured beside the snapshot.
- **Coverage gap.** Dismissal needs an additional input and baseline-screen assertion. Testing the listed shortcuts is separate: showing help does not prove scrolling, cancellation, or quitting.

## Gotchas

- Height limits visible guide rows. The helper uses 100×30; a narrower/shorter screen may truncate rows.
- Escape alone never quits the retained host. Ctrl-C first clears nonempty input, and quits only after its empty-editor confirmation sequence.
- Do not use a help screenshot as evidence that every advertised keybinding works.
