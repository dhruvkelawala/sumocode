# Spec — Harness evals: tracing, ablation and analytics for SumoCode

> Companion to [plan.mdx](./plan.mdx) (rationale, evidence, rejected alternatives) and the three review files `spec-critique.md`, `spec-critique-2.md`, `spec-critique-3.md`. **This document is the normative contract; where the plan disagrees with it, this wins.**

## Problem Statement

I change SumoCode constantly — the system prompt, which tools exist and how their schemas read, how much of a tool's output the model sees back, when skills are inlined, when subagents get used — and I judge every one of those changes by feel. When a session goes badly I cannot tell whether the model is weak or the harness fed it badly, so I end up changing the harness on superstition.

The evidence to settle this is already on disk. Every session writes a complete, timestamped transcript: every model call, every tool call with its arguments, every result with its failure flag, every token count and cost. Nothing reads it.

Reading it is not enough on its own. Recorded sessions are observational — different work, different days, different models — so they can show what happened and never why. Answering "did this change make the agent better" needs the *same* task run twice with one variable moved, and there is no way to do that today.

There is also no way to hand someone an interesting session, because Pi's `/share` is unreachable from SumoCode.

## Solution

An offline analysis of the transcripts already on disk, plus a way to run one task under two harness configurations and compare the results descriptively.

**Tracing.** A command reads a directory of session transcripts and reports per-session metrics — turns, per-tool failures over eligible outcomes, tokens and recorded cost, compactions, stop reasons — plus *struggle facts*: repeated calls with identical arguments, repeated calls that also failed, failure streaks, compaction pressure. No new instrumentation, because the transcript already exists.

**Ablation.** Behaviours SumoCode genuinely owns get a named variant with a recorded effective configuration. The first is how much of a tool's result reaches the model: a baseline arm with no intervention, and a tighter arm that narrows bulky output **and persists what it removed** so the model can still retrieve it.

**Evaluation.** A fixture is a task with a synthesized seed workspace and trusted deterministic assertions. The runner copies the seed into a run-owned workspace, runs SumoCode headlessly with a run-owned session directory, repeats a few times per arm, and scores what the agent produced — with the run's transcript attached.

**Sharing.** `/share` exports the session to an absolute private temporary path and publishes it as a secret gist, returning a viewer URL. Nothing is sent unless the command is run.

## User Stories

