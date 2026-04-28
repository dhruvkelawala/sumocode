#!/usr/bin/env node
// Element 3 — Splash.
// Per CATHEDRAL_UX_SPEC_V2.md §3.3:
//   Renders ONLY when session has zero user messages.
//   Top bar + footer render around splash; sidebar HIDDEN (full-width splash).
//
// Layout (vertically centered):
//   - cat hero (24×14 chafa-style ASCII)
//   - SUMOCODE wordmark (letter-spaced or pixel-block, accent)
//   - quote: "perfection is achieved..." — saint-exupéry
//   - DIVINE INVOCATION input frame with rotating placeholder
//   - hint row: AWAITING DIVINE INVOCATION (left) + keybinds (right)
//   - version line at bottom (splash only): SUMOCODE V0.2.0 · CATHEDRAL · 160×45 MONOSPACE

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ansToHTMLLines } from "./lib/ansi-to-html.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(repoRoot, "docs", "ui", "bible");

// Real production cat from src/assets/sumo-face.ans (chafa-rendered from
// Gemini-generated PNG). 12 lines, 24 cols wide. Truecolor SGR codes.
const CAT_HTML_LINES = ansToHTMLLines(resolve(repoRoot, "src/assets/sumo-face.ans"));

const rep = (ch, n) => ch.repeat(n);
const visibleLen = (s) =>
	s.replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").length;
const padRight = (s, n) => {
	const need = n - visibleLen(s);
	return need > 0 ? s + rep(" ", need) : s;
};
const padLeft = (s, n) => {
	const need = n - visibleLen(s);
	return need > 0 ? rep(" ", need) + s : s;
};
const center = (s, n) => {
	const need = n - visibleLen(s);
	if (need <= 0) return s;
	const left = Math.floor(need / 2);
	const right = need - left;
	return rep(" ", left) + s + rep(" ", right);
};
const row = (h) => padRight(h, 0); // joined later

// Cat is the REAL production rendered output (truecolor chafa).
// Loaded from src/assets/sumo-face.ans via CAT_HTML_LINES above.

// ─── SUMOCODE wordmark (letter-spaced) ──────────────────────────────────
const WORDMARK = "S U M O C O D E"; // 15 chars

// ─── Quote (3 lines: 2 quote, 1 attribution) ────────────────────────────
const QUOTE_LINES = [
	`"perfection is achieved when there is`,
	`nothing left to take away."`,
	`— saint-exupéry`,
];

// ─── Rotating placeholder examples ──────────────────────────────────────
const PLACEHOLDERS = [
	`Ask anything... "Refactor the auth flow."`,
	`Ask anything... "Why does the test for X fail?"`,
	`Ask anything... "Explain this codebase architecture."`,
	`Ask anything... "Find the bug in src/foo.ts:42."`,
	`Ask anything... "Show me what changed since yesterday."`,
];

