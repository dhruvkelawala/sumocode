import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import {
	CommandPaletteComponent,
	type CommandPaletteSnapshot,
	type PaletteMode,
} from "../../command-palette.js";
import {
	renderApprovalModal,
	updateApprovalSnapshot,
	type ApprovalChoice,
	type ApprovalModalSnapshot,
} from "../../approval-modal.js";
import {
	createRemnicMemoryClient,
	MemoryClientError,
	type MemoryFact,
	type RemnicMemoryClient,
} from "../../memory.js";
import { groupFactsByPanel } from "../../memory-categorization.js";
import {
	MemoryEditorComponent,
	formatMemoryStatus,
	type MemoryEditorSnapshot,
} from "../../memory-editor.js";
import { renderThemeCheck, type ThemeBgSlot, type ThemeFgSlot, type ThemeReader } from "../../theme-check.js";
import { activeThemeColors, getActiveTheme, listThemes, setActiveTheme } from "../../themes/index.js";
import type { EditorTextController } from "../pi-compat/extension-ui-adapter.js";
import type { ModalManager } from "../widgets/modal.js";
import type { NotificationCenter, NotificationLevel } from "../widgets/notification.js";
import type { RpcHostControls, RpcModelOption, RpcSessionStats, RpcThinkingLevel } from "./controls.js";
import type { RpcHostOverlayManager } from "./host-overlays.js";
import type { InlineSelectorHost } from "./inline-selector.js";
import { notifyOnError } from "./safe-send.js";
import type { RpcHostStateStore } from "./state.js";

export const RPC_HOST_COMMAND_PALETTE_INPUT = "\u001f";

export interface RpcHostSlashCommand {
	readonly name: string;
	readonly description: string;
}

type HostModals = Pick<ModalManager, "select" | "confirm" | "input">;
type HostInlineSelectors = Pick<InlineSelectorHost, "select">;
type HostNotifications = Pick<NotificationCenter, "notify">;
type MemoryClientFactory = () => RemnicMemoryClient;

export interface RpcHostActionsOptions {
	readonly controls: RpcHostControls;
	readonly stateStore: RpcHostStateStore;
	readonly modals: HostModals;
	readonly overlays: RpcHostOverlayManager;
	/**
	 * In-place selector surface (plan 036): `openModelSelector`,
	 * `openThinkingSelector`, `openSessionControls`, `openSettings`, and
	 * `openForkSelector` present through this instead of `modals.select(...)`,
	 * so they render in the editor's band with the transcript/chrome still
	 * visible instead of a full-screen `ModalLayer` backdrop. `modals` is kept
	 * for confirm/input and the genuinely-blocking approval/confirm/input
	 * flows elsewhere in the host -- only these five selectors moved.
	 */
	readonly inlineSelectors: HostInlineSelectors;
	readonly notifications: HostNotifications;
	readonly editorText?: EditorTextController;
	readonly createMemoryClient?: MemoryClientFactory;
	readonly onStateChange?: () => void;
	readonly onRenderRequest?: () => void;
	readonly onExitRequest?: (code: number) => void;
	/**
	 * Called after a session operation (new/switch/clone/fork) succeeds, so the
	 * host can refetch `get_messages` from the child and push a fresh transcript
	 * into the runtime. Without this the old session's messages stay on screen
	 * ("ghost transcript") after switching sessions. Not called when the
	 * operation is cancelled or throws.
	 */
	readonly rehydrateTranscript?: () => Promise<void>;
}

