import { createJiti } from "jiti";
import { repoRoot } from "./paths.mjs";

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	tryNative: false,
});

export async function captureComponentScenario(scenario) {
	const kind = scenario.component?.kind;
	if (!kind) throw new Error(`Component scenario ${scenario.id} is missing component.kind`);
	const lines = await renderComponentLines(kind, scenario);
	const rows = scenario.dimensions.rows ?? lines.length;
	const cols = scenario.dimensions.cols;
	const ansi = linesToAnsi(lines, cols, rows);
	return {
		kind: "component",
		bytes: ansi,
		plainText: lines.join("\n"),
		metadata: { componentKind: kind, lineCount: lines.length },
	};
}

async function renderComponentLines(kind, scenario) {
	if (kind === "input-frame-typed") return renderInputFrameTyped(scenario.dimensions.cols);
	if (kind === "input-frame-inline-skill") return renderInputFrameInlineSkill(scenario.dimensions.cols);
	if (kind === "footer-ready") return renderFooterReady(scenario.dimensions.cols);
	if (kind === "top-bar-default") return renderTopBarDefault(scenario.dimensions.cols);
	if (kind === "sidebar-editorial") return renderSidebarEditorial(scenario.dimensions.cols);
	if (kind === "tree-selector") return renderTreeSelector(scenario.dimensions.cols);
	if (kind === "tree-summary-choice") return renderTreeSummaryChoice(scenario.dimensions.cols);
	if (kind === "tree-custom-summary-editor") return renderTreeCustomSummaryEditor(scenario.dimensions.cols);
	throw new Error(`Unsupported component scenario kind: ${kind}`);
}

async function renderInputFrameTyped(width) {
	const mod = await jiti.import(`${repoRoot}/src/cathedral/input-frame.ts`);
	return [
		...mod.renderInputFrame("review src/auth/session.ts and tighten the return type", width, { promptColor: "accent" }),
		mod.renderInputHints(width),
	];
}

async function renderInputFrameInlineSkill(width) {
	const editorMod = await jiti.import(`${repoRoot}/src/cathedral/cathedral-editor.ts`);
	const inputMod = await jiti.import(`${repoRoot}/src/cathedral/input-frame.ts`);
	const passthrough = (text) => text;
	const tui = { requestRender() {}, terminal: { columns: width, rows: 45, setTitle() {} } };
	const theme = {
		borderColor: passthrough,
		selectList: {
			selectedPrefix: passthrough,
			selectedText: passthrough,
			description: passthrough,
			scrollInfo: passthrough,
			noMatch: passthrough,
		},
	};
	const keybindings = { matches: () => false };
	const editor = editorMod.createCathedralEditor(tui, theme, keybindings, { isSplash: () => false });
	editor.setText("Testing /skill:apr");
	return [...editor.render(width), inputMod.renderInputHints(width)];
}

async function renderTopBarDefault(width) {
	const mod = await jiti.import(`${repoRoot}/src/top-chrome.ts`);
	return [mod.renderTopChrome({
		activeSession: { id: "abc", label: "auth-flow-refactor", state: "thinking" },
		recentSessions: [
			{ id: "def", label: "debug-balance-tx" },
			{ id: "ghi", label: "index-issues" },
		],
		hidden: false,
		dotSize: "medium",
	}, width)];
}

async function renderFooterReady(width) {
	const mod = await jiti.import(`${repoRoot}/src/footer.ts`);
	return mod.renderFooterBlock({
		cwd: "/Users/dev/projects/sumocode",
		branch: "main",
		inputTokens: 42000,
		outputTokens: 0,
		contextTokens: 42000,
		contextWindow: 200000,
		costUsd: 0.42,
		state: "idle",
		modelId: "gpt-5.5",
		thinkingLevel: "medium",
	}, width);
}

async function renderTreeSelector(width) {
	const mod = await jiti.import(`${repoRoot}/src/sumo-tui/rpc/inline-selector.ts`);
	const items = [
		{ value: "u1", label: "▷ run the smoke tests on this branch", description: "5h ago" },
		{ value: "a1", label: "✦ Running the suite now — 1541 tests green." },
		{ value: "u2", label: "▷ fix the queued messages UI", description: "4h ago" },
		{ value: "a2", label: "├─ ✦ Rendered as lifted banner rows above the editor." },
		{ value: "a3", label: "└─ ✦ Rendered as a bordered QUEUED chat card instead.", description: "3h ago" },
		{ value: "u3", label: "   ▷ [refactor] now fix image paste collapse" },
		{ value: "a4", label: "   ├─ ✦ Shadowed handlePaste to collapse bracketed paste.", description: "2h ago" },
		{ value: "a5", label: "   └─ ✦ Alternative: normalize in insertTextAtCursor only.", description: "1h ago", isCurrent: true },
	];
	return new mod.InlineSelectorComponent("Session tree", items, () => undefined, 8, "a5").render(width);
}

async function renderTreeSummaryChoice(width) {
	const mod = await jiti.import(`${repoRoot}/src/sumo-tui/rpc/inline-selector.ts`);
	return new mod.InlineSelectorComponent("Summarize branch?", ["No summary", "Summarize", "Summarize with custom prompt"], () => undefined, 8, "No summary").render(width);
}

async function renderTreeCustomSummaryEditor(width) {
	const mod = await jiti.import(`${repoRoot}/src/sumo-tui/widgets/modal.ts`);
	const modal = new mod.ModalManager();
	void modal.editor("Custom summarization instructions", "Preserve the API decisions and\ncall out unresolved risks.");
	await Promise.resolve();
	return modal.render(width);
}

async function renderSidebarEditorial(width) {
	const mod = await jiti.import(`${repoRoot}/src/sidebar.ts`);
	return mod.renderSidebar({
		projectName: "sumocode",
		branch: "main",
		inputTokens: 42000,
		outputTokens: 0,
		contextWindow: 200000,
		cumulativeTokens: 3400000,
		costUsd: 0.42,
		mcpServers: [
			{ name: "github", status: "idle" },
			{ name: "stitch", status: "ok" },
			{ name: "context7", status: "idle" },
			{ name: "chrome-dev", status: "idle" },
		],
		memory: [
			"prefers Scriptorium language",
			"uses cmux over Ghostty directly",
			"keeps UI review evidence",
		],
		memoryTotal: 48,
		memoryUnavailable: false,
		activeSubTab: "CONTEXT",
	}, width);
}

function linesToAnsi(lines, cols, rows) {
	const output = ["\x1b[2J\x1b[H"];
	for (let row = 0; row < rows; row += 1) {
		const line = lines[row] ?? "";
		output.push(`\x1b[${row + 1};1H${line}`);
	}
	return output.join("");
}
