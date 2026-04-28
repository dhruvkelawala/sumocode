#!/usr/bin/env node
// Element 7 — Memory editor (`/sumo:memory edit` modal).
// Scriptorium direction: manuscript chrome + panel ledger of facts.
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

function buildPanel(title, items, panelWidth, selected = false) {
	const innerWidth = panelWidth - 2;
	const titleText = ` ${title} `;
	const side = Math.max(1, Math.floor((innerWidth - titleText.length) / 2));
	const remainder = innerWidth - titleText.length - side;
	const top =
		`<span class="fg-divider">╭${rep("─", side)}</span>` +
		`<span class="fg-accent">${titleText}</span>` +
		`<span class="fg-divider">${rep("─", Math.max(1, remainder))}╮</span>`;
	const bot = `<span class="fg-divider">╰${rep("─", innerWidth)}╯</span>`;
	const rows = [top];
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const isSelectedFact = selected && i === 0;
		const marker = isSelectedFact
			? `<span class="fg-accent">❈</span>`
			: `<span class="fg-divider">·</span>`;
		const textClass = isSelectedFact ? "fg-fg" : "fg-fg";
		const maxText = innerWidth - 5;
		const truncated = item.length > maxText ? item.slice(0, maxText - 1) + "…" : item;
		const content = `${marker} <span class="${textClass}">${truncated}</span>`;
		rows.push(`<span class="fg-divider">│</span> ${content}${rep(" ", innerWidth - 1 - visibleLen(content))}<span class="fg-divider">│</span>`);
	}
	rows.push(bot);
	return rows;
}

function buildMemoryEditor({ cols, search, selectedPanel, totalFacts }) {
	const rows = [];
	const blank = () => padRight("", cols);
	const halfRule = rep("─", 30);

	rows.push(blank());
	rows.push(center(`<span class="fg-accent">✾</span>  <span class="fg-accent">MEMORY SCRIPTORIUM</span>  <span class="fg-accent">✾</span>`, cols));
	rows.push(blank());
	rows.push(center(`<span class="fg-divider">${halfRule}</span>  <span class="fg-divider">·</span>  <span class="fg-divider">${halfRule}</span>`, cols));
	rows.push(blank());

	// Search as a manuscript reading prompt + facts count right aligned.
	const prompt = search || "search remembered facts…";
	const searchClass = search ? "fg-fg" : "fg-dim";
	const left = `   <span class="fg-accent">❯</span>  <span class="cursor"> </span><span class="${searchClass}">${prompt}</span>`;
	const right = `<span class="fg-dim">${totalFacts} facts</span>`;
	rows.push(padRight(`${left}${rep(" ", cols - visibleLen(left) - visibleLen(right) - 3)}${right}   `, cols));
	rows.push(blank());

	// 2-column panel grid.
	const panelWidth = Math.floor((cols - 8) / 2); // left margin 3 + gap 2 + right margin 3
	const panels = [
		{ title: "IDENTITY", items: ["Dhruv · Senior FE · Argent", "London / BST"] },
		{ title: "PREFERENCES", items: ["prefers TypeScript strict", "pnpm not npm"] },
		{ title: "WORKFLOW", items: ["TDD by default", "visual approval before done"] },
		{ title: "PROJECTS", items: ["sumocode/cathedral parity", "openclaw ACPX integration"] },
		{ title: "SYSTEM", items: ["cmux runtime, libghostty", "mac mini portrait", "macbook landscape"] },
		{ title: "GENERAL", items: ["ask open-ended questions", "commit hash must be verified"] },
	].map((p) => buildPanel(p.title, p.items, panelWidth, selectedPanel === p.title));

	for (let i = 0; i < panels.length; i += 2) {
		const leftPanel = panels[i];
		const rightPanel = panels[i + 1];
		const maxRows = Math.max(leftPanel.length, rightPanel ? rightPanel.length : 0);
		for (let r = 0; r < maxRows; r++) {
			const lr = leftPanel[r] || rep(" ", panelWidth);
			const rr = rightPanel ? (rightPanel[r] || rep(" ", panelWidth)) : "";
			rows.push(padRight(`   ${lr}  ${rr}`, cols));
		}
		rows.push(blank());
	}

	rows.push(center(`<span class="fg-divider">${halfRule}</span>  <span class="fg-divider">·</span>  <span class="fg-divider">${halfRule}</span>`, cols));
	const hint = `<span class="fg-dim">↑↓ wander    / search    e revise    d forget    ⎋ retreat</span>`;
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
		title: "Bible · Element 7 · Memory Scriptorium",
		label: "element 7 · MEMORY SCRIPTORIUM · 100 cols",
		blurb: "scriptorium treatment: floral title marks, reading-prompt search, six remembered-fact panels, ❈ focused fact marker, cathedral footer verbs.",
		spec: { search: "", selectedPanel: "PREFERENCES", totalFacts: 48 },
	},
	{
		filename: "07-memory-editor-search.html",
		title: "Bible · Element 7 · Memory Scriptorium · search",
		label: "element 7 · memory search active · 100 cols",
		blurb: "active search state: user typed 'typescript'; focused fact stays marked with ❈.",
		spec: { search: "typescript", selectedPanel: "PREFERENCES", totalFacts: 48 },
	},
];

for (const v of variants) {
	const content = buildMemoryEditor({ cols: COLS, ...v.spec });
	const rows = content.split("\n").length;
	writeFileSync(resolve(out, v.filename), htmlPage({ ...v, cols: COLS, content, rows }));
	console.log(`wrote ${v.filename}  (${COLS}×${rows})`);
}
