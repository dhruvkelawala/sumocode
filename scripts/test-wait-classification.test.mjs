/**
 * Retention policy for fixed waits in the timing-sensitive test files audited
 * by Plan 103.
 *
 * A test may still contain a timer when the timer IS the contract (a bounded
 * negative observation, a clock/backoff assertion, a fixture's own delay, or
 * the gap between bounded re-reads). It may not contain a timer that merely
 * stands in for an observable state transition — those wait for the state.
 *
 * Every retained timer in a named file must therefore carry an adjacent
 * `WAIT-CLASS` marker naming which of the four legitimate classes it is and
 * why. Unclassified timers fail; so do unknown class names and empty reasons.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Files Plan 103 audited. New timing-sensitive suites should be added here. */
const CANDIDATE_FILES = [
	"src/sumo-tui/rpc/host-actions.test.ts",
	"test/integration/rpc-session-switch.test.ts",
	"test/integration/rpc-queued-message-undo.test.ts",
	"test/integration/rpc-activity-cards.test.ts",
];

const WAIT_CLASSES = ["negative-observation", "clock-contract", "fixture-delay", "poll-interval"];

const TIMER_FUNCTIONS = new Set(["setTimeout", "setInterval", "setImmediate"]);
const VI_TIMER_METHODS = new Set([
	"advanceTimersByTime",
	"advanceTimersByTimeAsync",
	"advanceTimersToNextTimer",
	"advanceTimersToNextTimerAsync",
	"runAllTimers",
	"runAllTimersAsync",
	"runOnlyPendingTimers",
	"runOnlyPendingTimersAsync",
]);
const SLEEP_HELPERS = new Set(["delay", "sleep", "pause", "wait"]);
const MARKER = /^\s*(?:\*\s*)?WAIT-CLASS:(.*)$/;
const MARKER_BODY = /^\s*([A-Za-z-]+)\s*(?:—|--)\s*(.*)$/;

/**
 * Parse once with TypeScript, then use its AST and comment ranges for both
 * wait detection and marker attribution. This deliberately avoids maintaining
 * a second, incomplete JavaScript/TypeScript lexer in this test.
 *
 * The gate sees direct timer calls, Vitest timer controls, and awaited
 * numeric-literal sleep helpers. Arbitrary indirection remains outside its
 * file-scoped contract.
 *
 * @param {string} source
 * @returns {Array<{ line: number; text: string; problem: string }>}
 */
