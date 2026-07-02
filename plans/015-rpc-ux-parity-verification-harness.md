# Plan 015: Make RPC runtime UX parity a required visual gate

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report - do not improvise. When done, update the status row for this plan
> in `plans/README.md` - unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 96a2a0a..HEAD -- docs/visual/parity/scenarios.json scripts/visual-v2 src/visual-parity-contract.test.ts test/integration/rpc-host-shell.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: MED
- **Depends on**: 014
- **Category**: tests
- **Planned at**: commit `96a2a0a`, 2026-07-02

## Why this matters

The current RPC cutover passed `pnpm visual:ci` while the captured UI was not
1:1 with the current original Cathedral UI. That happened because several
runtime crops are review evidence rather than hard required gates, and because
the runtime scenario can still pass while the RPC runtime hand-paints a
minimal shell. Before executing UI parity work, the harness must fail loudly
when RPC splash, footer, sidebar, input, hint row, or transcript surfaces drift
from the canonical visual contract. The reviewer is responsible for final
parity approval, but the harness must make the obvious mismatches machine
visible.

## Current state

`docs/visual/parity/scenarios.json:210-247` defines `splash-runtime` as a
runtime scenario, but the only crop is `full` and it has no `status:
"required"`:

```json
{
  "id": "splash-runtime",
  "lane": "runtime",
  "status": "review",
  "dimensions": { "cols": 160, "rows": 45 },
  "bibleTarget": "03-splash.png",
  "crops": [
    { "id": "full", "targetCrop": "full", "runtimeCrop": "full" }
  ]
}
```

`docs/visual/parity/scenarios.json:249-328` defines
`active-landscape-runtime` crops for top bar, sidebar, chat, input, hint, and
footer, but those crop entries also lack `status: "required"`. The same is
true for the portrait runtime scenario starting at `docs/visual/parity/scenarios.json:345`.

`scripts/visual-v2/runtime-capture.mjs:70-78` writes scenario inputs exactly
as declared:

```js
const inputs = runtime.inputs ?? [];
for (const input of inputs) {
	const wait = Math.max(0, Number(input.afterMs ?? 0));
	await sleep(wait);
	if (exited) break;
	if (input.type === "text") child.write(input.value ?? "");
	else if (input.type === "key") child.write(input.value ?? "");
	else throw new Error(`Unsupported runtime input type in ${scenario.id}: ${input.type}`);
}
```

The active runtime scenarios currently submit using raw `"\r"` at
`docs/visual/parity/scenarios.json:279-282` and `:377-380`. In the RPC editor,
plain carriage return can be ambiguous in PTY automation; integration tests use
CSI-u Enter (`"\u001b[13u"`) for reliable submit.

The reviewer-captured RPC demo proved the current harness gap: the first clip
showed the prompt still in the input frame, while the second clip using
`"\u001b[13u"` reached `MEDITATING` and rendered live tool output.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Contract tests | `pnpm vitest run src/visual-parity-contract.test.ts` | all pass |
| Runtime smoke | `pnpm vitest run test/integration/rpc-host-shell.test.ts` | all pass |
| Visual one scenario | `pnpm visual:review -- --scenario active-landscape-runtime` | produces review pack |
| Visual CI | `pnpm visual:ci` | exits non-zero before parity work if required crops drift; exits 0 after Plan 016/017 |
| Typecheck/build | `pnpm exec tsc --noEmit && pnpm build` | exit 0 |

## Scope

**In scope:**

- `docs/visual/parity/scenarios.json`
- `scripts/visual-v2/index.mjs`, `scripts/visual-v2/runtime-capture.mjs`, and
  nearby visual harness modules if needed
- `src/visual-parity-contract.test.ts`
- `test/integration/rpc-host-shell.test.ts` only for launch/input proof
- Optional: a new `scripts/visual-v2/record-runtime-demo.mjs` helper that
  records an MP4/PNG evidence clip outside tracked goldens

**Out of scope:**

- Changing RPC runtime UI to pass the new gate. That is Plan 016/017.
- Promoting or updating goldens.
- Reintroducing the legacy seam or using `SUMO_LEGACY` for comparisons.
- Deleting existing review-pack artifacts unless they are generated ignored
  output.

## Git workflow

- Branch: `codex/rpc-migration-no-seam`
- Commit message example: `test: require rpc visual parity gates`
- Do not push or open a PR unless the operator explicitly instructs it.

## Steps

### Step 1: Make runtime crops required

In `docs/visual/parity/scenarios.json`, mark the runtime crops that define the
current original UX as required:

