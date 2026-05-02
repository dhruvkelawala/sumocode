import type {
	AutocompleteProviderFactory,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	KeybindingsManager,
	ReadonlyFooterDataProvider,
	Theme,
	WorkingIndicatorOptions,
} from "@mariozechner/pi-coding-agent";
import type {
	Component,
	EditorComponent,
	EditorTheme,
	OverlayHandle,
	OverlayOptions,
	TUI,
} from "@mariozechner/pi-tui";
import { ModalManager } from "../widgets/modal.js";
import { ModalLayer } from "../widgets/modal-layer.js";
import { NotificationCenter, type NotificationLevel } from "../widgets/notification.js";
import {
	RegionRegistry,
	type DisposableComponent,
	type WidgetPlacement,
} from "./region-registry.js";

export interface ThemeApi {
	getAllThemes(): { name: string; path: string | undefined }[];
	getTheme(name: string): Theme | undefined;
	setTheme(theme: string | Theme): { success: boolean; error?: string };
}

export interface EditorTextController {
	paste(text: string): void;
	setText(text: string): void;
	getText(): string;
}

export interface ToolsExpansionController {
	getExpanded(): boolean;
	setExpanded(expanded: boolean): void;
}

export interface SumoExtensionUIAdapterOptions {
	readonly regionRegistry: RegionRegistry;
	readonly tui: TUI;
	readonly theme: Theme;
	readonly editorTheme: EditorTheme;
	readonly keybindings: KeybindingsManager;
	readonly footerData?: ReadonlyFooterDataProvider;
	readonly notifications?: NotificationCenter;
	readonly modals?: ModalManager;
	readonly editorText?: EditorTextController;
	readonly themeApi?: ThemeApi;
	readonly tools?: ToolsExpansionController;
	readonly addAutocompleteProvider?: (factory: AutocompleteProviderFactory) => void;
	readonly setStatus?: (key: string, text: string | undefined) => void;
	readonly setWorkingMessage?: (message?: string) => void;
	readonly setWorkingIndicator?: (options?: WorkingIndicatorOptions) => void;
	readonly setHiddenThinkingLabel?: (label?: string) => void;
	readonly onRenderRequest?: () => void;
}

type TerminalInputHandler = Parameters<ExtensionUIContext["onTerminalInput"]>[0];

class OverlayComponentWrapper implements Component {
	private hidden = false;
	public constructor(private readonly component: DisposableComponent) {}
	public invalidate(): void {
		this.component.invalidate?.();
	}
	public handleInput(data: string): void {
		this.component.handleInput?.(data);
	}
	public render(width: number): string[] {
		return this.hidden ? [] : this.component.render(width);
	}
	public setHidden(hidden: boolean): void {
		this.hidden = hidden;
	}
	public isHidden(): boolean {
		return this.hidden;
	}
	public dispose(): void {
		this.component.dispose?.();
	}
}

function normalizeNotificationLevel(level: "info" | "warning" | "error" | undefined): NotificationLevel {
	return level ?? "info";
}

/**
 * Pi ExtensionUIContext implementation backed by RegionRegistry's named slots.
 * OwnedShellRenderer is the product render root; this adapter remains the
 * compatibility layer for extension UI surfaces that are not yet permanent
 * chrome siblings.
 *
 * Source: Pi 0.70.2's interactive mode exposes this surface from
 * `createExtensionUIContext()` at
 * `node_modules/.pnpm/@mariozechner+pi-coding-agent@0.70.2.../dist/modes/interactive/interactive-mode.js:1522-1557`.
 * Dialog/editor/custom behaviours mirror the upstream editor-container and
 * overlay paths at `interactive-mode.js:1584-1774`.
 */
export class SumoExtensionUIAdapter implements ExtensionUIContext {
	private readonly regionRegistry: RegionRegistry;
	private readonly tui: TUI;
	private readonly currentTheme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly notifications: NotificationCenter;
	private readonly modals: ModalManager;
	private readonly editorText: EditorTextController | undefined;
	private readonly themeApi: ThemeApi | undefined;
	private readonly tools: ToolsExpansionController | undefined;
	private readonly addProvider: ((factory: AutocompleteProviderFactory) => void) | undefined;
	private readonly onStatus: ((key: string, text: string | undefined) => void) | undefined;
	private readonly onWorkingMessage: ((message?: string) => void) | undefined;
	private readonly onWorkingIndicator: ((options?: WorkingIndicatorOptions) => void) | undefined;
	private readonly onHiddenThinkingLabel: ((label?: string) => void) | undefined;
	private readonly requestRender: () => void;
	private readonly terminalInputHandlers = new Set<TerminalInputHandler>();

