# Plan 044: Fix Ctrl-C-after-paste suppression and make the Apple Terminal Shift+Enter path real

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. SKIP updating
> `plans/README.md` — your reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat 86e5062..HEAD -- src/sumo-tui/input/shared-input-router.ts src/sumo-tui/rpc/runtime.ts`
> On drift, compare "Current state" excerpts; mismatch = STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `86e5062`, 2026-07-07

## Why this matters

Two input-path defects found by two independent auditors:

1. `containsCtrlCToken` early-returns `false` for ANY stdin chunk containing a
   bracketed-paste START marker — before tokenizing. If a complete paste block
   and a real Ctrl-C keypress coalesce into one `data` event (fast
   paste-then-interrupt, PTY buffering), the interrupt is swallowed and the
   whole chunk routes onward. The tokenizer already keeps paste blocks whole,
   so the blanket guard is strictly broader than the invariant it enforces.
2. The Apple Terminal Shift+Enter "fix" (prior-audit batch B3) never fires:
   the only production call passes `isShiftPressed: false` hardcoded, and the
   helper only rewrites when it's `true`. Apple Terminal users still cannot
   insert a newline with Shift+Enter — the chord submits.

## Current state

- `src/sumo-tui/input/shared-input-router.ts:231-240`:

```ts
export function containsCtrlCToken(data: string): boolean {
	// Belt-and-suspenders: even before token-splitting, a chunk carrying a
	// bracketed-paste start marker is never treated as an interrupt keypress.
	// splitInputTokens already keeps paste blocks whole (so isCtrlCInput would
	// not match their single combined token either), but this guard makes the
	// "paste content never triggers the interrupt tier" invariant explicit and
	// independent of the tokenizer's internals.
	if (data.includes("\x1b[200~")) return false;
	return splitInputTokens(data).some((token) => isCtrlCInput(token));
}
```

- `src/sumo-tui/rpc/runtime.ts:136-144` (the ONLY production call site of the
  Apple Terminal helper):

```ts
const text = typeof data === "string" ? data : data.toString("utf8");
// Apple Terminal sends a bare \r for both plain Enter and Shift+Enter
// (no Kitty protocol / modifyOtherKeys support), so without a shift
// probe this is a no-op today -- see normalizeAppleTerminalInput's
// doc comment for why isShiftPressed is hardcoded false. ...
const normalized = normalizeAppleTerminalInput(text, this.isAppleTerminal, false);
this.inputRouter.handleInput(normalized);
```

- `src/sumo-tui/input/shared-input-router.ts:204-218` —
  `normalizeAppleTerminalInput(data, isAppleTerminal, isShiftPressed)` rewrites
  bare `\r` to the CSI-u Shift+Enter sequence ONLY when both flags are true;
  its doc comment concedes every call site passes `false`.
- `src/sumo-tui/input/shared-input-router.test.ts:~327` — a test pins the
  current no-op limitation (helper called with synthetic `true`, never the
  runtime path).
- The oracle for behavior 2 is Pi's own input pipeline. SumoCode runs Pi
  `0.79.1`; its dist is available in the worktree at
  `node_modules/@earendil-works/pi-coding-agent/` and pi-tui at
  `node_modules/@earendil-works/pi-tui/`. Pi's interactive mode DOES handle
  Apple Terminal (`isAppleTerminalSession` exists in this repo mirroring it).
  Your Step 2 starts by reading how Pi itself distinguishes Shift+Enter on
  Apple Terminal (search those two packages for `AppleTerminal`,
  `modifyOtherKeys`, `1036`, `shift`, `\\r` handling in
  `dist/**/*terminal*.js` and `dist/**/input*.js`).
- Conventions: tabs, strict TS, colocated tests.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install (worktree) | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Targeted tests | `pnpm vitest run src/sumo-tui/input/shared-input-router.test.ts src/sumo-tui/rpc/runtime.test.ts` | all pass |

Full `pnpm test` currently exits 1 from a known unrelated flake — not a gate.

## Scope

**In scope**:
- `src/sumo-tui/input/shared-input-router.ts`
- `src/sumo-tui/rpc/runtime.ts`
- `src/sumo-tui/input/shared-input-router.test.ts`, `src/sumo-tui/rpc/runtime.test.ts`

**Out of scope**:
- The interrupt DECISION table (`src/sumo-tui/rpc/interrupt.ts`) — routing
  detection only, not what Ctrl-C does.
- Editor internals, keybindings manager, diagnostics call sites (another plan
  touches the diagnostics lines in this file — keep your hunks away from the
  `logDiagnostic` calls).
- Non-Apple terminal Enter behavior. Plain Enter MUST keep submitting.

## Git workflow

- Branch: `advisor/044-input-router-interrupt-fixes`
- Conventional commits (`fix(input): ...`). Do NOT push.

## Steps

### Step 1: Remove the blanket paste-start guard

Delete the `if (data.includes("\x1b[200~")) return false;` line (and shrink
the comment to state the tokenizer is the single authority). The tokenizer
path already exempts paste-block tokens.

**Verify**: new tests in `shared-input-router.test.ts`:
- chunk = `"\x1b[200~abc\x03def\x1b[201~"` → `containsCtrlCToken` is `false`
- chunk = `"\x1b[200~abc\x1b[201~\x03"` (paste then real Ctrl-C) → `true`
  (this must FAIL before your change; say so in a comment)
- chunk = `"\x03"` → `true`
Run: `pnpm vitest run src/sumo-tui/input/shared-input-router.test.ts` → pass.

### Step 2: Investigate Pi's real Apple Terminal Shift+Enter mechanism

Read Pi/pi-tui dist as described in "Current state". Determine which of these
is true and record file:line evidence in your report:

- (a) Pi enables a terminal mode on Apple Terminal (e.g. `modifyOtherKeys` /
  `CSI >4;2m` / kitty query fallback) that makes Shift+Enter distinguishable,
  and parses the resulting sequence;
- (b) Pi maps a DIFFERENT chord (e.g. Option+Enter sending `\x1b\r`) to
  newline on Apple Terminal and Shift+Enter genuinely cannot be detected;
- (c) Pi does nothing special — Apple Terminal simply cannot insert newline
  via Shift+Enter in Pi either.

### Step 3: Implement to match Pi exactly

- Case (a): replicate the enabling sequence in the RPC runtime's terminal
  setup (find where the runtime writes terminal init sequences — altscreen /
  mouse enable — and add the same mode Pi sets, with the matching teardown),
  then thread real shift detection into `normalizeAppleTerminalInput`'s call
  site and delete the hardcoded `false`.
- Case (b): implement the same alternative chord mapping at the same layer Pi
  does, update `normalizeAppleTerminalInput`'s doc comment to describe the
  real mechanism, and remove the dead `isShiftPressed` parameter if nothing
  can ever pass `true`.
- Case (c): remove the dead-parameter path entirely (delete the hardcoded
  `false` argument and the unreachable branch), replace the misleading
  "fix" with an explicit limitation note in the helper's doc comment, and
  make the existing limitation-pinning test assert the documented behavior at
  the RUNTIME call-site level (feed `\r` through `RpcHostRuntime.handleInput`
  with an Apple-Terminal env and assert what reaches the router). This is a
  descope WITH evidence, not a silent skip — your report must carry the Pi
  file:line proving (c).

**Verify**: `pnpm vitest run src/sumo-tui/rpc/runtime.test.ts src/sumo-tui/input/shared-input-router.test.ts` → pass; for (a)/(b) a test
exercises the real call-site path (not a synthetic `true`).

## Test plan

Step 1's three tokenizer cases; Step 3's call-site-level test for whichever
case holds. Pattern: existing router tests (raw byte-string in, verdict out).

## Done criteria

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] Targeted vitest files exit 0
- [ ] `grep -n '200~' src/sumo-tui/input/shared-input-router.ts` shows no early-return guard in `containsCtrlCToken`
- [ ] Paste-then-Ctrl-C regression test exists and passes
- [ ] Report contains Pi file:line evidence for case (a)/(b)/(c)
- [ ] No test asserts the helper with a synthetic `isShiftPressed: true` as its ONLY coverage
- [ ] `git status` — only in-scope files changed

## STOP conditions

- "Current state" excerpts don't match (drift).
- Case (a) requires terminal-mode changes outside the runtime's existing
  init/teardown seam (e.g. deep in retained-shell-renderer) — report first.
- Enabling the terminal mode regresses plain Enter or bracketed paste in any
  existing test — report rather than special-casing.

## Maintenance notes

- Whichever case holds, the helper's doc comment must describe the REAL
  mechanism afterward — the current comment describes an aspiration.
- Reviewer: diff hunks must not touch `logDiagnostic` lines (plan 045 owns
  those); check plain-Enter submit coverage still exists.
