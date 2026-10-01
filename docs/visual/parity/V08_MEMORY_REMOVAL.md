# v0.8 memory removal — frozen visual inventory

## Contract and tradeoffs

Dhruv's decision: “I don't want any Memory support right now.”

- Removed Remnic HTTP/token handling, turn-end extraction, memory editor/categorization, sidebar facts/retry workers, memory commands, and palette destination. No disabled compatibility shim or migration remains.
- Persona (`src/commands/persona.ts`, Pi's `APPEND_SYSTEM.md`) is independent and unchanged. No user data, external daemon, or Pi installation was read, migrated, uninstalled, or deleted by this change.
- The registry retains its existing CONTEXT styling, context/cost/MCP content, and process-memory metrics. With only one view, sub-tab state and both `Ctrl+1` / `Ctrl+2` bindings are removed. The inactive MEMORY row disappears, moving subsequent sidebar rows up one.
- Removed `learning` / `INSCRIBING` from runtime state and theme contracts. Compaction and branch summaries use `thinking` / `MEDITATING`; theme-check diff-added/success samples use the existing idle/success colour. Code syntax colours and generic heap/worker machinery remain independent of memory support.
- No dependency was specific to Remnic (it used Node fetch/fs); dependency versions and lockfile stay unchanged. No release version bump. Historical plans/research and design decisions remain history; current-facing design documents carry retirement notices rather than rewritten history.

## Retired targets

Fourteen memory/learning-only HTML pages were removed, together with `scripts/gen-bible-element-7.mjs` and `fixture-memory-scriptorium-overlay`. The surviving scenario manifest has 40 entries.

```text
docs/ui/bible/01-sidebar-memory.html
docs/ui/bible/01-sidebar-memory-empty.html
docs/ui/bible/01-sidebar-memory-daemon-down.html
docs/ui/bible/01-sidebar-v2-editorial-memory.html
docs/ui/bible/01-sidebar-v2-editorial-memory-empty.html
docs/ui/bible/01-sidebar-v2-editorial-memory-down.html
docs/ui/bible/01-sidebar-v3-marginalia-memory.html
docs/ui/bible/01-sidebar-v3-marginalia-memory-empty.html
docs/ui/bible/01-sidebar-v3-marginalia-memory-down.html
docs/ui/bible/02-topbar-learning.html
docs/ui/bible/05-footer-learning.html
docs/ui/bible/07-memory-editor.html
docs/ui/bible/07-memory-editor-search.html
docs/ui/bible/scene-memory-scriptorium-overlay.html
```

No memory-only PNG renders or approved-runtime goldens existed in this checkout. The old marketing asset `docs/marketing/03-memory-scriptorium.png` remains solely as a labelled historical v0.3 announce artifact, not a current feature claim.

## Bible pages awaiting review

No surviving HTML page, CSS baseline, PNG, or golden was regenerated or promoted. The following 39 retained pages still depict memory navigation/content or the old palette. Their matching `docs/ui/bible/renders/<basename>.png` outputs need refreshing after a sandboxed capture/review. Rejected sidebar/palette alternatives may instead remain explicitly labelled historical references; they must not be presented as current parity targets.

Sidebar: remove MEMORY navigation; subsequent rows move up one. Dense backup uses the abbreviated `mem` label.

```text
docs/ui/bible/01-sidebar-context.html
docs/ui/bible/01-sidebar-context-over-budget.html
docs/ui/bible/01-sidebar-with-metrics.html
docs/ui/bible/01-sidebar-v1-dense.html
docs/ui/bible/01-sidebar-v2-editorial.html
docs/ui/bible/01-sidebar-v2-editorial-context.html
docs/ui/bible/01-sidebar-v2-editorial-context-over.html
docs/ui/bible/01-sidebar-v2-editorial-metrics.html
docs/ui/bible/01-sidebar-v3-marginalia.html
docs/ui/bible/01-sidebar-v3-marginalia-context.html
docs/ui/bible/01-sidebar-v3-marginalia-context-over.html
docs/ui/bible/01-sidebar-v3-marginalia-metrics.html
```

Palette: remove MEMORY and its fact count; the runtime panel shrinks from 17 to 16 rows. The search example's former `mem` destination changes to THINKING.

```text
docs/ui/bible/08-palette-default.html
docs/ui/bible/08-palette-search.html
docs/ui/bible/08-palette-settings.html
docs/ui/bible/08-palette-v1-raycast.html
docs/ui/bible/08-palette-v2-scriptorium.html
docs/ui/bible/08-palette-v3-terminal.html
```

Landscape compositions: their embedded sidebar changes. Palette overlay also loses a row and needs renewed overlay-height/centering review. Some are hand-authored; updating generators alone is insufficient.

```text
docs/ui/bible/scene-active.html
docs/ui/bible/scene-active-runtime.html
docs/ui/bible/scene-active-amber-crt.html
docs/ui/bible/scene-active-obsidian.html
docs/ui/bible/scene-active-obsidian-tall.html
docs/ui/bible/scene-active-brutalist-tall.html
docs/ui/bible/scene-active-bash-live-view.html
docs/ui/bible/scene-active-code-block.html
docs/ui/bible/scene-active-mermaid.html
docs/ui/bible/scene-active-scroll-scribe.html
docs/ui/bible/scene-active-skill-pill.html
docs/ui/bible/scene-active-tool-ledger.html
docs/ui/bible/scene-activity-cards.html
docs/ui/bible/scene-approval-overlay.html
docs/ui/bible/scene-divine-query-overlay.html
docs/ui/bible/scene-palette-overlay.html
docs/ui/bible/theme-herdr-active.html
docs/ui/bible/theme-ultraviolet-core-active.html
docs/ui/bible/theme-ultraviolet-core-runcat-active.html
docs/ui/bible/theme-ultraviolet-core-code-block.html
docs/ui/bible/theme-ultraviolet-core-tool-ledger.html
```

The frozen `_assets/tokens*.css` files and `scripts/visual-v2/styled-cell-grid.mjs` retain historical learning colour decoding so old Bible pages can still be reviewed accurately. This is design compatibility, not a runtime state or Remnic integration.

## Runtime goldens and affected captures

Exactly three approved runtime crop files exist. **None needs updating for this removal**: ready footer, static top bar, and input frame are unchanged.

```text
docs/visual/parity/approved-runtime/footer-ready-component/footer.png
docs/visual/parity/approved-runtime/top-bar-default-component/top-bar.png
docs/visual/parity/approved-runtime/input-typed-component/input-frame.png
```

There is no approved sidebar or palette golden to promote. Re-capture the following scenario `full` images and any declared `sidebar` crops; only `fixture-command-palette-overlay` additionally changes its `overlay-center` crop. Divine Query's center crop is unchanged; its full-screen background changes.

```text
sidebar-editorial-component
active-landscape-runtime
herdr-theme-active-runtime
ultraviolet-core-active-runtime
ultraviolet-core-runcat-active-runtime
fixture-completed-landscape
fixture-worktree-result-disposition-landscape
fixture-subagent-recovery-states-landscape
fixture-subagent-budget-warnings-landscape
fixture-activity-cards-landscape
fixture-command-palette-overlay
fixture-tool-ledger-landscape
fixture-ultraviolet-core-tool-ledger
fixture-divine-query-overlay
fixture-scroll-scribe-landscape
fixture-skill-pill-landscape
fixture-code-block-landscape
fixture-mermaid-diagram-landscape
fixture-ultraviolet-core-code-block
fixture-track-b-transcript-landscape
fixture-native-queues-followup-landscape
fixture-direct-bash-running
fixture-direct-bash-succeeded
fixture-direct-bash-failed
fixture-direct-bash-cancelled
fixture-direct-bash-truncated
```

Portrait/no-sidebar and splash targets do not change. Compaction/branch-summary footer behaviour is covered by unit tests, not by a dedicated surviving visual scenario. Theme-check samples also change without a dedicated golden.

## Verification boundary

Node 24.15.0 and pnpm 10.29.2; frozen offline installation with scripts disabled. Static checks and unit tests only, with native/Herdr/worker environment overrides unset and hooks disabled. Follow-up checks use an isolated HOME and agent directory. The benchmark `src/sumo-tui/runtime/resume-flow.perf.test.ts` is excluded from the default unit run; pure performance-report/native-builder unit contracts remain part of `pnpm test` and do not launch the real app.

Integration, native, visual, and performance suites were deliberately not run. Sandbox verification and human visual approval remain outstanding; this change does not claim visual parity.

Check results:

- Frozen offline install, `pnpm exec tsc --noEmit`, `pnpm build`, and documentation checks: pass. All 40 scenario targets exist; changed JavaScript scripts pass `node --check`. Runtime grep finds no Remnic client/import, token/URL handling, port 7749, or learning indicator.
- Targeted UI/persona/command contracts: 454 tests pass across 20 files. Full unit run (four workers, performance benchmark excluded): 4,235 pass / 1 fail across 244 files (243 pass / 1 fail).
- The sole remaining failure predates this change: `scripts/build-native.test.mjs`, “uses the pinned Bun runtime,” expects 1.4.0 while this machine supplies 1.4.2. No Bun installation/pin change was made.
- Baseline unit run: 4,325 pass / 6 fail across 249 files. In addition to Bun, it timed out in worktree-disposition (ignored dependency trees), retained-reconstruction (journal cap), retained-supervisor (bounded JSON results), task-manager (execution/feed budget), and task-store (1,500 candidates cleanup hook). Those five timeouts did not recur in the bounded final run; no unrelated code was changed to fix them.
- Lint exits successfully with the same four pre-existing scratch-generator warnings. Report-only dead-code exits successfully with 9 unused files, 1 unused devDependency, 157 unused exports, 288 unused exported types, and 20 config hints (baseline: 9 / 1 / 163 / 294 / 20). Unrelated cleanup was intentionally left out.

The documentation checker requires live inventory counts, so `docs/ui/bible/README.md` is corrected to **95 HTML / 0 PNG**, including group counts. Before removal this checkout had 109 HTML / 0 PNG, while the README claimed 107 / 107 (with a pre-existing approval group count drift). PNGs are ignored build artifacts; counts describe this checkout, not new approved renders.

Next action: run the sandboxed integration/visual gates, review the changed sidebar and palette captures, and request Dhruv's approval before any golden promotion.
