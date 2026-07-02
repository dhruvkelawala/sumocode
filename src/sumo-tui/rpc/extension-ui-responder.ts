import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import type { EditorTextController } from "../pi-compat/extension-ui-adapter.js";
import type { RegionRegistry, WidgetPlacement } from "../pi-compat/region-registry.js";
import { ModalManager } from "../widgets/modal.js";
import { NotificationCenter, type NotificationLevel } from "../widgets/notification.js";

type DialogModals = Pick<ModalManager, "select" | "confirm" | "input">;
type ToastCenter = Pick<NotificationCenter, "notify">;
type TerminalTitle = { setTitle?(title: string): void };
type StatusSink = (key: string, text: string | undefined) => void;

export interface RpcExtensionUiResponderOptions {
	readonly modals?: DialogModals;
	readonly notifications?: ToastCenter;
	readonly regionRegistry?: Pick<RegionRegistry, "mountWidget">;
	readonly editorText?: EditorTextController;
	readonly terminal?: TerminalTitle;
	readonly setStatus?: StatusSink;
	readonly onRenderRequest?: () => void;
}

export interface RpcExtensionUiResponderSnapshot {
	readonly statuses: ReadonlyMap<string, string | undefined>;
	readonly widgets: ReadonlyMap<string, readonly string[] | undefined>;
	readonly title: string | undefined;
	readonly editorText: string;
}

export class RpcHostEditorBuffer implements EditorTextController {
	private value = "";

	public paste(text: string): void {
		this.value += text;
	}

	public setText(text: string): void {
		this.value = text;
	}

	public getText(): string {
		return this.value;
	}
}

function valueResponse(id: string, value: string | undefined): RpcExtensionUIResponse {
	return value === undefined ? { type: "extension_ui_response", id, cancelled: true } : { type: "extension_ui_response", id, value };
}

function notifyLevel(level: "info" | "warning" | "error" | undefined): NotificationLevel {
	return level ?? "info";
}

export class RpcExtensionUiResponder {
	private readonly modals: DialogModals;
	private readonly notifications: ToastCenter;
	private readonly regionRegistry: Pick<RegionRegistry, "mountWidget"> | undefined;
	private readonly editorText: EditorTextController;
	private readonly terminal: TerminalTitle | undefined;
	private readonly onStatus: StatusSink | undefined;
	private readonly onRenderRequest: () => void;
	private readonly statuses = new Map<string, string | undefined>();
	private readonly widgets = new Map<string, readonly string[] | undefined>();
	private title: string | undefined;

	public constructor(options: RpcExtensionUiResponderOptions = {}) {
		this.modals = options.modals ?? new ModalManager({ onChange: options.onRenderRequest });
		this.notifications = options.notifications ?? new NotificationCenter({ onChange: options.onRenderRequest });
		this.regionRegistry = options.regionRegistry;
		this.editorText = options.editorText ?? new RpcHostEditorBuffer();
		this.terminal = options.terminal;
		this.onStatus = options.setStatus;
		this.onRenderRequest = options.onRenderRequest ?? (() => undefined);
	}

	public async handle(request: RpcExtensionUIRequest): Promise<RpcExtensionUIResponse | void> {
		switch (request.method) {
			case "select": {
				const value = await this.modals.select(request.title, request.options, { timeout: request.timeout });
				return valueResponse(request.id, value);
			}
			case "confirm": {
				const confirmed = await this.modals.confirm(request.title, request.message, { timeout: request.timeout });
				return { type: "extension_ui_response", id: request.id, confirmed };
			}
			case "input": {
				const value = await this.modals.input(request.title, request.placeholder, { timeout: request.timeout });
				return valueResponse(request.id, value);
			}
			case "editor": {
				if (request.prefill !== undefined) this.editorText.setText(request.prefill);
				const value = await this.modals.input(request.title, request.prefill);
				if (value !== undefined) this.editorText.setText(value);
				return valueResponse(request.id, value);
			}
			case "notify":
				this.notifications.notify(request.message, notifyLevel(request.notifyType));
				this.onRenderRequest();
				return undefined;
			case "setStatus":
				this.statuses.set(request.statusKey, request.statusText);
				this.onStatus?.(request.statusKey, request.statusText);
				this.onRenderRequest();
				return undefined;
			case "setWidget":
				this.widgets.set(request.widgetKey, request.widgetLines);
				this.regionRegistry?.mountWidget(request.widgetKey, request.widgetLines, { placement: request.widgetPlacement as WidgetPlacement | undefined });
				this.onRenderRequest();
				return undefined;
			case "setTitle":
				this.title = request.title;
				this.terminal?.setTitle?.(request.title);
				this.onRenderRequest();
				return undefined;
			case "set_editor_text":
				this.editorText.setText(request.text);
				this.onRenderRequest();
				return undefined;
		}
	}

	public getSnapshot(): RpcExtensionUiResponderSnapshot {
		return {
			statuses: new Map(this.statuses),
			widgets: new Map(this.widgets),
			title: this.title,
			editorText: this.editorText.getText(),
		};
	}
}

export function createRpcExtensionUiResponder(options: RpcExtensionUiResponderOptions = {}): RpcExtensionUiResponder {
	return new RpcExtensionUiResponder(options);
}
