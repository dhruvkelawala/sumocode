# Fan-out coexistence: synthesis workflows vs production worktrees

Date: 2026-06-10  
Milestone: v0.4  
Issue: #279

## Decision

SumoCode uses two fan-out lanes with a hard routing boundary:

- **Synthesis fan-out**: in-memory subagents for research, audits, comparisons, and review synthesis where the output is one answer. The preferred path is the already-installed `pi-subagents` capability; `pi-dynamic-workflows` remains prior art until it is older, stable, and clearly better than `pi-subagents` for this repo.
- **Production fan-out**: visible `bg_task` / cmux panes, optionally with `worktree=true`, for agents that may change files on isolated named branches and produce artifacts that the orchestrator reconciles and ships.

Do **not** express production worktree fan-out as a dynamic workflow script. Worktree fan-out needs visible panes, durable task metadata, cmux lifecycle, branch/worktree tracking, and explicit prune/ship controls. Those are host/runtime concerns, not a model-authored in-memory DAG concern.

## Tool-routing guidance

Use synthesis fan-out (`pi-subagents` / future workflow-like tool) when:

- the task is read-only or advisory;
- the result should be synthesized into one parent answer;
- no branch, pane, or durable process lifecycle is required;
- examples: architecture audit, code review opinions, research, option comparison.

Use production fan-out (`bg_task runner=sumocode visible=true worktree=true`) when:

- a child may edit files or commit work;
- isolation from the parent checkout matters;
- the user needs an inspectable cmux pane;
- the output includes a branch/worktree to reconcile, review, prune, or ship.

## Relationship to pi-dynamic-workflows

`pi-dynamic-workflows` is useful prior art for:

- compact phase/progress copy;
- deterministic script sandboxing;
- explicit structured-output termination;
- model-authored `parallel`/`pipeline` ergonomics.

It is not adopted as a SumoCode dependency in v0.4. If it matures, open a follow-up design issue to compare it against `pi-subagents` as the single synthesis fan-out path.

## Impact on v0.4 production track

No production-track issue changes because of this decision. Issues #273–#276 continue to use SumoCode-local git/cmux/bg_task primitives. The concurrency-cap UX in #271 may reuse the concise progress/backpressure language from workflow tools, but not their execution substrate.
