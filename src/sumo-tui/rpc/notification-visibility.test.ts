import type { Component } from "@earendil-works/pi-tui";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activeThemeColors } from "../../themes/index.js";
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

async function createShell(notifications?: Component & Partial<Pick<NotificationCenter, "getNotice">>, modal?: Component & { getActiveKind(): string }) {
	const terminal = new CaptureTerminal({ output: { write: () => undefined } });
	const viewport = { columns: 90, rows: 30 };
	let hint = "before tick";
	const shell = await RpcShellAdapter.create({
		terminal, viewport, initialState: activeState, initialTranscript: { messages: [] },
		editor: new RpcHostEditorController(), notifications, modal,
		extensionRegions: { belowEditor: { invalidate() {}, render: () => [hint] } },
	});
	const rows = () => {
		const frame = shell.getLastFrame()!;
		return Array.from({ length: viewport.rows }, (_, row) => frame.toPlainRow(row));
	};
	const text = () => rows().join("\n");
	return { shell, terminal, viewport, rows, text, setHint: (value: string) => { hint = value; } };
}

/** The active layout paints the input frame's bottom border one row above the hint row. */
function hintRowIndex(rows: readonly string[]): number {
	return rows.findIndex((row) => row.includes("└")) + 1;
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
			// Issue 481: the notice is a transient hint, not a retained toast.
			notifications.notify("upstream notice");
			runtime.requestRender();
			await vi.advanceTimersByTimeAsync(0);
			expect(notifications.getToasts()).toEqual([]);
			expect(notifications.getNotice()?.message).toBe("upstream notice");
			expect(terminal.patches.map((patch) => patch.ansi).join("")).toContain("upstream notice");
			expect(terminal.cursor).not.toBeNull();
			// The hint row is not a log: the next keystroke clears it without a repaint race.
			input.emit("data", "x");
			await vi.advanceTimersByTimeAsync(0);
			expect(notifications.getNotice()).toBeUndefined();
			notifications.notify("sticky failure", "error");
			input.emit("data", "\u001b");
			await vi.advanceTimersByTimeAsync(30);
			expect(notifications.getNotice()).toBeUndefined();
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
			notifications.notify("expiring hint");
			shell.render();
			expect(text()).toContain("expiring hint");
			expect(terminal.cursor).not.toBeNull();
			await vi.advanceTimersByTimeAsync(499);
			shell.render();
			expect(notifications.getToasts()).toEqual([]);
			expect(text()).toContain("expiring hint");
			expect(terminal.cursor).not.toBeNull();
			await vi.advanceTimersByTimeAsync(1);
			shell.render();
			expect(notifications.getToasts()).toEqual([]);
			expect(text()).not.toContain("expiring hint");
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

	it("paints a transient notice in the hint row and a sticky failure above the input frame", async () => {
		const notifications = new NotificationCenter();
		const { shell, rows, text } = await createShell(notifications);
		try {
			shell.render();
			const hint = hintRowIndex(rows());
			const editor = hint - 2;
			expect(editor).toBeGreaterThan(1);
			const projectHint = rows()[hint]!.slice(0, rows()[hint]!.indexOf("CTRL+/")).trim();
			expect(projectHint.length).toBeGreaterThan(0);

			notifications.notify("new session");
			shell.render();
			expect(rows()[hintRowIndex(rows())]).toContain("new session");
			expect(text()).not.toContain(projectHint);

			// A sticky failure leaves the hint row alone and paints its own row above
			// the input frame, in the rust/approval tone.
			notifications.notify("unknown model: nope", "warning", 0);
			shell.render();
			const painted = rows();
			const noticeRow = painted.findIndex((row) => row.includes("unknown model: nope"));
			expect(noticeRow).toBeGreaterThanOrEqual(0);
			expect(noticeRow).toBeLessThan(hintRowIndex(painted) - 2);
			expect(painted[hintRowIndex(painted)]).toContain(projectHint);
			expect(shell.getLastFrame()!.getCell(noticeRow, 0).fg?.toLowerCase()).toBe(activeThemeColors().states.approval.toLowerCase());
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
