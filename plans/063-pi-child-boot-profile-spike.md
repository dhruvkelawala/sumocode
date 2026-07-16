# Plan 063: Spike — profile the Pi RPC child's ~2.2s boot and produce a grounded upstream ask

> **Executor instructions**: Follow this plan step by step. This is a
> READ-ONLY INVESTIGATION SPIKE: the only deliverable is one markdown
> document (plus the ledger row). You must not modify any source code,
> any file under `node_modules/`, or any config. If anything in the "STOP
> conditions" section occurs, stop and report — do not improvise. When done,
> update the status row for this plan in `plans/README.md` — unless a
> reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0dc25c7..HEAD -- scripts/startup-diagnostics-preload.cjs package.json`
> If the preload script changed, re-read it before relying on the behavior
> described below.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (read-only)
- **Depends on**: none (runs any time; most valuable after 061 lands, when child boot becomes the startup floor)
- **Category**: perf (investigation)
- **Planned at**: commit `0dc25c7`, 2026-07-08

## Why this matters

Measured at `0dc25c7`: `pi --mode rpc` takes ~2200–2800ms from spawn to its
first RPC response, and this cost is **entirely upstream** — it is identical
with and without SumoCode's extension (`-e src/extension.ts`), and
`--offline --no-session` doesn't reduce it. After plan 061, this child boot
is the floor under "time to fully interactive": no SumoCode-side work can
push below it. Before asking the Pi maintainers to optimize (or discovering
a boot phase that a flag can skip), we need to know *what* those 2.2s are:
module graph evaluation? model registry construction? extension/skill
discovery? auth resolution? This spike answers that with instrumentation
that already exists in this repo, and ends with a written, evidence-backed
recommendation — not code.

## Current state

- Pi is `@earendil-works/pi-coding-agent` 0.79.1, pinned. The binary is the
  pnpm shim `node_modules/.bin/pi` → `…/pi-coding-agent/dist/cli.js`;
  interactive/RPC logic lives in `dist/main.js` and `dist/…/rpc-mode.js`.
- `scripts/startup-diagnostics-preload.cjs` — an existing `--require` preload
  that instruments `Module._load`, logging any module taking ≥20ms plus an
  aggregate summary, as JSONL to `SUMO_TUI_DIAG_FILE`. Its activation guard
  (line 7):

  ```js
  const entrypoint = process.argv[1] || "";
  const shouldInstrument = entrypoint.includes("pi-coding-agent") || entrypoint.endsWith("/pi") || entrypoint.endsWith("/pi.js");
  ```

  The pnpm shim resolves argv[1] to a path containing `pi-coding-agent`, so
  the guard passes for a direct `pi` spawn. **Caveat**: `Module._load` only
  sees CJS loads; if Pi's dist is pure ESM, the module log will be sparse and
  the CPU profile (below) becomes the primary tool.
- The RPC readiness probe (same as plans 060/061 use): spawn the child, write
  `{"type":"get_state","id":"probe-1"}\n` to stdin, time until stdout
  contains `probe-1`.
- Reference numbers at `0dc25c7` (warm caches, Apple Silicon):
  bare `pi --mode rpc --offline --no-session`: ~2300–2800ms;
  with `-e src/extension.ts`: ~2230ms (not slower — extension cost is noise);
  `NODE_COMPILE_CACHE` is exported by `bin/sumocode.sh` but NOT by a direct
  spawn — measure its effect explicitly (matrix below).
- Repo convention for research artifacts: `docs/research/<topic>.md`
  (existing examples: `docs/research/pi-rpc-migration.md`,
  `docs/research/rpc-portable-tui-audit.md`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Readiness probe (baseline) | see Step 1 script (written to `/tmp`) | prints ms |
| Module-load trace | `SUMO_TUI_DIAG_FILE=/tmp/pi-boot.jsonl NODE_OPTIONS='--require <abs path to scripts/startup-diagnostics-preload.cjs>' <probe>` | JSONL with `process_module_load_*` events |
| CPU profile | `NODE_OPTIONS='--cpu-prof --cpu-prof-dir=/tmp/pi-prof'` on the probe spawn | `.cpuprofile` in /tmp/pi-prof |
| Repo intact check | `git status --short` | only the new docs file |

Quote `NODE_OPTIONS` paths — the primary dev tree contains a space
(`bin/sumocode.sh` shows the pattern: `--require \"${STARTUP_PRELOAD}\"`).

## Scope

**In scope** (the only files you may create/modify):
- `docs/research/pi-rpc-child-boot-profile.md` (create)
- `plans/README.md` (status row)
- Scratch scripts and outputs under `/tmp` only.

**Out of scope** (hard boundaries):
- ANY file under `node_modules/` — read Pi's dist sources freely, modify
  nothing.
- ANY file under `src/`, `scripts/`, `bin/` — this spike changes no product
  or tooling code. If the preload script needs a tweak to be useful, note
  that in the doc as a follow-up; do not make it.
- Creating GitHub issues — `gh issue create` is NOT authorized. Draft the
  issue text inside the doc; filing it is the maintainer's call.

## Git workflow

- Branch: `advisor/063-pi-child-boot-profile`
- One commit: `docs(research): profile pi rpc child boot`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 0: Safety preconditions

The probes spawn real Pi RPC children in this project directory and have
been observed interfering with a live interactive session.

