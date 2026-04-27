import type {
	KeybindingsManager,
	ReadonlyFooterDataProvider,
	Theme,
} from "@mariozechner/pi-coding-agent";
import type { Component, EditorComponent, EditorTheme, OverlayOptions, TUI } from "@mariozechner/pi-tui";
import { SumoNode } from "../layout/node.js";
import {
	FLEX_DIRECTION_COLUMN,
	POSITION_TYPE_ABSOLUTE,
	type Yoga,
} from "../layout/yoga.js";
import { PiComponentLeaf } from "../widgets/pi-component-leaf.js";
import { PiEditorLeaf } from "../widgets/pi-editor-leaf.js";
import type { CustomEditor } from "@mariozechner/pi-coding-agent";

export type RegionSlotName =
	| "header"
	| "footer"
	| "editor"
	| "aboveEditor"
	| "belowEditor"
	| "chat"
	| "pending"
	| "status"
	| "widgets-default";

export type WidgetPlacement = "aboveEditor" | "belowEditor" | "default";
export type DisposableComponent = Component & { dispose?(): void };

export type HeaderMount =
	| readonly string[]
	| DisposableComponent
	| ((tui: TUI, theme: Theme) => DisposableComponent);

export type FooterMount =
	| readonly string[]
	| DisposableComponent
	| ((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => DisposableComponent);

export type WidgetMount =
	| readonly string[]
	| DisposableComponent
	| ((tui: TUI, theme: Theme) => DisposableComponent);

export interface RegionRegistryOptions {
	readonly yoga: Yoga;
	readonly tui: TUI;
	readonly theme: Theme;
	readonly editorTheme: EditorTheme;
	readonly keybindings: KeybindingsManager;
	readonly footerData?: ReadonlyFooterDataProvider;
	readonly root?: SumoNode;
	readonly onChange?: () => void;
}

interface MountedRegion {
	readonly key: string;
	readonly slot: RegionSlotName | "overlay";
	readonly node: SumoNode;
	readonly component: DisposableComponent;
}

class StaticTextComponent implements Component {
	public constructor(private readonly lines: readonly string[]) {}
	public invalidate(): void {}
	public render(_width: number): string[] {
		return [...this.lines];
	}
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value);
}

function isComponent(value: unknown): value is DisposableComponent {
	return typeof value === "object" && value !== null && "render" in value && typeof (value as Component).render === "function";
}

function safeDispose(component: DisposableComponent): void {
	try {
		component.dispose?.();
	} catch (error) {
		console.debug("sumo-tui: component dispose failed", error);
	}
}

function placementToSlot(placement: WidgetPlacement | undefined): RegionSlotName {
	if (placement === "belowEditor") return "belowEditor";
	if (placement === "default") return "widgets-default";
	return "aboveEditor";
}

function percentToCells(value: number | `${number}%` | undefined, total: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	return Math.max(0, Math.floor((Number.parseFloat(value) / 100) * total));
}

/**
 * Named SumoCode slots for Pi extension UI hooks.
 *
 * Source: Pi 0.70.2 wires extension UI through `createExtensionUIContext()` and
 * delegates `setWidget`, `setFooter`, `setHeader`, `custom`, and
 * `setEditorComponent` to mutable pi-tui containers at
 * `node_modules/.pnpm/@mariozechner+pi-coding-agent@0.70.2.../dist/modes/interactive/interactive-mode.js:1522-1557`.
 * This registry is the retained-Yoga replacement for those mutable containers.
 */
export class RegionRegistry {
	public readonly root: SumoNode;
	private readonly yoga: Yoga;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly editorTheme: EditorTheme;
	private readonly keybindings: KeybindingsManager;
	private readonly footerData: ReadonlyFooterDataProvider | undefined;
	private readonly onChange: () => void;
	private readonly slots: Record<RegionSlotName, SumoNode>;
	private readonly overlayRoot: SumoNode;
	private readonly mounts = new Map<string, MountedRegion>();

	public constructor(options: RegionRegistryOptions) {
		this.yoga = options.yoga;
		this.tui = options.tui;
		this.theme = options.theme;
		this.editorTheme = options.editorTheme;
		this.keybindings = options.keybindings;
		this.footerData = options.footerData;
		this.onChange = options.onChange ?? (() => undefined);
		this.root = options.root ?? new SumoNode(this.yoga.Node.create());
		this.root.flexDirection = FLEX_DIRECTION_COLUMN;

		this.slots = {
			header: this.createSlot("header"),
			chat: this.createFlexSlot("chat"),
			pending: this.createSlot("pending"),
			status: this.createSlot("status"),
			"widgets-default": this.createSlot("widgets-default"),
			aboveEditor: this.createSlot("aboveEditor"),
			editor: this.createSlot("editor"),
			belowEditor: this.createSlot("belowEditor"),
			footer: this.createSlot("footer"),
		};

		this.overlayRoot = new SumoNode(this.yoga.Node.create(), this.root);
		this.overlayRoot.position = POSITION_TYPE_ABSOLUTE;
		this.overlayRoot.top = 0;
		this.overlayRoot.left = 0;
		this.overlayRoot.right = 0;
		this.overlayRoot.bottom = 0;
		this.overlayRoot.zIndex = 10_000;
	}

	public getSlot(name: RegionSlotName): SumoNode {
		return this.slots[name];
	}

	public getMountedKeys(): string[] {
		return [...this.mounts.keys()];
	}

