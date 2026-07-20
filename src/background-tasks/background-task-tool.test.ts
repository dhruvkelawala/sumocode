import { describe, expect, it, vi } from "vitest";
import { installBackgroundTasks } from "./background-task-tool.js";

describe("installBackgroundTasks", () => {
	it("keeps manager lifecycle wiring and the /bg viewer alias without registering a mega-tool", async () => {
		const registerTool = vi.fn();
		let bgCommand: { description: string; handler: (args: string, ctx: { ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void> } | undefined;
		const registerCommand = vi.fn((name: string, command: typeof bgCommand) => {
			if (name === "bg") bgCommand = command;
		});
		const on = vi.fn();
		const pi = { registerTool, registerCommand, on };

		installBackgroundTasks(pi as never);

		expect(registerTool).not.toHaveBeenCalled();
		expect(registerCommand).toHaveBeenCalledOnce();
		expect(registerCommand).toHaveBeenCalledWith("bg", expect.objectContaining({ description: expect.stringContaining("/ps") }));
		expect(registerCommand).not.toHaveBeenCalledWith("bg-run", expect.anything());
		expect(on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));

		const notify = vi.fn();
		await bgCommand?.handler("", { ui: { notify } });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Use /ps for the full process viewer."), "info");
	});
});
