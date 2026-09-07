import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { installTaskModeAutoExit, resetTaskMarkerEnvForTests } from "../../src/task-mode.js";
import { recoveryFinalText } from "./fixtures/plan112-source-controller.js";

afterEach(() => { resetTaskMarkerEnvForTests(); vi.useRealTimers(); });

it("expects visible recovery to preserve the task response writer's exact bytes", () => {
	vi.useFakeTimers();
	const task = realpathSync(mkdtempSync(join(tmpdir(), "recovery-response-")));
	chmodSync(task, 0o700);
	mkdirSync(join(task, "control"), { mode: 0o700 });
	const context = { ui: { setStatus: () => undefined }, shutdown: () => undefined };
	// The synthetic provider emits this text without a trailing newline.
	const message = { role: "assistant", content: [{ type: "text", text: "preserved result" }] };
	type Handler = (event: { messages?: Array<typeof message> }, ctx: typeof context) => void;
	const handlers = new Map<string, Handler>();
	// SAFETY: task mode only registers handlers; this test supplies their event/context boundary.
	installTaskModeAutoExit({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as never, {
		env: { SUMOCODE_TASK_MODE: "1", SUMOCODE_TASK_RESPONSE_FILE: join(task, "response.md"), SUMOCODE_TASK_CONTROL_DIR: join(task, "control") },
		graceMs: 0,
	});
	try {
		handlers.get("agent_end")!({ messages: [message] }, context);
		const response = readFileSync(join(task, "response.md"), "utf8");
		expect(response).toBe("preserved result\n");
		expect(response).toBe(recoveryFinalText.visible);
		expect(recoveryFinalText.headless).toBe("preserved result");
	} finally { handlers.get("session_shutdown")!({}, context); }
});
