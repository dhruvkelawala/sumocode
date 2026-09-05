import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, type IPty } from "node-pty";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createChildEvidenceContext,
	HARNESS_SIGNATURE,
	HARNESS_SIGNATURE_ENV_KEY,
	recordPtyExit,
	supervisePtyProcess,
	waitForDiagnosticReadiness,
	type ReadinessState,
} from "./harness-supervisor.js";
import {
	dryRunExecLine,
	dryRunField,
	LAUNCHER_COMMAND_CASES,
	RUNTIME_SELECTION_CASES,
} from "./launcher-runtime-contract.js";
import { createRpcChildFixture } from "./rpc-child-fixture.js";
import { buildSpawnEnv, replayScreenRows } from "./spawn-pi-pty.js";

const ROOT = resolve(process.env.SUMOCODE_INTEGRATION_PACKAGE_ROOT ?? process.cwd());
// SAFETY: package.json is repository-owned and the version field is required by
// pnpm; the string is only used to resolve build-native's deterministic path.
const PACKAGE_VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const PLATFORM_TAG = `${process.platform === "darwin" ? "macos" : process.platform}-${process.arch}`;
const ARCHIVE = join(ROOT, "dist/native", `sumocode-${PACKAGE_VERSION}-${PLATFORM_TAG}`);
const NATIVE_BIN = join(ARCHIVE, "bin/sumocode");
const NATIVE_PI = join(ARCHIVE, "bin/sumocode-pi");
const NATIVE_EXTENSION = join(ARCHIVE, "extension/sumocode-extension.bundle.mjs");
const NATIVE_RPC_EXTENSION = join(ARCHIVE, "extension/sumocode-rpc-extension.bundle.mjs");
const CLEANUP_SEQUENCE = "\x1b[?1049l";

interface PtyExit {
	readonly exitCode: number;
	readonly signal?: number;
}

interface NativePtySession {
	readonly pid: number;
	readonly exit: Promise<PtyExit>;
	getOutput(): string;
	getDiagPath(): string;
	waitForOutput(pattern: string | RegExp, timeoutMs?: number): Promise<string>;
	waitForReady(state: ReadinessState, timeoutMs?: number): Promise<void>;
	sendInput(input: string): void;
	signal(signal: NodeJS.Signals): void;
	cleanup(): Promise<void>;
}

const sessions: NativePtySession[] = [];
const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

function matches(output: string, pattern: string | RegExp): boolean {
	return pattern instanceof RegExp ? pattern.test(output) : output.includes(pattern);
}

/**
 * Native PTY launcher registered with the canonical harness supervisor. Every
 * process group enters SUMOCODE_INTEGRATION_MANIFEST and the outer
 * `--native-only` runner performs the same zero-survivor audit as the full
 * integration suite.
 */
function spawnNativePty(
	args: readonly string[],
	options: { readonly env?: NodeJS.ProcessEnv; readonly cwd?: string; readonly cols?: number; readonly rows?: number } = {},
): NativePtySession {
	const childEnv = buildSpawnEnv(process.env, { PI_BIN: "", ...options.env });
	const evidence = createChildEvidenceContext([NATIVE_BIN, ...args], childEnv);
	childEnv.SUMO_TUI_DIAG_FILE = evidence.diagPath;
	childEnv[HARNESS_SIGNATURE_ENV_KEY] = HARNESS_SIGNATURE;
	const child: IPty = spawn(NATIVE_BIN, [...args], {
		name: "xterm-256color",
		cols: options.cols ?? 100,
		rows: options.rows ?? 30,
		cwd: options.cwd ?? tempRoot("sumocode-native-cwd-"),
		env: childEnv,
	});
	const supervision = supervisePtyProcess(child.pid, evidence, childEnv);
	let output = "";
	child.onData((data) => {
		appendFileSync(evidence.stderrPath, data);
		output += data;
		if (output.length > 1_000_000) output = output.slice(-500_000);
	});
	const exit = new Promise<PtyExit>((resolveExit) => {
		child.onExit((event) => {
			recordPtyExit(supervision.pid, supervision.pgid, event.exitCode, event.signal, childEnv);
			resolveExit(event);
		});
	});
	const session: NativePtySession = {
		pid: child.pid,
		exit,
		getOutput: () => output,
		getDiagPath: () => evidence.diagPath,
		waitForOutput(pattern, timeoutMs = 10_000) {
			if (matches(output, pattern)) return Promise.resolve(output);
			return new Promise((resolveOutput, rejectOutput) => {
				const deadline = Date.now() + timeoutMs;
				const poll = (): void => {
					if (matches(output, pattern)) return resolveOutput(output);
					if (Date.now() >= deadline) return rejectOutput(new Error(`Timed out waiting for ${String(pattern)}. Evidence: ${evidence.evidenceDir}`));
					setTimeout(poll, 20);
				};
				poll();
			});
		},
		waitForReady(state, timeoutMs = 30_000) {
			return waitForDiagnosticReadiness(evidence.diagPath, state, timeoutMs).then(() => undefined);
		},
		sendInput(input) {
			child.write(input);
		},
		signal(signal) {
			child.kill(signal);
		},
		cleanup() {
			return supervision.terminate();
		},
	};
	sessions.push(session);
	return session;
}

