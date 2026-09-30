# SumoCode verification map

Maintained recipes for the retained RPC terminal UI. Source seed: `b8621925`. Read [the skill](../SKILL.md) for launch, instance doctor, evidence, and cleanup. Use `/maintain-verification-skill` when source or harness changes.

## Baseline preconditions

- Working local dependencies and clean integration preflight, Node >=23.11.
- Each recipe gets its own source-mode 100×30 PTY, scratch cwd, and isolated Pi agent directory. No credentials or user profile.
- Wait for `stable_chrome_ready`, active alternate screen, and the visible `DIVINE INVOCATION` screen before input.
- The executable recipe lives in `../scripts/drive.test.ts`; run it through `../scripts/vitest.config.mjs` from the repository root.

## Driving conventions

- Ctrl+/ uses `\u001f`; slash-command Enter uses `\x1b[13u`.
- Use replayed terminal text, not raw ANSI substrings, for visible-state assertions.
- Fresh PTY per entry point; no sharing, polling other agents, or driving the user's session.
- Run `pnpm vitest run --config .agents/skills/verify-sumocode/scripts/vitest.config.mjs -t <entry-id>`; the concrete filter is in each feature file. Require a passed test, not all-skipped output.

## Proof and skip reporting

- Record feature/entry ID, revision, action, before/after state, raw stream, diagnostics, and cleanup audit. Evidence lives in `.evidence/verify-sumocode-<entry>-<unique>/` and survives teardown.
- Opening a selector does not prove applying/persisting its values. Text proves behaviour, not colours or visual parity. Use EVIDENCE.md's visual lanes for pixel review.
- The six helper entries have been run live. Additional destinations, cancellation, and mutations below are mapped but **unproven**; no comprehensive product coverage is claimed.
- An unreachable path needs its attempted route and missing prerequisite. A different working entry point is not a substitute.

## Features

- [Command palette](command-palette.md): Ctrl+/ and `/sumo:palette`, destination overview.
- [Hotkeys overlay](hotkeys.md): `/hotkeys`, interrupt and navigation guidance.
- [Theme selector](themes.md): `/theme` and `/sumo:theme`, choice and persistence boundary.
- [RPC settings](settings.md): `/settings`, compaction/retry/diagram choices.

Source entry points for maintenance: `src/sumo-tui/rpc/host-actions.ts` owns these commands/destinations; `src/sumo-tui/rpc/runtime.ts` owns keyboard routing; `src/sumo-tui/rpc/inline-selector.ts` owns rendered uppercase selector titles. This index is a small verification slice, not an inventory of every SumoCode feature.