1. As the SumoCode developer, I want to read the transcripts already on disk, so that I use evidence I have already generated without adding instrumentation.
2. As the SumoCode developer, I want one command that summarises a whole corpus, so that I can see my usage and failure profile without scripting it myself.
3. As the SumoCode developer, I want per-tool failure counts alongside the count of eligible outcomes, so that a rate always carries the denominator it came from.
4. As the SumoCode developer, I want the per-tool breakdown labelled a failure rate rather than an error rate, so that I do not mistake a deliberately failing test for a broken tool.
5. As the SumoCode developer, I want recorded cost reported as recorded, so that historical totals are not silently re-priced with today's rates.
6. As the SumoCode developer, I want reasoning tokens shown as a subset of output with the count of turns that reported none, so that a known subtotal is never mistaken for a complete one.
7. As the SumoCode developer, I want cache reads and writes shown with an explicit denominator, so that "cache-read share" means something specific.
8. As the SumoCode developer, I want multi-model sessions attributed per turn, so that one session is not assigned wholly to one model.
9. As the SumoCode developer, I want compactions and stop reasons, so that context loss and abort patterns are visible.
10. As the SumoCode developer, I want sessions where the agent repeated an identical call, so that I can find where it went in circles.
11. As the SumoCode developer, I want legitimate watch-polling excluded by a declared and reported rule, so that waiting on a background task is not reported as being stuck.
12. As the SumoCode developer, I want `--json` to list every suppressed repeat with the rule that suppressed it, so that I can audit the exclusion rather than trust it.
13. As the SumoCode developer, I want repeats that *also failed* distinguished from repeats generally, so that routine repetition is not conflated with being blocked.
14. As the SumoCode developer, I want failure streaks with no intervening success, so that agents that never adapted are findable.
15. As the SumoCode developer, I want to filter by date and by model, so that I can compare a period rather than only total.
16. As the SumoCode developer, I want machine-readable output with a defined shape and version, so that I can compose results with other tools.
17. As the SumoCode developer, I want diagnostics on stderr and data on stdout, so that piping the JSON is not corrupted by notices.
18. As the SumoCode developer, I want defined exit statuses distinguishing success, a partial scan, usage error, failed assertions, and infrastructure failure, so that automation can react correctly.
19. As the SumoCode developer, I want an unparsable line to mark its file partial and keep that file out of the totals, so that a truncated file cannot quietly deflate or inflate a corpus number.
20. As the SumoCode developer, I want an unknown entry type skipped and counted, so that a newer Pi entry does not invalidate a session and does not pass silently either.
21. As the SumoCode developer, I want an orphan result or a call with no result counted in its own bucket, so that joins do not silently discard evidence.
22. As the SumoCode developer, I want a measurement that could not be computed reported as unavailable rather than zero, so that absence is never read as a good result.
23. As the SumoCode developer, I want a forked session's inherited entries excluded from its metrics and reported, so that corpus totals are not inflated by fork ancestry.
24. As the SumoCode developer, I want a session whose parent cannot be read marked for what it is, so that unverifiable inheritance never quietly enters a total.
25. As the SumoCode developer, I want to turn one harness behaviour off and run the same task again, so that an outcome can be attributed to a change I made.
26. As the SumoCode developer, I want both variants to run from the same commit, so that the comparison is not contaminated by other changes.
27. As the SumoCode developer, I want the model held fixed across a harness comparison, so that the result is about the harness.
28. As the SumoCode developer, I want the first ablation to target a behaviour SumoCode actually owns and that reaches the model, so that the experiment measures something.
29. As the SumoCode developer, I want the ablation to leave default behaviour provably unchanged when unset, so that adding it cannot alter existing behaviour.
30. As the SumoCode developer, I want a narrowed tool result to keep a pointer to everything it removed, so that the model never silently loses information it would otherwise have had.
31. As the SumoCode developer, I want each variant to record its effective configuration, so that a result is explainable weeks later.
32. As the SumoCode developer, I want an arm that cannot actually produce its advertised treatment to not exist, so that no result rests on a fabricated comparison.
33. As the SumoCode developer, I want fixtures to hold the task constant, so that different models and harness versions are compared on the same work.
34. As the SumoCode developer, I want each run isolated in a run-owned workspace, so that a run cannot contaminate my working tree.
35. As the SumoCode developer, I want the run's transcript written to a run-owned session directory and read back from there, so that the evidence is the run's own.
36. As the SumoCode developer, I want a run that fails to persist a transcript to fail loudly, so that I never receive a score computed from nothing.
37. As the SumoCode developer, I want a wall-clock and spend ceiling enforced rather than merely reported, so that a looping run is stopped instead of billed.
38. As the SumoCode developer, I want running descendants cleaned up through supervised process groups, so that a stopped run leaves nothing behind.
39. As the SumoCode developer, I want graders to live outside the writable workspace, so that a run cannot edit its own grader and pass.
40. As the SumoCode developer, I want aborted and failed runs retained with an explicit outcome, so that a short cheap-looking arm is visible as aborted rather than mistaken for efficient.
41. As the SumoCode developer, I want weighted assertions with a stated threshold and comparator, so that a fixture can value one outcome above another.
42. As the SumoCode developer, I want assertions on agent behaviour as well as task outcome, so that a run can be scored down for looping even when its tests pass.
43. As the SumoCode developer, I want every score to arrive with the run's full metrics attached, so that "it passed" also tells me what it cost.
44. As the SumoCode developer, I want a small repetition budget, so that a comparison is cheap enough to actually run.
45. As the SumoCode developer, I want each repetition reported individually, so that I can see the spread rather than a mean that hides it.
46. As the SumoCode developer, I want the report to say plainly that it draws no conclusion, so that three to five runs are never dressed up as significance.
47. As the SumoCode developer, I want no automated improved/regressed verdict, so that I am not handed a threshold someone invented.
48. As the SumoCode developer, I want a pass fraction shown as a fraction of runs rather than a percentage, so that n=5 is not misread as a pass rate.
49. As the SumoCode developer, I want harness-latency results kept out of quality tables, so that a speed-up is never mistaken for an improvement.
50. As the SumoCode developer, I want latency measurement explicitly deferred rather than filled with something adjacent, so that I am not shown a number that does not measure what it claims.
51. As the SumoCode developer, I want fixtures mined from sessions that actually struggled, so that my cases are known-hard rather than invented.
52. As the SumoCode developer, I want mined fixtures to use synthesized seed workspaces, so that private or client code can never be published from this public repository.
53. As the SumoCode developer, I want a fixture to record only an opaque source session id and never a path, so that it stays traceable without importing where it ran.
54. As the SumoCode developer, I want a fixture to count only once the baseline reproduces its signal, so that I am not testing the synthesis instead of the harness.
55. As the SumoCode developer, I want fixture provenance checked by a reviewer-controlled checklist rather than a path scan, so that copied material a scan cannot see is still caught.
56. As the SumoCode developer, I want to publish a session as a link, so that I can hand someone a transcript without them cloning anything.
57. As the SumoCode developer, I want the export written to an absolute private temporary path, so that sharing never leaves a transcript in a repository checkout.
58. As the SumoCode developer, I want to be told that the export contains the whole entry tree, the system prompt and the tool schemas, so that I know what I am disclosing before it goes.
59. As the SumoCode developer, I want to be told that a secret gist is unlisted rather than access-controlled, so that I do not overestimate its privacy.
60. As the SumoCode developer, I want each share failure mode handled distinctly, so that a failure never masquerades as success and an ambiguous result is never silently retried into a duplicate.
61. As the SumoCode developer, I want the record vocabulary to be vendor-neutral, so that adopting a hosted viewer later is a configuration change rather than a rewrite.
62. As the SumoCode developer, I want no network sender shipped, so that the "we could export this later" story does not quietly become an outbound integration.
63. As the SumoCode developer, I want tracing, evaluation and reporting to share one analysis, so that an eval report and a corpus report cannot disagree.
64. As the SumoCode developer, I want the analysis kept out of the interactive render path, so that measuring the product does not slow it down.
65. As the SumoCode developer, I want generated reports and records outside the repository, so that this public repo never accumulates my usage state.
66. As the SumoCode developer, I want the existing session reader reused for discovery and headers only, so that its silent-drop parsing cannot hide malformed lines from my totals.
67. As a maintainer reviewing a harness change, I want the same fixture matrix runnable before and after, so that I can decide to ship or revert on evidence.

