import { describe, expect, it, vi } from "vitest";
import { registerThemeCheckCommand } from "./theme-check.js";

function registerHarness() {
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
		handler = options.handler;
	});
	registerThemeCheckCommand({ registerCommand } as never);
	return { handler: handler!, registerCommand };
}

describe("/sumo:theme-check", () => {
	it("defers visibly in RPC mode without opening custom UI", async () => {
		const { handler } = registerHarness();
		const notify = vi.fn();
		const custom = vi.fn();

		await handler("", { hasUI: true, mode: "rpc", ui: { notify, custom } });

		expect(notify).toHaveBeenCalledWith("theme-check overlay unavailable in RPC mode", "warning");
		expect(custom).not.toHaveBeenCalled();
	});

	it("keeps opening the custom overlay in TUI mode", async () => {
		const { handler } = registerHarness();
		const custom = vi.fn(async () => undefined);

		await handler("", { hasUI: true, mode: "tui", ui: { custom } });

		expect(custom).toHaveBeenCalledTimes(1);
	});
});
