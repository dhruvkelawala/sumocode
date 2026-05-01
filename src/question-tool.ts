/**
 * Cathedral question tool — single-question Divine Query overlay.
 *
 * Overrides Pi's default `question` tool with Scriptorium styling.
 * The LLM invokes this when it needs a single user decision.
 *
 * Options render as a Divine Query modal. The last option is always
 * "Type something…" which opens a Pi editor for free-text input.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { renderDivineQuery, updateDivineQuery, type DivineQuerySnapshot, DIVINE_QUERY_OVERLAY_OPTIONS } from "./divine-query.js";

const QuestionParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	context: Type.Optional(Type.String({ description: "Optional context/help text shown under the question" })),
	questions: Type.Optional(
		Type.Array(
			Type.Object({
				question: Type.String({ description: "Question text to ask the user" }),
				context: Type.Optional(Type.String({ description: "Optional context/help text shown under the question" })),
			}),
			{ minItems: 1, description: "Questions to ask, in order" },
		),
	),
});

const FREE_TEXT_LABEL = "Type something…";

/**
 * Pi's `Editor` renders with its own theme tokens — its default cursor and
 * syntax colors are bright greens that look foreign on the Cathedral palette.
 * Wrap each editor row so any Pi `[39m` (default-fg reset) lands back on
 * Cathedral foreground. The framing layer in `renderDivineQuery` re-applies
 * surfaceLifted bg via `persistentBg`, so we only need foreground discipline
 * here.
 */
const FG_RESET = "[39m";
const RESET = "[0m";
const CATHEDRAL_FG = "[38;2;245;230;200m";

export function withCathedralForeground(line: string): string {
	const reCathedralized = line
		.replaceAll(RESET, `${RESET}${CATHEDRAL_FG}`)
		.replaceAll(FG_RESET, `${FG_RESET}${CATHEDRAL_FG}`);
	return `${CATHEDRAL_FG}${reCathedralized}${FG_RESET}`;
}

interface QuestionResult {
	answer: string;
	wasCustom: boolean;
}

async function showCathedralQuestion(
	ctx: ExtensionContext,
	title: string,
	options: readonly string[],
): Promise<QuestionResult | null> {
	return ctx.ui.custom<QuestionResult | null>(
		(tui, theme, _kb, done) => {
			let snapshot: DivineQuerySnapshot = { title, options, focusedIndex: 0 };
			let editMode = false;
			let cachedLines: string[] | undefined;

			const editorTheme: EditorTheme = {
				borderColor: (s) => theme.fg("accent", s),
				selectList: {
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				},
			};
			const editor = new Editor(tui, editorTheme);

			editor.onSubmit = (value) => {
				const trimmed = value.trim();
				if (trimmed) {
					done({ answer: trimmed, wasCustom: true });
				} else {
					editMode = false;
					editor.setText("");
					refresh();
				}
			};

			function refresh(): void {
				cachedLines = undefined;
				tui.requestRender();
			}

			function handleInput(data: string): void {
				if (editMode) {
					if (matchesKey(data, Key.escape)) {
						editMode = false;
						editor.setText("");
						refresh();
						return;
					}
					editor.handleInput(data);
					refresh();
					return;
				}

				const result = updateDivineQuery(snapshot, data);
				snapshot = result.snapshot;

				if (result.done !== undefined) {
					if (result.done === -1) {
						done(null);
						return;
					}
					const selected = options[result.done];
					if (selected === FREE_TEXT_LABEL) {
						editMode = true;
						refresh();
						return;
					}
					done({ answer: selected ?? "", wasCustom: false });
					return;
				}

				refresh();
			}

			function render(width: number): string[] {
				if (cachedLines) return cachedLines;

				const extras: string[] = [];
				if (editMode) {
					// `renderDivineQuery` returns full-width lifted panel rows.
					// Reserve 5 cols indent + 1 col trailing margin.
					const editorInnerWidth = Math.max(1, width - 6);
					extras.push(`     ${theme.fg("muted", "Your answer:")}`);
					for (const line of editor.render(editorInnerWidth)) {
						extras.push(`     ${withCathedralForeground(line)}`);
					}
					extras.push("");
					extras.push(`     ${theme.fg("dim", "Enter to submit · Esc to go back")}`);
				}

				const lines = renderDivineQuery(snapshot, width, { extras });
				cachedLines = lines;
				return lines;
			}

			return {
				render,
				invalidate: () => { cachedLines = undefined; },
				handleInput,
			};
		},
		{ overlay: true, overlayOptions: DIVINE_QUERY_OVERLAY_OPTIONS },
	);
}

export function installQuestionTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "question",
		label: "Question",
		description: "Ask the user a question and let them pick from options. Use when you need user input to proceed. Do NOT prefix options with A)/B)/1./2. — the Cathedral UI adds labels automatically.",
		parameters: QuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available" }],
					details: { cancelled: true, reason: "no_ui" },
				};
			}

			// Normalize: support both single question and questions array
			const questions = params.questions?.length
				? params.questions
				: params.question
					? [{ question: params.question, context: params.context }]
					: [];

			if (questions.length === 0) {
				return {
					content: [{ type: "text", text: "No questions provided." }],
					details: { cancelled: true, reason: "empty" },
				};
			}

			// For single question, show Divine Query directly
			if (questions.length === 1) {
				const q = questions[0];
				const title = q.context ? `${q.question}\n${q.context}` : q.question;
				// No predefined options — just free text via the "Type something…" option
				const result = await showCathedralQuestion(ctx, title, [FREE_TEXT_LABEL]);

				if (!result) {
					return {
						content: [{ type: "text", text: "User cancelled." }],
						details: { cancelled: true },
					};
				}

				return {
					content: [{ type: "text", text: `User answered: ${result.answer}` }],
					details: { cancelled: false, answer: result.answer, wasCustom: result.wasCustom },
				};
			}

			// For multiple questions, show them sequentially
			const answers: { question: string; answer: string }[] = [];
			for (const q of questions) {
				const title = q.context ? `${q.question}\n${q.context}` : q.question;
				const result = await showCathedralQuestion(ctx, title, [FREE_TEXT_LABEL]);

				if (!result) {
					return {
						content: [{ type: "text", text: "User cancelled." }],
						details: { cancelled: true, answeredSoFar: answers },
					};
				}

				answers.push({ question: q.question, answer: result.answer });
			}

			const formatted = answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n");
			return {
				content: [{ type: "text", text: `User answered:\n\n${formatted}` }],
				details: { cancelled: false, entries: answers },
			};
		},

		renderCall(args, theme) {
			const q = args.question ?? (Array.isArray(args.questions) ? args.questions[0]?.question : "");
			return new Text(theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", q), 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as { cancelled?: boolean; answer?: string; entries?: { answer: string }[] } | undefined;
			if (!details || details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const answer = details.answer ?? details.entries?.map((e) => e.answer).join(", ") ?? "";
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", answer), 0, 0);
		},
	});
}