	public constructor(options: SumoExtensionUIAdapterOptions) {
		this.regionRegistry = options.regionRegistry;
		this.tui = options.tui;
		this.currentTheme = options.theme;
		this.keybindings = options.keybindings;
		this.notifications = options.notifications ?? new NotificationCenter({ onChange: options.onRenderRequest });
		this.modals = options.modals ?? new ModalLayer({
			onChange: options.onRenderRequest,
			getTerminalSize: () => ({
				columns: (this.tui.terminal as { columns?: number } | undefined)?.columns ?? 80,
				rows: (this.tui.terminal as { rows?: number } | undefined)?.rows ?? 24,
			}),
		});
		this.editorText = options.editorText;
		this.themeApi = options.themeApi;
		this.tools = options.tools;
		this.addProvider = options.addAutocompleteProvider;
		this.onStatus = options.setStatus;
		this.onWorkingMessage = options.setWorkingMessage;
		this.onWorkingIndicator = options.setWorkingIndicator;
		this.onHiddenThinkingLabel = options.setHiddenThinkingLabel;
		this.requestRender = options.onRenderRequest ?? (() => this.tui.requestRender?.());
		this.regionRegistry.mountOverlay("__notifications", this.notifications, {
			anchor: "top-right",
			width: "45%",
			maxHeight: 6,
		});
		if (this.modals instanceof ModalLayer) {
			this.regionRegistry.mountOverlay("__modal", this.modals, {
				row: 0,
				col: 0,
				width: "100%",
				maxHeight: "100%",
			});
		} else {
			this.regionRegistry.mountModal("__modal", this.modals, {
				anchor: "center",
				width: "65%",
				maxHeight: "80%",
			});
		}
	}

	public select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
		return this.modals.select(title, options, opts);
	}

	public confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
		return this.modals.confirm(title, message, opts);
	}

	public input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
		return this.modals.input(title, placeholder, opts);
	}

	public notify(message: string, type?: "info" | "warning" | "error"): void {
		this.notifications.notify(message, normalizeNotificationLevel(type));
	}

	public onTerminalInput(handler: TerminalInputHandler): () => void {
		this.terminalInputHandlers.add(handler);
		return () => this.terminalInputHandlers.delete(handler);
	}

	public dispatchTerminalInput(data: string): { consume?: boolean; data?: string } | undefined {
		for (const handler of this.terminalInputHandlers) {
			const result = handler(data);
			if (result?.consume) return result;
			if (result?.data !== undefined) data = result.data;
		}
		return data === undefined ? undefined : { data };
	}

	public setStatus(key: string, text: string | undefined): void {
		this.onStatus?.(key, text);
		this.requestRender();
	}

	public setWorkingMessage(message?: string): void {
		this.onWorkingMessage?.(message);
		this.requestRender();
	}

	public setWorkingIndicator(options?: WorkingIndicatorOptions): void {
		this.onWorkingIndicator?.(options);
		this.requestRender();
	}

	public setHiddenThinkingLabel(label?: string): void {
		this.onHiddenThinkingLabel?.(label);
		this.requestRender();
	}

	public setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
	public setWidget(
		key: string,
		content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void;
	public setWidget(
		key: string,
		content: string[] | ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		this.regionRegistry.mountWidget(key, content, { placement: options?.placement as WidgetPlacement | undefined });
	}

	public setFooter(
		factory: ((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void }) | undefined,
	): void {
		this.regionRegistry.mountFooter(factory);
	}

	public setHeader(factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined): void {
		this.regionRegistry.mountHeader(factory);
	}

	public setTitle(title: string): void {
		this.tui.terminal?.setTitle?.(title);
	}

	public async custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const key = `__custom_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		let wrapper: OverlayComponentWrapper | undefined;
		let settled = false;
		return new Promise<T>((resolve, reject) => {
			const close = (result: T): void => {
				if (settled) return;
				settled = true;
				this.regionRegistry.unmount(key);
				resolve(result);
			};
			Promise.resolve(factory(this.tui, this.currentTheme, this.keybindings, close))
				.then((component) => {
					if (settled) {
						component.dispose?.();
						return;
					}
					wrapper = new OverlayComponentWrapper(component);
					if (options?.overlay === false) this.regionRegistry.mountOverlay(key, wrapper, undefined);
					else this.regionRegistry.mountModal(key, wrapper, options?.overlayOptions);
					options?.onHandle?.(this.createOverlayHandle(key, wrapper));
				})
				.catch((error: unknown) => {
					if (settled) return;
					settled = true;
					reject(error);
				});
		});
	}

	public pasteToEditor(text: string): void {
		this.editorText?.paste(text);
	}

	public setEditorText(text: string): void {
		this.editorText?.setText(text);
	}

	public getEditorText(): string {
		return this.editorText?.getText() ?? "";
	}

	public editor(title: string, prefill?: string): Promise<string | undefined> {
		if (prefill) this.editorText?.setText(prefill);
		return this.modals.input(title, prefill);
	}

	public addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
		this.addProvider?.(factory);
	}

	public setEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent) | undefined,
	): void {
		this.regionRegistry.mountEditor(factory);
	}

	public get theme(): Theme {
		return this.currentTheme;
	}

	public getAllThemes(): { name: string; path: string | undefined }[] {
		return this.themeApi?.getAllThemes() ?? [];
	}

	public getTheme(name: string): Theme | undefined {
		return this.themeApi?.getTheme(name);
	}

	public setTheme(theme: string | Theme): { success: boolean; error?: string } {
		return this.themeApi?.setTheme(theme) ?? { success: false, error: "Theme API unavailable" };
	}

	public getToolsExpanded(): boolean {
		return this.tools?.getExpanded() ?? false;
	}

	public setToolsExpanded(expanded: boolean): void {
		this.tools?.setExpanded(expanded);
		this.requestRender();
	}

	private createOverlayHandle(key: string, wrapper: OverlayComponentWrapper): OverlayHandle {
		return {
			hide: () => this.regionRegistry.unmount(key),
			setHidden: (hidden: boolean) => {
				wrapper.setHidden(hidden);
				this.requestRender();
			},
			isHidden: () => wrapper.isHidden(),
			focus: () => undefined,
			unfocus: () => undefined,
			isFocused: () => false,
		};
	}
}
