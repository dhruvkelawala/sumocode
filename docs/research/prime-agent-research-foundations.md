# Prime Agent research foundations: defensible ideas for SumoCode

**Status:** adoption-oriented research note  
**Primary-source cutoff:** 2026-08-06  
**Scope:** Recursive Language Models (RLM), Continual Harness, and Prime Agent's official implementation. This report intentionally excludes third-party summaries and treats Prime Intellect's benchmark/blog claims as implementation evidence, not independent scientific validation because Prime Intellect's launch article is also the source of the product benchmarks.[4] (§§ “Evaluating Prime Agent” and “Citation”)

## Executive conclusion

The defensible core is narrower than the marketing language:

1. **Treat large context as addressable data, not as text that must all remain in the root model window.** Give the model stable handles plus programmatic search, slicing, transformation, and selective model calls over those handles. This is the RLM paper's central mechanism, and its depth-0 ablation indicates that externalizing the prompt can help even without recursive calls.[1] (§2, pp. 3–4; §4, pp. 6–7)
2. **Make delegation composable in programs.** Sub-model calls should be callable inside loops, maps, filters, and dependency graphs, with intermediate results retained outside the root context. The paper's expressivity argument depends on *symbolic recursion*, not merely exposing a conventional “spawn subagent” tool.[1] (§2, pp. 3–4)
3. **Keep orchestration policy in a typed host runtime.** Prime Agent's Python surface requests child creation through a typed bridge, while the TypeScript host owns depth checks, model resolution, lifecycle, persistence, and usage attribution.[6] (§§ “Architecture,” “Child Execution,” and “Usage and Cost Attribution”)
4. **Represent reusable harness state explicitly and version it.** Continual Harness's useful abstraction is the decomposition `H = (p, G, K, M)`—supplemental prompt policy, sub-agent specifications, skills, and memory—updated from observed trajectories.[3] (§2.2, pp. 3–4; §3.1–3.2, pp. 4–5)
5. **Adopt refinement only behind evidence, validation, and rollback boundaries.** The Continual Harness paper updates state directly and reports serious failure modes; rollback, immutable base policy, and before/after snapshots are Prime Agent engineering additions, not results established by the paper.[3] (Appendix B.3, pp. 20–21; §6, p. 10)[6] (§ “Continual Harness State”)

**Recommendation:** prototype an RLM-style **context object + bounded orchestration API** first. Add a session-local, reviewable harness ledger second. Do **not** ship autonomous global self-modification, unrestricted recursive spawning, or token-efficiency claims until SumoCode-specific evaluations establish them.[1][3][6]

## 1. What each source actually establishes

| Source | What it establishes | What it does **not** establish |
|---|---|---|
| **Recursive Language Models** | An inference scaffold can place the prompt in a persistent REPL variable, expose only bounded metadata to the root model, and let generated programs recursively invoke models over selected transformations.[1] (§2, pp. 3–4) | It does not prove uniformly lower token use, latency, or cost; results vary by model, task, decomposition, and recursion depth.[1] (§4–5, pp. 6–9) |
| **Continual Harness** | A reset-free loop can update prompt, sub-agent, skill, and memory state from recent trajectory windows; on Pokémon Red/Emerald this sometimes closes part of the gap between a minimal and expert harness.[3] (§3, pp. 4–5; §4.3–4.6, pp. 6–9) | It does not demonstrate general coding-agent improvement, safe autonomous refinement, convergence, or successful bootstrapping below a model capability floor.[3] (§6, p. 10) |
| **Prime Agent official source/docs** | A concrete implementation combines persistent IPython, typed host requests, retained child sessions, session-local harness state, immutable base prompt, snapshots, and rollback.[5][6] (§§ “Core Invariants,” “Host Bridge,” and “Continual Harness State”) | Its product benchmarks and “self-improving” label are not substitutes for a controlled paper establishing causal contribution on coding tasks; Prime Intellect states that no model had been trained around Prime Agent at publication time.[4] (§ “Evaluating Prime Agent”) |

