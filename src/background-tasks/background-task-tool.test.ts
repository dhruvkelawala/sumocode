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

function lifecycleHarness() {
	const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void> | void>();
	const pi = {
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		on: vi.fn((event: string, handler: (event: unknown, ctx: any) => Promise<void> | void) => handlers.set(event, handler)),
	};
	return { pi, handlers };
}

describe("installBackgroundTasks", () => {
	it("detaches replaced managers and keeps process-session quit ownership across factory instances", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "sumocode-terminal-install-"));
		roots.push(rootDir);
		const firstRuntime = lifecycleHarness();
		const first = installBackgroundTasks(firstRuntime.pi as never, { store: new TerminalTaskStore({ rootDir }) });
		const firstDetach = vi.spyOn(first, "detach");
		const firstStopOwned = vi.spyOn(first, "stopOwned").mockResolvedValue([]);

		expect(firstRuntime.pi.registerTool).not.toHaveBeenCalled();
		expect(firstRuntime.pi.registerCommand).not.toHaveBeenCalled();
		await firstRuntime.handlers.get("session_start")?.({}, { sessionManager: { getSessionId: () => "session-a" } });
		await firstRuntime.handlers.get("session_shutdown")?.({ reason: "new" }, { sessionManager: { getSessionId: () => "session-a" } });
		expect(firstStopOwned).not.toHaveBeenCalled();
		expect(firstDetach).toHaveBeenCalledOnce();

		const replacementRuntime = lifecycleHarness();
		const replacement = installBackgroundTasks(replacementRuntime.pi as never, { store: new TerminalTaskStore({ rootDir }) });
		const replacementDetach = vi.spyOn(replacement, "detach");
		const replacementStopOwned = vi.spyOn(replacement, "stopOwned").mockResolvedValue([]);
		await replacementRuntime.handlers.get("session_start")?.({}, { sessionManager: { getSessionId: () => "session-b" } });
		await replacementRuntime.handlers.get("session_shutdown")?.({ reason: "quit" }, { sessionManager: { getSessionId: () => "session-b" } });

		expect(replacementStopOwned).toHaveBeenCalledTimes(2);
		expect(replacementStopOwned).toHaveBeenCalledWith("session-a");
		expect(replacementStopOwned).toHaveBeenCalledWith("session-b");
		expect(replacementDetach).toHaveBeenCalledOnce();
	});
});