const THINKING_LEVELS: readonly RpcThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export const RPC_HOST_SLASH_COMMANDS: readonly RpcHostSlashCommand[] = Object.freeze([
	{ name: "settings", description: "Open RPC settings" },
	{ name: "model", description: "Select model or set provider/model" },
	{ name: "thinking", description: "Select thinking level" },
	{ name: "theme", description: "Select SumoCode theme" },
	{ name: "sumo:theme", description: "Select SumoCode theme" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "new", description: "Start a new session" },
	{ name: "clone", description: "Duplicate the current session" },
	{ name: "fork", description: "Fork from a previous user message" },
	{ name: "sessions", description: "Open session controls" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "name", description: "Rename the current session" },
	{ name: "quit", description: "Quit SumoCode" },
	{ name: "sumo:memory", description: "Open or update SumoCode memory" },
	{ name: "sumo:theme-check", description: "Preview current theme tokens" },
	{ name: "sumo:approval", description: "Preview approval overlay" },
	{ name: "sumo:palette", description: "Open the command palette" },
]);

const RPC_HOST_SLASH_COMMAND_NAMES = new Set(RPC_HOST_SLASH_COMMANDS.map((command) => command.name));

export function isRpcHostSlashCommandName(name: string): boolean {
	return RPC_HOST_SLASH_COMMAND_NAMES.has(normalizeCommandName(name));
}

function notify(notifications: HostNotifications, message: string, level: NotificationLevel = "info"): void {
	notifications.notify(message, level);
}

function modelLabel(model: RpcModelOption): string {
	return model.active ? `Current: ${model.label}` : model.label;
}

function parseModelLabel(label: string): { provider: string; id: string } | undefined {
	const cleaned = label.replace(/^Current:\s*/i, "");
	const slash = cleaned.indexOf("/");
	if (slash <= 0) return undefined;
	return { provider: cleaned.slice(0, slash), id: cleaned.slice(slash + 1) };
}

function firstArg(input: string): { command: string; args: string } {
	const trimmed = input.trim();
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	return { command: match?.[1]?.toLowerCase() ?? "", args: match?.[2] ?? "" };
}

function normalizeCommandName(name: string): string {
	return name.trim().replace(/^\/+/, "").toLowerCase();
}

function ansi(hex: string, channel: 38 | 48): string {
	const normalized = hex.replace("#", "");
	const r = parseInt(normalized.slice(0, 2), 16);
	const g = parseInt(normalized.slice(2, 4), 16);
	const b = parseInt(normalized.slice(4, 6), 16);
	return `\u001b[${channel};2;${r};${g};${b}m`;
}

function color(text: string, hex: string): string {
	return `${ansi(hex, 38)}${text}\u001b[39m`;
}

function colorBg(text: string, hex: string): string {
	return `${ansi(hex, 48)}${text}\u001b[49m`;
}

function slotColor(slot: ThemeFgSlot): string {
	const colors = activeThemeColors();
	if (slot === "accent" || slot === "borderAccent" || slot.startsWith("md") || slot.startsWith("syntax")) return colors.accent;
	if (slot === "success" || slot === "thinkingOff" || slot === "thinkingMinimal") return colors.states.idle;
	if (slot === "warning" || slot === "thinkingText" || slot === "thinkingLow" || slot === "thinkingMedium" || slot === "thinkingHigh" || slot === "thinkingXhigh") return colors.states.thinking;
	if (slot === "error") return colors.states.approval;
	if (slot === "border" || slot === "borderMuted" || slot === "mdHr" || slot === "mdQuoteBorder" || slot === "toolDiffContext") return colors.divider;
	if (slot === "muted" || slot === "dim" || slot === "toolOutput" || slot === "bashMode") return colors.foregroundDim;
	if (slot === "toolDiffAdded") return colors.states.learning;
	if (slot === "toolDiffRemoved") return colors.states.approval;
	return colors.foreground;
}

function bgSlotColor(slot: ThemeBgSlot): string {
	const colors = activeThemeColors();
	if (slot === "selectedBg") return colors.surfaceLifted;
	if (slot === "toolErrorBg") return colors.states.approval;
	if (slot === "toolSuccessBg") return colors.states.learning;
	return colors.surface;
}

