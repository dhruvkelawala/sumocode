# Active Landscape Runtime Review

Issue: #86  
Parent: #80  
Scenario: `active-landscape-runtime`  
Runtime contract: `./bin/sumocode.sh --offline --no-extensions --no-session -e ./scripts/visual-v2/runtime-faux-provider.mjs --model sumocode-visual/active-working`

## Decision

The active landscape runtime scene is now locked as a **review-only composed scene** for the current hybrid Pi/SumoTUI runtime.

It exercises the real runtime path and captures the approved primitive regions together:

- top bar
- 30-column sidebar
- chat area
- active input frame
- hint row
- footer

This is not a promotion to strict scene parity. No active-landscape crop is marked `required` in this slice.

## Current scene semantics

`active-landscape-runtime` waits for the real splash editor, types the deterministic prompt, submits it with the manifest logical `Enter` key, and captures the active-working state. The active stream comes from the committed visual-only faux provider extension so captures do not depend on user API keys or private Pi config.

This remains intentionally different from completed-response fixture scenes because runtime-labelled scenarios do not inject completed assistant/tool transcripts.

The current runtime scene therefore validates composition and layout under real startup/input/submit behavior, while future slices handle richer deterministic content:

- #89 — V2 chat message frame parity
- #90 — fixture-backed completed response, overlays, tools, skill pill, code block, and scroll/scribe states

## Required review crops

The scenario manifest must keep these crops present:

```txt
full
top-bar
sidebar
chat-area
input-frame
hint-row
footer
```

These crops are review evidence only unless explicitly promoted after human visual approval.

## Latest local review

Command:

```bash
pnpm visual:review -- --scenario active-landscape-runtime
```

Review pack:

```txt
docs/visual/out/parity/index.html
```

Runtime artifact:

```txt
docs/visual/out/parity/active-landscape-runtime/runtime-full.png
```

Observed result from the #86 review run:

```txt
active-landscape-runtime: review
full: review-diff
chat-area: passed/review-compatible
top-bar/sidebar/input-frame/hint-row/footer: review evidence present
```

## Promotion policy

Do not promote active-landscape full-scene or crop goldens to `required` in #86.

Promotion can happen later when the relevant slice has explicit human visual approval:

- top-bar/footer/input/sidebar crops may reuse their component approvals when the scene composition matches them closely enough.
- chat-area should wait for #89.
- completed-response/tool/overlay scene crops should wait for #90.
