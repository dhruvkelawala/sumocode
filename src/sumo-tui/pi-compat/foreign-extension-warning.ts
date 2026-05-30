import type { ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";

export interface ExtensionIdentity {
	readonly name?: string;
	readonly packageName?: string;
	readonly path?: string;
	readonly source?: string;
}

export interface ForeignExtensionWarningOptions {
	readonly notify: (message: string, type?: "info" | "warning" | "error") => void;
	readonly debug?: (message: string) => void;
}

export interface ForeignAwareUIOptions extends ForeignExtensionWarningOptions {
	readonly resolveCallerExtensionName?: () => string | undefined;
}

const SUMOCODE_PACKAGE_PREFIXES = ["@dhruvkelawala/sumocode", "@sumodeus/"] as const;
const FOREIGN_UI_WARNING = "is using Pi UI hooks not supported in SumoCode v1. Their UI may not render.";

type UiHook = "setHeader" | "setFooter" | "setEditorComponent" | "setWidget" | "custom";
type CustomFactory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>;
type CustomOptions = {
	overlay?: boolean;
	overlayOptions?: OverlayOptions | (() => OverlayOptions);
	onHandle?: (handle: OverlayHandle) => void;
};

function normalizeNpmSource(source: string): string | undefined {
	if (!source.startsWith("npm:")) return undefined;
	const spec = source.slice("npm:".length);
	if (spec.startsWith("@")) {
		const parts = spec.split("@");
		return parts.length >= 3 ? `@${parts[1]}` : spec;
	}
	return spec.split("@")[0];
}

function packageNameFromNodeModules(input: string): string | undefined {
	const normalized = input.replace(/\\/g, "/");
	const marker = "/node_modules/";
	const index = normalized.lastIndexOf(marker);
	if (index === -1) return undefined;
	const after = normalized.slice(index + marker.length);
	const parts = after.split("/");
	if (parts[0]?.startsWith("@")) return parts[0] && parts[1] ? `${parts[0]}/${parts[1]}` : undefined;
	return parts[0];
}

export function packageNameForExtension(identity: ExtensionIdentity | string): string {
	if (typeof identity === "string") {
		return normalizeNpmSource(identity) ?? packageNameFromNodeModules(identity) ?? identity;
	}
	return (
		identity.packageName ??
		identity.name ??
		(identity.source ? normalizeNpmSource(identity.source) : undefined) ??
		(identity.path ? packageNameFromNodeModules(identity.path) : undefined) ??
		identity.path ??
		identity.source ??
		"<unknown-extension>"
	);
}

export function isSumoCodeExtensionName(name: string): boolean {
	return SUMOCODE_PACKAGE_PREFIXES.some((prefix) => (prefix.endsWith("/") ? name.startsWith(prefix) : name === prefix || name.startsWith(`${prefix}/`)));
}

export function isForeignExtension(identity: ExtensionIdentity | string): boolean {
	return !isSumoCodeExtensionName(packageNameForExtension(identity));
}

export class ForeignExtensionWarning {
	private readonly notify: ForeignExtensionWarningOptions["notify"];
	private readonly debug: (message: string) => void;
	private readonly warned = new Set<string>();

	public constructor(options: ForeignExtensionWarningOptions) {
		this.notify = options.notify;
		this.debug = options.debug ?? ((message) => console.debug(message));
	}

	public warn(identity: ExtensionIdentity | string): void {
		const name = packageNameForExtension(identity);
		if (this.warned.has(name)) return;
		this.warned.add(name);
		this.notify(`Note: Extension '${name}' ${FOREIGN_UI_WARNING}`, "warning");
	}

	public warnForForeignExtensions(extensions: readonly ExtensionIdentity[]): void {
		for (const extension of extensions) {
			if (isForeignExtension(extension)) this.warn(extension);
		}
	}

	public shouldBlock(identity: ExtensionIdentity | string | undefined): boolean {
		if (!identity) return false;
		return isForeignExtension(identity);
	}

	public block(identity: ExtensionIdentity | string, hook: UiHook): boolean {
		if (!this.shouldBlock(identity)) return false;
		const name = packageNameForExtension(identity);
		this.warn(name);
		this.debug(`sumo-tui: foreign extension '${name}' attempted ${hook}; no-op in SumoCode v1`);
		return true;
	}

	public getWarnedExtensions(): readonly string[] {
		return [...this.warned];
	}
}

/**
 * Best-effort foreign extension UI guard.
 *
 * Pi 0.78.0 gives `ExtensionRunner` one shared UI context for all handlers
 * (`dist/core/extensions/runner.js:372-411`), so Phase 4 cannot receive the
 * extension id as an argument without the interactive-mode fork. This wrapper
 * accepts an injected caller resolver (the fork can provide one; tests can fake
 * one) and defensively no-ops retained UI hooks for non-SumoCode packages.
 */
export function createForeignAwareUIContext(base: ExtensionUIContext, options: ForeignAwareUIOptions): ExtensionUIContext {
	const warnings = new ForeignExtensionWarning(options);
	const caller = (): string | undefined => options.resolveCallerExtensionName?.();
	const block = (hook: UiHook): boolean => {
		const name = caller();
		return name ? warnings.block(name, hook) : false;
	};

	return {
		...base,
		setHeader: (factory) => {
			if (block("setHeader")) return;
			base.setHeader(factory);
		},
		setFooter: (factory) => {
			if (block("setFooter")) return;
			base.setFooter(factory);
		},
		setEditorComponent: (factory) => {
			if (block("setEditorComponent")) return;
			base.setEditorComponent(factory);
		},
		setWidget: (key: string, content: never, widgetOptions?: never) => {
			if (block("setWidget")) return;
			base.setWidget(key, content, widgetOptions);
		},
		custom: async <T>(factory: CustomFactory<T>, customOptions?: CustomOptions): Promise<T> => {
			if (block("custom")) return undefined as T;
			return base.custom<T>(factory, customOptions);
		},
	};
}
