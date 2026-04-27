import { CATHEDRAL_TOKENS } from "../../tokens.js";
import { SumoNode } from "../layout/node.js";
import type { Yoga, YogaNode } from "../layout/yoga.js";
import type { MouseEvent } from "../input/mouse.js";
import type { CellBuffer, Rect } from "../render/buffer.js";

export interface ScrolledUpBannerOptions {
	readonly isVisible: () => boolean;
	readonly getUnreadCount: () => number;
	readonly onJumpToBottom: () => void;
}

function fg(hexColor: string): string {
	const hex = hexColor.startsWith("#") ? hexColor.slice(1) : hexColor;
	const red = Number.parseInt(hex.slice(0, 2), 16);
	const green = Number.parseInt(hex.slice(2, 4), 16);
	const blue = Number.parseInt(hex.slice(4, 6), 16);
	return `\x1b[38;2;${red};${green};${blue}m`;
}

/** Overlay shown when chat is manually scrolled away from sticky-bottom. */
export class ScrolledUpBanner extends SumoNode {
	private lastRect: Rect | undefined;
	private readonly isVisible: () => boolean;
	private readonly getUnreadCount: () => number;
	private readonly onJumpToBottom: () => void;

	public constructor(yogaNode: YogaNode, parent: SumoNode | undefined, options: ScrolledUpBannerOptions) {
		super(yogaNode, parent);
		this.isVisible = options.isVisible;
		this.getUnreadCount = options.getUnreadCount;
		this.onJumpToBottom = options.onJumpToBottom;
		this.position = "absolute";
		this.left = 0;
		this.right = 0;
		this.bottom = 0;
		this.height = 1;
		this.zIndex = 100;
	}

	public static create(yoga: Yoga, parent: SumoNode | undefined, options: ScrolledUpBannerOptions): ScrolledUpBanner {
		return new ScrolledUpBanner(yoga.Node.create(), parent, options);
	}

	public render(buffer: CellBuffer, rect: Rect): void {
		this.lastRect = rect;
		if (!this.isVisible()) return;
		const unread = this.getUnreadCount();
		const noun = unread === 1 ? "message" : "messages";
		const label = `↓ ${unread} new ${noun} — Press End to jump`;
		const styled = `\x1b[2m${fg(CATHEDRAL_TOKENS.colors.foregroundDim)}${label}\x1b[0m`;
		buffer.paintRow(rect.top, styled, rect.left, rect.width);
	}

	public handleMouseEvent(event: MouseEvent): boolean {
		if (event.type !== "down" || !this.isVisible() || !this.lastRect) return false;
		const inside = event.row >= this.lastRect.top && event.row < this.lastRect.top + this.lastRect.height && event.col >= this.lastRect.left && event.col < this.lastRect.left + this.lastRect.width;
		if (!inside) return false;
		this.onJumpToBottom();
		return true;
	}
}
