import { describe, expect, it, vi } from "vitest";
import { registerSlateCommand, getSlate } from "./slate.js";

describe("/slate slash command", () => {
	it("registers /slate command and two tools on the pi API", () => {
		const registerCommand = vi.fn();
		const registerTool = vi.fn();
		const on = vi.fn();
		registerSlateCommand({ registerCommand, registerTool, on } as never);

		expect(registerCommand).toHaveBeenCalledWith(
			"slate",
			expect.objectContaining({ description: expect.stringContaining("Park an idea") }),
		);
		expect(registerTool).toHaveBeenCalledTimes(2);
		const toolNames = registerTool.mock.calls.map((call: unknown[]) => (call[0] as { name: string }).name);
		expect(toolNames).toContain("slate_list");
		expect(toolNames).toContain("slate_done");
	});

	it("subscribes to session_start and session_shutdown", () => {
		const on = vi.fn();
		registerSlateCommand({ registerCommand: vi.fn(), registerTool: vi.fn(), on } as never);

		const eventNames = on.mock.calls.map((call: unknown[]) => call[0]);
		expect(eventNames).toContain("session_start");
		expect(eventNames).toContain("session_shutdown");
	});

	it("prints a message in non-interactive mode", async () => {
		let handler: ((args: string[], ctx: unknown) => Promise<void>) | undefined;
		const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		});
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		registerSlateCommand({ registerCommand, registerTool: vi.fn(), on: vi.fn() } as never);

		try {
			await handler?.([], { hasUI: false });
			expect(stdout).toHaveBeenCalledWith("slate requires interactive UI\n");
		} finally {
			stdout.mockRestore();
		}
	});
});

describe("slate_list tool", () => {
	it("returns empty message when slate is empty", async () => {
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { type: string; text: string }[] }> }>();
		const registerTool = vi.fn((def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
			tools.set(def.name, def as never);
		});
		registerSlateCommand({ registerCommand: vi.fn(), registerTool, on: vi.fn() } as never);

		// Clear the slate
		getSlate().clear();

		const result = await tools.get("slate_list")!.execute("id", {}, undefined, undefined, {});
		expect(result.content[0]!.text).toContain("empty");
	});

	it("returns numbered list when slate has items", async () => {
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { type: string; text: string }[] }> }>();
		const registerTool = vi.fn((def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
			tools.set(def.name, def as never);
		});
		registerSlateCommand({ registerCommand: vi.fn(), registerTool, on: vi.fn() } as never);

		getSlate().clear();
		getSlate().add("fix cursor");
		getSlate().add("refactor sidebar");

		const result = await tools.get("slate_list")!.execute("id", {}, undefined, undefined, {});
		expect(result.content[0]!.text).toContain("1. fix cursor");
		expect(result.content[0]!.text).toContain("2. refactor sidebar");
	});
});

describe("slate_done tool", () => {
	it("removes item at given index", async () => {
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }> }>();
		const registerTool = vi.fn((def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
			tools.set(def.name, def as never);
		});
		registerSlateCommand({ registerCommand: vi.fn(), registerTool, on: vi.fn() } as never);

		getSlate().clear();
		getSlate().add("A");
		getSlate().add("B");

		const result = await tools.get("slate_done")!.execute("id", { index: 1 }, undefined, undefined, {});
		expect(result.content[0]!.text).toContain("Resolved: \"A\"");
		expect(result.isError).toBeUndefined();
		expect(getSlate().list()).toEqual(["B"]);
	});

	it("returns error for out-of-bounds index", async () => {
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }> }>();
		const registerTool = vi.fn((def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
			tools.set(def.name, def as never);
		});
		registerSlateCommand({ registerCommand: vi.fn(), registerTool, on: vi.fn() } as never);

		getSlate().clear();

		const result = await tools.get("slate_done")!.execute("id", { index: 5 }, undefined, undefined, {});
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("No item at index 5");
	});
});
