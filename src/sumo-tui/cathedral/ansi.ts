import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { activeThemeColors } from "../../themes/index.js";
import { lineToAnsi, span, textLine } from "../render/primitives.js";

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

function skipControlString(text: string, start: number): number {
	let index = start + 2;
	while (index < text.length && text[index] !== "\n") {
		if (text[index] === "\u0007" || text.charCodeAt(index) === 0x9c) return index + 1;
		if (text[index] === "\u001b" && text[index + 1] === "\\") return index + 2;
		index += 1;
	}
	return index;
}

function skipEscapeSequence(text: string, start: number): number {
	const next = text[start + 1];
	if (next === undefined || next === "\n") return start + 1;
	if (next === "]" || next === "_" || next === "P" || next === "X" || next === "^") {
		return skipControlString(text, start);
	}
	if (next === "[") {
		let index = start + 2;
		while (index < text.length && text[index] !== "\n") {
			const code = text.charCodeAt(index);
			if (code >= 0x40 && code <= 0x7e) return index + 1;
			index += 1;
		}
		return index;
	}
	if (next === "(" || next === ")" || next === "%" || next === "*" || next === "+" || next === "#") {
		return start + (text[start + 2] === undefined || text[start + 2] === "\n" ? 2 : 3);
	}
	return start + 2;
}

/** Remove terminal control sequences while preserving printable text and line structure. */
export function stripAnsi(text: string): string {
	let output = "";
	let index = 0;
	while (index < text.length) {
		const char = text[index]!;
		if (char === "\u001b") {
			index = skipEscapeSequence(text, index);
			continue;
		}
		const code = text.charCodeAt(index);
		if (code === 0x9b) {
			index += 1;
			while (index < text.length && text[index] !== "\n") {
				const finalCode = text.charCodeAt(index);
				index += 1;
				if (finalCode >= 0x40 && finalCode <= 0x7e) break;
			}
			continue;
		}
		if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
			index += 1;
			while (index < text.length && text[index] !== "\n") {
				if (text[index] === "\u0007" || text.charCodeAt(index) === 0x9c) {
					index += 1;
					break;
				}
				if (text[index] === "\u001b" && text[index + 1] === "\\") {
					index += 2;
					break;
				}
				index += 1;
			}
			continue;
		}
		if ((code < 0x20 || (code >= 0x7f && code <= 0x9f)) && char !== "\n" && char !== "\t") {
			index += 1;
			continue;
		}
		output += char;
		index += 1;
	}
	return output;
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
	return lineToAnsi(textLine([span(content)], {
		fg: activeThemeColors().foreground,
		bg: activeThemeColors().surface,
	}), { width });
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
		`${indent}${colorHex("┌", activeThemeColors().divider)} ${colorHex(label, activeThemeColors().accent)} ${colorHex("─".repeat(dashCount), activeThemeColors().divider)}`,
		safeWidth,
	);
}
