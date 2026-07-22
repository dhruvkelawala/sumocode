import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentManager } from "./subagents/manager.js";
import { installCommandPalette } from "./command-palette.js";
import { registerCursorCommand } from "./commands/cursor.js";
import { registerDiffCommand } from "./commands/diff.js";
import { registerDivineQueryCommand } from "./commands/divine-query.js";
import { registerExitCommand } from "./commands/exit.js";
import { registerSlateCommand } from "./commands/slate.js";
import { registerShipCommand } from "./commands/ship.js";
import { registerPersonaCommand } from "./commands/persona.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerSpinnerCommand } from "./commands/spinner.js";
import { registerSumoSyncCommand } from "./commands/sync.js";
import { registerTabsCommand } from "./commands/tabs.js";
import { registerThemeCommand } from "./commands/theme.js";
import { registerThemeCheckCommand } from "./commands/theme-check.js";
import { registerWorktreeCommand } from "./commands/worktree.js";
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
// Installers must register interactions synchronously. The registry temporarily
// wraps Pi's registration methods for the duration of `install()` and restores
// them in `finally`; delayed registrations would intentionally bypass ownership
// tracking instead of keeping a Proxy/cast-heavy wrapper alive.
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
	private activeOwner = "unknown";

	public constructor(
		private readonly pi: ExtensionAPI,
		private readonly reporter: InteractionDiagnosticReporter = defaultReporter,
	) {}

	public install(owner: string, installer: InteractionInstaller): void {
		const previousOwner = this.activeOwner;
		const originalRegisterCommand = this.pi.registerCommand;
		const originalRegisterShortcut = this.pi.registerShortcut;
		this.activeOwner = owner;
		this.pi.registerCommand = (name: string, options: CommandOptions): void => {
			if (!this.claim("command", name, this.commands)) return;
			originalRegisterCommand.call(this.pi, name, options);
		};
		this.pi.registerShortcut = (shortcut: Parameters<ExtensionAPI["registerShortcut"]>[0], options: ShortcutOptions): void => {
			if (!this.claim("shortcut", String(shortcut), this.shortcuts)) return;
			originalRegisterShortcut.call(this.pi, shortcut, options);
		};
		try {
			installer(this.pi);
		} finally {
			this.pi.registerCommand = originalRegisterCommand;
			this.pi.registerShortcut = originalRegisterShortcut;
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
	readonly subagentManager?: SubagentManager;
	readonly includeUiSurfaces?: boolean;
}

export function createInteractionRegistry(pi: ExtensionAPI, reporter?: InteractionDiagnosticReporter): InteractionRegistry {
	return new InteractionRegistry(pi, reporter);
}

export function installSumoInteractions(pi: ExtensionAPI, options: InstallSumoInteractionsOptions = {}): InteractionRegistrySnapshot {
	const registry = createInteractionRegistry(pi, options.reporter);
	if (options.includeUiSurfaces !== false) {
		registry.install("command-palette", installCommandPalette);
		registry.install("sidebar", installSidebar);
	}
	registry.install("commands.cursor", registerCursorCommand);
	registry.install("commands.diff", registerDiffCommand);
	registry.install("commands.divine-query", registerDivineQueryCommand);
	registry.install("commands.exit", registerExitCommand);
	registry.install("commands.slate", registerSlateCommand);
	registry.install("commands.persona", registerPersonaCommand);
	registry.install("commands.review", (targetPi) => registerReviewCommand(targetPi, { subagentSpawner: options.subagentManager }));
	registry.install("commands.ship", registerShipCommand);
	registry.install("commands.spinner", registerSpinnerCommand);
	registry.install("commands.sync", registerSumoSyncCommand);
	registry.install("commands.tabs", registerTabsCommand);
	registry.install("commands.theme", registerThemeCommand);
	registry.install("commands.theme-check", registerThemeCheckCommand);
	registry.install("commands.worktree", registerWorktreeCommand);
	registry.install("commands.memory", registerMemoryCommand);
	registry.flushDiagnostics();
	return registry.getSnapshot();
}
