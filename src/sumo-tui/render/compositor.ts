import { CATHEDRAL_TOKENS } from "../../tokens.js";
import { POSITION_TYPE_ABSOLUTE } from "../layout/yoga.js";
import type { SumoNode, SumoNodeEventHandlerResult } from "../layout/node.js";
import type { MouseEvent } from "../input/mouse.js";
import type { CellBuffer, Rect } from "./buffer.js";

export interface HardwareCursor {
	row: number;
	col: number;
}

export interface CompositeResult {
	hardwareCursor: HardwareCursor | null;
}

export interface CompositeSelectionPass {
	applySelectionHighlight(buffer: CellBuffer): void;
}

export interface CompositeOptions {
	selection?: CompositeSelectionPass;
}

interface RenderableNode extends SumoNode {
	render?: (buffer: CellBuffer, rect: Rect) => void;
	getHardwareCursor?: () => HardwareCursor | null;
	/** A widget such as ScrollBox renders/culls its own children into a viewport. */
	compositeChildren?: boolean;
}

interface HitTestNode extends SumoNode {
	/** Allows scroll containers to translate child hit rects by their current offset. */
	getChildHitOrigin?: (rect: Rect) => { top: number; left: number };
	handleMouseEvent?: (event: MouseEvent) => boolean | void;
}

interface PositionedChild {
	node: SumoNode;
	order: number;
}

function isRenderable(node: SumoNode): node is RenderableNode {
	return "render" in node || "getHardwareCursor" in node;
}

function asHitTestNode(node: SumoNode): HitTestNode {
	return node as HitTestNode;
}

function nodeRect(node: SumoNode, originTop: number, originLeft: number): Rect {
	return {
		top: originTop + node.getComputedTop(),
		left: originLeft + node.getComputedLeft(),
		width: node.getComputedWidth(),
		height: node.getComputedHeight(),
	};
}

function containsPoint(rect: Rect, row: number, col: number): boolean {
	return row >= rect.top && row < rect.top + rect.height && col >= rect.left && col < rect.left + rect.width;
}

function collectCursor(node: SumoNode, current: HardwareCursor | null): HardwareCursor | null {
	if (!isRenderable(node) || !node.getHardwareCursor) return current;
	return node.getHardwareCursor() ?? current;
}

function orderedChildren(node: SumoNode): PositionedChild[] {
	return node.children.map((child, order) => ({ node: child, order })).sort((left, right) => {
		const leftAbs = left.node.getPositionType() === POSITION_TYPE_ABSOLUTE;
		const rightAbs = right.node.getPositionType() === POSITION_TYPE_ABSOLUTE;
		if (leftAbs !== rightAbs) return leftAbs ? 1 : -1;
		if (!leftAbs) return left.order - right.order;
		return left.node.zIndex - right.node.zIndex || left.order - right.order;
	});
}

/**
 * Composite a retained SumoNode tree into a CellBuffer.
 *
 * Source note: absolute origin accumulation mirrors the OpenTUI/Ink adapter's
 * Yoga walk (`docs/spike-research/opentui-island/src/adapters/ink/index.tsx:106-123`),
 * while the retained frame shape follows the OpenTUI host-frame model.
 */
export function composite(root: SumoNode, buffer: CellBuffer, options: CompositeOptions = {}): CompositeResult {
	buffer.setDefaultBackground(CATHEDRAL_TOKENS.colors.background);
	buffer.setDefaultForeground(CATHEDRAL_TOKENS.colors.foreground);
	buffer.clear();

	let hardwareCursor: HardwareCursor | null = null;

	function visit(node: SumoNode, originTop: number, originLeft: number): void {
		const rect = nodeRect(node, originTop, originLeft);
		if (isRenderable(node) && node.render) {
			node.render(buffer, rect);
			hardwareCursor = collectCursor(node, hardwareCursor);
			if (node.compositeChildren === false) return;
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
	options.selection?.applySelectionHighlight(buffer);
	return { hardwareCursor };
}

/** Return the deepest Yoga node whose computed rect contains the zero-based cell. */
export function hitTest(root: SumoNode, row: number, col: number): SumoNode | null {
	function visit(node: SumoNode, originTop: number, originLeft: number): SumoNode | null {
		const rect = nodeRect(node, originTop, originLeft);
		if (!containsPoint(rect, row, col)) return null;

		const hitNode = asHitTestNode(node);
		const childOrigin = hitNode.getChildHitOrigin?.(rect) ?? { top: rect.top, left: rect.left };
		const children = orderedChildren(node);
		for (let index = children.length - 1; index >= 0; index -= 1) {
			const child = children[index];
			if (!child) continue;
			const childHit = visit(child.node, childOrigin.top, childOrigin.left);
			if (childHit) return childHit;
		}

		return node;
	}

	return visit(root, 0, 0);
}

function invokeEventHandler(node: SumoNode, event: MouseEvent): SumoNodeEventHandlerResult {
	const handlers = node.eventHandlers;
	if (event.type === "scroll") return handlers.onScroll?.(node, event);
	if (event.type === "down") return handlers.onMouseDown?.(node, event);
	if (event.type === "up") return handlers.onMouseUp?.(node, event);
	return handlers.onMouseMove?.(node, event);
}

/** Hit-test and bubble a mouse event from deepest target to ancestors. */
export function dispatchMouseEvent(root: SumoNode, event: MouseEvent): boolean {
	let node = hitTest(root, event.row, event.col);
	while (node) {
		const hitNode = asHitTestNode(node);
		if (hitNode.handleMouseEvent?.(event) === true) return true;
		if (invokeEventHandler(node, event) === true) return true;
		node = node.parent ?? null;
	}
	return false;
}
