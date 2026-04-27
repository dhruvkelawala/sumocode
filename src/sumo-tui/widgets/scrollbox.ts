import { SumoNode } from "../layout/node.js";
import { FLEX_DIRECTION_COLUMN, POSITION_TYPE_ABSOLUTE, type Yoga, type YogaNode } from "../layout/yoga.js";
import type { KeyEvent } from "../input/key-router.js";
import type { MouseEvent } from "../input/mouse.js";
import { CellBuffer, type Rect } from "../render/buffer.js";
import type { HardwareCursor } from "../render/compositor.js";

interface RenderableNode extends SumoNode {
	render?: (buffer: CellBuffer, rect: Rect) => void;
	getHardwareCursor?: () => HardwareCursor | null;
	compositeChildren?: boolean;
}

interface PositionedChild {
	node: SumoNode;
	order: number;
}

export interface ScrollBoxStateChange {
	scrollOffset: number;
	scrollHeight: number;
	viewportHeight: number;
	manualScroll: boolean;
	atBottom: boolean;
}

export interface ScrollBoxOptions {
	readonly stickyBottom?: boolean;
	readonly scrollAcceleration?: number;
	readonly onScrollStateChange?: (state: ScrollBoxStateChange) => void;
}

function clampInteger(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, Math.round(value)));
}

function isRenderable(node: SumoNode): node is RenderableNode {
	return "render" in node || "getHardwareCursor" in node;
}

function intersectsViewport(rect: Rect, viewport: Rect): boolean {
	return rect.top < viewport.top + viewport.height && rect.top + rect.height > viewport.top && rect.left < viewport.left + viewport.width && rect.left + rect.width > viewport.left;
}

function orderedChildBuckets(node: SumoNode): { normal: PositionedChild[]; absolute: PositionedChild[] } {
	const normal: PositionedChild[] = [];
	const absolute: PositionedChild[] = [];
	node.children.forEach((child, order) => {
		const bucket = child.getPositionType() === POSITION_TYPE_ABSOLUTE ? absolute : normal;
		bucket.push({ node: child, order });
	});
	absolute.sort((left, right) => left.node.zIndex - right.node.zIndex || left.order - right.order);
	return { normal, absolute };
}

function eventInside(rect: Rect | undefined, event: MouseEvent): boolean {
	if (!rect) return false;
	return event.row >= rect.top && event.row < rect.top + rect.height && event.col >= rect.left && event.col < rect.left + rect.width;
}

/**
 * Retained in-app scroll container for altscreen chat history.
 *
 * The sticky-bottom shape mirrors OpenCode's session view
 * (`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1058-1075`),
 * where a `<scrollbox stickyScroll stickyStart="bottom">` owns chat scrollback
 * inside the alternate screen instead of leaking wheel input to terminal history.
 */
export class ScrollBox extends SumoNode {
	public scrollOffset = 0;
	public scrollHeight = 0;
	public viewportHeight = 0;
	public manualScroll = false;
	public stickyBottom: boolean;
	public scrollAcceleration: number;
	public readonly compositeChildren = false;
	private readonly onScrollStateChange: ((state: ScrollBoxStateChange) => void) | undefined;
	private lastRect: Rect | undefined;
	private hardwareCursor: HardwareCursor | null = null;
	private lastEmittedState: ScrollBoxStateChange | undefined;

	public constructor(yogaNode: YogaNode, parent?: SumoNode, options: ScrollBoxOptions = {}) {
		super(yogaNode, parent);
		this.stickyBottom = options.stickyBottom ?? false;
		this.scrollAcceleration = Math.max(1, Math.round(options.scrollAcceleration ?? 3));
		this.onScrollStateChange = options.onScrollStateChange;
		this.flexGrow = 1;
		this.flexShrink = 1;
		this.flexDirection = FLEX_DIRECTION_COLUMN;
	}

	public static create(yoga: Yoga, parent?: SumoNode, options: ScrollBoxOptions = {}): ScrollBox {
		return new ScrollBox(yoga.Node.create(), parent, options);
	}

	public override addChild(node: SumoNode): void {
		super.addChild(node);
		this.recomputeScrollHeight();
		this.applyStickyOrClamp(false);
	}

	public override removeChild(node: SumoNode): void {
		super.removeChild(node);
		this.recomputeScrollHeight();
		this.applyStickyOrClamp(false);
	}

	public getMaxScrollOffset(): number {
		return Math.max(0, this.scrollHeight - this.viewportHeight);
	}

	public scrollTo(offset: number): void {
		this.setScrollOffset(offset, true);
	}

	public scrollBy(delta: number): void {
		this.setScrollOffset(this.scrollOffset + delta, true);
	}

	public scrollToBottom(): void {
		this.setScrollOffset(this.getMaxScrollOffset(), true);
	}

	public isAtBottom(): boolean {
		return this.scrollOffset >= this.getMaxScrollOffset();
	}

	/** Re-read Yoga-computed child metrics after a layout pass. */
	public syncLayoutMetrics(viewportHeight = this.getComputedHeight()): void {
		this.viewportHeight = Math.max(0, Math.round(viewportHeight));
		this.recomputeScrollHeight();
		this.applyStickyOrClamp(false);
	}

	/**
	 * Notify batched content changes. For top removals (virtualization) we subtract
	 * removed rows from the top-based offset; pure appends preserve the offset so
	 * Edge Case 2.5 (streaming while scrolled up) keeps the same visible anchor.
	 */
	public notifyContentChanged(addedLines: number, removedLines: number): void {
		const previousOffset = this.scrollOffset;
		this.scrollHeight = Math.max(0, this.scrollHeight + Math.max(0, addedLines) - Math.max(0, removedLines));
		if (this.stickyBottom && !this.manualScroll) {
			this.setScrollOffset(this.getMaxScrollOffset(), false);
			return;
		}
		this.setScrollOffset(previousOffset - Math.max(0, removedLines), false);
	}

