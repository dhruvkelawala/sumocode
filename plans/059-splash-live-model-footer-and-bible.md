# Plan 059: RPC splash footer shows the live model (not "AWAITING PROMPT"); update the bible

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. SKIP updating
> `plans/README.md` — your reviewer maintains the index.
>
> **VISUAL / GOLDEN-GATED**: This changes a captured surface. Per `AGENTS.md`,
> you PRODUCE render + review evidence and STOP — you NEVER run
> `pnpm visual:promote`. A `pnpm visual:ci` failure on the splash crop after
> your change is EXPECTED (the golden is stale until a human promotes it); it
> is not an executor failure — report it as expected.
>
> **Drift check (run first)**: `git diff --stat 4f289fb..HEAD -- src/sumo-tui/rpc/shell-adapter.ts src/cathedral/input-frame.ts src/cathedral/input-hints.ts docs/ui/bible/03-splash.html docs/ui/bible/03-splash-portrait.html`
> On excerpt mismatch, STOP.

## Status

- **Priority**: P1 (user-reported)
- **Effort**: M
- **Risk**: MED (visual canon + golden gate)
- **Depends on**: none (base = current `integrate/track-d` tip `4f289fb`)
- **Category**: bug (visual parity with main) + docs (bible)
- **Planned at**: commit `4f289fb`, 2026-07-07

## Why this matters

On `main`, the splash's input-frame footer left-hint shows the live model +
thinking level (e.g. `╰─ gpt-5.5 · high`). Under the RPC host it shows a static
`╰─ AWAITING PROMPT`, and the visual bible is stale (still shows AWAITING plus
a bottom version line that the product no longer renders). The user wants the
RPC splash to match main (live model in the footer) and the bible updated to
match. The model text MUST be the live current model — it updates when the user
changes model on the splash (plan 041 already pushes model changes into the
runtime state the splash reads).

## Current state

**The regression** — `src/sumo-tui/rpc/shell-adapter.ts:648-652`:

```ts
function renderSplashHint(width: number): string {
	const frameWidth = Math.min(width, SPLASH_INPUT_FRAME_WIDTH);
	const hint = renderInputHints(frameWidth, { leftHint: INPUT_FRAME_HINT_AWAITING });
	return centerAnsi(hint, width);
}
```

`INPUT_FRAME_HINT_AWAITING` = `"╰─ AWAITING PROMPT"` (`src/cathedral/input-frame.ts:43`).
Find `renderSplashHint`'s caller in shell-adapter.ts (splash composition) — it
currently passes no state. The adapter already holds chrome state
(`RpcHostChromeState` with `modelLabel?: string` = `provider/id` or `id`, and
`thinkingLevel?: string`) used elsewhere in the file (e.g. `renderActiveHint`,
`topChromeSnapshot`).

**The reference (main/classic path)** — `src/cathedral/input-hints.ts`:

```ts
function modelDisplayName(ctx): string { return ctx.model?.id ?? "no model"; }
function splashInvocationHint(modelId, thinkingLevel): string {
	return `╰─ ${modelId} · ${thinkingLevel ?? "thinking"}`;
}
// rendered via: renderInputHints(frameWidth, { leftHint: splashInvocationHint(...), leftHintStyle: "model-thinking" })
```

`renderInputHints` (`input-frame.ts:214-224`) with `leftHintStyle:
"model-thinking"` colors the model id in ACCENT and the `╰─ ` prefix +
` · ` + thinking level in DIM. Right side is always `CTRL+/ · COMMANDS`
(`INPUT_FRAME_HINT_KEYBINDS`). Note the model shown is the short `id`
(`gpt-5.5`), NOT `provider/id`.

**The stale bible** — `docs/ui/bible/03-splash.html`:
- Line ~51: `<span class="fg-dim">╰─ AWAITING PROMPT</span> ... CTRL+/ · COMMANDS` — must become the live-model form.
- Line ~54: `<span class="fg-dim">SUMOCODE V0.3.0 · CATHEDRAL · 160 × 45 MONOSPACE</span>` — the product does NOT render this version line in the RPC splash; remove the row.
- Line ~14 blurb mentions "version line at bottom" — update.
- `docs/ui/bible/03-splash-portrait.html` has the same two staleness points (lines ~78 AWAITING, ~81 version line).
The version line is NOT rendered by the RPC host (grep confirms
`SPLASH_VERSION_LINE` has no consumer in `src/sumo-tui/`), so no implementation
change is needed to remove it — only the bible is wrong.