	public getMounted(key: string): MountedRegion | undefined {
		return this.mounts.get(key);
	}

	public mountHeader(content: HeaderMount | undefined): void {
		this.mount("__header", "header", content === undefined ? undefined : this.resolveHeader(content));
	}

	public mountFooter(content: FooterMount | undefined): void {
		this.mount("__footer", "footer", content === undefined ? undefined : this.resolveFooter(content));
	}

	public mountEditor(factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent) | undefined): void {
		this.unmount("__editor");
		if (!factory) {
			this.onChange();
			return;
		}

		const component = factory(this.tui, this.editorTheme, this.keybindings) as unknown as DisposableComponent;
		const node = PiEditorLeaf.create(this.yoga, component as unknown as CustomEditor, this.slots.editor);
		this.mounts.set("__editor", { key: "__editor", slot: "editor", node, component });
		this.onChange();
	}

	public mountWidget(key: string, content: WidgetMount | undefined, opts: { placement?: WidgetPlacement } = {}): void {
		this.unmount(key);
		if (content === undefined) {
			this.onChange();
			return;
		}
		this.mount(key, placementToSlot(opts.placement), this.resolveWidget(content));
	}

	public mountOverlay(key: string, component: DisposableComponent | undefined, overlayOptions?: OverlayOptions | (() => OverlayOptions)): void {
		this.unmount(key);
		if (!component) {
			this.onChange();
			return;
		}
		const node = PiComponentLeaf.create(this.yoga, component, this.overlayRoot);
		node.position = POSITION_TYPE_ABSOLUTE;
		node.zIndex = this.mounts.size + 1;
		this.applyOverlayOptions(node, overlayOptions);
		this.mounts.set(key, { key, slot: "overlay", node, component });
		this.onChange();
	}

	public unmount(key: string): void {
		const existing = this.mounts.get(key);
		if (!existing) return;
		this.mounts.delete(key);
		safeDispose(existing.component);
		existing.node.dispose();
		this.onChange();
	}

	public clear(): void {
		for (const key of [...this.mounts.keys()]) this.unmount(key);
	}

	public dispose(): void {
		this.clear();
		this.root.dispose();
	}

	private createSlot(_name: RegionSlotName): SumoNode {
		const slot = new SumoNode(this.yoga.Node.create(), this.root);
		slot.flexDirection = FLEX_DIRECTION_COLUMN;
		return slot;
	}

	private createFlexSlot(name: RegionSlotName): SumoNode {
		const slot = this.createSlot(name);
		slot.flexGrow = 1;
		slot.flexShrink = 1;
		return slot;
	}

	private mount(key: string, slot: RegionSlotName, component: DisposableComponent | undefined): void {
		this.unmount(key);
		if (!component) {
			this.onChange();
			return;
		}
		const node = PiComponentLeaf.create(this.yoga, component, this.slots[slot]);
		this.mounts.set(key, { key, slot, node, component });
		this.onChange();
	}

	private resolveHeader(content: HeaderMount): DisposableComponent {
		if (isStringArray(content)) return new StaticTextComponent(content);
		if (isComponent(content)) return content;
		return content(this.tui, this.theme);
	}

	private resolveFooter(content: FooterMount): DisposableComponent {
		if (isStringArray(content)) return new StaticTextComponent(content);
		if (isComponent(content)) return content;
		return content(this.tui, this.theme, this.footerData ?? this.createEmptyFooterData());
	}

	private resolveWidget(content: WidgetMount): DisposableComponent {
		if (isStringArray(content)) return new StaticTextComponent(content);
		if (isComponent(content)) return content;
		return content(this.tui, this.theme);
	}

	private createEmptyFooterData(): ReadonlyFooterDataProvider {
		return {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map<string, string>(),
			getAvailableProviderCount: () => 0,
			onBranchChange: () => () => undefined,
		} as ReadonlyFooterDataProvider;
	}

	private applyOverlayOptions(node: SumoNode, overlayOptions: OverlayOptions | (() => OverlayOptions) | undefined): void {
		const options = typeof overlayOptions === "function" ? overlayOptions() : overlayOptions;
		const terminal = this.tui.terminal as { columns?: number; rows?: number } | undefined;
		const columns = terminal?.columns ?? 80;
		const rows = terminal?.rows ?? 24;
		const width = percentToCells(options?.width, columns) ?? Math.min(60, columns);
		const maxHeight = percentToCells(options?.maxHeight, rows);
		node.width = width;
		if (maxHeight !== undefined) node.height = maxHeight;

		if (options?.anchor === "top-right") {
			node.top = options.offsetY ?? 0;
			node.right = Math.abs(options.offsetX ?? 0);
			return;
		}
		if (options?.anchor === "bottom-right") {
			node.bottom = Math.abs(options.offsetY ?? 0);
			node.right = Math.abs(options.offsetX ?? 0);
			return;
		}
		if (options?.anchor === "right-center") {
			node.top = Math.max(0, Math.floor(rows / 2) + (options.offsetY ?? 0));
			node.right = Math.abs(options.offsetX ?? 0);
			return;
		}
		node.top = options?.row === undefined ? Math.max(0, Math.floor(rows / 3)) : (percentToCells(options.row, rows) ?? 0);
		node.left = options?.col === undefined ? Math.max(0, Math.floor((columns - width) / 2)) : (percentToCells(options.col, columns) ?? 0);
	}
}

export { StaticTextComponent };
