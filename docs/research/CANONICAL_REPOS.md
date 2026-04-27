# Canonical reference repos for SumoCode research

## TUI / Agent libraries

- **OpenCode** (the real one): `https://github.com/anomalyco/opencode`
  - NOT `sst/opencode` (different/fork)
  - NOT `anomaly/opencode` (404)
  - This is the AI coding agent we want to learn from for in-app chat scrollback,
    altscreen ownership, mouse handling, modal layers, sidebar reflow.

- **OpenTUI**: `https://github.com/sst/opentui`
  - SST's React-style TUI framework with Yoga flex layout.
  - Bun + FFI + Zig native bindings.

- **opentui-island**: `https://github.com/benvinegar/opentui-island`
  - Dhruv's fork: `https://github.com/dhruvkelawala/opentui-island`
  - Embeds OpenTUI islands inside pi-tui or Ink via a Bun sidecar (JSON-lines IPC).
  - Useful for the Surface bridge pattern even if we don't adopt the sidecar.

- **Pi-mono**: `https://github.com/badlogic/pi-mono`
  - The canonical Pi monorepo. NOT a single package.
  - Workspaces: pi-ai, pi-agent-core, pi-coding-agent, pi-tui, pi-web-ui, pi-mom, pi-pods.
  - Pi-mono blocks AI-filed PRs by policy. Don't try to file upstream PRs from
    SumoCode automation. Dhruv files manually if needed.

## Research artifacts in SumoCode repo

- `docs/research/sumo-tui-spike/01-opencode.md` — OpenCode TUI deep dive (anomalyco)
- `docs/research/sumo-tui-spike/02-opentui.md` — OpenTUI internals
- `docs/research/sumo-tui-spike/03-opentui-island.md` — Surface bridge + sidecar
- `docs/research/sumo-tui-spike/04-pi-tui.md` — pi-tui internals + integration boundary
- `docs/research/sumo-tui-spike/SUMO_TUI_RESEARCH_AND_SPEC.md` — Synthesis + roadmap
