import type { Component } from "@earendil-works/pi-tui";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HardwareCursor } from "../render/compositor.js";
import { TerminalSessionOwner, type TerminalPatch } from "../runtime/terminal-controller.js";
import { InputRecoveryNotice } from "../widgets/input-recovery-notice.js";
import { NotificationCenter } from "../widgets/notification.js";
import { RpcHostEditorController } from "./editor.js";
import { RpcHostRuntime } from "./runtime.js";
import { RpcShellAdapter } from "./shell-adapter.js";

const activeState = {
	isStreaming: true, isCompacting: false, hasMessages: true,
	messageCount: 1, pendingMessageCount: 0, taskPartialCount: 0, costUsd: 0,
};

class CaptureTerminal extends TerminalSessionOwner {
	public cursor: HardwareCursor | null = null;
	public readonly patches: TerminalPatch[] = [];
	public override writeFramePatches(patches: readonly TerminalPatch[], cursor: HardwareCursor | null): void {
		this.cursor = cursor;
		this.patches.push(...patches);
	}
}

async function createShell(notifications?: Component, modal?: Component & { getActiveKind(): string }) {
	const terminal = new CaptureTerminal({ output: { write: () => undefined } });
	const viewport = { columns: 90, rows: 30 };
	let hint = "before tick";
	const shell = await RpcShellAdapter.create({
		terminal, viewport, initialState: activeState, initialTranscript: { messages: [] },
		editor: new RpcHostEditorController(), notifications, modal,
		extensionRegions: { belowEditor: { invalidate() {}, render: () => [hint] } },
	});
	const text = () => {
		const frame = shell.getLastFrame()!;
		return Array.from({ length: viewport.rows }, (_, row) => frame.toPlainRow(row)).join("\n");
	};
	return { shell, terminal, viewport, text, setHint: (value: string) => { hint = value; } };
}

afterEach(() => vi.useRealTimers());

