import { createJiti } from "@mariozechner/jiti";
import { visibleWidth } from "@mariozechner/pi-tui";
import { repoRoot } from "./paths.mjs";

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	tryNative: false,
});

const FIXTURE_TIMES = {
	userOne: new Date("2026-04-30T11:41:00"),
	sumoOne: new Date("2026-04-30T11:42:00"),
	userTwo: new Date("2026-04-30T11:42:30"),
	sumoTwo: new Date("2026-04-30T11:43:00"),
};

const FIXTURES = {
	"completed-active": {
		transcript: {
			messages: [
				{
					id: "u1",
					role: "user",
					displayName: "USER",
					timestamp: FIXTURE_TIMES.userOne,
					blocks: [{ type: "markdown", text: "hello, refactor the auth flow to use the new session pattern." }],
				},
				{
					id: "s1",
					role: "sumo",
					displayName: "SUMO",
					timestamp: FIXTURE_TIMES.sumoOne,
					blocks: [
						{ type: "markdown", text: "Reading the auth flow." },
						{ type: "tool", tool: { id: "read-session", name: "read", status: "success", output: "src/auth/session.ts" } },
						{ type: "tool", tool: { id: "edit-session", name: "edit", status: "success", output: "src/auth/session.ts" } },
						{ type: "markdown", text: "Done. Updated 14 lines, deleted 6 stale helpers." },
					],
				},
				{
					id: "u2",
					role: "user",
					displayName: "USER",
					timestamp: FIXTURE_TIMES.userTwo,
					blocks: [{ type: "markdown", text: "run tests" }],
				},
				{
					id: "s2",
					role: "sumo",
					displayName: "SUMO",
					timestamp: FIXTURE_TIMES.sumoTwo,
					blocks: [
						{ type: "markdown", text: "Running tests now." },
						{ type: "tool", tool: { id: "bash-test", name: "bash", status: "success", output: "pnpm test src/auth · 22 tests, 1.2s" } },
						{ type: "markdown", text: "All 22 tests pass." },
					],
				},
			],
		},
	},
	"command-palette": {
		overlay: "command-palette",
		transcript: {
			messages: [
				{
					id: "u1",
					role: "user",
					displayName: "USER",
					timestamp: FIXTURE_TIMES.userOne,
					blocks: [{ type: "markdown", text: "open command palette" }],
				},
				{
					id: "s1",
					role: "sumo",
					displayName: "SUMO",
					timestamp: FIXTURE_TIMES.sumoOne,
					blocks: [{ type: "markdown", text: "Palette is ready." }],
				},
			],
		},
	},
	"tool-ledger": {
		transcript: {
			messages: [
				{
					id: "u1",
					role: "user",
					displayName: "USER",
					timestamp: FIXTURE_TIMES.userOne,
					blocks: [{ type: "markdown", text: "inspect auth session and run focused tests" }],
				},
				{
					id: "s1",
					role: "sumo",
					displayName: "SUMO",
					timestamp: FIXTURE_TIMES.sumoOne,
					blocks: [
						{ type: "markdown", text: "I’ll inspect the session boundary, patch it, then run focused tests." },
						{ type: "tool", tool: { id: "read", name: "read", status: "success", output: "src/auth/session.ts" } },
						{ type: "tool", tool: { id: "edit", name: "edit", status: "success", output: "+14 -6 session flow updated" } },
						{ type: "tool", tool: { id: "bash", name: "bash", status: "success", output: "22 passed in 1.2s" } },
						{ type: "markdown", text: "The focused path is green." },
					],
				},
			],
		},
	},
};

export async function captureFixtureScenario(scenario) {
	const fixtureId = scenario.fixture?.id;
	if (!fixtureId) throw new Error(`Fixture scenario ${scenario.id} is missing fixture.id`);
	const fixture = FIXTURES[fixtureId];
	if (!fixture) throw new Error(`Unsupported fixture id: ${fixtureId}`);
	const lines = await renderFixtureScene(scenario, fixture);
	const cols = scenario.dimensions.cols;
	const rows = scenario.dimensions.rows;
	return {
		kind: "fixture",
		bytes: linesToAnsi(lines, cols, rows),
		plainText: lines.join("\n"),
		metadata: { fixtureId, lineCount: lines.length },
	};
}