## 2. RLM: theoretical basis and adoptable mechanism

### 2.1 Prompt/context as a variable

For base model `M` with context limit `K`, the RLM initializes a persistent environment `E` containing arbitrary prompt `P` as a variable, then gives the root model constant-size metadata such as length, a short prefix, and access instructions instead of inserting all of `P` into the model history.[1] (§2, p. 3)

Each iteration executes model-generated code, mutates environment state, and returns only bounded metadata about stdout to the root history; completion occurs when the environment's `Final` value is set.[1] (§2 and Algorithm 1, pp. 3–4)

This creates a useful separation between durable external state and the bounded model-visible control context.[1] (§2, pp. 3–4)

- **Durable data plane:** full prompt, files, parsed structures, intermediate values, and child outputs.[1] (§2, pp. 3–4)
- **Bounded control plane:** current objective, handles, small observations, code, and compact execution metadata.[1] (§2, pp. 3–4)

The separation—not Python specifically—is the defensible design principle. The paper's implementation and official source use Python, while the formal requirement is a persistent environment with symbolic handles and callable sub-models.[1] (§2, pp. 3–4)[2] (§ “Overview”)

### 2.2 Recursive LM calls

An RLM sub-call is generated *inside* the program operating on `P`, so the model can map a classifier across all records, query selected chunks, combine partial results, or construct a larger dependency graph without verbalizing every call in the root response.[1] (§2, p. 4)

The paper distinguishes this from a scaffold that separately offers `Exec` and `sub_LLM` actions: if code cannot invoke the sub-model, the agent can verbalize only a small number of delegations and cannot express loops that launch work proportional to the input or pairwise transformations.[1] (Algorithm 2 discussion, p. 4)

“Recursive” does not require unlimited depth. The main experiments evaluate depth 0–3; depth 1 means the root can call ordinary LMs, while deeper variants call RLMs.[1] (§3.2, p. 5) Prime Agent defaults to maximum depth 1 and enforces depth in the host.[6] (§ “Child Execution”)

### 2.3 Programmatic orchestration

The valuable orchestration property is **composition**: search/filter first, batch independent calls, retain typed intermediate results, aggregate deterministically, and ask the root model to inspect only exceptions or summaries. The RLM paper observes probe-then-decompose behavior and reports that decomposition choice materially affects quality.[1] (§5, pp. 8–9)

Prime Agent implements a narrower agent-oriented version: `await rlm(...)` admits an independent child and immediately returns a handle; answers arrive later through explicit messages or files, and the parent-scoped child registry survives kernel restart and compaction.[5] (§2 “Subagents are native RLM calls”)[6] (§§ “Independent Delegation” and “Parent-Scoped Sub-Agent Registry”)

That implementation is relevant to SumoCode, but it is not identical to the paper's synchronous `sub_RLM` function returning values inside arbitrary transformations. SumoCode should preserve both modes conceptually: **value-returning bounded map/reduce calls** for data processing and **retained asynchronous child agents** for long-running work.[1] (§2 and Algorithm 1, pp. 3–4)[5] (§2 “Subagents are native RLM calls”)

### 2.4 What the results support—and their limits

The RLM paper tests long-context retrieval, aggregation, repository understanding, and pairwise reasoning, with prompt lengths from 32K to 11M tokens.[1] (§3.1 and Table 1, pp. 4–6)

Selected results show why adoption is plausible but not automatic:

