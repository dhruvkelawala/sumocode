import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { FileActivityStore } from "../../activity/store.js";
import { RegionRegistry } from "../pi-compat/region-registry.js";
import { SumoRpcClient } from "./client.js";
import { ChromeCacheWorkerClient } from "./chrome-cache-worker-client.js";
import { RpcHostRuntime } from "./runtime.js";
import { runRpcHost, type RpcHostExitDependencies } from "./host.js";

// The historical host has no constructor-injection seam. Replace only effects
// so the same test runs against its unchanged cleanup, without a legacy adapter.
/* oxlint-disable anti-slop/no-module-mocking -- retrospective proof must not edit the historical host to add injection. */
vi.mock("../../themes/index.js", () => ({ applyStartupTheme: vi.fn() }));
vi.mock("./git.js", () => ({ readGitBranch: async () => undefined, watchGitBranch: async () => () => undefined }));
vi.mock("./chrome-cache-worker-client.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./chrome-cache-worker-client.js")>();
	return { ...original, ChromeCacheWorkerClient: class {
		async read() { return undefined; }
		async write() {}
		async dispose() {}
	} };
});
vi.mock("./runtime.js", () => ({ RpcHostRuntime: class {
	async start() { throw new Error("injected runtime start failure"); }
	stop() {}
	waitForExit() { return new Promise<number>(() => undefined); }
} }));

/* oxlint-enable anti-slop/no-module-mocking */

afterEach(() => vi.restoreAllMocks());

const events = ["SIGINT", "SIGTERM", "unhandledRejection", "uncaughtException"] as const;

describe("retrospective public host cleanup", () => {
	it("preserves the exported Node timer type", () => {
		expectTypeOf<NonNullable<RpcHostExitDependencies["setTimeout"]>>().toEqualTypeOf<typeof setTimeout>();
	});

	it.each([
		{ trigger: "runtime start failure", code: 1 },
		{ trigger: "SIGINT", code: 130 },
		{ trigger: "SIGTERM", code: 0 },
	] as const)("characterizes lifecycle order: $trigger", async ({ trigger, code }) => {
		const order: string[] = [];
		const before = events.map((event) => process.listeners(event));
		const exit = vi.fn();
		const stderr = { write: vi.fn(() => true) };
		const root = mkdtempSync(join(tmpdir(), "sumo-host-cleanup-"));
		const exitFile = join(root, "exit-code");
		vi.spyOn(SumoRpcClient.prototype, "start").mockImplementation(async (adopt) => { adopt?.(); });
		let releaseChild!: () => void;
		const childStopped = new Promise<void>((resolve) => { releaseChild = resolve; });
		vi.spyOn(SumoRpcClient.prototype, "stop").mockImplementation(async () => {
			order.push("child");
			await childStopped;
		});
		vi.spyOn(RegionRegistry.prototype, "dispose").mockImplementation(() => { order.push("regions"); });
		vi.spyOn(FileActivityStore.prototype, "subscribe").mockImplementation(() => () => { order.push("unsubscribe"); });
		vi.spyOn(FileActivityStore.prototype, "dispose").mockImplementation(() => { order.push("activity"); });
		vi.spyOn(RpcHostRuntime.prototype, "stop").mockImplementation(() => { order.push("runtime"); });
		vi.spyOn(ChromeCacheWorkerClient.prototype, "dispose").mockImplementation(async () => { order.push("cache"); });
		const running = runRpcHost({
			argv: [],
			env: { NODE_ENV: "test", PI_BIN: "unused", SUMOCODE_ROOT_DIR: process.cwd(), SUMOCODE_PROJECT_CWD: root, SUMOCODE_EXIT_CODE_FILE: exitFile },
			// SAFETY: runtime is replaced; host reads only dimensions/TTY and write.
			stdout: { isTTY: true, columns: 80, rows: 24, write: () => true } as never,
			// SAFETY: no runtime input starts; cleanup can only disable raw mode.
			stdin: { setRawMode: () => undefined } as never,
			// SAFETY: host diagnostics only call write on this sink.
			stderr: stderr as never,
			exit,
			onPreSpawnedChildAdopted: () => {
				expect(process.listenerCount("SIGINT")).toBe(before[0]!.length + 1);
				expect(process.listenerCount("SIGTERM")).toBe(before[1]!.length + 1);
				if (trigger !== "runtime start failure") process.emit(trigger);
			},
		});
		try {
			await vi.waitFor(() => expect(order).toContain("child"));
			expect(order).not.toContain("cache");
			expect(exit).not.toHaveBeenCalled();
		} finally {
			releaseChild();
		}
		expect(await running).toBe(code);
		expect(order).toEqual([
			...(trigger === "runtime start failure" ? ["runtime"] : []),
			"regions", "unsubscribe", "activity", "child", "cache",
		]);
		for (const [index, event] of events.entries()) expect(process.listeners(event)).toEqual(before[index]);
		if (trigger !== "runtime start failure") {
			expect(exit).toHaveBeenCalledExactlyOnceWith(code);
			expect(readFileSync(exitFile, "utf8")).toBe(String(code));
		} else expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("injected runtime start failure"));
	});
});
