#!/usr/bin/env node
// Element 7 — Memory editor (`/sumo:memory edit` modal).
// Per CATHEDRAL_UX_SPEC_V2.md §3.7. Read-only browser + inline edit (e/d).
// 6 panels: IDENTITY / PREFERENCES / WORKFLOW / PROJECTS / SYSTEM / GENERAL.

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

function buildPanel(title, items, panelWidth) {
	const innerWidth = panelWidth - 2;
	const titleLen = title.length;
	const dashes = innerWidth - titleLen - 2;
	const top = `<span class="fg-divider">\u256d\u2500 </span><span class="fg-accent">${title}</span><span class="fg-divider"> ${rep("\u2500", dashes)}\u256e</span>`;
	const bot = `<span class="fg-divider">\u2570${rep("\u2500", innerWidth)}\u256f</span>`;
	const rows = [top];
	for (const item of items) {
		const truncated = item.length > innerWidth - 2 ? item.slice(0, innerWidth - 3) + "\u2026" : item;
		rows.push(`<span class="fg-divider">\u2502</span> <span class="fg-fg">${truncated}</span>${rep(" ", innerWidth - 1 - truncated.length)}<span class="fg-divider">\u2502</span>`);
	}
	rows.push(bot);
	return rows;
}

function buildMemoryEditor({ cols, search, selectedFact, totalFacts }) {
	const rows = [];
	const blank = () => padRight("", cols);

	rows.push(blank());
	rows.push(center(`<span class="fg-accent">SUMOCODE MEMORY</span>`, cols));
	rows.push(blank());
	rows.push(`   <span class="fg-divider">${rep("\u2500", cols - 6)}</span>   `);
	rows.push(blank());

	// Search input + facts count right-aligned
	const searchInner = cols - 24;
	const searchText = search || "search\u2026";
	const searchClass = search ? "fg-fg" : "fg-dim";
	const factsCount = `<span class="fg-dim">${totalFacts} facts</span>`;
	const factsLen = visibleLen(factsCount);
	rows.push(
		`   <span class="fg-divider">\u2502</span> <span class="${searchClass}">${searchText}</span>${rep(" ", searchInner - searchText.length)}<span class="fg-divider">\u2502</span>   ${factsCount}${rep(" ", cols - 12 - searchInner - factsLen)}`,
	);
	rows.push(blank());

	// 2-column panel grid
	const panelWidth = Math.floor((cols - 8) / 2); // gap of 2 between panels
	const panels = [
		buildPanel("IDENTITY", ["Dhruv \u00b7 Senior FE \u00b7 Argent", "London / BST"], panelWidth),
		buildPanel("PREFERENCES", ["prefers TypeScript strict", "pnpm not npm"], panelWidth),
		buildPanel("WORKFLOW", ["TDD by default", "visual approval before done"], panelWidth),
		buildPanel("PROJECTS", ["sumocode/cathedral parity", "openclaw ACPX integration"], panelWidth),
		buildPanel("SYSTEM", ["cmux runtime, libghostty", "mac mini portrait", "macbook landscape"], panelWidth),
		// GENERAL hidden if empty
	];

	// Render in pairs (left/right)
	for (let i = 0; i < panels.length; i += 2) {
		const left = panels[i];
		const right = panels[i + 1];
		const maxRows = Math.max(left.length, right ? right.length : 0);
		for (let r = 0; r < maxRows; r++) {
			const lr = left[r] || rep(" ", panelWidth);
			const rr = right ? (right[r] || rep(" ", panelWidth)) : "";
			rows.push(padRight(`   ${lr}  ${rr}`, cols));
		}
		rows.push(blank());
	}

	rows.push(`   <span class="fg-divider">${rep("\u2500", cols - 6)}</span>   `);
	const hint = `<span class="fg-dim">\u2191\u2193 navigate   /  search   e  edit   d  delete   esc  close</span>`;
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

const COLS = 100;
const variants = [
	{
		filename: "07-memory-editor.html",
		title: "Bible · Element 7 · Memory editor",
		label: "element 7 · /sumo:memory edit · 100 cols",
		blurb: "6-panel grid (2 across). search input + facts count. inline e/d edit hints in footer.",
		spec: { search: "", totalFacts: 48 },
	},
	{
		filename: "07-memory-editor-search.html",
		title: "Bible · Element 7 · Memory editor · search",
		label: "element 7 · memory editor with active search · 100 cols",
		blurb: "user typed 'typescript' — would filter rows in real implementation.",
		spec: { search: "typescript", totalFacts: 48 },
	},
];

for (const v of variants) {
	const content = buildMemoryEditor({ cols: COLS, ...v.spec });
	const rows = content.split("\n").length;
	writeFileSync(resolve(out, v.filename), htmlPage({ ...v, cols: COLS, content, rows }));
	console.log(`wrote ${v.filename}  (${COLS}\u00d7${rows})`);
}
