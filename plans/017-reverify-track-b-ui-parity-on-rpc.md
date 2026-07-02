# Plan 017: Re-verify Plans 007-013 UI parity under the RPC-default runtime

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report - do not improvise. When done, update the status row for this plan
> in `plans/README.md` - unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 96a2a0a..HEAD -- src/sumo-tui/transcript src/sumo-tui/widgets/chat-message.ts src/sumo-tui/widgets/chat-message.test.ts src/sumo-tui/pi-compat/chat-viewport-controller.ts src/sumo-tui/pi-compat/chat-viewport-controller.test.ts docs/visual/parity/scenarios.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: 014, 015, 016
- **Category**: tests
- **Planned at**: commit `96a2a0a`, 2026-07-02

## Why this matters

Plans 007-013 fixed important UI parity gaps: skill pills, edit diffs,
compaction summaries, extension-message labels, Markdown rendering, dynamic
expand hints, and live tool execution. Those changes are included in the
accepted RPC feature branch, but the earlier review proved the shell parity
gate was too weak. This plan re-checks every Track B surface under the
RPC-default runtime and the stricter visual harness so we do not ship a
visually correct shell with degraded transcript behavior.

## Current state

The feature branch includes the Track B implementation via
`codex/rpc-precutover-stack-clean-exec` (`c256f6e`, `573248c`) and the cutover
commit `96a2a0a`.

`plans/README.md` records 007-013 as accepted in the source stack:

- 007 skill envelope pill
- 008 edit diff rendering
- 009 branch + compaction summary boxes
- 010 extension message labels
- 011 pi-tui Markdown rendering
- 012 dynamic key hints + expand-all
- 013 live tool execution for all tools

Relevant source areas:

- `src/sumo-tui/transcript/view-model.ts` maps Pi/RPC messages into
  `ChatBlock[]`.
- `src/sumo-tui/widgets/chat-message.ts` renders those blocks into framed
  transcript rows.
- `src/sumo-tui/transcript/tool-renderer.ts` renders tool rows and expand
  hints.
- `src/sumo-tui/pi-compat/chat-viewport-controller.ts` still owns some live
  event folding for the legacy/in-process path; the RPC path uses
  `src/sumo-tui/rpc/transcript-pump.ts` and `src/sumo-tui/rpc/runtime.ts`.

Visual scenarios already exist for several Track B surfaces:

- `fixture-skill-pill-landscape`
- `fixture-code-block-landscape`
- `fixture-tool-ledger-landscape`
- `fixture-scroll-scribe-landscape`
- `fixture-completed-landscape`
- `fixture-completed-portrait`

The stricter Plan 015 harness must be in place before this plan executes, so
these scenarios can be promoted from "nice review evidence" to a real RPC UI
parity gate.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Transcript unit tests | `pnpm vitest run src/sumo-tui/transcript/view-model.test.ts src/sumo-tui/transcript/tool-renderer.test.ts src/sumo-tui/transcript/code-renderer.test.ts src/sumo-tui/widgets/chat-message.test.ts` | all pass |
| Live event unit tests | `pnpm vitest run src/sumo-tui/pi-compat/chat-viewport-controller.test.ts src/sumo-tui/rpc/transcript-pump.test.ts src/sumo-tui/rpc/runtime.test.ts` | all pass |
| Visual fixture lane | `pnpm visual:review -- --lane fixture` | review pack produced; Track B scenarios pass required crops |
| Full visual | `pnpm visual:ci` | exit 0 |
| Typecheck/build | `pnpm exec tsc --noEmit && pnpm build` | exit 0 |
| Integration | `pnpm test:integration` | all pass |

## Scope

**In scope:**

- Tests and fixtures for Plans 007-013 surfaces
- `src/sumo-tui/transcript/*`
- `src/sumo-tui/widgets/chat-message.ts`
- `src/sumo-tui/widgets/chat-message.test.ts`
- `src/sumo-tui/rpc/transcript-pump.ts`
- `src/sumo-tui/rpc/runtime.ts`
- `docs/visual/parity/scenarios.json` only to mark Track B fixture/runtime
  evidence as required where stable

**Out of scope:**

- Removing the legacy seam. That is Plan 014.
- Restoring splash/sidebar/footer shell parity. That is Plan 016.
- Promoting or updating visual goldens.
- Rewriting the transcript model from scratch.

## Git workflow

