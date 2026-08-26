// oxlint-disable-next-line no-control-regex -- intentional ESC byte match covering CSI/OSC/APC sequences used to strip Pi styling
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);
const PI_NOISE_FILTER_INSTALLED = Symbol("sumo-tui.pi-noise-filter-installed");

import type { SessionRecord } from "../transcript/view-model.js";

export const PI_NOISE_TEXT_PATTERNS: readonly RegExp[] = [
	/\[Skill conflicts\]/i,
	/\[Prompt conflicts\]/i,
	/\[Extension issues\]/i,
	/\[Theme conflicts\]/i,
	/Warning:\s*Anthropic subscription auth is active/i,
	/Anthropic subscription auth is active\. Third-party harness usage/i,
];

/**
 * Opaque foreign Pi renderable component handed across the compat seam.
 * Structural on purpose: SumoCode only ever touches the optional hooks below.
 */
export type ForeignChatComponent = {
	render?(width: number): string[];
	invalidate?(): void;
};

export interface PiChatContainer {
	children?: unknown[];
	addChild?(component: ForeignChatComponent): void;
	clear?(): void;
	invalidate?(): void;
	render?(width: number): string[];
}

interface FilterablePiChatContainer extends PiChatContainer {
	[PI_NOISE_FILTER_INSTALLED]?: true;
}

export interface PiNoiseFilterState {
	removedNodes: unknown[];
	skipNextSpacer: boolean;
}

function envFlagEnabled(value: string | undefined, defaultValue: boolean): boolean {
	if (value === undefined) return defaultValue;
	return !FALSE_ENV_VALUES.has(value.trim().toLowerCase());
}

// Boundary predicates for opaque values crossing the Pi compat seam. They are
// generic so callers keep their own static type; each check validates exactly
// one runtime property before the value is used.
function isRecord<T>(value: T): value is T & SessionRecord {
	return typeof value === "object" && value !== null;
}

function isString<T>(value: T): value is T & string {
	return typeof value === "string";
}

function isCallable<T>(value: T): value is T & ((...args: never[]) => void) {
	return typeof value === "function";
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function getTextComponentContent<T>(component: T): string | undefined {
	if (!isRecord(component) || !("text" in component)) return undefined;
	return isString(component.text) ? component.text : undefined;
}

function isSpacerComponent<T>(component: T): boolean {
	if (!isRecord(component)) return false;
	// SAFETY: probing Pi's runtime class hierarchy (`constructor.name`) on an
	// opaque foreign component; the object check above guards property access.
	return (component as { constructor?: { name?: unknown } }).constructor?.name === "Spacer";
}

export function shouldHidePiNoise(env: NodeJS.ProcessEnv = process.env): boolean {
	return envFlagEnabled(env.SUMO_TUI_HIDE_PI_NOISE, true);
}

export function shouldForceHardwareCursor(env: NodeJS.ProcessEnv = process.env): boolean {
	return envFlagEnabled(env.SUMO_TUI_SHOW_HARDWARE_CURSOR, true);
}

export function isPiNoiseTextComponent<T>(component: T): boolean {
	const text = getTextComponentContent(component);
	if (text === undefined) return false;
	const plain = stripAnsi(text);
	return PI_NOISE_TEXT_PATTERNS.some((pattern) => pattern.test(plain));
}

export function getUpstreamChatContainer<T>(upstream: T): PiChatContainer | undefined {
	if (!isRecord(upstream) || !("chatContainer" in upstream)) return undefined;
	const chatContainer: unknown = upstream.chatContainer;
	if (!isRecord(chatContainer)) return undefined;
	// SAFETY: structural probe of Pi's interactive mode; the container is only
	// consumed through the optional members of PiChatContainer below.
	return chatContainer as PiChatContainer;
}

export function filterPiNoiseChildren(container: PiChatContainer, state: PiNoiseFilterState = { removedNodes: [], skipNextSpacer: false }): number {
	if (!Array.isArray(container.children)) return 0;
	const nextChildren: unknown[] = [];
	let removed = 0;
	let skipNextSpacer = state.skipNextSpacer;
	for (const child of container.children) {
		if (isPiNoiseTextComponent(child)) {
			state.removedNodes.push(child);
			removed += 1;
			skipNextSpacer = true;
			continue;
		}
		if (skipNextSpacer && isSpacerComponent(child)) {
			state.removedNodes.push(child);
			removed += 1;
			skipNextSpacer = false;
			continue;
		}
		skipNextSpacer = false;
		nextChildren.push(child);
	}
	container.children = nextChildren;
	state.skipNextSpacer = skipNextSpacer;
	return removed;
}

export function installPiNoiseFilter<T>(upstream: T, state: PiNoiseFilterState = { removedNodes: [], skipNextSpacer: false }): boolean {
	// SAFETY: FilterablePiChatContainer only adds an optional install-marker
	// symbol; member access stays guarded by the capability checks below.
	const container = getUpstreamChatContainer(upstream) as FilterablePiChatContainer | undefined;
	if (!container?.addChild || container[PI_NOISE_FILTER_INSTALLED]) return false;
	const originalAddChild = container.addChild.bind(container);
	container.addChild = (component: ForeignChatComponent): void => {
		if (isPiNoiseTextComponent(component)) {
			state.removedNodes.push(component);
			state.skipNextSpacer = true;
			return;
		}
		if (state.skipNextSpacer && isSpacerComponent(component)) {
			state.removedNodes.push(component);
			state.skipNextSpacer = false;
			return;
		}
		state.skipNextSpacer = false;
		originalAddChild(component);
	};
	container[PI_NOISE_FILTER_INSTALLED] = true;
	return true;
}

export function forceHardwareCursorVisible<T>(upstream: T): boolean {
	if (!isRecord(upstream) || !("ui" in upstream)) return false;
	const ui: unknown = upstream.ui;
	if (!isRecord(ui) || !("setShowHardwareCursor" in ui)) return false;
	// SAFETY: `setShowHardwareCursor` is an undocumented Pi ui method; presence
	// and callability are verified below before invoking it with one boolean.
	const setShowHardwareCursor = (ui as { setShowHardwareCursor?: (visible: boolean) => void }).setShowHardwareCursor;
	if (!isCallable(setShowHardwareCursor)) return false;
	setShowHardwareCursor.call(ui, true);
	return true;
}
