import { resolve } from "node:path";
import { containsCtrlCToken, isEscapeInput } from "../input/shared-input-router.js";
import { loadYoga } from "../layout/yoga.js";
import { applyStartupTheme } from "../../themes/index.js";
import { ExtensionStatusPublication, RegionRegistry } from "../pi-compat/region-registry.js";
import type { TranscriptControllerChatSink } from "../transcript/controller.js";
import type { ChatMessageViewModel } from "../transcript/view-model.js";
import type { ChatPagerReplaceStats } from "../widgets/chat-pager.js";
import { ModalLayer } from "../widgets/modal-layer.js";
import { NotificationCenter } from "../widgets/notification.js";
import { SumoRpcClient, truncateForNotification } from "./client.js";
import { RpcHostControls } from "./controls.js";
import { createRpcKeybindingsManager, RpcHostEditorController } from "./editor.js";
import { createRpcExtensionUiResponder } from "./extension-ui-responder.js";
import { RpcHostActions } from "./host-actions.js";
import { RpcHostOverlayManager } from "./host-overlays.js";
import { decideRpcInterrupt, type RpcInterruptInputKind } from "./interrupt.js";
import { readGitBranch } from "./git.js";
import { RpcHostRuntime } from "./runtime.js";
import { responseData } from "./response.js";
import { notifyOnError } from "./safe-send.js";
import { RpcHostStateStore, type RpcHostChromeState } from "./state.js";
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

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.stack ?? error.message : String(error);
}

export interface UnhandledRejectionShutdownOptions {
	readonly stderr: Pick<NodeJS.WriteStream, "write">;
	readonly cleanup: (code: number) => Promise<void>;
	readonly exit: (code: number) => void;
}

