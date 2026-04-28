#!/usr/bin/env node
// Element 8 — Command palette (Ctrl+/).
// 6 modes: SESSION / MODEL / THINKING / MEMORY / THEME / SETTINGS.
// Drill-down on Enter. Selected row in accent fill.

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(repoRoot, "docs", "ui", "bible");

const rep = (ch, n) => ch.repeat(n);
const visibleLen = (s) =>
	s.replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").length;
const padRight = (s, n) => {
	const need = n - visibleLen(s);
	return need > 0 ? s + rep(" ", need) : s;
};
const center = (s, n) => {
	const need = n - visibleLen(s);
	if (need <= 0) return s;
	const left = Math.floor(need / 2);
	const right = need - left;
	return rep(" ", left) + s + rep(" ", right);
};

const MODES = [
	{ key: "SESSION",  arrow: "▶", value: "CURRENT: auth-flow-refactor" },
	{ key: "MODEL",    arrow: "▶", value: "CURRENT: claude-opus-4-7" },
	{ key: "THINKING", arrow: "▶", value: "CURRENT: xhigh" },
	{ key: "MEMORY",   arrow: "▶", value: "55 FACTS" },
	{ key: "THEME",    arrow: "▶", value: "CURRENT: cathedral" },
	{ key: "SETTINGS", arrow: "",  value: "" },
];

function buildPalette({ cols, search, selectedIdx }) {
	const rows = [];
	const blank = () => padRight("", cols);

	rows.push(blank());
	rows.push(center(`<span class="fg-accent">COMMAND PALETTE</span>`, cols));
	rows.push(blank());
	rows.push(`   <span class="fg-divider">${rep("\u2500", cols - 6)}</span>   `);
	rows.push(blank());

	// Search input
	const searchInner = cols - 10;
	const searchText = search || "search\u2026";
	const searchClass = search ? "fg-fg" : "fg-dim";
	rows.push(
		`   <span class="fg-divider">\u2502</span> <span class="${searchClass}">${searchText}</span>${rep(" ", searchInner - searchText.length)}<span class="fg-divider">\u2502</span>   `,
	);
	rows.push(blank());

	// Mode rows
	for (let i = 0; i < MODES.length; i++) {
		const mode = MODES[i];
		const focused = i === selectedIdx;
		const labelPad = 12; // pad mode label to col 12
		const padAfterLabel = labelPad - mode.key.length;
		const valuePart = mode.value
			? `<span class="fg-dim">${mode.arrow} ${mode.value}</span>`
			: "";
		const valueLen = mode.value ? mode.arrow.length + 1 + mode.value.length : 0;

		const innerCols = cols - 8;
		const padEnd = innerCols - mode.key.length - padAfterLabel - valueLen;

		if (focused) {
			rows.push(
				`   <span class="cursor"> </span><span class="fg-fg" style="background: var(--accent); color: var(--background);">  ${mode.key}${rep(" ", padAfterLabel)}${mode.arrow ? mode.arrow + " " + mode.value : ""}${rep(" ", Math.max(0, padEnd - 2))}</span><span class="cursor"> </span>` +
				rep(" ", cols - innerCols - 4),
			);
		} else {
			rows.push(
				`     <span class="fg-fg">${mode.key}</span>${rep(" ", padAfterLabel)}${valuePart}${rep(" ", Math.max(0, padEnd - 2))}     `,
			);
		}
	}

	rows.push(blank());
	rows.push(`   <span class="fg-divider">${rep("\u2500", cols - 6)}</span>   `);

	const hint = `<span class="fg-dim">\u2191\u2193 navigate    \u23ce  select    esc  close</span>`;
	rows.push(center(hint, cols));
	rows.push(blank());

	return rows.join("\n");
}

function htmlPage({ title, label, blurb, cols, content, rows }) {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="_assets/tokens.css">
<style>
  .stage-blurb { max-width: ${cols}ch; color: var(--foreground-dim); font-size: 11px; line-height: 1.6; padding: 0 8px; text-align: center; }
</style>
</head>
<body>
<div class="stage">
  <div class="stage-label">${label}</div>
  <div class="stage-blurb">${blurb}</div>
  <div data-render-rect class="term" style="--term-cols: ${cols}; --term-rows: ${rows};">
    <pre class="grid" style="background: var(--surface-lifted)">${content}</pre>
  </div>
</div>
</body>
</html>
`;
}

const COLS = 80;

const variants = [
	{
		filename: "08-palette-default.html",
		title: "Bible · Element 8 · Command palette · MODEL focused",
		label: "element 8 · command palette · default open · 80 cols",
		blurb: "Ctrl+/ palette. 6 mode rows. MODEL focused (most common second-level action). search input above.",
		spec: { search: "", selectedIdx: 1 },
	},
	{
		filename: "08-palette-search.html",
		title: "Bible · Element 8 · Command palette · search filter",
		label: "element 8 · command palette · with search filter · 80 cols",
		blurb: "user typed 'mem' — only MEMORY matches. selected via fuzzy filter.",
		spec: { search: "mem", selectedIdx: 3 },
	},
	{
		filename: "08-palette-settings.html",
		title: "Bible · Element 8 · Command palette · SETTINGS focused",
		label: "element 8 · command palette · SETTINGS focused · 80 cols",
		blurb: "last mode focused. demonstrates row without value/arrow.",
		spec: { search: "", selectedIdx: 5 },
	},
];

for (const v of variants) {
	const content = buildPalette({ cols: COLS, ...v.spec });
	const rows = content.split("\n").length;
	writeFileSync(resolve(out, v.filename), htmlPage({ ...v, cols: COLS, content, rows }));
	console.log(`wrote ${v.filename}  (${COLS}\u00d7${rows})`);
}
