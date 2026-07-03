# V2 Harness Baseline Review

Issue: #81
Parent: #80
Harness foundation: PR #79 / `a1a81d4 feat(visual): add v2 parity harness`

## Baseline decision

The V2 harness is approved as the review loop for Cathedral V2 UI work. It is **not** a claim of full Visual Bible parity and it does not yet cover every Bible element.

Use it to review component-by-component implementation slices. Promote crops only after explicit developer visual approval.

## Current scenario coverage

| Scenario | Lane | Purpose | Baseline status |
|---|---|---|---|
| `input-typed-component` | component | Active typed input frame target vs current component capture | Review target accepted |
| `footer-ready-component` | component | Footer/status row target vs current component capture | Review target accepted |
| `sidebar-editorial-component` | component | Editorial REGISTRY sidebar target vs current component capture | Review target accepted |
| `splash-runtime` | runtime | Real runtime splash capture | Review-only; target accepted |
| `active-landscape-runtime` | runtime | Real 160×45 post-submit active-working capture against `scene-active-runtime` | Active-working target contract accepted |
| `active-portrait-runtime` | runtime | Real portrait post-submit active-working capture against `scene-active-runtime-portrait` | Active-working target contract accepted |

## Review decisions captured during #79/#81

- The review pack must be human-readable before merge/use.
- Cards are grouped into component scenarios first and runtime scenarios second.
- Human review should compare **Bible target** vs **Current capture**. Pixel diffs are diagnostic/gating artifacts, not the primary review surface.
- Sidebar masthead is a single-row `REGISTRY`; sidebar version metadata was removed.
- Splash hint row is constrained to the invocation frame width.
- Splash left hint is `╰─ AWAITING PROMPT`.
- `TAB · AGENTS` is deferred until agent switching is functional; V2 hints show `CTRL+/ · COMMANDS` only.
- Full-screen scene targets reserve one blank breathing row above the top bar and one below the footer.
- Active runtime scenarios wait for the splash editor, submit the prompt with manifest logical Enter, and capture deterministic active-working state through the visual-only faux provider extension.
- Runtime active-working targets are live-submitted prompt scenes. The richer completed/tool `scene-active` targets remain fixture/review canon, and runtime lanes must not inject completed assistant/tool transcripts.

## Local verification

Fresh baseline commands run locally:

```bash
pnpm render:bible
pnpm visual:ci
```

Result:

```txt
Visual Bible: 95 mockups rendered
V2 visual CI: 6 scenarios rendered
- input-typed-component: review
- footer-ready-component: review
- sidebar-editorial-component: review
- splash-runtime: review
- active-landscape-runtime: review
- active-portrait-runtime: passed/review-compatible
```

Review pack:

```txt
docs/visual/out/parity/index.html
```

Tailscale/local review route used during review:

```txt
/bible-verify/
```

## Promotion smoke test

Promotion was smoke-tested and reverted locally:

```bash
pnpm visual:promote -- --scenario input-typed-component --crop input-frame --status approved
```

Observed behavior:

- Runtime crop copied to `docs/visual/parity/approved-runtime/input-typed-component/input-frame.png`.
- `scenarios.json` crop status changed to `approved`.
- Both changes were reverted after the smoke test.
- No runtime golden was committed.
- No crop was marked `required`.

## Candidate first crops

The first candidates for actual visual approval/promotion after implementation are:

1. `input-typed-component/input-frame` — tracked by #82.
2. `footer-ready-component/footer` — tracked by #83.
3. `sidebar-editorial-component/full` — tracked by #85.
4. `active-landscape-runtime/top-bar` and `active-landscape-runtime/footer` after #84/#83.

Do **not** promote runtime or component crops to `required` until the corresponding UI implementation PR has developer-approved visual evidence.

## Known non-goals for this baseline

- 100% Visual Bible scenario coverage.
- Modal/overlay/tool-ledger fixture coverage.
- Completed model-response runtime captures.
- Strict full-screen pixel-perfect gating.

Those belong in follow-up slices, especially #90 and its future children.
