# Worktree fan-out + bg_task hardening — grilling decisions

Branch: `spike/codex-t3code-features`
Date: 2026-05-28
Status: design notes from a grill-me session. Not yet implemented.

Companion to `docs/research/codex-t3code-feature-audit.html` (the Codex/T3 feature
audit). This file records the design decisions reached while grilling the
adoption plan, focused on the P1 worktree loop and the bg_task changes it
depends on.

---

## Context

The audit recommended a P1 "worktree → review → ship" loop. During grilling the
scope expanded: the orchestrator should be able to **fan out N subagents across
N branches** (each in its own git worktree) and reconcile their work. That
ambition exposed real weaknesses in the current `bg_task` implementation, so the
plan now has two layers: harden `bg_task`, then build worktree fan-out on it.

---

## Decisions reached

### D1 — Worktree git state: named branch up front

`/sumo:worktree <task>` creates the worktree on a **named branch** (e.g.
`sumo/<slug>`) from current HEAD — not Codex's detached-HEAD model.

- Rationale: detached HEAD only pays off at Codex's fleet scale (15+ disposable
  worktrees with snapshot/restore). We're not building a fleet manager. A named
  branch makes `/sumo:ship` trivial (already on a branch → push + PR), makes the
  pane label readable, and matches how a human drives one or two worktrees.
- Cost accepted: every worktree leaves a branch behind; git forbids the same
  branch checked out in two worktrees at once (the handoff/branch-lock rule).

### D2 — Fan-out integration: `worktree: true` param on `bg_task` spawn

`bg_task` itself creates the worktree before spawning the child in it, and
**tracks the worktree ref in the task record** (next to the cmux ref), so
stop/cleanup can find it.

- One tool call per subagent: `bg_task spawn runner=sumocode worktree=true …`.
- The worktree create/list/remove logic lives in a shared module that BOTH
  `/sumo:worktree` (interactive, D-future) and `bg_task` (fan-out) call.

### D3 — Worktree teardown: never auto-remove

When a worktree-backed task ends, the **worktree folder is NOT auto-removed**.
It is tracked so it CAN be pruned, but removal is a separate explicit action
(`bg_task clear` with a flag, or a `/sumo:worktree prune` command).

- Rationale: the fan-out's value is the surviving branches the orchestrator
  reconciles. `git worktree remove` deletes the folder; committed branches
  survive in the shared `.git`, but **uncommitted** changes are lost. Auto-remove
  risks silently destroying a subagent's unsaved work.
- Pane close ≠ worktree removal. Disk leak is acceptable; silent data loss is not.
- Commit-gated removal (auto-remove only if HEAD advanced and no uncommitted
  changes) is the PR-grade behavior later — it needs real git-state tests.

### D4 — Completion trigger: real pane/agent EXIT, not first response.md

"Completed" must mean the subagent's **agent loop actually ended**, not "first
`agent_end` / first assistant message written." Today the manager marks a task
`completed` the moment `response.md` appears (first turn), which is wrong for a
multi-turn subagent that keeps working.

- This forces audit finding #4 (manager has no liveness signal for the agent
  child) to the front. Detection mechanism is parked behind D6 below.

### D5 — Pane lifecycle: orchestrator owns keep/close (model A: dead-but-preserved)

The pane/worktree is a **resource the orchestrator owns**. Nothing auto-closes.
The subagent is **single-shot**: it finishes its task, writes its harvest, and
the process exits — but the **cmux pane stays open** as a preserved viewport
showing the final transcript. The orchestrator then wakes, inspects harvest +
diff, and **explicitly decides keep or close** (and separately the worktree's
fate per D3).

- This dissolves the need for elaborate process-exit detection as the
  *completion* trigger: we only need a **wake signal** (subagent idle / harvest
  ready), then the orchestrator drives.
- Re-engaging a finished subagent = spawn a NEW subagent.
- Tiny child change: suppress the current 10s idle auto-close so the pane
  persists after exit.

### The notify gap (must-fix, independent of everything above)

The agent **success** path (`armResponseWatcher`, task-manager.ts ~L431) sets
`status="completed"` and writes meta — then **returns silently**. It never calls
`finalizeTask`, so it never reaches `sendUserMessage` / `fireCmuxNotify`. The
**failure** path (watchdog timeout) DOES notify. So a subagent that *succeeds*
tells the orchestrator nothing; one that *times out* pings it — exactly backwards.

This is the root of "I have to prompt the orchestrator to check." The shell
runner already finalizes through the notify path correctly; the agent success
branch just bypasses the wakeup that's already built. Fixing this is the
concrete first step (route agent success through the notify path).

