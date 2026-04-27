import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga, type Yoga } from "../layout/yoga.js";
import { bufferToAnsiLines } from "../render/ansi-writer.js";
import { CellBuffer } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import { FrameScheduler } from "../runtime/frame-scheduler.js";
import { installLifecycle } from "../runtime/lifecycle.js";
import { ChatPager } from "../widgets/chat-pager.js";

interface DemoState {
	root: SumoNode;
	chat: ChatPager;
	scheduler: FrameScheduler;
}

function terminalSize(): { cols: number; rows: number } {
	const cols = process.stdout.columns;
	const rows = process.stdout.rows;
	return { cols: cols && cols > 0 ? cols : 80, rows: rows && rows > 0 ? rows : 24 };
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

function createDemoState(yoga: Yoga): DemoState {
	let state: DemoState;
	const root = new SumoNode(yoga.Node.create());
	root.flexDirection = FLEX_DIRECTION_COLUMN;
	const scheduler = new FrameScheduler({
		frameIntervalMs: 17,
		render: () => renderFrame(root),
	});
	const chat = ChatPager.create(yoga, root, {
		renderControls: {
			scheduleRender: () => scheduler.requestRender(),
			setStreamingMode: (enabled) => (enabled ? scheduler.enterStreamingMode() : scheduler.exitStreamingMode()),
		},
	});
	state = { root, chat, scheduler };
	return state;
}

function seedMessages(chat: ChatPager, count: number): void {
	for (let index = 0; index < count; index += 1) {
		chat.addMessage(index % 2 === 0 ? "user" : "sumo", index % 2 === 0 ? `Question ${index / 2 + 1}?` : `Answer ${Math.ceil(index / 2)} from the in-app ScrollBox.`);
	}
}

function runStreamingDemo(state: DemoState): void {
	seedMessages(state.chat, 5);
	state.chat.addMessage("sumo", "Streaming: ");
	renderFrame(state.root);
	const chunks = ["sticky ", "bottom ", "holds ", "while ", "chunks ", "arrive ", "inside ", "altscreen."];
	let index = 0;
	const timer = setInterval(() => {
		state.chat.appendToLast(chunks[index] ?? "");
		index += 1;
		if (index >= chunks.length) {
			clearInterval(timer);
			state.chat.endStreaming();
		}
	}, 90);
}

function runBannerDemo(state: DemoState): void {
	seedMessages(state.chat, 60);
	renderFrame(state.root);
	setTimeout(() => {
		state.chat.scrollBox.scrollToBottom();
		state.chat.handleKey({ key: "PageUp" });
		state.chat.addMessage("sumo", "A new answer arrived while you were reading history.");
		renderFrame(state.root);
	}, 450);
}

export default function sumoTuiPhase3ChatDemo(pi: ExtensionAPI): void {
	installLifecycle(pi);
	let state: DemoState | undefined;
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		void loadYoga().then((yoga) => {
			state = createDemoState(yoga);
			if (process.env.SUMO_TUI_PHASE3_DEMO === "banner") runBannerDemo(state);
			else runStreamingDemo(state);
		});
	});
	pi.on("session_shutdown", () => {
		state?.scheduler.dispose();
		state?.root.dispose();
		state = undefined;
	});
}
