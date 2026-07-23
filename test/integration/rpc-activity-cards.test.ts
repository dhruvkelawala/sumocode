import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityFeedPublisher } from "../../src/activity/feed-publisher.js";
import type { ActivitySnapshot } from "../../src/activity/domain.js";
import { ActivityManagerBridge } from "../../src/activity/manager-bridge.js";
import { ACTIVITY_OUTPUT_MAX_BYTES, ACTIVITY_OUTPUT_MAX_LINES } from "../../src/activity/output-tail.js";
import { captureProcessBirthTime } from "../../src/background-tasks/process-tree.js";
import type { TerminalTaskSnapshot } from "../../src/background-tasks/task-types.js";
import { TERMINAL_CLEANUP_SEQUENCE } from "../../src/sumo-tui/runtime/terminal-controller.js";
import {
	PI_BOOT_SEQUENCE,
	replayScreenRows,
	spawnSumocodePty,
	waitForScreen,
	type SpawnedPiPty,
} from "./spawn-pi-pty.js";
import { createRpcChildFixture } from "./rpc-child-fixture.js";

const CSI_U_ENTER = "\x1b[13u";
const DOWN = "\x1b[B";
const CTRL_O = "\x0f";

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

function externalFeedWriter(ownerSessionId: string, rootDir: string): ActivityFeedPublisher {
	const processStartTime = captureProcessBirthTime(process.pid);
	if (!processStartTime) throw new Error("Could not capture integration writer process identity");
	return new ActivityFeedPublisher(ownerSessionId, {
		rootDir,
		writerIdentity: { token: randomUUID(), pid: process.pid, processStartTime },
		inspectWriter: () => "alive",
	});
}

function terminalActivity(id: string, ownerSessionId: string, overrides: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
	return {
		id,
		kind: "terminal",
		title: "live terminal",
		status: "running",
		ownerSessionId,
		createdAt: 1_000,
		updatedAt: 1_000,
		outputTail: "starting output",
		body: { kind: "terminal", command: "pnpm test", text: "starting output" },
		...overrides,
	};
}

async function createTerminalLifecycleProvider(directory: string): Promise<string> {
	const path = join(directory, "activity-terminal-provider.mjs");
	const fauxProviderUrl = new URL("./providers/faux.js", import.meta.resolve("@earendil-works/pi-ai")).href;
	const command = "printf 'phase-%s\\n' one; sleep 3; printf 'phase-%s\\n' two; sleep 3; printf 'phase-%s\\n' complete";
	await writeFile(path, `
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(fauxProviderUrl)};

const provider = "sumocode-activity-test";
const modelId = "terminal-lifecycle";
const api = "sumocode-activity-test-api";

export default function install(pi) {
  const core = createFauxCore({
    provider,
    api,
    tokensPerSecond: 1000,
    models: [{ id: modelId, name: "Activity terminal lifecycle", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
  });
  core.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal_start", {
      command: ${JSON.stringify(command)},
      title: "real terminal lifecycle",
      completion: "passive",
    }, { id: "terminal-call-real" }), { stopReason: "toolUse" }),
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 8000));
      return fauxAssistantMessage("terminal lifecycle observed", { stopReason: "stop" });
    },
  ]);
  pi.registerProvider(provider, {
    name: "SumoCode Activity Test",
    baseUrl: "http://localhost:0",
    apiKey: "non-secret-test-key",
    api,
    streamSimple: core.streamSimple,
    models: [{ id: modelId, name: "Activity terminal lifecycle", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
  });
}
`, "utf8");
	await chmod(path, 0o755);
	return path;
}

function spawnFixture(piBin: string, agentDir: string, cols = 100, rows = 30): SpawnedPiPty {
	return spawnSumocodePty({
		env: {
			PI_CODING_AGENT_DIR: agentDir,
			SUMOCODE_STATE_DIR: join(agentDir, "state"),
			SUMO_TUI_DIAG_FILE: join(agentDir, "activity-diag.jsonl"),
			PI_BIN: piBin,
		},
		cols,
		rows,
	});
}

