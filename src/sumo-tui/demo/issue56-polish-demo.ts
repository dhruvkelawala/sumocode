import { EmptyChatQuoteNode } from "../cathedral/empty-chat-quote.js";
import { createSidebarTree, type SidebarLayoutSnapshot } from "../cathedral/sidebar-tree.js";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga, type Yoga } from "../layout/yoga.js";
import { CATHEDRAL_TOKENS } from "../../tokens.js";
import { colorHex } from "../cathedral/ansi.js";
import { bufferToAnsiLines } from "../render/ansi-writer.js";
import { CellBuffer, type Rect } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import type { MeasureMode, YogaNode } from "../layout/yoga.js";

class DemoTextNode extends SumoNode {
	public constructor(yogaNode: YogaNode, private readonly lines: readonly string[], parent?: SumoNode) {
		super(yogaNode, parent);
		this.flexGrow = 1;
		this.flexShrink = 1;
		this.setMeasureFunc((width, widthMode, height, heightMode) => this.measure(width, widthMode, height, heightMode));
	}

	public render(buffer: CellBuffer, rect: Rect): void {
		for (let row = 0; row < Math.min(rect.height, this.lines.length); row += 1) {
			buffer.paintRow(rect.top + row, this.lines[row] ?? "", rect.left, rect.width);
		}
	}

	private measure(width: number, _widthMode: MeasureMode, height: number, _heightMode: MeasureMode): { width: number; height: number } {
		return { width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height)) };
	}
}

function terminalSize(): { cols: number; rows: number } {
	const forcedCols = Number.parseInt(process.env.SUMO_TUI_ISSUE56_COLS ?? "", 10);
	const forcedRows = Number.parseInt(process.env.SUMO_TUI_ISSUE56_ROWS ?? "", 10);
	const cols = Number.isFinite(forcedCols) && forcedCols > 0 ? forcedCols : process.stdout.columns;
	const rows = Number.isFinite(forcedRows) && forcedRows > 0 ? forcedRows : process.stdout.rows;
	return { cols: cols && cols > 0 ? cols : 120, rows: rows && rows > 0 ? rows : 36 };
}

function fixtureSnapshot(): SidebarLayoutSnapshot {
	return {
		terminalWidth: terminalSize().cols,
		terminalHeight: terminalSize().rows,
		sessionHasMessages: true,
		dockMinWidth: 80,
		projectName: "argent-x",
		branch: "main",
		inputTokens: 42_000,
		outputTokens: 0,
		contextWindow: 200_000,
		costUsd: 0.42,
		activeSubTab: "CONTEXT",
		mcpServers: [
			{ name: "stitch", status: "ok" },
			{ name: "figma", status: "down" },
			{ name: "chrome-devtools", status: "idle" },
		],
		memory: [
			"prefers TypeScript strict",
			"pnpm not npm",
			"based in London",
			"visual verification before done",
			"cmux over Ghostty direct",
		],
		memoryTotal: 53,
		metrics: {
			cpuPercent: 2.4,
			memoryMiB: 184,
			fps: 0,
			cpuHistory: [1, 2, 4, 3, 5, 3, 2, 2, 3, 2.4],
			memoryHistory: [171, 172, 174, 176, 178, 180, 181, 182, 183, 184],
			fpsHistory: [0, 0, 1, 0, 0, 2, 0, 0, 0, 0],
		},
	};
}

function renderFrame(root: SumoNode): void {
	const { cols, rows } = terminalSize();
	root.width = cols;
	root.height = rows;
	root.yogaNode.calculateLayout(cols, rows, DIRECTION_LTR);
	const buffer = new CellBuffer(rows, cols);
	composite(root, buffer);
	process.stdout.write(`\x1b[?2026h\x1b[2J\x1b[H${bufferToAnsiLines(buffer).join("\r\n")}\x1b[?2026l`);
}

function placeChatOverlay(node: SumoNode): void {
	node.position = "absolute";
	node.top = 0;
	node.left = 0;
	node.width = Math.max(1, terminalSize().cols - 50);
	node.height = "100%";
	node.zIndex = 50;
}