describe("RPC notification visibility", () => {
	it.each([false, true])("keeps empty runtime notices cursor-visible and narrow-repaint eligible (upstream: %s)", async (withUpstream) => {
		vi.useFakeTimers();
		const terminal = new CaptureTerminal({ output: { write: () => undefined } });
		let hint = "before tick";
		const runtime = new RpcHostRuntime({
			output: { columns: 90, rows: 30, write: () => undefined },
			input: { isTTY: false, on() {} }, terminal,
			editor: new RpcHostEditorController(), initialState: activeState,
			notifications: withUpstream ? new NotificationCenter() : undefined,
			extensionRegions: { belowEditor: { invalidate() {}, render: () => [hint] } },
		});
		try {
			await runtime.start();
			expect(terminal.cursor).not.toBeNull();
			terminal.patches.length = 0;
			hint = "ZZZZZZZZ";
			await vi.advanceTimersByTimeAsync(1_000);
			expect(terminal.patches.length).toBeGreaterThan(0);
			expect(terminal.patches.map((patch) => patch.ansi).join("")).not.toContain(hint);
			expect(terminal.cursor).not.toBeNull();
			runtime.requestRender();
			await vi.advanceTimersByTimeAsync(0);
			expect(terminal.patches.map((patch) => patch.ansi).join("")).toContain(hint);
		} finally {
			runtime.stop();
		}
	});

	it("combines real input recovery feedback with upstream notifications in the runtime", async () => {
		vi.useFakeTimers();
		const terminal = new CaptureTerminal({ output: { write: () => undefined } });
		const input = Object.assign(new EventEmitter(), { isTTY: true });
		const notifications = new NotificationCenter();
		const runtime = new RpcHostRuntime({
			output: { columns: 90, rows: 30, write: () => undefined }, input, terminal,
			editor: new RpcHostEditorController(), initialState: activeState, notifications,
		});
		try {
			await runtime.start();
			notifications.notify("upstream toast", "info", 0);
			runtime.requestRender();
			await vi.advanceTimersByTimeAsync(0);
			// Issue 481: upstream notifications stay in the model but paint no rows.
			expect(notifications.getToasts()).toHaveLength(1);
			expect(terminal.patches.map((patch) => patch.ansi).join("")).not.toContain("upstream toast");
			expect(terminal.cursor).not.toBeNull();
			notifications.clear();
			runtime.requestRender();
			await vi.advanceTimersByTimeAsync(0);
			expect(terminal.cursor).not.toBeNull();
			terminal.patches.length = 0;
			input.emit("data", "\x1b[20");
			await vi.advanceTimersByTimeAsync(30);
			expect(terminal.patches.map((patch) => patch.ansi).join("")).toContain("input paused");
			expect(terminal.cursor).toBeNull();
		} finally {
			runtime.stop();
			notifications.dispose();
		}
	});

	it("shows a recovery notice, then restores the cursor and narrow repaint after clear", async () => {
		const notice = new InputRecoveryNotice();
		const { shell, terminal, text, setHint } = await createShell(notice);
		try {
			shell.render();
			expect(terminal.cursor).not.toBeNull();
			notice.setMessage("input paused — incomplete paste");
			shell.repaintWorkingIndicator();
			expect(text()).toContain("input paused");
			expect(terminal.cursor).toBeNull();
			notice.setMessage("");
			shell.repaintWorkingIndicator();
			expect(text()).not.toContain("input paused");
			expect(terminal.cursor).not.toBeNull();
			setHint("ZZZZZZZZ");
			shell.repaintWorkingIndicator();
			expect(text()).toContain("before tick");
			shell.render();
			expect(text()).toContain("ZZZZZZZZ");
		} finally {
			shell.dispose();
		}
	});

	it("never paints upstream toasts and hides the cursor only for an active modal", async () => {
		vi.useFakeTimers();
		const notifications = new NotificationCenter({ defaultTimeoutMs: 500 });
		let modalActive = false;
		const modal = { invalidate() {}, render: () => ["active modal"], getActiveKind: () => modalActive ? "select" : "" };
		const { shell, terminal, text, setHint } = await createShell(notifications, modal);
		try {
			notifications.notify("upstream toast");
			shell.render();
			expect(text()).not.toContain("upstream toast");
			expect(terminal.cursor).not.toBeNull();
			await vi.advanceTimersByTimeAsync(499);
			shell.render();
			expect(notifications.getToasts()).toHaveLength(1);
			expect(text()).not.toContain("upstream toast");
			expect(terminal.cursor).not.toBeNull();
			await vi.advanceTimersByTimeAsync(1);
			shell.repaintWorkingIndicator();
			expect(notifications.getToasts()).toHaveLength(0);
			expect(text()).not.toContain("upstream toast");
			expect(terminal.cursor).not.toBeNull();
			setHint("ZZZZZZZZ");
			shell.repaintWorkingIndicator();
			expect(text()).toContain("before tick");
			modalActive = true;
			shell.repaintWorkingIndicator();
			expect(terminal.cursor).toBeNull();
			expect(text()).toContain("ZZZZZZZZ");
		} finally {
			shell.dispose();
			notifications.dispose();
		}
	});

	it("does not activate an overlay whose rows are empty at the paint width", async () => {
		const notifications = { invalidate() {}, render: (width: number) => width === 1 ? ["probe-only row"] : [] };
		const { shell, terminal, text, setHint } = await createShell(notifications);
		try {
			shell.render();
			expect(terminal.cursor).not.toBeNull();
			setHint("ZZZZZZZZ");
			shell.repaintWorkingIndicator();
			expect(text()).toContain("before tick");
		} finally {
			shell.dispose();
		}
	});

	it("uses current-width notification rows for both cursor and narrow repaint eligibility", async () => {
		const notifications = { invalidate() {}, render: (width: number) => width >= 80 ? ["upstream notice"] : [] };
		const { shell, terminal, viewport, text, setHint } = await createShell(notifications);
		try {
			shell.render();
			expect(text()).toContain("upstream notice");
			expect(terminal.cursor).toBeNull();
			viewport.columns = 60;
			shell.render();
			expect(text()).not.toContain("upstream notice");
			expect(terminal.cursor).not.toBeNull();
			setHint("narrow must not repaint this");
			shell.repaintWorkingIndicator();
			expect(text()).toContain("before tick");
			viewport.columns = 90;
			shell.repaintWorkingIndicator();
			expect(text()).toContain("upstream notice");
			expect(terminal.cursor).toBeNull();
		} finally {
			shell.dispose();
		}
	});
});
