import { describe, expect, it, vi } from "vitest";
import { registerApprovalCommand } from "./approval.js";

describe("/sumo:approval slash command", () => {
	it("registers /sumo:approval on the pi API", () => {
		const registerCommand = vi.fn();
		registerApprovalCommand({ registerCommand } as never);

		expect(registerCommand).toHaveBeenCalledWith(
			"sumo:approval",
			expect.objectContaining({ description: "Open a test Cathedral approval modal" }),
		);
	});

	it("opens the approval modal and reports the selected choice", async () => {
		let handler: ((args: string[], ctx: unknown) => Promise<void>) | undefined;
		const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		});
		const custom = vi.fn(async () => "yes");
		const notify = vi.fn();
		registerApprovalCommand({ registerCommand } as never);

		await handler?.([], { hasUI: true, ui: { custom, notify } });

		expect(custom).toHaveBeenCalledTimes(1);
		const [, options] = custom.mock.calls[0] as unknown[];
		expect(options).toMatchObject({ overlay: true });
		expect(notify).toHaveBeenCalledWith("Approval selected: yes", "info");
	});

	it("prints a message in non-interactive mode", async () => {
		let handler: ((args: string[], ctx: unknown) => Promise<void>) | undefined;
		const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		});
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		registerApprovalCommand({ registerCommand } as never);

		try {
			await handler?.([], { hasUI: false });
			expect(stdout).toHaveBeenCalledWith("sumo:approval requires interactive UI\n");
		} finally {
			stdout.mockRestore();
		}
	});
});
