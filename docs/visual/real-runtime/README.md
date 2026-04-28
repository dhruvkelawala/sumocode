# Real-runtime VHS matrix · Tier 1

These tapes ALL drive the actual `./bin/sumocode.sh` (via `pi -e ./src/extension.ts`) — **no demo extensions**. This is the canonical pre-merge UX check, mandated by `docs/research/VERIFICATION_HARNESS_SPEC.md`.

## Run

```bash
pnpm test:visual:real-runtime
```

Outputs land in `docs/visual/out/real-runtime/*.png`. Eyeball them. T2 (golden-image diff) automates this.

## Tapes

| # | Tape | Validates |
|---|---|---|
| 01 | `01-splash.tape` | Splash visible, theme bg painted, cursor visible |
| 02 | `02-input-typed.tape` | Long input typed, no overflow into sidebar |
| 03 | `03-narrow-60col.tape` | 60×24 — sidebar overlay mode (< 120 col threshold) |
| 04 | `04-portrait-40x100.tape` | Mac mini portrait — splash centering at narrow height |
| 05 | `05-landscape-160x40.tape` | MacBook landscape — sidebar dock mode (≥ 120 col) |
| 06 | `06-clean-exit.tape` | Ctrl+C → no escape leakage, altscreen torn down |

## Deferred to Tier 3 (need scenario DSL with input scripting)

The following scenarios require scripted assistant messages or programmatic resize, which VHS doesn't support natively. They live in `test/scenarios/` once T3 lands:

- `07-five-messages-ghost-shell` — sends 5 messages, verifies no ghost UI shells in scrollback (issue #67)
- `08-code-block-render` — assistant message with fenced code, no layout break
- `09-mid-stream-resize` — resize during streaming response
- `10-tool-approval-modal` — tool call → approval modal → approve flow

## Pre-merge protocol

Any PR that touches:
- `src/sumo-tui/`
- `src/sidebar.ts` / `src/footer.ts` / `src/top-chrome.ts` / `src/cathedral/`
- `src/extension.ts`

MUST include rendered output of all 6 tapes in PR description. After T2 (golden diff) lands this becomes automatic via CI.