- On GPT-5 OOLONG, depth-1 RLM scored 56.0 versus 44.0 for the base model, at reported mean API costs of $0.43 versus $0.14.[1] (Table 1, p. 6)
- On GPT-5 OOLONG-Pairs, depth-1 scored 58.0 versus 0.1 for the base model, at $0.33 versus $0.16.[1] (Table 1, p. 6)
- On BrowseComp-Plus (6–11M input tokens), depth-1 averaged $0.99 and scored 91.3; the paper compares that with a linearly extrapolated $1.50–$2.75 merely to ingest the input using GPT-5-mini.[1] (§4 Observation 1, p. 6)
- Depth 0 sometimes wins: Qwen3-Coder depth 0 scored 66.0 on CodeQA, above all its recursive variants, supporting context externalization independently of recursion.[1] (Table 1 and Observation 2, pp. 6–7)
- Greater depth is not monotonic: Qwen3-Coder's deeper recursion performs worse on several tasks, and the paper attributes part of this to syntax errors propagating into sub-RLM calls.[1] (§5, pp. 8–9)

The paper's defensible efficiency claim is **comparable order-of-magnitude API cost on the studied tasks**, not guaranteed token savings. Median RLM runs can be cheaper than base-model runs while mean cost is higher because of expensive failure trajectories; the implementation is sequential and runtimes vary widely.[1] (§4 Observation 4, p. 7)

The paper also reports that a Qwen3-8B RLM fine-tuned on 1,000 filtered trajectories improved by a median 28.3% across four downstream tasks and ran more than 3× faster than its untrained RLM version, but this is a small-scale, scaffold-specific training result—not evidence that an arbitrary frontier model will efficiently use the interface without training.[1] (§4 Observation 6, pp. 7–8; Appendix A, p. 16)

## 3. Continual Harness: theoretical basis and adoptable mechanism

### 3.1 Harness state as an explicit object

Continual Harness models the mutable scaffold as `H = (p, G, K, M)`:

- `p`: system prompt/strategic guidance;
- `G`: specialized sub-agents;
- `K`: textual or executable reusable skills; and
- `M`: persistent facts, strategies, and observations.[3] (§2.2, pp. 3–4)

Every `F` steps after warm-up `W`, a Refiner reads the recent trajectory window, identifies failure signatures, and emits component-specific edits. Prompt state is replaced; sub-agents, skills, and memory receive CRUD-style updates; the environment does not reset.[3] (§3.1, pp. 4–5)

The paper's four refinement passes target concrete signals: prompt changes for identified failures, sub-agent changes for repeated multi-step patterns, skills distilled from successes or repaired after exceptions, and memory additions/updates for gaps or stale knowledge.[3] (§3.2, p. 5)

### 3.2 Durable refinement

“Continual” means that refinement evidence and the environment trajectory persist within a long episode, allowing the system to react to late-stage failures that reset-based optimization would not reach in the same run.[3] (§3.2, p. 5)

This supports a SumoCode design where lessons can survive context compaction and terminal detachment, but durability should be scoped. Prime Agent keeps harness entries session-local by default, stores them in a session artifact ledger, and requires explicit placement for global entries.[6] (§ “Continual Harness State”)

Durability is not the same as correctness. The paper reports a Power Plant route loop where the agent continued for 1,003 turns; after roughly 500 stalled turns it stopped creating tools, suffered schema mismatch, and ignored environmental feedback because it assumed its tool worked.[3] (Appendix B.3, pp. 20–21)

### 3.3 What the experiments support—and their limits

On Pokémon Emerald with Gemini 3.1 Pro, from-scratch Continual Harness reached 100% of monitored milestones at a reported $130 median, versus the minimal harness at 98% and $215; bootstrap variants reached 96–100% at $110–$140.[3] (§4.4 and Figure 6, pp. 7–8)

The effect was capability-dependent. Flash results were high variance, while every Flash-Lite Continual Harness variant reached only 3–13% and underperformed the 20% minimal baseline at comparable or higher cost.[3] (§4.4, p. 7)

The paper does not establish convergence, a comparison against reset-based training on the same task, or an open-source model capable of serving as both refiner/teacher and trainee; those are explicitly left unresolved.[3] (§6, p. 10)

