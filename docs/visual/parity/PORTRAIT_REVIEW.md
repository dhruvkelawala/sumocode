# Active Portrait Runtime Review

Issue: #87
Parent: #80
Policy: `docs/SUMO_TUI_PORTRAIT_SIDEBAR_POLICY.md`
Scenario: `active-portrait-runtime`

## Decision captured

The canonical V1 portrait scene remains a `60 × 100` no-sidebar runtime capture. It composes the approved V2 primitives full-width and follows the Bible vertical rhythm:

- blank breathing row above the compact top chrome
- compact top chrome
- blank breathing row before chat
- boxed chat message frames
- full-width active input frame
- portrait hint row with sidebar-hidden context
- footer/status row

Per the accepted portrait policy, this PR does **not** add a sidebar crop, bottom registry band, or portrait overlay. Sidebar richness stays deferred.

## Review evidence

The scenario now emits crop-level evidence in addition to the full-screen comparison:

- `full`
- `top-bar`
- `chat-area`
- `input-frame`
- `hint-row`
- `footer`

All portrait crops remain `review` status. No portrait runtime golden is promoted and no portrait crop is marked `required` in #87.

Generate the local review pack with:

```bash
pnpm visual:review -- --scenario active-portrait-runtime
```

Review locally at:

```txt
http://127.0.0.1:7781/bible-verify/ → active-portrait-runtime
```

## Known deferrals

- Completed assistant/tool transcript content remains fixture-backed follow-up work (#90).
- Portrait registry richness remains deferred by the V1 Option A policy.
- The Pi working/status loader row is suppressed at compact portrait widths so the bottom stack aligns with the scene target.
- Strict portrait pixel gating requires later explicit visual approval plus a committed runtime golden.
