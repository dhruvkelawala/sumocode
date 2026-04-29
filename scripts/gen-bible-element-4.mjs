#!/usr/bin/env node
// Generator for Element 4 (active input frame) mockups.
// Computes exact char counts so frame borders + content align cell-perfect.

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(repoRoot, "docs", "ui", "bible");

/** Construct one row of exact `cols` width. */
function pad(s, n, ch = " ") {
	if (s.length >= n) return s.slice(0, n);
	return s + ch.repeat(n - s.length);
}
function rep(ch, n) { return ch.repeat(n); }

/** Build the input frame as 3 rows + a hint row. */
function buildElement4({ cols, typedText }) {
	// Frame top + bottom
	const topBorder = `<span class="fg-divider">┌${rep("─", cols - 2)}┐</span>`;
	const botBorder = `<span class="fg-divider">└${rep("─", cols - 2)}┘</span>`;

	// Cursor row: │ > <text><cursor><padding>│ (total cols)
	// Cells: 1 (left │) + 1 (space) + 1 (>) + 1 (space) + N (text) + 1 (cursor) + ? (pad) + 1 (right │)
	// = 4 + textLen + 1 + padLen + 1 = cols  →  padLen = cols - textLen - 6
	const textLen = typedText.length;
	const padLen = cols - textLen - 6;
	if (padLen < 0) throw new Error(`text too long for ${cols} cols`);

	const cursorRow =
		`<span class="fg-divider">│</span>` +
		` ` +
		`<span class="fg-accent">&gt;</span>` +
		` ` +
		(textLen > 0 ? `<span class="fg-fg">${typedText}</span>` : ``) +
		`<span class="cursor"> </span>` +
		rep(" ", padLen) +
		`<span class="fg-divider">│</span>`;

	// Hint row: right-aligned. "TAB · AGENTS  CTRL+/ · COMMANDS" = 31 chars.
	const hintLeft = "TAB · AGENTS";
	const hintMidGap = "  ";
	const hintMid = "CTRL+/";
	const hintRight = " · COMMANDS";
	const hintLen = hintLeft.length + hintMidGap.length + hintMid.length + hintRight.length;
	const hintPad = cols - hintLen;
	if (hintPad < 0) throw new Error(`hint too long for ${cols} cols`);

	const hintRow =
		rep(" ", hintPad) +
		`<span class="fg-dim">${hintLeft}</span>` +
		hintMidGap +
		`<span class="fg-accent">${hintMid}</span>` +
		`<span class="fg-dim">${hintRight}</span>`;

	return { topBorder, cursorRow, botBorder, hintRow };
}

function htmlPage({ title, label, cols, rows, typedText }) {
	const { topBorder, cursorRow, botBorder, hintRow } = buildElement4({ cols, typedText });
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="_assets/tokens.css">
</head>
<body>
<div class="stage">
  <div class="stage-label">${label}</div>
  <div data-render-rect class="term" style="--term-cols: ${cols}; --term-rows: ${rows};">
    <pre class="grid bg-recess">${topBorder}
${cursorRow}
${botBorder}</pre>
    <pre class="grid">${hintRow}</pre>
  </div>
</div>
</body>
</html>
`;
}

const variants = [
	{
		filename: "04-active-input-empty.html",
		title: "Bible · Element 4 · active input — empty",
		label: "element 4 · active input · empty · 160×4",
		cols: 160, rows: 4, typedText: "",
	},
	{
		filename: "04-active-input-typed.html",
		title: "Bible · Element 4 · active input — typed",
		label: "element 4 · active input · typed · 160×4",
		cols: 160, rows: 4,
		typedText: "review src/argent-x/balance.ts and tighten the return type",
	},
	{
		filename: "04-active-input-empty-portrait.html",
		title: "Bible · Element 4 · active input — empty · portrait",
		label: "element 4 · active input · empty · portrait 60×4",
		cols: 60, rows: 4, typedText: "",
	},
	{
		filename: "04-active-input-typed-portrait.html",
		title: "Bible · Element 4 · active input — typed · portrait",
		label: "element 4 · active input · typed · portrait 60×4",
		cols: 60, rows: 4,
		typedText: "review balance.ts and tighten",
	},
];

for (const v of variants) {
	const path = resolve(out, v.filename);
	writeFileSync(path, htmlPage(v));
	console.log(`wrote ${v.filename}  (${v.cols}×${v.rows})`);
}
