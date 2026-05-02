import { describe, expect, it, vi } from "vitest";
import { registerExitCommand } from "./exit.js";

describe("/exit slash command", () => {
	it("registers an alias that shuts down SumoCode cleanly", async () => {
		let handler: ((args: string, ctx: { shutdown: () => void }) => Promise<void>) | undefined;
		const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		});
		const shutdown = vi.fn();

		registerExitCommand({ registerCommand } as never);
		await handler?.("", { shutdown });

		expect(registerCommand).toHaveBeenCalledWith("exit", expect.objectContaining({
			description: "Exit SumoCode cleanly",
		}));
		expect(shutdown).toHaveBeenCalledOnce();
	});
});
