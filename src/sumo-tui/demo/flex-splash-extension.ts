import type { CustomEditor, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga } from "../layout/yoga.js";
import { bufferToAnsiLines } from "../render/ansi-writer.js";
import { CellBuffer } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import { installLifecycle } from "../runtime/lifecycle.js";
import { PiComponentLeaf } from "../widgets/pi-component-leaf.js";
import { PiEditorLeaf } from "../widgets/pi-editor-leaf.js";

class SplashEditor implements Component {
	public invalidate(): void {}
	public render(width: number): string[] {
		const prompt = `sumo-tui Phase 2 ${CURSOR_MARKER}`;
		const pad = Math.max(0, Math.floor((width - visibleWidth(prompt)) / 2));
		return [" ".repeat(pad) + prompt, "", "Yoga flex centers this editor leaf."];
	}
}

function asEditor(component: Component): CustomEditor {
	return component as unknown as CustomEditor;
}

async function renderSplash(): Promise<void> {
	const cols = process.stdout.columns ?? 80;
	const rows = process.stdout.rows ?? 24;
	const yoga = await loadYoga();
	const root = new SumoNode(yoga.Node.create());
	const topSpacer = new SumoNode(yoga.Node.create(), root);
	const editor = new PiEditorLeaf(yoga.Node.create(), asEditor(new SplashEditor()), root);
	const bottomSpacer = new SumoNode(yoga.Node.create(), root);
	const footer = PiComponentLeaf.create(yoga, new Text("footer pinned by Yoga flex", 0, 0), root);

	root.width = cols;
	root.height = rows;
	root.flexDirection = FLEX_DIRECTION_COLUMN;
	topSpacer.flexGrow = 1;
	topSpacer.flexShrink = 1;
	editor.height = 3;
	bottomSpacer.flexGrow = 1;
	bottomSpacer.flexShrink = 1;
	footer.height = 1;

	root.yogaNode.calculateLayout(cols, rows, DIRECTION_LTR);
	const buffer = new CellBuffer(rows, cols);
	const result = composite(root, buffer);
	const frame = bufferToAnsiLines(buffer).join("\r\n");
	const cursor = result.hardwareCursor ? `\x1b[${result.hardwareCursor.row + 1};${result.hardwareCursor.col + 1}H` : "";
	process.stdout.write(`\x1b[?2026h\x1b[2J\x1b[H${frame}${cursor}\x1b[?2026l`);
	root.dispose();
}

export default function sumoTuiPhase2Splash(pi: ExtensionAPI): void {
	installLifecycle(pi);
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		void renderSplash();
	});
}