	public render(buffer: CellBuffer, rect: Rect): void {
		this.lastRect = rect;
		this.hardwareCursor = null;
		this.syncLayoutMetrics(rect.height);

		const viewportBuffer = new CellBuffer(rect.height, rect.width);
		const viewport: Rect = { top: 0, left: 0, width: rect.width, height: rect.height };
		for (const child of this.children) {
			this.renderSubtree(child, -this.scrollOffset, 0, viewportBuffer, viewport, rect);
		}

		for (let row = 0; row < rect.height; row += 1) {
			for (let col = 0; col < rect.width; col += 1) {
				buffer.setCell(rect.top + row, rect.left + col, viewportBuffer.getCell(row, col));
			}
		}
	}

	public getHardwareCursor(): HardwareCursor | null {
		return this.hardwareCursor;
	}

	public getChildHitOrigin(rect: Rect): { top: number; left: number } {
		return { top: rect.top - this.scrollOffset, left: rect.left };
	}

	public handleMouseEvent(event: MouseEvent): boolean {
		if (event.type !== "scroll" || !eventInside(this.lastRect, event)) return false;
		this.scrollBy(event.scrollDir === "up" ? -this.scrollAcceleration : this.scrollAcceleration);
		return true;
	}

	public handleKey(event: KeyEvent): boolean {
		const key = event.key.toLowerCase();
		if (key === "pageup" || key === "pgup") {
			// OpenCode pages messages by a viewport fraction (`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:686-770`).
			this.scrollBy(-this.halfPage());
			return true;
		}
		if (key === "pagedown" || key === "pgdn") {
			this.scrollBy(this.halfPage());
			return true;
		}
		if (key === "home") {
			this.scrollTo(0);
			return true;
		}
		if (key === "end") {
			this.scrollToBottom();
			this.manualScroll = false;
			this.emitStateIfChanged();
			return true;
		}
		// EC-13.2: drag-selection across messages is intentionally not claimed here;
		// terminal-native selection requires a later selection model so we let drags bubble.
		return false;
	}

	private halfPage(): number {
		return Math.max(1, Math.floor(this.viewportHeight / 2));
	}

	private setScrollOffset(offset: number, fromUser: boolean): void {
		this.recomputeScrollHeight();
		const nextOffset = clampInteger(offset, 0, this.getMaxScrollOffset());
		this.scrollOffset = nextOffset;
		if (fromUser) this.manualScroll = !this.isAtBottom();
		else if (this.isAtBottom()) this.manualScroll = false;
		this.emitStateIfChanged();
	}

	private applyStickyOrClamp(fromUser: boolean): void {
		if (this.stickyBottom && !this.manualScroll) {
			this.setScrollOffset(this.getMaxScrollOffset(), false);
			return;
		}
		this.setScrollOffset(this.scrollOffset, fromUser);
	}

	private recomputeScrollHeight(): void {
		let bottom = 0;
		for (const child of this.children) {
			bottom = Math.max(bottom, child.getComputedTop() + child.getComputedHeight());
		}
		this.scrollHeight = Math.max(0, Math.round(bottom));
	}

	private renderSubtree(node: SumoNode, originTop: number, originLeft: number, target: CellBuffer, viewport: Rect, parentRect: Rect): void {
		const childRect: Rect = {
			top: originTop + node.getComputedTop(),
			left: originLeft + node.getComputedLeft(),
			width: node.getComputedWidth(),
			height: node.getComputedHeight(),
		};

		if (!intersectsViewport(childRect, viewport)) return;

		if (isRenderable(node) && node.render) {
			node.render(target, childRect);
			this.collectChildCursor(node, parentRect, viewport);
			if (node.compositeChildren === false) return;
		}

		const buckets = orderedChildBuckets(node);
		for (const child of buckets.normal) this.renderSubtree(child.node, childRect.top, childRect.left, target, viewport, parentRect);
		for (const child of buckets.absolute) this.renderSubtree(child.node, childRect.top, childRect.left, target, viewport, parentRect);
	}

	private collectChildCursor(node: RenderableNode, parentRect: Rect, viewport: Rect): void {
		if (!node.getHardwareCursor) return;
		const cursor = node.getHardwareCursor();
		if (!cursor) return;
		if (cursor.row < viewport.top || cursor.row >= viewport.top + viewport.height || cursor.col < viewport.left || cursor.col >= viewport.left + viewport.width) return;
		this.hardwareCursor = { row: parentRect.top + cursor.row, col: parentRect.left + cursor.col };
	}

	private emitStateIfChanged(): void {
		if (!this.onScrollStateChange) return;
		const state: ScrollBoxStateChange = {
			scrollOffset: this.scrollOffset,
			scrollHeight: this.scrollHeight,
			viewportHeight: this.viewportHeight,
			manualScroll: this.manualScroll,
			atBottom: this.isAtBottom(),
		};
		const previous = this.lastEmittedState;
		if (
			previous &&
			previous.scrollOffset === state.scrollOffset &&
			previous.scrollHeight === state.scrollHeight &&
			previous.viewportHeight === state.viewportHeight &&
			previous.manualScroll === state.manualScroll &&
			previous.atBottom === state.atBottom
		) {
			return;
		}
		this.lastEmittedState = state;
		this.onScrollStateChange(state);
	}
}
