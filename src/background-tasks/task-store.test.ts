import { execFile } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	StaleTerminalTaskRevisionError,
	TerminalTaskLockBusyError,
	TerminalTaskStore,
	parseTerminalTaskSnapshot,
} from "./task-store.js";
import { TERMINAL_TASK_SCHEMA_VERSION, type TerminalTaskSnapshot } from "./task-types.js";

function privateWrite(path: string, contents: string): void {
	writeFileSync(path, contents, { mode: 0o600 });
	chmodSync(path, 0o600);
}

function taskDirectory(store: TerminalTaskStore, id: string, createdAt = 1_000): string {
	const directory = join(store.rootDir, `${id}-${createdAt}`);
	mkdirSync(directory, { mode: 0o700 });
	chmodSync(directory, 0o700);
	privateWrite(join(directory, "output.log"), "");
	return directory;
}

function snapshot(store: TerminalTaskStore, id: string, ownerSessionId = "session-a"): TerminalTaskSnapshot {
	const directory = taskDirectory(store, id);
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
		logFile: join(directory, "output.log"),
	};
}

function runRacer(rootDir: string, id: string, gate: string, ready: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const fixture = fileURLToPath(new URL("../../test/fixtures/terminal-store-racer.ts", import.meta.url));
	return new Promise((resolve, reject) => {
		const child = execFile(join(process.cwd(), "node_modules", ".bin", "jiti"), [fixture, rootDir, id, gate, ready], (error, stdout, stderr) => {
			if (error && !("code" in error)) reject(error);
			else resolve({ code: child.exitCode, stdout, stderr });
		});
	});
}