---

## Sequencing (proposed, not yet ratified)

1. **Spike (this branch):** wire the notify gap + prove orchestrator-owns-close
   ergonomics on top of today's bg_task, accepting reload-fragility. Throwaway.
2. **Hardening PR:** durable registry (read meta.json on startup, reconcile),
   stable IDs (not per-process counter), real liveness (D4 detection), pane
   persistence (D5), GC + log-size cap + concurrency cap.
3. **Worktree PR:** `worktree: true` (D2) + never-auto-remove (D3) on the now
   stable base.

The image features (P3 inline render, P4 editor `[Image 1]` placeholder) are
implementation tasks, not spikes — they go straight to `to-issues`, independent
of this track.

---

## bg_task audit findings (reference)

The grilling was driven by an audit of `src/background-tasks/`. Findings, by tier:

**Tier 1 — architecture gaps (the "half-assed" feel)**

1. **No recovery across reload.** `session_shutdown` with reason ≠ `quit`
   (`/reload`, `/new`, `/resume`, `/fork`) leaves children running but the new
   manager starts empty. `meta.json` is **written but never read back** — recovery
   is an admitted "future feature." After a reload, running tasks are orphaned:
   `list` shows nothing, you can't `log` or `stop` them.
2. **Counter IDs reset to 0 per manager** (`this.counter = 0` in the constructor).
   A fresh `bg-1` collides with an on-disk `bg-1` from before the reload.
3. **"completed" = response.md exists, not "agent done"** (see D4). First
   `agent_end` marks a still-working multi-turn subagent as finished.
4. **Agent child has no pid.** The sumocode child is `exec`'d inside the cmux
   pane; the manager never learns its pid. `stop` = `cmux close-surface` and hope
   SIGHUP lands. No process-level kill, no liveness check.

**Tier 2 — stability/correctness**

5. **Fixed 10-min watchdog, deadline not heartbeat.** A legitimately long agent
   task is marked `failed` at minute 10 even while actively producing tokens.
   Not per-task configurable.
6. **No disk GC.** `$TMPDIR/sumocode-bg/<id>-<ts>/` dirs accumulate forever.
   `clearFinishedTasks` only drops in-memory entries.
7. **Unbounded log growth.** Tail-*reads* are bounded; the log *file* is not. A
   watcher/dev-server writes forever.
8. **No concurrency cap.** Directly blocks safe fan-out: N subagents = N panes
   with no ceiling.

**Tier 3 — polish**

9. Per-task poll timers (500ms shell / 750ms response) — acknowledged "simplest
   reliable" hack.
10. `meta.json` has no schema version, so recovery can't safely evolve the format.
11. Failure reason isn't structured in the task record — only `status` + log tail.

**What "full-featured and stable" means:** make the task store durable and the
manager a **reconciler, not an owner** — read meta.json on startup, rehydrate,
reconcile status from `exit.code` / `response.md` / pane-liveness; stable IDs;
real liveness (pane-exit, not first response.md); lifecycle GC + log cap;
concurrency cap with a queue.

---

## D8 — sequencing: harden bg_task first, then fan-out (both in v0.4)

**Decision:** option A — harden `bg_task` first (PR1), then build `worktree:true`
fan-out on the stable base (PR2). **Both ship in v0.4** (no slipping fan-out).

- PR1 (hardening): durable registry (read meta.json on startup + reconcile),
  stable IDs (not per-process counter), real-exit liveness (D4/D5), GC + log-size
  cap, concurrency cap (D9), and the notify-gap fix.
- PR2 (fan-out): `worktree: true` (D2) + never-auto-remove (D3) on the hardened base.
- Rationale: bolting worktree ownership on today's reload-fragile manager means a
  `/reload` orphans panes AND worktrees and the orchestrator loses the
  branch↔subagent map — the fan-out's whole value evaporates. Durability is a
  prerequisite, not polish. Don't build fan-out on a foundation already known broken.

## D9 — concurrency cap: reject-with-state as cooperative backpressure

**Decision:** option C — reject over-cap spawns, but the rejection is an
**LLM-friendly backpressure signal, not an error**. Lands in PR1.

- Governs the heavy `runner=sumocode` agent panes (conservative default, ~3-4,
  each is a full sumocode process). Shell tasks get a separate/higher limit.
- Over-cap spawn returns a **successful tool result** (NOT a thrown error) with:
  - `status="at_capacity"`
  - plain prose: "this is expected, not a failure — N/N agent slots in use, wait
    for one to finish"
  - the running set (id, title, status, age) so the orchestrator picks intelligently
  - a concrete next-action line: "poll `bg_task log <id>` until one completes,
    then retry this spawn" / "stop the stalest with `bg_task stop <id>` if unneeded"
  - structured `details` mirroring the above for machine parsing