The domain is embodied Pokémon play, with button presses as the primary efficiency measure; translating the result to coding requires a new definition of trajectory evidence, success, regression, and cost.[3] (§4.1, pp. 5–6; Appendix A, p. 14)

## 4. Evidence and rollback boundaries

### 4.1 What comes from the paper

The paper's refinement trigger is trajectory-based: navigation loops, tool-call failures, stalled objectives, missed exploration, successful sequences, exceptions, and stale memory.[3] (§3.2, pp. 4–5) It provides empirical evidence that some evolved navigation skills approach a Dijkstra oracle and continue improving in-loop.[3] (§4.6, p. 9)

However, the method as described applies updates directly as `H_{t+1} = H_t ⊕ Δ`; the paper does not specify transactional application, immutable policy, a canary evaluator, or rollback semantics.[3] (§3.1 and Figure 2, p. 4)

### 4.2 What Prime Agent adds

Prime Agent narrows refinement to small CRUD edits, persists refinement events, records before/after snapshots for rollback, and keeps the base system prompt immutable while treating refinements as supplemental state.[6] (§ “Continual Harness State”)

These are sensible safety boundaries, but they are implementation choices rather than causal findings from the Continual Harness experiments. The Prime Agent blog's further language—“smallest relevant edit,” recorded triggers/outcomes, and rollback by refinement ID—should be treated as a product contract to verify in source and tests, not as a paper-backed performance claim.[4] (§ “Self-Improvement via the Continual Harness”)

### 4.3 Required SumoCode boundary

A SumoCode refiner should produce an **auditable proposal**, not an unreviewed mutation; this adds Prime Agent's snapshot/rollback boundary to the paper's direct-update loop.[3] (§3.1, p. 4)[6] (§ “Continual Harness State”)

```text
observation -> hypothesis -> proposed minimal patch -> validator(s)
            -> canary use -> measured outcome -> promote or roll back
```

Each proposal should record the triggering trajectory references, old/new content hashes, affected scope, evaluator output, author/model, and rollback pointer. This follows the paper's trajectory-conditioned updates while adding the missing transactional boundary identified above.[3] (§3.1–3.2, pp. 4–5)[6] (§ “Continual Harness State”)

The immutable layer must include user instructions, security policy, permission policy, secret-handling rules, and tool capability boundaries. Mutable prompt notes may specialize behavior but must not weaken the immutable layer; this follows Prime Agent's base-prompt boundary rather than the paper, whose `p` is directly rewritten.[3] (§3.1, p. 4)[6] (§ “Continual Harness State”)

## 5. SumoCode integration implications

### 5.1 Existing foundations

SumoCode already separates experience from execution: its foreground RPC host owns rendering/input while Pi owns the agent loop, model providers, sessions, MCP, skills, and tools.[8] (§ “The runtime seam,” lines 111–115) Prime Agent likewise separates clients, supervisor, session workers, kernels, provider calls, and storage, making SumoCode's existing RPC boundary a natural place to add typed context/orchestration requests without embedding a second agent loop.[7] (§§ “System at a Glance” and “Prompt Execution Flow”)

The current sub-agent manager already provides host-enforced capacity (`MAX_RUNNING = 4`), optional isolated worktrees, explicit cancellation, retained snapshots, and a host-observed completion manifest.[9] (lines 13–18, 127–175, 198–248, 354–413) Its manifest distinguishes observable checkout state from child attribution and treats failed status reads as “unknown,” not clean.[10] (lines 73–113)

SumoCode also already has durable, private activity storage with owner checks, restrictive permissions, bounded document sizes, no-follow reads, and atomic file replacement mechanisms.[12] (lines 24–35, 97–112, 160–203, 206–240) Its memory extraction currently observes user and assistant text after `agent_end` and sends it to Remnic asynchronously.[11] (lines 33–43 and 60–81)

