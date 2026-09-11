import { afterEach, describe, expect, it, vi } from "vitest";
import { activeThemeColors } from "../../themes/index.js";
import { stripAnsi } from "../cathedral/ansi.js";
import { NotificationCenter, renderHostNotice } from "./notification.js";

function rgb(hex: string): string {
	const normalized = hex.replace("#", "");
	return `${Number.parseInt(normalized.slice(0, 2), 16)};${Number.parseInt(normalized.slice(2, 4), 16)};${Number.parseInt(normalized.slice(4, 6), 16)}`;
}

afterEach(() => vi.useRealTimers());

describe("NotificationCenter host notices", () => {
	it("keeps a transient hint in the notice slot and paints no overlay rows (issue 481: no top-right toast surface)", () => {
		const notifications = new NotificationCenter();
		const id = notifications.notify("new session");
		expect(notifications.getNotice()).toEqual({ message: "new session", level: "info", sticky: false });
		expect(notifications.render(80)).toEqual([]);
		expect(notifications.render(1)).toEqual([]);
		expect(notifications.getToasts()).toEqual([]);
		notifications.dismiss(id);
		expect(notifications.getNotice()).toBeUndefined();
	});

	it("expires a transient hint after its timeout and leaves no timer behind", () => {
		vi.useFakeTimers();
		const onChange = vi.fn();
		const notifications = new NotificationCenter({ defaultTimeoutMs: 3_000, onChange });
		notifications.notify("press ctrl-c again to quit", "info", { timeoutMs: 1_500 });
		expect(onChange).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1_499);
		expect(notifications.getNotice()?.message).toBe("press ctrl-c again to quit");
		vi.advanceTimersByTime(1);
		expect(notifications.getNotice()).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
		expect(onChange).toHaveBeenCalledTimes(2);
	});

	it("keeps an error sticky until dismissed, with no expiry timer", () => {
		vi.useFakeTimers();
		const notifications = new NotificationCenter();
		const id = notifications.notify("rpc error: memory offline", "error");
		expect(notifications.getNotice()).toEqual({ message: "rpc error: memory offline", level: "error", sticky: true });
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(60_000);
		expect(notifications.getNotice()?.message).toBe("rpc error: memory offline");
		notifications.dismiss(id);
		expect(notifications.getNotice()).toBeUndefined();
	});

	it("treats an explicit sticky option as sticky (the child-exit notice convention)", () => {
		vi.useFakeTimers();
		const notifications = new NotificationCenter();
		notifications.notify("RPC child exited unexpectedly", "error", { sticky: true });
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(60_000);
		expect(notifications.getNotice()?.sticky).toBe(true);
		notifications.dispose();
		expect(notifications.getNotice()).toBeUndefined();
	});

	it("keeps one slot: a repeated notice refreshes instead of stacking, a later one replaces", () => {
		vi.useFakeTimers();
		const onChange = vi.fn();
		const notifications = new NotificationCenter({ defaultTimeoutMs: 3_000, onChange });
		const first = notifications.notify("branch summary in progress", "warning");
		for (let index = 0; index < 7; index += 1) notifications.notify("branch summary in progress", "warning");
		expect(notifications.getNotice()?.message).toBe("branch summary in progress");
		expect(onChange).toHaveBeenCalledTimes(1);
		// The repeat refreshed the expiry rather than letting the first timer fire.
		vi.advanceTimersByTime(2_999);
		expect(notifications.getNotice()?.message).toBe("branch summary in progress");
		notifications.notify("no models available", "warning");
		expect(notifications.getNotice()?.message).toBe("no models available");
		expect(first).toBeGreaterThan(0);
		expect(onChange).toHaveBeenCalledTimes(2);
	});

	it("dismisses a hint on a keystroke but leaves a sticky failure alone", () => {
		const notifications = new NotificationCenter();
		notifications.notify("exported: /tmp/session.html");
		notifications.dismissTransient();
		expect(notifications.getNotice()).toBeUndefined();
		notifications.notify("unknown model: nope", "warning", { sticky: true });
		notifications.dismissTransient();
		expect(notifications.getNotice()?.message).toBe("unknown model: nope");
		notifications.dismissSticky();
		expect(notifications.getNotice()).toBeUndefined();
	});

	it("clears the expiry timer on clear and dispose", () => {
		vi.useFakeTimers();
		const notifications = new NotificationCenter();
		notifications.notify("first");
		notifications.clear();
		expect(vi.getTimerCount()).toBe(0);
		notifications.notify("second");
		notifications.dispose();
		expect(vi.getTimerCount()).toBe(0);
		expect(notifications.getNotice()).toBeUndefined();
	});

	it("caps an over-long sticky failure and ellipsizes the last retained row", () => {
		const rows = renderHostNotice({ message: `rpc error: ${"stderr tail ".repeat(200)}`, level: "error", sticky: true }, 40);
		expect(rows).toHaveLength(6);
		expect(rows.every((row) => stripAnsi(row).length === 40)).toBe(true);
		expect(stripAnsi(rows[5]!).trimEnd().endsWith("…")).toBe(true);
	});

	it("renders a sticky failure in the rust/approval tone", () => {
		const rows = renderHostNotice({ message: "unknown model: nope", level: "warning", sticky: true }, 40);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain(rgb(activeThemeColors().states.approval));
		expect(stripAnsi(rows[0]!)).toContain("unknown model: nope");
	});
});
