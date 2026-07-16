import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chooseDiffSplitDirection, type TerminalSize } from "./diff.js";

export const DEFAULT_REVIEW_MODEL = "openai-codex/gpt-5.3-codex";

/** Short aliases → full provider/model ids. */
export const MODEL_ALIASES: Record<string, string> = {
	codex: "openai-codex/gpt-5.3-codex",
	opus: "anthropic/claude-opus-4.6",
	sonnet: "anthropic/claude-sonnet-4.6",
	deepseek: "deepseek/deepseek-v4-pro",
};

export interface ReviewTaskSpawnOptions {
	readonly command: string;
	readonly cwd: string;
	readonly title?: string;
	readonly visible?: boolean;
	readonly direction?: "right" | "down";
	readonly runner?: "shell" | "sumocode";
	readonly model?: string;
	readonly thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	readonly notifyOnExit?: boolean;
}

export interface ReviewTaskHandle {
	readonly id: string;
	readonly pane?: {
		readonly host: "cmux" | "herdr";
		readonly paneId: string;
		readonly workspaceId?: string;
	};
}

export interface ReviewTaskSpawner {
	spawnTask(options: ReviewTaskSpawnOptions): ReviewTaskHandle;
}

export interface RegisterReviewCommandOptions {
	readonly taskSpawner?: ReviewTaskSpawner;
	readonly terminalSize?: () => TerminalSize;
}

function getTerminalSize(): TerminalSize {
	return {
		columns: process.stdout.columns,
		rows: process.stdout.rows,
	};
}

export function resolveReviewModel(env: NodeJS.ProcessEnv = process.env): string {
	return env.SUMOCODE_REVIEW_MODEL?.trim() || DEFAULT_REVIEW_MODEL;
}

/**
 * Split args into an optional model alias (first word) and the remaining scope string.
 *
 *   "codex #42"  → { model: "openai-codex/gpt-5.3-codex", scopeArgs: "#42" }
 *   "#42"        → { model: undefined, scopeArgs: "#42" }
 *   "opus"       → { model: "anthropic/claude-opus-4.6",  scopeArgs: "" }
 *   ""           → { model: undefined, scopeArgs: "" }
 */
export function extractModelAlias(args: string): { model: string | undefined; scopeArgs: string } {
	const trimmed = args.trim();
	const spaceIdx = trimmed.indexOf(" ");
	const firstWord = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
	const alias = MODEL_ALIASES[firstWord];
	if (alias) {
		const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
		return { model: alias, scopeArgs: rest };
	}
	return { model: undefined, scopeArgs: trimmed };
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

export function reviewScopeLabel(scope: ReviewScope): string {
	if (scope.kind === "working-tree") return "branch diff";
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

You are the reviewer running in your own tracked SumoCode background task with model ${model}.
Review only: inspect the requested scope directly, report findings precisely, and stop after one complete review pass. Do not fix code in this child task unless the parent explicitly asks in a later turn.

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

export function registerReviewCommand(pi: ExtensionAPI, options: RegisterReviewCommandOptions = {}): void {
	const terminalSize = options.terminalSize ?? getTerminalSize;
	pi.registerCommand("sumo:review", {
		description: `Run a tracked bg_task diff review. Args: [${Object.keys(MODEL_ALIASES).join("|")}] [scope]. Scope: empty=branch diff, #51=PR, or git range/path`,
		handler: async (args, ctx) => {
			const taskSpawner = options.taskSpawner;
			if (!taskSpawner) {
				notify(ctx, "/sumo:review cannot start: bg_task manager is not available", "warning");
				return;
			}

			const { model: aliasModel, scopeArgs } = extractModelAlias(args ?? "");
			const model = aliasModel ?? resolveReviewModel();
			const prompt = buildReviewPrompt(scopeArgs, model);
			const scope = parseReviewScope(scopeArgs);
			const label = reviewScopeLabel(scope);
			const direction = chooseDiffSplitDirection(terminalSize());
			try {
				const task = taskSpawner.spawnTask({
					command: prompt,
					cwd: ctx.cwd,
					title: `review: ${label} · ${model}`,
					visible: true,
					direction: direction as "right" | "down",
					runner: "sumocode",
					model,
					thinking: "xhigh",
					notifyOnExit: true,
				});
				const paneHint = task.pane ? ` · ${task.pane.host} ${task.pane.paneId}` : "";
				notify(ctx, `review started: ${task.id}${paneHint} · ${model} · ${label}. read: bg_task action=log id=${task.id}; stop: bg_task action=stop id=${task.id}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, `/sumo:review failed to start bg_task: ${message}`, "warning");
			}
		},
	});
}
