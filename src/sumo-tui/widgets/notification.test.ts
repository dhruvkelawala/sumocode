import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationCenter } from "./notification.js";

afterEach(() => vi.useRealTimers());

describe("NotificationCenter", () => {
	it("retains no toasts and paints no rows at any width (issue 481: no top-right toast surface)", () => {
		const notifications = new NotificationCenter({ defaultTimeoutMs: 0 });
		const id = notifications.notify("quiet notice");
		expect(id).toBeGreaterThan(0);
		expect(notifications.getToasts()).toEqual([]);
		expect(notifications.render(80)).toEqual([]);
		expect(notifications.render(1)).toEqual([]);
		notifications.dismiss(id);
		notifications.clear();
		expect(notifications.getToasts()).toEqual([]);
	});

	it("schedules no expiry timer and fires no render callback", () => {
		vi.useFakeTimers();
		const onChange = vi.fn();
		const notifications = new NotificationCenter({ defaultTimeoutMs: 500, onChange });
		notifications.notify("temporary");
		expect(notifications.getToasts()).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(10_000);
		expect(notifications.getToasts()).toEqual([]);
		expect(onChange).not.toHaveBeenCalled();
		notifications.dismiss(1);
		notifications.clear();
		notifications.dispose();
		expect(onChange).not.toHaveBeenCalled();
	});
});
