# Plans — Pi RPC migration

Executor-grade, self-contained plans for migrating SumoCode off the Pi `dist/main.js`
InteractiveMode patch onto Pi's native `--mode rpc`, with SumoCode as the host process
rendering everything via SumoTUI.

**Written against commit:** `ae03bc0` (SumoCode 0.4.0, Pi 0.79.1 pinned)
**Design rationale:** [`docs/research/pi-rpc-migration.md`](../docs/research/pi-rpc-migration.md)
**Prior decision being superseded:** [`docs/SUMO_TUI_PI_PATCH_STRATEGY.md`](../docs/SUMO_TUI_PI_PATCH_STRATEGY.md)

These plans are advisory. They do **not** authorize starting the migration — Phase 0 is a
go/no-go gate; everything after it is contingent on that gate passing.

## Execution order & dependencies

```
001 (Phase 0: spike + go/no-go)   ← MUST pass before any of 002–006
        │
        ▼
002 (Phase 1: host shell + transcript + chrome)
        │
        ▼
003 (Phase 2: extension_ui responder + selectors + controls)
        │
        ├──────────────┐
        ▼              ▼
004 (Phase 3:      005 (Phase 4: overlays + approval rewrite)   ← SECURITY-CRITICAL
     editor)           depends on 003 (extension_ui responder)
        │              │
        └──────┬───────┘
               ▼
006 (Phase 5: cutover — flag flip, smoke matrix, rollback)   ← depends on ALL of 002–005
```

004 and 005 can proceed in parallel once 003 lands. 006 must not start until 002–005 are all
DONE and the security test in 005 is green.

## Status

| # | Plan | Phase | Size | Depends on | Status | Issue |
|---|---|---|---|---|---|---|
| 001 | [RPC fidelity spike + go/no-go](001-rpc-fidelity-spike.md) | 0 | M | — | TODO | [#289](https://github.com/dhruvkelawala/sumocode/issues/289) |
| 002 | [Host shell + transcript + chrome on RPC](002-host-shell-transcript-chrome.md) | 1 | M | 001 PASS | TODO | [#290](https://github.com/dhruvkelawala/sumocode/issues/290) |
| 003 | [extension_ui responder + selectors + controls](003-extension-ui-responder-selectors.md) | 2 | M | 002 | TODO | [#291](https://github.com/dhruvkelawala/sumocode/issues/291) |
| 004 | [Editor internalization](004-editor-internalization.md) | 3 | L | 003 | TODO | [#292](https://github.com/dhruvkelawala/sumocode/issues/292) |
| 005 | [Overlays + approval-gate rewrite](005-overlays-approval-rewrite.md) | 4 | L | 003 | TODO | [#293](https://github.com/dhruvkelawala/sumocode/issues/293) |
| 006 | [Cutover](006-cutover.md) | 5 | M | 002–005 | TODO | [#294](https://github.com/dhruvkelawala/sumocode/issues/294) |

## Verification gates (every plan)

```bash
pnpm exec tsc --noEmit && pnpm build   # always
pnpm test                              # unit
pnpm test:integration                  # PTY/real-Pi integration
pnpm visual:ci                         # V2 visual parity gate (UI same-or-better)
pnpm perf:startup                      # startup readiness baseline (Phase 0/1)
```

## Considered and rejected

- **Add a `custom` channel to Pi's RPC protocol.** Rejected: requires forking Pi, which is
  the exact thing this migration exists to escape. Use host-render + `extension_ui` value
  round-trip instead (see 005).
- **Revert to in-process public extension chrome (no patch, no RPC).** Rejected previously in
  `SUMO_TUI_PI_PATCH_STRATEGY.md`; loses retained chat-viewport control. The RPC inversion
  avoids that loss.
