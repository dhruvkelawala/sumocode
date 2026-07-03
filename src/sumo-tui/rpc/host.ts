import { resolve } from "node:path";
import { loadYoga } from "../layout/yoga.js";
import { ExtensionStatusPublication, RegionRegistry } from "../pi-compat/region-registry.js";
import { ModalLayer } from "../widgets/modal-layer.js";
import { NotificationCenter } from "../widgets/notification.js";
import { SumoRpcClient } from "./client.js";
import { RpcHostControls } from "./controls.js";
import { RpcHostEditorController } from "./editor.js";
import { createRpcExtensionUiResponder } from "./extension-ui-responder.js";
import { RpcHostActions } from "./host-actions.js";
import { RpcHostOverlayManager } from "./host-overlays.js";
import { readGitBranch } from "./git.js";
import { RpcHostRuntime } from "./runtime.js";
import { responseData } from "./response.js";
import { RpcHostStateStore } from "./state.js";
import { RpcTranscriptPump } from "./transcript-pump.js";
import { rpcVisualFixtureFromEnv } from "./visual-fixtures.js";

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

function writeTerminalTitle(stream: Pick<NodeJS.WriteStream, "write">, title: string): void {
	stream.write(`\u001b]0;${title.replace(/[\x00-\x1F\x7F-\x9F]/g, "")}\u0007`);
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
	return next;
}

export interface RpcPromptSubmitOptions {
	readonly visualFixture?: unknown;
	readonly actions?: Pick<RpcHostActions, "handleSubmittedText">;
	readonly stateStore: Pick<RpcHostStateStore, "getSnapshot">;
	readonly client: Pick<SumoRpcClient, "send">;
	readonly onBeforeSend?: (message: string) => void;
}

export async function submitRpcPrompt(message: string, options: RpcPromptSubmitOptions): Promise<void> {
	if (options.visualFixture) return;
	if (message.trim().length === 0) return;
	if (await options.actions?.handleSubmittedText(message)) return;
	const state = options.stateStore.getSnapshot();
	options.onBeforeSend?.(message);
	const response = state.isStreaming
		? await options.client.send({ type: "prompt", message, streamingBehavior: "followUp" })
		: await options.client.send({ type: "prompt", message });
	responseData(response, "prompt");
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
	const visualFixture = rpcVisualFixtureFromEnv(env);
	const extensionPath = resolve(root, "src/extension.ts");
	const client = new SumoRpcClient({
		command: piBinary(env),
		args: ["--mode", "rpc", "-e", extensionPath, ...argv],
		cwd,
		env: childEnv(env),
	});
	const transcriptPump = new RpcTranscriptPump();
	const stateStore = new RpcHostStateStore();
	const controls = new RpcHostControls(client, stateStore);
	let runtime: RpcHostRuntime | undefined;
	const requestRender = (): void => runtime?.requestRender();
	const hostTerminal = {
		get columns(): number {
			return Math.max(1, stdout.columns ?? 80);
		},
		get rows(): number {
			return Math.max(1, stdout.rows ?? 24);
		},
		setTitle(title: string): void {
			writeTerminalTitle(stdout, title);
		},
	};
	const regionRegistry = new RegionRegistry({
		yoga: await loadYoga(),
		tui: { requestRender, terminal: hostTerminal } as never,
		theme: {} as never,
		editorTheme: { borderColor: (value: string) => value, selectList: {} } as never,
		keybindings: {} as never,
		onChange: requestRender,
	});
	const statusPublication = new ExtensionStatusPublication();
	regionRegistry.mountStatus(statusPublication.component);
	const modals = new ModalLayer({
		onChange: requestRender,
		getTerminalSize: () => ({ columns: hostTerminal.columns, rows: hostTerminal.rows }),
	});
	const overlays = new RpcHostOverlayManager(requestRender);
	const notifications = new NotificationCenter({ onChange: requestRender });
	let actions: RpcHostActions | undefined;
	let regionRegistryDisposed = false;
	const editor = new RpcHostEditorController({
		controls,
		cwd,
		onRenderRequest: requestRender,
		onSubmit: async (message) => {
			await submitRpcPrompt(message, {
				visualFixture,
				actions,
				stateStore,
				client,
				onBeforeSend: () => {
					const state = stateStore.getSnapshot();
					runtime?.update({
						state: {
							...state,
							isStreaming: true,
							pendingMessageCount: Math.max(1, state.pendingMessageCount),
							hasMessages: true,
							lastEventType: "agent_start",
						},
					});
				},
			});
		},
	});
	const uiResponder = createRpcExtensionUiResponder({
		modals,
		notifications,
		approvalOverlay: overlays,
		regionRegistry,
		statusPublication,
		editorText: editor,
		terminal: hostTerminal,
		onRenderRequest: requestRender,
	});
	client.setUiRequestHandler((request) => uiResponder.handle(request));
	actions = new RpcHostActions({
		controls,
		stateStore,
		modals,
		overlays,
		notifications,
		editorText: editor,
		onStateChange: requestRender,
		onRenderRequest: requestRender,
	});
	let statsTimer: NodeJS.Timeout | undefined;
	let statsInFlight = false;

	client.onEvent((event) => {
		if (visualFixture) return;
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
		if (!regionRegistryDisposed) {
			regionRegistryDisposed = true;
			regionRegistry.dispose();
		}
		await client.stop();
	};
	const handleSigint = (): void => { void stop(130).then(() => process.exit(130)); };
	const handleSigterm = (): void => { void stop(0).then(() => process.exit(0)); };
	process.once("SIGINT", handleSigint);
	process.once("SIGTERM", handleSigterm);

	try {
		await client.start();
		const branch = await readGitBranch(cwd);
		await controls.refreshState(branch);
		await editor.configureAutocomplete(controls);
		const transcript = visualFixture
			? visualFixture.transcript
			: transcriptPump.replaceFromMessages(responseData(await client.send({ type: "get_messages" }), "get_messages").messages);
		const state = visualFixture ? visualFixture.state : stateStore.getSnapshot();
		runtime = new RpcHostRuntime({
			output: stdout,
			input: stdin,
			initialState: state,
			initialTranscript: transcript,
			inputPreview: visualFixture?.inputPreview,
			editor,
			modal: modals,
			overlay: overlays,
			notifications,
			extensionRegions: {
				aboveEditor: regionRegistry.createStackPublication(["status", "widgets-default", "aboveEditor"]).component,
				belowEditor: regionRegistry.createStackPublication(["belowEditor"], { filterBlankRows: true }).component,
				sidebar: regionRegistry.createSlotPublication("sidebar").component,
			},
			inputHandler: actions,
		});
		await runtime.start();
		if (!visualFixture) {
			await refreshStats();
			statsTimer = setInterval(() => { void refreshStats(); }, 5_000);
		}
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
