# Plan 060: Refresh the startup perf baseline with per-phase measurements for the RPC host path

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0dc25c7..HEAD -- scripts/perf-startup.mjs docs/perf/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf (measurement)
- **Planned at**: commit `0dc25c7`, 2026-07-08

## Why this matters

The committed startup baseline (`docs/perf/startup.md`) is from 2026-06-11 and
measures the **retired retained runtime** (pre-RPC-cutover, commit `e86879a`,
first-frame 1824ms). The product now boots through the RPC host
(`bin/sumocode.sh` → `sumo-rpc-host.js` → `src/sumo-tui/rpc/host.ts`), whose
startup budget is completely different: ~900–1350ms host module import (jiti)
plus ~2200–2800ms Pi child boot, all serial, before the first frame. Plans 061
(early first frame) and 062 (pre-bundled host entry) change this pipeline;
without a per-phase baseline on the RPC path there is no way to prove their
before/after deltas. This plan adds two phase measurements (host-import,
child-first-response) to the existing harness and regenerates the baseline.

## Current state

- `scripts/perf-startup.mjs` — the report-only startup harness. Structure:
  - `measureProcess(label, command, args)` — spawns a command, times to exit
    (used for `launcher-dry-run` and `print-mode`).
  - `measureFirstFrame()` — node-pty spawn of `bin/sumocode.sh --offline
    --no-extensions --no-session`, times until altscreen/sync escape
    (`\x1b[?1049h` / `\x1b[?2026h`) or `DIVINE INVOCATION` appears.
  - `measureStartupTimeline()` — same spawn with `SUMO_TUI_DIAG_FILE` set,
    polls the diag JSONL for `boot_screen_frame` / `app_ready` /
    `stable_chrome_ready` / `input_ready` events.
  - `main()` writes `docs/perf/startup.json` and `docs/perf/startup.md`.
- Known quirk to leave alone: the harness sets `SUMO_TUI: "1"` in child env;
  `bin/sumocode.sh` overrides it to `0` anyway. Harmless.
- Known quirk this plan documents but does NOT fix: all four timeline events
  are currently emitted at the same instant — `src/sumo-tui/rpc/runtime.ts:309`:

  ```ts
  for (const event of ["boot_screen_frame", "stable_chrome_ready", "app_ready", "input_ready"]) {
      logDiagnostic(event, { surface: "rpc_host", cols, rows });
  }
  ```

  Plan 061 splits them. This plan's job is only to make the harness able to
  show the split once it happens.
- `sumo-rpc-host.js` (repo root, 9 lines) — the host entry:

  ```js
  import { createJiti } from "jiti";
  const jiti = createJiti(import.meta.url, { moduleCache: true, tryNative: false });
  const mod = await jiti.import("./src/sumo-tui/rpc/host.ts");
  await mod.main();
  ```

- The RPC child is spawned by the host as
  `${PI_BIN} --mode rpc -e <root>/src/extension.ts ...argv` (see
  `src/sumo-tui/rpc/host.ts:502`). `PI_BIN` resolves to
  `<root>/node_modules/.bin/pi` in this repo.
- The RPC protocol is JSON lines on stdin/stdout. A probe command
  `{"type":"get_state","id":"probe-1"}` written to the child's stdin gets a
  response line containing `"probe-1"` once the child is ready. Measured at
  `0dc25c7`: ~2200–2800ms (identical with and without `-e src/extension.ts`).
- Reference numbers measured at `0dc25c7` on the advisor's machine (Apple
  Silicon, warm caches) — for sanity-checking your results, not as gates:
  host import via jiti ~900–1350ms; child first response ~2200–2800ms.
- Conventions: plain `.mjs` Node scripts under `scripts/`, tab indentation,
  no external deps beyond what `package.json` already has (`node-pty` is a
  devDependency and already imported by this script).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Unit tests | `pnpm test` | exit 0 |
| Run the harness | `pnpm perf:startup` | exit 0, prints markdown table |
| Fast harness iteration | `SUMOCODE_STARTUP_PERF_RUNS=2 pnpm perf:startup` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `scripts/perf-startup.mjs`
- `docs/perf/startup.json` (regenerated)
- `docs/perf/startup.md` (regenerated)

**Out of scope** (do NOT touch, even though they look related):
- `src/sumo-tui/rpc/runtime.ts` — splitting the readiness events is plan 061.
- `scripts/measure-resume-perf.mjs`, `scripts/startup-diagnostics-preload.cjs` — different harnesses.
- `bin/sumocode.sh`, `sumo-rpc-host.js`, anything under `src/` — measurement only, no product changes.

## Git workflow

- Branch: `advisor/060-startup-perf-baseline-refresh`
- Conventional commits, e.g. `perf(startup): add host-import and child-boot phase measurements`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a `child-first-response` measurement

In `scripts/perf-startup.mjs`, add `measureChildFirstResponse()`:

- Spawn (plain `child_process.spawn`, no PTY needed):
  `join(ROOT, "node_modules", ".bin", "pi")` with args
  `["--mode", "rpc", "-e", join(ROOT, "src", "extension.ts"), "--offline", "--no-session"]`,
  cwd `ROOT`, env `{ ...process.env, SUMO_TUI: "0", SUMOCODE_RPC_CHILD: "1" }`,
  stdio `["pipe", "pipe", "pipe"]`.
