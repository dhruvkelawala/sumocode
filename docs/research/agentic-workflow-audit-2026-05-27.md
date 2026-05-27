# Agentic workflow audit: lessons from Theo's current AI coding flow

Date: 2026-05-27

## Source summary

This audit is based on the summarized video in which Theo walks through his current AI coding workflow while building Lakebed. The useful signal for SumoCode is not the specific endorsement of one app, but the operating model:

- Use a capable default model, currently GPT-5.5 in Theo's setup.
- Prefer agent-app workflows over raw terminal/SSH workflows for serious work, especially when remote control, image paste, and thread management matter.
- Keep workflows simple. Avoid over-engineering process around the agent.
- Use fresh threads aggressively when the topic changes. Old context is steering, not neutral memory.
- Prefer short, outcome-oriented prompts over file-by-file micromanagement.
- Let the model explore the codebase and find the right files unless ambiguity actually matters.
- Read the model's prose, plans, logs, and review feedback. The conversation is part of the work, not decoration around the diff.
- Use project guidance files as a letter about philosophy, constraints, terminology, and taste — not as a giant technical rulebook.
- Add a glossary when domain terms are easy to confuse.
- Use concrete examples for complex ideas. Examples beat long abstractions.
- Give agents reliable ways to verify their work: tests, browser checks, CLI commands, deployment smoke tests, or visual evidence.
- Use PRs, review agents, and parallel work selectively. They are review/risk tools, not the default way to make every small change.

## Current SumoCode alignment

SumoCode already has several strong fits with this model:

1. **Model default is already aligned.** `~/.pi/agent/settings.json` uses `openai-codex/gpt-5.5` by default.
2. **App-like runtime is the core product.** SumoCode runs inside cmux and owns the retained terminal UX, rather than treating the terminal as an incidental transport.
3. **Remote/delegated work exists.** `bg_task` can spawn shell work or visible child SumoCode panes, and `sumocode task --prompt-file` gives delegated agents a first-class path.
4. **Verification discipline is strong.** Project instructions require typecheck/build and visual evidence for UI work.
5. **The persona is already relatively concise.** `APPEND_SYSTEM.md` is much smaller than the full project context and contains personal operating agreements.
6. **Fast mode exists.** `/fast` can apply OpenAI/Codex priority service tier to supported models.

## Main gap

The largest gap is prompt and setup entropy.

The effective SumoCode system context includes the persona, project `AGENTS.md`, a long skills registry, many tool descriptions, package guidance, and project-specific visual/testing policy. Much of that is necessary in the moment, but loading it all by default creates the failure mode called out in the video: the agent becomes over-steered by irrelevant process and tool affordances.

The desired SumoCode default should be:

> sharp context, simple workflow, fresh sessions for new topics, philosophy-driven steering, and concrete verification.

Today SumoCode is powerful, but the default setup is closer to a maximalist expert cockpit than a minimal agent workspace.

## Recommendations

### 1. Add an agentic coding philosophy to the Zeus persona

`APPEND_SYSTEM.md` should explicitly teach the model how Dhruv wants AI coding to work. The section should be a short letter, not another checklist.

Suggested text:

```md
## Agentic Coding Philosophy

Keep the workflow simple. Prefer one focused thread, fresh context for new topics, short outcome-oriented prompts, and concrete verification.

Treat Dhruv's prompts as intent, not file-level instructions. Infer the right files from the codebase unless the ambiguity matters.

Read outputs carefully: plans, logs, diffs, review comments, and test failures are part of the conversation. If they contradict the current direction, stop and adjust.

For complex problems, use concrete examples. A small example with real inputs/outputs beats a long abstract explanation.

Do not overuse skills, subprocess agents, or parallel work. Reach for them only when they reduce risk, isolate context, or Dhruv asks.

When a task materially changes topic, prefer a fresh thread/session over carrying stale context forward.
```

Expected effect:

- Less default process theater.
- Better file discovery behavior.
- Fewer unnecessary subagent/skill invocations.
- Stronger bias toward conversation, verification, and fresh context.

### 2. Add a SumoCode glossary to the persona

SumoCode has overloaded terms that models can easily conflate. The persona should define them once.

Suggested text:

```md
## SumoCode Glossary

- Pi: the upstream coding-agent runtime. Owns agent loop, providers, MCP, sessions, tools, skills.
- SumoCode: Dhruv's Pi extension and CLI wrapper. Owns UX, Cathedral UI, task panes, prompt ergonomics.
- SumoTUI: retained renderer inside SumoCode. Use for layout, terminal UI, scroll, modal, mouse, and visual parity work.
- Classic extension API: Pi's `ctx.ui.*` layer. Use only for lightweight classic surfaces.
- cmux: the host terminal app. Do not assume Ghostty windows directly.
- Cathedral: the SumoCode visual/product language.
- Dhruv: the human product owner.
- Zeus: the agent persona implementing and advising.
```

Expected effect:

- Less accidental mixing of Pi vs SumoCode ownership.
- Better architectural decisions when editing retained vs classic UI.
- Less repeated clarification in prompts.

### 3. Replace ceremonial planning pressure with useful approach statements

Current cross-project memory says not to skip plans. That is directionally useful, but can encourage ceremonial planning even for simple work.

Recommended wording:

```md
- For meaningful code changes, state the intended approach and verification briefly before editing.
- Avoid ceremonial plans for trivial edits. Conversation and verified outcomes matter more than process theater.
```

Expected effect:

- Keeps safety for meaningful changes.
- Removes friction for small edits.
- Matches the video's preference for natural back-and-forth over rigid plan mode.

### 4. Introduce setup profiles to reduce default prompt bloat

`settings.json` currently enables a broad package/tool/skill universe by default. That is useful for a power user, but it pushes irrelevant affordances into the model's context.

Introduce profile-oriented setup. Example profile shape:

```json
{
  "profiles": {
    "core": ["sumocode", "pi-cmux", "agent-browser", "github", "summarize", "sem", "commit", "diagnose", "code-review"],
    "design": ["core", "figma", "stitch-kit", "visual-explainer"],
    "infra": ["core", "railway", "github"],
    "planning": ["core", "grill-with-docs", "to-prd", "to-issues", "triage"]
  }
}
```

The exact Pi config mechanism may differ, but the product direction is clear: default to core, opt into specialized capability when the task demands it.

Expected effect:

- Smaller default system prompt.
- Fewer accidental tool temptations.
- Faster model orientation.
- Cleaner mental model for Dhruv.

### 5. Make fresh-topic workflow first-class

The video's strongest operational advice is that old chat history steers the next change. SumoCode should make fresh slices cheap.

Possible command:

```txt
/slice "add server env var deploy support"
```

Behavior options:

- Start a fresh SumoCode session for the same repo.
- Include repo instructions and current model/mode.
- Optionally include a concise handoff generated from the current thread.
- Avoid dragging unrelated history into the new session.

Alternative names: `/fresh`, `/new-slice`, `/thread`.

Expected effect:

- Aligns SumoCode with Codex/T3 Code-style thread workflows.
- Reduces context contamination.
- Encourages sequential, focused work over runaway parallelism.

### 6. Refine delegated task guidance

Current project prompt says the `task` tool should not be used unless it is a skill run or explicitly requested. This prevents runaway delegation, but it is overly blunt.

Recommended guidance:

```md
- Do not delegate by default.
- Use `task`, `subagent`, or visible `bg_task` agents only for independent audits, parallel research, skill-isolated work, review loops, or when Dhruv explicitly asks.
- Avoid parallel implementation for tightly-coupled code changes.
- Prefer one focused main thread for normal feature work.
```

Expected effect:

- Preserves the guardrail.
- Allows high-value delegation for audits/reviews.
- Matches the video's skepticism of excessive parallel work.

### 7. Add mode presets for model/thinking/fast-mode combinations

Current setup has `/fast`, default model settings, and manual thinking selection. That is flexible but not ergonomic.

Add command presets such as:

```txt
/mode quick   -> GPT-5.5, low thinking, fast on
/mode build   -> GPT-5.5, medium thinking, fast on
/mode deep    -> GPT-5.5, high/xhigh thinking, fast optional
/mode review  -> review-tuned model, xhigh thinking
```

Expected effect:

- Keeps the default simple.
- Gives Dhruv fast mode without remembering provider/model details.
- Matches the video's practical switching between low/fast and deeper modes.

### 8. Surface verification as an explicit product primitive

The project already requires verification, but the UI could make it more visible.

Possible improvements:

- Sidebar/footer line for last verifier command and status.
- Final-response reminder when code changed and no verifier ran.
- `sumocode verify` command that reads project hints and runs the recommended verifier.
- Task summary section: `Evidence: pnpm exec tsc --noEmit ✅, pnpm build ✅`.

Expected effect:

- Agents are nudged to prove work before claiming done.
- Dhruv gets faster trust signals.
- Matches the video's emphasis on giving agents the tools to check their own output.

## Proposed issue breakdown

1. [#261](https://github.com/dhruvkelawala/sumocode/issues/261) — Add agentic coding philosophy and glossary to Zeus persona.
2. [#262](https://github.com/dhruvkelawala/sumocode/issues/262) — Design setup profiles to reduce default prompt/tool bloat.
3. [#263](https://github.com/dhruvkelawala/sumocode/issues/263) — Add fresh-slice command for topic changes.
4. [#264](https://github.com/dhruvkelawala/sumocode/issues/264) — Refine task/subagent delegation guidance.
5. [#265](https://github.com/dhruvkelawala/sumocode/issues/265) — Add mode presets for quick/build/deep/review workflows.
6. [#266](https://github.com/dhruvkelawala/sumocode/issues/266) — Surface verification evidence in SumoCode UI and final summaries.

## Recommended sequencing

1. Persona updates first. This has the highest leverage and lowest implementation cost.
2. Delegation guidance next. It reduces accidental workflow complexity immediately.
3. Fresh-slice command. This creates a concrete workflow affordance.
4. Mode presets. Useful once the workflow has a clearer shape.
5. Setup profiles. Larger design surface because it touches config/package loading.
6. Verification UI. Valuable, but should be designed against existing footer/sidebar constraints.

## Non-goals

- Do not remove SumoCode's verification discipline.
- Do not make SumoCode a clone of Codex or T3 Code.
- Do not disable specialized tools globally; make them opt-in or profile-scoped.
- Do not encourage unsupervised parallel implementation by default.
- Do not weaken project-specific safety rules around commits, build verification, visual evidence, or destructive commands.

## Success criteria

- A normal coding session starts with less irrelevant prompt/tool pressure.
- The agent defaults to fresh, focused, outcome-oriented work.
- Dhruv can opt into specialized design/infra/planning capabilities without carrying them everywhere.
- The persona helps the model understand SumoCode's domain language and Dhruv's preferred collaboration style.
- Final answers include clear verification evidence for non-trivial code changes.
