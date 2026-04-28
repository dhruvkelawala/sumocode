#!/usr/bin/env node
// Element 5 — Footer + bottom version line.
// Per CATHEDRAL_UX_SPEC_V2.md §3.5:
//   Left:  ● <STATE> · <model> · <thinking>
//   Right: <project> (branch) · <ctx>/<window> · $<cost>
// 5 state variants, plus narrow + splash-with-version.

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(repoRoot, "docs", "ui", "bible");

function rep(ch, n) { return ch.repeat(n); }

/** State label table (cathedral) + dot color class */
const STATES = {
	idle:      { label: "READY",        dotClass: "fg-idle"    },
	thinking:  { label: "MEDITATING",   dotClass: "fg-think"   },
	tool:      { label: "ILLUMINATING", dotClass: "fg-tool"    },
	approval:  { label: "DEFERRING",    dotClass: "fg-approve" },
	learning:  { label: "INSCRIBING",   dotClass: "fg-learn"   },
};

/** Build a footer row. Returns inner HTML for one <pre.grid> row. */
function buildFooter({ cols, state, model, thinking, project, branch, ctxTokens, ctxWindow, cost, sidebarHidden }) {
	const { label, dotClass } = STATES[state];

	// Left zone construction (visible content + length)
	// ● <LABEL> · <model> · <thinking>
	const dot = "●";
	const left = ` ${label} · ${model} · ${thinking}`; // leading space after dot
	const leftLen = 1 + left.length; // dot + content
	const leftHTML =
		`<span class="${dotClass}">${dot}</span>` +
		`<span class="fg-fg"> ${label}</span>` +
		`<span class="fg-dim"> · </span>` +
		`<span class="fg-fg">${model}</span>` +
		`<span class="fg-dim"> · </span>` +
		`<span class="fg-fg">${thinking}</span>`;

	// Right zone: progressively collapse based on width
	// 1: project (branch) · ctx/win · $cost
	// 2: (branch) · ctx/win · $cost           [< 110]
	// 3: ctx/win · $cost                       [< 90]
	// 4: ctx/win                               [< 70]
	// 5: <empty>                               [< 50]
	let rightTokens = [];
	if (cols >= 50)  rightTokens.push(`${ctxTokens}/${ctxWindow}`);
	if (cols >= 70)  rightTokens.push(`$${cost}`);
	if (cols >= 90)  rightTokens.unshift(`(${branch})`);
	if (cols >= 110) rightTokens.unshift(project);

	const rightStr = rightTokens.join(" · ");
	const rightLen = rightStr.length;

	const padLen = cols - leftLen - rightLen;
	if (padLen < 0) {
		throw new Error(`footer too long for ${cols} cols: leftLen=${leftLen} rightLen=${rightLen}`);
	}

	// Construct right zone HTML
	let rightHTML = "";
	if (rightStr) {
		// Color tokens: project + (branch) in fg-fg, separators in fg-dim,
		// ctx/win in fg-fg, $cost in fg-fg
		// Just split on " · " and color each piece
		const pieces = rightStr.split(" · ");
		rightHTML = pieces
			.map((piece, i) => {
				const sep = i > 0 ? `<span class="fg-dim"> · </span>` : "";
				return `${sep}<span class="fg-fg">${piece}</span>`;
			})
			.join("");
	}

	return leftHTML + rep(" ", padLen) + rightHTML;
}

/** Build splash version line (centered, dim) */
function buildVersionLine(cols, version, themeName, dims) {
	const text = `SUMOCODE V${version} · ${themeName.toUpperCase()} · ${dims} MONOSPACE`;
	const padBefore = Math.floor((cols - text.length) / 2);
	const padAfter = cols - text.length - padBefore;
	return rep(" ", padBefore) + `<span class="fg-dim">${text}</span>` + rep(" ", padAfter);
}

function htmlPage({ title, label, cols, rows, footerSpec, withVersion = null }) {
	const footerRow = buildFooter({ cols, ...footerSpec });
	const versionRow = withVersion ? buildVersionLine(cols, withVersion.version, withVersion.theme, withVersion.dims) : null;

	const versionHTML = versionRow ? `\n    <pre class="grid">${versionRow}</pre>` : "";

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
    <pre class="grid">${footerRow}</pre>${versionHTML}
  </div>
</div>
</body>
</html>
`;
}

const standardSpec = {
	model: "claude-opus-4-7",
	thinking: "xhigh",
	project: "sumo-deus",
	branch: "main",
	ctxTokens: "42k",
	ctxWindow: "200k",
	cost: "0.42",
};

const variants = [
	// 5 state variants in landscape (160 cols)
	{
		filename: "05-footer-idle.html",
		title: "Bible · Element 5 · footer · READY",
		label: "element 5 · footer · READY (idle) · 160×1",
		cols: 160, rows: 1,
		footerSpec: { state: "idle", ...standardSpec, model: "gpt-5.5", thinking: "medium" },
	},
	{
		filename: "05-footer-thinking.html",
		title: "Bible · Element 5 · footer · MEDITATING",
		label: "element 5 · footer · MEDITATING (thinking) · 160×1",
		cols: 160, rows: 1,
		footerSpec: { state: "thinking", ...standardSpec },
	},
	{
		filename: "05-footer-tool.html",
		title: "Bible · Element 5 · footer · ILLUMINATING",
		label: "element 5 · footer · ILLUMINATING (tool) · 160×1",
		cols: 160, rows: 1,
		footerSpec: { state: "tool", ...standardSpec },
	},
	{
		filename: "05-footer-approval.html",
		title: "Bible · Element 5 · footer · DEFERRING",
		label: "element 5 · footer · DEFERRING (approval) · 160×1",
		cols: 160, rows: 1,
		footerSpec: { state: "approval", ...standardSpec },
	},
	{
		filename: "05-footer-learning.html",
		title: "Bible · Element 5 · footer · INSCRIBING",
		label: "element 5 · footer · INSCRIBING (learning) · 160×1",
		cols: 160, rows: 1,
		footerSpec: { state: "learning", ...standardSpec },
	},

	// Narrow / portrait variant (60 cols → drops project, branch, $cost)
	{
		filename: "05-footer-portrait.html",
		title: "Bible · Element 5 · footer · narrow",
		label: "element 5 · footer · READY · narrow 60×1",
		cols: 60, rows: 1,
		footerSpec: { state: "idle", ...standardSpec, model: "gpt-5.5", thinking: "medium" },
	},

	// Splash variant — footer + version line below (visible only on splash)
	{
		filename: "05-footer-with-version.html",
		title: "Bible · Element 5 · footer + splash version line",
		label: "element 5 · footer + splash version line · 160×2",
		cols: 160, rows: 2,
		footerSpec: { state: "idle", ...standardSpec, model: "gpt-5.5", thinking: "medium" },
		withVersion: { version: "0.2.0", theme: "cathedral", dims: "160 × 45" },
	},
];

for (const v of variants) {
	const path = resolve(out, v.filename);
	writeFileSync(path, htmlPage(v));
	console.log(`wrote ${v.filename}  (${v.cols}×${v.rows})`);
}