- The slot-free wakeup **reuses the notify-gap fix** so the orchestrator is pinged
  when a slot frees, rather than polling blind.
- A real queue (accept + pending + auto-start on slot-free) is deferred: it couples
  to liveness detection, and a liveness bug would silently stall queued tasks. The
  orchestrator is the natural batch controller given it owns the N branches. Promote
  to a queue only if the reject-loop proves annoying once fan-out is exercised.

## D10 — /sumo:ship: full commit→push→PR, staged + human-gated

**Decision:** option C capability (commit → push → open PR), but **STAGED with
mandatory confirmation before any remote action** — never one-shot.

- Flow: generate commit message + show file summary → **commit locally** (safe,
  reversible) → **STOP, confirm before push** → **confirm before `gh pr create`**
  (title/body pre-filled, optionally open in browser).
- Hard constraint from `AGENTS.md`: never push/merge/PR without explicit approval.
  The one-shot T3 "one-click ship" flow is off the table for SumoCode regardless
  of convenience. Local commit is fine unattended; remote actions are human-gated.
- D1 makes this simple: the worktree is already on a named branch (`sumo/<slug>`),
  so ship just pushes + PRs — no branch creation.
- Reuse `review.ts`'s `gh` patterns.
- **Fan-out:** ship stays a per-branch human-gated action. We do NOT auto-ship N PRs.

## D7 — hunk diff split geometry: aspect-based direction

Separate track from the worktree work, but decided in the same session.

**Problem:** `/sumo:diff` hardcodes a RIGHT split (`openCommandInNewSplit(pi, "right", …)`).
On the Mac mini portrait monitor a right split halves the already-narrow chat
column → diff is unreadable. hunk needs horizontal room for filenames, +/-
gutters, and syntax.

**Decision (option A — pure aspect):**

- **portrait (rows > cols) → split DOWN** (full width preserved, abundant vertical space used)
- **landscape → split RIGHT** (today's behavior, unchanged)
- **`--down` / `--right` flag** overrides either way

**Why aspect, not width:** the user's portrait monitor is >120 cols wide, so a
width threshold (the sidebar policy's `W >= 120` rule) would wrongly pick RIGHT.
The real signal is **orientation** — in portrait, horizontal is the scarce axis
regardless of absolute column count. Confirmed against two screenshots of the
same portrait session: one with SumoCode's registry sidebar open, one with it
closed (cmux list open instead). The user wants DOWN in **both** — proving
sidebar-visibility is the wrong trigger (it would flip to RIGHT when the sidebar
is closed). Orientation alone captures the intent in both scenarios.

**Note on the policy doc:** `SUMO_TUI_PORTRAIT_SIDEBAR_POLICY.md` deliberately
avoids aspect ratio for *sidebar visibility* (uses hard `W >= 120`). That is a
different decision — sidebar column-budget vs. split axis. Using aspect for the
split direction does not contradict the width-first sidebar rule.

**Scope:** keep hunk in its own cmux pane (option A from the framing question);
do NOT build a native in-transcript diff surface in V1 — that fights the doc's
overlay-seam caution and belongs in V2 with its own issue + Bible target +
visual golden.

---

## Parked: Idea B — alive-and-re-promptable subagents

Chosen model is A (dead-but-preserved). **Idea B is explicitly deferred, captured
here so it is not lost.**

In Idea B, a finished subagent's sumocode session **stays running and idle**
rather than exiting. The orchestrator can then:

- **Inject a follow-up prompt** into the running child pane — a true reverse
  handoff INTO the child, continuing on the same branch/context without
  re-establishing state.
- Or **close** it to reclaim resources.

Why it's powerful: persistent steerable workers. The orchestrator keeps a pool
of live subagents on different branches and drives each across multiple turns
(plan → review feedback → revise) without losing the child's in-memory context.

Why it's deferred — Idea B requires real new machinery:

- **Prompt injection into a running child pane** (today the prompt is only the
  one-shot `--prompt-file` kickoff; no channel to send a 2nd message to a live
  child).
- **Per-turn harvest** — `response.md` rewritten on each idle, with versioning so
  the orchestrator reads the latest turn, not the first.
- **Concurrency / memory cap** — N live sumocode processes is real resource cost,
  unlike N preserved-but-dead panes.
- **Liveness semantics** — "idle and waiting" vs "working" vs "exited" become
  three distinct states the manager must track.

Revisit B only once model-A single-shot fan-out proves insufficient in practice.
