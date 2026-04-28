#!/usr/bin/env node
// Element 11 — DIVINE QUERY modal (cathedral-themed Pi ask/confirm).
// Per CATHEDRAL_UX_SPEC_V2.md §3.11.
// Width 60% terminal, min 50, max 80. Centered.

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

function buildDivineQuery({ cols, question, options, selectedIdx }) {
	const rows = [];
	const innerCols = cols - 4;
	const blank = () => padRight("", cols);

	// Centered title
	rows.push(blank());
	rows.push(center(`<span class="fg-accent">DIVINE QUERY</span>`, cols));
	rows.push(blank());

	// Top divider rule
	rows.push(`   <span class="fg-divider">${rep("\u2500", cols - 6)}</span>   `);
	rows.push(blank());

	// Question (wrapped)
	const questionLines = wrap(question, innerCols - 4);
	for (const line of questionLines) {
		rows.push(`   <span class="fg-fg">${line}</span>${rep(" ", cols - 3 - line.length)}`);
	}
	rows.push(blank());

	// Options
	for (let i = 0; i < options.length; i++) {
		const opt = options[i];
		const label = `${String.fromCharCode(65 + i)}) ${opt}`;
		if (i === selectedIdx) {
			// Selected row: accent bg fill
			const padInner = innerCols - label.length - 2;
			rows.push(
				`   <span class="cursor"> </span><span class="fg-fg" style="background: var(--accent); color: var(--background);">${label}${rep(" ", padInner)}</span><span class="cursor"> </span>` +
				rep(" ", cols - innerCols - 4),
			);
		} else {
			rows.push(`     <span class="fg-fg">${label}</span>${rep(" ", cols - 5 - label.length)}`);
		}
	}
	rows.push(blank());

	// Bottom divider rule
	rows.push(`   <span class="fg-divider">${rep("\u2500", cols - 6)}</span>   `);

	// Footer keybinds
	const hint = `<span class="fg-dim">\u2191\u2193  navigate    \u23ce  select    esc  cancel</span>`;
	rows.push(center(hint, cols));
	rows.push(blank());

	return rows.join("\n");
}

function wrap(text, width) {
	const words = text.split(/\s+/);
	const lines = [];
	let cur = "";
	for (const w of words) {
		if (!cur) cur = w;
		else if (cur.length + 1 + w.length <= width) cur += " " + w;
		else { lines.push(cur); cur = w; }
	}
	if (cur) lines.push(cur);
	return lines;
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
		filename: "11-divine-query-rename.html",
		title: "Bible · Element 11 · DIVINE QUERY · rename",
		label: "element 11 · DIVINE QUERY · 3 options, B selected · 80 cols",
		blurb: "cathedral-themed Pi ask/confirm dialog. flat-hybrid card on surface-lifted bg. selected option in accent fill.",
		spec: {
			question: "Should I rename `getUser` to `fetchUser` across the auth module?",
			options: [
				"Yes, rename it everywhere",
				"No, leave it as-is",
				"Use a different name",
			],
			selectedIdx: 1,
		},
	},
	{
		filename: "11-divine-query-yesno.html",
		title: "Bible · Element 11 · DIVINE QUERY · yes/no",
		label: "element 11 · DIVINE QUERY · 2 options, A selected · 80 cols",
		blurb: "minimal yes/no question with first option focused.",
		spec: {
			question: "Run the migration on production database?",
			options: ["Yes", "No"],
			selectedIdx: 0,
		},
	},
	{
		filename: "11-divine-query-many.html",
		title: "Bible · Element 11 · DIVINE QUERY · 5 options",
		label: "element 11 · DIVINE QUERY · 5 options, C selected · 80 cols",
		blurb: "longer option list. middle option focused.",
		spec: {
			question: "Which test framework should I use for the new auth module?",
			options: [
				"Vitest (fast, modern, default)",
				"Jest (most popular, slower)",
				"Node:test (zero deps)",
				"Bun:test (Bun-only, blazing fast)",
				"Skip tests for now",
			],
			selectedIdx: 2,
		},
	},
];

for (const v of variants) {
	const content = buildDivineQuery({ cols: COLS, ...v.spec });
	const rows = content.split("\n").length;
	writeFileSync(resolve(out, v.filename), htmlPage({ ...v, cols: COLS, content, rows }));
	console.log(`wrote ${v.filename}  (${COLS}\u00d7${rows})`);
}