## Implementation Decisions

- A new **offline analysis layer** owns everything derived from transcripts. It exposes one interface for corpus analysis and one for single-session analysis, and **must not be imported by the interactive host.**
- The **existing session reader** is reused for file discovery, headers and tree structure *only*. Its entry reader silently drops unparseable lines, which contradicts US 19, so **the analysis layer owns its own line parsing**.
- The **eval layer** consumes the analysis interface and does not reimplement transcript parsing.
- A **variant registry** owns the name-to-effective-configuration mapping.
- One **tool-result hook** provides the narrowing transform, installed only under the tighter variant, from the classic extension profile the headless launch path loads.
- The **existing host action surface** gains the share action.

### Ablation

- **First axis: tool-result narrowing.** `baseline` installs no narrowing handler. `tighter` narrows bulky tool results to a declared ceiling **and writes everything it removed to a run-owned overflow file, appending that path to the narrowed result.**
- **There is no "unbounded" arm.** A post-result transform can only narrow; labelled as full while returning already-truncated content it would be a fabricated treatment.
- **The overflow file is SumoCode's, not Pi's.** Pi persists its temporary file only when Pi's own limits truncate, so a handler relying on Pi's escape hatch would destroy results between the ceiling and Pi's limit with no pointer.
- **Invalid configuration fails at startup.** Zero, negative, non-numeric and empty values are rejected rather than falling back.
- **Redaction and Activity display limits are not part of this axis.**
- **The regression test observes the next model call's content** via the persisted tool-result entry in the run's transcript.

### Isolation

- Runs execute in a **run-owned workspace** with a **run-owned session directory**, and the transcript is read from that directory rather than by locating the newest session.
- **This is trusted-workspace isolation, not a security sandbox.** The runner guarantees it cleans up its own temporary artifacts and does not modify the user's session store or working tree. It makes no claim that nothing outside the workspace changed.
- Graders live outside the agent-writable workspace. A grader that cannot execute produces an infrastructure outcome, not an agent failure.
- A wall-clock and a spend ceiling are enforced; exceeding either aborts the run and terminates its supervised process group.
- Teardown authority covers runner-owned temporary paths only.