function themeReader(): ThemeReader {
	return {
		fg: (slot, text) => color(text, slotColor(slot)),
		bg: (slot, text) => colorBg(color(text, activeThemeColors().foreground), bgSlotColor(slot)),
	};
}

function formatInteger(value: number): string {
	return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "0";
}

function formatCost(value: number): string {
	if (!Number.isFinite(value)) return "$0.00";
	return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
}

function formatSessionStats(stats: RpcSessionStats): string {
	return `session: ${formatInteger(stats.totalMessages)} messages | ${formatInteger(stats.tokens.total)} tokens | ${formatCost(stats.cost)}`;
}

class LinesOverlayComponent implements Component {
	public constructor(
		private readonly renderLines: (width: number) => string[],
		private readonly done: () => void,
	) {}

	public invalidate(): void {}

	public handleInput(_data: string): void {
		this.done();
	}

	public render(width: number): string[] {
		return this.renderLines(width);
	}
}

class HostApprovalPreviewComponent implements Component {
	private snapshot: ApprovalModalSnapshot;

	public constructor(command: string, private readonly done: (choice: ApprovalChoice) => void) {
		this.snapshot = {
			command,
			descriptionLines: ["This is a host-side RPC approval preview."],
			activeButton: "no",
		};
	}

	public invalidate(): void {}

	public handleInput(data: string): void {
		const result = updateApprovalSnapshot(this.snapshot, data);
		this.snapshot = result.snapshot;
		if (result.done) this.done(result.done);
	}

	public render(width: number): string[] {
		return renderApprovalModal(this.snapshot, width);
	}
}

export class RpcHostActions {
	private readonly controls: RpcHostControls;
	private readonly stateStore: RpcHostStateStore;
	private readonly modals: HostModals;
	private readonly overlays: RpcHostOverlayManager;
	private readonly inlineSelectors: HostInlineSelectors;
	private readonly notifications: HostNotifications;
	private readonly editorText: EditorTextController | undefined;
	private readonly createMemoryClient: MemoryClientFactory;
	private readonly onStateChange: () => void;
	private readonly onRenderRequest: () => void;
	private readonly onExitRequest: (code: number) => void;
	private readonly rehydrateTranscript: () => Promise<void>;

	public constructor(options: RpcHostActionsOptions) {
		this.controls = options.controls;
		this.stateStore = options.stateStore;
		this.modals = options.modals;
		this.overlays = options.overlays;
		this.inlineSelectors = options.inlineSelectors;
		this.notifications = options.notifications;
		this.editorText = options.editorText;
		this.createMemoryClient = options.createMemoryClient ?? createRemnicMemoryClient;
		this.onStateChange = options.onStateChange ?? (() => undefined);
		this.onRenderRequest = options.onRenderRequest ?? (() => undefined);
		this.onExitRequest = options.onExitRequest ?? (() => undefined);
		this.rehydrateTranscript = options.rehydrateTranscript ?? (() => Promise.resolve());
	}

	public handleInput(data: string): boolean {
		if (data === RPC_HOST_COMMAND_PALETTE_INPUT || data === "ctrl+/" || matchesKey(data, Key.ctrl("/"))) {
			void notifyOnError(() => this.openCommandPalette(), this.notifications);
			return true;
		}
		return false;
	}

