# RPC settings

RPC settings offers auto-compaction, auto-retry, and Mermaid diagram rendering choices without leaving the retained editor. Selecting a setting applies it; Escape cancels.

## Sub-features

- `settings-slash`: `/settings` opens the choices.
- `settings-palette`: SETTINGS in the palette opens the same selector. Mapped, unproven.
- `settings-apply`: compaction/retry toggles and Mermaid off/final/streaming choices take effect. Mapped, unproven.
- `settings-cancel`: Escape returns to the editor without choosing. Mapped, unproven.

## How to get to it (user POV)

- Type `/settings` in the retained editor and press Enter.
- Press Ctrl+/, choose SETTINGS, and press Enter.

## Driving it with SumoCode PTY harness

Preconditions: [the baseline](README.md#baseline-preconditions), idle input, no tree navigation or branch summary in progress.

- **Open.** Run `pnpm vitest run --config .agents/skills/verify-sumocode/scripts/vitest.config.mjs -t settings-slash`. It submits `/settings\x1b[13u` and waits for `RPC SETTINGS`.
- **Proof.** Inspect `after.txt` for Enable/Disable auto compaction, Enable/Disable auto retry, and Mermaid modes with the current marker. Require 1 passed, nonempty action/before/after/raw artifacts, and 0 survivors.
- **Coverage gap.** Palette entry, cancellation, and applying a value need additional user input and observable assertions in the helper. Do not treat opening the selector as proof of changed RPC state or persistence. Proving actual retry/compaction requires a safe local provider boundary fixture and its observable result; it is outside this offline opening pilot.

## Gotchas

- `RPC SETTINGS` is uppercase on screen, unlike its handler label.
- Busy tree navigation can refuse the selector with `branch summary in progress`; reset before retrying.
- Offline startup permits opening these controls without auth. It does not make a real compaction/LLM request safe or free.
