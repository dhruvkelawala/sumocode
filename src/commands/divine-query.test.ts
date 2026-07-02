import { describe, expect, it, vi } from "vitest";
import { registerDivineQueryCommand } from "./divine-query.js";

describe("/sumo:query slash command", () => {
	it("registers /sumo:query on the pi API", () => {
		const registerCommand = vi.fn();
		registerDivineQueryCommand({ registerCommand } as never);

		expect(registerCommand).toHaveBeenCalledWith(
			"sumo:query",
			expect.objectContaining({ description: "Open a test Cathedral Divine Query modal" }),
		);
	});

	it("opens the Divine Query overlay and reports the selected option", async () => {
		let handler: ((args: string[], ctx: unknown) => Promise<void>) | undefined;
		const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		});
		const custom = vi.fn(async () => 0);
		const notify = vi.fn();
		registerDivineQueryCommand({ registerCommand } as never);

		await handler?.([], { hasUI: true, ui: { custom, notify } });

		expect(custom).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith("Divine Query selected: Looks good — ship it", "info");
	});

	it("uses primitive select in RPC mode and reports the selected option", async () => {
		let handler: ((args: string[], ctx: unknown) => Promise<void>) | undefined;
		const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		});
		const select = vi.fn(async () => "Needs visual polish");
		const custom = vi.fn();
		const notify = vi.fn();
		registerDivineQueryCommand({ registerCommand } as never);

		await handler?.([], { hasUI: true, mode: "rpc", ui: { select, custom, notify } });

		expect(select).toHaveBeenCalledTimes(1);
		expect(custom).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Divine Query selected: Needs visual polish", "info");
	});

	it("prints a message in non-interactive mode", async () => {
		let handler: ((args: string[], ctx: unknown) => Promise<void>) | undefined;
		const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		});
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		registerDivineQueryCommand({ registerCommand } as never);

		try {
			await handler?.([], { hasUI: false });
			expect(stdout).toHaveBeenCalledWith("sumo:query requires interactive UI\n");
		} finally {
			stdout.mockRestore();
		}
	});
});
