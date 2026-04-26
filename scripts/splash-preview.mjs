#!/usr/bin/env node
// Cathedral splash preview harness — renders one of four wordmark variants
// onto a faux Pi viewport so vhs can screenshot each.
//
// Usage:
//   node scripts/splash-preview.mjs <variant: a | b | c | d>
//
// Each variant shares the surrounding structure (tab bar at top, faux input
// + footer at bottom) and only swaps the centered wordmark.

import process from "node:process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RESET = "\u001b[0m";
const DIM = "\u001b[2m";

function fg(hex) {
	const n = hex.replace("#", "");
	const r = parseInt(n.slice(0, 2), 16);
	const g = parseInt(n.slice(2, 4), 16);
	const b = parseInt(n.slice(4, 6), 16);
	return `\u001b[38;2;${r};${g};${b}m`;
}

const ACCENT = fg("#D97706");
const VELLUM = fg("#F5E6C8");
const MUTED = fg("#8B7A63");
const DIVIDER = fg("#3A2F25");
const SAGE = fg("#7FB069");

const TERMINAL_COLS = 140;
const TERMINAL_ROWS = 44;

function visibleLength(str) {
	return str.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function center(str, width = TERMINAL_COLS) {
	const len = visibleLength(str);
	if (len >= width) return str;
	const pad = Math.floor((width - len) / 2);
	return `${" ".repeat(pad)}${str}`;
}

function tabBar() {
	const left = `${ACCENT}║${RESET} ${SAGE}●${RESET} ${VELLUM}work-20260424${RESET} ${ACCENT}║${RESET}`;
	const sep = `   ${MUTED}│ + new${RESET}`;
	const line = `${left}${sep}`;
	const pad = " ".repeat(Math.max(0, TERMINAL_COLS - visibleLength(line)));
	return `${line}${pad}`;
}

function footerLine() {
	const sep = `${DIVIDER} · ${RESET}`;
	const path = `${VELLUM}sumocode (main)${RESET}`;
	const tokens = `${MUTED}↑0 ↓0${RESET}`;
	const cost = `${MUTED}$0.00${RESET}`;
	const ctx = `${MUTED}0%/1.0M${RESET}`;
	const dot = `${SAGE}●${RESET}`;
	const ready = `${VELLUM}ready${RESET}`;
	const model = `${MUTED}claude-opus-4-7${RESET}`;
	return `${path}${sep}${tokens}${sep}${cost}${sep}${ctx}${sep}${dot} ${ready}${sep}${model}`;
}

function inputBox() {
	const innerWidth = 80;
	const cursor = `${ACCENT}█${RESET}`;
	const placeholder = `${MUTED}Ask anything... "Refactor the auth flow."${RESET}`;
	const top = `${DIVIDER}┌${"─".repeat(innerWidth)}┐${RESET}`;
	const mid = `${DIVIDER}│${RESET} ${cursor} ${placeholder}${" ".repeat(Math.max(0, innerWidth - 4 - visibleLength(placeholder)))} ${DIVIDER}│${RESET}`;
	const bot = `${DIVIDER}└${"─".repeat(innerWidth)}┘${RESET}`;
	return [top, mid, bot];
}

function inputHints() {
	return `${MUTED}tab · agents    ctrl+p · commands${RESET}`;
}

function bastetFigureV1() {
	// V1 — tall pointed ears + long slim body, kohl-marked eyes, ankh chest.
	return [
		`${VELLUM}    ╱╲  ╱╲    ${RESET}`,
		`${VELLUM}   ╱ ╲╱ ╲   ${RESET}`,
		`${VELLUM}  ╱   ╳   ╲  ${RESET}`,
		`${VELLUM} ╱ ${ACCENT}●${VELLUM} ┃ ${ACCENT}●${VELLUM} ╲ ${RESET}`,
		`${VELLUM} ┃   ${ACCENT}▽${VELLUM}   ┃ ${RESET}`,
		`${VELLUM}  ╲   ┃   ╱  ${RESET}`,
		`${VELLUM}    ┃   ┃    ${RESET}`,
		`${VELLUM}   ╱ ${ACCENT}☥${VELLUM} ╲   ${RESET}`,
		`${VELLUM}  ╱     ╲  ${RESET}`,
		`${VELLUM}  ╰───────╯  ${RESET}`,
	];
}

function bastetFigureV2() {
	// V2 — pixel-art block style, regal upright cat with bolt sigil.
	return [
		`${VELLUM} ██    ██ ${RESET}`,
		`${VELLUM} ████████ ${RESET}`,
		`${VELLUM}██${ACCENT}●${VELLUM}██${ACCENT}●${VELLUM}██${RESET}`,
		`${VELLUM}███${ACCENT}▽${VELLUM}███${RESET}`,
		`${VELLUM} ████████ ${RESET}`,
		`${VELLUM}  ██████  ${RESET}`,
		`${VELLUM}  █${ACCENT}☥${VELLUM} █${ACCENT}☥${VELLUM}█  ${RESET}`,
		`${VELLUM}  ██████  ${RESET}`,
		`${VELLUM} ██    ██ ${RESET}`,
	];
}

function bastetChafa(file) {
	const path = resolve(REPO_ROOT, "docs", "visual", file);
	const raw = readFileSync(path, "utf8").replace(/\r?\n$/, "");
	return raw.split("\n");
}

function bastetFigureChafa20() {
	return bastetChafa("bastet-20x15.ans");
}

function bastetFigureChafa24() {
	return bastetChafa("bastet-24x18.ans");
}

function bastetFigureChafa32() {
	return bastetChafa("bastet-32x24.ans");
}

function bastetFigureFace(size) {
	return bastetChafa(`face-${size}.ans`);
}

function bastetFigureV3() {
	// V3 — minimal line silhouette, very stylized hieroglyph profile.
	return [
		`${ACCENT} │╲ ╱│ ${RESET}`,
		`${ACCENT} │  ╲│ ${RESET}`,
		`${VELLUM}┌─┴───┐ ${RESET}`,
		`${VELLUM}│ ${ACCENT}●${VELLUM} ${ACCENT}●${VELLUM} │ ${RESET}`,
		`${VELLUM}│  ${ACCENT}▽${VELLUM}  │ ${RESET}`,
		`${VELLUM}└──┬──┘ ${RESET}`,
		`${VELLUM}   │    ${RESET}`,
		`${VELLUM}  ┌┴┐   ${RESET}`,
		`${VELLUM}  │${ACCENT}☥${VELLUM}│   ${RESET}`,
		`${VELLUM}  └─┘   ${RESET}`,
	];
}

function bastetFigure(variant) {
	switch (variant) {
		case "v1":
			return bastetFigureV1();
		case "v2":
			return bastetFigureV2();
		case "v3":
			return bastetFigureV3();
		case "chafa20":
			return bastetFigureChafa20();
		case "chafa24":
			return bastetFigureChafa24();
		case "chafa32":
			return bastetFigureChafa32();
		case "face16":
			return bastetFigureFace("16x10");
		case "face20":
			return bastetFigureFace("20x12");
		case "face24":
			return bastetFigureFace("24x14");
		case "face28":
			return bastetFigureFace("28x16");
		case "face32":
			return bastetFigureFace("32x18");
		default:
			return [];
	}
}

function wordmarkA() {
	// Single-line uppercase letterspaced.
	return [`${ACCENT}S  U  M  O  C  O  D  E${RESET}`];
}

function wordmarkB() {
	// Cartouche frame around the letterspaced wordmark.
	const inner = "S  U  M  O  C  O  D  E";
	const frameWidth = inner.length + 4;
	const top = `${ACCENT}┌${"─".repeat(frameWidth)}┐${RESET}`;
	const mid = `${ACCENT}│${RESET}  ${ACCENT}${inner}${RESET}  ${ACCENT}│${RESET}`;
	const bot = `${ACCENT}└${"─".repeat(frameWidth)}┘${RESET}`;
	return [top, mid, bot];
}

function wordmarkC() {
	// Block-letter ASCII art. Each glyph is 6 cols wide + 1 col gap so the
	// monospace grid is honest: S U M O C O D E.
	const glyphs = {
		S: ["█████ ", "█     ", "█████ ", "    █ ", "█████ "],
		U: ["█   █ ", "█   █ ", "█   █ ", "█   █ ", "█████ "],
		M: ["█   █ ", "██ ██ ", "█ █ █ ", "█   █ ", "█   █ "],
		O: ["█████ ", "█   █ ", "█   █ ", "█   █ ", "█████ "],
		C: ["█████ ", "█     ", "█     ", "█     ", "█████ "],
		D: ["████  ", "█   █ ", "█   █ ", "█   █ ", "████  "],
		E: ["█████ ", "█     ", "████  ", "█     ", "█████ "],
	};
	const letters = "SUMOCODE".split("");
	const rows = Array.from({ length: 5 }, (_, i) =>
		letters.map((ch) => glyphs[ch][i] ?? "      ").join(""),
	);
	return rows.map((line) => `${ACCENT}${line}${RESET}`);
}

function wordmarkD() {
	// Hieratic glyph — abstract cat-with-bolt sigil. No SUMOCODE text.
	return [
		`${ACCENT}     ▄▀▔▔▔▀▄     ${RESET}`,
		`${ACCENT}    ▏  ◆ ◆  ▕    ${RESET}`,
		`${ACCENT}     ╲  ϟ  ╱     ${RESET}`,
		`${ACCENT}      ▔▔▔▔▔      ${RESET}`,
		`${ACCENT}        ☥        ${RESET}`,
	];
}

function quoteLines() {
	return [
		`${DIM}${MUTED}"perfection is achieved when there is nothing left to take away."${RESET}`,
		`${DIM}${MUTED}                                              — saint-exupéry${RESET}`,
	];
}

function buildVariant(variant) {
	const wordmark = {
		a: wordmarkA(),
		b: wordmarkB(),
		c: wordmarkC(),
		d: wordmarkD(),
	}[variant];

	if (!wordmark) {
		console.error(`unknown variant: ${variant} (expected a, b, c, d)`);
		process.exit(1);
	}

	const out = [];

	// Top: tab bar.
	out.push(tabBar());

	// Center vertically: blank rows + bastet + wordmark + quote.
	const figureChoice = process.argv[3];
	const figureLines = figureChoice ? bastetFigure(figureChoice) : [];
	const splashHeight = figureLines.length + 2 + wordmark.length + 2 + quoteLines().length;
	const inputBlock = inputBox();
	const reservedBottom = inputBlock.length + 2 + 1; // input + spacing + footer
	const availableMiddle = TERMINAL_ROWS - 1 /* tabbar */ - reservedBottom;
	const topPad = Math.max(0, Math.floor((availableMiddle - splashHeight) / 2));

	for (let i = 0; i < topPad; i++) out.push("");
	for (const line of figureLines) out.push(center(line));
	if (figureLines.length > 0) out.push("");
	out.push("");
	for (const line of wordmark) out.push(center(line));
	out.push("");
	out.push("");
	for (const line of quoteLines()) out.push(center(line));

	// Spacer down to the bottom block.
	const filled = out.length;
	const bottomTarget = TERMINAL_ROWS - reservedBottom;
	for (let i = filled; i < bottomTarget; i++) out.push("");

	// Centered input block.
	for (const line of inputBlock) out.push(center(line, TERMINAL_COLS));
	out.push(center(inputHints(), TERMINAL_COLS));

	// Footer pinned to last row.
	const fillLeft = TERMINAL_ROWS - out.length - 1;
	for (let i = 0; i < fillLeft; i++) out.push("");
	out.push(center(footerLine(), TERMINAL_COLS));

	return out;
}

const variant = (process.argv[2] ?? "a").toLowerCase();
const lines = buildVariant(variant);
process.stdout.write(`${lines.join("\n")}\n`);