describe("RPC durable Activity cards", () => {
	it("proves real Pi get_state ownership and the installed bridge's terminal lifecycle on one card", async () => {
		const cols = 100;
		const rows = 36;
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-real-activity-agent-"));
		const providerPath = await createTerminalLifecycleProvider(agentDir);
		const diagnosticsPath = join(agentDir, "real-activity-diag.jsonl");
		app = spawnSumocodePty({
			cols,
			rows,
			env: {
				PI_CODING_AGENT_DIR: agentDir,
				SUMOCODE_STATE_DIR: join(agentDir, "state"),
				SUMO_TUI_DIAG_FILE: diagnosticsPath,
			},
			args: [
				"--offline",
				"--no-extensions",
				"--no-session",
				"-e", providerPath,
				"--model", "sumocode-activity-test/terminal-lifecycle",
				"--approve",
			],
		});
		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		app.sendInput(`run the terminal lifecycle${CSI_U_ENTER}`);

		let screen = await waitForScreen(app, ({ text }) => (
			text.includes("[real terminal lifecycle]") && text.includes("phase-one")
		), { cols, rows, timeoutMs: 15_000 });
		expect(screen.text.match(/\[real terminal lifecycle\]/g)).toHaveLength(1);

		screen = await waitForScreen(app, ({ text }) => (
			text.includes("phase-two") && !text.includes("phase-complete")
		), { cols, rows, timeoutMs: 10_000 });
		expect(screen.text.match(/\[real terminal lifecycle\]/g)).toHaveLength(1);

		screen = await waitForScreen(app, ({ text }) => (
			text.includes("phase-complete") && text.includes("terminal exited with code 0")
		), { cols, rows, timeoutMs: 12_000 });
		expect(screen.text.match(/\[real terminal lifecycle\]/g)).toHaveLength(1);

		const diagnostics = (await readFile(diagnosticsPath, "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const bridge = diagnostics.find((entry) => entry.event === "activity_bridge_bound" && typeof entry.ownerSessionId === "string");
		const host = diagnostics.find((entry) => entry.event === "rpc_activity_owner_observed" && Number(entry.activityCount) > 0);
		expect(bridge).toBeDefined();
		expect(host).toMatchObject({
			rpcSessionId: bridge?.ownerSessionId,
			feedOwnerSessionId: bridge?.ownerSessionId,
		});
	}, 45_000);

	it("observes feed creation without an RPC event, updates one keyed card, and persists Ctrl+O across restart", async () => {
		const cols = 100;
		const rows = 30;
		const piBin = await createRpcChildFixture("sumocode-rpc-activity-child-", {
			sessionId: "session-a",
			sessionName: "Activity Session",
		});
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-activity-agent-"));
		const publisher = externalFeedWriter("session-a", join(agentDir, "state"));
		app = spawnFixture(piBin, agentDir, cols, rows);
		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);

		expect(publisher.publish([terminalActivity("term-live", "session-a")])).toBe(true);
		expect(publisher.getSnapshot()).toMatchObject([{ id: "term-live", status: "running" }]);
		let screen = await waitForScreen(app, ({ text }) => text.includes("[live terminal]") && text.includes("starting output"), { cols, rows, timeoutMs: 10_000 });
		expect(screen.text.match(/\[live terminal\]/g)).toHaveLength(1);

		const settledAt = Date.now();
		publisher.publish([terminalActivity("term-live", "session-a", {
			status: "succeeded",
			createdAt: settledAt - 1_000,
			updatedAt: settledAt,
			settledAt,
			outputTail: "completed output",
			body: { kind: "terminal", command: "pnpm test", text: "completed output" },
			result: { summary: "terminal exited with code 0" },
		})]);
		screen = await waitForScreen(app, ({ text }) => text.includes("completed output") && !text.includes("starting output"), { cols, rows, timeoutMs: 10_000 });
		expect(screen.text.match(/\[live terminal\]/g)).toHaveLength(1);

		app.sendInput(CTRL_O);
		await waitForScreen(app, ({ text }) => text.includes("ctrl+o output") && text.includes("[live terminal]"), { cols, rows, timeoutMs: 5_000 });
		app.sendInput("\x03");
		await app.waitForOutput("press ctrl-c again to quit", 5_000);
		app.sendInput("\x03");
		await app.waitForOutput(TERMINAL_CLEANUP_SEQUENCE, 10_000);
		app = undefined;

		app = spawnFixture(piBin, agentDir, cols, rows);
		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		screen = await waitForScreen(app, ({ text }) => text.includes("[live terminal]") && text.includes("ctrl+o output"), { cols, rows, timeoutMs: 10_000 });
		expect(screen.text).not.toContain('"Meow meow meow... meow meow"');
	}, 45_000);

	it("isolates session A from B feed updates and restores A cards on resume", async () => {
		const cols = 100;
		const rows = 30;
		const piBin = await createRpcChildFixture("sumocode-rpc-activity-switch-child-", {
			sessionId: "session-a",
			sessionName: "Session A",
			newSessionId: "session-b",
			newSessionName: "Session B",
			switchSessions: {
				"resume-a": { sessionId: "session-a", sessionName: "Session A" },
			},
		});
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-activity-switch-agent-"));
		const rootDir = join(agentDir, "state");
		const publisherA = externalFeedWriter("session-a", rootDir);
		const publisherB = externalFeedWriter("session-b", rootDir);
		publisherA.publish([terminalActivity("term-a", "session-a", { title: "session a terminal", outputTail: "A before", body: { kind: "terminal", text: "A before" } })]);
		app = spawnFixture(piBin, agentDir, cols, rows);
		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		await waitForScreen(app, ({ text }) => text.includes("[session a terminal]") && text.includes("A before"), { cols, rows, timeoutMs: 10_000 });

		app.sendInput(`/new${CSI_U_ENTER}`);
		await waitForScreen(app, ({ text }) => text.includes("DIVINE INVOCATION") && !text.includes("session a terminal"), { cols, rows, timeoutMs: 10_000 });
		publisherA.publish([terminalActivity("term-a", "session-a", { title: "session a terminal", outputTail: "A updated while hidden", body: { kind: "terminal", text: "A updated while hidden" } })]);
		publisherB.publish([terminalActivity("term-b", "session-b", { title: "session b terminal", outputTail: "B visible", body: { kind: "terminal", text: "B visible" } })]);
		let screen = await waitForScreen(app, ({ text }) => text.includes("[session b terminal]") && text.includes("B visible"), { cols, rows, timeoutMs: 10_000 });
		expect(screen.text).not.toContain("A updated while hidden");

		app.sendInput(`/sessions${CSI_U_ENTER}`);
		await waitForScreen(app, ({ text }) => text.includes("SESSION CONTROLS"), { cols, rows, timeoutMs: 5_000 });
		app.sendInput(DOWN);
		app.sendInput(CSI_U_ENTER);
		await waitForScreen(app, ({ text }) => text.toLowerCase().includes("path to session jsonl"), { cols, rows, timeoutMs: 5_000 });
		app.sendInput("resume-a");
		await waitForScreen(app, ({ text }) => text.includes("> resume-a"), { cols, rows, timeoutMs: 5_000 });
		app.sendInput(CSI_U_ENTER);
		screen = await waitForScreen(app, ({ text }) => text.includes("Session A") && text.includes("[session a terminal]") && text.includes("A updated while hidden") && !text.includes("session b terminal"), { cols, rows, timeoutMs: 10_000 });
		expect(screen.text.match(/\[session a terminal\]/g)).toHaveLength(1);
	}, 45_000);

	it("does not overwrite an event emitted immediately after initial get_messages", async () => {
		const cols = 100;
		const rows = 30;
		const piBin = await createRpcChildFixture("sumocode-rpc-activity-initial-hydration-race-", {
			sessionId: "session-initial",
			sessionName: "Initial Hydration",
			initialHydrationRace: true,
		});
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-activity-initial-hydration-agent-"));
		app = spawnFixture(piBin, agentDir, cols, rows);
		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		const screen = await waitForScreen(app, ({ text }) => (
			text.includes("initial race completed") && text.includes("READY") && !text.includes("DIVINE INVOCATION")
		), { cols, rows, timeoutMs: 10_000 });
		expect(screen.text).not.toContain("initial race draft");
	}, 30_000);

	it("replays post-hydration message_update, agent_end, and agent_settled events after a session change", async () => {
		const cols = 100;
		const rows = 30;
		const piBin = await createRpcChildFixture("sumocode-rpc-activity-hydration-race-", {
			sessionId: "session-a",
			sessionName: "Session A",
			newSessionId: "session-b",
			newSessionName: "Session B",
			sessionHydrationRace: true,
		});
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-activity-hydration-agent-"));
		app = spawnFixture(piBin, agentDir, cols, rows);
		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		app.sendInput(`/new${CSI_U_ENTER}`);
		const screen = await waitForScreen(app, ({ text }) => (
			text.includes("Session B") && text.includes("session race completed") && text.includes("READY") && !text.includes("DIVINE INVOCATION")
		), { cols, rows, timeoutMs: 10_000 });
		expect(screen.text).not.toContain("session race draft");
	}, 30_000);

	it("bounds noisy raw terminal output through bridge, feed, watcher, and retained renderer", async () => {
		const cols = 100;
		const rows = 30;
		const piBin = await createRpcChildFixture("sumocode-rpc-activity-noisy-child-", { sessionId: "session-a", sessionName: "Noisy Activity" });
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-activity-noisy-agent-"));
		const rootDir = join(agentDir, "state");
		const noisy = Array.from({ length: 80 }, (_, index) => `\u001b[31mline-${String(index).padStart(3, "0")}:${"🧘".repeat(500)}\u001b[0m`).join("\n");
		const task: TerminalTaskSnapshot = {
			schemaVersion: 4,
			revision: 1,
			id: "term-noisy",
			ownerSessionId: "session-a",
			command: "noisy-command",
			cwd: "/tmp",
			title: "noisy terminal",
			status: "running",
			completionPolicy: "passive",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			deliveryState: "none",
			pid: 1,
			processGroupId: 1,
			processStartTime: "fixture",
			logFile: "/tmp/noisy.log",
		};
		const terminalSource = {
			subscribeChanges(listener: (snapshots: readonly TerminalTaskSnapshot[]) => void): () => void {
				listener([task]);
				return () => undefined;
			},
			getOutput(): string { return noisy; },
			getOutputBytes(): Uint8Array { return Buffer.from(noisy, "utf8"); },
		};
		const subagentSource = {
			list: () => [],
			addChangeListener: () => () => undefined,
		};
		const bridge = new ActivityManagerBridge(terminalSource, subagentSource, { rootDir });
		bridge.bindSession("session-a");
		try {
			app = spawnFixture(piBin, agentDir, cols, rows);
			await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
			await waitForScreen(app, ({ text }) => text.includes("line-079") && text.includes("display rows collapsed"), { cols, rows, timeoutMs: 10_000 });
			const [stored] = new ActivityFeedPublisher("session-a", { rootDir }).getSnapshot();
			expect(Buffer.byteLength(stored?.outputTail ?? "", "utf8")).toBeLessThanOrEqual(ACTIVITY_OUTPUT_MAX_BYTES);
			expect((stored?.outputTail ?? "").split("\n").length).toBeLessThanOrEqual(ACTIVITY_OUTPUT_MAX_LINES);
			expect(stored?.outputTail).toContain("line-079");
			expect(stored?.outputTail).not.toContain("\u001b");
			expect(stored?.outputTail).not.toContain("�");
		} finally {
			bridge.dispose();
		}
	}, 30_000);

	it("host exit is not held open by ActivityStore watchers or poll timers", async () => {
		const piBin = await createRpcChildFixture("sumocode-rpc-activity-exit-child-", { sessionId: "session-a" });
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-activity-exit-agent-"));
		app = spawnFixture(piBin, agentDir);
		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		app.sendSignal("SIGINT");
		await app.waitForOutput(TERMINAL_CLEANUP_SEQUENCE, 10_000);
		const rows = await replayScreenRows(app.getOutput(), 100, 30);
		expect(rows.join("\n")).not.toContain("RPC child exited unexpectedly");
	}, 30_000);
});
