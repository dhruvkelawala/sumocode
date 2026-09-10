import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runRpcHost } from "./host.js";

// The production host has no client injection seam, so this exercises the real
// `runRpcHostSession` wiring (real SumoRpcClient, fake child) with only the
// terminal-owning effects replaced -- the same shape host-cleanup.test.ts uses.
/* oxlint-disable anti-slop/no-module-mocking -- production wiring proof must not edit the host to add a seam. */
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

afterEach(() => vi.unstubAllEnvs());

/** A child whose stdout the test drives, with the kill reaped in a microtask. */
function fakeChild() {
	// SAFETY: nullable Node exit fields begin live and change when the fake child exits.
	const child = Object.assign(new EventEmitter(), {
		pid: 1234,
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn((_signal?: NodeJS.Signals) => {
			queueMicrotask(() => {
				child.signalCode = "SIGTERM";
				child.emit("exit", null, "SIGTERM");
				child.emit("close", null, "SIGTERM");
			});
			return true;
		}),
	});
	return child;
}

/** The diagnostics-sink fields this test reads back; every other JSONL key is ignored. */
interface DiagnosticRecord {
	readonly event: string;
	readonly frameSummary?: string;
	readonly reason?: string;
}

function parseDiagnosticLine(line: string): DiagnosticRecord {
	// SAFETY: logDiagnostic writes one JSON object per line; the assertions below
	// re-validate every field this test consumes.
	return JSON.parse(line) as DiagnosticRecord;
}

function diagnosticEvents(file: string): DiagnosticRecord[] {
	return readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0).map(parseDiagnosticLine);
}

describe("host malformed-frame diagnostics", () => {
	it("reports every malformed frame through the diagnostics sink and keeps counting after a valid frame", async () => {
		const root = mkdtempSync(join(tmpdir(), "sumo-host-protocol-diag-"));
		const diagFile = join(root, "diag.jsonl");
		vi.stubEnv("SUMO_TUI_DIAG_FILE", diagFile);
		const child = fakeChild();
		const stderr = { write: vi.fn(() => true) };
		const running = runRpcHost({
			argv: [],
			env: {
				NODE_ENV: "test",
				PI_BIN: "unused",
				SUMOCODE_ROOT_DIR: process.cwd(),
				SUMOCODE_PROJECT_CWD: root,
				SUMOCODE_EXIT_CODE_FILE: join(root, "exit-code"),
			},
			// SAFETY: the runtime is replaced; the host reads only dimensions/TTY and write.
			stdout: { isTTY: true, columns: 80, rows: 24, write: () => true } as never,
			// SAFETY: no runtime input starts; cleanup can only disable raw mode.
			stdin: { setRawMode: () => undefined } as never,
			// SAFETY: host diagnostics only call write on this sink.
			stderr: stderr as never,
			// SAFETY: this event/stream fake implements the child surface consumed by SumoRpcClient.
			preSpawnedChild: child as never,
			onPreSpawnedChildAdopted: () => {
				// Two malformed frames, one valid frame (which must reset the
				// consecutive-error counter), then a third malformed frame: the
				// threshold of three *consecutive* errors is never reached.
				child.stdout.write("bad one\n");
				child.stdout.write("bad two\n");
				child.stdout.write("{}\n");
				child.stdout.write("bad three\n");
			},
		});

		try {
			await running;
			const protocolErrors = diagnosticEvents(diagFile).filter((event) => event.event === "rpc_protocol_error");
			expect(protocolErrors).toHaveLength(3);
			expect(protocolErrors.map((event) => event.frameSummary)).toEqual([
				"[invalid protocol frame: 7 bytes]",
				"[invalid protocol frame: 7 bytes]",
				"[invalid protocol frame: 9 bytes]",
			]);
			for (const event of protocolErrors) {
				expect(event.reason).toBe("Invalid JSON protocol frame: Unexpected token in JSON");
			}
			// The valid frame reset the counter, so the third malformed frame did not
			// trip MAX_CONSECUTIVE_PROTOCOL_ERRORS: a tripped counter fires the
			// client exit path, which throws "RPC child exited during startup" out of
			// client.start() and aborts the host before the runtime is ever
			// constructed -- this stderr line would never be written.
			expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("injected runtime start failure"));
			// The single SIGTERM is the host's own shutdown reap, not a protocol kill.
			expect(child.kill).toHaveBeenCalledTimes(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
