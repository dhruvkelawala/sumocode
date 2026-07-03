import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	CombinedAutocompleteProvider,
	fuzzyFilter,
	type AutocompleteItem,
	type AutocompleteProvider,
	type Component,
	type EditorTheme,
	type SlashCommand,
	type TUI,
} from "@earendil-works/pi-tui";
import { createCathedralEditor, type CathedralEditor } from "../../cathedral/cathedral-editor.js";
import type { KeyEvent, KeyTarget } from "../input/key-router.js";
import type { EditorTextController } from "../pi-compat/extension-ui-adapter.js";
import type { RpcHostControls, RpcModelOption, RpcSlashCommand } from "./controls.js";
import { RPC_HOST_SLASH_COMMANDS } from "./host-actions.js";
import { notifyOnError, type ErrorNotifier } from "./safe-send.js";

export type RpcEditorAutocompleteControls = Pick<RpcHostControls, "getCommands" | "getAvailableModels">;
type RpcModelCompletionControls = Pick<RpcHostControls, "getAvailableModels">;

export interface RpcEditorAutocompleteOptions {
	readonly controls?: RpcModelCompletionControls;
}

export interface RpcAutocompleteProviderOptions {
	readonly cwd?: string;
	readonly fdPath?: string | null;
}

export interface RpcHostEditorControllerOptions extends RpcAutocompleteProviderOptions {
	readonly controls?: RpcEditorAutocompleteControls;
	readonly tui?: TUI;
	readonly theme?: EditorTheme;
	readonly keybindings?: KeybindingsManager;
	readonly isSplash?: () => boolean;
	readonly onSubmit?: (text: string) => void | Promise<void>;
	readonly errorNotifier?: ErrorNotifier;
	readonly onRenderRequest?: () => void;
	readonly autocompleteMaxVisible?: number;
}

const identity = (text: string): string => text;
const CSI_U_ENTER = "\x1b[13u";

export function buildRpcAutocompleteCommands(
	rpcCommands: readonly RpcSlashCommand[] = [],
	options: RpcEditorAutocompleteOptions = {},
): SlashCommand[] {
	const seen = new Set<string>();
	const commands: SlashCommand[] = RPC_HOST_SLASH_COMMANDS.map((command) => {
		seen.add(command.name);
		return { name: command.name, description: command.description };
	});
	const modelCommand = commands.find((command) => command.name === "model");
	if (modelCommand && options.controls) {
		modelCommand.getArgumentCompletions = (prefix) => getModelArgumentCompletions(options.controls!, prefix);
	}

	for (const command of rpcCommands) {
		const name = normalizeCommandName(command.name);
		if (!name || seen.has(name)) continue;
		seen.add(name);
		commands.push({
			name,
			description: command.description,
		});
	}

	return commands;
}

export async function loadRpcAutocompleteCommands(controls: RpcEditorAutocompleteControls): Promise<SlashCommand[]> {
	return buildRpcAutocompleteCommands(await controls.getCommands(), { controls });
}

export function createRpcAutocompleteProvider(
	commands: readonly SlashCommand[],
	options: RpcAutocompleteProviderOptions = {},
): CombinedAutocompleteProvider {
	return new CombinedAutocompleteProvider([...commands], options.cwd ?? process.cwd(), options.fdPath ?? null);
}

export async function createRpcAutocompleteProviderFromControls(
	controls: RpcEditorAutocompleteControls,
	options: RpcAutocompleteProviderOptions = {},
): Promise<CombinedAutocompleteProvider> {
	return createRpcAutocompleteProvider(await loadRpcAutocompleteCommands(controls), options);
}

export class RpcHostEditorController implements EditorTextController, KeyTarget {
	public readonly editor: CathedralEditor;
	private readonly tui: TUI;
	private readonly controls: RpcEditorAutocompleteControls | undefined;
	private readonly cwd: string | undefined;
	private readonly fdPath: string | null | undefined;
	private readonly onSubmit: (text: string) => void | Promise<void>;
	private readonly errorNotifier: ErrorNotifier | undefined;
	private isSplashProvider: () => boolean;

