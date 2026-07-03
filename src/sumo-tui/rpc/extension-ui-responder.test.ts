import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RPC_APPROVAL_TITLE_MARKER } from "../../approval-modal.js";
import { ExtensionStatusPublication } from "../pi-compat/region-registry.js";
import { ModalManager } from "../widgets/modal.js";
import { NotificationCenter } from "../widgets/notification.js";
import { RpcHostEditorController } from "./editor.js";
import { RpcExtensionUiResponder, RpcHostEditorBuffer } from "./extension-ui-responder.js";

function request<T extends RpcExtensionUIRequest>(request: T): T {
	return request;
}

class TestOverlayHost {
	public active: Component | undefined;
	public kind: string | undefined;
	private finish: ((value: unknown) => void) | undefined;

	public show<T>(kind: string, create: (done: (value: T) => void) => Component): Promise<T> {
		this.kind = kind;
		return new Promise<T>((resolve) => {
			this.finish = (value) => {
				this.active = undefined;
				this.kind = undefined;
				this.finish = undefined;
				resolve(value as T);
			};
			this.active = create((value) => this.finish?.(value));
		});
	}

	public close(value?: unknown): void {
		this.finish?.(value);
	}
}

afterEach(() => {
	vi.useRealTimers();
});

describe("RpcExtensionUiResponder", () => {
	it("round-trips select responses with the original request id", async () => {
		const modals = new ModalManager();
		const responder = new RpcExtensionUiResponder({ modals });
		const response = responder.handle(request({
			type: "extension_ui_request",
			id: "select-1",
			method: "select",
			title: "Pick",
			options: ["alpha", "beta"],
		}));

		modals.handleInput("down");
		modals.handleInput("enter");

		await expect(response).resolves.toEqual({ type: "extension_ui_response", id: "select-1", value: "beta" });
	});

	it("round-trips cancelled select requests without inventing a value", async () => {
		const modals = new ModalManager();
		const responder = new RpcExtensionUiResponder({ modals });
		const response = responder.handle(request({
			type: "extension_ui_request",
			id: "select-cancel",
			method: "select",
			title: "Pick",
			options: ["alpha"],
		}));

		modals.handleInput("escape");

		await expect(response).resolves.toEqual({ type: "extension_ui_response", id: "select-cancel", cancelled: true });
	});

	it("round-trips unanswered select requests as cancelled without inventing a value", async () => {
		vi.useFakeTimers();
		const modals = new ModalManager();
		const responder = new RpcExtensionUiResponder({ modals });
		const response = responder.handle(request({
			type: "extension_ui_request",
			id: "select-timeout",
			method: "select",
			title: "Pick",
			options: ["alpha"],
			timeout: 100,
		}));

		await vi.advanceTimersByTimeAsync(100);

		await expect(response).resolves.toEqual({ type: "extension_ui_response", id: "select-timeout", cancelled: true });
	});

	it("round-trips confirm responses with the original request id", async () => {
		const modals = new ModalManager();
		const responder = new RpcExtensionUiResponder({ modals });
		const response = responder.handle(request({
			type: "extension_ui_request",
			id: "confirm-1",
			method: "confirm",
			title: "Continue",
			message: "Proceed?",
		}));

		modals.handleInput("right");
		modals.handleInput("enter");

		await expect(response).resolves.toEqual({ type: "extension_ui_response", id: "confirm-1", confirmed: false });
	});

	it("round-trips input and editor values through the modal layer", async () => {
		const modals = new ModalManager();
		const editorText = new RpcHostEditorBuffer();
		const responder = new RpcExtensionUiResponder({ modals, editorText });
		const inputResponse = responder.handle(request({
			type: "extension_ui_request",
			id: "input-1",
			method: "input",
			title: "Name",
			placeholder: "optional",
		}));

		modals.handleInput("o");
		modals.handleInput("k");
		modals.handleInput("enter");

		await expect(inputResponse).resolves.toEqual({ type: "extension_ui_response", id: "input-1", value: "ok" });

		const editorResponse = responder.handle(request({
			type: "extension_ui_request",
			id: "editor-1",
			method: "editor",
			title: "Edit",
			prefill: "draft",
		}));

		modals.handleInput("escape");

		await expect(editorResponse).resolves.toEqual({ type: "extension_ui_response", id: "editor-1", cancelled: true });
		expect(responder.getSnapshot().editorText).toBe("draft");
	});

	it("routes nonblocking requests into host-owned surfaces without responding", async () => {
		const notify = vi.fn();
		const setTitle = vi.fn();
		const setStatus = vi.fn();
		const statusPublication = new ExtensionStatusPublication();
		const mountWidget = vi.fn();
		const onRenderRequest = vi.fn();
		const responder = new RpcExtensionUiResponder({
			notifications: { notify },
			terminal: { setTitle },
			setStatus,
			statusPublication,
			regionRegistry: { mountWidget },
			onRenderRequest,
		});

		await expect(responder.handle(request({
			type: "extension_ui_request",
			id: "notify-1",
			method: "notify",
			message: "saved",
			notifyType: "warning",
		}))).resolves.toBeUndefined();
		await expect(responder.handle(request({
			type: "extension_ui_request",
			id: "status-1",
			method: "setStatus",
			statusKey: "fast-mode",
			statusText: "fast",
		}))).resolves.toBeUndefined();
		await expect(responder.handle(request({
			type: "extension_ui_request",
			id: "widget-1",
			method: "setWidget",
			widgetKey: "sumocode-widget",
			widgetLines: ["one"],
			widgetPlacement: "belowEditor",
		}))).resolves.toBeUndefined();
		await expect(responder.handle(request({
			type: "extension_ui_request",
			id: "title-1",
			method: "setTitle",
			title: "SumoCode",
		}))).resolves.toBeUndefined();
		await expect(responder.handle(request({
			type: "extension_ui_request",
			id: "editor-text-1",
			method: "set_editor_text",
			text: "prefilled",
		}))).resolves.toBeUndefined();

		expect(notify).toHaveBeenCalledWith("saved", "warning");
		expect(setStatus).toHaveBeenCalledWith("fast-mode", "fast");
		expect(statusPublication.render(80)).toEqual(["fast-mode: fast"]);
		expect(mountWidget).toHaveBeenCalledWith("sumocode-widget", ["one"], { placement: "belowEditor" });
		expect(setTitle).toHaveBeenCalledWith("SumoCode");
		expect(responder.getSnapshot()).toMatchObject({
			title: "SumoCode",
			editorText: "prefilled",
		});
		expect(responder.getSnapshot().statuses.get("fast-mode")).toBe("fast");
		expect(responder.getSnapshot().widgets.get("sumocode-widget")).toEqual(["one"]);
		expect(onRenderRequest).toHaveBeenCalledTimes(5);
	});

	it("creates default modal and notification services when host UI services are absent", async () => {
		const responder = new RpcExtensionUiResponder();
		await expect(responder.handle(request({
			type: "extension_ui_request",
			id: "set-editor",
			method: "set_editor_text",
			text: "cached",
		}))).resolves.toBeUndefined();

		expect(responder.getSnapshot().editorText).toBe("cached");
	});

	it("routes set_editor_text into a live RPC editor controller", async () => {
		const editor = new RpcHostEditorController();
		const responder = new RpcExtensionUiResponder({ editorText: editor });

		await expect(responder.handle(request({
			type: "extension_ui_request",
			id: "set-live-editor",
			method: "set_editor_text",
			text: "live prefill",
		}))).resolves.toBeUndefined();

		expect(editor.getText()).toBe("live prefill");
		expect(responder.getSnapshot().editorText).toBe("live prefill");
	});

	it("keeps real notification center behavior available for host-owned toasts", async () => {
		const notifications = new NotificationCenter({ defaultTimeoutMs: 0 });
		const responder = new RpcExtensionUiResponder({ notifications });

		await responder.handle(request({
			type: "extension_ui_request",
			id: "notify-2",
			method: "notify",
			message: "hello",
			notifyType: "info",
		}));

		expect(notifications.getToasts()).toMatchObject([{ message: "hello", level: "info" }]);
	});

	it("routes approval-marked selects through the Cathedral overlay host", async () => {
		const overlay = new TestOverlayHost();
		const modals = new ModalManager();
		const responder = new RpcExtensionUiResponder({ approvalOverlay: overlay, modals });
		const response = responder.handle(request({
			type: "extension_ui_request",
			id: "approval-1",
			method: "select",
			title: `${RPC_APPROVAL_TITLE_MARKER}\n\nrm -rf node_modules\n\nThis will permanently delete files.`,
			options: ["No", "Yes", "Always"],
		}));

		expect(overlay.kind).toBe("approval");
		expect(overlay.active?.render(80).join("\n")).toContain("APPROVAL REQUIRED");
		expect(overlay.active?.render(80).join("\n")).toContain("rm -rf node_modules");

		overlay.active?.handleInput?.("y");

		await expect(response).resolves.toEqual({ type: "extension_ui_response", id: "approval-1", value: "Yes" });
		expect(modals.getActiveKind()).toBeUndefined();
	});

	it("strips approval command and description control sequences before overlay rendering", async () => {
		const overlay = new TestOverlayHost();
		const responder = new RpcExtensionUiResponder({ approvalOverlay: overlay });
		const response = responder.handle(request({
			type: "extension_ui_request",
			id: "approval-sanitize",
			method: "select",
			title: `${RPC_APPROVAL_TITLE_MARKER}\n\nrm -rf \u001b]2;spoofed-title\u0007node_modules\u001b[2J\n\nThis will delete\u0000 files\u001b[?25l.`,
			options: ["No", "Yes", "Always"],
		}));

		const rendered = overlay.active?.render(100).join("\n") ?? "";

		expect(rendered).toContain("rm -rf node_modules");
		expect(rendered).toContain("This will delete files.");
		expect(rendered).not.toContain("\u001b]2;spoofed-title\u0007");
		expect(rendered).not.toContain("\u001b[2J");
		expect(rendered).not.toContain("\u001b[?25l");
		expect(rendered).not.toContain("\u0000");

		overlay.active?.handleInput?.("n");
		await expect(response).resolves.toEqual({ type: "extension_ui_response", id: "approval-sanitize", value: "No" });
	});

	it("falls back to generic select when approval options do not match exactly", async () => {
		const overlay = new TestOverlayHost();
		const modals = new ModalManager();
		const responder = new RpcExtensionUiResponder({ approvalOverlay: overlay, modals });
		const response = responder.handle(request({
			type: "extension_ui_request",
			id: "approval-mismatch",
			method: "select",
			title: `${RPC_APPROVAL_TITLE_MARKER}\n\nrm -rf node_modules`,
			options: ["Allow", "Deny"],
		}));

		expect(overlay.kind).toBeUndefined();
		expect(modals.getActiveKind()).toBe("select");
		modals.handleInput("enter");

		await expect(response).resolves.toEqual({ type: "extension_ui_response", id: "approval-mismatch", value: "Allow" });
	});
});