These are stronger starting points than replacing SumoCode's runtime with Prime Agent because they already cover the host-side lifecycle, isolation, evidence, persistence, and memory seams needed by the proposed features.[8][9][10]

### 5.2 Proposed architecture

#### A. `ContextObjectStore` — adopt first

Create stable handles for transcript spans, tool outputs, repository snapshots, search results, and child artifacts; this is the SumoCode analogue of placing prompt and intermediates behind symbolic handles.[1] (§2, pp. 3–4) Expose bounded operations rather than raw history dumps so the control context remains bounded.[1] (§2 and Algorithm 1, pp. 3–4)

```ts
context.meta(handle)
context.slice(handle, range)
context.search(handle, query, limit)
context.map(handle, partitioner, modelCall, concurrency)
context.reduce(handles, reducer)
context.materialize(handle, byteLimit)
```

The root context should receive handle metadata and bounded previews, never an automatic dump. This directly implements the RLM paper's symbolic-handle requirement while allowing SumoCode to retain Pi's TypeScript/RPC runtime.[1] (§2, pp. 3–4)[8] (§ “The runtime seam”)

Use content-addressed immutable blobs plus append-only references.[12] (lines 206–240) A handle must resolve to the same bytes throughout a run; mutable resources should create a new version.[1] (§2, pp. 3–4) This recommendation preserves the RLM requirement that the root program manipulate stable external values and fits SumoCode's existing append-only/private persistence direction.[1][12]

#### B. Typed orchestration API — adopt with limits

Expose programmatic composition over existing `SubagentManager`, but keep admission and policy host-side, as Prime Agent does through its typed host request bridge.[6] (§§ “Architecture” and “Child Execution”)

```ts
orchestrate.spawn(spec)
orchestrate.map(items, specFactory, { concurrency, budget })
orchestrate.wait(ids, { timeout })
orchestrate.cancel(ids)
orchestrate.collect(ids, schema)
```

Enforce maximum depth, fan-out, running children, token/cost budget, wall time, model allowlist, and worktree policy in the host. Prime Agent's host bridge and SumoCode's existing capacity/worktree checks provide the defensible precedent.[6] (§§ “Architecture” and “Child Execution”)[9] (lines 13–18, 157–248)

Do not make asynchronous agent messages the only return channel. Retained agents need messaging, but bounded map/reduce jobs should return schema-validated values so programs can deterministically aggregate them; this preserves the RLM paper's symbolic-composition advantage.[1] (§2, p. 4)

#### C. `HarnessLedger` — adopt second, session-local

Represent supplemental state with four typed collections corresponding to `(p, G, K, M)`, plus a refinement-event log. Keep current installed skills and executable code separate from lightweight skill *descriptions* until code is reviewed and packaged; Prime Agent makes the same distinction.[3] (§2.2, pp. 3–4)[5] (§3 “Skills add programmatic capability”)

Default scope should be the current session/repository. Promotion to project or user-global state should require explicit user approval and a diff. The Continual Harness paper does not study cross-project contamination, and Prime Agent itself defaults CRUD changes to local session state.[6] (§ “Continual Harness State”)

#### D. `RefinementProposal` pipeline — do not auto-promote initially

Trigger only from repeatable evidence: the same tool error class, failed verifier after a tactic, repeated child-task shape, demonstrated successful procedure, or user correction.[3] (§3.2, p. 5) One anecdotal model judgment is insufficient because the paper's update loop can propagate false assumptions, schema failures, and feedback blindness.[3] (Appendix B.3, pp. 20–21)

Require validators by component:

| Component | Minimum validation before promotion |
|---|---|
| Prompt note | Replay on a small held-out trajectory set; no policy contradiction |
| Sub-agent spec | At least two successful uses; bounded cost/latency comparison |
| Skill description | Schema check and successful invocation; executable code still requires normal review/tests |
| Memory | Source/provenance, confidence, contradiction check, expiry/scope |

