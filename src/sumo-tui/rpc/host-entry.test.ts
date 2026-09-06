import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
// SAFETY: untyped build module; the VM consumes its actual runtime exports.
const hostBundle = await import("../../../scripts/lib/host-bundle.mjs" as string);

type Mode = "initialization" | "import" | "signal-import" | "SIGTERM" | "SIGINT" | "adopted" | "adopted-stop";

// Compile whole entries, not extracted helpers. Explicit module effects keep
// this process-free; unknown imports fail at the boundary, never as free names.
function entryFixture(entry: "node" | "native", mode: Mode, dies: boolean, requestedCode = 1) {
	const trace: string[] = [];
	const signals = new EventEmitter();
	// SAFETY: starts alive; kill updates the same nullable exit fields as ChildProcess.
	const child = Object.assign(new EventEmitter(), {
		pid: 12345, exitCode: null as number | null, signalCode: null as string | null,
		kill: vi.fn((signal: string) => {
			trace.push(signal);
			if (dies && signal === "SIGKILL") {
				child.signalCode = signal;
				child.emit("exit", null, signal);
			}
			return false;
		}),
	});
	const entryUrl = new URL(entry === "node" ? "../../../sumo-rpc-host.js" : "../../native/main.ts", import.meta.url);
	const source = ts.transpileModule(readFileSync(entryUrl, "utf8").replaceAll("import.meta.url", JSON.stringify(entryUrl.href)), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	let starts = 0;
	const main = vi.fn(async (options: { onPreSpawnedChildAdopted(): void; exit(code: number): void }) => {
		starts += 1;
		if (mode === "adopted" || mode === "adopted-stop") options.onPreSpawnedChildAdopted();
		if (mode === "adopted-stop") {
			if (starts > 1) return 0;
			options.exit(requestedCode);
			return requestedCode;
		}
		throw new Error("initialization failed");
	});
	const loadHost = () => {
		trace.push("host:import");
		if (mode === "SIGTERM" || mode === "SIGINT") {
			signals.emit(mode);
			signals.emit(mode);
		}
		if (mode === "signal-import") signals.emit("SIGTERM");
		if (mode === "import" || mode === "signal-import") throw new Error("import failed");
		return { main, runRpcHost: main };
	};
	const unexpected = () => { throw new Error("unexpected filesystem effect"); };
	const modules = {
		"node:child_process": { spawn: () => { trace.push("child:spawn"); return child; } },
		"node:fs": {
			appendFileSync: () => undefined,
			writeFileSync: (file: string, value: string) => { trace.push(`${file}:${value}`); },
			readFileSync: () => "", realpathSync: (file: string) => file,
			existsSync: () => false, statSync: unexpected, fchmodSync: unexpected,
			openSync: () => 1, closeSync: () => undefined,
			rmSync: (file: string) => { trace.push(`file:cleanup:${file}`); },
		},
		"node:fs/promises": { readFile: unexpected, stat: async () => { throw new Error("no bundle"); } },
		"node:os": os, "node:path": path, "node:url": url,
		"./scripts/lib/host-bundle.mjs": {
			HOST_INPUT_MANIFEST_OUTPUT: hostBundle.HOST_INPUT_MANIFEST_OUTPUT,
			hostInputManifestIsFresh: unexpected, hostOutputsHash: unexpected,
		},
		"./src/sumo-tui/rpc/spawn-child.mjs": { buildChildSpawnPlan: () => ({ command: "fake", args: [], env: {} }) },
		"../sumo-tui/rpc/spawn-child.mjs": { buildChildSpawnPlan: () => ({ command: "fake", args: [], env: {} }) },
		jiti: { createJiti: () => ({ import: async () => loadHost() }) },
	};
	const result: Promise<void> = runInNewContext(`(async () => { ${source} })()`, {
		exports: {}, setTimeout, clearTimeout,
		require: (name: string) => {
			if (name === "../sumo-tui/rpc/host.js") return loadHost();
			if (!Object.hasOwn(modules, name)) throw new Error(`unspecified entry import: ${name}`);
			// SAFETY: own-key check above restricts imports to the complete effect table.
			return modules[name as keyof typeof modules];
		},
		process: {
			env: { SUMOCODE_HOST_BUNDLE: "0", SUMOCODE_RELOAD: "1", SUMOCODE_EXIT_CODE_FILE: "status" },
			argv: ["node", "entry"], execPath: "/archive/bin/sumocode", pid: 100, cwd: () => ".",
			stdout: { isTTY: true, write: () => { trace.push("terminal:restore"); } },
			stdin: { setRawMode: () => { trace.push("raw:off"); } },
			stderr: { write: (message: string) => { trace.push(message); } },
			on: signals.on.bind(signals), removeListener: signals.removeListener.bind(signals),
			exit: (code: number) => { trace.push(`exit:${code}`); },
		},
	});
	const settled = result.then(() => undefined, (error: Error) => error);
	return { trace, child, main, signals, settled };
}

describe.each(["node", "native"] as const)("%s RPC entry reap ownership", (entry) => {
	it.each(["initialization", "import", "signal-import", "SIGTERM", "SIGINT"] as const)("reports unreaped %s failure after restoring terminal", async (mode) => {
		vi.useFakeTimers();
		try {
			const f = entryFixture(entry, mode, false);
			await vi.runAllTimersAsync();
			const result = await f.settled;
			expect(f.trace).toContain("child:spawn");
			expect(f.trace).toContain("host:import");
			if (mode === "initialization") expect(f.main).toHaveBeenCalledOnce();
			else expect(f.main).not.toHaveBeenCalled();
			if (mode === "SIGTERM" || mode === "SIGINT") expect(result).toBeUndefined();
			else expect(result?.message).toBe(`${mode === "signal-import" ? "import" : mode} failed`);
			expect(f.trace.filter((item) => item.startsWith("exit:"))).toEqual(["exit:1"]);
			expect(f.trace.indexOf("terminal:restore")).toBeGreaterThanOrEqual(0);
			expect(f.trace.indexOf("terminal:restore")).toBeLessThan(f.trace.indexOf("exit:1"));
			expect(f.trace.join("\n")).toContain('"pid":12345');
			if (entry === "node" && (mode === "SIGTERM" || mode === "SIGINT")) expect(f.trace).toContain("status:1");
			expect(f.child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
			expect(f.signals.eventNames()).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		} finally { vi.useRealTimers(); }
	});

	it.each([["SIGTERM", 0], ["SIGINT", 130]] as const)("keeps %s exit %i only after successful KILL escalation", async (signal, code) => {
		vi.useFakeTimers();
		try {
			const f = entryFixture(entry, signal, true);
			await vi.runAllTimersAsync();
			expect(await f.settled).toBeUndefined();
			expect(f.trace.filter((item) => item.startsWith("exit:"))).toEqual([`exit:${code}`]);
			if (entry === "node") expect(f.trace).toContain(`status:${code}`);
			expect(f.main).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally { vi.useRealTimers(); }
	});

	it("does not signal the former entry child after adoption rejection", async () => {
		vi.useFakeTimers();
		try {
			const f = entryFixture(entry, "adopted", false);
			await vi.runAllTimersAsync();
			expect(await f.settled).toEqual(expect.objectContaining({ message: "initialization failed" }));
			expect(f.main).toHaveBeenCalledOnce();
			expect(f.child.kill).not.toHaveBeenCalled();
			expect(f.trace).not.toContain("terminal:restore");
			expect(f.signals.eventNames()).toEqual([]);
		} finally { vi.useRealTimers(); }
	});
});

it.each([0, 1, 130])("native entry honors adopted host exit %i after its file cleanup", async (code) => {
	const f = entryFixture("native", "adopted-stop", false, code);
	expect(await f.settled).toBeUndefined();
	expect(f.main).toHaveBeenCalledOnce();
	expect(f.trace.at(-1)).toBe(`exit:${code}`);
	expect(f.trace.at(-2)).toContain("file:cleanup:/tmp/sumocode-reload-ready.");
	expect(f.child.kill).not.toHaveBeenCalled();
	expect(f.signals.eventNames()).toEqual([]);
});

it("native entry keeps reload in-process rather than forcing host exit 100", async () => {
	const f = entryFixture("native", "adopted-stop", false, 100);
	expect(await f.settled).toBeUndefined();
	expect(f.main).toHaveBeenCalledTimes(2);
	expect(f.trace.filter((item) => item.startsWith("exit:"))).toEqual([]);
	expect(f.child.kill).not.toHaveBeenCalled();
	expect(f.signals.eventNames()).toEqual([]);
});