- `splash-runtime`: full splash crop is required.
- `active-landscape-runtime`: top-bar, sidebar, chat-area, input-frame,
  hint-row, and footer are required. Full may stay review-only if pixel noise is
  too broad, but required crops must cover all visible chrome.
- `active-portrait-runtime`: top-bar, chat-area, input-frame, hint-row, and
  footer are required.
- Existing fixture overlay crops that represent command palette, divine query,
  memory scriptorium, tool ledger, skill pill, code block, and scroll/scribe
  should either already be required or be made required when they are stable.

Choose thresholds from existing successful component crop thresholds. Do not
relax thresholds to make the current minimal RPC shell pass.

**Verify:**

```bash
pnpm vitest run src/visual-parity-contract.test.ts
```

Expected: tests pass after updating contract expectations.

### Step 2: Fix automated submit inputs for RPC runtime scenarios

Update active runtime scenario inputs to use CSI-u Enter:

```json
{ "afterMs": 250, "type": "key", "value": "\u001b[13u" }
```

Keep the delay above the editor's raw-paste CR window. If the visual harness
needs a named input kind for Enter instead of embedding the sequence, add it in
`scripts/visual-v2/runtime-capture.mjs` and test it.

**Verify:**

```bash
pnpm visual:review -- --scenario active-landscape-runtime
```

Expected: the captured runtime reaches the submitted/working state rather than
leaving the test prompt in the editor.

### Step 3: Add explicit RPC shell rejection patterns

Add runtime rejection patterns that catch the known non-parity placeholders:

- `SUMOCODE RPC`
- `empty transcript`
- `sumocode · rpc host`

These should reject only in scenarios whose target is the original Cathedral
UX. Do not add them to tests that intentionally assert the temporary RPC shell
exists before Plan 016 executes.

**Verify:**

```bash
pnpm visual:review -- --scenario splash-runtime
```

Expected before Plan 016: this should fail or report a rejection against the
current minimal RPC shell. That failure is acceptable and is the point of this
plan. Record it in the executor report. After Plan 016, the same command must
pass.

### Step 4: Produce reviewer evidence outputs

Add or document a helper that records:

- PNG poster frame for `splash-runtime`
- PNG poster frame for `active-landscape-runtime`
- optional MP4 clip of a submitted offline prompt reaching `MEDITATING`

The helper must write under an ignored path such as `/tmp/sumocode-rpc-demo` or
`docs/visual/out/parity/`, not into Bible goldens.

**Verify:**

```bash
pnpm visual:review -- --scenario splash-runtime
pnpm visual:review -- --scenario active-landscape-runtime
```

Expected: review pack paths are printed. If a new recorder script exists, it
prints the generated poster/video paths.

### Step 5: Document reviewer responsibility

Update `docs/visual/parity/CONTRACT.md` or the closest visual harness doc to
state that RPC-default UI parity is not approved until:

- required crop gates pass,
- text-level styled-cell diff and geometry audit have no unapproved drift,
- a human reviewer compares the review pack or clip against the current
  original UX,
- no golden promotion occurs without Dhruv approval.

**Verify:**

```bash
rg "RPC.*parity|human reviewer|required crop|golden promotion" docs/visual/parity docs/visual
```

Expected: the new responsibility is documented.

## Test plan

- Contract unit tests for required runtime crops.
- One scenario visual review proving submit input works.
- One expected-fail visual review against the current minimal RPC shell, unless
  Plan 016 has already landed in the same execution sequence.

## Done criteria

ALL must hold:

- [ ] Runtime visual scenarios mark the original UX-defining crops as required.
- [ ] Active runtime scenarios submit with a reliable key sequence.
- [ ] The current minimal RPC placeholders are rejected by original-UX runtime
  scenarios.
- [ ] Review evidence locations are printed and not committed as goldens.
- [ ] The visual docs say the reviewer is responsible for final UI parity
  approval.
- [ ] `pnpm exec tsc --noEmit && pnpm build` exits 0.

## STOP conditions

Stop and report if:

- Making the crops required would require modifying goldens in this plan.
- The harness cannot distinguish original-UX scenarios from temporary RPC-shell
  scenarios without broad rewrites.
- The visual runner cannot submit a prompt reliably after two attempts.

## Maintenance notes

This plan intentionally may make `pnpm visual:ci` fail until Plan 016 restores
the actual UX. That is healthier than a green gate over a non-parity UI. The
advisor/reviewer should treat this plan's expected failure as a gate opening,
not as a regression to paper over.