async function createTree(yoga: Yoga, scenario: string): Promise<ReturnType<typeof createSidebarTree>> {
	const snapshot = fixtureSnapshot();
	const tree = createSidebarTree(yoga, undefined, snapshot);
	tree.chat.flexDirection = FLEX_DIRECTION_COLUMN;

	if (scenario === "empty") {
		const quote = new EmptyChatQuoteNode(yoga.Node.create(), () => ({ sidebarVisible: true, isSplash: false, userMessageCount: 0 }), tree.root);
		placeChatOverlay(quote);
		return tree;
	}

	if (scenario === "sidebar") {
		const text = new DemoTextNode(yoga.Node.create(), [
			`${colorHex("SYSTEM >", CATHEDRAL_TOKENS.colors.foregroundDim)} ${colorHex("Sidebar fixture: all UX_SPEC §4.2 panels are populated for visual verification.", CATHEDRAL_TOKENS.colors.foreground)}`,
		], tree.root);
		placeChatOverlay(text);
		return tree;
	}

	const text = new DemoTextNode(yoga.Node.create(), [
		`${colorHex("USER >", CATHEDRAL_TOKENS.colors.accent)} ${colorHex("Can you polish the cathedral chat and sidebar without expanding v1 scope?", CATHEDRAL_TOKENS.colors.foreground)}`,
		`${colorHex("SUMO >", CATHEDRAL_TOKENS.colors.states.idle)} ${colorHex("Yes — keeping DECISIONS locked. Code block theme audit sample:", CATHEDRAL_TOKENS.colors.foreground)}`,
		colorHex("       ```ts", CATHEDRAL_TOKENS.colors.foregroundDim),
		`${colorHex("       function", CATHEDRAL_TOKENS.colors.accent)} ${colorHex("initializeCathedralEngine", CATHEDRAL_TOKENS.colors.states.thinking)}${colorHex("(config) {", CATHEDRAL_TOKENS.colors.foreground)}`,
		`${colorHex("         const", CATHEDRAL_TOKENS.colors.accent)} ${colorHex("status", CATHEDRAL_TOKENS.colors.foreground)} ${colorHex("=", CATHEDRAL_TOKENS.colors.foreground)} ${colorHex("\"yellow_protocol_active\"", CATHEDRAL_TOKENS.colors.states.idle)}${colorHex(";", CATHEDRAL_TOKENS.colors.foreground)}`,
		`${colorHex("         return", CATHEDRAL_TOKENS.colors.accent)} ${colorHex("status", CATHEDRAL_TOKENS.colors.foreground)}${colorHex(";", CATHEDRAL_TOKENS.colors.foreground)}`,
		colorHex("       }", CATHEDRAL_TOKENS.colors.foreground),
		colorHex("       ```", CATHEDRAL_TOKENS.colors.foregroundDim),
		`${colorHex("USER >", CATHEDRAL_TOKENS.colors.accent)} ${colorHex("Show the htop HUD and memory bullets too.", CATHEDRAL_TOKENS.colors.foreground)}`,
		`${colorHex("TOOL >", CATHEDRAL_TOKENS.colors.states.tool)} ${colorHex("$ pnpm test", CATHEDRAL_TOKENS.colors.foreground)}`,
		colorHex("       ✓ src/sidebar-token-bar.test.ts", CATHEDRAL_TOKENS.colors.states.idle),
		colorHex("       ✓ src/sidebar-mcp-pills.test.ts", CATHEDRAL_TOKENS.colors.states.idle),
		colorHex("       ✓ src/empty-chat-quote.test.ts", CATHEDRAL_TOKENS.colors.states.idle),
		`${colorHex("SUMO >", CATHEDRAL_TOKENS.colors.states.idle)} ${colorHex("Done. ACTIVE_CONTEXT, MCP, ACTIVE_MEMORY, and METRICS now share the §4.2 carved header style.", CATHEDRAL_TOKENS.colors.foreground)}`,
	], tree.root);
	placeChatOverlay(text);
	return tree;
}

let tree: ReturnType<typeof createSidebarTree> | undefined;
let keepAlive: ReturnType<typeof setInterval> | undefined;
const tapeMode = process.env.SUMO_TUI_ISSUE56_TAPE === "1";
function stopTimersAndDispose(): void {
	if (keepAlive) clearInterval(keepAlive);
	keepAlive = undefined;
	tree?.root.dispose();
}

function cleanup(): void {
	stopTimersAndDispose();
	process.stdout.write("\x1b[?25h\x1b[?1049l\x1b[0m");
}

process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[H");
process.on("SIGINT", () => {
	if (tapeMode) {
		stopTimersAndDispose();
		process.exit(130);
	}
	cleanup();
	process.exit(130);
});
if (!tapeMode) process.on("exit", cleanup);

const yoga = await loadYoga();
tree = await createTree(yoga, process.env.SUMO_TUI_ISSUE56_SCENARIO ?? "chat");
renderFrame(tree.root);
keepAlive = setInterval(() => undefined, 1000);
if (tapeMode) {
	setTimeout(() => {
		stopTimersAndDispose();
		process.exit(0);
	}, 1_500);
}
