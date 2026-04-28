const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);
const PI_NOISE_FILTER_INSTALLED = Symbol("sumo-tui.pi-noise-filter-installed");

export const PI_NOISE_TEXT_PATTERNS: readonly RegExp[] = [
	/\[Extension issues\]/i,
	/Warning:\s*Anthropic subscription auth is active/i,
	/Anthropic subscription auth is active\. Third-party harness usage/i,
];

export interface PiChatContainer {
	children?: unknown[];
	addChild?(component: unknown): void;
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

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function getTextComponentContent(component: unknown): string | undefined {
	if (typeof component !== "object" || component === null || !("text" in component)) return undefined;
	const text = (component as { text?: unknown }).text;
	return typeof text === "string" ? text : undefined;
}

function isSpacerComponent(component: unknown): boolean {
	if (typeof component !== "object" || component === null) return false;
	return component.constructor?.name === "Spacer";
}

export function shouldHidePiNoise(env: NodeJS.ProcessEnv = process.env): boolean {
	return envFlagEnabled(env.SUMO_TUI_HIDE_PI_NOISE, true);
}

export function shouldForceHardwareCursor(env: NodeJS.ProcessEnv = process.env): boolean {
	return envFlagEnabled(env.SUMO_TUI_SHOW_HARDWARE_CURSOR, true);
}

export function isPiNoiseTextComponent(component: unknown): boolean {
	const text = getTextComponentContent(component);
	if (text === undefined) return false;
	const plain = stripAnsi(text);
	return PI_NOISE_TEXT_PATTERNS.some((pattern) => pattern.test(plain));
}

export function getUpstreamChatContainer(upstream: unknown): PiChatContainer | undefined {
	if (typeof upstream !== "object" || upstream === null || !("chatContainer" in upstream)) return undefined;
	const chatContainer = (upstream as { chatContainer?: unknown }).chatContainer;
	return typeof chatContainer === "object" && chatContainer !== null ? (chatContainer as PiChatContainer) : undefined;
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

export function installPiNoiseFilter(upstream: unknown, state: PiNoiseFilterState = { removedNodes: [], skipNextSpacer: false }): boolean {
	const container = getUpstreamChatContainer(upstream) as FilterablePiChatContainer | undefined;
	if (!container?.addChild || container[PI_NOISE_FILTER_INSTALLED]) return false;
	const originalAddChild = container.addChild.bind(container);
	container.addChild = (component: unknown): void => {
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

export function forceHardwareCursorVisible(upstream: unknown): boolean {
	if (typeof upstream !== "object" || upstream === null || !("ui" in upstream)) return false;
	const ui = (upstream as { ui?: unknown }).ui;
	if (typeof ui !== "object" || ui === null || !("setShowHardwareCursor" in ui)) return false;
	const setShowHardwareCursor = (ui as { setShowHardwareCursor?: unknown }).setShowHardwareCursor;
	if (typeof setShowHardwareCursor !== "function") return false;
	setShowHardwareCursor.call(ui, true);
	return true;
}