	public async handleSubmittedText(text: string): Promise<boolean> {
		const { command, args } = firstArg(text);
		if (!command.startsWith("/")) return false;
		switch (command) {
			case "/model":
				if (args.trim()) await this.setModelFromText(args.trim());
				else await this.openModelSelector();
				return true;
			case "/thinking":
				if (args.trim()) await this.setThinkingFromText(args.trim());
				else await this.openThinkingSelector();
				return true;
			case "/theme":
			case "/sumo:theme":
				if (args.trim()) this.setThemeFromText(args.trim());
				else await this.openThemeSelector();
				return true;
			case "/compact":
				await this.compact(args.trim());
				return true;
			case "/new":
				await this.newSession();
				return true;
			case "/clone":
				await this.cloneSession();
				return true;
			case "/fork":
				await this.openForkSelector();
				return true;
			case "/session":
				await this.showSessionStats();
				return true;
			case "/sessions":
				await this.openSessionControls();
				return true;
			case "/name":
				await this.renameSession();
				return true;
			case "/settings":
				await this.openSettings();
				return true;
			case "/quit":
				this.onExitRequest(0);
				return true;
			case "/sumo:memory":
				await this.handleMemoryCommand(args);
				return true;
			case "/sumo:theme-check":
				await this.openThemeCheck();
				return true;
			case "/sumo:approval":
				await this.openApprovalPreview();
				return true;
			case "/sumo:palette":
				await this.openCommandPalette();
				return true;
			default:
				if (command.startsWith("/")) {
					if (await this.childCanExecuteCommand(command)) return false;
					notify(this.notifications, `unknown command: ${command}`, "warning");
					return true;
				}
				return false;
		}
	}

	public async openCommandPalette(): Promise<void> {
		const selection = await this.overlays.show<PaletteMode | undefined>(
			"commandPalette",
			(done) => new CommandPaletteComponent(this.buildPaletteSnapshot(), done),
		);
		await this.handlePaletteSelection(selection);
	}

	public async handlePaletteSelection(selection: PaletteMode | undefined): Promise<void> {
		if (selection === undefined) return;
		if (selection === "MODEL") await this.openModelSelector();
		else if (selection === "THINKING") await this.openThinkingSelector();
		else if (selection === "SESSION") await this.openSessionControls();
		else if (selection === "MEMORY") await this.openMemoryEditor();
		else if (selection === "THEME") await this.openThemeSelector();
		else if (selection === "SETTINGS") await this.openSettings();
	}

	public async openModelSelector(): Promise<void> {
		const models = await this.controls.getAvailableModels();
		if (models.length === 0) {
			notify(this.notifications, "no models available", "warning");
			return;
		}
		const labels = models.map(modelLabel);
		const selected = await this.inlineSelectors.select("Choose model", labels);
		if (selected === undefined) return;
		const parsed = parseModelLabel(selected);
		if (!parsed) {
			notify(this.notifications, `unknown model: ${selected}`, "warning");
			return;
		}
		await this.controls.setModel(parsed.provider, parsed.id);
		this.onStateChange();
		notify(this.notifications, `model: ${parsed.provider}/${parsed.id}`, "info");
	}

	public async openThinkingSelector(): Promise<void> {
		const selected = await this.modals.select("Set thinking level", [...THINKING_LEVELS]);
		if (selected === undefined) return;
		await this.setThinkingFromText(selected);
	}

	public async openThemeSelector(): Promise<void> {
		const selected = await this.modals.select("Choose SumoCode theme", listThemes().map((theme) => theme.name));
		if (selected) this.setThemeFromText(selected);
	}

	public async openSessionControls(): Promise<void> {
		const selected = await this.modals.select("Session controls", [
			"New session",
			"Switch session by path",
			"Fork from message",
			"Clone session",
			"Rename session",
		]);
		if (selected === "New session") await this.newSession();
		else if (selected === "Switch session by path") await this.switchSessionByPath();
		else if (selected === "Fork from message") await this.openForkSelector();
		else if (selected === "Clone session") await this.cloneSession();
		else if (selected === "Rename session") await this.renameSession();
	}

	public async openSettings(): Promise<void> {
		const selected = await this.modals.select("RPC settings", [
			"Enable auto compaction",
			"Disable auto compaction",
			"Enable auto retry",
			"Disable auto retry",
		]);
		if (selected === "Enable auto compaction") await this.setAutoCompaction(true);
		else if (selected === "Disable auto compaction") await this.setAutoCompaction(false);
		else if (selected === "Enable auto retry") await this.setAutoRetry(true);
		else if (selected === "Disable auto retry") await this.setAutoRetry(false);
	}

