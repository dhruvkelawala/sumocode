import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	RPC_APPROVAL_TITLE_MARKER,
	renderApprovalModal,
	updateApprovalSnapshot,
	type ApprovalChoice,
	type ApprovalModalSnapshot,
} from "../../approval-modal.js";
import type { EditorTextController } from "../pi-compat/extension-ui-adapter.js";
import type { ExtensionStatusPublication, RegionRegistry, WidgetPlacement } from "../pi-compat/region-registry.js";
import { ModalManager } from "../widgets/modal.js";
import { NotificationCenter, type NotificationLevel } from "../widgets/notification.js";

type DialogModals = Pick<ModalManager, "select" | "confirm" | "input" | "editor">;
type ToastCenter = Pick<NotificationCenter, "notify">;
type TerminalTitle = { setTitle?(title: string): void };
type StatusSink = (key: string, text: string | undefined) => void;
type ApprovalOverlayHost = {
	show<T>(kind: string, create: (done: (value: T) => void) => Component): Promise<T>;
	close?(value?: unknown): void;
};

export interface RpcExtensionUiResponderOptions {
	readonly modals?: DialogModals;
	readonly notifications?: ToastCenter;
	readonly approvalOverlay?: ApprovalOverlayHost;
	readonly regionRegistry?: Pick<RegionRegistry, "mountWidget">;
	readonly statusPublication?: Pick<ExtensionStatusPublication, "setStatus">;
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

const RPC_APPROVAL_OPTIONS = ["No", "Yes", "Always"] as const;
const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|_[^\u0007]*(?:\u0007|\u001b\\))/g;
const CONTROL_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

function isApprovalSelect(title: string, options: readonly string[]): boolean {
	return title.startsWith(RPC_APPROVAL_TITLE_MARKER)
		&& options.length === RPC_APPROVAL_OPTIONS.length
		&& options.every((option, index) => option === RPC_APPROVAL_OPTIONS[index]);
}

function approvalOption(choice: ApprovalChoice): string {
	if (choice === "yes") return "Yes";
	if (choice === "always") return "Always";
	return "No";
}

function sanitizeApprovalText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(ANSI_PATTERN, "")
		.replace(/\t/g, " ")
		.replace(CONTROL_PATTERN, "");
}

function approvalSnapshotFromTitle(title: string): ApprovalModalSnapshot {
	const body = sanitizeApprovalText(title.slice(RPC_APPROVAL_TITLE_MARKER.length)).replace(/^\s+/, "");
	const sections = body.split(/\n\s*\n/);
	const command = sections.shift()?.trim() ?? "";
	const description = sections.join("\n\n").trim();
	const descriptionLines = description.length > 0 ? description.split("\n") : [];
	return {
		command,
		descriptionLines,
		activeButton: "no",
	};
}

class RpcApprovalOverlayComponent implements Component {
	public constructor(
		private snapshot: ApprovalModalSnapshot,
		private readonly done: (choice: ApprovalChoice) => void,
	) {}
	public invalidate(): void {}
	public handleInput(data: string): void {
		const result = updateApprovalSnapshot(this.snapshot, data);
		this.snapshot = result.snapshot;
		if (result.done) this.done(result.done);
	}
	public render(width: number): string[] {
		return renderApprovalModal(this.snapshot, width);
	}
}

export class RpcExtensionUiResponder {
	private readonly modals: DialogModals;
	private readonly notifications: ToastCenter;
	private readonly approvalOverlay: ApprovalOverlayHost | undefined;
	private readonly regionRegistry: Pick<RegionRegistry, "mountWidget"> | undefined;
	private readonly statusPublication: Pick<ExtensionStatusPublication, "setStatus"> | undefined;
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
		this.approvalOverlay = options.approvalOverlay;
		this.regionRegistry = options.regionRegistry;
		this.statusPublication = options.statusPublication;
		this.editorText = options.editorText ?? new RpcHostEditorBuffer();
		this.terminal = options.terminal;
		this.onStatus = options.setStatus;
		this.onRenderRequest = options.onRenderRequest ?? (() => undefined);
	}

	public async handle(request: RpcExtensionUIRequest): Promise<RpcExtensionUIResponse | void> {
		switch (request.method) {
			case "select": {
				if (this.approvalOverlay && isApprovalSelect(request.title, request.options)) {
					const value = await this.showApprovalSelect(request.title, request.timeout);
					return valueResponse(request.id, value);
				}
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
				// Pi's editor() contract: open an editor prefilled with `request.prefill`, return
				// the edited text verbatim on submit. The host's real chat-draft editor is
				// intentionally left untouched here: this is a standalone dialog flow, not a
				// mirror of the user's in-progress draft, and clobbering it would silently discard
				// whatever the user was mid-typing.
				const value = await this.modals.editor(request.title, request.prefill ?? "");
				return valueResponse(request.id, value);
			}
			case "notify":
				this.notifications.notify(request.message, notifyLevel(request.notifyType));
				this.onRenderRequest();
				return undefined;
			case "setStatus":
				this.statuses.set(request.statusKey, request.statusText);
				this.statusPublication?.setStatus(request.statusKey, request.statusText);
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
			default: {
				// The `RpcExtensionUIRequest` union is exhaustive at the type level, but the wire
				// payload is untyped JSON from the Pi child process: a Pi upgrade can add a new
				// extension_ui method this responder doesn't know about yet. Without this branch
				// `handle()` would resolve `void` and (pre-fix) leave the request unanswered,
				// wedging Pi's rpc-mode.js pendingExtensionRequests entry forever. Return an
				// explicit cancelled response and log so the gap surfaces during a Pi upgrade
				// instead of silently hanging.
				const unknownRequest = request as { method?: unknown; id: string };
				console.error(
					`[sumocode] extension_ui request with unrecognized method "${String(unknownRequest.method)}" (id=${unknownRequest.id}); responding cancelled. This likely means Pi added a new extension_ui method that RpcExtensionUiResponder needs to implement.`,
				);
				return { type: "extension_ui_response", id: unknownRequest.id, cancelled: true };
			}
		}
	}

	private async showApprovalSelect(title: string, timeout: number | undefined): Promise<string> {
		const overlay = this.approvalOverlay;
		if (!overlay) return "No";
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const choice = overlay.show<ApprovalChoice>(
				"approval",
				(done) => new RpcApprovalOverlayComponent(approvalSnapshotFromTitle(title), done),
			);
			const resolved = timeout !== undefined && timeout > 0
				? await Promise.race([
					choice,
					new Promise<ApprovalChoice>((resolve) => {
						timer = setTimeout(() => {
							overlay.close?.("no");
							resolve("no");
						}, timeout);
						timer.unref?.();
					}),
				])
				: await choice;
			return approvalOption(resolved);
		} catch {
			return "No";
		} finally {
			if (timer) clearTimeout(timer);
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