### Reporting

Reports are **descriptive screening reports**. They show every repetition, the numerator and eligible denominator behind every rate, and pooled figures, and they state that no conclusion is drawn. No noise floor, no effect threshold, no improved/regressed verdict. Unavailable is never rendered as zero.

### Sharing

- Export to an **absolute private temporary path** created by the host, cleaned up on every exit path.
- Disclose before upload: the session header, **every entry on the tree**, the active leaf, the system prompt, and the tool schemas.
- A secret gist is unlisted, not access-controlled, and the user is told so.
- Handle distinctly: `gh` missing, `gh` unauthenticated, non-zero exit, spawn failure, and **exit 0 with no parseable URL**. In that last case no gist id is known, so the raw `gh` output is reported and **no retry is attempted**.
- The uploaded file is `session.html`; the viewer URL is Pi's own share-viewer helper applied to the returned gist id.

## Contracts

### Commands

- `trace --root <dir> [--since <date>] [--model <id>] [--json]`
- `eval --fixture <id> --harness <name>[,<name>] --reps <n> [--json]`

Both are additive to the launcher's existing subcommand dispatch — the pattern `doctor` and `diag` already use, where a name is matched in the launcher's command `case` and delegates to a short script under `scripts/`, following `scripts/diag-summary.mjs` — and change nothing about runtime selection.

- **`--root` resolution**, highest priority first: the flag; `PI_CODING_AGENT_SESSION_DIR`; the agent directory's `sessions/` subdirectory. Session files are `*.jsonl`, discovered **recursively** through the per-project subdirectories Pi creates beneath the sessions root.
- **`--since`** filters on the session header timestamp, inclusive, UTC; a bare date means midnight UTC that day.
- **`--model`** matches per-message model ids exactly, against **either** `model` or `responseModel` when both are present.
- **`--reps`** defaults to 3; below the fixture's `min_reps` it is raised to `min_reps` with a stderr diagnostic; no upper clamp.
- **An unknown `--harness` name fails before any run starts.**

Default output is a short human summary: one row per session with turns, calls, failure rate with its denominator, cost and the struggle facts; a totals row; and a trailing count of skipped files. `--json` is the machine contract and the table is a view of it. Grouping is deliberately not a slice-1 flag.

### Exit statuses

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Assertions failed (eval only) |
| 2 | Usage error — bad arguments, unknown variant, invalid override value |
| 3 | Partial scan — at least one file was unreadable or had unparsable lines, and is therefore excluded from totals |
| 4 | Infrastructure failure |

### JSON shape

A versioned object on stdout, never a stream.

```
{ version: 1, kind, root, sessions[], summary{}, diagnostics{}, suppressed_polling[] }
```

- `kind` is `"trace"` or `"eval"`.
- `version` is the integer `1`; it increments on any breaking change to this shape or to a metric definition.
- Each `sessions[]` element is `{ metrics, struggle, flags }` — the two records below plus a `flags` object carrying `partial`, `inheritance`, and `unknown_entries`.
- `diagnostics` carries `files_discovered`, `files_filtered_out`, `files_unreadable`, `files_partial`, and `skipped[]{ path, reason }`. Counters are scoped **before** filters: `files_discovered` counts every matching file found under the resolved root, so coverage is reproducible regardless of `--since` or `--model`.
- Diagnostics also go to stderr, one `skip <path>: <reason>` line each.

**Unavailable encoding.** A numeric measure that could not be computed is `null`, never `0`. A measure is unavailable when its denominator is zero or when its inputs were partial. `null` and `0` are never conflated.

### Metric field names

`SessionMetrics`: `session_id`, `branch_leaf`, `inherited_entries`, `inheritance_verified`, `started_at`, `assistant_turns`, `tool_calls`, `tool_results_joined`, `orphan_results`, `calls_without_result`, `unknown_entries`, `failures_by_tool`, `eligibles_by_tool`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `reasoning_unreported_turns`, `cost_usd_recorded`, `compactions`, `stop_reasons`, `models_by_turn`, `aux_usage`.

`StruggleFacts`: `session_id`, `repeat_pairs`, `repeat_occurrences`, `longest_repeat`, `repeat_locations[]`, `error_streak_max`, `fail_repeat_pairs`, `compaction_pressure`.

