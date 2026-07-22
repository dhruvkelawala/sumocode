import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaleTerminalTaskRevisionError, TerminalTaskStore } from "./task-store.js";
import { TERMINAL_TASK_SCHEMA_VERSION, type TerminalTaskSnapshot } from "./task-types.js";

function snapshot(id: string, ownerSessionId = "session-a"): TerminalTaskSnapshot {
	return {
		schemaVersion: TERMINAL_TASK_SCHEMA_VERSION,
		revision: 1,
		id,
		ownerSessionId,
		command: "pnpm test",
		cwd: "/repo",
		title: "tests",
		status: "starting",
		completionPolicy: "passive",
		createdAt: 1_000,
		updatedAt: 1_000,
		deliveryState: "none",
		logFile: `/tmp/${id}/output.log`,
	};
}

describe("TerminalTaskStore", () => {
	let rootDir: string;

	beforeEach(() => {
		rootDir = mkdtempSync(join(tmpdir(), "sumocode-terminal-store-"));
	});

	afterEach(() => {
		rmSync(rootDir, { recursive: true, force: true });
	});

	it("persists atomic revision-checked transitions", () => {
		const store = new TerminalTaskStore({ rootDir });
		const initial = snapshot("term-a");
		const metaPath = join(rootDir, "term-a-1000", "meta.json");
		store.create(initial, metaPath);

		const running = store.transition(initial.id, 1, (current) => ({
			...current,
			status: "running",
			updatedAt: 2_000,
			pid: 42,
			processGroupId: 42,
			processStartTime: "start",
		}));

		expect(running.revision).toBe(2);
		expect(store.get(initial.id)).toEqual(running);
		expect(readdirSync(join(rootDir, "term-a-1000"))).toEqual(["meta.json"]);
		expect(() => store.transition(initial.id, 1, (current) => ({ ...current }))).toThrow(StaleTerminalTaskRevisionError);
	});

	it("filters records by durable owner session", () => {
		const store = new TerminalTaskStore({ rootDir });
		store.create(snapshot("term-a", "session-a"), join(rootDir, "term-a-1000", "meta.json"));
		store.create(snapshot("term-b", "session-b"), join(rootDir, "term-b-1000", "meta.json"));

		expect(store.listOwned("session-a").map((task) => task.id)).toEqual(["term-a"]);
		expect(store.getOwned("term-b", "session-a")).toBeUndefined();
		expect(store.getOwned("term-b", "session-b")?.id).toBe("term-b");
	});

	it("logically quarantines corrupt and legacy records without overwriting them", () => {
		const onDiagnostic = vi.fn();
		const corruptDir = join(rootDir, "corrupt");
		const legacyDir = join(rootDir, "legacy");
		mkdirSync(corruptDir, { recursive: true });
		mkdirSync(legacyDir, { recursive: true });
		const corruptPath = join(corruptDir, "meta.json");
		const legacyPath = join(legacyDir, "meta.json");
		writeFileSync(corruptPath, "{not json");
		writeFileSync(legacyPath, JSON.stringify({ schemaVersion: 3, id: "bg-old" }));

		const store = new TerminalTaskStore({ rootDir, onDiagnostic });

		expect(store.loadAll()).toEqual([]);
		expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ kind: "corrupt", path: corruptPath }));
		expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ kind: "legacy", path: legacyPath }));
		expect(existsSync(corruptPath)).toBe(true);
		expect(existsSync(legacyPath)).toBe(true);
	});
});
