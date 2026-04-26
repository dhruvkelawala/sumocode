/**
 * Cathedral tab bar (DESIGN.md §4 + docs/ui/claude-design/Terminal.jsx).
 *
 * Layout:
 *   ║ ● work-20260424 ║   │ readyx-20260423   │ sumocode-20260420   │ + new
 *
 * Active tab is wrapped in burnt-orange double-line ║ ║. The state dot
 * inside takes the active state color. Inactive labels are separated by
 * single │ in muted brown. The trailing "│ + new" is also muted.
 *
 * Pi 0.70.x does not expose a session enumeration API, so today the
 * inactiveLabels list is always empty. We still render the structure so
 * the visual is correct when Pi grows that surface (or we add it via
 * #11 SumoCode-native parallel agent UX).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CATHEDRAL_TOKENS, type SumoCodeState } from "./tokens.js";

const RESET = "\u001b[0m";
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export type TabBarSnapshot = {
	activeLabel: string;
	state: SumoCodeState;
	inactiveLabels: readonly string[];
};

function visibleLength(text: string): number {
	return text.replace(ANSI_PATTERN, "").length;
}

function color(text: string, hex: string): string {
	const n = hex.replace("#", "");
	const r = Number.parseInt(n.slice(0, 2), 16);
	const g = Number.parseInt(n.slice(2, 4), 16);
	const b = Number.parseInt(n.slice(4, 6), 16);
	return `\u001b[38;2;${r};${g};${b}m${text}${RESET}`;
}

function ellipsize(text: string, max: number): string {
	if (max <= 0) return "";
	if (text.length <= max) return text;
	if (max === 1) return "…";
	return `${text.slice(0, max - 1)}…`;
}

function activeTab(snapshot: TabBarSnapshot, maxLabel: number): string {
	const label = ellipsize(snapshot.activeLabel, maxLabel);
	const dot = color("●", CATHEDRAL_TOKENS.colors.states[snapshot.state]);
	const wrap = (ch: string): string => color(ch, CATHEDRAL_TOKENS.colors.accent);
	return `${wrap("║")} ${dot} ${label} ${wrap("║")}`;
}

function inactiveTab(label: string): string {
	const sep = color("│", CATHEDRAL_TOKENS.colors.foregroundDim);
	const text = color(label, CATHEDRAL_TOKENS.colors.foregroundDim);
	return `   ${sep} ${text}`;
}

function newTab(): string {
	const sep = color("│", CATHEDRAL_TOKENS.colors.foregroundDim);
	const text = color("+ new", CATHEDRAL_TOKENS.colors.foregroundDim);
	return `   ${sep} ${text}`;
}

/**
 * Active tab visible width when wrapping a label of length `n`:
 * ║(1) + space(1) + ●(1) + space(1) + label(n) + space(1) + ║(1) = 6 + n.
 */
const ACTIVE_TAB_OVERHEAD = 6;

/**
 * Render the cathedral tab bar at the given terminal width. Always pads to
 * width with spaces so the bar renders as a complete row.
 */
export function renderTabBar(snapshot: TabBarSnapshot, width: number): string {
	const newCap = newTab();
	const reservedForNew = visibleLength(newCap);
	let remaining = Math.max(0, width - reservedForNew);

	const maxActiveLabel = Math.max(1, remaining - ACTIVE_TAB_OVERHEAD);
	const active = activeTab(snapshot, Math.min(snapshot.activeLabel.length, maxActiveLabel));
	remaining -= visibleLength(active);

	const inactives: string[] = [];
	for (const label of snapshot.inactiveLabels) {
		const candidate = inactiveTab(label);
		const visible = visibleLength(candidate);
		if (visible > remaining) break;
		inactives.push(candidate);
		remaining -= visible;
	}

	const composed = `${active}${inactives.join("")}${newCap}`;
	const composedLen = visibleLength(composed);
	if (composedLen >= width) return composed;
	return `${composed}${" ".repeat(width - composedLen)}`;
}

/**
 * Pi-wiring glue. Mounts the cathedral tab bar as the session header
 * (above the chat area). Re-renders whenever state changes.
 */
export function installTabBar(pi: ExtensionAPI): void {
	let state: SumoCodeState = "idle";
	let render: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setHeader((tui, _theme) => {
			render = () => tui.requestRender();

			return {
				dispose(): void {
					render = undefined;
				},
				invalidate(): void {},
				render(width: number): string[] {
					const sessionId = ctx.sessionManager.getSessionId();
					const sessionName = ctx.sessionManager.getSessionName();
					const activeLabel = sessionName ?? sessionId ?? "session";

					return [
						renderTabBar(
							{
								activeLabel,
								state,
								inactiveLabels: [],
							},
							width,
						),
					];
				},
			};
		});
	});

	pi.on("before_agent_start", () => {
		state = "thinking";
		render?.();
	});
	pi.on("agent_start", () => {
		state = "thinking";
		render?.();
	});
	pi.on("tool_call", () => {
		state = "tool";
		render?.();
	});
	pi.on("tool_result", () => {
		state = "thinking";
		render?.();
	});
	pi.on("agent_end", () => {
		state = "idle";
		render?.();
	});
}