export function createUnhandledRejectionHandler(options: UnhandledRejectionShutdownOptions): (reason: unknown) => void {
	let shutdown: Promise<void> | undefined;
	return (reason: unknown): void => {
		if (shutdown) return;
		shutdown = (async () => {
			writeLine(options.stderr, `[sumocode-rpc] unhandled rejection: ${formatUnknownError(reason)}`);
			await options.cleanup(1);
			options.exit(1);
		})().catch((error) => {
			writeLine(options.stderr, `[sumocode-rpc] unhandled rejection cleanup failed: ${formatUnknownError(error)}`);
			options.exit(1);
		});
	};
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

function fallbackChatSinkStats(messages: readonly ChatMessageViewModel[]): ChatPagerReplaceStats {
	return {
		sourceMessages: messages.length,
		acceptedMessages: messages.length,
		renderedMessages: messages.length,
		archivedMessages: 0,
	};
}

/**
 * A `TranscriptControllerChatSink` that forwards to whatever
 * `RpcHostRuntime.getChatSink()` currently returns. Needed because
 * `RpcTranscriptPump` (which owns the `TranscriptController` that this sink
 * is attached to at construction time, see `TranscriptControllerOptions.chat`)
 * is created synchronously near the top of `runRpcHost`, well before
 * `RpcHostRuntime` (and its async `RpcShellAdapter.create`, which happens
 * after `client.start()`) exists at all. Before the runtime/adapter exist,
 * writes are no-ops -- any events the controller processes in that window
 * still update its OWN internal state correctly (see `TranscriptController`),
 * they just have no live pager to push into yet; the adapter's constructor
 * separately seeds the pager from `initialTranscript` once it IS created
 * (from a `transcriptPump.replaceFromMessages` snapshot taken right before),
 * so nothing from that narrow startup window is lost, only deferred to the
 * normal hydration path.
 */
export function createLazyChatSink(getRuntime: () => { getChatSink(): TranscriptControllerChatSink | undefined } | undefined): TranscriptControllerChatSink {
	return {
		replaceViewModels: (messages) => getRuntime()?.getChatSink()?.replaceViewModels(messages) ?? fallbackChatSinkStats(messages),
		addViewModel: (message) => getRuntime()?.getChatSink()?.addViewModel(message),
		replaceLastWithViewModel: (message) => getRuntime()?.getChatSink()?.replaceLastWithViewModel(message),
	};
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

export interface RpcHostExitDependencies {
	readonly modals: Pick<ModalLayer, "close">;
	readonly overlays: Pick<RpcHostOverlayManager, "close">;
	readonly stateStore: Pick<RpcHostStateStore, "getSnapshot">;
	readonly notifications: Pick<NotificationCenter, "notify">;
	readonly requestRender: () => void;
	readonly stopHost: (code: number) => Promise<void>;
	readonly exit: (code: number) => void;
	readonly updateRuntimeState: (state: RpcHostChromeState) => void;
	readonly setTimeout?: typeof setTimeout;
	readonly shutdownDelayMs?: number;
	readonly exitCode?: number;
}

/**
 * Builds the RPC host's `client.onExit` handler as an injectable function of
 * its dependencies, mirroring `createRpcHostInterruptHandler` below: the RPC
 * child is the whole agent, so if it dies outside of a deliberate stop() the
 * host cannot keep functioning. Closing modals/overlays via their normal
 * close() resolves any pending approval/select/input promise the same way an
 * interactive dismiss would (confirm -> false, select/input -> undefined; for
 * the approval overlay this already normalizes to "No"/deny, the correct
 * fail-safe). The runtime is stopped with a nonzero exit code after a short
 * delay so the terse notification is actually visible before the terminal is
 * restored -- a zombie shell with a dead child behind it cannot do anything
 * useful, so keeping it alive indefinitely is not an option.
 */
export function createRpcExitHandler(deps: RpcHostExitDependencies): (error: Error) => void {
	const scheduleTimeout = deps.setTimeout ?? setTimeout;
	const shutdownDelayMs = deps.shutdownDelayMs ?? 750;
	const exitCode = deps.exitCode ?? 1;
	return (error: Error): void => {
		deps.modals.close();
		deps.overlays.close();
		deps.updateRuntimeState({ ...deps.stateStore.getSnapshot(), isStreaming: false, isCompacting: false });
		deps.notifications.notify(`RPC child exited unexpectedly: ${truncateForNotification(error.message)}`, "error", 0);
		deps.requestRender();
		const timer = scheduleTimeout(() => {
			void deps.stopHost(exitCode).then(() => deps.exit(exitCode));
		}, shutdownDelayMs);
		(timer as { unref?: () => void }).unref?.();
	};
}

export interface RpcHostInterruptDependencies {
	readonly modals: Pick<ModalLayer, "getActiveKind" | "close">;
	readonly overlays: Pick<RpcHostOverlayManager, "getActiveKind" | "close">;
	readonly editor: Pick<RpcHostEditorController, "getText" | "setText" | "isAutocompleteOpen">;
	readonly stateStore: Pick<RpcHostStateStore, "getSnapshot">;
	readonly controls: Pick<RpcHostControls, "abort">;
	readonly notifications: Pick<NotificationCenter, "notify">;
	readonly requestHostExit: (code: number) => void;
	/**
	 * True in the window between a prompt submission and the RPC child's
	 * `agent_start` event, when `stateStore`'s `isStreaming` bit has not yet
	 * flipped. Without this, a Ctrl-C sent in that window is treated as the
	 * pre-streaming arm-quit tier instead of an abort.
	 */
	readonly submitInFlight?: () => boolean;
	readonly now?: () => number;
}

/**
 * Builds the RPC host's pre-editor Ctrl-C/Escape handler as an injectable
 * function of its dependencies, factored out of `runRpcHost`'s closure so
 * the interrupt-decision wiring (which state each input kind reads, and
 * what each decision does) can be unit tested without booting the full host.
 */
export function createRpcHostInterruptHandler(deps: RpcHostInterruptDependencies): (data: string) => boolean {
	const now = deps.now ?? Date.now;
	let armedQuitUntil: number | undefined;
	const inputKind = (data: string): RpcInterruptInputKind | undefined => {
		// containsCtrlCToken (not a raw substring/equality test): `data` may be
		// a coalesced multi-token stdin chunk, and must only classify as
		// ctrl-c when a discrete Ctrl-C key token is actually present -- never
		// because pasted content happens to contain a literal 0x03 byte.
		if (containsCtrlCToken(data)) return "ctrl-c";
		if (isEscapeInput(data)) return "escape";
		return undefined;
	};
	return (data: string): boolean => {
		const kind = inputKind(data);
		if (!kind) return false;
		const nowMs = now();
		const modalActive = deps.modals.getActiveKind() !== undefined;
		const overlayActive = deps.overlays.getActiveKind() !== undefined;
		const isStreaming = deps.stateStore.getSnapshot().isStreaming || deps.submitInFlight?.() === true;
		const decision = decideRpcInterrupt(kind, {
			modalActive,
			overlayActive,
			draftNonEmpty: deps.editor.getText().trim().length > 0,
			isStreaming,
			autocompleteOpen: deps.editor.isAutocompleteOpen(),
			armedUntil: armedQuitUntil,
			now: nowMs,
		});
		switch (decision) {
			case "dismiss-modal":
				armedQuitUntil = undefined;
				if (modalActive) deps.modals.close();
				else deps.overlays.close();
				return true;
			case "clear-draft":
				armedQuitUntil = undefined;
				deps.editor.setText("");
				deps.notifications.notify("draft cleared", "info");
				return true;
			case "abort":
				armedQuitUntil = undefined;
				void notifyOnError(async () => {
					await deps.controls.abort();
					deps.notifications.notify("abort requested", "info");
				}, deps.notifications);
				return true;
			case "arm-quit":
				armedQuitUntil = nowMs + 1_500;
				deps.notifications.notify("press ctrl-c again to quit", "info");
				return true;
			case "quit":
				armedQuitUntil = undefined;
				deps.requestHostExit(130);
				return true;
			case "pass":
				return false;
		}
	};
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
	// Resolve and apply the configured theme before the runtime/shell is
	// constructed so the host's first frame already renders the user's theme
	// instead of the registry default (Cathedral). The RPC child process never
	// renders, so main's extension.ts theme-init (which the child also runs)
	// has no visible effect here — the host must apply it independently, via
	// the same shared resolution `extension.ts` uses.
	applyStartupTheme({ cwd });
	const visualFixture = rpcVisualFixtureFromEnv(env);
	const extensionPath = resolve(root, "src/extension.ts");
	const client = new SumoRpcClient({
		command: piBinary(env),
		args: ["--mode", "rpc", "-e", extensionPath, ...argv],
		cwd,
		env: childEnv(env),
	});
	let runtime: RpcHostRuntime | undefined;
	// The B9 diffing chat sink: `TranscriptController` (owned by
	// `transcriptPump`) is constructed here, before `runtime`/its
	// `RpcShellAdapter` exist (that happens async, later, after
	// `client.start()`) -- see `createLazyChatSink`'s doc comment for why
	// this indirection is needed instead of passing the pager directly.
	const transcriptPump = new RpcTranscriptPump({
		chat: createLazyChatSink(() => runtime),
		scheduleRender: () => runtime?.requestRender(),
	});
	const stateStore = new RpcHostStateStore();
	const controls = new RpcHostControls(client, stateStore);
	let stopHost: (code: number) => Promise<void> = async (code: number): Promise<void> => {
		runtime?.stop(code);
		await client.stop();
	};
	const handleUnhandledRejection = createUnhandledRejectionHandler({
		stderr,
		cleanup: (code) => stopHost(code),
		exit: (code) => process.exit(code),
	});
	process.on("unhandledRejection", handleUnhandledRejection);
	// A synchronous throw from the event -> render path (e.g. a listener
	// registered via client.onEvent, which runs transcript ingestion + a full
	// render synchronously) is an uncaughtException, not an unhandledRejection
	// -- Plan 025 only installed the latter, so a sync throw there had no
	// terminal-restoring handler at all and could leave the terminal in raw
	// mode / altscreen after the process died. Reuse the exact same handler
	// (same stop()-then-exit(1) path, same duplicate-event guard) for both
	// events so a sync throw and an async rejection are torn down identically.
	process.once("uncaughtException", handleUnhandledRejection);
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
	let requestHostExit: (code: number) => void = () => undefined;
	// Forward reference: the editor's `onInterrupt` callback (registered below,
	// on construction) must route `app.interrupt` through the same interrupt
	// tier module Ctrl-C/Escape already use (`createRpcHostInterruptHandler`,
	// built further down once its own dependencies -- including `editor`
	// itself -- exist). `app.interrupt`'s default key is Escape, so replaying
	// a canonical escape token into that handler reuses its existing
	// modal/overlay/streaming/autocomplete decision logic instead of
	// duplicating it -- this stays correct even when the user has remapped
	// `app.interrupt` to a different key, since by the time `onInterrupt`
	// fires pi's own manager has already confirmed that binding was pressed.
	let handleAppInterrupt: () => void = () => undefined;
	// Set the instant a prompt is submitted, cleared once the RPC child's
	// `agent_start` event lands (via stateStore.handleAgentEvent, see
	// client.onEvent below) or the send itself fails. `stateStore`'s
	// `isStreaming` bit only flips on `agent_start`, so without this flag a
	// Ctrl-C sent in the submit -> agent_start window reads as pre-streaming
	// and arms quit instead of aborting (defect: double Ctrl-C quits the app
	// instead of aborting the in-flight send).
	let submitInFlight = false;
	const keybindings = createRpcKeybindingsManager({ env });
	const editor = new RpcHostEditorController({
		controls,
		cwd,
		keybindings,
		onRenderRequest: requestRender,
		errorNotifier: notifications,
		// app.exit (Ctrl+D by default, or the user's keybindings.json remap):
		// CustomEditor only invokes this when the editor is empty (enforced
		// inside CustomEditor itself -- see editor.ts's onExit doc comment).
		// Same clean-shutdown path as `/quit` (host-actions.ts: `onExitRequest(0)`
		// -> here, `requestHostExit(0)` -> `runtime?.stop(0)`).
		onExit: () => requestHostExit(0),
		// app.interrupt (Escape by default, or the user's remap): replay into
		// the interrupt tier module (see `handleAppInterrupt` above).
		onInterrupt: () => handleAppInterrupt(),
		onSubmit: async (message) => {
			submitInFlight = true;
			try {
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
			} catch (error) {
				submitInFlight = false;
				// The synthetic isStreaming:true painted into runtime.update above
				// would otherwise stay stuck until the next 5s stats poll. Reset it
				// immediately so the UI and interrupt gating agree the send failed.
				runtime?.update({ state: stateStore.getSnapshot() });
				throw error;
			}
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
	// After new/switch/clone/fork the child's message list changed out from
	// under the host, but nothing repaints the transcript on its own -- the
	// old session's messages otherwise stay on screen as a "ghost transcript".
	// Refetch get_messages and push the result through the same
	// replaceFromMessages/runtime.update path used for initial hydration below.
	const rehydrateTranscript = async (): Promise<void> => {
		const messages = responseData(await client.send({ type: "get_messages" }), "get_messages").messages;
		const transcript = transcriptPump.replaceFromMessages(messages);
		runtime?.update({ transcript, transcriptRevision: transcriptPump.getRevision() });
	};
	actions = new RpcHostActions({
		controls,
		stateStore,
		modals,
		overlays,
		notifications,
		editorText: editor,
		onStateChange: requestRender,
		onRenderRequest: requestRender,
		onExitRequest: (code) => requestHostExit(code),
		rehydrateTranscript,
	});
	let statsTimer: NodeJS.Timeout | undefined;
	let statsInFlight = false;
	let stopPromise: Promise<void> | undefined;

	client.onEvent((event) => {
		if (visualFixture) return;
		if ((event as { type?: unknown }).type === "agent_start") submitInFlight = false;
		const transcript = transcriptPump.handleAgentEvent(event);
		const state = stateStore.handleAgentEvent(event);
		runtime?.update({ state, transcript, transcriptRevision: transcriptPump.getRevision() });
	});

	// The RPC child is the whole agent -- without this, the host has no signal
	// at all when it dies while idle (no pending request to reject) and keeps
	// rendering against a corpse forever; see createRpcExitHandler for why each
	// step (close modals/overlays, clear streaming state, notify, exit
	// nonzero) is needed.
	const handleClientExit = createRpcExitHandler({
		modals,
		overlays,
		stateStore,
		notifications,
		requestRender,
		stopHost: (code) => stopHost(code),
		exit: (code) => process.exit(code),
		updateRuntimeState: (state) => runtime?.update({ state }),
	});
	client.onExit((error) => {
		if (visualFixture) return;
		handleClientExit(error);
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
		stopPromise ??= (async () => {
			if (statsTimer) clearInterval(statsTimer);
			runtime?.stop(code);
			if (!regionRegistryDisposed) {
				regionRegistryDisposed = true;
				regionRegistry.dispose();
			}
			await client.stop();
		})();
		await stopPromise;
	};
	stopHost = stop;
	requestHostExit = (code: number): void => {
		runtime?.stop(code);
	};
	const handlePreEditorInput = createRpcHostInterruptHandler({
		modals,
		overlays,
		editor,
		stateStore,
		controls,
		notifications,
		requestHostExit: (code) => requestHostExit(code),
		submitInFlight: () => submitInFlight,
	});
	// A canonical escape token replays the exact same classification
	// (dismiss-modal / abort / arm-quit / quit / pass) `handlePreEditorInput`
	// already applies to a real Ctrl-C/Escape keypress -- see the
	// `handleAppInterrupt` declaration above for why this is the correct reuse
	// point instead of a second, editor-local interrupt implementation.
	handleAppInterrupt = (): void => { handlePreEditorInput("\x1b"); };
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
			env,
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
			preEditorInputHandler: handlePreEditorInput,
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
		process.removeListener("unhandledRejection", handleUnhandledRejection);
		process.removeListener("uncaughtException", handleUnhandledRejection);
		await stop();
	}
}

export async function main(): Promise<void> {
	const code = await runRpcHost();
	process.exitCode = code;
}