// ─── Build splash content rows for given dimensions ─────────────────────
function buildSplash({ cols, rows: totalRows, placeholderIndex = 0 }) {
	const lines = [];

	// 1. Cat hero — center horizontally. Each line is already an HTML
	// fragment with inline color spans (from chafa truecolor output).
	// Visible width is 24 cells per the source asset.
	const CAT_VISIBLE_W = 24;
	const catLeftPad = Math.max(0, Math.floor((cols - CAT_VISIBLE_W) / 2));
	const catRightPad = Math.max(0, cols - CAT_VISIBLE_W - catLeftPad);
	const catRendered = CAT_HTML_LINES.map((line) =>
		rep(" ", catLeftPad) + line + rep(" ", catRightPad),
	);

	// 2. Wordmark — center, accent
	const wordmark = center(`<span class="fg-accent">${WORDMARK}</span>`, cols);

	// 3. Quote — center, dim italic
	const quote = QUOTE_LINES.map((line) =>
		center(`<span class="fg-dim">${line}</span>`, cols),
	);

	// 4. Input frame DIVINE INVOCATION — 60 cols inner, centered if room
	const innerWidth = Math.min(60, cols - 6); // input frame width
	const placeholder = PLACEHOLDERS[placeholderIndex % PLACEHOLDERS.length];
	const truncatedPh = placeholder.length > innerWidth - 4
		? placeholder.slice(0, innerWidth - 5) + "…"
		: placeholder;
	// Frame: ┌─ DIVINE INVOCATION ────────...─────┐
	const labelText = "DIVINE INVOCATION";
	const topBorderText = `┌─ ${labelText} ${rep("─", innerWidth - 4 - labelText.length - 2)}┐`;
	const topBorderHTML = `<span class="fg-divider">┌─ </span>` +
		`<span class="fg-accent">${labelText}</span>` +
		` <span class="fg-divider">${rep("─", innerWidth - 4 - labelText.length - 2)}┐</span>`;
	const inputText = `> ${truncatedPh}`;
	const inputContentLen = 2 + truncatedPh.length + 1; // "> " + ph + cursor
	const inputPad = innerWidth - 2 - inputContentLen - 2 - 2; // borders + leading/trailing space
	const inputRowHTML = `<span class="fg-divider">│</span> ` +
		`<span class="fg-accent">&gt;</span> <span class="fg-dim">${truncatedPh}</span>` +
		`<span class="cursor"> </span>` +
		rep(" ", Math.max(1, inputPad + 2)) +
		`<span class="fg-divider">│</span>`;
	const botBorderHTML = `<span class="fg-divider">└${rep("─", innerWidth - 2)}┘</span>`;

	const inputFrameRows = [
		center(topBorderHTML, cols),
		center(inputRowHTML, cols),
		center(botBorderHTML, cols),
	];

	// 5. Hint row: left "└─ AWAITING DIVINE INVOCATION" + right "TAB · AGENTS  CTRL+/ · COMMANDS"
	// At narrow widths the left flavour doesn't fit alongside the right keybinds.
	// Drop the left flavour below 100 cols; keep right keybinds always.
	const right = `TAB · AGENTS  CTRL+/ · COMMANDS`; // 31 cells
	const rightHTML =
		`<span class="fg-dim">TAB · AGENTS  </span>` +
		`<span class="fg-accent">CTRL+/</span>` +
		`<span class="fg-dim"> · COMMANDS</span>`;
	const showLeftFlavour = cols >= 100;
	const inputFrameLeftPad = Math.floor((cols - innerWidth) / 2);
	let hintRow;
	if (showLeftFlavour) {
		const left = `└─ AWAITING DIVINE INVOCATION`; // 30 cells
		const hintLeftHTML = rep(" ", inputFrameLeftPad) + `<span class="fg-dim">${left}</span>`;
		const hintMid = cols - inputFrameLeftPad - left.length - right.length;
		hintRow = hintLeftHTML + rep(" ", Math.max(1, hintMid)) + rightHTML;
	} else {
		// portrait/narrow: just right-align keybinds
		const leadingPad = cols - right.length;
		hintRow = rep(" ", Math.max(1, leadingPad)) + rightHTML;
	}

	// 6. Version line: SUMOCODE V0.2.0 · CATHEDRAL · 160 × 45 MONOSPACE
	const versionText = `SUMOCODE V0.2.0 · CATHEDRAL · ${cols} × ${totalRows} MONOSPACE`;
	const versionRow = center(`<span class="fg-dim">${versionText}</span>`, cols);

	// ─── compose with spacing ───────────────────────────────────────────
	const out = [];
	const blank = center("", cols);

	// Top padding
	const contentRows =
		CAT_HTML_LINES.length + // 12
		2 + 1 + // wordmark
		2 + QUOTE_LINES.length + // 3
		2 + 3 + // input frame
		1 + 1 + // hint
		2 + 1; // version
	const topPad = Math.max(2, Math.floor((totalRows - contentRows) / 2));
	for (let i = 0; i < topPad; i++) out.push(blank);

	// Cat
	out.push(...catRendered);
	out.push(blank);
	out.push(blank);

	// Wordmark
	out.push(wordmark);
	out.push(blank);
	out.push(blank);

	// Quote
	out.push(...quote);
	out.push(blank);
	out.push(blank);

	// Input frame
	out.push(...inputFrameRows);
	out.push(blank);

	// Hint
	out.push(hintRow);
	out.push(blank);
	out.push(blank);

	// Version line
	out.push(versionRow);

	// Bottom padding to reach totalRows (or trim if over)
	while (out.length < totalRows) out.push(blank);
	return out.slice(0, totalRows);
}

// ─── HTML page wrapper ──────────────────────────────────────────────────
function htmlPage({ title, label, blurb, gridRows, cols }) {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="_assets/tokens.css">
<style>
  .stage-blurb { max-width: 60ch; color: var(--foreground-dim); font-size: 11px; line-height: 1.6; letter-spacing: 0.04em; padding: 0 8px; text-align: center; }
</style>
</head>
<body>
<div class="stage">
  <div class="stage-label">${label}</div>
  <div class="stage-blurb">${blurb}</div>
  <div data-render-rect class="term" style="--term-cols: ${cols}; --term-rows: ${gridRows.length};">
    <pre class="grid">${gridRows.join("\n")}</pre>
  </div>
</div>
</body>
</html>
`;
}

const variants = [
	{
		filename: "03-splash.html",
		title: "Bible · Element 3 · SPLASH (landscape)",
		label: "element 3 · splash · 160×45 landscape",
		blurb: "splash renders only when session has zero messages. cat hero (24×14 chafa render placeholder), SUMOCODE wordmark accent, quote dim italic, DIVINE INVOCATION input frame with rotating placeholder, hint row, version line at bottom.",
		cols: 160, rows: 45, placeholderIndex: 0,
	},
	{
		filename: "03-splash-portrait.html",
		title: "Bible · Element 3 · SPLASH (portrait)",
		label: "element 3 · splash · 60×100 portrait",
		blurb: "portrait variant of splash for Mac mini orientation. same content, narrower DIVINE INVOCATION frame.",
		cols: 60, rows: 100, placeholderIndex: 1,
	},
];

for (const v of variants) {
	const gridRows = buildSplash({ cols: v.cols, rows: v.rows, placeholderIndex: v.placeholderIndex });
	const path = resolve(out, v.filename);
	writeFileSync(path, htmlPage({ ...v, gridRows }));
	console.log(`wrote ${v.filename}  (${v.cols}×${gridRows.length})`);
}