	public async openForkSelector(): Promise<void> {
		const messages = await this.controls.getForkMessages();
		if (messages.length === 0) {
			notify(this.notifications, "no forkable messages", "warning");
			return;
		}
		const labels = messages.map((message, index) => `${index + 1}. ${message.text.slice(0, 72)}`);
		const selected = await this.modals.select("Fork from message", labels);
		if (!selected) return;
		const index = labels.indexOf(selected);
		const message = messages[index];
		if (!message) return;
		const result = await this.controls.fork(message.entryId);
		if (!result.cancelled) {
			if (result.text) this.editorText?.setText(result.text);
			await this.rehydrateTranscript();
		}
		this.onStateChange();
	}

	public async openThemeCheck(): Promise<void> {
		await this.overlays.show<void>(
			"themeCheck",
			(done) => new LinesOverlayComponent(
				(width) => renderThemeCheck(themeReader(), Math.max(40, Math.min(width, 120))),
				done,
			),
		);
	}

	public async openApprovalPreview(command = "rm -rf node_modules/"): Promise<void> {
		const choice = await this.overlays.show<ApprovalChoice>(
			"approvalPreview",
			(done) => new HostApprovalPreviewComponent(command, done),
		);
		notify(this.notifications, `approval selected: ${choice}`, choice === "no" ? "warning" : "info");
	}

	public async openMemoryEditor(): Promise<void> {
		let facts: MemoryFact[];
		const client = this.createMemoryClient();
		try {
			facts = await client.browse({ status: "active", limit: 500 });
		} catch (error) {
			const message = error instanceof MemoryClientError ? error.message : String(error);
			notify(this.notifications, `memory unavailable: ${message}`, "warning");
			return;
		}
		const initial: MemoryEditorSnapshot = {
			searchQuery: "",
			groups: groupFactsByPanel(facts),
			factsTotal: facts.length,
			focusedFactId: null,
		};
		await this.overlays.show<void>(
			"memoryEditor",
			(done) => new MemoryEditorComponent(initial, {
				client,
				notify: (message, level) => notify(this.notifications, message, level ?? "info"),
				invalidate: this.onRenderRequest,
				close: () => done(),
			}),
		);
	}

	public async handleMemoryCommand(args: string): Promise<void> {
		const { command, args: rest } = firstArg(args);
		const client = this.createMemoryClient();
		if (command === "" || command === "edit") {
			await this.openMemoryEditor();
			return;
		}
		if (command === "status") {
			await notifyOnError(async () => {
				notify(this.notifications, formatMemoryStatus(await client.status()), "info");
			}, this.notifications);
			return;
		}
		if (command === "add") {
			const text = rest.trim();
			if (!text) {
				notify(this.notifications, "usage: /sumo:memory add <text>", "info");
				return;
			}
			await notifyOnError(async () => {
				await client.add(text);
				notify(this.notifications, `memory added: ${text.slice(0, 40)}${text.length > 40 ? "…" : ""}`, "info");
			}, this.notifications);
			return;
		}
		if (command === "forget") {
			const id = rest.trim();
			if (!id) {
				notify(this.notifications, "usage: /sumo:memory forget <fact-id>", "info");
				return;
			}
			await notifyOnError(async () => {
				await client.forget(id);
				notify(this.notifications, `memory forgotten: ${id}`, "info");
			}, this.notifications);
			return;
		}
		notify(this.notifications, "usage: /sumo:memory [edit|add <text>|forget <id>|status]", "info");
	}

	private buildPaletteSnapshot(): CommandPaletteSnapshot {
		const state = this.stateStore.getSnapshot();
		return {
			searchQuery: "",
			activeIndex: 1,
			rows: [
				{ label: "SESSION", currentValue: state.sessionName ?? state.sessionId ?? "current session" },
				{ label: "MODEL", currentValue: state.modelLabel ?? "model pending" },
				{ label: "THINKING", currentValue: state.thinkingLevel ?? "medium" },
				{ label: "MEMORY", currentValue: "host" },
				{ label: "THEME", currentValue: getActiveTheme().name },
				{ label: "SETTINGS", currentValue: "host controls" },
			],
		};
	}