**Render/verify tooling**: `pnpm render:bible` regenerates bible HTML/PNG;
`pnpm visual:review` builds the review pack; `pnpm visual:ci` is the gate
(will fail on the splash crop until a human promotes — expected).
`src/visual-parity-contract.test.ts` and `docs/visual/parity/scenarios.json`
may encode splash rows — if a splash assertion references AWAITING or the
version line, update it to the new form (precedent: plan 054 updated the
contract alongside a surface change).

Conventions: tabs, strict TS, colocated tests, typed render primitives
(`docs/SUMO_TUI_RENDER_PRIMITIVES.md`); voice lowercase/terse.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install (worktree) | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Targeted tests | `pnpm vitest run src/sumo-tui/rpc/shell-adapter.test.ts src/cathedral/input-frame.test.ts src/cathedral/input-hints.test.ts src/visual-parity-contract.test.ts` | pass (see Step 4 for contract updates) |
| Regenerate bible | `pnpm render:bible` | exit 0; regenerates `03-splash*` HTML + PNG |
| Review pack | `pnpm visual:review -- --scenario <splash id>` | produces review evidence |

## Scope

**In scope**:
- `src/sumo-tui/rpc/shell-adapter.ts` (`renderSplashHint` + its caller — thread state)
- `src/cathedral/input-hints.ts` — export a pure `splashInvocationHint(modelId, thinkingLevel)` (and reuse it in both paths) so the classic and RPC splash share ONE string shape
- `src/cathedral/input-frame.ts` — remove `INPUT_FRAME_HINT_AWAITING` ONLY if no production caller remains after Step 1 (grep); otherwise leave it
- `docs/ui/bible/03-splash.html`, `docs/ui/bible/03-splash-portrait.html` (+ regenerated PNGs under `docs/ui/bible/renders/`)
- `src/sumo-tui/rpc/shell-adapter.test.ts`, `src/cathedral/input-frame.test.ts`, `src/cathedral/input-hints.test.ts`, `src/visual-parity-contract.test.ts` (only assertions touching the splash hint / version line)

**Out of scope**:
- The active (non-splash) hint (`renderActiveHint`) — unchanged.
- `footer.ts` `SPLASH_VERSION_LINE` and its test — leave the constant (it is
  not rendered in the RPC splash; deleting it is a separate cleanup). Do NOT
  touch `footer.test.ts`.
- `CATHEDRAL_UX_SPEC_V2.md` — note as a follow-up; do not edit here.
- Any golden promotion (`pnpm visual:promote`) — human-gated.
- The cat art, wordmark, quote, DIVINE INVOCATION frame, placeholder — all
  already correct; do not change.

## Git workflow

- Branch: `advisor/059-splash-live-model-footer-and-bible` off `4f289fb`
- Conventional commits (`fix(rpc): ...`, `docs(bible): ...`). Do NOT push.

## Steps

### Step 1: RPC splash hint renders the live model + thinking

Export `splashInvocationHint(modelId: string, thinkingLevel: string | undefined): string`
from `input-hints.ts` (the `╰─ ${modelId} · ${thinkingLevel ?? "thinking"}`
one-liner) and use it in `input-hints.ts` itself (no behavior change there).
In `shell-adapter.ts`, change `renderSplashHint` to accept the chrome state,
derive the short model id from `state.modelLabel` (the segment after the last
`/`, or `"no model"` when `modelLabel` is undefined), and render:

```ts
const modelId = state.modelLabel ? state.modelLabel.split("/").pop()! : "no model";
const hint = renderInputHints(frameWidth, {
	leftHint: splashInvocationHint(modelId, state.thinkingLevel),
	leftHintStyle: "model-thinking",
});
```

Thread `state` from `renderSplashHint`'s caller. Remove the
`INPUT_FRAME_HINT_AWAITING` import if now unused.

**Verify**: `pnpm exec tsc --noEmit` → 0; shell-adapter.test.ts — new/updated
test: the splash hint contains the state's model id (accent) + thinking (dim)
and `CTRL+/ · COMMANDS`, and does NOT contain `AWAITING PROMPT`; a
`modelLabel: undefined` state renders `no model · thinking`.

### Step 2: Remove the now-unused AWAITING constant (conditional)

