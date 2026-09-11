import { describe, expect, it, vi } from "vitest";
import { NotificationCenter } from "../widgets/notification.js";
import type { NotificationLevel } from "../widgets/notification.js";
import { notifyOnError } from "./safe-send.js";

describe("notifyOnError", () => {
	it("runs successful actions without notifying", async () => {
		const notifications: Array<{ message: string; level?: NotificationLevel }> = [];

		await notifyOnError(async () => undefined, {
			notify: (message, level) => notifications.push({ message, level }),
		});

		expect(notifications).toEqual([]);
	});

	it("catches failures and emits a terse rpc error notification", async () => {
		const notifications: Array<{ message: string; level?: NotificationLevel }> = [];

		await notifyOnError(async () => {
			throw new Error("memory offline");
		}, {
			notify: (message, level) => notifications.push({ message, level }),
		});

		expect(notifications).toEqual([{ message: "rpc error: memory offline", level: "error" }]);
	});

	it("clears a stale sticky failure through the notifier hook before invoking the action", async () => {
		const order: string[] = [];

		await notifyOnError(() => {
			order.push("action");
		}, {
			notify: vi.fn(),
			dismissSticky: () => order.push("dismiss"),
		});

		expect(order).toEqual(["dismiss", "action"]);
	});

	it("dismisses a stale sticky failure before the action runs, so the notice is gone at action start", async () => {
		const notifications = new NotificationCenter();
		notifications.notify("unknown command: stale", "warning", { sticky: true });
		let noticeAtActionStart: string | undefined = "unset";

		await notifyOnError(async () => {
			noticeAtActionStart = notifications.getNotice()?.message;
		}, notifications);

		expect(noticeAtActionStart).toBeUndefined();
	});

	// Regression (issue 481 home B): host commands report validation rejections
	// by returning normally *after* raising their own sticky notice (unknown
	// command/model/thinking level, memory unavailable, login already in
	// progress). A post-action dismiss cleared them microseconds after they were
	// raised; the clear must happen at the action's entry instead.
	it("keeps a sticky notice an action raises and then returns normally", async () => {
		const notifications = new NotificationCenter();

		await notifyOnError(async () => {
			notifications.notify("unknown command: /sumo:does-not-exist", "warning", { sticky: true });
		}, notifications);

		expect(notifications.getNotice()).toEqual({
			message: "unknown command: /sumo:does-not-exist",
			level: "warning",
			sticky: true,
		});
	});

	it("replaces a stale sticky failure with the failing action's own error notice", async () => {
		const notifications = new NotificationCenter();
		notifications.notify("unknown model: stale", "warning", { sticky: true });

		await notifyOnError(async () => {
			throw new Error("memory offline");
		}, notifications);

		expect(notifications.getNotice()).toEqual({ message: "rpc error: memory offline", level: "error", sticky: true });
	});
});