**Verify**: `ps aux | grep -c "[s]umo-rpc-host"` → `0` (no live session).
Every probe you write MUST: pass `--offline --no-session`, have a 30s
timeout, and `SIGTERM` (then `SIGKILL` after 250ms) its child on every exit
path. After the whole spike: `ps aux | grep -c "[p]i-coding-agent"` → `0`.

### Step 1: Reproduce the baseline

Write the readiness probe to `/tmp/probe-pi-boot.mjs` (spawn
`<root>/node_modules/.bin/pi` with `["--mode","rpc","--offline","--no-session"]`,
cwd = repo root, time to `probe-1` response as described in "Current state").
Run 5 times; record all samples.

**Verify**: median within 1500–4000ms (i.e. the finding still reproduces).
If median < 1000ms, the problem has shrunk since planning — record that
and continue with reduced expectations (the doc is still worth writing).

### Step 2: Boot matrix

Run the probe 3× per configuration and tabulate medians:

| # | Configuration | Isolates |
|---|---|---|
| 1 | bare (`--mode rpc --offline --no-session`) | baseline |
| 2 | \+ `-e <root>/src/extension.ts` | SumoCode extension cost |
| 3 | \+ `--no-extensions` | user-global extension discovery |
| 4 | \+ `NODE_COMPILE_CACHE=<root>/node_modules/.cache/node-compile-cache` | V8 bytecode cache effect |
| 5 | \+ both 3 and 4 | best case |
| 6 | without `--offline` | network/auth resolution cost (run last; if it hangs, kill and record "network-bound") |

### Step 3: Module-load trace

Run configuration 1 with the preload attached (see command table). Then
summarize `/tmp/pi-boot.jsonl`: total module count/ms from
`process_module_load_summary`, and every `process_module_load_slow` entry
(spec + ms), sorted. If the JSONL shows fewer than ~50 loads total, note
"Pi dist is ESM-dominant; Module._load undercounts" and lean on Step 4.

### Step 4: CPU profile

Run configuration 1 with `--cpu-prof` (command table). Analyze the
`.cpuprofile` (write a small `/tmp` aggregation script: sum `timeDeltas` per
`samples[i]`, bucket by `callFrame.url` — group `node_modules/.pnpm/<pkg>`
prefixes and `node:` internals). Report the top ~15 buckets in ms. You are
looking to attribute the ~2.2s across: module evaluation (which packages),
Pi initialization work (which functions/files in `pi-coding-agent/dist`),
and idle/IO gaps (total profile time ≫ sampled CPU time ⇒ note the gap and,
if large, rerun the probe with `strace`-free wall-clock event logging:
timestamps for spawn → first stdout byte → probe response).

### Step 5: Write the deliverable

Create `docs/research/pi-rpc-child-boot-profile.md` with:

1. **Summary** — one paragraph: where the ~2.2s goes, with numbers.
2. **Method** — probe description, exact configurations, machine/date/commit.
3. **Boot matrix table** (Step 2).
4. **Attribution** — module-load table (Step 3) + CPU-profile buckets (Step 4).
5. **Findings** — each with evidence, e.g. "X ms evaluating package Y",
   "`--no-extensions` saves Z ms", "NODE_COMPILE_CACHE saves W ms".
6. **Recommendation** — exactly one of:
   - (a) *Upstream ask*: a ready-to-file issue draft (title, body, numbers,
     reproduction) for `pi-coding-agent` — DRAFT ONLY, do not file;
   - (b) *Host-side mitigation*: a flag/env/config Pi already supports that
     SumoCode's launcher could pass, with measured savings — described as a
     proposed follow-up plan, not implemented;
   - (c) *Not actionable*: the cost is irreducible module evaluation spread
     thinly; say so plainly and recommend closing this line of work.
7. **Non-goals honored** — confirm no code was modified
   (`git status --short` output pasted).

**Verify**: the doc exists, every number in it traces to a command you ran,
and `git status --short` shows only the new doc.

## Test plan

Not applicable (read-only spike; no code changes). The "tests" are the
reproducibility requirements baked into each step's verify line — every
reported number must come from ≥3 samples with median reported.

## Done criteria

ALL must hold:

- [ ] `docs/research/pi-rpc-child-boot-profile.md` exists with all seven sections
- [ ] Boot matrix has medians for all 6 configurations (or a recorded reason a config was skipped)
- [ ] The recommendation is exactly one of (a)/(b)/(c) with evidence
- [ ] `git status --short` shows ONLY the new doc (and the ledger row edit)
- [ ] `ps aux | grep -c "[p]i-coding-agent"` → 0 after the run
- [ ] No GitHub issue was created
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A live SumoCode session is running in this project and cannot be paused
  (Step 0 precondition).
- Any probe leaves a child you cannot kill, or the machine shows Pi
  processes accumulating across runs.
- You feel the need to edit anything under `node_modules/`, `src/`, or
  `scripts/` to get signal — describe the blocker in the doc instead.
- Configuration 6 (no `--offline`) prompts for auth or mutates
  `~/.pi/agent` state — kill it, record "requires auth, skipped", move on.
- The baseline no longer reproduces (median < 1000ms) AND you've already
  recorded that — finish the doc early with recommendation (c).

## Maintenance notes

- If the recommendation is (a), the maintainer files the issue and this
  spike's doc is the evidence attachment; re-measure after any Pi version
  bump (the pin is `~0.79.0` — a minor bump can invalidate everything here).
- If (b), the follow-up plan should be written by the next `/improve plan`
  invocation with this doc as input.
- The boot matrix method (probe + configurations) is reusable for any future
  "why is the child slow" regression — link to this doc from the next
  investigation rather than reinventing it.