The paper shows that model capability, schema fragility, and false assumptions can reverse gains; therefore validation must be external to the proposal-generating model where practical.[3] (§4.4, p. 7; Appendix B.3, pp. 20–21)

### 5.3 Compaction and context interaction

RLM-style context objects should complement, not remove, Pi compaction. Compaction maintains a small conversational control plane; handles preserve lossless access to source material. Prime Agent similarly keeps automatic compaction while retaining kernel state and child registries.[5] (§4 “State is designed to outlive one turn”)[6] (§ “Parent-Scoped Sub-Agent Registry”)

A compaction summary must preserve live handle IDs, current task graph, validation status, and unresolved evidence.[1][5] It should not copy large handle contents back into the summary, because doing so would collapse the external-data/control-context separation that gives the RLM its effective-context advantage.[1] (§2, pp. 3–4)

## 6. Risks and mitigations

| Risk | Evidence | Required mitigation |
|---|---|---|
| **Runaway cost/fan-out** | RLM cost has long-tail failure trajectories; deeper recursion is not uniformly better.[1] (§4–5, pp. 7–9) | Depth 1 default; concurrency/fan-out/token/time ceilings; parent-visible budget ledger; cancellation. |
| **Bad decomposition compounds** | First decomposition materially affects outcome; syntax errors propagate in deeper recursive calls.[1] (§5, pp. 8–9) | Typed schemas, dry-run plans, small initial samples, fail-fast child admission, bounded retries. |
| **False “token efficiency” claims** | Some reported RLM rows cost more than base calls, and mean can exceed median due to outliers.[1] (Table 1 and Observation 4, pp. 6–7) | Report input/output/cached tokens, child tokens, cost, wall time, and quality separately. |
| **Harness drift / reward hacking** | Prime Agent reports that refinement in Factorio learned cheating after finding an exploit.[4] (§ “A long-horizon case study on games”) | Immutable policy, evaluator independent from mutable harness, adversarial gates, rollback, no self-authored success criterion. |
| **Capability-floor regressions** | Flash-Lite self-refinement underperformed the minimal harness.[3] (§4.4 and §6, pp. 7, 10) | Feature-gate refinement by model/eval; retain static baseline; automatic rollback on regression. |
| **Schema fragility and feedback blindness** | Continual Harness case study reports both during a 1,003-turn loop.[3] (Appendix B.3, pp. 20–21) | Runtime validation, health probes, explicit postcondition checks, stale-loop detector. |
| **Untrusted code execution** | Prime Agent states that its persistent kernel runs with OS permissions and is not a security sandbox.[5] (§ “Trust Model”) | Prefer typed TypeScript operations; isolate generated code; preserve current permission boundary. |
| **Cross-task contamination** | Neither paper establishes safe global promotion of learned state.[1][3] | Session/repo scope by default; provenance and expiry; explicit user promotion. |
| **Attribution ambiguity in shared workspaces** | SumoCode's manifest intentionally refuses to attribute shared-checkout paths to one child.[10] (lines 73–84) | Use worktrees for mutation-capable children; never infer causal success from shared-checkout dirtiness. |

## 7. Evaluation plan before adoption claims

Run a factorial evaluation on SumoCode tasks so context externalization, recursive calls, retained agents, and refinement are measured independently rather than credited as one bundle.[1] (§4 Observation 2, p. 7)[3] (§4.6 and Appendix C, pp. 9, 21–24)

1. **Baseline:** current Pi + SumoCode compaction and subagents.
2. **Context objects only:** no recursive calls.
3. **Context objects + bounded value-returning model map/reduce.**
4. **Context objects + retained child agents.**
5. **Static harness ledger.**
6. **Proposal-only refiner.**
7. **Auto-apply with validator and rollback** only after the prior condition is stable.

