import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { CATHEDRAL_TOKENS } from "../../tokens.js";

export const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
export const RESET = "\u001b[0m";
export const SIDEBAR_INDENT = "  ";

function parseHex(hex: string): { r: number; g: number; b: number } {
	const normalized = hex.replace("#", "");
	return {
		r: Number.parseInt(normalized.slice(0, 2), 16),
		g: Number.parseInt(normalized.slice(2, 4), 16),
		b: Number.parseInt(normalized.slice(4, 6), 16),
	};
}

export function fgHex(hex: string): string {
	const { r, g, b } = parseHex(hex);
	return `\u001b[38;2;${r};${g};${b}m`;
}

export function bgHex(hex: string): string {
	const { r, g, b } = parseHex(hex);
	return `\u001b[48;2;${r};${g};${b}m`;
}

export function colorHex(text: string, hex: string): string {
	return `${fgHex(hex)}${text}${RESET}`;
}

export function bold(text: string): string {
	return `\u001b[1m${text}${RESET}`;
}

export function italic(text: string): string {
	return `\u001b[3m${text}${RESET}`;
}

export function dim(text: string): string {
	return `\u001b[2m${text}${RESET}`;
}

export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

export function visibleLength(text: string): number {
	return visibleWidth(text);
}

export function padAnsiToWidth(line: string, width: number): string {
	const safeWidth = Math.max(0, Math.floor(width));
	const truncated = visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, "") : line;
	const padding = Math.max(0, safeWidth - visibleWidth(truncated));
	return `${truncated}${" ".repeat(padding)}`;
}

/** Wrap a logical sidebar row in the cathedral mahogany surface background. */
export function surfaceLine(content: string, width: number): string {
	const line = padAnsiToWidth(content, width);
	return `${bgHex(CATHEDRAL_TOKENS.colors.surface)}${fgHex(CATHEDRAL_TOKENS.colors.foreground)}${line}${RESET}`;
}

/**
 * CATHEDRAL_UX_SPEC.md §4.2 section header contract:
 * `┌ LABEL ────` with the label in accent and the rule in divider.
 */
export function renderSidebarSectionHeader(label: string, width: number, indent = SIDEBAR_INDENT): string {
	const safeWidth = Math.max(1, Math.floor(width));
	const innerWidth = Math.max(1, safeWidth - visibleWidth(indent));
	const prefixWidth = 2 + label.length + 1; // "┌ " + label + " "
	const dashCount = Math.max(4, innerWidth - prefixWidth);
	return padAnsiToWidth(
		`${indent}${colorHex("┌", CATHEDRAL_TOKENS.colors.divider)} ${colorHex(label, CATHEDRAL_TOKENS.colors.accent)} ${colorHex("─".repeat(dashCount), CATHEDRAL_TOKENS.colors.divider)}`,
		safeWidth,
	);
}
