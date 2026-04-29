import { createJiti } from "@mariozechner/jiti";
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
	if (kind === "footer-ready") return renderFooterReady(scenario.dimensions.cols);
	if (kind === "top-bar-default") return renderTopBarDefault(scenario.dimensions.cols);
	if (kind === "sidebar-editorial") return renderSidebarEditorial(scenario.dimensions.cols);
	throw new Error(`Unsupported component scenario kind: ${kind}`);
}

async function renderInputFrameTyped(width) {
	const mod = await jiti.import(`${repoRoot}/src/cathedral/input-frame.ts`);
	return [
		...mod.renderInputFrame("review src/argent-x/balance.ts and tighten the return type", width, { promptColor: "accent" }),
		mod.renderInputHints(width),
	];
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
		cwd: "/Users/sumo-deus/sumo-deus",
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

async function renderSidebarEditorial(width) {
	const mod = await jiti.import(`${repoRoot}/src/sidebar.ts`);
	return mod.renderSidebar({
		projectName: "sumocode",
		branch: "main",
		inputTokens: 42000,
		outputTokens: 8000,
		contextWindow: 200000,
		costUsd: 0.42,
		mcpServers: [
			{ name: "github", status: "ok" },
			{ name: "stitch", status: "idle" },
			{ name: "chrome", status: "idle" },
		],
		memory: [
			"prefers Scriptorium language",
			"uses cmux over Ghostty directly",
			"keeps UI review evidence",
		],
		memoryTotal: 48,
		memoryUnavailable: false,
		activeSubTab: "CONTEXT",
		metrics: {
			cpuPercent: 2.4,
			memoryMiB: 142,
			fps: 60,
			cpuHistory: [1, 1.4, 1.8, 2.0, 2.4, 2.1, 1.9, 2.2, 2.4, 2.4],
			memoryHistory: [120, 123, 126, 130, 134, 138, 140, 141, 142, 142],
			fpsHistory: [58, 60, 60, 59, 60, 60, 60, 59, 60, 60],
		},
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