describe("TerminalTaskStore", () => {
	let rootDir: string;

	beforeEach(() => {
		rootDir = mkdtempSync(join(tmpdir(), "sumocode-terminal-store-"));
		chmodSync(rootDir, 0o700);
	});

	afterEach(() => {
		rmSync(rootDir, { recursive: true, force: true });
	});

	it("persists atomic revision-checked transitions", () => {
		const store = new TerminalTaskStore({ rootDir });
		const initial = snapshot(store, "term-a");
		const metaPath = join(dirname(initial.logFile), "meta.json");
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
		expect(() => store.transition(initial.id, 1, (current) => ({ ...current }))).toThrow(StaleTerminalTaskRevisionError);
	});

	it("serializes CAS across store instances so one writer succeeds and one is stale", async () => {
		const first = new TerminalTaskStore({ rootDir });
		const initial = snapshot(first, "term-race");
		first.create(initial, join(dirname(initial.logFile), "meta.json"));
		const second = new TerminalTaskStore({ rootDir });
		second.loadAll();

		const winner = first.transition(initial.id, 1, (current) => ({ ...current, title: "first", updatedAt: 2_000 }));
		expect(winner.title).toBe("first");
		expect(() => second.transition(initial.id, 1, (current) => ({ ...current, title: "second", updatedAt: 2_000 }))).toThrow(StaleTerminalTaskRevisionError);
		expect(new TerminalTaskStore({ rootDir }).loadAll()[0]?.title).toBe("first");
	});

	it("serializes a real subprocess revision race with one success and one stale result", async () => {
		const store = new TerminalTaskStore({ rootDir });
		const initial = snapshot(store, "term-subprocess-race");
		store.create(initial, join(dirname(initial.logFile), "meta.json"));
		const gate = join(store.rootDir, "race.gate");
		const readyA = join(store.rootDir, "race-a.ready");
		const readyB = join(store.rootDir, "race-b.ready");
		const first = runRacer(store.rootDir, initial.id, gate, readyA);
		const second = runRacer(store.rootDir, initial.id, gate, readyB);
		await vi.waitFor(() => expect(existsSync(readyA) && existsSync(readyB)).toBe(true), { timeout: 5_000 });
		privateWrite(gate, "go\n");

		const results = await Promise.all([first, second]);
		expect(results.map((result) => result.stdout.trim()).sort()).toEqual(["stale", "success"]);
		expect(results.every((result) => result.code === 0)).toBe(true);
		expect(new TerminalTaskStore({ rootDir }).loadAll()[0]?.revision).toBe(2);
	});

	it("filters records by durable owner session", () => {
		const store = new TerminalTaskStore({ rootDir });
		const first = snapshot(store, "term-a", "session-a");
		const second = snapshot(store, "term-b", "session-b");
		store.create(first, join(dirname(first.logFile), "meta.json"));
		store.create(second, join(dirname(second.logFile), "meta.json"));

		expect(store.listOwned("session-a").map((task) => task.id)).toEqual(["term-a"]);
		expect(store.getOwned("term-b", "session-a")).toBeUndefined();
		expect(store.getOwned("term-b", "session-b")?.id).toBe("term-b");
	});

	it("strictly rejects schema-v4 traversal, identity, path, and state invariant violations", () => {
		const store = new TerminalTaskStore({ rootDir });
		const initial = snapshot(store, "term-valid");
		expect(parseTerminalTaskSnapshot(initial)).toEqual(initial);
		expect(parseTerminalTaskSnapshot({ ...initial, id: "term-../escape" })).toBeUndefined();
		expect(parseTerminalTaskSnapshot({ ...initial, status: "running", pid: 0, processGroupId: 4, processStartTime: "start" })).toBeUndefined();
		expect(parseTerminalTaskSnapshot({ ...initial, status: "running", pid: 4, processGroupId: 4, processStartTime: "" })).toBeUndefined();
		expect(parseTerminalTaskSnapshot({ ...initial, deliveryState: "pending" })).toBeUndefined();
		expect(parseTerminalTaskSnapshot({ ...initial, logFile: "../output.log" })).toBeUndefined();

		const invalid = { ...initial, logFile: join(store.rootDir, "outside.log") };
		privateWrite(join(dirname(initial.logFile), "meta.json"), `${JSON.stringify(invalid)}\n`);
		expect(store.loadAll()).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("quarantines symlink artifacts and path escapes", () => {
		const onDiagnostic = vi.fn();
		const store = new TerminalTaskStore({ rootDir, onDiagnostic });
		const initial = snapshot(store, "term-link");
		rmSync(initial.logFile);
		const outside = join(store.rootDir, "outside.log");
		privateWrite(outside, "secret");
		symlinkSync(outside, initial.logFile);
		privateWrite(join(dirname(initial.logFile), "meta.json"), `${JSON.stringify(initial)}\n`);

		expect(store.loadAll()).toEqual([]);
		expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ kind: "corrupt" }));
	});

	it("logically quarantines corrupt and legacy records without overwriting them", () => {
		const onDiagnostic = vi.fn();
		const store = new TerminalTaskStore({ rootDir, onDiagnostic });
		const corruptDir = join(store.rootDir, "corrupt");
		const legacyDir = join(store.rootDir, "legacy");
		mkdirSync(corruptDir, { mode: 0o700 });
		mkdirSync(legacyDir, { mode: 0o700 });
		chmodSync(corruptDir, 0o700);
		chmodSync(legacyDir, 0o700);
		const corruptPath = join(corruptDir, "meta.json");
		const legacyPath = join(legacyDir, "meta.json");
		privateWrite(corruptPath, "{not json");
		privateWrite(legacyPath, JSON.stringify({ schemaVersion: 3, id: "bg-old" }));

		expect(store.loadAll()).toEqual([]);
		expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ kind: "corrupt", path: corruptPath }));
		expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ kind: "legacy", path: legacyPath }));
		expect(readFileSync(corruptPath, "utf8")).toBe("{not json");
		expect(existsSync(legacyPath)).toBe(true);
	});

	it.skipIf(process.platform === "win32")("enforces 0700 directories and 0600 metadata under a permissive umask", () => {
		const previousUmask = process.umask(0);
		try {
			const store = new TerminalTaskStore({ rootDir });
			const initial = snapshot(store, "term-modes");
			const metaPath = join(dirname(initial.logFile), "meta.json");
			store.create(initial, metaPath);
			expect(lstatSync(store.rootDir).mode & 0o777).toBe(0o700);
			expect(lstatSync(dirname(initial.logFile)).mode & 0o777).toBe(0o700);
			expect(lstatSync(metaPath).mode & 0o777).toBe(0o600);
		} finally {
			process.umask(previousUmask);
		}
	});

	it("breaks only an abandoned lock whose dead owner is proven", () => {
		const store = new TerminalTaskStore({ rootDir, lockTimeoutMs: 30, lockPollMs: 1 });
		const initial = snapshot(store, "term-lock");
		const metaPath = join(dirname(initial.logFile), "meta.json");
		store.create(initial, metaPath);
		const lockDir = join(dirname(metaPath), ".meta.lock");
		mkdirSync(lockDir, { mode: 0o700 });
		chmodSync(lockDir, 0o700);
		privateWrite(join(lockDir, "owner.json"), `${JSON.stringify({ token: "dead", pid: 2_147_483_647, processStartTime: "old" })}\n`);
		expect(store.transition(initial.id, 1, (current) => ({ ...current, title: "recovered", updatedAt: 2_000 })).title).toBe("recovered");
		expect(existsSync(lockDir)).toBe(false);

		mkdirSync(lockDir, { mode: 0o700 });
		chmodSync(lockDir, 0o700);
		privateWrite(join(lockDir, "owner.json"), "{}\n");
		expect(() => store.transition(initial.id, 2, (current) => ({ ...current, title: "unsafe", updatedAt: 3_000 }))).toThrow(TerminalTaskLockBusyError);
		expect(existsSync(lockDir)).toBe(true);
	});
});