function findWaitClassificationViolations(source) {
	const sourceFile = ts.createSourceFile("candidate.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const lines = source.split("\n");
	const info = analyzeSource(source, sourceFile);
	const violations = [];
	for (const index of findWaitLineIndexes(sourceFile)) {
		const text = lines[index];
		const marker = findAdjacentMarker(info, index);
		if (marker === undefined) {
			violations.push({ line: index + 1, text: text.trim(), problem: "timer has no adjacent WAIT-CLASS marker" });
			continue;
		}
		const parsed = MARKER_BODY.exec(marker);
		if (!parsed) {
			violations.push({ line: index + 1, text: text.trim(), problem: `WAIT-CLASS marker must read "<class> — <reason>", got "${marker.trim()}"` });
			continue;
		}
		const [, className, reason] = parsed;
		if (!WAIT_CLASSES.includes(className)) {
			violations.push({ line: index + 1, text: text.trim(), problem: `unknown WAIT-CLASS "${className}" (expected one of ${WAIT_CLASSES.join(", ")})` });
			continue;
		}
		if (reason.trim().length === 0) {
			violations.push({ line: index + 1, text: text.trim(), problem: `WAIT-CLASS "${className}" has an empty reason` });
		}
	}
	for (const fragment of findExecutableFixtureTemplateFragments(sourceFile)) {
		for (const violation of findWaitClassificationViolations(fragment.source)) {
			const line = fragment.firstLine + violation.line;
			violations.push({ ...violation, line, text: lines[line - 1]?.trim() ?? violation.text });
		}
	}
	return [...new Map(violations.map((violation) => [violation.line, violation])).values()];
}

/**
 * Templates that flow into `writeFile`/`writeFileSync` are executable fixture
 * source in the audited files. Parse their fragments recursively;
 * interpolation expressions already belong to the outer AST.
 *
 * @param {import("typescript").SourceFile} sourceFile
 * @returns {Array<{ source: string; firstLine: number }>}
 */
function findExecutableFixtureTemplateFragments(sourceFile) {
	const directTemplates = new Set();
	const writtenIdentifiers = new Set();
	const collectWrites = (node) => {
		if (ts.isCallExpression(node) && ["writeFile", "writeFileSync"].includes(staticCalleeName(ts.skipOuterExpressions(node.expression)))) {
			const data = node.arguments[1] === undefined ? undefined : ts.skipOuterExpressions(node.arguments[1]);
			if (data !== undefined && (ts.isNoSubstitutionTemplateLiteral(data) || ts.isTemplateExpression(data))) directTemplates.add(data);
			else if (data !== undefined && ts.isIdentifier(data)) writtenIdentifiers.add(data.text);
		}
		ts.forEachChild(node, collectWrites);
	};
	collectWrites(sourceFile);

	const fragments = [];
	const add = (text, start) => {
		if (text.length > 0) fragments.push({ source: text, firstLine: sourceFile.getLineAndCharacterOfPosition(start).line });
	};
	const visit = (node) => {
		const declaration = node.parent;
		const assignedThenWritten = declaration !== undefined
			&& ts.isVariableDeclaration(declaration)
			&& declaration.initializer === node
			&& ts.isIdentifier(declaration.name)
			&& writtenIdentifiers.has(declaration.name.text);
		if ((directTemplates.has(node) || assignedThenWritten) && ts.isNoSubstitutionTemplateLiteral(node)) {
			add(node.text, node.getStart(sourceFile) + 1);
		} else if ((directTemplates.has(node) || assignedThenWritten) && ts.isTemplateExpression(node)) {
			add(node.head.text, node.head.getStart(sourceFile) + 1);
			for (const span of node.templateSpans) add(span.literal.text, span.literal.getStart(sourceFile) + 1);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return fragments;
}

/**
 * Zero-based lines on which classified wait calls begin. One marker covers all
 * waits on a line, matching the policy's line-oriented diagnostics.
 *
 * @param {import("typescript").SourceFile} sourceFile
 * @returns {number[]}
 */
function findWaitLineIndexes(sourceFile) {
	const indexes = new Set();
	const visit = (node) => {
		if (ts.isCallExpression(node) && isWaitCall(node)) {
			indexes.add(sourceFile.getLineAndCharacterOfPosition(node.expression.getStart(sourceFile)).line);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return [...indexes].sort((left, right) => left - right);
}

/**
 * @param {import("typescript").CallExpression} call
 * @returns {boolean}
 */
function isWaitCall(call) {
	const callee = ts.skipOuterExpressions(call.expression);
	const name = staticCalleeName(callee);
	if (name !== undefined && TIMER_FUNCTIONS.has(name)) return true;
	if (
		name !== undefined
		&& VI_TIMER_METHODS.has(name)
		&& (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
		&& ts.isIdentifier(ts.skipOuterExpressions(callee.expression))
		&& ts.skipOuterExpressions(callee.expression).text === "vi"
	) return true;
	return ts.isIdentifier(callee)
		&& SLEEP_HELPERS.has(callee.text)
		&& call.arguments.length > 0
		&& isNumericLiteralExpression(call.arguments[0]);
}

/**
 * @param {import("typescript").Expression} expression
 * @returns {boolean}
 */
function isNumericLiteralExpression(expression) {
	const unwrapped = ts.skipOuterExpressions(expression);
	if (ts.isNumericLiteral(unwrapped)) return true;
	return ts.isPrefixUnaryExpression(unwrapped)
		&& (unwrapped.operator === ts.SyntaxKind.PlusToken || unwrapped.operator === ts.SyntaxKind.MinusToken)
		&& isNumericLiteralExpression(unwrapped.operand);
}

/**
 * @param {import("typescript").Expression} callee
 * @returns {string | undefined}
 */
function staticCalleeName(callee) {
	if (ts.isIdentifier(callee)) return callee.text;
	if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
	if (ts.isElementAccessExpression(callee) && callee.argumentExpression !== undefined) {
		const argument = ts.skipOuterExpressions(callee.argumentExpression);
		if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return argument.text;
	}
	return undefined;
}

/**
 * Build the small line model needed by the adjacency rule from compiler-owned
 * tokens and comments. Strings, regexes, template text, escapes, type
 * arguments, and `${…}` boundaries are therefore handled by TypeScript.
 *
 * @param {string} source
 * @param {import("typescript").SourceFile} sourceFile
 * @returns {Array<{ comments: string[]; hasCode: boolean; hasComment: boolean }>}
 */
function analyzeSource(source, sourceFile) {
	const info = source.split("\n").map(() => ({ comments: [], hasCode: false, hasComment: false }));
	const seenComments = new Set();

	const recordComment = (range) => {
		const key = `${range.pos}:${range.end}`;
		if (seenComments.has(key)) return;
		seenComments.add(key);
		const firstLine = sourceFile.getLineAndCharacterOfPosition(range.pos).line;
		const rawComment = source.slice(range.pos, range.end);
		const comment = range.kind === ts.SyntaxKind.SingleLineCommentTrivia
			? rawComment.slice(2)
			: rawComment.slice(2, -2);
		for (const [offset, fragment] of comment.split("\n").entries()) {
			const line = firstLine + offset;
			info[line].hasComment = true;
			info[line].comments.push(fragment);
		}
	};

	const visitToken = (node) => {
		const children = node.getChildren(sourceFile);
		if (children.length > 0) {
			for (const child of children) visitToken(child);
			return;
		}

		for (const range of ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []) recordComment(range);
		for (const range of ts.getTrailingCommentRanges(source, node.getEnd()) ?? []) recordComment(range);

		const start = node.getStart(sourceFile);
		const end = node.getEnd();
		if (end <= start || node.kind === ts.SyntaxKind.EndOfFileToken) return;
		const firstLine = sourceFile.getLineAndCharacterOfPosition(start).line;
		const lastLine = sourceFile.getLineAndCharacterOfPosition(end - 1).line;
		for (let line = firstLine; line <= lastLine; line += 1) info[line].hasCode = true;
	};
	visitToken(sourceFile);
	return info;
}

/**
 * A marker may sit in a comment on the wait line itself, or in the contiguous
 * comment-only block directly above it. A blank line or executable code ends
 * the ascent.
 *
 * @param {ReturnType<typeof analyzeSource>} info
 * @param {number} index
 * @returns {string | undefined}
 */
function findAdjacentMarker(info, index) {
	for (let cursor = index; cursor >= 0; cursor -= 1) {
		if (cursor !== index && (info[cursor].hasCode || !info[cursor].hasComment)) return undefined;
		for (const comment of info[cursor].comments) {
			const marker = MARKER.exec(comment);
			if (marker) return marker[1];
		}
	}
	return undefined;
}

describe("test wait classification", () => {
	it.each(CANDIDATE_FILES)("%s classifies every retained timer", async (relativePath) => {
		const source = await readFile(join(REPO_ROOT, relativePath), "utf8");
		const violations = findWaitClassificationViolations(source);
		expect(violations, formatViolations(relativePath, violations)).toEqual([]);
	});

	it("rejects a bare timer", () => {
		expect(findWaitClassificationViolations("await new Promise((r) => setTimeout(r, 300));")).toEqual([
			{ line: 1, text: "await new Promise((r) => setTimeout(r, 300));", problem: "timer has no adjacent WAIT-CLASS marker" },
		]);
	});

	it.each([
		"await new Promise((r) => setImmediate(r));",
		"globalThis.setTimeout(run, 5000);",
		'globalThis["setTimeout"](run, 5000);',
		"timers.setInterval(run, 5000);",
		"vi.advanceTimersToNextTimer();",
		"await vi.advanceTimersToNextTimerAsync();",
		"vi.runAllTimers();",
		"await vi.runAllTimersAsync();",
		"vi.runOnlyPendingTimers();",
		"await vi.runOnlyPendingTimersAsync();",
		"const handle = setInterval(tick, 10);",
	])("rejects the unclassified fake-timer wait %s", (source) => {
		expect(findWaitClassificationViolations(source)[0]?.problem).toBe("timer has no adjacent WAIT-CLASS marker");
	});

	it.each([
		"await delay(100);",
		"await sleep(50);",
		"await pause(1_000);",
		"await delay((5000));",
		"await sleep(5000 as const);",
		"export {}; await (delay(5000));",
		"await delay(5000).then(done);",
		"await Promise.all([delay(5000)]);",
		"delay(5000);",
		"await delay(+5000);",
		"await pause(-5000);",
	])("rejects the unclassified sleep-helper call %s", (source) => {
		expect(findWaitClassificationViolations(source)[0]?.problem).toBe("timer has no adjacent WAIT-CLASS marker");
	});

	it("does not flag predicate-driven waiters that merely take an interval", () => {
		const source = [
			"await vi.waitFor(() => expect(rows).toHaveLength(2), { timeout: 500, interval: 1 });",
			"await app.waitForOutput('ready', 5_000);",
			"await waitForScreen(app, ({ text }) => text.includes('READY'), { timeoutMs: 5_000 });",
			"await waitForPromptMessages(logPath, ['prompt A']);",
			"await delay(remainingMs);",
		].join("\n");
		expect(findWaitClassificationViolations(source)).toEqual([]);
	});

	it("rejects an unknown class name", () => {
		const source = "// WAIT-CLASS: vibes — it feels right\nawait new Promise((r) => setTimeout(r, 300));";
		expect(findWaitClassificationViolations(source)[0]?.problem).toBe(
			`unknown WAIT-CLASS "vibes" (expected one of ${WAIT_CLASSES.join(", ")})`,
		);
	});

	it.each([
		["a line comment", "// WAIT-CLASS: fixture-delay — \nawait new Promise((r) => setTimeout(r, 300));"],
		["a block comment", "/* WAIT-CLASS: fixture-delay — */\nawait new Promise((r) => setTimeout(r, 300));"],
		["one of two block comments", "/* WAIT-CLASS: fixture-delay — */ /* unrelated note */\nawait new Promise((r) => setTimeout(r, 300));"],
	])("rejects an empty reason in %s", (_label, source) => {
		expect(findWaitClassificationViolations(source)[0]?.problem).toBe('WAIT-CLASS "fixture-delay" has an empty reason');
	});

	it.each([
		['await new Promise((r) => setTimeout(r, 300)); const note = "WAIT-CLASS: fixture-delay — held open";', "on the timer line"],
		['const note = "WAIT-CLASS: fixture-delay — held open";\nawait new Promise((r) => setTimeout(r, 300));', "on the line above"],
		["const note = `WAIT-CLASS: poll-interval — held open`;\nawait new Promise((r) => setTimeout(r, 300));", "in a template literal"],
	])("rejects a marker embedded in executable code (%#)", (source) => {
		expect(findWaitClassificationViolations(source).at(-1)?.problem).toBe("timer has no adjacent WAIT-CLASS marker");
	});

	it.each([
		["identifier and paren split", "setTimeout\n(() => resolve(), 300);"],
		["call on its own line", "await new Promise((resolve) =>\n\tsetTimeout(resolve, 300),\n);"],
		["sleep helper split", "await delay\n(50);"],
		["fake timer split", "vi.advanceTimersByTime\n(1000);"],
		["comment before the paren", "setTimeout /* explanatory comment */ (run, 5000);"],
		["comments around type arguments", "await delay /* typed */ <number> /* fixed */ (5000);"],
	])("rejects an unclassified timer split across tokens: %s", (_label, source) => {
		expect(findWaitClassificationViolations(source)[0]?.problem).toBe("timer has no adjacent WAIT-CLASS marker");
	});

	it.each([
		["a call with a trailing marker comment", 'doThing(); // WAIT-CLASS: fixture-delay — reason\nawait new Promise((r) => setTimeout(r, 300));'],
		["an assignment with a trailing marker comment", "const x = 1; /* WAIT-CLASS: poll-interval — reason */\nawait new Promise((r) => setTimeout(r, 300));"],
		["a block comment followed by a call", "/* WAIT-CLASS: fixture-delay — reason */ doThing();\nawait new Promise((r) => setTimeout(r, 300));"],
		["a block-comment close followed by a call", "/*\n * WAIT-CLASS: fixture-delay — reason\n */ doThing();\nawait new Promise((r) => setTimeout(r, 300));"],
	])("rejects a marker sharing a line with executable code above the timer: %s", (_label, source) => {
		expect(findWaitClassificationViolations(source).at(-1)?.problem).toBe("timer has no adjacent WAIT-CLASS marker");
	});

	it.each([
		["a one-line block comment", "/* WAIT-CLASS: fixture-delay — reason */\nawait new Promise((r) => setTimeout(r, 300));"],
		["a multi-line block comment", "/*\n * WAIT-CLASS: poll-interval — reason\n */\nawait new Promise((r) => setTimeout(r, 300));"],
	])("accepts a wholly-comment block above the timer: %s", (_label, source) => {
		expect(findWaitClassificationViolations(source)).toEqual([]);
	});

	it("reports a split timer on the line holding its identifier", () => {
		expect(findWaitClassificationViolations("const a = 1;\nsetTimeout\n(() => resolve(), 300);")).toEqual([
			{ line: 2, text: "setTimeout", problem: "timer has no adjacent WAIT-CLASS marker" },
		]);
	});

	it("accepts a split timer whose marker sits above its identifier", () => {
		const source = "// WAIT-CLASS: fixture-delay — the fake provider holds the turn open\nsetTimeout\n(() => resolve(), 300);";
		expect(findWaitClassificationViolations(source)).toEqual([]);
	});

	it("reports one violation per line, however many timers that line holds", () => {
		expect(findWaitClassificationViolations("setTimeout(a, 1); setTimeout(b, 2);")).toHaveLength(1);
	});

	it.each([
		["a string after a closing block comment", 'await new Promise((r) => setTimeout(r, 50)); /* note */ const s = "WAIT-CLASS: fixture-delay — reason";'],
		["a string after a closing block comment, line above", '/* note */ const s = "WAIT-CLASS: fixture-delay — reason";\nawait new Promise((r) => setTimeout(r, 50));'],
		["a marker in a string with a comment elsewhere on the line", 'const s = "WAIT-CLASS: poll-interval — reason"; // unrelated note\nawait new Promise((r) => setTimeout(r, 50));'],
	])("rejects a marker that is string content, not comment text: %s", (_label, source) => {
		expect(findWaitClassificationViolations(source).at(-1)?.problem).toBe("timer has no adjacent WAIT-CLASS marker");
	});

	it.each([
		["a character class holding slashes", 'const re = /[//] WAIT-CLASS: fixture-delay — bogus/; setTimeout(run, 50);'],
		["a regex on the line above", 'const re = /[//] WAIT-CLASS: fixture-delay — bogus/;\nawait new Promise((r) => setTimeout(r, 50));'],
		["a regex holding a block-comment open", 'const re = /a[/*] WAIT-CLASS: poll-interval — bogus/; setTimeout(run, 50);'],
		["a regex holding an unbalanced quote", "const re = /it's/; setTimeout(run, 50);"],
	])("rejects a marker that is regex content, not comment text: %s", (_label, source) => {
		expect(findWaitClassificationViolations(source).at(-1)?.problem).toBe("timer has no adjacent WAIT-CLASS marker");
	});

	it("still reads a real comment on a line that also holds a regex", () => {
		const source = "const re = /[//]/; setTimeout(run, 50); // WAIT-CLASS: fixture-delay — the fake child's own delay";
		expect(findWaitClassificationViolations(source)).toEqual([]);
	});

	it("treats a slash after a value as division, not a regex", () => {
		const source = "const half = total / 2; // WAIT-CLASS: poll-interval — bounded re-read gap\nawait new Promise((r) => setTimeout(r, 50));";
		expect(findWaitClassificationViolations(source)[0]?.problem).toBe("timer has no adjacent WAIT-CLASS marker");
	});

	it("keeps comment attribution aligned across an escaped newline in a string", () => {
		// A line continuation inside a string used to be skipped without counting
		// the newline, shifting every later line's comment text by one and losing
		// this marker.
		const source = [
			'const s = "a\\',
			'b";',
			"// WAIT-CLASS: fixture-delay — the fake provider holds the turn open",
			"await new Promise((r) => setTimeout(r, 300));",
		].join("\n");
		expect(findWaitClassificationViolations(source)).toEqual([]);
	});

	it("does not let template content pose as a marker", () => {
		const source = "const note = `// WAIT-CLASS: fixture-delay — bogus`; setTimeout(run, 50);";
		expect(findWaitClassificationViolations(source)[0]?.problem).toBe("timer has no adjacent WAIT-CLASS marker");
	});

	it.each([
		["a leading-dot literal", "await delay(.5e4);"],
		["a leading-dot literal with space", "await sleep( .25);"],
		["an explicit type argument", "await delay<number>(5000);"],
		["a spaced type argument", "await sleep <number> (5000);"],
	])("gates a sleep helper called with %s", (_label, source) => {
		expect(findWaitClassificationViolations(source)[0]?.problem).toBe("timer has no adjacent WAIT-CLASS marker");
	});

	it.each([
		["a plain interpolation", "const elapsed = `${setTimeout(run, 50)}`;"],
		["an interpolation holding an object", "const elapsed = `${ ({ a: setTimeout(run, 50) }) }`;"],
		["a nested template interpolation", "const elapsed = `${`${setTimeout(run, 50)}`}`;"],
	])("gates a timer inside %s", (_label, source) => {
		expect(findWaitClassificationViolations(source)[0]?.problem).toBe("timer has no adjacent WAIT-CLASS marker");
	});

	it.each([
		["a closing backtick", "const ratio = +`4` / 2; setTimeout(run, 50);"],
		["a closing double quote", 'const ratio = +"4" / 2; setTimeout(run, 50);'],
		["a closing single quote", "const ratio = +'4' / 2; setTimeout(run, 50);"],
		["a closing regex delimiter", "const n = /a/.source.length / 2; setTimeout(run, 50);"],
	])("treats a slash after %s as division, not a regex", (_label, source) => {
		expect(findWaitClassificationViolations(source)[0]?.problem).toBe("timer has no adjacent WAIT-CLASS marker");
	});

	it("resumes template text after an interpolation closes", () => {
		const source = "const plugin = `${name} // WAIT-CLASS: fixture-delay — bogus`;\nawait new Promise((r) => setTimeout(r, 300));";
		expect(findWaitClassificationViolations(source)[0]?.problem).toBe("timer has no adjacent WAIT-CLASS marker");
	});

	it.each([
		["a directly written template", "writeFile(path, `\nsetTimeout(run, 8000);\n`, 'utf8');"],
		["an indirectly written template", "const source = `\nsetTimeout(run, 8000);\n`; writeFile(path, source, 'utf8');"],
		["a written template fragment after interpolation", "writeFile(path, `const value = ${fixtureValue};\nsetTimeout(run, 8000);`);"],
		["escaped written template text", "writeFile(path, `// fixture header\\nsetTimeout(run, 8000);`);"],
	])("gates a timer inside generated source in %s", (_label, source) => {
		expect(findWaitClassificationViolations(source)[0]?.problem).toBe("timer has no adjacent WAIT-CLASS marker");
	});

	it.each([
		["a display template", "expect(rendered).toContain(`setTimeout(run, 50);`);"],
		["a double-quoted string", 'const plugin = "await new Promise((r) => setTimeout(r, 8000));";'],
		["a comment", "// historical note: this used to call setTimeout(resolve, 20)"],
	])("does not gate a timer that is only %s", (_label, source) => {
		expect(findWaitClassificationViolations(source)).toEqual([]);
	});

	it("still accepts a real comment that follows a string on the same line", () => {
		const source = 'await new Promise((r) => setTimeout(r, 300)); // WAIT-CLASS: fixture-delay — matches the child\'s own "hold" window';
		expect(findWaitClassificationViolations(source)).toEqual([]);
	});

	it("rejects prose that merely mentions marker syntax", () => {
		const source = "// This is not a WAIT-CLASS: fixture-delay — reason\nsetTimeout(run, 300);";
		expect(findWaitClassificationViolations(source)[0]?.problem).toBe("timer has no adjacent WAIT-CLASS marker");
	});

	it("rejects a marker separated from its timer by real code", () => {
		const source = "// WAIT-CLASS: fixture-delay — held open by the fake provider\nconst unrelated = 1;\nawait new Promise((r) => setTimeout(r, 300));";
		expect(findWaitClassificationViolations(source)[0]?.problem).toBe("timer has no adjacent WAIT-CLASS marker");
	});

	it("accepts a classified timer, inline or above", () => {
		const above = "// WAIT-CLASS: poll-interval — gap between bounded re-reads\n// of the command log.\nawait new Promise((r) => setTimeout(r, 50));";
		const inline = "await new Promise((r) => setTimeout(r, 50)); // WAIT-CLASS: poll-interval — gap between bounded re-reads";
		expect(findWaitClassificationViolations(above)).toEqual([]);
		expect(findWaitClassificationViolations(inline)).toEqual([]);
	});

	it("ignores files with no timers", () => {
		expect(findWaitClassificationViolations("await vi.waitFor(() => expect(x).toBe(1), { timeout: 500, interval: 1 });")).toEqual([]);
	});
});

/**
 * @param {string} relativePath
 * @param {ReturnType<typeof findWaitClassificationViolations>} violations
 * @returns {string}
 */
function formatViolations(relativePath, violations) {
	if (violations.length === 0) return "";
	const detail = violations.map((violation) => `  ${relativePath}:${violation.line}  ${violation.problem}\n    ${violation.text}`).join("\n");
	return `unclassified waits — replace with an observable-state wait, or add "// WAIT-CLASS: <${WAIT_CLASSES.join("|")}> — <reason>":\n${detail}`;
}