`grep -rn "INPUT_FRAME_HINT_AWAITING" src/` — if the only remaining references
are its definition and its own test, remove the constant
(`input-frame.ts:43`) and its test assertion (`input-frame.test.ts` — the
"exposes locked awaiting hint string" case and any `leftHint:
INPUT_FRAME_HINT_AWAITING` usages, replacing those test inputs with a literal
or the model-thinking hint). If any OTHER production file still uses it, keep
it and note that in the report.

**Verify**: `pnpm vitest run src/cathedral/input-frame.test.ts src/cathedral/input-hints.test.ts` → pass.

### Step 3: Update the bible HTML

In `03-splash.html` and `03-splash-portrait.html`:
- Replace the `╰─ AWAITING PROMPT` span with the live-model form, colored to
  match `leftHintStyle: "model-thinking"`: prefix `╰─ ` dim, model id
  accent, ` · <thinking>` dim. Use a representative current model:
  `╰─ ` (dim) + `gpt-5.5` (accent, `fg-accent`) + ` · high` (dim). Keep the
  right side `CTRL+/ · COMMANDS` unchanged.
- Delete the version-line row (`SUMOCODE V… · CATHEDRAL · … MONOSPACE`).
- Update the stage blurb to drop "version line at bottom" and say the frame
  footer shows the live `model · thinking`.
Keep column widths/alignment consistent with the surrounding grid rows.

**Verify**: `pnpm render:bible` → exit 0 (regenerates the HTML-driven targets
and PNGs). Confirm the regenerated `03-splash*` no longer contain
`AWAITING PROMPT` or `MONOSPACE`: `grep -n "AWAITING\|MONOSPACE" docs/ui/bible/03-splash.html docs/ui/bible/03-splash-portrait.html` → no matches.

### Step 4: Reconcile the visual contract + produce review evidence

Run `pnpm vitest run src/visual-parity-contract.test.ts`. If it fails because
it pins the splash AWAITING/version-line rows, update those assertions to the
new form (do NOT weaken unrelated assertions). Then run
`pnpm visual:review` (whole or `-- --scenario <splash scenario id from
docs/visual/parity/scenarios.json>`) to produce the review pack, and read
`docs/visual/out/parity/<splash>/raw/styled-cell-diff.txt` if present.

**Verify**: `pnpm exec tsc --noEmit` → 0; targeted vitest (incl. contract) →
pass; `pnpm visual:review` produces a review pack. Run `pnpm visual:ci` and
report its result verbatim — a FAILURE localized to the splash crop (golden
stale) is EXPECTED and acceptable; a failure anywhere else is a STOP.

## Test plan

- shell-adapter.test.ts: splash hint shows live model+thinking, no AWAITING;
  no-model fallback.
- input-hints.test.ts: `splashInvocationHint` export covered (kept green).
- input-frame.test.ts: AWAITING assertions updated/removed per Step 2.
- visual-parity-contract.test.ts: splash rows reconciled if pinned.
- Pattern: existing hint tests in those files.

## Done criteria

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm vitest run src/sumo-tui/rpc/shell-adapter.test.ts src/cathedral/input-frame.test.ts src/cathedral/input-hints.test.ts src/visual-parity-contract.test.ts` exits 0
- [ ] RPC splash hint shows live `model · thinking` (test-proven), no `AWAITING PROMPT`
- [ ] `pnpm render:bible` succeeds; `03-splash*` HTML free of `AWAITING`/`MONOSPACE`; version-line row gone
- [ ] `pnpm visual:review` review pack produced; `pnpm visual:ci` result reported verbatim (splash-crop-only failure is expected/acceptable)
- [ ] `pnpm visual:promote` NOT run
- [ ] `git status` — only in-scope files + regenerated `docs/ui/bible/renders/*` changed

## STOP conditions

- The regenerated bible or `visual:ci` shows a change to a NON-splash surface
  (your edit leaked).
- `renderSplashHint`'s caller cannot supply state without a larger refactor
  (report the seam).
- `visual-parity-contract.test.ts` can only pass by weakening a non-splash
  assertion.
- `INPUT_FRAME_HINT_AWAITING` has a production caller beyond shell-adapter
  (keep it; report).

## Maintenance notes

- Splash footer now reads live chrome state — it updates when the model
  changes on the splash (plan 041 pushes model changes into runtime state).
- Golden promotion is the reviewer/Dhruv's call after inspecting the review
  pack; the executor stops at evidence.
- Follow-ups (not here): `CATHEDRAL_UX_SPEC_V2.md` Element 3 still documents
  AWAITING + the version line; and `footer.ts SPLASH_VERSION_LINE` is now
  unreferenced by the RPC path (candidate cleanup).