- Branch: `codex/rpc-migration-no-seam`
- Commit message example: `test: verify rpc transcript parity surfaces`
- Do not push or open a PR unless the operator explicitly instructs it.

## Steps

### Step 1: Map every 007-013 feature to a test and visual scenario

Create a short checklist in the executor report mapping:

- 007 skill pill -> unit test and visual scenario
- 008 edit diff -> unit test and visual scenario
- 009 branch/compaction summary -> unit test and visual scenario
- 010 extension-message labels -> unit test and visual scenario
- 011 Markdown rendering -> unit test and visual scenario
- 012 expand hints -> unit test and visual scenario
- 013 live tool execution -> unit test, RPC/live event test, and visual scenario

If a feature has no visual fixture, add a deterministic fixture scenario rather
than relying on a broad runtime screenshot.

**Verify:**

```bash
rg "fixture-skill|fixture-code|fixture-tool|compaction|markdown|expand|extension" docs/visual/parity/scenarios.json src/sumo-tui
```

Expected: every Track B feature has an explicit test or scenario anchor.

### Step 2: Re-run and tighten unit coverage

Run the transcript and live-event tests listed in "Commands you will need".
Add missing assertions where a Track B feature only has indirect coverage.

Important assertions:

- skill envelopes never dump raw `<skill ...>` bodies in normal collapsed mode;
- edit diffs show changed file/path and diff summary/content as designed;
- compaction/branch summaries render as distinct framed blocks;
- extension/custom messages have labels instead of empty boxes;
- Markdown no longer renders literal `**`, `#`, or list markers when a styled
  form is expected;
- expand/collapse hints use the bound expand key;
- non-task tools can render a running state and merge final output by
  `toolCallId`.

**Verify:**

```bash
pnpm vitest run src/sumo-tui/transcript/view-model.test.ts src/sumo-tui/transcript/tool-renderer.test.ts src/sumo-tui/transcript/code-renderer.test.ts src/sumo-tui/widgets/chat-message.test.ts src/sumo-tui/pi-compat/chat-viewport-controller.test.ts src/sumo-tui/rpc/transcript-pump.test.ts src/sumo-tui/rpc/runtime.test.ts
```

Expected: all pass.

### Step 3: Make fixture visual checks enforce Track B parity

In `docs/visual/parity/scenarios.json`, ensure the Track B scenarios have
required crops for the feature area:

- skill pill row/body,
- edit diff/code block area,
- tool ledger/live tool row,
- scroll/scribe or compaction summary block,
- Markdown-rendered assistant content.

Prefer narrow crops around the changed feature instead of requiring the entire
frame if shell parity noise would obscure the signal.

**Verify:**

```bash
pnpm visual:review -- --lane fixture
```

Expected: Track B fixture scenarios pass required crops and produce review
evidence.

### Step 4: Re-run RPC runtime visual CI

After Plan 016 shell parity is in place, run:

```bash
pnpm visual:ci
```

Expected: full visual CI exits 0 with Track B feature scenarios included in
the required gate.

### Step 5: Produce final reviewer evidence

Record in the executor report:

- exact unit/integration/visual commands run,
- review pack path,
- any residual accepted caveat,
- whether any visual golden promotion was intentionally skipped.

Do not mark this plan DONE if any feature only passed because the required
crop was skipped or downgraded to review-only.

## Test plan

- Unit tests for every Track B feature.
- Fixture visual scenarios for every user-visible Track B feature.
- Full RPC visual CI after shell parity.
- Integration to ensure live RPC event pump still works.

## Done criteria

ALL must hold:

- [ ] Every 007-013 feature maps to at least one unit test and one visual
  fixture/runtime scenario.
- [ ] Track B feature crops are required where stable.
- [ ] `pnpm vitest run ...` focused Track B suite passes.
- [ ] `pnpm visual:review -- --lane fixture` passes required Track B crops.
- [ ] `pnpm visual:ci` exits 0 after Plan 016.
- [ ] Review evidence path is reported.
- [ ] No visual goldens are promoted without Dhruv approval.

## STOP conditions

Stop and report if:

- A 007-013 source change is missing from the feature branch.
- A Track B feature cannot be represented deterministically in the fixture lane.
- Passing the visual gate requires changing goldens.
- Live RPC event rendering double-renders or drops final tool output.

## Maintenance notes

This plan is the "do not regress the transcript while fixing the shell" pass.
The reviewer should compare the fixture review pack, not only the active
runtime screenshot. Small shell differences can hide transcript regressions if
the crop is too broad.
