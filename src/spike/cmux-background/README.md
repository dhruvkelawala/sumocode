# Spike: cmux-visible background tasks

Research spike for SumoCode orchestrator-visible background work via cmux splits.

**Production implementation:** `src/background-tasks/` (`bg_task` tool, visible spawn, cmux split integration).

## Contents

| File | Purpose |
|---|---|
| [RESEARCH.md](./RESEARCH.md) | Deep comparison of pi-subagents, pi-cmux, opencode-cmux, pi-background-tasks |
| [INTEGRATION-PLAN.md](./INTEGRATION-PLAN.md) | Rollout plan (Phase 0–2 implemented in `src/background-tasks/`) |
| [cmux-adapter.ts](./cmux-adapter.ts) | Portable cmux CLI adapter (PoC — mirrored in `src/commands/cmux-split.ts`) |
| [visible-spawn.ts](./visible-spawn.ts) | Log-tee wrapper (promoted to `src/background-tasks/visible-spawn.ts`) |
| [visual-explainer.html](./visual-explainer.html) | Architecture diagram + decision matrix |

## Status

**Spike + production module shipped.** Use `bg_task` from SumoCode; spike files remain for research evidence only.

## Quick validation

```bash
pnpm vitest run src/spike/cmux-background
pnpm exec tsc --noEmit
```

Open the visual explainer:

```bash
open src/spike/cmux-background/visual-explainer.html
```
