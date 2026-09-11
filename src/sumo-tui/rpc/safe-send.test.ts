import { describe, expect, it, vi } from "vitest";
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

	it("dismisses the previous sticky failure after the action completes successfully", async () => {
		const dismissSticky = vi.fn();

		await notifyOnError(async () => undefined, {
			notify: vi.fn(),
			dismissSticky,
		});

		expect(dismissSticky).toHaveBeenCalledTimes(1);
	});

	it("leaves the notice alone when the action fails so the failure notice re-arms it", async () => {
		const dismissSticky = vi.fn();

		await notifyOnError(async () => {
			throw new Error("memory offline");
		}, {
			notify: vi.fn(),
			dismissSticky,
		});

		expect(dismissSticky).not.toHaveBeenCalled();
	});
});