async function renderFixtureScene(scenario, fixture) {
	const transcript = fixture.transcript;
	const cols = scenario.dimensions.cols;
	const rows = scenario.dimensions.rows;
	const portrait = cols < 80;
	const sidebarVisible = cols >= 120;
	const gutter = sidebarVisible ? 2 : portrait ? 1 : 0;
	const sidebarWidth = sidebarVisible ? 30 : 0;
	const chatWidth = Math.max(1, cols - sidebarWidth - gutter);

	const [topChrome, inputFrame, footer, sidebar, chatPager, yogaMod, layoutNodeMod, bufferMod, compositorMod, writerMod, transcriptMod] = await Promise.all([
		jiti.import(`${repoRoot}/src/top-chrome.ts`),
		jiti.import(`${repoRoot}/src/cathedral/input-frame.ts`),
		jiti.import(`${repoRoot}/src/footer.ts`),
		jiti.import(`${repoRoot}/src/sidebar.ts`),
		jiti.import(`${repoRoot}/src/sumo-tui/widgets/chat-pager.ts`),
		jiti.import(`${repoRoot}/src/sumo-tui/layout/yoga.ts`),
		jiti.import(`${repoRoot}/src/sumo-tui/layout/node.ts`),
		jiti.import(`${repoRoot}/src/sumo-tui/render/buffer.ts`),
		jiti.import(`${repoRoot}/src/sumo-tui/render/compositor.ts`),
		jiti.import(`${repoRoot}/src/sumo-tui/render/ansi-writer.ts`),
		jiti.import(`${repoRoot}/src/sumo-tui/transcript/view-model.ts`),
	]);

	const topRows = topChrome.renderTopChromeBlock({
		activeSession: { id: "fixture", label: "019dd3d8", state: "idle" },
		recentSessions: [],
		hidden: false,
	}, cols);

	const inputRows = inputFrame.renderInputFrame("", cols, { promptColor: "accent" });
	const hintRows = portrait
		? [` ${inputFrame.renderInputHints(cols - 2, { leftHint: "sumo-deus (main)", leftHintStyle: "project-branch" })} `, " ".repeat(cols)]
		: [inputFrame.renderInputHints(cols)];
	const footerRows = footer.renderFooterBlock({
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
	}, cols);
	const bottomRows = ["" , ...inputRows, ...hintRows, ...(portrait ? [] : [""]), ...footerRows, ""];
	const chatHeight = Math.max(1, rows - topRows.length - bottomRows.length);

	const yoga = await yogaMod.loadYoga();
	const chatRoot = new layoutNodeMod.SumoNode(yoga.Node.create());
	chatRoot.flexDirection = yogaMod.FLEX_DIRECTION_COLUMN;
	const chat = chatPager.ChatPager.create(yoga, chatRoot, { stickyBottom: false });
	for (const message of transcript.messages) {
		chat.addMessage(message.role, transcriptMod.chatMessageViewModelToPlainText(message), message.timestamp);
	}
	chatRoot.width = chatWidth;
	chatRoot.height = chatHeight;
	chatRoot.yogaNode.calculateLayout(chatWidth, chatHeight, yogaMod.DIRECTION_LTR);
	const frame = new bufferMod.CellBuffer(chatHeight, chatWidth);
	compositorMod.composite(chatRoot, frame);
	const chatLines = writerMod.bufferToAnsiLines(frame);
	chatRoot.dispose();

	const sidebarLines = sidebarVisible ? sidebar.renderSidebar({
		projectName: "sumo-deus",
		branch: "main",
		inputTokens: 42000,
		outputTokens: 0,
		contextWindow: 200000,
		cumulativeTokens: 3400000,
		costUsd: 0.42,
		mcpServers: sidebar.PLACEHOLDER_MCP,
		memory: ["prefers Scriptorium language", "uses cmux", "keeps UI review evidence"],
		memoryTotal: 48,
		activeSubTab: "CONTEXT",
	}, sidebarWidth) : [];

	const scene = [...topRows];
	for (let row = 0; row < chatHeight; row += 1) {
		const chatLine = padAnsiToWidth(chatLines[row] ?? "", chatWidth);
		if (sidebarVisible) scene.push(`${chatLine}${" ".repeat(gutter)}${sidebarLines[row] ?? " ".repeat(sidebarWidth)}`);
		else scene.push(`${chatLine}${" ".repeat(gutter)}`);
	}
	scene.push(...bottomRows);
	const fitted = fitRows(scene, cols, rows);
	return fixture.overlay ? await applyOverlay(fitted, cols, rows, fixture.overlay) : fitted;
}

async function applyOverlay(lines, cols, rows, overlay) {
	if (overlay !== "command-palette") throw new Error(`Unsupported fixture overlay: ${overlay}`);
	const palette = await jiti.import(`${repoRoot}/src/command-palette.ts`);
	const overlayLines = palette.renderCommandPalette({
		searchQuery: "",
		activeIndex: 1,
		rows: palette.COMMAND_PALETTE_MODE_ROWS,
	}, cols);
	const overlayWidth = Math.max(...overlayLines.map((line) => visibleWidth(line)), 0);
	const left = Math.max(0, Math.floor((cols - overlayWidth) / 2));
	const top = Math.max(0, Math.floor((rows - overlayLines.length) / 2));
	const next = [...lines];
	for (let index = 0; index < overlayLines.length && top + index < rows; index += 1) {
		const overlayLine = padAnsiToWidth(overlayLines[index] ?? "", overlayWidth);
		next[top + index] = `${" ".repeat(left)}${overlayLine}${" ".repeat(Math.max(0, cols - left - overlayWidth))}`;
	}
	return next;
}

function padAnsiToWidth(line, width) {
	const visible = visibleWidth(line);
	if (visible >= width) return line;
	return `${line}${" ".repeat(width - visible)}`;
}

function fitRows(lines, cols, rows) {
	return Array.from({ length: rows }, (_, index) => padAnsiToWidth(lines[index] ?? "", cols));
}

function linesToAnsi(lines, cols, rows) {
	const output = ["\x1b[2J\x1b[H"];
	for (let row = 0; row < rows; row += 1) {
		const line = lines[row] ?? "";
		output.push(`\x1b[${row + 1};1H${line}`);
	}
	return output.join("");
}