async function waitForExit(session: NativePtySession, timeoutMs = 15_000): Promise<PtyExit> {
	return await Promise.race([
		session.exit,
		new Promise<never>((_resolve, reject) => {
			setTimeout(() => reject(new Error(`Timed out waiting for native process ${session.pid} exit`)), timeoutMs);
		}),
	]);
}

function runNative(args: readonly string[], options: { readonly input?: string; readonly env?: NodeJS.ProcessEnv; readonly cwd?: string } = {}) {
	return spawnSync(NATIVE_BIN, [...args], {
		cwd: options.cwd ?? tempRoot("sumocode-native-command-"),
		env: buildSpawnEnv(process.env, { PI_BIN: "", ...options.env }),
		input: options.input ?? "",
		encoding: "utf8",
		timeout: 30_000,
	});
}

function readDiagEvents(path: string): Array<{ event?: string }> {
	return readFileSync(path, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.flatMap((line) => {
			try {
				// SAFETY: only the optional event discriminator is consumed below.
				return [JSON.parse(line) as { event?: string }];
			} catch {
				return [];
			}
		});
}

async function waitForDiagEvent(path: string, event: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path) && readDiagEvents(path).some((entry) => entry.event === event)) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	}
	throw new Error(`Timed out waiting for diagnostic event ${event}: ${path}`);
}

function createExecutable(name: string, source: string): string {
	const root = tempRoot("sumocode-native-executable-");
	const path = join(root, name);
	writeFileSync(path, source, { mode: 0o755 });
	chmodSync(path, 0o755);
	return path;
}

function createTerminalProvider(stateFile: string): string {
	const root = tempRoot("sumocode-native-provider-");
	const path = join(root, "terminal-provider.mjs");
	writeFileSync(path, `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const provider = "sumocode-native-contract";
const modelId = "terminal-tools";
const readyFile = ${JSON.stringify(`${stateFile}.ready`)};
let turn = 0;

function base(model) {
	return {
		role: "assistant", content: [], api: provider, provider, model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "pending", timestamp: Date.now(),
	};
}

function streamTool(model, name, args) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const output = base(model);
		stream.push({ type: "start", partial: output });
		const toolCall = { type: "toolCall", id: "native-" + name + "-" + (++turn), name, arguments: args };
		output.content.push(toolCall);
		stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
		stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
		output.stopReason = "toolUse";
		stream.push({ type: "done", reason: "toolUse", message: output });
		stream.end();
	});
	return stream;
}

function streamText(model, text) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const output = base(model);
		stream.push({ type: "start", partial: output });
		output.content.push({ type: "text", text });
		stream.push({ type: "text_start", contentIndex: 0, partial: output });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
		output.stopReason = "stop";
		stream.push({ type: "done", reason: "stop", message: output });
		stream.end();
	});
	return stream;
}

function toolResults(context, name) {
	return context.messages.filter((message) => message.role === "toolResult" && message.toolName === name);
}

function terminalId(context) {
	const start = toolResults(context, "terminal_start").at(-1);
	const text = start?.content?.find((part) => part.type === "text")?.text ?? "";
	const id = text.match(/Started terminal ([^ ·.]+)/)?.[1];
	if (!id) throw new Error("terminal_start result did not contain an id: " + text);
	const pid = Number(text.match(/pid: ([0-9]+)/)?.[1] ?? "0");
	writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify({ id, pid }));
	return id;
}

function streamModel(model, context) {
	if (toolResults(context, "terminal_start").length === 0) {
		const command = "printf NATIVE_BG_READY; : > " + JSON.stringify(readyFile) + "; sleep 60";
		return streamTool(model, "terminal_start", { command, title: "native runner probe", completion: "passive" });
	}
	const id = terminalId(context);
	if (toolResults(context, "terminal_check").length === 0 || !existsSync(readyFile)) return streamTool(model, "terminal_check", { id });
	if (toolResults(context, "terminal_stop").length === 0) return streamTool(model, "terminal_stop", { ids: [id] });
	return streamText(model, "NATIVE_TERMINAL_STARTED_CHECKED_AND_STOPPED");
}

export default function install(pi) {
	pi.registerProvider(provider, {
		name: "SumoCode native contract", baseUrl: "http://127.0.0.1", apiKey: "native-contract", api: provider,
		models: [{ id: modelId, name: "Native terminal tools", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256 }],
		streamSimple: streamModel,
	});
}
`);
	return path;
}

function processAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid < 2) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (processAlive(pid) && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	if (processAlive(pid)) throw new Error(`managed terminal pid ${pid} survived terminal_stop`);
}

async function waitForNonemptyFile(path: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path) && readFileSync(path, "utf8").trim() !== "") return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(`timed out waiting for file: ${path}`);
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.cleanup();
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const nativeDescribe = process.env.SUMOCODE_NATIVE_CONTRACT === "1" ? describe : describe.skip;

