import { POSITION_TYPE_ABSOLUTE } from "../layout/yoga.js";
import type { SumoNode } from "../layout/node.js";
import type { CellBuffer, Rect } from "./buffer.js";

export interface HardwareCursor {
	row: number;
	col: number;
}

export interface CompositeResult {
	hardwareCursor: HardwareCursor | null;
}

interface RenderableNode extends SumoNode {
	render?: (buffer: CellBuffer, rect: Rect) => void;
	getHardwareCursor?: () => HardwareCursor | null;
}

interface PositionedChild {
	node: SumoNode;
	order: number;
}

function isRenderable(node: SumoNode): node is RenderableNode {
	return "render" in node || "getHardwareCursor" in node;
}

function nodeRect(node: SumoNode, originTop: number, originLeft: number): Rect {
	return {
		top: originTop + node.getComputedTop(),
		left: originLeft + node.getComputedLeft(),
		width: node.getComputedWidth(),
		height: node.getComputedHeight(),
	};
}

function collectCursor(node: SumoNode, current: HardwareCursor | null): HardwareCursor | null {
	if (!isRenderable(node) || !node.getHardwareCursor) return current;
	return node.getHardwareCursor() ?? current;
}

/**
 * Composite a retained SumoNode tree into a CellBuffer.
 *
 * Source note: absolute origin accumulation mirrors the OpenTUI/Ink adapter's
 * Yoga walk (`docs/spike-research/opentui-island/src/adapters/ink/index.tsx:106-123`),
 * while the retained frame shape follows the OpenTUI host-frame model.
 */
export function composite(root: SumoNode, buffer: CellBuffer): CompositeResult {
	let hardwareCursor: HardwareCursor | null = null;

	function visit(node: SumoNode, originTop: number, originLeft: number): void {
		const rect = nodeRect(node, originTop, originLeft);
		if (isRenderable(node) && node.render) {
			node.render(buffer, rect);
			hardwareCursor = collectCursor(node, hardwareCursor);
		}

		const normalChildren: PositionedChild[] = [];
		const absoluteChildren: PositionedChild[] = [];
		node.children.forEach((child, order) => {
			const bucket = child.getPositionType() === POSITION_TYPE_ABSOLUTE ? absoluteChildren : normalChildren;
			bucket.push({ node: child, order });
		});

		for (const child of normalChildren) visit(child.node, rect.top, rect.left);
		absoluteChildren.sort((left, right) => left.node.zIndex - right.node.zIndex || left.order - right.order);
		for (const child of absoluteChildren) visit(child.node, rect.top, rect.left);
	}

	visit(root, 0, 0);
	return { hardwareCursor };
}
