import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { activeThemeColors } from "../../themes/index.js";
import { fgHex, RESET } from "../cathedral/ansi.js";

const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";
const STRIKE = "\x1b[9m";

function wrap(text: string, hex: string, sgr = ""): string {
	return `${sgr}${fgHex(hex)}${text}${RESET}`;
}

export function cathedralMarkdownTheme(): MarkdownTheme {
	const c = activeThemeColors();
	return {
		heading: (text) => wrap(text, c.accent, BOLD),
		link: (text) => wrap(text, c.accent),
		linkUrl: (text) => wrap(text, c.foregroundDim),
		code: (text) => wrap(text, c.accent),
		codeBlock: (text) => wrap(text, c.foregroundDim),
		codeBlockBorder: (text) => wrap(text, c.divider),
		quote: (text) => wrap(text, c.foregroundDim, ITALIC),
		quoteBorder: (text) => wrap(text, c.divider),
		hr: (text) => wrap(text, c.divider),
		listBullet: (text) => wrap(text, c.accent),
		bold: (text) => `${BOLD}${text}${RESET}`,
		italic: (text) => `${ITALIC}${text}${RESET}`,
		strikethrough: (text) => `${STRIKE}${text}${RESET}`,
		underline: (text) => `${UNDERLINE}${text}${RESET}`,
		codeBlockIndent: "  ",
	};
}
