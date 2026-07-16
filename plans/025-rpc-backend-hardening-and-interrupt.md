# Plan 025: RPC backend hardening and interrupt semantics

> **Executor instructions:** Follow this plan step by step. Part A (hardening)
> has no dependency on the Track D shell work and may run in parallel with
> 018–019. Part B is split: Steps B1–B2 (the `abort` control and the pure
> tier module) have no wiring and can be done anytime; Steps B3–B4 (wiring +
> integration test) **require Plan 023's shared input router and its
> `preEditorInputHandler` hook.** Start from `codex/plan023-shared-input-router-exec`
> at `d1982eb`; do not reintroduce a local stdin parser in `rpc/runtime.ts`.
> If that branch/commit is not available, STOP and report. Run every
> verification command; on a STOP condition, stop and report.
>
> **Drift check (run first):**
> `git rev-parse --short HEAD` must print `d1982eb` before you create your
> execution branch, or your branch must contain `d1982eb` as its direct base.
> Then run
> `git diff --stat d1982eb..HEAD -- src/sumo-tui/rpc/ src/sumo-tui/input/ test/integration/`.
> It should be empty before you begin. If not, compare the excerpts below
> against the live code before proceeding; on a mismatch, STOP.
>
> Source spec: this plan extracts the backend/behavioral half of
> [draft-rpc-host-main-brain-rebuild.md](draft-rpc-host-main-brain-rebuild.md)
> (superseded as an execution plan; still valid as evidence).

## Status

- **Priority:** P0
- **Effort:** M
- **Risk:** MED
- **Depends on:** Part A — none (parallel with 018–019); Part B1–B2 — none; Part B3–B4 — 023 (hard: wire through the shared router only)
- **Category:** correctness / bug
- **Planned at:** `a3966a7`, 2026-07-02
- **Reconciled at:** `d1982eb`, after Plan 023 completed on 2026-07-03.
- **Execution base:** `codex/plan023-shared-input-router-exec` at `d1982eb`.
- **Execution:** DONE in `codex/plan025-rpc-hardening-interrupt-exec` at `93e1449`.
- **Review:** APPROVED after one revision. Revise #1 fixed the fatal unhandled-rejection cleanup path so it awaits shared host cleanup and does not orphan the Pi RPC child.

## Why this matters

Three defect families make the RPC host lose or kill live sessions
independently of any rendering work:

1. **Process crashes.** There is no `unhandledRejection` handler in the repo,
   and the host `void`-discards rejectable promises on the hottest paths. One
   RPC timeout (30s default) or one failed memory call crashes the whole TUI.
2. **Transport fragility.** A single non-JSON stdout line from the child tears
   down the session *and leaves the Pi child running detached* (orphan). The
   child stderr buffer grows unbounded for the process lifetime.
3. **No interrupt.** Pi's RPC protocol has `{type:"abort"}`; the host never
   sends it. Any `\u0003` (Ctrl-C) hard-exits the app — even mid-stream, even
   with an approval modal open — and Esc is swallowed by the editor. The
   repo's own classic-path contract (`test/integration/ctrl-c-input.test.ts:20`,
   "clears a draft and keeps the process alive") is violated on the RPC path,
   and there is no `/quit`, so the hard-kill is the only exit.

## Current state

Verified excerpts after Plan 023 at `d1982eb`:

```ts
// src/sumo-tui/rpc/client.ts:158-165 — parse failure → handleExit, which
// rejects pending requests and marks the client dead but NEVER kills the
// child process (orphan). One bad line (e.g. a stray console.log from an
// extension inside the child) is instantly fatal to the session.
private handleLine(line: string): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		this.handleExit(new Error(`Failed to parse RPC line: ${toError(error).message}. line=${line}`));
		return;
	}
```

```ts
// src/sumo-tui/rpc/client.ts:93-95 — unbounded stderr accumulation.
child.stderr.on("data", (chunk: string) => {
	this.stderrBuffer += chunk;
});
```

```ts
// src/sumo-tui/rpc/editor.ts:113-115 — rejection escapes; with no
// unhandledRejection handler anywhere, Node terminates the process.
this.editor.onSubmit = (text) => {
	void Promise.resolve(this.onSubmit(text));
};
```

The submit handler it discards (`src/sumo-tui/rpc/host.ts:136-154`) awaits
`submitRpcPrompt(...)`, which awaits `client.send({type:"prompt", ...})` and
`responseData(...)`; both throw on timeout or error responses. Same unguarded
pattern: `void this.openCommandPalette()` at
`src/sumo-tui/rpc/host-actions.ts:233`, and the `/sumo:memory add|forget|status`
client calls at `host-actions.ts:386-412` (only `openMemoryEditor` has a
try/catch).