- Immediately write `JSON.stringify({ type: "get_state", id: "probe-1" }) + "\n"`
  to the child's stdin.
- Time from spawn until a stdout chunk makes the accumulated buffer contain
  `"probe-1"`. Then `child.kill("SIGTERM")` and, after 250ms, `SIGKILL` if
  still alive (mirror the kill pattern in `measureFirstFrame`).
- Reuse `TIMEOUT_MS` for the timeout path and `summariseMeasurement` for the
  result. Run `RUNS` samples like the other measurements, with the same 100ms
  inter-run sleep.
- **`--offline --no-session` are mandatory** — probes must never create
  session files or touch providers.

**Verify**: `SUMOCODE_STARTUP_PERF_RUNS=2 pnpm perf:startup` → exits 0 and the
table has a `child-first-response` row with a plausible value (1000–5000ms).

### Step 2: Add a `host-import` measurement

Add `measureHostImport()` that spawns a fresh `node` subprocess per sample
(cold module state is the point — do not measure in-process):

- Command: `node --input-type=module -e "<snippet>"` where the snippet is:

  ```js
  const t = performance.now();
  const { createJiti } = await import(process.env.PERF_ROOT + "/node_modules/jiti/lib/jiti.mjs");
  const jiti = createJiti("file://" + process.env.PERF_ROOT + "/sumo-rpc-host.js", { moduleCache: true, tryNative: false });
  await jiti.import(process.env.PERF_ROOT + "/src/sumo-tui/rpc/host.ts");
  console.log(Math.round(performance.now() - t));
  ```

  Pass `PERF_ROOT: ROOT` via env rather than interpolating the path into the
  snippet (the dev tree path contains a space).
- Parse the stdout integer as the sample's `durationMs`; nonzero exit or
  unparseable output → `ok: false` sample.
- This mirrors the exact jiti options in `sumo-rpc-host.js` (excerpt in
  "Current state"). If plan 062 has landed by the time you execute this and
  `sumo-rpc-host.js` no longer uses those options, still keep this
  measurement as-is (it measures the jiti fallback path) and note that in the
  report; do not chase 062's bundle path in this plan.

**Verify**: `SUMOCODE_STARTUP_PERF_RUNS=2 pnpm perf:startup` → table has a
`host-import` row (plausible: 300–2000ms).

### Step 3: Wire both into `main()` and the report

Add both measurements to the `measurements` array in `main()` (order:
`launcher-dry-run`, `host-import`, `child-first-response`, `print-mode`,
first-frame, timeline). Add one sentence to the markdown preamble in
`markdown(report)` noting that `first-frame` ≈ `host-import` +
`child-first-response` + hydration round trips while startup is serial (plan
061 changes this).

**Verify**: `node --check scripts/perf-startup.mjs` → exit 0.

### Step 4: Regenerate the baseline

Run the full harness (default 5 runs) and commit the regenerated
`docs/perf/startup.json` and `docs/perf/startup.md`.

**Precondition**: no live interactive SumoCode session running in this
project directory — the probes spawn real Pi RPC children and have been
observed interfering with a live session. Check with
`ps aux | grep -c "[s]umo-rpc-host"` → expect `0` before running.

**Verify**: `pnpm perf:startup` → exit 0; `git diff --stat docs/perf/` shows
both files changed; the new `startup.md` commit line references the current
HEAD, and rows exist for all of: `launcher-dry-run`, `host-import`,
`child-first-response`, `print-mode`, `first-frame`, `boot-screen-frame`,
`app-ready`, `stable-chrome`, `input-ready`.

## Test plan

This is a measurement script (explicitly report-only, not a CI gate — keep it
that way). No vitest tests required. The verification gates are:
`node --check`, two harness runs (2-run and 5-run), and eyeballing that the
new rows are plausible against the reference numbers in "Current state".
Confirm `pnpm test` and `pnpm exec tsc --noEmit` still pass (they should be
untouched by this plan; run them to prove no accidental damage).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `node --check scripts/perf-startup.mjs` exits 0
- [ ] `pnpm perf:startup` exits 0
- [ ] `grep -c "host-import\|child-first-response" docs/perf/startup.md` ≥ 2
- [ ] `pnpm exec tsc --noEmit` exits 0 and `pnpm test` exits 0 (unchanged by this plan)
- [ ] `git status --short` shows changes only in the three in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `scripts/perf-startup.mjs` no longer matches the structure described in
  "Current state" (someone else already reworked the harness).
- The `get_state` probe never gets a response within 15s on two consecutive
  attempts (the RPC protocol may have changed — do not debug Pi here).
- `child-first-response` measures under 500ms or over 10s consistently —
  the probe is likely measuring the wrong thing; report the raw output.
- A live SumoCode session is running in this project and cannot be stopped.

## Maintenance notes

- Plans 061 and 062 MUST re-run `pnpm perf:startup` and commit the regenerated
  baseline as part of their evidence; their done criteria reference the rows
  this plan adds.
- After 061 lands, `boot-screen-frame` should become meaningfully smaller than
  `app-ready` — if they still coincide post-061, that's a 061 regression, and
  this harness is the tool that catches it.
- The harness stays report-only by design (see the preamble it prints);
  do not turn these numbers into CI gates without maintainer sign-off.
