# SumoCode Visual Harness

Headless reproducible screenshots of SumoCode running inside Pi, used for
Cathedral visual parity verification.

## V2 Cathedral Visual Harness

- PRD: https://github.com/dhruvkelawala/sumocode/issues/78
- Technical spec: [`V2_HARNESS_SPEC.md`](./V2_HARNESS_SPEC.md)

V2 will compare Visual Bible targets against deterministic retained-TUI runtime and component captures. It is crop-first, review-only initially, and promotes approved runtime goldens explicitly before they become CI-blocking.

## How it works

[`vhs`](https://github.com/charmbracelet/vhs) renders scripted terminal sessions
to PNG/GIF. Each `.tape` file under `docs/visual/` defines one scenario:

- launches a fresh Pi process
- types/sleeps to drive Pi into the state we want to verify
- writes a PNG into `docs/visual/out/`

Because `vhs` is headless, output is identical regardless of whether the
developer terminal is cmux, Ghostty, iTerm, or kitty. cmux uses `libghostty`
under the hood so glyph fallback and 24-bit color match what `vhs` produces.

## Run

```bash
pnpm visual
```

Outputs PNGs into `docs/visual/out/`. The directory is git-ignored.

## Adding a scenario

1. Copy an existing tape next to it as `<scenario>.tape`.
2. Adjust the `Type "..."` / `Sleep` lines to drive Pi into that state.
3. `pnpm visual` to render.
4. Open the resulting PNG (or read it from a coding agent) to verify.

## Pi runtime

The harness assumes:

- `pi` is on `PATH`
- the SumoCode extension is installed (`pi install ...`)
- Anthropic / OpenAI auth is already cached in `~/.pi/agent/auth.json`,
  because `vhs` runs non-interactively and cannot complete OAuth flows

If you want a "fresh boot, no auth" capture, set `PI_NO_AUTH=1` in the tape
before launching. (TODO: wire up.)
