import { describe, expect, it, vi } from "vitest";
import { registerApprovalCommand } from "./approval.js";

/** Minimal command-handler context shape exercised by these tests. */
type CommandHandler = (
	args: string[],
	ctx: {
		hasUI: boolean;
		mode?: string;
		ui?: {
			custom?: (...args: unknown[]) => Promise<string | number>;
			notify?: (...args: unknown[]) => void;
		};
	},
) => Promise<void>;

describe("/sumo:approval slash command", () => {
	it("registers /sumo:approval on the pi API", () => {
		const registerCommand = vi.fn();
		// SAFETY: test double only exercises registerCommand, the sole member used here.
		registerApprovalCommand({ registerCommand } as never);

		expect(registerCommand).toHaveBeenCalledWith(
			"sumo:approval",
			expect.objectContaining({ description: "Open a test Cathedral approval modal" }),
		);
	});

	it("opens the approval modal and reports the selected choice", async () => {
		let handler: CommandHandler | undefined;
		const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		});
		const custom = vi.fn(async () => "yes");
		const notify = vi.fn();
		// SAFETY: test double only exercises registerCommand, the sole member used here.
		registerApprovalCommand({ registerCommand } as never);

		await handler?.([], { hasUI: true, ui: { custom, notify } });

		expect(custom).toHaveBeenCalledTimes(1);
		// SAFETY: the modal branch always passes a single options object as the second custom() argument.
		const [, options] = custom.mock.calls[0] as unknown[];
		expect(options).toMatchObject({ overlay: true });
		expect(notify).toHaveBeenCalledWith("Approval selected: yes", "info");
	});

	it("defers in RPC mode without opening custom UI or reporting a fake selection", async () => {
		let handler: CommandHandler | undefined;
		const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		});
		const custom = vi.fn(async () => "yes");
		const notify = vi.fn();
		// SAFETY: test double only exercises registerCommand, the sole member used here.
		registerApprovalCommand({ registerCommand } as never);

		await handler?.([], { hasUI: true, mode: "rpc", ui: { custom, notify } });

		expect(custom).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith("approval modal unavailable in RPC mode", "warning");
		expect(notify).not.toHaveBeenCalledWith("Approval selected: yes", "info");
	});

	it("prints a message in non-interactive mode", async () => {
		let handler: CommandHandler | undefined;
		const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		});
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		// SAFETY: test double only exercises registerCommand, the sole member used here.
		registerApprovalCommand({ registerCommand } as never);

		try {
			await handler?.([], { hasUI: false });
			expect(stdout).toHaveBeenCalledWith("sumo:approval requires interactive UI\n");
		} finally {
			stdout.mockRestore();
		}
	});
});
