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

	it("returns successful at_capacity result instead of throwing when agent cap is full", async () => {
		const originalSurface = process.env.CMUX_SURFACE_ID;
		const originalCapacity = process.env.SUMOCODE_BG_AGENT_CAPACITY;
		process.env.CMUX_SURFACE_ID = "surface:1";
		process.env.SUMOCODE_BG_AGENT_CAPACITY = "1";
		try {
			const cmuxSplit = await import("../commands/cmux-split.js");
			vi.spyOn(cmuxSplit, "openCommandInNewSplitWithRefs").mockResolvedValue({
				ok: true,
				workspaceRef: "workspace:1",
				surfaceRef: "surface:2",
			});
			let tool: { execute: (...args: never[]) => Promise<{ content: Array<{ text: string }>; details?: unknown }> } | undefined;
			const registerTool = vi.fn((definition) => {
				tool = definition;
			});
			const pi = {
				registerTool,
				registerCommand: vi.fn(),
				on: vi.fn(),
				sendUserMessage: vi.fn(),
				exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "", killed: false })),
			};
			installBackgroundTasks(pi as never);

			await tool?.execute(
				"call-1" as never,
				{ action: "spawn", command: "review one", runner: "sumocode", visible: true, title: "agent one" } as never,
				undefined as never,
				undefined as never,
				{ cwd: "/repo" } as never,
			);
			const result = await tool?.execute(
				"call-2" as never,
				{ action: "spawn", command: "review two", runner: "sumocode", visible: true } as never,
				undefined as never,
				undefined as never,
				{ cwd: "/repo" } as never,
			);

			expect(result?.content[0]?.text).toContain("status=at_capacity");
			expect(result?.details).toMatchObject({
				action: "spawn",
				status: "at_capacity",
				capacity: 1,
				runningCount: 1,
			});
		} finally {
			if (originalSurface === undefined) delete process.env.CMUX_SURFACE_ID;
			else process.env.CMUX_SURFACE_ID = originalSurface;
			if (originalCapacity === undefined) delete process.env.SUMOCODE_BG_AGENT_CAPACITY;
			else process.env.SUMOCODE_BG_AGENT_CAPACITY = originalCapacity;
		}
	});
});
