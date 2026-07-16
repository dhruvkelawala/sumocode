# Plan 042: Resolve /resume and /tree selections by stable ids, and fail /tree gracefully

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. SKIP updating
> `plans/README.md` — your reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat 86e5062..HEAD -- src/sumo-tui/rpc/host-actions.ts src/sumo-tui/rpc/session-reader.ts`
> On drift, compare "Current state" excerpts before proceeding; mismatch = STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `86e5062`, 2026-07-07

## Why this matters

`/resume` and `/tree` recover the picked entry via `labels.indexOf(selected)`
on human-readable display labels. Two sessions whose labels collide (labels
truncate timestamps to the minute + short title + message count) resolve to
the FIRST match — the user picks one session and silently switches to another.
For `/tree` it's worse: the UI says "Fork from" one node but sends a different
`entry.id` to Pi. Separately, `/tree` has no graceful path when the current
session file is missing or unreadable: `buildSessionTree` streams the file
with no catch, so the command rejects with a generic RPC error instead of a
warning.

## Current state

- `src/sumo-tui/rpc/host-actions.ts:659-668` (`openResumeSelector`):

```ts
const labels = sessions.map((session) => resumeSessionLabel(session));
const items: InlineSelectorItem[] = sessions.map((session, index) => ({
	value: labels[index]!,
	label: labels[index]!,
	isCurrent: session.path === sessionFile,
}));
const selected = await this.inlineSelectors.select("Resume session", items);
if (!selected) return;
const index = labels.indexOf(selected);
const session = sessions[index];
```

- `src/sumo-tui/rpc/host-actions.ts:700-706` (`openTreeBrowser`):

```ts
const rows = flattenSessionTree(tree);
const labels = rows.map((row) => `${"  ".repeat(row.depth)}Fork from: ${treeNodeSummary(row.node)}`);
const selected = await this.inlineSelectors.select("Session tree (fork from a node)", labels);
if (!selected) return;
const index = labels.indexOf(selected);
const row = rows[index];
```

- `InlineSelectorItem` already supports distinct `value` vs `label` (see the
  resume items above; the selector resolves with the item's `value` —
  confirm in `src/sumo-tui/rpc/inline-selector.ts`, `handleInput`'s confirm
  branch at :165-169 calls `this.done(item?.value)`).
- `/tree`'s selector call passes a raw `string[]` (labels) — the select host
  accepts both forms; converting to items is required for stable values.
- `src/sumo-tui/rpc/host-actions.ts:695` — `const tree = await buildSessionTree(sessionFile);`
  with no try/catch.
- `src/sumo-tui/rpc/session-reader.ts:117-158` — `readSessionInfo` deliberately
  returns `undefined` on unreadable files (`try { statSync } catch { return
  undefined }`, and the whole stream loop wrapped in try/catch, per the doc
  comment "returns `undefined` for a missing header or unreadable file instead
  of throwing").
- `src/sumo-tui/rpc/session-reader.ts:207-217` — `readSessionEntries` (used by
  `buildSessionTree` at :228-230) has NO catch: a missing/unreadable file
  rejects.
- Existing tests: `src/sumo-tui/rpc/host-actions.test.ts` (~:476 resume,
  ~:537 tree — both use distinct labels only) and
  `src/sumo-tui/rpc/session-reader.test.ts` (tree happy paths at ~:104+).
- Conventions: tabs, strict TS, colocated tests, warning notifications via
  `notify(this.notifications, "...", "warning")` — lowercase terse voice
  (see `src/voice.ts` rules: lowercase, no exclamation marks).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install (worktree) | `pnpm install` | exit 0 |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0 |
| Targeted tests | `pnpm vitest run src/sumo-tui/rpc/host-actions.test.ts src/sumo-tui/rpc/session-reader.test.ts` | all pass |

Full `pnpm test` currently exits 1 from a known unrelated flake — not a gate.

## Scope

**In scope**:
- `src/sumo-tui/rpc/host-actions.ts` (only `openResumeSelector`, `openTreeBrowser`)
- `src/sumo-tui/rpc/session-reader.ts` (only `readSessionEntries`/`buildSessionTree` error handling)
- `src/sumo-tui/rpc/host-actions.test.ts`, `src/sumo-tui/rpc/session-reader.test.ts`

**Out of scope**:
- `inline-selector.ts` internals (rendering, filtering).
- Label formatting (`resumeSessionLabel`, `treeNodeSummary`) — labels stay
  exactly as they are; only the VALUE side changes.
- `/resume` performance (a separate plan bounds the scanning).

## Git workflow

- Branch: `advisor/042-stable-session-selector-values`
- Conventional commits (`fix(rpc): ...`). Do NOT push.

## Steps

### Step 1: `/resume` — select by session path

In `openResumeSelector`, set each item's `value` to `session.path` (labels
unchanged), and resolve the selection via
`sessions.find((s) => s.path === selected)`. Delete the `labels.indexOf` line.
Note `isCurrent` already compares paths — no change there.

**Verify**: `pnpm vitest run src/sumo-tui/rpc/host-actions.test.ts` → existing
resume tests pass unchanged (they assert by behavior, not by value shape — if
one asserts the value string equals the label, update it to the path and note
it in your report).

### Step 2: `/tree` — select by entry id

In `openTreeBrowser`, build `InlineSelectorItem[]` with
`value: row.node.entry.id` and `label` = the existing indent + "Fork from"
string; resolve via `rows.find((r) => r.node.entry.id === selected)`. If two
rows carry the same entry id (malformed session), prefer the first and note
that this cannot misfork since the id IS what `fork(entryId)` sends.

**Verify**: targeted host-actions tests pass.

### Step 3: `/tree` — graceful unreadable-file path

Mirror `readSessionInfo`'s philosophy: make `buildSessionTree` return
`undefined` when the file is missing/unreadable (wrap `readSessionEntries`'s
stream in try/catch → `undefined`; keep malformed individual lines skipped as
today via `parseLine`). In `openTreeBrowser`, on `undefined` notify
`"session tree unavailable"` (warning) and return; keep the existing
`tree.length === 0` → `"session has no entries yet"` branch distinct.

**Verify**: `pnpm vitest run src/sumo-tui/rpc/session-reader.test.ts` → pass.

### Step 4: Regression tests

Add:
- host-actions.test.ts: two sessions producing IDENTICAL labels (same
  minute/title/count) — selecting the second entry switches to the SECOND
  session's path (this test must fail on the old `labels.indexOf` code; state
  that check in a comment).
- host-actions.test.ts: `/tree` with two nodes whose summaries collide —
  selecting the second forks from the second node's entry id.
- host-actions.test.ts: `/tree` with a `sessionFile` pointing at a missing
  file — warning notified, no rejection, no fork sent.
- session-reader.test.ts: `buildSessionTree` on a nonexistent path →
  `undefined`; on a file with a valid header and one malformed JSONL line →
  tree still built from the valid entries (existing malformed-line tolerance
  pinned).

**Verify**: both targeted test files exit 0.

## Test plan

Covered by Step 4. Pattern: existing resume/tree tests in
`host-actions.test.ts` (fake controls + fake inline selector host that
resolves a chosen value).

## Done criteria

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm vitest run src/sumo-tui/rpc/host-actions.test.ts src/sumo-tui/rpc/session-reader.test.ts` exits 0
- [ ] `grep -n "labels.indexOf" src/sumo-tui/rpc/host-actions.ts` → no matches
- [ ] Duplicate-label tests exist and pass (resume + tree)
- [ ] `/tree` missing-file test exists and passes
- [ ] `git status` — only the 4 in-scope files changed

## STOP conditions

- The inline selector host does NOT resolve with the item's `value` (i.e. the
  confirm branch resolves labels) — that contradicts "Current state" and the
  fix needs a different seam.
- Entry ids turn out not to be unique per session file in the happy path.
- Any fix requires touching `inline-selector.ts`.

## Maintenance notes

- Anything that adds a new selector flow should pass stable ids in `value` —
  never display strings. Reviewer: check no other `indexOf(selected)` pattern
  exists in host-actions (`grep -n "indexOf(selected)"`).
- Deferred: `/resume` scan cost (separate plan), label enrichment.
