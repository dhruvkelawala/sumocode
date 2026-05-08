import type { Component } from "@earendil-works/pi-tui";
import { SumoNode } from "../layout/node.js";
import { FLEX_DIRECTION_COLUMN, type Yoga } from "../layout/yoga.js";
import { PiComponentLeaf } from "../widgets/pi-component-leaf.js";
import {
	renderSplashContent,
	SUMOCODE_QUOTE,
	SUMOCODE_QUOTE_ATTRIBUTION,
	type SplashSnapshot,
} from "../../splash.js";

export type SplashSnapshotProvider = () => SplashSnapshot;

export interface SplashTree {
	readonly root: SumoNode;
	readonly topSpacer: SumoNode;
	readonly content: PiComponentLeaf;
	readonly bottomSpacer: SumoNode;
	/** Collapse the tree once the first message arrives (EC-17.4 / 17.6). */
	syncVisibility(): void;
	setDimmed(dimmed: boolean): void;
}

export function defaultSplashSnapshot(hasMessages = false): SplashSnapshot {
	return {
		quote: SUMOCODE_QUOTE,
		quoteAttribution: SUMOCODE_QUOTE_ATTRIBUTION,
		hasMessages,
	};
}

export function getSplashContentHeight(snapshot: SplashSnapshot, width: number): number {
	return renderSplashContent(snapshot, width).length;
}

class SplashContentComponent implements Component {
	private dimmed = false;
	public constructor(private readonly snapshot: SplashSnapshotProvider) {}
	public invalidate(): void {}
	public setDimmed(dimmed: boolean): void {
		this.dimmed = dimmed;
	}
	public render(width: number): string[] {
		const snapshot = this.snapshot();
		const rows = renderSplashContent(this.dimmed ? { ...snapshot, hasMessages: false } : snapshot, width);
		if (!this.dimmed) return rows;
		return rows.map((row) => `\u001b[2m${row}\u001b[0m`);
	}
}

/**
 * Yoga-centered cathedral splash.
 *
 * The shape is intentionally tiny and declarative:
 *   Root(column, flexGrow=1)
 *     TopSpacer(flexGrow=1)
 *     SplashContent(PiComponentLeaf, intrinsic fixed row count)
 *     BottomSpacer(flexGrow=1)
 *
 * There is no viewport padding or chrome-reservation math here; Yoga splits the
 * free rows between the two spacers at any terminal height.
 */
export function createSplashTree(yoga: Yoga, parent: SumoNode | undefined, snapshot: SplashSnapshotProvider): SplashTree {
	const root = new SumoNode(yoga.Node.create(), parent);
	root.flexDirection = FLEX_DIRECTION_COLUMN;
	root.flexGrow = 1;
	root.flexShrink = 1;

	const topSpacer = new SumoNode(yoga.Node.create(), root);
	topSpacer.flexGrow = 1;
	topSpacer.flexShrink = 1;

	const contentComponent = new SplashContentComponent(snapshot);
	let forceVisible = false;
	const content = PiComponentLeaf.create(yoga, contentComponent, root);
	content.flexShrink = 0;

	const bottomSpacer = new SumoNode(yoga.Node.create(), root);
	bottomSpacer.flexGrow = 1;
	bottomSpacer.flexShrink = 1;

	return {
		root,
		topSpacer,
		content,
		bottomSpacer,
		syncVisibility(): void {
			if (snapshot().hasMessages && !forceVisible) {
				root.height = 0;
				root.flexGrow = 0;
				root.flexShrink = 0;
				return;
			}
			root.yogaNode.setHeightAuto();
			root.flexGrow = 1;
			root.flexShrink = 1;
		},
		setDimmed(dimmed: boolean): void {
			forceVisible = dimmed;
			contentComponent.setDimmed(dimmed);
		},
	};
}
