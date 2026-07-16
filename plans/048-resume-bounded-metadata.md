# Plan 048: Bound /resume's session scanning (byte-capped reads, capped concurrency)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. SKIP updating
> `plans/README.md` — your reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat advisor/042-stable-session-selector-values..HEAD -- src/sumo-tui/rpc/session-reader.ts src/sumo-tui/rpc/host-actions.ts`
> Your base branch is `advisor/042-stable-session-selector-values`. On
> excerpt mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW/MED
- **Depends on**: plans/042-stable-session-selector-values.md
- **Category**: perf
- **Planned at**: commit `86e5062`, 2026-07-07

## Why this matters

Opening `/resume` synchronously parses EVERY `.jsonl` session file in the
directory to EOF (message counting, latest-activity scan, latest
`session_info` name) before the selector appears — O(all session bytes), with
unbounded parallel read streams (`Promise.all` over every file). Directories
with long sessions produce a noticeable stall and an IO spike. The listing
only needs enough metadata for a selector row.

## Current state

- `src/sumo-tui/rpc/session-reader.ts:117-181` — `readSessionInfo` streams the
  whole file: header, latest `session_info` name, `messageCount += 1` per
  message, `lastActivityTime` max-scan, `firstMessage` (first user text).
  Fallback already exists: `modified` falls back to `stats.mtime` when no
  activity time was found (:164-168).
- `src/sumo-tui/rpc/session-reader.ts:189-201` — `listSessions`:
  `Promise.all(files.map((file) => readSessionInfo(file)))`, then sorts by
  `modified` desc.
- `src/sumo-tui/rpc/host-actions.ts:648-677` — `/resume` awaits
  `listSessions(dirname(sessionFile))`, builds labels via
  `resumeSessionLabel(session)`; after plan 042 the item `value` is
  `session.path`.
- Find `resumeSessionLabel` in `host-actions.ts` (~:319) — the label uses
  name/first-message plus message count.
- The reader is documented as a line-for-line port of Pi's `buildSessionInfo`
  (doc comment :108-116). This plan deliberately diverges for perf; keep the
  doc comment honest about the divergence.
- Tests: `src/sumo-tui/rpc/session-reader.test.ts`,
  `src/sumo-tui/rpc/host-actions.test.ts`. Conventions: tabs, strict TS.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install (worktree) | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Targeted tests | `pnpm vitest run src/sumo-tui/rpc/session-reader.test.ts src/sumo-tui/rpc/host-actions.test.ts` | all pass |

## Scope

**In scope**:
- `src/sumo-tui/rpc/session-reader.ts` (+ test)
- `src/sumo-tui/rpc/host-actions.ts` — ONLY if the label needs a capped-count
  marker (see Step 2); prefer no change.

**Out of scope**:
- `/tree` (`buildSessionTree`) — it reads ONE file and needs full fidelity.
- The selector UI, async row updates, caching across invocations.
- `switchSession` behavior.

## Git workflow

- Branch: `advisor/048-resume-bounded-metadata` off
  `advisor/042-stable-session-selector-values`
- Conventional commits (`perf(rpc): ...`). Do NOT push.

## Steps

### Step 1: Byte-cap `readSessionInfo`

Add an options parameter `readSessionInfo(filePath, { maxBytes = 256 * 1024 } = {})`:
create the read stream with `{ start: 0, end: maxBytes - 1 }`, and track
whether the file is larger than the cap (`stats.size > maxBytes`). When
capped: parse what's in the window (header is line 1 — always present);
`messageCount` becomes a floor; `modified` uses the existing
`stats.mtime` fallback when no in-window activity time was seen; guard the
final partial line (a JSONL line cut mid-byte fails `parseLine` and is
skipped — confirm `parseLine` catches and returns undefined for malformed
JSON; it does per the malformed-line tolerance in the tree tests). Surface
the cap in the returned shape: add `readonly truncatedScan: boolean` to
`SessionListInfo`.

**Verify**: session-reader.test.ts — a fixture file larger than a small test
cap (pass `maxBytes` explicitly, e.g. 512) returns `truncatedScan: true`,
a floor `messageCount`, `modified === mtime`, and the header/first-message
fields from the window; an under-cap file returns `truncatedScan: false` and
identical results to the uncapped behavior (compare against the existing
expectations — do not change them).

### Step 2: Honest labels for capped scans

In `resumeSessionLabel`, when `session.truncatedScan` is true render the
count as `N+` (floor marker). If the label helper lives in
`host-actions.ts`, this is the one permitted change there.

**Verify**: host-actions.test.ts — a truncated session renders an `N+` count
label; untruncated labels unchanged.

### Step 3: Cap listing concurrency

Replace the unbounded `Promise.all` in `listSessions` with a simple
concurrency-limited loop (max 8 in flight — write a small local helper, no
new dependency). Ordering of the RESULT is unchanged (sort by `modified`
happens after).

**Verify**: session-reader.test.ts — with an injected `readSessionInfo` spy
(or by instrumenting via a temp-dir fixture of ~20 files and a wrapped
reader), at most 8 concurrent reads are observed. If injection requires a
test-only parameter, add `listSessions(dir, { concurrency = 8, reader =
readSessionInfo } = {})` — dependency-injection parameters for tests match
the codebase's style (see `readGitBranch(cwd, execFileFn)` in
`src/sumo-tui/rpc/git.ts:18`).

## Test plan

Per steps; use tmpdir fixtures like the existing session-reader tests. Must
include: capped large file, under-cap equivalence, concurrency bound, label
marker.

## Done criteria

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] Targeted vitest files exit 0
- [ ] `grep -n "Promise.all" src/sumo-tui/rpc/session-reader.ts` → no match in `listSessions`
- [ ] Capped-scan test exists and passes; under-cap behavior byte-identical
- [ ] Doc comment updated to note the deliberate divergence from Pi's full scan
- [ ] `git status` — only in-scope files changed

## STOP conditions

- `parseLine` does NOT tolerate a mid-line cut (then the cap needs a
  last-newline trim — implement that only if trivial, else report).
- The label helper turns out to live outside host-actions/session-reader.
- Anything requires selector async updates.

## Maintenance notes

- If session files gain an index/sidecar upstream in Pi, replace the byte cap
  with it and delete `truncatedScan`.
- Reviewer: check the stream `end` option math (inclusive) and that the cap
  default is generous enough that typical sessions are NOT truncated (256KB
  covers the header + early messages comfortably).