`aux_usage` holds `compaction`, `branch_summary`, `nested_tool` and `orphan_nested_tool`, each with `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `reasoning_unreported_events`, `events_with_usage`, `events_without_usage`, `cost_usd_recorded`.

`HarnessVariant`: `name`, `axis`, `effective_config`, `commit`. `EvalRun`: `run_id`, `fixture_id`, `variant_name`, `model`, `rep`, `session_path`, `outcome`, `assertions[]`. `Fixture`: `id`, `prompt`, `seed_repo`, `assertions[]`, `threshold`, `min_reps`, `source_session_id`, `baseline_signal`.

### Metric definitions

- **`repeat_pairs`** — distinct canonical keys `(tool, args)` occurring **two or more times**, excluding suppressed polling.
- **`repeat_occurrences`** — total occurrences of those keys **beyond the first**. Both are reported so the counting rule in force is visible.
- **`longest_repeat`** — the highest occurrence count of any single non-suppressed key.
- **`fail_repeat_pairs`** — distinct keys with **two or more failed** occurrences. This is the assertion-eligible form; a repeated success is usually routine.
- **`error_streak_max`** — the longest run of consecutive joined results with a failure flag, in the accounted sequence (see the model filter).
- **`compaction_pressure`** — compactions per 100 assistant turns; `null` when turns are zero.
- **`repeat_locations`** — one entry **per occurrence** beyond the first: `{ entry_id, tool, occurrence }`.
- **Canonicalisation** — JSON serialisation with object keys sorted recursively; key order never splits a call's identity.
- **Eligible outcomes** — for each tool, the count of **joined results** for that tool. Orphan results and calls without results appear in neither the numerator nor the denominator; they are reported in their own fields.
- **Cache-read share** — `cache_read_tokens / (input_tokens + cache_read_tokens + cache_write_tokens)`. `null` when the denominator is zero.
- **Reasoning** — a subset of output, never added to it. `reasoning_tokens` sums only the turns that reported a breakdown and is reported alongside `reasoning_unreported_turns`, so a known subtotal is never presented as a complete total.
- **Auxiliary usage** — compaction, branch-summary and nested-tool usage are counted in `aux_usage` and are **never** folded into turn totals.
- **Auxiliary availability** — `usage` is optional on compaction, branch-summary and tool-result entries. Every bucket therefore carries `events_with_usage` and `events_without_usage` and reports **recorded subtotals**: the numeric fields sum what was recorded and are never rendered as complete. A bucket whose `events_with_usage` is zero reports `null` for its numeric fields. `reasoning_tokens` inside a bucket follows the same rule as assistant turns, with `reasoning_unreported_events` alongside, so a known subtotal is never presented as a total.
- **Auxiliary reasoning (mixed)** — a bucket with recorded and unrecorded events reports the recorded sum plus the unrecorded count; it is never `null`, because a partial subtotal with its coverage stated is more useful than discarding what was recorded.
- **`nested_tool` versus `orphan_nested_tool`** — nested-tool usage is attributed through its issuing turn. Usage carried by an **orphan result**, which has no issuing turn to attribute to, is counted in `orphan_nested_tool` and is never folded into `nested_tool`. The two buckets are disjoint, so a model filter cannot inflate a matched model's usage with unattributable tokens.
- **`cost_usd_recorded`** — the sum of recorded per-message cost. Never a re-priced estimate.

### Session accounting, inheritance and the model filter

**Accounted branch.** The path from the session's root entry to its last entry in file order.

**Inheritance.** A session whose header names a parent may contain entries copied from it. Pi copies the parent's non-header entries and records a parent **path**, not a per-entry marker, so inheritance is identified by **entry id present in the resolved parent file**. The parent is looked up at the recorded path; if that path resolves to a file **inside the resolved root** and is readable, inherited ids are excluded from derived metrics and counted in `inherited_entries` with `inheritance_verified: true`.

**A parent with unparsable lines is not an admissible identity source.** A partial parent may be missing the very ids needed to classify the child, and accepting its parseable subset would silently reclassify the child's copied entries as its own — the exact double-count this rule exists to prevent. A partial parent therefore yields `inheritance_verified: false`, on the same footing as a missing, unreadable or out-of-root parent, and the session is excluded from `summary` totals.

If the parent is missing, unreadable, out of root, or partial, the session's metrics are still reported but `inheritance_verified` is `false` and the session is **excluded from `summary` totals**, so unverifiable inheritance can never double-count corpus numbers. Its per-session figures remain visible.

**Model attribution.** Each assistant turn is counted in `models_by_turn` under **`responseModel` when present, otherwise `model`** — the id that actually served the turn, rather than the id that was requested. A turn whose two ids differ contributes to exactly one key, never both.

**Model filter.** With `--model`, the accounted sequence contains **only matching turns**, and matching accepts either id. Turns excluded by the filter are absent from the sequence entirely, so an excluded turn's result neither extends nor breaks a streak — the filtered rate describes the filtered model's behaviour, which is the question being asked. Consequences: compactions and branch summaries carry no model id and are therefore `null` under a model filter; orphan **results** are always reported unfiltered, because they have no issuing turn that could match. Calls without results **do** have an issuing turn and are filtered with it; they are reported unfiltered only in the sense that `calls_without_result` is a diagnostic that is always emitted.

**Zero-match sessions.** A session with no matching turns is **excluded** from `summary.sessions` and counted in `files_filtered_out`. The filter is a session-level inclusion criterion, so a session contributing nothing must not inflate the session count it is contributing nothing to.

### Polling suppression

Rule set version: **`polling-rules@1`**, reported alongside every suppression record so a reader knows which rule produced it.

Excluded outright by name: `terminal_wait`, `terminal_check`, `terminal_list`, `subagent_wait`, `subagent_check`, `subagent_list`.

`terminal_start` is excluded only by **tokenised** match, never by substring. The command string is split on unquoted shell separators (`;`, `&&`, `||`, newline); each segment's first word is its command name; the call is suppressed when any segment's command name is exactly `sleep` and that segment's first argument matches `^[0-9]+(\.[0-9]+)?$`. This suppresses a real `sleep 300` and does not suppress `echo 'sleep 300'` or a mention inside a quoted argument.

**Suppression records** are one row per **key** — `(session_id, tool, args_digest)` — emitted for every suppressed key regardless of count, with `count` equal to the **total occurrences including the first**. `args_digest` is the first 16 hex characters of the SHA-256 of the canonicalised arguments. Rows therefore explain every suppressed occurrence without a separate occurrence stream, and the suppression set is auditable per key.

### Assertions

Types: `shell` (a command exits 0), `git` (the diff touches only declared paths, including deletions and untracked files), `trace` (**a predicate over the run's analysis record** — its metrics and its struggle facts). Each carries a positive numeric weight. The fixture score is the weighted mean of its assertions; the label is pass when **score is greater than or equal to the threshold**.

### Summary aggregation

`summary` is computed from counts, never from averaging per-session rates.

- Additive measures (`assistant_turns`, `tool_calls`, token and cost totals, aux buckets) are **sums**.
- `failures_by_tool` and `eligibles_by_tool` are **summed**, and the summary rate is recomputed from the summed counts — never the mean of per-session rates.
- `repeat_pairs` and `fail_repeat_pairs` are **summed**. De-duplication happens **within a session, never across sessions**: two sessions repeating the same call are two observations of the same habit.
- `compaction_pressure` is recomputed as **`100 * total compactions / total assistant turns`** — the same unit as the per-session measure, so a session reporting `20` contributes to a summary also expressed per hundred turns, not per turn. `null` when total turns are zero.
- `sessions` counts contributed sessions. When any session is excluded from totals — partial file, unverified inheritance — the affected measures carry a `sessions_missing` count so an under-count is visible rather than implied.

### State directory

Records and reports are written under the user's SumoCode state directory, outside the repository, overridable by `SUMOCODE_ANALYTICS_DIR`. Nothing is written into a checkout.

### Declaration

Field names follow the AI telemetry naming conventions where an equivalent exists and a product-namespaced name where one does not. **No convention revision is pinned in this work**; until one is named here, these are this document's own names.

## Testing Decisions

**What makes a good test.** Tests assert externally observable behaviour at the named seams and never on internals or private helpers. The primary acceptance seam is the command — `trace --root <dir> --json` against a temporary corpus — because it is what the user invokes and it covers dispatch, argument handling, discovery, analysis, serialisation and exit status together. Focused arithmetic tests live at the in-process analysis interface. These are hermetic filesystem tests over temporary directories, not pure functions.

**Modules tested.** Command contract, argument validation, each exit status. Accounting, with literal transcripts covering: an unparsable line (file partial, excluded from totals, exit 3); an unknown entry type (skipped, counted, file still contributes); an orphan result; a call with no result; a zero denominator (`null`, not `0`); multiple models in one session; **a turn whose `model` and `responseModel` differ, asserting it lands under exactly one key**; **a session with zero matching turns, asserting it is absent from `summary.sessions` and present in `files_filtered_out`**; a fork with a readable parent (inherited ids excluded); **a fork with a readable-but-partial parent, asserting `inheritance_verified: false` and exclusion from summary totals**; a fork whose parent is missing or outside the root; and a mixture of reported and unreported reasoning. The polling rule: a real `sleep` suppresses, `echo 'sleep 300'` does **not**, `sleep 0.5` suppresses, and every suppressed key appears in `--json` with its rule-set version and occurrence count. **Machine invariants**: an expected digest under recursively reordered argument keys; singleton suppression grouped into one row; occurrence locations beyond the first. The model filter: **an A-fail, B-success, A-fail sequence reports `error_streak_max` of 2 under `--model A`**; compactions are `null`; an unmatched turn's `calls_without_result` is still emitted. **Auxiliary accounting**: each bucket separated from assistant totals; a bucket with no recorded usage reporting `null`; a bucket mixing recorded and unrecorded usage reporting a subtotal with both event counters; mixed auxiliary reasoning; and **an orphan result's nested usage landing in `orphan_nested_tool`, not `nested_tool`**. Summary aggregation: summed counts, per-session de-duplication only, `sessions_missing` when a session is excluded, **an unequal-denominator pooled-rate case**, and **a pressure assertion pinning the explicit `100 *` unit**. The ablation: default byte-identical when unset; next model call verifiably smaller when set, **with a working pointer to the overflow**. Scoring including the `>=` boundary. The runner through an injected whole-agent-run adapter, plus separate coverage of the real adapter's arguments and persistence.

**Full gate** before declaring any slice done, per AGENTS.md: `pnpm exec tsc --noEmit && pnpm build`, the relevant unit suites, `pnpm test`, `pnpm test:integration` for launcher changes, and `pnpm visual:ci` once any visual surface ships. A pinned producer-versus-reader contract test guards against upstream transcript-format drift, which literal fixtures cannot catch alone.

**Explicitly not asserted.** Internal call sequences — but the external process request and environment *are*, since they define the treatment.

**One opt-in acceptance exercise.** A paid sweep and a live share publication are run deliberately and are not substitutes for the deterministic checks.

## Out of Scope

- Any hosted backend, OTLP collector, vendor SDK or database, and **any network sender**, including an inert one.
- Live telemetry during interactive sessions.
- A second transcript format.
- Model ranking or a leaderboard as a deliverable.
- LLM-judge scoring.
- Additional ablation axes. The memory, budget and compaction axes previously listed are **not model-facing knobs** and need seam design before they can be ablated at all.
- The experience and latency track, and any turn-level stall detector, which lack a reproducible measurement contract.
- Crash and error reporting, which is separate work with different data and consent.
- Security sandboxing of agent execution.
- Any change to the launcher's runtime selection, the RPC host, or retained-renderer behaviour.
- A CI gate.

## Further Notes

- **Four premises in earlier drafts were wrong and are corrected here:** the first ablation targeted presentation rather than model-facing output; the run protocol disabled the persistence it depended on; the share path would have written a transcript into the user's checkout; and the tighter arm's escape hatch was asserted rather than built.
- **The corpus figures are historical evidence, not a live oracle.** The session directory is private and mutable, so a correct reader over a changed directory need not reproduce the same totals. Exact reproduction needs a frozen input manifest and fixed accounting definitions; ordinary tests use synthetic inputs.
- **A failure flag is not a defect.** Deliberately failing commands register as failures, and no analysis recovers intent from the transcript.
- **Mining is gated on validation.** Fixtures are authored only once the runner can confirm the baseline reproduces the signal.
- **The plan carries the argument.** Where this document states a decision flatly, the plan has the evidence and the alternatives rejected.