nativeDescribe("native executable contract", () => {
	it("built the complete archive and pinned Pi child", () => {
		expect(existsSync(NATIVE_BIN)).toBe(true);
		expect(existsSync(NATIVE_PI)).toBe(true);
		expect(existsSync(NATIVE_EXTENSION)).toBe(true);
		expect(existsSync(NATIVE_RPC_EXTENSION)).toBe(true);
		expect(existsSync(join(ARCHIVE, "CHANGELOG.md"))).toBe(true);
		expect(readFileSync(NATIVE_PI).includes("register-bedrock")).toBe(false);
		expect(readFileSync(join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/bun/cli.js"), "utf8")).toContain('import("./register-bedrock.js")');
		expect(runNative(["--version"]).stdout).toContain(`sumocode ${PACKAGE_VERSION}`);
		expect(spawnSync(NATIVE_PI, ["--version"], { encoding: "utf8" }).stdout.trim()).toBe("0.84.4");
	});

	it("forwards Pi option values that collide with launcher subcommands", () => {
		const nameValue = runNative(["--dry-run", "--name", "task"]);
		expect(nameValue.status).toBe(0);
		expect(dryRunField(nameValue.stdout, "COMMAND")).toBe("run");
		expect(dryRunField(nameValue.stdout, "ARGS")).toBe("--name task");
		for (const argv of [["--dry-run", "--model", "diag"], ["--dry-run", "-p", "doctor says hi"]]) {
			const result = runNative(argv);
			expect(result.status).toBe(0);
			expect(dryRunField(result.stdout, "COMMAND")).toBe("run");
		}
	});

	it("rejects an install missing the RPC extension bundle", () => {
		const root = tempRoot("sumocode-native-incomplete-install-");
		for (const directory of ["bin", "extension", "share"]) mkdirSync(join(root, directory));
		for (const file of ["bin/sumocode", "bin/sumocode-pi", "extension/sumocode-extension.bundle.mjs", "share/yoga.wasm", "share/sumo-face.ans"]) {
			writeFileSync(join(root, file), "");
		}
		chmodSync(join(root, "bin/sumocode"), 0o755);
		const installer = join(root, "install.sh");
		writeFileSync(installer, readFileSync(join(ROOT, "install.sh")), { mode: 0o755 });
		const result = spawnSync("sh", [installer], {
			env: { ...process.env, SUMOCODE_INSTALL_PREFIX: join(root, "prefix") }, encoding: "utf8",
		});
		expect(result.status).toBe(65);
		expect(result.stderr).toContain("extension/sumocode-rpc-extension.bundle.mjs");
	});

	for (const row of RUNTIME_SELECTION_CASES) {
		it(`shares launcher selection: ${row.name}`, async () => {
			let output: string;
			if (row.stdoutTty) {
				const session = spawnNativePty(["--dry-run", ...row.argv]);
				const event = await waitForExit(session);
				expect(event.exitCode).toBe(0);
				output = session.getOutput();
			} else {
				const result = runNative(["--dry-run", ...row.argv]);
				expect(result.status).toBe(0);
				output = result.stdout;
			}
			expect(dryRunField(output, "SUMO_RPC")).toBe(row.branch === "rpc-host" ? "1" : "");
			const execLine = dryRunExecLine(output);
			expect(execLine).toContain("bin/sumocode-pi");
			expect(execLine).toContain(row.branch === "rpc-host" ? NATIVE_RPC_EXTENSION : NATIVE_EXTENSION);
		});
	}

	it("parses equals-form native launcher paths", () => {
		const root = tempRoot("sumocode-native-equals-options-");
		const diagFile = join(root, "diag.jsonl");
		const promptFile = join(root, "prompt.txt");
		writeFileSync(promptFile, "review native equals options\n");
		const diagResult = runNative(["--dry-run", `--diag-file=${diagFile}`]);
		expect(diagResult.status).toBe(0);
		expect(dryRunField(diagResult.stdout, "SUMO_TUI_DIAG_FILE")).toBe(diagFile);
		for (const arg of [`--prompt-file=${promptFile}`, `--task-dir=${root}`]) {
			const result = runNative(["--dry-run", "task", arg]);
			expect(result.status, result.stderr).toBe(0);
		}
	});

	it("redacts prompt and secret bytes from native dry-run diagnostics", () => {
		const result = runNative(["--dry-run", "--api-key", "SECRET-KEY", "--print", "SECRET-PROMPT"]);
		expect(result.status).toBe(0);
		expect(result.stdout).not.toContain("SECRET-KEY");
		expect(result.stdout).not.toContain("SECRET-PROMPT");
		expect(result.stdout).toContain("--api-key [redacted] --print [redacted]");

		const equalsResult = runNative(["--dry-run", "-p=SECRET-EQUALS-PROMPT"]);
		expect(equalsResult.status).toBe(0);
		expect(equalsResult.stdout).not.toContain("SECRET-EQUALS-PROMPT");
		expect(equalsResult.stdout).toContain("-p=[redacted]");
	});

	for (const row of LAUNCHER_COMMAND_CASES) {
		it(`shares launcher command: ${row.name}`, () => {
			const diagFile = join(tempRoot("sumocode-native-diag-"), "diag.jsonl");
			writeFileSync(diagFile, `${JSON.stringify({ event: "boot_screen_frame" })}\n`);
			const argv = row.argv.map((arg) => arg === "{diagFile}" ? diagFile : arg);
			const result = runNative(argv);
			if (row.expect === "exit-0") expect(result.status).toBe(0);
			else if (row.expect === "doctor-runs") expect([0, 70]).toContain(result.status);
			else expect(result.status).toBe(64);
			if (row.stdoutContains !== undefined) expect(result.stdout).toContain(row.stdoutContains);
		}, 30_000);
	}

	it("enters an explicit project directory instead of submitting it as a prompt", () => {
		const caller = tempRoot("sumocode-native-project-caller-");
		const project = realpathSync(tempRoot("sumocode-native-explicit-project-"));
		const result = runNative(["--dry-run", project], { cwd: caller });
		expect(result.status).toBe(0);
		expect(dryRunField(result.stdout, "PROJECT_CWD")).toBe(project);
		expect(dryRunField(result.stdout, "ARGS")).toBe("");
		expect(dryRunField(result.stdout, "KICKOFF_PROMPT_TRANSPORT")).toBe("(none)");
	});

	it("keeps a relative PI_BIN bound to the caller before entering a project", () => {
		const caller = tempRoot("sumocode-native-relative-pi-caller-");
		const project = tempRoot("sumocode-native-relative-pi-project-");
		mkdirSync(join(caller, "tools"));
		mkdirSync(join(project, "tools"));
		writeFileSync(join(caller, "tools/pi"), "#!/bin/bash\nprintf SAFE_PI\n", { mode: 0o755 });
		writeFileSync(join(project, "tools/pi"), "#!/bin/bash\nprintf PROJECT_PI\n", { mode: 0o755 });
		const result = runNative(["--no-sumo-tui", project], { cwd: caller, env: { PI_BIN: "./tools/pi" } });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("SAFE_PI");
		expect(result.stdout).not.toContain("PROJECT_PI");
	});

	it("threads compiled parent provenance into nested child launch plans", async () => {
		const root = tempRoot("sumocode-native-provenance-");
		const taskLog = join(root, "task.json");
		const parentPi = createExecutable("parent-selected-pi", `#!/bin/bash\nnode -e 'const fs=require("node:fs"); fs.writeFileSync(process.env.PROVENANCE_TASK_LOG, JSON.stringify({argv:process.argv.slice(1),pi:process.env.PI_BIN,launcher:process.env.SUMOCODE_LAUNCHER})); console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:"done"}}))' -- "$@"\n`);
		const dryRun = runNative(["--dry-run"], { env: { PI_BIN: parentPi } });
		expect(dryRun.status).toBe(0);
		const piBinary = dryRunField(dryRun.stdout, "PI_BIN");
		const previousEnv = { ...process.env };
		delete process.env.SUMOCODE_BG_CHILD;
		Object.assign(process.env, {
			PI_BIN: piBinary,
			SUMOCODE_LAUNCHER: NATIVE_BIN,
			SUMOCODE_RPC_CHILD: "1",
			SUMOCODE_NATIVE_TASK: "1",
			PI_CODING_AGENT_DIR: join(root, "agent"),
			TMPDIR: root,
			PROVENANCE_TASK_LOG: taskLog,
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w1:p1",
		});
		mkdirSync(process.env.PI_CODING_AGENT_DIR!);
		const tools = new Map<string, { execute: (...args: never[]) => Promise<object> }>();
		const commands = new Map<string, { handler: (...args: never[]) => Promise<void> }>();
		const paneRuns: string[] = [];
		const exec = vi.fn(async (_command: string, args: string[]) => {
			if (args[0] === "pane" && args[1] === "current") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1" } } }), stderr: "" };
			if (args[0] === "pane" && args[1] === "list") return { code: 0, stdout: JSON.stringify({ result: { panes: [{ pane_id: args[3] === "w2" ? "w2:p1" : "w1:p1", workspace_id: args[3] ?? "w1", tab_id: "w1:t1" }] } }), stderr: "" };
			if (args[0] === "pane" && args[1] === "split") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1" } } }), stderr: "" };
			if (args[0] === "pane" && args[1] === "run") { paneRuns.push(args[3] ?? ""); return { code: 0, stdout: "", stderr: "" }; }
			if (args[0] === "pane" && (args[1] === "close" || args[1] === "move")) return { code: 0, stdout: "", stderr: "" };
			if (args[0] === "worktree" && args[1] === "create") return { code: 0, stdout: JSON.stringify({ result: { workspace: { workspace_id: "w2" } } }), stderr: "" };
			return { code: 1, stdout: "", stderr: `unexpected herdr call: ${args.join(" ")}` };
		});
		const pi = {
			on: vi.fn(),
			registerCommand: vi.fn((name: string, definition: { handler: (...args: never[]) => Promise<void> }) => commands.set(name, definition)),
			registerShortcut: vi.fn(),
			registerTool: vi.fn((definition: { name: string; execute: (...args: never[]) => Promise<object> }) => tools.set(definition.name, definition)),
			registerProvider: vi.fn(),
			registerMessageRenderer: vi.fn(),
			sendMessage: vi.fn(),
			getThinkingLevel: vi.fn(() => "low"),
			getActiveTools: vi.fn(() => ["read"]),
			exec,
		};
		try {
			const extension = await import(`${pathToFileURL(NATIVE_RPC_EXTENSION).href}?provenance=${Date.now()}`);
			extension.resetSumocodeProcessInstallLatchForTests?.();
			// SAFETY: the Pi double implements the registration/runtime surface used by the compiled RPC extension.
			extension.default(pi as never);
			expect([...tools.keys()]).toEqual(expect.arrayContaining(["task", "subagent_spawn"]));
			const context = { cwd: ROOT, model: undefined, hasUI: true, ui: { notify: vi.fn() }, sessionManager: { getSessionFile: () => undefined, getBranch: () => [{ type: "message" }] } };
			// SAFETY: the compiled task definition and context expose the exact Pi tool execution surface used here.
			await tools.get("task")!.execute("native-provenance", { type: "single", tasks: [{ prompt: "probe", fork: false }] }, undefined, undefined, context as never);
			// SAFETY: the fake parent Pi writes this exact provenance record.
			const observed = JSON.parse(readFileSync(taskLog, "utf8")) as { pi: string; launcher: string };
			expect(observed).toMatchObject({ pi: piBinary, launcher: NATIVE_BIN });

			// SAFETY: the compiled subagent tool uses the same caller-facing execute seam.
			await tools.get("subagent_spawn")!.execute("visible-provenance", { prompt: "watch", name: "worker", visible: true }, undefined, undefined, context as never);
			const visibleScript = readdirSync(root, { recursive: true, encoding: "utf8" }).find((path) => path.endsWith("run.sh"));
			expect(visibleScript).toBeDefined();
			expect(readFileSync(join(root, visibleScript!), "utf8")).toContain(`exec '${NATIVE_BIN}' 'task'`);

			// SAFETY: the compiled command definition and context expose the registered slash-command handler seam.
			await commands.get("sumo:worktree")!.handler("new provenance", context as never);
			expect(paneRuns).toHaveLength(1);
			expect(paneRuns[0]).toBe(`pnpm install && exec '${NATIVE_BIN}'`);
		} finally {
			for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
			Object.assign(process.env, previousEnv);
		}
	}, 20_000);

	it("runs diag without starting a Pi runtime", () => {
		const root = tempRoot("sumocode-native-diag-only-");
		const marker = join(root, "pi-started");
		const pi = createExecutable("pi-diag-probe", `#!/bin/bash\nprintf started > ${JSON.stringify(marker)}\n`);
		const diagFile = join(root, "diag.jsonl");
		writeFileSync(diagFile, `${JSON.stringify({ event: "boot_screen_frame" })}\n`);
		const result = runNative(["diag", diagFile], { env: { PI_BIN: pi } });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Event counts");
		expect(existsSync(marker)).toBe(false);
	});

	it("doctor fails when the diagnostics directory is not writable", () => {
		const root = tempRoot("sumocode-native-unwritable-diag-");
		chmodSync(root, 0o555);
		try {
			const result = runNative(["doctor", "--diag-file", join(root, "diag.jsonl")]);
			expect(result.status).toBe(70);
			expect(result.stdout).toContain("diagnostics directory not writable");
		} finally {
			chmodSync(root, 0o700);
		}
	});

	it("keeps retained diagnostics output owner-only while summarizing a separate input", () => {
		const root = tempRoot("sumocode-native-private-diag-");
		const input = join(root, "summary-input.jsonl");
		const output = join(root, "debug-output.jsonl");
		const originalInput = `${JSON.stringify({ event: "boot_screen_frame" })}\n`;
		const retained = `${JSON.stringify({ event: "retained_output" })}\n`;
		writeFileSync(input, originalInput, { mode: 0o644 });
		writeFileSync(output, retained, { mode: 0o644 });
		const result = runNative(["-d", "--no-clear-diag", "--diag-file", output, "diag", input]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(`Diagnostics: ${input}`);
		expect(readFileSync(output, "utf8")).toBe(retained);
		expect(statSync(output).mode & 0o777).toBe(0o600);
		expect(readFileSync(input, "utf8")).toBe(originalInput);
		expect(statSync(input).mode & 0o777).toBe(0o644);
	});

	it("selects explicit then inherited diagnostics output independently of diag input", () => {
		const root = tempRoot("sumocode-native-diag-precedence-");
		const input = join(root, "summary-input.jsonl");
		const inherited = join(root, "inherited-output.jsonl");
		const explicit = join(root, "explicit-output.jsonl");
		const originalInput = `${JSON.stringify({ event: "boot_screen_frame" })}\n`;
		writeFileSync(input, originalInput, { mode: 0o644 });
		writeFileSync(inherited, "inherited\n", { mode: 0o644 });
		writeFileSync(explicit, "explicit\n", { mode: 0o644 });

		const inheritedResult = runNative(["-d", "--no-clear-diag", "diag", input], {
			env: { SUMO_TUI_DIAG_FILE: inherited },
		});
		expect(inheritedResult.status).toBe(0);
		expect(inheritedResult.stdout).toContain(`Diagnostics: ${input}`);
		expect(readFileSync(inherited, "utf8")).toBe("inherited\n");
		expect(statSync(inherited).mode & 0o777).toBe(0o600);
		expect(readFileSync(input, "utf8")).toBe(originalInput);
		expect(statSync(input).mode & 0o777).toBe(0o644);

		chmodSync(inherited, 0o644);
		const explicitResult = runNative(["-d", "--no-clear-diag", "--diag-file", explicit, "diag", input], {
			env: { SUMO_TUI_DIAG_FILE: inherited },
		});
		expect(explicitResult.status).toBe(0);
		expect(explicitResult.stdout).toContain(`Diagnostics: ${input}`);
		expect(readFileSync(explicit, "utf8")).toBe("explicit\n");
		expect(statSync(explicit).mode & 0o777).toBe(0o600);
		expect(readFileSync(inherited, "utf8")).toBe("inherited\n");
		expect(statSync(inherited).mode & 0o777).toBe(0o644);
		expect(readFileSync(input, "utf8")).toBe(originalInput);
		expect(statSync(input).mode & 0o777).toBe(0o644);
	});

	it("renders static slash completion between editor and hydrated command readiness", async () => {
		const agentDir = tempRoot("sumocode-native-agent-");
		const cwd = tempRoot("sumocode-native-project-");
		const session = spawnNativePty(["--offline", "--no-extensions", "--no-session", "--approve"], {
			env: { PI_CODING_AGENT_DIR: agentDir }, cwd,
		});
		await session.waitForReady("input");
		await session.waitForOutput("DIVINE INVOCATION");
		session.sendInput("/resume");
		await waitForDiagEvent(session.getDiagPath(), "slash_ready");
		await waitForDiagEvent(session.getDiagPath(), "command_ready");
		await waitForDiagEvent(session.getDiagPath(), "terminal_index_ready");
		const events = readDiagEvents(session.getDiagPath());
		const editorIndex = events.findIndex((event) => event.event === "editor_ready");
		const slashIndex = events.findIndex((event) => event.event === "slash_ready");
		const commandIndex = events.findIndex((event) => event.event === "command_ready");
		const terminalIndex = events.findIndex((event) => event.event === "terminal_index_start");
		expect(editorIndex).toBeGreaterThanOrEqual(0);
		expect(slashIndex).toBeGreaterThan(editorIndex);
		expect(commandIndex).toBeGreaterThan(slashIndex);
		expect(terminalIndex).toBeGreaterThan(commandIndex);
		const screen = (await replayScreenRows(session.getOutput(), 100, 30)).join("\n");
		expect(screen).toContain("DIVINE INVOCATION");
		expect(screen).toContain("Resume a previous session");
		expect(screen).toContain("█");
		session.signal("SIGTERM");
		expect((await waitForExit(session)).exitCode).toBe(0);
		expect(session.getOutput()).toContain(CLEANUP_SEQUENCE);
	}, 45_000);

	it("loads the inlined SumoCode extension through compiled Pi's virtual modules", () => {
		const result = runNative(["--mode", "rpc", "--offline", "--no-extensions", "--no-session"], {
			input: `${JSON.stringify({ type: "get_commands" })}\n`,
			env: { PI_CODING_AGENT_DIR: tempRoot("sumocode-native-pi-agent-") },
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('"name":"reload"');
	});

	it("loads a dynamic user TypeScript extension through compiled Pi Jiti", () => {
		const root = tempRoot("sumocode-native-dynamic-extension-");
		const extension = join(root, "dynamic.ts");
		writeFileSync(extension, `export default function install(pi) { pi.registerCommand("native-dynamic", { description: "native dynamic proof", handler: async () => {} }); }\n`);
		const result = runNative(["--mode", "rpc", "--offline", "--no-extensions", "--no-session", "-e", extension], {
			input: `${JSON.stringify({ type: "get_commands" })}\n`,
			env: { PI_CODING_AGENT_DIR: tempRoot("sumocode-native-dynamic-agent-") },
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('"name":"native-dynamic"');
	});

	it("keeps helper subprocesses inert when SUMOCODE_BG_CHILD is set", () => {
		const result = runNative(["--mode", "rpc", "--offline", "--no-extensions", "--no-session"], {
			input: `${JSON.stringify({ type: "get_commands" })}\n`,
			env: { SUMOCODE_BG_CHILD: "1", PI_CODING_AGENT_DIR: tempRoot("sumocode-native-helper-agent-") },
		});
		expect(result.status).toBe(0);
		expect(result.stdout).not.toContain('"name":"reload"');
	});

	it("preserves the direct Pi child's signal exit code", () => {
		const pi = createExecutable("pi-sigkill", "#!/bin/bash\nkill -KILL $$\n");
		const result = runNative(["--no-sumo-tui"], { env: { PI_BIN: pi } });
		expect(result.status).toBe(137);
	});

	for (const row of [
		{ name: "positional prompt", argv: ["--no-session", "SENTINEL-positional"], prompt: "SENTINEL-positional" },
		{ name: "--print prompt", argv: ["--no-session", "--print", "SENTINEL-print"], prompt: "SENTINEL-print" },
		{ name: "-p= prompt", argv: ["--no-session", "-p=SENTINEL-equals"], prompt: "SENTINEL-equals" },
	] as const) {
		it(`moves ${row.name} from direct-Pi argv to stdin`, () => {
			const stubOut = join(tempRoot("sumocode-native-direct-pi-"), "stub.json");
			const piStub = createExecutable("pi-stub", `#!/bin/bash\nnode -e 'const fs=require("node:fs"); let s=""; process.stdin.setEncoding("utf8"); process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>fs.writeFileSync(process.argv[1],JSON.stringify({argv:process.argv.slice(2),stdin:s,launcher:process.env.SUMOCODE_LAUNCHER})))' ${JSON.stringify(stubOut)} -- "$@"\n`);
			const result = runNative(["--no-sumo-tui", ...row.argv], { env: { PI_BIN: piStub } });
			expect(result.status).toBe(0);
			// SAFETY: the owned stub writes this exact object shape.
			const observed = JSON.parse(readFileSync(stubOut, "utf8")) as { argv: string[]; stdin: string; launcher: string };
			expect(observed.argv).toContain(NATIVE_EXTENSION);
			expect(observed.launcher).toBe(NATIVE_BIN);
			expect(observed.argv.join(" ")).not.toContain(row.prompt);
			expect(observed.stdin).toBe(row.prompt);
		});
	}

	it("forwards SIGINT unchanged to a direct Pi child", async () => {
		const pi = createExecutable("pi-signal", "#!/bin/bash\ntrap 'printf GOT_SIGINT; exit 130' INT\ntrap 'printf GOT_SIGTERM; exit 143' TERM\nprintf READY\nwhile :; do sleep 1; done\n");
		const session = spawnNativePty(["--no-sumo-tui"], { env: { PI_BIN: pi } });
		await session.waitForOutput("READY");
		session.signal("SIGINT");
		await session.waitForOutput("GOT_SIGINT");
		expect((await waitForExit(session)).exitCode).toBe(130);
		expect(session.getOutput()).not.toContain("GOT_SIGTERM");
	});

	for (const { signal, expected } of [{ signal: "SIGTERM", expected: 0 }, { signal: "SIGINT", expected: 130 }] as const) {
		it(`owns ${signal} before child adoption`, async () => {
			const log = join(tempRoot("sumocode-native-pre-adoption-"), "fixture.jsonl");
			const pi = await createRpcChildFixture("sumocode-native-pre-adoption-child-");
			const session = spawnNativePty(["--offline", "--no-extensions", "--no-session", "--approve"], {
				env: {
					PI_BIN: pi,
					NODE_ENV: "test",
					SUMOCODE_TEST_PRE_ADOPTION_DELAY_MS: "5000",
					SUMOCODE_RPC_FIXTURE_LOG: log,
				},
			});
			await session.waitForOutput("", 50);
			const deadline = Date.now() + 5_000;
			while ((!existsSync(log) || readFileSync(log, "utf8").trim() === "") && Date.now() < deadline) {
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
			}
			expect(existsSync(log)).toBe(true);
			session.signal(signal);
			expect((await waitForExit(session)).exitCode).toBe(expected);
		}, 20_000);

		it(`owns ${signal} after child adoption and restores terminal modes`, async () => {
			const pi = await createRpcChildFixture("sumocode-native-post-adoption-child-");
			const session = spawnNativePty(["--offline", "--no-extensions", "--no-session", "--approve"], { env: { PI_BIN: pi } });
			await session.waitForReady("input");
			session.signal(signal);
			expect((await waitForExit(session)).exitCode).toBe(expected);
			expect(session.getOutput()).toContain(CLEANUP_SEQUENCE);
		}, 30_000);
	}

	it("contains a crashing Pi child and restores the terminal", async () => {
		const crashPi = createExecutable("pi-crash", "#!/bin/sh\nexit 42\n");
		const session = spawnNativePty(["--offline", "--no-extensions", "--no-session", "--approve"], { env: { PI_BIN: crashPi } });
		const event = await waitForExit(session);
		expect(event.exitCode).not.toBe(0);
		if (session.getOutput().includes("\x1b[?1049h")) expect(session.getOutput()).toContain(CLEANUP_SEQUENCE);
	}, 20_000);

	it("reads, writes, and drains the compiled chrome-cache worker", async () => {
		const agentDir = tempRoot("sumocode-native-chrome-agent-");
		const cwd = realpathSync(tempRoot("sumocode-native-chrome-project-"));
		const cacheDir = join(agentDir, "state/sumocode/chrome/v1");
		const cacheFile = join(cacheDir, "chrome-cache.json");
		mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
		const retainedCwd = "/retained-native-cache-proof";
		writeFileSync(cacheFile, `${JSON.stringify({ version: 1, byCwd: {
			[cwd]: { savedAt: Date.now(), modelLabel: "cached/native-proof", thinkingLevel: "high" },
			[retainedCwd]: { savedAt: Date.now() - 1, modelLabel: "retained/native-proof", thinkingLevel: "low" },
		} })}\n`, { mode: 0o600 });
		const pi = await createRpcChildFixture("sumocode-native-chrome-child-");
		const session = spawnNativePty(["--offline", "--no-extensions", "--no-session", "--approve"], {
			cwd,
			env: { PI_BIN: pi, PI_CODING_AGENT_DIR: agentDir },
		});
		await session.waitForReady("input");
		await waitForDiagEvent(session.getDiagPath(), "command_ready");
		session.signal("SIGTERM");
		expect((await waitForExit(session)).exitCode).toBe(0);
		const persisted = readFileSync(cacheFile, "utf8");
		expect(persisted).toContain(cwd);
		// writeCachedChrome reads and retains other cache entries before writing
		// the hydrated current cwd, proving native worker read + write + drain.
		expect(persisted).toContain(retainedCwd);
		expect(persisted).toContain("retained/native-proof");
		expect(persisted).not.toContain("cached/native-proof");
	}, 30_000);

	it("runs terminal start/check/stop through the native host runner", async () => {
		const agentDir = tempRoot("sumocode-native-terminal-agent-");
		const cwd = tempRoot("sumocode-native-terminal-project-");
		const stateFile = join(tempRoot("sumocode-native-terminal-state-"), "state.json");
		const provider = createTerminalProvider(stateFile);
		const session = spawnNativePty([
			"--print", "run native terminal contract", "--offline", "--no-extensions", "--approve", "--no-session",
			"-e", provider, "--model", "sumocode-native-contract/terminal-tools",
		], { cwd, env: { PI_CODING_AGENT_DIR: agentDir } });
		await waitForNonemptyFile(stateFile, 30_000);
		// SAFETY: the owned provider writes this exact object after terminal_start.
		const started = JSON.parse(readFileSync(stateFile, "utf8")) as { id: string; pid: number };
		expect(started.id).toMatch(/^term-/);
		const storeRoot = join(agentDir, "state/sumocode-terminals");
		const taskDir = readdirSync(storeRoot).find((name) => name.startsWith(`${started.id}-`));
		if (taskDir === undefined) throw new Error(`terminal metadata directory missing for ${started.id}`);
		const outputPath = join(storeRoot, taskDir, "output.log");
		await waitForNonemptyFile(outputPath);
		expect(readFileSync(outputPath, "utf8")).toContain("NATIVE_BG_READY");
		const metaPath = join(storeRoot, taskDir, "meta.json");
		// SAFETY: task-manager owns this schema; the test consumes only pid.
		const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { pid?: number };
		const terminalPid = meta.pid ?? started.pid;
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			// SAFETY: task-manager owns this schema; the test consumes only status.
			const snapshot = JSON.parse(readFileSync(metaPath, "utf8")) as { status?: string };
			if (snapshot.status === "cancelled") break;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
		}
		// SAFETY: task-manager owns this schema; the test consumes only status.
		expect((JSON.parse(readFileSync(metaPath, "utf8")) as { status?: string }).status).toBe("cancelled");
		await waitForProcessExit(terminalPid);
		session.signal("SIGTERM");
		await waitForExit(session);
	}, 75_000);

	it("relaunches direct Pi with --continue without replaying its prompt", async () => {
		const root = tempRoot("sumocode-native-reload-");
		const state = join(root, "count");
		const pi = createExecutable("pi-reload", `#!/bin/bash\ncount=0; [ ! -f ${JSON.stringify(state)} ] || count=$(cat ${JSON.stringify(state)}); count=$((count+1)); printf '%s' "$count" > ${JSON.stringify(state)}; printf 'RUN-%s %s\\n' "$count" "$*"; [ "$count" -eq 1 ] && exit 100; exit 0\n`);
		const session = spawnNativePty(["--no-sumo-tui", "RELOAD-ONCE-PROMPT"], { env: { PI_BIN: pi, TMPDIR: root } });
		await session.waitForOutput("RUN-2");
		expect((await waitForExit(session)).exitCode).toBe(0);
		const runs = session.getOutput().split(/\r?\n/).filter((line) => line.includes("RUN-"));
		expect(runs.find((line) => line.includes("RUN-1"))).toContain("RELOAD-ONCE-PROMPT");
		const runTwo = runs.find((line) => line.includes("RUN-2"));
		expect(runTwo).toContain("--continue");
		expect(runTwo).not.toContain("RELOAD-ONCE-PROMPT");
		expect(readFileSync(state, "utf8")).toBe("2");
		expect(session.getOutput()).toContain(CLEANUP_SEQUENCE);
		expect(readdirSync(root).filter((name) => name.startsWith("sumocode-reload-ready."))).toEqual([]);
	}, 20_000);

	it("reloads RPC children without nesting native host processes", async () => {
		const root = tempRoot("sumocode-native-rpc-reload-");
		const state = join(root, "count");
		const log = join(root, "children.log");
		const pi = createExecutable("pi-rpc-reload", `#!/bin/bash\ncount=0; [ ! -f ${JSON.stringify(state)} ] || count=$(cat ${JSON.stringify(state)}); count=$((count+1)); printf '%s' "$count" > ${JSON.stringify(state)}; printf '%s %s\\n' "$count" "$PPID" >> ${JSON.stringify(log)}; [ "$count" -lt 3 ] && exit 100; exit 42\n`);
		const session = spawnNativePty(["--offline", "--no-extensions", "--no-session", "--approve"], { env: { PI_BIN: pi, TMPDIR: root } });
		expect((await waitForExit(session, 20_000)).exitCode).not.toBe(0);
		const parentPids = readFileSync(log, "utf8").trim().split("\n").map((line) => Number(line.split(" ")[1]));
		expect(parentPids).toHaveLength(3);
		expect(new Set(parentPids)).toEqual(new Set([session.pid]));
		expect(readdirSync(root).filter((name) => name.startsWith("sumocode-exit-code.") || name.startsWith("sumocode-reload-ready."))).toEqual([]);
	}, 25_000);
});
