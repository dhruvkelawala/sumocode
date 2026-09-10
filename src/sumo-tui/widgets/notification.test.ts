import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationCenter } from "./notification.js";

afterEach(() => vi.useRealTimers());

describe("NotificationCenter", () => {
	it("tracks toasts but paints no rows at any width (issue 481: no top-right toast surface)", () => {
		const notifications = new NotificationCenter({ defaultTimeoutMs: 0 });
		const id = notifications.notify("quiet notice");
		expect(notifications.getToasts()).toMatchObject([{ id, message: "quiet notice", level: "info" }]);
		expect(notifications.render(80)).toEqual([]);
		expect(notifications.render(1)).toEqual([]);
		notifications.dismiss(id);
		expect(notifications.getToasts()).toHaveLength(0);
	});

	it("auto-dismisses toasts after the timeout while still painting nothing", () => {
		vi.useFakeTimers();
		const notifications = new NotificationCenter({ defaultTimeoutMs: 500 });
		notifications.notify("temporary");
		expect(notifications.render(80)).toEqual([]);
		vi.advanceTimersByTime(500);
		expect(notifications.getToasts()).toHaveLength(0);
		notifications.dispose();
	});
});
