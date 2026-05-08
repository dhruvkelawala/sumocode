/**
 * Cathedral answer tool — multi-question Divine Query wizard.
 *
 * Extracts questions from the last assistant message, then presents
 * each as a Divine Query overlay for the user to answer sequentially.
 * Registers the `/answer` command and `Ctrl+.` shortcut.
 *
 * This replaces Pi's `answer.ts` extension with Cathedral-themed UI.
 */

import { complete, type Model, type Api, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { DIVINE_QUERY_OVERLAY_OPTIONS } from "./divine-query.js";
import { activeThemeColors } from "./themes/index.js";

// ── Types ────────────────────────────────────────────────────

interface ExtractedQuestion {
	question: string;
	context?: string;
}

interface ExtractionResult {
	questions: ExtractedQuestion[];
}

interface QnAResult {
	entries: Array<ExtractedQuestion & { answer: string }>;
	formatted: string;
}

// ── Extraction ───────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering.

Output a JSON object with this structure:
{
  "questions": [
    {
      "question": "The question text",
      "context": "Optional context that helps answer the question"
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Be concise with question text
- Include context only when it provides essential information for answering
- If no questions are found, return {"questions": []}`;

const HAIKU_MODEL_ID = "claude-haiku-4-5";
const GPT_FALLBACK_MODEL_ID = "gpt-5.4-mini";

async function selectExtractionModel(
	currentModel: Model<Api>,
	modelRegistry: ModelRegistry,
): Promise<Model<Api>> {
	const haikuModel = modelRegistry.find("anthropic", HAIKU_MODEL_ID);
	if (haikuModel) {
		const auth = await modelRegistry.getApiKeyAndHeaders(haikuModel);
		if (auth.ok) return haikuModel;
	}
	const gptFallback = modelRegistry.find("openai-codex", GPT_FALLBACK_MODEL_ID);
	if (gptFallback) {
		const auth = await modelRegistry.getApiKeyAndHeaders(gptFallback);
		if (auth.ok) return gptFallback;
	}
	return currentModel;
}

function parseExtractionResult(text: string): ExtractionResult | null {
	try {
		let jsonStr = text;
		const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch) jsonStr = jsonMatch[1].trim();
		const parsed = JSON.parse(jsonStr);
		return parsed && Array.isArray(parsed.questions) ? (parsed as ExtractionResult) : null;
	} catch {
		return null;
	}
}

// ── Cathedral Q&A Component ─────────────────────────────────

const RESET = "\u001b[0m";
function cathedralFg(text: string, hex: string): string {
	const h = hex.replace("#", "");
	const r = parseInt(h.slice(0, 2), 16);
	const g = parseInt(h.slice(2, 4), 16);
	const b = parseInt(h.slice(4, 6), 16);
	return `\u001b[38;2;${r};${g};${b}m${text}${RESET}`;
}

const accent = (s: string) => cathedralFg(s, activeThemeColors().accent);
const fg = (s: string) => cathedralFg(s, activeThemeColors().foreground);
const dim = (s: string) => cathedralFg(s, activeThemeColors().foregroundDim);
const divider = (s: string) => cathedralFg(s, activeThemeColors().divider);
const idle = (s: string) => cathedralFg(s, activeThemeColors().states.idle);
const thinking = (s: string) => cathedralFg(s, activeThemeColors().states.thinking);
const liftedBg = `\u001b[48;2;61;48;36m`; // surfaceLifted

class CathedralQnAComponent implements Component {
	private questions: ExtractedQuestion[];
	private answers: string[];
	private currentIndex = 0;
	private editor: Editor;
	private tui: TUI;
	private onDone: (result: QnAResult | null) => void;
	private showingConfirmation = false;
	private cachedLines: string[] | undefined;

	constructor(questions: ExtractedQuestion[], tui: TUI, onDone: (result: QnAResult | null) => void) {
		this.questions = questions;
		this.answers = questions.map(() => "");
		this.tui = tui;
		this.onDone = onDone;

		const editorTheme: EditorTheme = {
			borderColor: (s) => cathedralFg(s, activeThemeColors().accent),
			selectList: {
				selectedPrefix: (t) => cathedralFg(t, activeThemeColors().accent),
				selectedText: (t) => cathedralFg(t, activeThemeColors().accent),
				description: (t) => cathedralFg(t, activeThemeColors().foregroundDim),
				scrollInfo: (t) => cathedralFg(t, activeThemeColors().foregroundDim),
				noMatch: (t) => cathedralFg(t, activeThemeColors().states.approval),
			},
		};
		this.editor = new Editor(tui, editorTheme);
		this.editor.disableSubmit = true;
		this.editor.onChange = () => { this.invalidate(); this.tui.requestRender(); };
	}

	private saveCurrentAnswer(): void {
		this.answers[this.currentIndex] = this.editor.getText();
	}

	private navigateTo(index: number): void {
		if (index < 0 || index >= this.questions.length) return;
		this.saveCurrentAnswer();
		this.currentIndex = index;
		this.editor.setText(this.answers[index] || "");
		this.invalidate();
	}

	private submit(): void {
		this.saveCurrentAnswer();
		const entries = this.questions.map((q, i) => ({
			...q,
			answer: this.answers[i]?.trim() || "(no answer)",
		}));
		const parts: string[] = [];
		for (const entry of entries) {
			parts.push(`Q: ${entry.question}`);
			if (entry.context) parts.push(`> ${entry.context}`);
			parts.push(`A: ${entry.answer}`);
			parts.push("");
		}
		this.onDone({ entries, formatted: parts.join("\n").trim() });
	}

	invalidate(): void { this.cachedLines = undefined; }

	handleInput(data: string): void {
		if (this.showingConfirmation) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") { this.submit(); return; }
			if (matchesKey(data, Key.escape) || data.toLowerCase() === "n") {
				this.showingConfirmation = false;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.onDone(null); return; }

		if (matchesKey(data, Key.tab)) {
			if (this.currentIndex < this.questions.length - 1) { this.navigateTo(this.currentIndex + 1); this.tui.requestRender(); }
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			if (this.currentIndex > 0) { this.navigateTo(this.currentIndex - 1); this.tui.requestRender(); }
			return;
		}

		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			this.saveCurrentAnswer();
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
			} else {
				this.showingConfirmation = true;
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines) return this.cachedLines;

		const boxWidth = Math.min(width, 120);
		const contentWidth = boxWidth - 4;
		const horizontalLine = (count: number) => "─".repeat(count);

		const boxLine = (content: string, leftPad = 2): string => {
			const paddedContent = " ".repeat(leftPad) + content;
			const contentLen = visibleWidth(paddedContent);
			const rightPad = Math.max(0, boxWidth - contentLen - 2);
			return `${liftedBg}${divider("│")}${paddedContent}${" ".repeat(rightPad)}${divider("│")}${RESET}`;
		};

		const emptyBoxLine = (): string => `${liftedBg}${divider("│")}${" ".repeat(boxWidth - 2)}${divider("│")}${RESET}`;
		const padToWidth = (line: string): string => {
			const len = visibleWidth(line);
			return line + " ".repeat(Math.max(0, width - len));
		};

		const lines: string[] = [];

		// Title: ✾ DIVINE QUERY ✾ (n/total)
		lines.push(padToWidth(`${liftedBg}${divider("╭" + horizontalLine(boxWidth - 2) + "╮")}${RESET}`));
		const title = `${accent("✾")}  ${accent("DIVINE QUERY")}  ${accent("✾")}  ${dim(`${this.currentIndex + 1}/${this.questions.length}`)}`;
		lines.push(padToWidth(boxLine(title)));

		// Split rule
		const ruleLen = Math.max(1, Math.floor((contentWidth - 6) / 2 - 5));
		const splitRule = `${divider("─".repeat(ruleLen))}  ${divider("·")}  ${divider("─".repeat(ruleLen))}`;
		lines.push(padToWidth(boxLine(splitRule)));

		// Progress
		const progressParts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const answered = (this.answers[i]?.trim() || "").length > 0;
			const current = i === this.currentIndex;
			if (current) progressParts.push(accent("❈"));
			else if (answered) progressParts.push(idle("✓"));
			else progressParts.push(divider("·"));
		}
		lines.push(padToWidth(boxLine(progressParts.join(" "))));
		lines.push(padToWidth(emptyBoxLine()));

		// Question
		const q = this.questions[this.currentIndex];
		const questionText = `${accent("Q:")} ${fg(q.question)}`;
		for (const line of wrapTextWithAnsi(questionText, contentWidth)) {
			lines.push(padToWidth(boxLine(line)));
		}

		// Context
		if (q.context) {
			lines.push(padToWidth(emptyBoxLine()));
			for (const line of wrapTextWithAnsi(dim(`> ${q.context}`), contentWidth - 2)) {
				lines.push(padToWidth(boxLine(line)));
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		// Editor
		const answerPrefix = accent("A: ");
		const editorWidth = contentWidth - 4 - 3;
		const editorLines = this.editor.render(editorWidth);
		for (let i = 1; i < editorLines.length - 1; i++) {
			const prefix = i === 1 ? answerPrefix : "   ";
			lines.push(padToWidth(boxLine(prefix + editorLines[i])));
		}

		lines.push(padToWidth(emptyBoxLine()));

		// Footer
		lines.push(padToWidth(boxLine(splitRule)));
		if (this.showingConfirmation) {
			const confirmMsg = `${thinking("Submit all answers?")} ${dim("(Enter/y to confirm, Esc/n to cancel)")}`;
			lines.push(padToWidth(boxLine(truncateToWidth(confirmMsg, contentWidth))));
		} else {
			const controls = dim("⇅ wander    ⏎ answer    ⇧⇥ retreat    ⎋ cancel");
			lines.push(padToWidth(boxLine(truncateToWidth(controls, contentWidth))));
		}
		lines.push(padToWidth(`${liftedBg}${divider("╰" + horizontalLine(boxWidth - 2) + "╯")}${RESET}`));

		this.cachedLines = lines;
		return lines;
	}
}

// ── Extension wiring ─────────────────────────────────────────

export function installAnswerTool(pi: ExtensionAPI): void {
	const runQuestionnaire = async (ctx: ExtensionContext, questions: ExtractedQuestion[]): Promise<QnAResult | null> => {
		if (!ctx.hasUI) {
			ctx.ui.notify("questionnaire requires interactive mode", "error");
			return null;
		}
		return ctx.ui.custom<QnAResult | null>(
			(tui, _theme, _kb, done) => new CathedralQnAComponent(questions, tui, done),
			{ overlay: true, overlayOptions: DIVINE_QUERY_OVERLAY_OPTIONS },
		);
	};

	const answerHandler = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) { ctx.ui.notify("answer requires interactive mode", "error"); return; }
		if (!ctx.model) { ctx.ui.notify("No model selected", "error"); return; }

		const branch = ctx.sessionManager.getBranch();
		let lastAssistantText: string | undefined;

		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message") {
				const msg = entry.message;
				if ("role" in msg && msg.role === "assistant") {
					if (msg.stopReason !== "stop") {
						ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
						return;
					}
					const textParts = msg.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text);
					if (textParts.length > 0) { lastAssistantText = textParts.join("\n"); break; }
				}
			}
		}

		if (!lastAssistantText) { ctx.ui.notify("No assistant messages found", "error"); return; }

		const extractionModel = await selectExtractionModel(ctx.model, ctx.modelRegistry);

		const extractionResult = await ctx.ui.custom<ExtractionResult | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, `Extracting questions using ${extractionModel.id}...`);
			loader.onAbort = () => done(null);

			const doExtract = async () => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(extractionModel);
				if (!auth.ok) throw new Error(auth.error);
				const userMessage: UserMessage = {
					role: "user",
					content: [{ type: "text", text: lastAssistantText! }],
					timestamp: Date.now(),
				};
				const response = await complete(
					extractionModel,
					{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
					{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
				);
				if (response.stopReason === "aborted") return null;
				const responseText = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				return parseExtractionResult(responseText);
			};

			doExtract().then(done).catch(() => done(null));
			return loader;
		});

		if (!extractionResult) { ctx.ui.notify("Cancelled", "info"); return; }
		if (extractionResult.questions.length === 0) { ctx.ui.notify("No questions found in the last message", "info"); return; }

		const answersResult = await runQuestionnaire(ctx, extractionResult.questions);
		if (!answersResult) { ctx.ui.notify("Cancelled", "info"); return; }

		pi.sendMessage(
			{
				customType: "answers",
				content: "I answered your questions in the following way:\n\n" + answersResult.formatted,
				display: true,
				details: { entries: answersResult.entries },
			},
			{ triggerTurn: true },
		);
	};

	pi.registerCommand("answer", {
		description: "Extract questions from last assistant message into interactive Q&A",
		handler: (_args, ctx) => answerHandler(ctx),
	});

	pi.registerShortcut("ctrl+.", {
		description: "Extract and answer questions",
		handler: answerHandler,
	});
}