Stratify by task density rather than token length alone: sparse retrieval, dense whole-repository aggregation, pairwise comparison, long-running implementation, and repeated operational workflow. The RLM paper shows that effective context depends on how required semantic work scales with input length.[1] (§3, pp. 4–5)

For every run record:

- task success and verifier results;[1][3]
- root and child input/output/cached tokens;[1][6]
- API cost and wall-clock latency;[1]
- depth, fan-out, retries, and failed children;[1][6]
- context bytes inspected versus total available;[1]
- refinement proposals, accepted/rejected updates, rollback rate, and post-update regression;[3][6]
- human intervention and user correction count.[3]

Do not report “self-improvement” unless the same task distribution shows a preregistered, repeatable improvement over the static-harness baseline after accounting for added inference cost. Do not report “token-efficient” unless total billable tokens—including children and refinement—decrease at matched quality; the source papers show capability-dependent regressions and cost outliers that make either label unsafe without matched evaluation.[1] (§4 Observation 4, p. 7)[3] (§4.4 and §6, pp. 7, 10)

## 8. Adoption decision

| Idea | Decision | Rationale |
|---|---|---|
| Prompt/context as stable external objects | **Adopt in prototype** | Strongest RLM mechanism; useful at depth 0; fits SumoCode's RPC seam.[1] (§2 and Observation 2, pp. 3–4, 7)[8] |
| Programmatic, value-returning model calls | **Adopt in prototype** | Preserves symbolic composition missing from ordinary tool-call delegation.[1] (§2, p. 4) |
| Retained asynchronous sub-agents | **Extend existing system** | SumoCode already has bounded workers, worktrees, manifests, and cancellation.[9][10] |
| Unlimited recursion or autonomous swarm | **Reject** | No monotonic depth benefit; higher cost/error propagation risk.[1] (§3.2 and §5, pp. 5, 8–9) |
| Session-local `(p,G,K,M)` ledger | **Adopt after context objects** | Clear state model, provided immutable base policy and typed scope.[3] (§2.2, pp. 3–4)[6] |
| Automatic direct refinement | **Defer** | Paper lacks rollback and reports capability-floor/schema failures.[3] (§4.4, §6, Appendix B.3) |
| Proposal + validator + snapshot rollback | **Adopt experimentally** | Combines trajectory evidence with Prime Agent's engineering boundary.[3] (§3.2, p. 5)[6] |
| Global cross-project self-modification | **Reject by default** | Neither paper evaluates safe global promotion; Prime Agent defaults harness state to session-local scope.[1][3][6] |
| Generic token-efficiency marketing | **Reject** | Results are task/model dependent and have costly outliers.[1] (Table 1 and Observation 4, pp. 6–7) |

## Sources

[1] https://arxiv.org/abs/2512.24601v3
[2] https://github.com/alexzhang13/rlm
[3] https://arxiv.org/abs/2605.09998v1
[4] https://www.primeintellect.ai/blog/prime-agent
[5] https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/docs/rlm.md
[6] https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/docs/rlm-runtime.md
[7] https://github.com/PrimeIntellect-ai/prime-agent/blob/0e0d23391bcd879f1aea70dbda4d07dda7970b34/packages/coding-agent/docs/architecture.md
[8] https://github.com/dhruvkelawala/sumocode/blob/9f70b8e44843daa8ed20921495e168d611014514/README.md
[9] https://github.com/dhruvkelawala/sumocode/blob/9f70b8e44843daa8ed20921495e168d611014514/src/subagents/manager.ts
[10] https://github.com/dhruvkelawala/sumocode/blob/9f70b8e44843daa8ed20921495e168d611014514/src/subagents/manifest.ts
[11] https://github.com/dhruvkelawala/sumocode/blob/9f70b8e44843daa8ed20921495e168d611014514/src/memory-extraction.ts
[12] https://github.com/dhruvkelawala/sumocode/blob/9f70b8e44843daa8ed20921495e168d611014514/src/activity/persistence.ts
