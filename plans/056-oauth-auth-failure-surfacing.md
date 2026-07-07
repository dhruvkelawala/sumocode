# Plan 056: Surface provider auth failures — doctor expiry check + visible RPC run errors

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. SKIP updating
> `plans/README.md` — your reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat advisor/041-optimistic-model-thinking-chrome..HEAD -- bin/sumocode.sh src/sumo-tui/rpc/host.ts src/sumo-tui/transcript/controller.ts`
> Your base branch is `advisor/041-optimistic-model-thinking-chrome`. On
> excerpt mismatch, STOP.

## Status

- **Priority**: P1 (user-reported as "claude-oauth-adapter doesn't work")
- **Effort**: M
- **Risk**: LOW/MED
- **Depends on**: plans/041-optimistic-model-thinking-chrome.md (host.ts overlap)
- **Category**: bug / dx
- **Planned at**: commit `86e5062`, 2026-07-07 (after live diagnosis)

## Why this matters

Diagnosed live 2026-07-07: the user's Anthropic OAuth access token expired
(~19 days prior; `~/.pi/agent/auth.json` `.anthropic.expires` in the past) and
refresh did not recover. Pi 0.79.1 then fails EVERY anthropic run at auth
resolution — stderr says `No API key for provider: anthropic` — before any
provider request is built (verified: the pi-claude-oauth-adapter's
`before_provider_request` hook never fires; the adapter is healthy and
blameless). Two product gaps made this cost the user a debugging session:

1. **The RPC host renders the failure as silence.** A live probe
   (`pi --mode rpc`, prompt sent) produced `agent_start → message_end(user)`
   and then NOTHING visible for 40+ seconds — no assistant message, no error
   box in the transcript stream. The user sees a dead session.
2. **Nothing in SumoCode points at the recovery path** (`pi` → `/login` →
   Claude Pro/Max — not available inside the RPC host; upstream Phase-3 ask).

This plan makes both failures loud and actionable.

## Current state

- `bin/sumocode.sh` — has a `doctor` subcommand (see the `doctor)` case;
  checks Pi binary/RPC host health; look for the existing check style and
  output format `✓ ...` / `✗ ...`). PI_BIN resolution prefers
  `ROOT_DIR/node_modules/.bin/pi` (~line 383).
- `~/.pi/agent/auth.json` (runtime path: `$PI_CODING_AGENT_DIR/auth.json`,
  default `~/.pi/agent`) — per-provider entries; OAuth entries carry
  `access`, `refresh`, `expires` (epoch ms), `type`. NEVER print token
  values; expiry timestamps and key names only.
- RPC error surfacing today: `src/sumo-tui/rpc/host.ts:739-745` — the event
  pump forwards agent events into the transcript pump. What Pi emits over RPC
  when a run aborts at auth resolution is UNVERIFIED — probe evidence shows
  no assistant/error content arrived within 40s; whether a late/error-shaped
  event exists must be established in Step 1.
- Transcript error rendering: `src/sumo-tui/transcript/controller.ts` +
  `view-model.ts` — find how existing error-ish events (e.g. `error`,
  aborted turns) map to blocks today (`grep -n "error" src/sumo-tui/transcript/controller.ts src/sumo-tui/transcript/view-model.ts`).
- Voice: `src/voice.ts` — lowercase, terse, no exclamation marks.
- Conventions: tabs, strict TS, colocated tests; bash 3.2-compatible launcher
  code (macOS default bash).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install (worktree) | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Targeted tests | `pnpm vitest run src/sumo-tui/rpc/host.test.ts src/sumo-tui/transcript/controller.test.ts` | all pass |
| Launcher syntax | `bash -n bin/sumocode.sh` | exit 0 |
| Live repro (read-only) | `printf '{"type":"prompt","id":"p1","message":"hi"}\n' \| node_modules/.bin/pi --mode rpc --no-session` (with a 30s stdin hold) | observe what events arrive on auth failure |

## Scope

**In scope**:
- `bin/sumocode.sh` — doctor auth check only
- `src/sumo-tui/rpc/host.ts`, `src/sumo-tui/rpc/client.ts` (only if Step 1
  shows the error arrives on a channel the host drops)
- `src/sumo-tui/transcript/controller.ts` / `view-model.ts` (only if Step 1
  shows an event kind the transcript drops)
- Colocated tests for whatever changes

**Out of scope**:
- Implementing `/login` in the RPC host (upstream Phase-3 ask — do not fake it).
- The pi-claude-oauth-adapter package (user config repo; not this codebase).
- Reversing the DF-2 setStatus-no-op decision (extension status rendering is
  a separate product decision — report, don't implement).
- Token refresh logic (Pi owns auth).

## Git workflow

- Branch: `advisor/056-oauth-auth-failure-surfacing` off
  `advisor/041-optimistic-model-thinking-chrome`
- Conventional commits (`fix(rpc): ...` / `feat(launcher): ...`). Do NOT push.

## Steps

### Step 1: Establish what Pi emits on an auth-resolution failure (bounded, 30 min max)

Reproduce read-only with the live-repro command (auth.json on this machine is
currently in the failing state — if it is NOT by the time you run, simulate:
run with `PI_CODING_AGENT_DIR` pointed at a temp dir containing a copied
settings.json and an auth.json whose anthropic entry has `expires` in the
past and garbage `access`/`refresh` values — construct the file yourself,
never copy real token values). Record: does Pi emit an `error` event, a
`turn_end` with error payload, a `message` with error content, or nothing?
Also capture Pi's stderr (`No API key for provider: anthropic` appeared
there in diagnosis).

- If an event arrives that the transcript DROPS → Step 2a.
- If NOTHING arrives on stdout and the signal exists only on stderr →
  Step 2b.

### Step 2a: Render the dropped error event

Map the event to a visible transcript error block (follow the existing
error-block pattern found in "Current state" grep) and/or a notification.
The rendered text must include the provider name and the actionable hint:
`anthropic auth failed — run pi directly and /login to re-authenticate`.
Add a controller/pump test feeding the recorded event shape and asserting
the visible block.

### Step 2b: Surface child stderr auth failures

`SumoRpcClient` already buffers child stderr (`client.ts` `stderrBuffer`).
Add a narrow watcher: when a fresh stderr chunk matches
`/No API key for provider: (\w+)/`, fire a host notification (same hint text
as 2a) at most once per provider per run. Wire it in host.ts next to the
existing client wiring. Test with a fake child stderr emission.

(If BOTH channels carry signal, prefer 2a and note 2b as skipped.)

### Step 3: `sumocode doctor` auth expiry check

Add a doctor check `auth`: read `$PI_CODING_AGENT_DIR/auth.json` (default
`~/.pi/agent/auth.json`) with `jq` if available, else a conservative grep;
for each provider entry that has an `expires` number in the past, print
`✗ <provider> oauth token expired <N> days ago — run pi and /login to re-authenticate`;
print `✓ auth: no expired oauth tokens` otherwise; missing/unreadable file →
`- auth: no auth.json (nothing to check)`. NEVER print token values. Match
the doctor section's existing output style.

**Verify**: `bash -n bin/sumocode.sh` → 0; run `bin/sumocode.sh doctor` and
confirm the auth line appears (on this machine it should currently report the
expired anthropic entry, or ✓ if the user has re-logged-in by then — either
is acceptable, say which you saw).

## Test plan

- Step 2a or 2b test as described (event fixture or fake stderr).
- Doctor: no unit harness exists for the launcher — verification is
  `bash -n` + a live `doctor` run pasted into the report.
- Patterns: existing host.test.ts fake-client tests.

## Done criteria

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] Targeted vitest files exit 0
- [ ] Step 1 finding recorded in the report (event shape or stderr-only, with evidence)
- [ ] An anthropic auth failure now produces a VISIBLE artifact in the RPC host (block or notification) with the /login hint — proven by test
- [ ] `bin/sumocode.sh doctor` includes the auth check; `bash -n` passes
- [ ] No token values appear in any code, test fixture, or report
- [ ] `git status` — only in-scope files changed

## STOP conditions

- Step 1 shows Pi emits NOTHING on either channel (stdout events or stderr)
  — then surfacing requires an upstream change; report with evidence.
- The stderr watcher would need to parse anything beyond the single regex
  (scope creep into log parsing).
- Rendering the error requires new block kinds in the shared view-model
  contract (report first — that contract has its own doc).

## Maintenance notes

- When upstream Pi gains an RPC login/auth primitive (Phase-3 ask, plan 035),
  the notification hint should switch from "run pi directly" to the in-app
  flow, and the doctor check stays.
- Reviewer: check the notification fires once per run, not per retry; check
  no secret material can reach the diagnostics trace via the new paths.