	private async setModelFromText(value: string): Promise<void> {
		const parsed = parseModelLabel(value);
		if (!parsed) {
			notify(this.notifications, "usage: /model <provider/model>", "warning");
			return;
		}
		await this.controls.setModel(parsed.provider, parsed.id);
		this.onStateChange();
		notify(this.notifications, `model: ${parsed.provider}/${parsed.id}`, "info");
	}

	private async setThinkingFromText(value: string): Promise<void> {
		const level = value.trim().toLowerCase() as RpcThinkingLevel;
		if (!THINKING_LEVELS.includes(level)) {
			notify(this.notifications, `unknown thinking level: ${value}`, "warning");
			return;
		}
		await this.controls.setThinkingLevel(level);
		this.onStateChange();
		notify(this.notifications, `thinking: ${level}`, "info");
	}

	private setThemeFromText(value: string): void {
		const result = setActiveTheme(value);
		if (!result.success) {
			notify(this.notifications, result.error, "warning");
			return;
		}
		this.onRenderRequest();
		notify(this.notifications, `theme: ${result.theme.name}`, "info");
	}

	private async compact(instructions: string): Promise<void> {
		await this.controls.compact(instructions.length > 0 ? instructions : undefined);
		this.onStateChange();
		notify(this.notifications, "compaction requested", "info");
	}

	private async newSession(): Promise<void> {
		const result = await this.controls.newSession();
		if (!result.cancelled) {
			await this.controls.refreshState();
			await this.rehydrateTranscript();
			this.onStateChange();
			notify(this.notifications, "new session", "info");
		}
	}

	private async switchSessionByPath(): Promise<void> {
		const path = await this.modals.input("Switch session", "path to session jsonl");
		const trimmed = path?.trim() ?? "";
		if (!trimmed) return;
		const result = await this.controls.switchSession(trimmed);
		if (!result.cancelled) {
			await this.controls.refreshState();
			await this.rehydrateTranscript();
			this.onStateChange();
			notify(this.notifications, "session switched", "info");
		}
	}

	private async cloneSession(): Promise<void> {
		const result = await this.controls.clone();
		if (!result.cancelled) {
			await this.controls.refreshState();
			await this.rehydrateTranscript();
			this.onStateChange();
			notify(this.notifications, "session cloned", "info");
		}
	}

	private async showSessionStats(): Promise<void> {
		const stats = await this.controls.getSessionStats();
		this.stateStore.hydrateFromSessionStats(stats);
		this.onStateChange();
		notify(this.notifications, formatSessionStats(stats), "info");
	}

	private async renameSession(): Promise<void> {
		const name = await this.modals.input("Rename session", "session name");
		const trimmed = name?.trim() ?? "";
		if (!trimmed) return;
		await this.controls.setSessionName(trimmed);
		await this.controls.refreshState();
		this.onStateChange();
		notify(this.notifications, `session name: ${trimmed}`, "info");
	}

	private async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.controls.setAutoCompaction(enabled);
		await this.controls.refreshState();
		this.onStateChange();
		notify(this.notifications, `auto compaction ${enabled ? "enabled" : "disabled"}`, "info");
	}

	private async setAutoRetry(enabled: boolean): Promise<void> {
		await this.controls.setAutoRetry(enabled);
		this.onStateChange();
		notify(this.notifications, `auto retry ${enabled ? "enabled" : "disabled"}`, "info");
	}

	private async childCanExecuteCommand(command: string): Promise<boolean> {
		const name = normalizeCommandName(command);
		if (!name) return false;
		const commands = await this.controls.getCommands();
		return commands.some((childCommand) => normalizeCommandName(childCommand.name) === name);
	}
}
