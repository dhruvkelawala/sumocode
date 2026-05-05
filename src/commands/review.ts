import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export const DEFAULT_REVIEW_MODEL = "deepseek/deepseek-v4-pro";

export function resolveReviewModel(env: NodeJS.ProcessEnv = process.env): string {
	return env.SUMOCODE_REVIEW_MODEL?.trim() || DEFAULT_REVIEW_MODEL;
}

/**
 * Parse the args string into a structured scope descriptor.
 *
 * Supported forms:
 *   (empty)       → working tree + branch fallback
 *   #51           → PR number via `gh pr diff`
 *   51            → PR number via `gh pr diff`
 *   main...HEAD   → explicit git range passthrough
 *   src/foo.ts    → explicit path passthrough
 */
export type ReviewScope =
	| { kind: "working-tree" }
	| { kind: "pr"; number: string }
	| { kind: "explicit"; raw: string };

export function parseReviewScope(args: string): ReviewScope {
	const trimmed = args.trim();
	if (!trimmed) return { kind: "working-tree" };
	const prMatch = /^#?(\d+)$/.exec(trimmed);
	if (prMatch) return { kind: "pr", number: prMatch[1]! };
	return { kind: "explicit", raw: trimmed };
}

function scopeDescription(scope: ReviewScope): string {
	if (scope.kind === "working-tree") return "the current branch diff (working tree changes or branch vs main)";
	if (scope.kind === "pr") return `PR #${scope.number}`;
	return scope.raw;
}

function inspectInstructions(scope: ReviewScope): string {
	if (scope.kind === "pr") {
		return `\
How to inspect:
1. Run \`gh pr diff ${scope.number}\` to get the full PR diff. If that fails, try \`gh pr diff ${scope.number} --repo <owner/repo>\`.
2. Run \`gh pr view ${scope.number}\` to read the PR title and description — this is the intent context.
3. For every changed function/method in the diff, read the full enclosing function body from the file on disk — not just the diff hunk.
4. Read the test files for each changed module.
5. Run \`pnpm exec tsc --noEmit\` to confirm no type errors.
6. Run \`pnpm vitest run <changed test files>\` to confirm tests pass.`;
	}

	if (scope.kind === "explicit") {
		return `\
How to inspect:
1. Run \`git diff ${scope.raw}\` to get the diff for the requested scope.
2. For every changed function/method, read the full enclosing function body from disk — not just the diff hunk.
3. Read the test files for each changed module.
4. Run \`pnpm exec tsc --noEmit\` to confirm no type errors.
5. Run \`pnpm vitest run <changed test files>\` to confirm tests pass.`;
	}

	// working-tree: must not accept empty diff as GREEN
	return `\
How to inspect:
1. Run \`git diff HEAD\` to see uncommitted changes. Also run \`git status\` to find untracked files and read them directly.
2. IMPORTANT: if \`git diff HEAD\` is empty (working tree is clean), do NOT return GREEN — instead run \`git diff origin/main...HEAD\` to get the full branch diff vs main. If that is also empty (already on main with no commits ahead), explicitly state "scope is empty — nothing to review" rather than returning GREEN.
3. For every changed function/method, read the full enclosing function body from disk — not just the diff hunk. Bugs caused by interaction with surrounding code are invisible from hunks alone.
4. Read the test files for each changed module to assess test adequacy.
5. Run \`pnpm exec tsc --noEmit\` to confirm no type errors.
6. Run \`pnpm vitest run <changed test files>\` to confirm tests pass.`;
}