```ts
// src/sumo-tui/rpc/runtime.ts:119-149 — Plan 023's shared router is in place,
// but its default Ctrl-C behavior still hard-exits before editor/modal-specific
// semantics can apply unless host.ts supplies a preEditorInputHandler.
this.inputRouter = new SharedInputRouter({
	// ...
	handlePreEditorInput: (data) => {
		if (this.preEditorInputHandler?.(data) === true) return true;
		if (isCtrlCInput(data)) {
			this.requestExit(130);
			return true;
		}
		return false;
	},
	// ...
	handleUnhandledInput: (data) => {
		if (data.includes("q") || isEscapeInput(data)) {
			this.requestExit(0);
			return true;
		}
		return false;
	},
});
```

```ts
// src/sumo-tui/rpc/runtime.ts:44-47 — this is the required Plan 025 wiring hook.
readonly inputHandler?: RpcHostInputHandler;
readonly preEditorInputHandler?: (data: string) => boolean | void;
```

`src/sumo-tui/rpc/controls.ts` has no `abort()`. Pi's command union has it:
`node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts:31`
(`type: "abort"`). `rg -n "abort" src/sumo-tui/rpc/controls.ts` → no matches
at reconciliation time.

Do **not** revert Plan 023's router shape. This old pre-023 runtime branch is
gone and must stay gone:

```ts
// removed by Plan 023; do not recreate
private readonly handleInput = (data: string | Buffer): void => {
	const text = typeof data === "string" ? data : data.toString("utf8");
	if (text.includes("\u0003")) {
		this.requestExit(130);
		return;
	}
```

