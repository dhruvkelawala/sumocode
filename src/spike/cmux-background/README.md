# Spike: cmux-visible background tasks

Research spike for SumoCode orchestrator-visible background work via cmux splits, built on a fork of `@vanillagreen/pi-background-tasks`.

## Contents

| File | Purpose |
|---|---|
| [RESEARCH.md](./RESEARCH.md) | Deep comparison of pi-subagents, pi-cmux, opencode-cmux, pi-background-tasks |
| [INTEGRATION-PLAN.md](./INTEGRATION-PLAN.md) | Proposed fork + SumoCode wiring plan |
| [cmux-adapter.ts](./cmux-adapter.ts) | Portable cmux CLI adapter (PoC) |
| [visible-spawn.ts](./visible-spawn.ts) | Log-tee wrapper command builder for visible tasks |
| [visual-explainer.html](./visual-explainer.html) | Architecture diagram + decision matrix |

## Status

**Spike only** — nothing in this directory is imported by SumoCode production code. Promote by moving the adapter into a real package and forking `pi-background-tasks`.

## Quick validation

```bash
pnpm vitest run src/spike/cmux-background
pnpm exec tsc --noEmit
```

Open the visual explainer:

```bash
open src/spike/cmux-background/visual-explainer.html
```
