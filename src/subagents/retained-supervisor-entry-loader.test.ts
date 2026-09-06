import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// SAFETY: package-owned plain JS entry; this describes only its import test boundary.
const { runSourceEntry } = createRequire(import.meta.url)("./retained-supervisor-entry.mjs") as {
	runSourceEntry(argv: readonly string[], load: (url: string) => Promise<{ createJiti: (entry: string, options: { moduleCache: boolean; tryNative: boolean; fsCache: boolean }) => { import: (path: string) => Promise<{ runRetainedSupervisorEntry: (args: readonly string[]) => Promise<void> }> } }>): Promise<void>;
};
const workerArgs = process.execArgv;
beforeEach(() => { process.execArgv = []; });
afterEach(() => { process.execArgv = workerArgs; vi.restoreAllMocks(); });

it("loads physical source and Pi-local Jiti from the package, independent of task cwd", async () => {
	vi.spyOn(process, "cwd").mockReturnValue("/untrusted/task");
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	const pi = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const jiti = realpathSync(createRequire(pi).resolve("jiti"));
	const runRetainedSupervisorEntry = vi.fn(async () => undefined);
	const importSource = vi.fn(async () => ({ runRetainedSupervisorEntry }));
	const createJiti = vi.fn(() => ({ import: importSource }));
	const load = vi.fn(async () => ({ createJiti }));
	const args = ["--task-dir", "/private/task"];
	await runSourceEntry(args, load);
	expect(load).toHaveBeenCalledWith(pathToFileURL(jiti).href);
	expect(createJiti).toHaveBeenCalledWith(pathToFileURL(resolve(root, "src/subagents/retained-supervisor-entry.mjs")).href,
		{ moduleCache: true, tryNative: false, fsCache: false });
	expect(importSource).toHaveBeenCalledWith(resolve(root, "src/subagents/retained-supervisor-entry.ts"));
	expect(runRetainedSupervisorEntry).toHaveBeenCalledWith(args);
});

it("rejects Node loader options before loading code", async () => {
	process.execArgv = ["--import", "/untrusted/hook.mjs"];
	const load = vi.fn();
	await expect(runSourceEntry([], load)).rejects.toThrow(/^retained_entry_failed$/);
	expect(load).not.toHaveBeenCalled();
});

it("waits for source controller settlement and redacts its failure", async () => {
	let refuse!: (error: Error) => void;
	const pending = new Promise<void>((_, reject) => { refuse = reject; });
	const run = runSourceEntry([], async () => ({ createJiti: () => ({ import: async () => ({
		runRetainedSupervisorEntry: () => pending,
	}) }) }));
	let done = false;
	const result = run.finally(() => { done = true; });
	const rejected = expect(result).rejects.toThrow(/^retained_entry_failed$/);
	await Promise.resolve();
	await Promise.resolve();
	expect(done).toBe(false);
	refuse(new Error("private source detail"));
	await rejected;
});

it("redacts loader failure without exposing paths or exception text", async () => {
	await expect(runSourceEntry([], async () => { throw new Error("private text /private/task"); })).rejects.toThrow(/^retained_entry_failed$/);
});