Conventions: tabs, strict TS, colocated tests, no build step (jiti). Voice
per `src/voice.ts` — notification copy lowercase, terse, no exclamation marks.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm exec tsc --noEmit && pnpm build` | exit 0 |
| Unit (targeted) | `pnpm vitest run src/sumo-tui/rpc/client.test.ts src/sumo-tui/rpc/controls.test.ts src/sumo-tui/rpc/host-actions.test.ts src/sumo-tui/rpc/editor.test.ts src/sumo-tui/rpc/runtime.test.ts src/sumo-tui/rpc/interrupt.test.ts src/sumo-tui/rpc/safe-send.test.ts` | pass |
| Integration | `pnpm test:integration` | pass |
| Manual | `bin/sumocode.sh -d .` | RPC host boots; JSONL diagnostics |

Repo root `/Volumes/SumoDeus NVMe/code/sumocode` — path contains a space,
always quote it.

## Scope

**In scope:**

- `src/sumo-tui/rpc/client.ts`, `controls.ts`, `host.ts`, `host-actions.ts`,
  `editor.ts` + colocated tests
- new `src/sumo-tui/rpc/safe-send.ts` (or equivalent helper) + test
- new `src/sumo-tui/rpc/interrupt.ts` + test
- the shared input router's pre-editor Ctrl-C/Esc interception point from Plan
  023, by passing `preEditorInputHandler` from `host.ts` into `RpcHostRuntime`
  (Steps B3-B4 only; do not recreate local stdin parsing in
  `src/sumo-tui/rpc/runtime.ts`)
- new `test/integration/rpc-ctrl-c.test.ts`

**Out of scope:**

- Shell/layout work (018–020), transcript ingestion (021), modal layer
  internals (022), general input routing (023).
- The approval gate logic in `src/approval-modal.ts` — fail-closed, verified;
  do not touch.
- `bin/sumocode.sh`, `sumo-rpc-host.js`, launcher runtime selection.
- `plans/README.md` and this plan file during execution — the reviewer updates
  plan status after approval.

## Steps — Part A: hardening (no Track D dependency)

### Step A1: Never orphan the child

In `client.ts` `handleExit`, if `this.child` is still set, `SIGTERM` it (with
the same 2s `SIGKILL` fallback `stop()` uses) before clearing the reference.

**Verify:** new unit test — fatal parse error → child `kill` called
(spy). `pnpm vitest run src/sumo-tui/rpc/client.test.ts` → pass.

### Step A2: Tolerate isolated protocol garbage; cap stderr

In `handleLine`, skip an unparseable line (surface it via a new optional
`onProtocolError(line, error)` callback) instead of dying; only `handleExit`
after 3 *consecutive* unparseable lines. Reset the counter on any good line.
Cap `stderrBuffer` at 64 KiB, keeping the tail.

**Verify:** unit tests — one bad line among good ones: pending requests still
resolve, `onProtocolError` fired; 3 consecutive bad lines: exit; stderr capped
at 65536 chars. → pass.

### Step A3: No user action can crash the process

Add a `notifyOnError` helper (new `safe-send.ts`): runs an async fn, catches,
sends a lowercase terse notification (e.g. `rpc error: <message>`). Rewire
every fire-and-forget async call site:

- `RpcHostEditorController`'s `editor.onSubmit` bridge in `editor.ts`;
- `void this.openCommandPalette()` in `host-actions.ts`;
- the `/sumo:memory add|forget|status` client calls in `host-actions.ts`.

Pass a notification/error handler from `host.ts` into the editor controller so
submission failures notify instead of becoming unhandled rejections. Then
install a last-resort `process.on("unhandledRejection", …)` at the top of
`runRpcHost` that restores the terminal (`runtime?.stop(1)`), writes the error
to stderr, and exits 1. Register that handler once per `runRpcHost` invocation
and remove it in a `finally` block so tests or embedded callers do not retain
stale runtime/client closures or duplicate listeners.

**Verify:** unit tests — a rejecting `onSubmit` produces a notification and no
unhandled rejection (vitest fails on unhandled rejections by default); memory
client failure on `/sumo:memory add x` notifies instead of throwing.
`pnpm vitest run src/sumo-tui/rpc/host-actions.test.ts src/sumo-tui/rpc/editor.test.ts` → pass.

## Steps — Part B: interrupt semantics

### Step B1: `abort()` control

Add `abort(): Promise<void>` to `RpcHostControls` sending `{ type: "abort" }`.
If the pinned Pi version's `RpcCommand` union rejects it in TypeScript, STOP.

**Verify:** `pnpm vitest run src/sumo-tui/rpc/controls.test.ts` → pass;
`grep -rn '"abort"' src/sumo-tui/rpc/controls.ts` → ≥1 match.

### Step B2: Tiered Ctrl-C as a pure decision module

New `src/sumo-tui/rpc/interrupt.ts` exporting a pure decision function over
`{ modalActive, overlayActive, draftNonEmpty, isStreaming, armedUntil, now }`
and an input kind (`ctrl-c` or `escape`) returning one of
`dismiss-modal | clear-draft | abort | arm-quit | quit | pass`:

1. modal/overlay active → dismiss it (deny/cancel semantics — a dismissed
   approval resolves "no", which the gate treats as deny);
2. non-empty editor draft → clear draft;
3. `isStreaming` → send `abort`;
4. otherwise → arm a 1.5s "press ctrl+c again to quit" notification; a second
   Ctrl-C inside the window exits cleanly with code 130.

Esc, when no modal/overlay/autocomplete is open and `isStreaming`, → `abort`.
Esc otherwise should return `pass` so editor/autocomplete behavior is not
replaced by this plan.

**Verify:** `pnpm vitest run src/sumo-tui/rpc/interrupt.test.ts` → decision
table covered (all five outcomes + Esc cases).

### Step B3: Wire it and add `/quit` (requires 023)

Wire the tier module through Plan 023's shared input router by passing
`preEditorInputHandler` from `host.ts` into `new RpcHostRuntime(...)`.
`rpc/runtime.ts` should remain a backend-neutral router host; do not move the
decision table into `runtime.ts`.

The handler in `host.ts` should gather:

- modal active: `modals.getActiveKind() !== undefined`;
- overlay active: `overlays.getActiveKind() !== undefined`;
- draft non-empty: `editor.getText().trim().length > 0`;
- streaming: `stateStore.getSnapshot().isStreaming`;
- armed quit deadline: a host-local timestamp.

Apply outcomes at the host boundary:

- `dismiss-modal`: call `modals.close()` when a modal is active, otherwise
  `overlays.close()`; approval dismissal must remain deny/cancel.
- `clear-draft`: `editor.setText("")` and notify `draft cleared`.
- `abort`: `await controls.abort()` through `notifyOnError`; update chrome
  state only if existing state APIs make that natural, otherwise rely on child
  events; notify `abort requested`.
- `arm-quit`: store `now + 1500` and notify `press ctrl-c again to quit`.
- `quit`: call the same clean-shutdown path used by `runtime.stop(130)`.
- `pass`: return `false` so the shared router can continue to the editor or
  unhandled-input path.

Add `/quit` to `handleSubmittedText` and the host autocomplete/command table in
`host-actions.ts`; it should call the same clean-shutdown path as the
double-press tier. Prefer injecting an `onExitRequest(code)` callback into
`RpcHostActions` rather than importing runtime types into the actions module.

**Verify:**
`grep -n 'text.includes("\\u0003")' src/sumo-tui/rpc/runtime.ts` → no match.
`pnpm vitest run src/sumo-tui/rpc/host-actions.test.ts` → `/quit` test passes.

### Step B4: Integration proof

New `test/integration/rpc-ctrl-c.test.ts` (model after
`test/integration/rpc-host-shell.test.ts`, spawn via `spawnSumocodePty`):
first Ctrl-C clears a typed draft and the process stays alive; double Ctrl-C
exits and `TERMINAL_CLEANUP_SEQUENCE` is seen.

**Verify:** `pnpm test:integration` → all pass including the new file.

## Done criteria

- [x] `pnpm exec tsc --noEmit && pnpm build` exit 0
- [x] `pnpm test` either exits 0 or exits only with the known pre-existing `task-manager.test.ts` `output.log` ENOENT caveat noted in `plans/README.md`; report which happened
- [x] `pnpm test:integration` exit 0, including `rpc-ctrl-c`
- [x] `grep -rn '"abort"' src/sumo-tui/rpc/controls.ts` → ≥1 match
- [x] `grep -n 'text.includes("\\u0003")' src/sumo-tui/rpc/runtime.ts` → no match
- [x] `grep -rn "unhandledRejection" src/sumo-tui/rpc/host.ts` → ≥1 match
- [x] Fatal-transport unit test proves the child is killed, not orphaned
- [x] No files outside Scope modified (`git status`)
- [x] Reviewer updates `plans/README.md` status row for 025 after approval

## Reviewer verification

Reviewer reran the closeout gates against `codex/plan025-rpc-hardening-interrupt-exec`
at `93e1449`:

```bash
pnpm vitest run src/sumo-tui/rpc/host.test.ts src/sumo-tui/rpc/client.test.ts src/sumo-tui/rpc/controls.test.ts src/sumo-tui/rpc/host-actions.test.ts src/sumo-tui/rpc/editor.test.ts src/sumo-tui/rpc/runtime.test.ts src/sumo-tui/rpc/interrupt.test.ts src/sumo-tui/rpc/safe-send.test.ts
pnpm exec tsc --noEmit && pnpm build
pnpm test:integration
grep -rn '"abort"' src/sumo-tui/rpc/controls.ts
grep -n 'text.includes("\\u0003")' src/sumo-tui/rpc/runtime.ts
grep -rn "unhandledRejection" src/sumo-tui/rpc/host.ts
pnpm test
pnpm render:bible
pnpm visual:review -- --scenario splash-runtime
pnpm visual:review -- --scenario active-landscape-runtime
pnpm visual:review -- --scenario active-portrait-runtime
pnpm visual:ci
python3 /Users/sumo-deus/.codex/skills/autoreview/scripts/autoreview --mode branch --base codex/plan023-shared-input-router-exec --engine codex --prompt "<Plan 025 final review context>"
```

Results: focused RPC tests, type/build, integration tests, greps, runtime visual
reviews, and visual CI passed. `pnpm test` passed all 121 files / 1169 tests,
then exited 1 only for the known unrelated `task-manager.test.ts` `output.log`
ENOENT. Final branch autoreview was clean with no accepted/actionable findings.

## STOP conditions

- Pi's `RpcCommand` union has no `abort` member, or a live abort during a
  streaming response (manual check via `bin/sumocode.sh -d .`) does not stop
  the stream.
- Plan 023's shared router has not landed and Steps B3–B4 are next — mark
  BLOCKED on 023 and stop; wiring the tiers into the legacy runtime handler
  and re-homing them later is explicitly not allowed.
- Rewiring `onSubmit` error handling requires changing the RPC prompt
  semantics (`streamingBehavior` selection in `host.ts:89-92`) — report, do
  not redesign.
- Any verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The Ctrl-C decision table is user-facing contract; a change there needs the
  integration test updated in the same commit.
- Pi version bumps: re-verify `abort` stays in the RPC command union
  (AGENTS.md already mandates re-checking `rpc-types.d.ts` on bumps).
- Deferred: `steer`-on-Esc-then-type (Pi RPC supports `steer`; natural
  follow-up once abort works — noted in draft-rpc-host-main-brain-rebuild.md).
