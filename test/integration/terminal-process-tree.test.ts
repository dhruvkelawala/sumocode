import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalTaskManager } from "../../src/background-tasks/task-manager.js";
import { TerminalTaskStore } from "../../src/background-tasks/task-store.js";
import { shellEscape } from "../../src/background-tasks/visible-spawn.js";

const roots: string[] = [];
const managers: TerminalTaskManager[] = [];

afterEach(() => {
	for (const manager of managers.splice(0)) manager.detach();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("terminal process-tree integration", () => {
	it("escalates against a SIGTERM-ignoring descendant and proves the group is gone", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "sumocode-terminal-tree-integration-"));
		roots.push(rootDir);
		const descendantPidFile = join(rootDir, "descendant.pid");
		const program = [
			"const fs = require('node:fs')",
			`fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(process.pid))`,
			"process.on('SIGTERM', () => {})",
			"setInterval(() => {}, 1000)",
		].join(";");
		const manager = new TerminalTaskManager({
			store: new TerminalTaskStore({ rootDir }),
			termGraceMs: 100,
			killGraceMs: 2_000,
			pollIntervalMs: 25,
		});
		managers.push(manager);
		const task = await manager.start({
			ownerSessionId: "integration-session",
			command: `node -e ${shellEscape(program)}`,
			cwd: process.cwd(),
			title: "SIGTERM-resistant descendant",
		});
		await vi.waitFor(() => expect(existsSync(descendantPidFile)).toBe(true), { timeout: 2_000 });
		const descendantPid = Number.parseInt(readFileSync(descendantPidFile, "utf8"), 10);

		const result = await manager.stop([task.id], "integration-session");

		expect(result[0]).toMatchObject({ outcome: "cancelled", task: { status: "cancelled" } });
		expect(() => process.kill(descendantPid, 0)).toThrow();
	});
});
