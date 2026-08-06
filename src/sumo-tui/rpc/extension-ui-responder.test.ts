import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionStatusPublication } from "../pi-compat/region-registry.js";
import { authInputTitle, secretInputTitle } from "../pi-compat/secret-input.js";
import { encodeRpcTreeNavigationOutcome, InMemoryRpcTreeNavigationOutcomeBroker, RPC_TREE_NAVIGATION_RESULT_STATUS_KEY } from "../pi-compat/tree-navigation-command.js";
import { ModalManager } from "../widgets/modal.js";
import { NotificationCenter } from "../widgets/notification.js";
import { RpcHostEditorController } from "./editor.js";
import { RpcExtensionUiResponder, RpcHostEditorBuffer } from "./extension-ui-responder.js";

function request<T extends RpcExtensionUIRequest>(request: T): T {
	return request;
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

	it("round-trips input responses through the modal layer", async () => {
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
	});

	it("masks SumoCode authentication secrets while returning the raw value to the RPC child", async () => {
		const modals = new ModalManager();
		const responder = new RpcExtensionUiResponder({ modals });
		const inputResponse = responder.handle(request({
			type: "extension_ui_request",
			id: "secret-1",
			method: "input",
			title: secretInputTitle("API key"),
			placeholder: "sk-...",
		}));

		modals.handleInput("sk-secret");
		expect(modals.render(40).join("\n")).not.toContain("sk-secret");
		expect(modals.render(40).join("\n")).not.toContain("sumocode-secret-input");
		modals.handleInput("enter");

		await expect(inputResponse).resolves.toEqual({ type: "extension_ui_response", id: "secret-1", value: "sk-secret" });
	});

	it("closes an OAuth prompt when the child reports that login settled", async () => {
		const modals = new ModalManager();
		const responder = new RpcExtensionUiResponder({ modals });
		const inputResponse = responder.handle(request({
			type: "extension_ui_request",
			id: "oauth-code",
			method: "input",
			title: authInputTitle("Paste redirect URL"),
		}));

		await responder.handle(request({
			type: "extension_ui_request",
			id: "login-settled",
			method: "setStatus",
			statusKey: "sumocode.login",
			statusText: undefined,
		}));

		expect(modals.getActiveKind()).toBeUndefined();
		await expect(inputResponse).resolves.toEqual({ type: "extension_ui_response", id: "oauth-code", cancelled: true });
	});

	it("cancels only tagged auth prompts when another modal is active", async () => {
		const modals = new ModalManager();
		const responder = new RpcExtensionUiResponder({ modals });
		const unrelated = responder.handle(request({
			type: "extension_ui_request",
			id: "unrelated",
			method: "input",
			title: "Rename session",
		}));
		const auth = responder.handle(request({
			type: "extension_ui_request",
			id: "queued-auth",
			method: "input",
			title: authInputTitle("Paste redirect URL"),
		}));

		await responder.handle(request({
			type: "extension_ui_request",
			id: "login-settled-queued",
			method: "setStatus",
			statusKey: "sumocode.login",
			statusText: undefined,
		}));

		expect(modals.getActiveDialogSnapshot()?.title).toBe("Rename session");
		await expect(auth).resolves.toEqual({ type: "extension_ui_response", id: "queued-auth", cancelled: true });
		modals.handleInput("enter");
		await expect(unrelated).resolves.toEqual({ type: "extension_ui_response", id: "unrelated", value: "" });
	});

	it("returns the editor multiline prefill verbatim on immediate Enter without touching the host draft", async () => {
		const modals = new ModalManager();
		const editorText = new RpcHostEditorBuffer();
		editorText.setText("user is mid-typing this");
		const responder = new RpcExtensionUiResponder({ modals, editorText });

		const editorResponse = responder.handle(request({
			type: "extension_ui_request",
			id: "editor-prefill",
			method: "editor",
			title: "Edit",
			prefill: "a\nb\nc",
		}));

		// The modal's value must be seeded with the prefill (not just its placeholder), so an
		// immediate Enter returns the prefill unchanged rather than an empty string or flattened text.
		modals.handleInput("enter");

		await expect(editorResponse).resolves.toEqual({ type: "extension_ui_response", id: "editor-prefill", value: "a\nb\nc" });
		// The host's real chat-draft editor is a separate surface and must never be touched by
		// the editor() dialog flow.
		expect(editorText.getText()).toBe("user is mid-typing this");
	});

	it("returns the edited editor value when the user changes the prefill", async () => {
		const modals = new ModalManager();
		const editorText = new RpcHostEditorBuffer();
		editorText.setText("user is mid-typing this");
		const responder = new RpcExtensionUiResponder({ modals, editorText });

		const editorResponse = responder.handle(request({
			type: "extension_ui_request",
			id: "editor-edit",
			method: "editor",
			title: "Edit",
			prefill: "draft",
		}));

		modals.handleInput("backspace");
		modals.handleInput("backspace");
		modals.handleInput("backspace");
		modals.handleInput("backspace");
		modals.handleInput("backspace");
		modals.handleInput("ablist");
		modals.handleInput("enter");

		await expect(editorResponse).resolves.toEqual({ type: "extension_ui_response", id: "editor-edit", value: "ablist" });
		expect(editorText.getText()).toBe("user is mid-typing this");
	});

	it("cancels the editor dialog on escape without touching the host draft at any point", async () => {
		const modals = new ModalManager();
		const editorText = new RpcHostEditorBuffer();
		editorText.setText("user is mid-typing this");
		const responder = new RpcExtensionUiResponder({ modals, editorText });

		const editorResponse = responder.handle(request({
			type: "extension_ui_request",
			id: "editor-cancel",
			method: "editor",
			title: "Edit",
			prefill: "draft",
		}));

		// Draft must be untouched before, during, and after the dialog.
		expect(editorText.getText()).toBe("user is mid-typing this");
		modals.handleInput("escape");

		await expect(editorResponse).resolves.toEqual({ type: "extension_ui_response", id: "editor-cancel", cancelled: true });
		expect(editorText.getText()).toBe("user is mid-typing this");
		expect(responder.getSnapshot().editorText).toBe("user is mid-typing this");
	});

	it("responds cancelled and logs a diagnostic for an unrecognized extension_ui method", async () => {
		const modals = new ModalManager();
		const responder = new RpcExtensionUiResponder({ modals });
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

		try {
			// Cast through unknown: the wire payload from Pi's child process is untyped JSON, so a
			// future Pi upgrade can send a method this responder's exhaustive switch doesn't know
			// about. Simulate that here even though the current RpcExtensionUIRequest union is closed.
			const response = responder.handle(
				{ type: "extension_ui_request", id: "future-1", method: "future_method", title: "New" } as unknown as RpcExtensionUIRequest,
			);

			await expect(response).resolves.toEqual({ type: "extension_ui_response", id: "future-1", cancelled: true });
			expect(consoleError).toHaveBeenCalledTimes(1);
			expect(consoleError.mock.calls[0]?.[0]).toContain("future_method");
		} finally {
			consoleError.mockRestore();
		}
	});

	it("intercepts correlated tree outcomes before ordinary status publication", async () => {
		const broker = new InMemoryRpcTreeNavigationOutcomeBroker();
		const waiter = broker.register("019f8a78-b4f5-7b7b-b774-2d2e4bce9001", 1_000);
		const setStatus = vi.fn();
		const statusPublication = new ExtensionStatusPublication();
		const responder = new RpcExtensionUiResponder({ treeNavigationOutcomeBroker: broker, setStatus, statusPublication });
		const outcome = { requestId: "019f8a78-b4f5-7b7b-b774-2d2e4bce9001", status: "committed" as const, leafId: "leaf" };
		await responder.handle(request({ type: "extension_ui_request", id: "tree-status", method: "setStatus", statusKey: RPC_TREE_NAVIGATION_RESULT_STATUS_KEY, statusText: encodeRpcTreeNavigationOutcome(outcome) }));
		await expect(waiter).resolves.toEqual(outcome);
		expect(setStatus).not.toHaveBeenCalled();
		expect(statusPublication.getStatuses().has(RPC_TREE_NAVIGATION_RESULT_STATUS_KEY)).toBe(false);
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
		// ExtensionStatusPublication tracks statuses (see getStatuses()/getSnapshot() below)
		// but must not render them as a visible strip -- main never paints setStatus() text
		// anywhere (see region-registry.ts's ExtensionStatusPublication doc comment).
		expect(statusPublication.render(80)).toEqual([]);
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

	it("treats approval-shaped select titles as ordinary generic selects", async () => {
		const modals = new ModalManager();
		const responder = new RpcExtensionUiResponder({ modals });
		const response = responder.handle(request({
			type: "extension_ui_request",
			id: "ordinary-approval-shaped-select",
			method: "select",
			title: "APPROVAL REQUIRED\n\nrm -rf node_modules",
			options: ["No", "Yes", "Always"],
		}));

		expect(modals.getActiveKind()).toBe("select");
		modals.handleInput("down");
		modals.handleInput("enter");

		await expect(response).resolves.toEqual({ type: "extension_ui_response", id: "ordinary-approval-shaped-select", value: "Yes" });
	});
});