	public constructor(options: RpcHostEditorControllerOptions = {}) {
		this.tui = options.tui ?? createFallbackTui(options.onRenderRequest);
		this.controls = options.controls;
		this.cwd = options.cwd;
		this.fdPath = options.fdPath;
		this.onSubmit = options.onSubmit ?? (() => undefined);
		this.errorNotifier = options.errorNotifier;
		this.isSplashProvider = options.isSplash ?? (() => false);
		this.editor = createCathedralEditor(
			this.tui,
			options.theme ?? createFallbackEditorTheme(),
			options.keybindings ?? createNoopKeybindings(),
			{ isSplash: () => this.isSplashProvider() },
		);
		this.editor.focused = true;
		this.editor.onChange = () => this.tui.requestRender();
		this.editor.onSubmit = (text) => {
			if (this.errorNotifier) {
				void notifyOnError(() => this.onSubmit(text), this.errorNotifier);
				return;
			}
			void Promise.resolve(this.onSubmit(text)).catch(() => undefined);
		};
		if (options.autocompleteMaxVisible !== undefined) this.editor.setAutocompleteMaxVisible(options.autocompleteMaxVisible);
	}

	public async configureAutocomplete(controls: RpcEditorAutocompleteControls | undefined = this.controls): Promise<void> {
		if (!controls) return;
		this.setAutocompleteProvider(await createRpcAutocompleteProviderFromControls(controls, {
			cwd: this.cwd,
			fdPath: this.fdPath,
		}));
	}

	public setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.editor.setAutocompleteProvider(provider);
	}

	public focus(): Component {
		this.editor.focused = true;
		return this.editor;
	}

	public blur(): void {
		this.editor.focused = false;
	}

	public invalidate(): void {
		this.editor.invalidate();
	}

	public setSplashProvider(provider: () => boolean): void {
		this.isSplashProvider = provider;
		this.tui.requestRender();
	}

	public handleKey(event: KeyEvent): boolean {
		this.handleInput(keyEventToEditorInput(event));
		return true;
	}

	public handleInput(data: string): void {
		for (const chunk of splitCsiUEnter(data)) {
			this.editor.handleInput(chunk);
		}
	}

	public render(width: number): string[] {
		return this.editor.render(width);
	}

	public paste(text: string): void {
		this.editor.insertTextAtCursor(text);
		this.tui.requestRender();
	}

	public setText(text: string): void {
		this.editor.setText(text);
		this.tui.requestRender();
	}

	public getText(): string {
		return this.editor.getText();
	}
}

export async function createRpcHostEditorController(
	options: RpcHostEditorControllerOptions = {},
): Promise<RpcHostEditorController> {
	const controller = new RpcHostEditorController(options);
	await controller.configureAutocomplete(options.controls);
	return controller;
}

function normalizeCommandName(name: string): string {
	return name.trim().replace(/^\/+/, "");
}

function keyEventToEditorInput(event: KeyEvent): string {
	if (event.sequence !== undefined) return event.sequence;
	if (event.key === "enter" || event.key === "Enter") return "\r";
	return event.key;
}

function splitCsiUEnter(data: string): string[] {
	if (!data.includes(CSI_U_ENTER)) return [data];
	const chunks: string[] = [];
	let remaining = data;
	while (remaining.length > 0) {
		const index = remaining.indexOf(CSI_U_ENTER);
		if (index === -1) {
			chunks.push(remaining);
			break;
		}
		if (index > 0) chunks.push(remaining.slice(0, index));
		chunks.push(CSI_U_ENTER);
		remaining = remaining.slice(index + CSI_U_ENTER.length);
	}
	return chunks;
}

async function getModelArgumentCompletions(
	controls: RpcModelCompletionControls,
	prefix: string,
): Promise<AutocompleteItem[] | null> {
	const models = await controls.getAvailableModels();
	if (models.length === 0) return null;
	const items = models.map(modelToAutocompleteItem);
	const filtered = fuzzyFilter(items, prefix, (item) => `${item.value} ${item.description ?? ""}`);
	return filtered.length > 0 ? filtered : null;
}

function modelToAutocompleteItem(model: RpcModelOption): AutocompleteItem {
	return {
		value: model.label,
		label: model.label,
		description: model.active ? "active" : undefined,
	};
}

function createFallbackTui(onRenderRequest: (() => void) | undefined): TUI {
	return {
		requestRender: () => onRenderRequest?.(),
		terminal: { columns: 80, rows: 24, setTitle: () => undefined },
	} as unknown as TUI;
}

function createFallbackEditorTheme(): EditorTheme {
	return {
		borderColor: identity,
		selectList: {
			selectedPrefix: identity,
			selectedText: identity,
			description: identity,
			scrollInfo: identity,
			noMatch: identity,
		},
	};
}

function createNoopKeybindings(): KeybindingsManager {
	return {
		matches: () => false,
	} as unknown as KeybindingsManager;
}