export function buildReviewPrompt(args: string, model = DEFAULT_REVIEW_MODEL): string {
	const scope = parseReviewScope(args);
	const description = scopeDescription(scope);
	const inspect = inspectInstructions(scope);

	return `Run SumoCode diff review for ${description}.

Main-agent protocol:
- Do not perform the final review yourself. Invoke the task tool as a scroll/scribe reviewer with model ${model}.
- Use task type="single" with one task. Pass model="${model}" and thinking="high".
- The scribe must inspect the requested scope directly with git commands and file reads.
- If the scribe returns P0, P1, or P2 findings, fix the issues or ask me before making product-risk changes, then call the review task again.
- Relentlessly repeat review -> fix -> review until the scribe returns a GREEN signal.
- Stop only when there is a GREEN signal or when blocked by missing requirements/permissions.

---

Scribe instructions — read carefully before reviewing:

Project context:
- Language: TypeScript (strict, no emit — jiti runs TS directly)
- Test runner: vitest (pnpm vitest run <file> or pnpm test)
- Type check: pnpm exec tsc --noEmit
- Build check: pnpm build
- Integration tests: pnpm test:integration
- Conventions: tabs, no unused locals/params, colocated tests (foo.ts next to foo.test.ts)

Review scope: ${description}

Your job: find bugs that matter. A false positive is worse than a missed finding — err on the side of precision.

IMPORTANT: You are the reviewer. Do NOT use the task tool or delegate to any sub-agent. Use only bash, read, and write. Perform the entire review yourself in this session.

DO NOT flag any of the following:
- Code style, formatting, naming conventions, whitespace, or import ordering
- Missing comments or documentation
- Refactor opportunities that do not carry direct bug risk
- Speculative "could be an issue if..." concerns — if you can't trace a concrete execution path to a failure, omit it
- Test file structure, test naming, or test verbosity

${inspect}

Regression-contract discipline:
- For each changed code path that replaces or wraps existing behavior, compare the old and new success, failure, and no-op paths from the diff. Preserve old failure semantics unless the PR explicitly says otherwise.
- If a changed call returns a result object such as \`{ success, error }\`, verify the error path is handled before any success notification, persistence write, subscriber event, cache update, or internal state mutation.
- For code that coordinates two state systems (for example external UI/API state plus internal registry/cache state), treat the boundary as transactional: internal state must not advance if the external operation failed.
- Tests are inadequate if they cover only the happy path and unknown-input path while omitting a known-input failure from a mocked dependency.

Reasoning discipline — for every finding you report:
- State the premise: what you observed in the code.
- Trace the concrete execution path that leads to the failure.
- State the conclusion: what breaks, under what condition.
- If you cannot complete this trace, omit the finding.

Severity rubric:
- P0: release blocker. Causes data loss, security/privacy exposure, destructive behavior, unrecoverable crashes on core flows, or breaks build/startup for most users.
- P1: must fix before merge. Causes incorrect behavior, significant regression, broken important workflow, race/leak, stale state, failed error handling, or missing validation likely to affect users. Build failure or test failure is always P1.
- P2: should fix before merge when practical. Risky edge case, incomplete test coverage for changed behavior, confusing failure mode, maintainability issue with plausible bug risk.

GREEN signal criteria:
Return GREEN only when ALL of the following are true:
- No P0/P1/P2 findings remain.
- \`pnpm exec tsc --noEmit\` passes (or was already clean before this change).
- Relevant tests pass.
- You have read the enclosing function for every changed hunk, not just the diff lines.
- Test coverage is adequate for the changed behavior, or any gap is explicitly low-risk and justified.
- The diff was non-empty — if scope was empty, state that explicitly instead of returning GREEN.

Output format:
- First line: one of GREEN, P0, P1, P2 (highest severity found), or EMPTY (scope had no diff to review).
- Findings: one block per issue, ordered by severity. Each block must contain:
  - Severity, File, Line range
  - Premise: what you observed
  - Execution path: the concrete trace to failure
  - Impact: what breaks
  - Fix: concrete recommendation
- Omit any severity level you have no finding for — do not write "No P1 issues found".
- Tests/verification section: what commands you ran and what they returned.
- If GREEN: state every file you read, every command you ran, and why no blocking issues remain.`;
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	process.stdout.write(`${message}\n`);
}

export function registerReviewCommand(pi: ExtensionAPI): void {
	pi.registerCommand("sumo:review", {
		description: "Run scroll/scribe diff review until GREEN. Args: empty=branch diff, #51=PR, or git range/path",
		handler: async (args, ctx) => {
			const model = resolveReviewModel();
			const prompt = buildReviewPrompt(args, model);
			const scope = parseReviewScope(args);
			const label = scope.kind === "pr" ? `PR #${scope.number}` : scope.kind === "explicit" ? scope.raw : "branch diff";
			try {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			} catch {
				pi.sendUserMessage(prompt);
			}
			notify(ctx, `review queued: ${model} · ${label}`);
		},
	});
}
