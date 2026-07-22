import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installBackgroundTasks } from "./background-task-tool.js";
import { TerminalTaskStore } from "./task-store.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("installBackgroundTasks", () => {
	it("wires lifecycle without retaining the legacy slash alias or a mega-tool", async () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
		const pi = {
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
			on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(event, handler)),
		};
		const rootDir = mkdtempSync(join(tmpdir(), "sumocode-terminal-install-"));
		roots.push(rootDir);
		const manager = installBackgroundTasks(pi as never, { store: new TerminalTaskStore({ rootDir }) });
		const detach = vi.spyOn(manager, "detach");
		const stopOwned = vi.spyOn(manager, "stopOwned").mockResolvedValue([]);

		expect(pi.registerTool).not.toHaveBeenCalled();
		expect(pi.registerCommand).not.toHaveBeenCalled();
		expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));

		await handlers.get("session_shutdown")?.({ reason: "resume" }, { sessionManager: { getSessionId: () => "session-a" } });
		expect(stopOwned).not.toHaveBeenCalled();
		expect(detach).not.toHaveBeenCalled();

		await handlers.get("session_shutdown")?.({ reason: "quit" }, { sessionManager: { getSessionId: () => "session-a" } });
		expect(stopOwned).toHaveBeenCalledWith("session-a");
		expect(detach).toHaveBeenCalledOnce();
	});
});
