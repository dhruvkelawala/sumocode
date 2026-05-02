import type {
	KeybindingsManager,
	ReadonlyFooterDataProvider,
	Theme,
} from "@mariozechner/pi-coding-agent";
import type { Component, EditorComponent, EditorTheme, OverlayOptions, TUI } from "@mariozechner/pi-tui";
import { SumoNode } from "../layout/node.js";
import {
	FLEX_DIRECTION_COLUMN,
	FLEX_DIRECTION_ROW,
	POSITION_TYPE_ABSOLUTE,
	type Yoga,
} from "../layout/yoga.js";
import { ModalBackdropNode, ModalSurfaceComponent } from "../widgets/modal-layer.js";
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
	| "widgets-default"
	| "sidebar";

export type WidgetPlacement = "aboveEditor" | "belowEditor" | "default" | "sidebar" | "modal";
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

function placementToSlot(placement: Exclude<WidgetPlacement, "modal"> | undefined): RegionSlotName {
	if (placement === "belowEditor") return "belowEditor";
	if (placement === "default") return "widgets-default";
	if (placement === "sidebar") return "sidebar";
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
	private mountedChatNode: SumoNode | undefined;

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

		const header = this.createSlot("header", this.root);
		const main = new SumoNode(this.yoga.Node.create(), this.root);
		main.flexDirection = FLEX_DIRECTION_ROW;
		main.flexGrow = 1;
		main.flexShrink = 1;

		const content = new SumoNode(this.yoga.Node.create(), main);
		content.flexDirection = FLEX_DIRECTION_COLUMN;
		content.flexGrow = 1;
		content.flexShrink = 1;

		this.slots = {
			header,
			chat: this.createFlexSlot("chat", content),
			pending: this.createSlot("pending", content),
			status: this.createSlot("status", content),
			"widgets-default": this.createSlot("widgets-default", content),
			aboveEditor: this.createSlot("aboveEditor", content),
			editor: this.createSlot("editor", content),
			belowEditor: this.createSlot("belowEditor", content),
			sidebar: this.createSlot("sidebar", main),
			footer: this.createSlot("footer", this.root),
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

	public mountChat(node: SumoNode | undefined): void {
		if (this.mountedChatNode) {
			this.slots.chat.removeChild(this.mountedChatNode);
			this.mountedChatNode = undefined;
		}
		if (node) {
			this.slots.chat.addChild(node);
			this.mountedChatNode = node;
		}
		this.onChange();
	}

	public mountWidget(key: string, content: WidgetMount | undefined, opts: { placement?: WidgetPlacement } = {}): void {
		this.unmount(key);
		if (content === undefined) {
			this.onChange();
			return;
		}
		if (opts.placement === "modal") {
			this.mountModal(key, this.resolveWidget(content), { anchor: "center", width: "65%", maxHeight: "80%" });
			return;
		}
		const slot = placementToSlot(opts.placement);
		if (slot === "sidebar") {
			this.slots.sidebar.width = 30;
			this.slots.sidebar.flexShrink = 0;
		}
		this.mount(key, slot, this.resolveWidget(content));
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

	public mountModal(key: string, component: DisposableComponent | undefined, overlayOptions?: OverlayOptions | (() => OverlayOptions)): void {
		this.unmount(key);
		if (!component) {
			this.onChange();
			return;
		}
		const surface = new ModalSurfaceComponent(component);
		const width = this.resolveOverlayWidth(
			typeof overlayOptions === "function" ? overlayOptions() : overlayOptions,
			((this.tui.terminal as { columns?: number } | undefined)?.columns ?? 80),
		);
		const backdrop = new ModalBackdropNode(this.yoga.Node.create(), this.overlayRoot, () => surface.isVisible(width));
		backdrop.position = POSITION_TYPE_ABSOLUTE;
		backdrop.top = 0;
		backdrop.left = 0;
		backdrop.right = 0;
		backdrop.bottom = 0;
		backdrop.zIndex = this.mounts.size + 1;

		const node = PiComponentLeaf.create(this.yoga, surface, backdrop);
		node.position = POSITION_TYPE_ABSOLUTE;
		node.zIndex = 1;
		this.applyModalOptions(node, surface, overlayOptions);
		this.mounts.set(key, { key, slot: "overlay", node: backdrop, component: surface });
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
		this.mountChat(undefined);
		this.root.dispose();
	}

	private createSlot(_name: RegionSlotName, parent: SumoNode): SumoNode {
		const slot = new SumoNode(this.yoga.Node.create(), parent);
		slot.flexDirection = FLEX_DIRECTION_COLUMN;
		return slot;
	}

	private createFlexSlot(name: RegionSlotName, parent: SumoNode): SumoNode {
		const slot = this.createSlot(name, parent);
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
		const width = this.resolveOverlayWidth(options, columns);
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

	private applyModalOptions(node: SumoNode, surface: ModalSurfaceComponent, overlayOptions: OverlayOptions | (() => OverlayOptions) | undefined): void {
		const options = typeof overlayOptions === "function" ? overlayOptions() : overlayOptions;
		const terminal = this.tui.terminal as { columns?: number; rows?: number } | undefined;
		const columns = terminal?.columns ?? 80;
		const rows = terminal?.rows ?? 24;
		const width = this.resolveOverlayWidth(options, columns);
		const maxHeight = percentToCells(options?.maxHeight, rows);
		const contentHeight = surface.render(width).length;
		const height = maxHeight === undefined ? contentHeight : Math.min(maxHeight, contentHeight);
		node.width = width;
		node.height = height;
		node.top = Math.max(0, Math.floor((rows - height) / 2) + (options?.offsetY ?? 0));
		node.left = Math.max(0, Math.floor((columns - width) / 2) + (options?.offsetX ?? 0));
	}

	private resolveOverlayWidth(options: OverlayOptions | undefined, columns: number): number {
		const requested = percentToCells(options?.width, columns) ?? Math.min(60, columns);
		const minWidth = options?.minWidth ?? 0;
		return Math.max(1, Math.min(columns, Math.max(minWidth, requested)));
	}
}

export { StaticTextComponent };
