import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { installCommandPalette } from "./command-palette.js";
import { registerCursorCommand } from "./commands/cursor.js";
import { registerPersonaCommand } from "./commands/persona.js";
import { registerSpinnerCommand } from "./commands/spinner.js";
import { registerTabsCommand } from "./commands/tabs.js";
import { registerThemeCommand } from "./commands/theme.js";
import { registerThemeCheckCommand } from "./commands/theme-check.js";
import { registerMemoryCommand } from "./memory-editor.js";
import { installSidebar } from "./sidebar.js";

export type InteractionKind = "command" | "shortcut";
export type InteractionConflictAction = "skipped";

export interface InteractionConflictDiagnostic {
	readonly kind: InteractionKind;
	readonly id: string;
	readonly owner: string;
	readonly conflictsWith: string;
	readonly action: InteractionConflictAction;
}

export interface InteractionRegistrySnapshot {
	readonly commands: ReadonlyArray<[id: string, owner: string]>;
	readonly shortcuts: ReadonlyArray<[id: string, owner: string]>;
	readonly diagnostics: readonly InteractionConflictDiagnostic[];
}

export type InteractionDiagnosticReporter = (diagnostics: readonly InteractionConflictDiagnostic[]) => void;

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type ShortcutOptions = Parameters<ExtensionAPI["registerShortcut"]>[1];
type InteractionInstaller = (pi: ExtensionAPI) => void;

function defaultReporter(diagnostics: readonly InteractionConflictDiagnostic[]): void {
	if (diagnostics.length === 0) return;
	console.warn(`[sumocode] interaction-conflicts ${JSON.stringify({ diagnostics })}`);
}

/**
 * Central registrar for SumoCode slash commands and keybindings.
 *
 * Existing installers still own their handlers, but every `registerCommand` and
 * `registerShortcut` call flows through this registry so ownership and startup
 * conflicts are visible in one place.
 */
export class InteractionRegistry {
	private readonly commands = new Map<string, string>();
	private readonly shortcuts = new Map<string, string>();
	private readonly diagnostics: InteractionConflictDiagnostic[] = [];
	private readonly apiProxy: ExtensionAPI;
	private activeOwner = "unknown";

	public constructor(
		private readonly pi: ExtensionAPI,
		private readonly reporter: InteractionDiagnosticReporter = defaultReporter,
	) {
		this.apiProxy = new Proxy(pi as object, {
			get: (target, property, receiver) => {
				if (property === "registerCommand") return this.registerCommand;
				if (property === "registerShortcut") return this.registerShortcut;
				const value = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as ExtensionAPI;
	}

	public get api(): ExtensionAPI {
		return this.apiProxy;
	}

	public install(owner: string, installer: InteractionInstaller): void {
		const previousOwner = this.activeOwner;
		this.activeOwner = owner;
		try {
			installer(this.apiProxy);
		} finally {
			this.activeOwner = previousOwner;
		}
	}

	public flushDiagnostics(): void {
		this.reporter(this.diagnostics);
	}

	public getSnapshot(): InteractionRegistrySnapshot {
		return {
			commands: [...this.commands.entries()],
			shortcuts: [...this.shortcuts.entries()],
			diagnostics: [...this.diagnostics],
		};
	}

	private readonly registerCommand = (name: string, options: CommandOptions): void => {
		if (!this.claim("command", name, this.commands)) return;
		this.pi.registerCommand(name, options);
	};

	private readonly registerShortcut = (shortcut: Parameters<ExtensionAPI["registerShortcut"]>[0], options: ShortcutOptions): void => {
		if (!this.claim("shortcut", String(shortcut), this.shortcuts)) return;
		this.pi.registerShortcut(shortcut, options);
	};

	private claim(kind: InteractionKind, id: string, owners: Map<string, string>): boolean {
		const existingOwner = owners.get(id);
		if (existingOwner) {
			this.diagnostics.push({
				kind,
				id,
				owner: this.activeOwner,
				conflictsWith: existingOwner,
				action: "skipped",
			});
			return false;
		}
		owners.set(id, this.activeOwner);
		return true;
	}
}

export interface InstallSumoInteractionsOptions {
	readonly reporter?: InteractionDiagnosticReporter;
}

export function createInteractionRegistry(pi: ExtensionAPI, reporter?: InteractionDiagnosticReporter): InteractionRegistry {
	return new InteractionRegistry(pi, reporter);
}

export function installSumoInteractions(pi: ExtensionAPI, options: InstallSumoInteractionsOptions = {}): InteractionRegistrySnapshot {
	const registry = createInteractionRegistry(pi, options.reporter);
	registry.install("command-palette", installCommandPalette);
	registry.install("sidebar", installSidebar);
	registry.install("commands.cursor", registerCursorCommand);
	registry.install("commands.persona", registerPersonaCommand);
	registry.install("commands.spinner", registerSpinnerCommand);
	registry.install("commands.tabs", registerTabsCommand);
	registry.install("commands.theme", registerThemeCommand);
	registry.install("commands.theme-check", registerThemeCheckCommand);
	registry.install("commands.memory", registerMemoryCommand);
	registry.flushDiagnostics();
	return registry.getSnapshot();
}
