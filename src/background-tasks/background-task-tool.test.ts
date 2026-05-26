import { describe, expect, it, vi } from "vitest";
import { installBackgroundTasks } from "./background-task-tool.js";

describe("installBackgroundTasks", () => {
	it("registers bg_task tool and /bg commands", () => {
		const registerTool = vi.fn();
		const registerCommand = vi.fn();
		const on = vi.fn();
		const pi = { registerTool, registerCommand, on };

		installBackgroundTasks(pi as never);

		expect(registerTool).toHaveBeenCalledOnce();
		expect(registerTool.mock.calls[0]?.[0]?.name).toBe("bg_task");
		expect(registerCommand).toHaveBeenCalledWith("bg", expect.any(Object));
		expect(registerCommand).toHaveBeenCalledWith("bg-run", expect.any(Object));
		expect(on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
	});
});
