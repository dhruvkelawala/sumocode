import { resolve } from "node:path";
import type { RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { SumoRpcClient } from "./client.js";
import { readGitBranch } from "./git.js";
import { RpcHostRuntime } from "./runtime.js";
import { RpcHostStateStore } from "./state.js";
import { RpcTranscriptPump } from "./transcript-pump.js";

export interface RpcHostMainOptions {
	readonly argv?: readonly string[];
	readonly env?: NodeJS.ProcessEnv;
	readonly stdout?: NodeJS.WriteStream;
	readonly stdin?: NodeJS.ReadStream;
	readonly stderr?: Pick<NodeJS.WriteStream, "write">;
}

function writeLine(stream: Pick<NodeJS.WriteStream, "write">, line: string): void {
	stream.write(`${line}\n`);
}

function responseData(response: RpcResponse, command: RpcResponse["command"]): unknown {
	if (response.command !== command || response.success !== true) {
		const error = response.success === false ? response.error : `Unexpected response for ${command}`;
		throw new Error(error);
	}
	return (response as { data?: unknown }).data;
}

function hostRoot(env: NodeJS.ProcessEnv): string {
	return resolve(env.SUMOCODE_ROOT_DIR ?? process.cwd());
}

function hostCwd(env: NodeJS.ProcessEnv): string {
	return resolve(env.SUMOCODE_PROJECT_CWD ?? process.cwd());
}

function piBinary(env: NodeJS.ProcessEnv): string {
	const pi = env.PI_BIN;
	if (!pi) throw new Error("SUMO_RPC host requires PI_BIN to be set by bin/sumocode.sh");
	return pi;
}

function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const next: NodeJS.ProcessEnv = {
		...env,
		SUMOCODE_RPC_CHILD: "1",
		SUMO_TUI: "0",
	};
	delete next.SUMO_TUI_MODULE;
	return next;
}

export async function runRpcHost(options: RpcHostMainOptions = {}): Promise<number> {
	const argv = [...(options.argv ?? process.argv.slice(2))];
	const env = options.env ?? process.env;
	const stdout = options.stdout ?? process.stdout;
	const stdin = options.stdin ?? process.stdin;
	const stderr = options.stderr ?? process.stderr;
	if (stdout.isTTY !== true) {
		writeLine(stderr, "[sumocode-rpc] RPC host requires a TTY; use node-pty or an interactive terminal.");
		return 70;
	}
	const root = hostRoot(env);
	const cwd = hostCwd(env);
	const extensionPath = resolve(root, "src/extension.ts");
	const client = new SumoRpcClient({
		command: piBinary(env),
		args: ["--mode", "rpc", "-e", extensionPath, ...argv],
		cwd,
		env: childEnv(env),
	});
	const transcriptPump = new RpcTranscriptPump();
	const stateStore = new RpcHostStateStore();
	let runtime: RpcHostRuntime | undefined;
	let statsTimer: NodeJS.Timeout | undefined;
	let statsInFlight = false;

	client.onEvent((event) => {
		const transcript = transcriptPump.handleAgentEvent(event);
		const state = stateStore.handleAgentEvent(event);
		runtime?.update({ state, transcript });
	});

	const refreshStats = async (): Promise<void> => {
		if (statsInFlight) return;
		statsInFlight = true;
		try {
			const statsResponse = await client.send({ type: "get_session_stats" }, 5_000);
			const stats = responseData(statsResponse, "get_session_stats");
			const state = stateStore.hydrateFromSessionStats(stats);
			runtime?.update({ state });
		} catch {
			// Stats are useful chrome data, but an empty/offline shell must still boot.
		} finally {
			statsInFlight = false;
		}
	};

	const stop = async (code = 0): Promise<void> => {
		if (statsTimer) clearInterval(statsTimer);
		runtime?.stop(code);
		await client.stop();
	};
	const handleSigint = (): void => { void stop(130).then(() => process.exit(130)); };
	const handleSigterm = (): void => { void stop(143).then(() => process.exit(143)); };
	process.once("SIGINT", handleSigint);
	process.once("SIGTERM", handleSigterm);

	try {
		await client.start();
		const branch = await readGitBranch(cwd);
		const stateResponse = await client.send({ type: "get_state" });
		const rpcState = responseData(stateResponse, "get_state") as RpcSessionState;
		stateStore.hydrateFromRpcState(rpcState, branch);
		const messagesResponse = await client.send({ type: "get_messages" });
		const messages = (responseData(messagesResponse, "get_messages") as { messages: unknown[] }).messages;
		const transcript = transcriptPump.replaceFromMessages(messages);
		const state = stateStore.getSnapshot();
		runtime = new RpcHostRuntime({ output: stdout, input: stdin, initialState: state, initialTranscript: transcript });
		await runtime.start();
		await refreshStats();
		statsTimer = setInterval(() => { void refreshStats(); }, 5_000);
		return await runtime.waitForExit();
	} catch (error) {
		writeLine(stderr, `[sumocode-rpc] ${error instanceof Error ? error.message : String(error)}`);
		if (client.stderr.length > 0) writeLine(stderr, client.stderr.trim());
		return 1;
	} finally {
		process.removeListener("SIGINT", handleSigint);
		process.removeListener("SIGTERM", handleSigterm);
		await stop();
	}
}

export async function main(): Promise<void> {
	const code = await runRpcHost();
	process.exitCode = code;
}
