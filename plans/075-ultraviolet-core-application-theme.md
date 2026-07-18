# Plan 075 — Ultraviolet Core Application Theme

- **Status:** DONE — implemented on `advisor/075-ultraviolet-core-application-theme`; awaiting PR/release flow
- **Created:** 2026-07-18
- **Planned at:** `0477358` on `origin/main`
- **Issue:** https://github.com/dhruvkelawala/sumocode/issues/319
- **Target branch:** `advisor/075-ultraviolet-core-application-theme`
- **Implementation commits:** `115c6dd`, `16549f5`, `dcf75e0`, `f7cf7b7`, `989b2f5` plus docs closeout

## Goal

Promote Ultraviolet Core into SumoCode's fifth first-party theme and make dense retained-renderer application surfaces theme-owned without adding renderer theme-name branches.

Ultraviolet Core is intentionally a violet-black command layer:

- violet owns focus, routing, active frame, cursor and keyword structure;
- pale lavender owns ordinary body/idle text;
- ice owns secondary syntax and learning signals;
- amber owns tool execution and tool-ledger emphasis;
- pink owns approval, failure and interruption;
- Cathedral remains default and first in registry order.

## Scope shipped

- Added the generic optional `ThemeApplicationRoles` contract and `activeThemeApplicationRoles()` resolver.
- Kept existing themes legacy-compatible through centralized fallback roles, including the historic Cathedral code-comment fallback.
- Added `ultraviolet-core` as the fifth selectable, persisted first-party theme after Herdr.
- Extended startup, command, cursor, lifecycle and RPC runtime coverage for Ultraviolet OSC 11/12 behavior.
- Routed tool-ledger compact/expanded output through semantic tool roles while preserving status and diff semantics.
- Routed code-block surface, border, gutter and existing syntax token categories through semantic code roles.
- Added deterministic Ultraviolet Bible targets and a design contract under `docs/ui/stitch/ultraviolet-core/`.
- Added themed fixture capture support with `finally` reset protection and visual contract coverage.
- Added review-only visual scenarios for active runtime, tool ledger and code block output.
- Updated present-tense product truth for five themes.

## Non-goals preserved

- No theme-name conditionals in production renderers.
- No syntax parser rewrite or new syntax token taxonomy.
- No layout, sidebar, transcript model, approval-flow or terminal-host changes.
- No personal Ghostty/Herdr config reads.
- No approved runtime golden promotion.

## Evidence

Focused and staged evidence was produced throughout the branch:

- role/theme/command/render/lifecycle/RPC Vitest slices;
- `pnpm typecheck` after each implementation chunk;
- deterministic double-run `pnpm render:bible` hash comparison for new Ultraviolet HTML targets;
- review-only visual captures for:
  - `fixture-ultraviolet-core-tool-ledger`;
  - `fixture-ultraviolet-core-code-block`;
  - `fixture-tool-ledger-landscape`;
  - `ultraviolet-core-active-runtime`.

Final closeout verification is recorded in the assistant handoff/PR body rather than promoted into runtime goldens.

## Maintenance notes

- Future first-party themes can rely on the fallback application roles or provide a complete `applicationRoles` object. Partial nested overrides are intentionally unsupported.
- Add more application role families only after a concrete surface proves generic theme tokens insufficient.
- The centralized legacy `#6F5D46` code-comment fallback is intentional compatibility debt for existing themes.
- Tool-ledger structure, semantic Bible classes and themed fixture scenarios should move together if the ledger renderer changes.
