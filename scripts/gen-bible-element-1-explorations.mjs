#!/usr/bin/env node
// Element 1 — Sidebar DESIGN EXPLORATIONS using frontend-design skill.
// Three distinct aesthetic directions for comparison against locked baseline:
//   - V1 DENSE/TMUX     · info density first, no decoration
//   - V2 EDITORIAL      · magazine display, tracked-out masthead, hero values
//   - V3 MARGINALIA     · manuscript hand-notes, dotted-rules, intimate
//
// Same content (CONTEXT active, standard token state) in each so user can
// grade the IDEA, not the data.

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(repoRoot, "docs", "ui", "bible");
const SIDEBAR_COLS = 30;

function rep(ch, n) { return ch.repeat(n); }
function visibleLen(s) {
	return s.replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").length;
}
function padRight(line, cols) {
	const need = cols - visibleLen(line);
	return need > 0 ? line + rep(" ", need) : line;
}
function row(contentHTML) {
	return (
		`<span class="box-fill" style="background: var(--surface)">` +
		padRight(contentHTML, SIDEBAR_COLS) +
		`</span>`
	);
}
function blank() { return row(""); }

const data = {
	project: "sumo-deus",
	branch: "main",
	ctxTokens: "42k",
	ctxWindow: "200k",
	cost: "0.42",
	cumul: "3.4M",
	mcps: [
		{ name: "github",     state: "idle" },
		{ name: "stitch",     state: "ok" },
		{ name: "context7",   state: "idle" },
		{ name: "chrome-dev", state: "idle" },
	],
};

// ─────────────────────────────────────────────────────────────────────────
// V1 — DENSE / TMUX
//   Hyper-compact. Single-line where possible. No section headers. Pure
//   information density. Status-bar aesthetic, not panel aesthetic.
// ─────────────────────────────────────────────────────────────────────────
function buildDense() {
	const rows = [];
	rows.push(row(` <span class="fg-accent">REGISTRY</span> <span class="fg-dim">v1.0</span>`));
	rows.push(blank());
	// Tabs on one line
	rows.push(row(
		` <span class="fg-accent">\u25b6</span><span class="fg-fg">CTX</span>` +
		`  <span class="fg-dim">\u25a2 mem</span>`,
	));
	rows.push(blank());
	// Project + branch
	rows.push(row(
		` <span class="fg-fg">${data.project}</span><span class="fg-dim">/${data.branch}</span>`,
	));
	// Token bar inline with numbers
	const filled = 5; // 42/200 = ~21% but show 5/12
	const barLen = 10;
	rows.push(row(
		` <span class="fg-idle">[${rep("\u2588", filled)}${rep("\u2591", barLen - filled)}]</span>` +
		`<span class="fg-fg">${data.ctxTokens}/${data.ctxWindow}</span>`,
	));
	// Cost + cumul on one line
	rows.push(row(
		` <span class="fg-fg">$${data.cost}</span> <span class="fg-dim">\u00b7 cumul</span> <span class="fg-fg">${data.cumul}</span>`,
	));
	rows.push(blank());
	// MCP packed: gh\u25cf  stitch\u25cb  ctx7\u25cf  chr\u25cf
	const mcpAbbr = { github: "gh", stitch: "stitch", context7: "ctx7", "chrome-dev": "chr" };
	const dotFor = (state) => state === "ok" ? `<span class="fg-idle">\u25cb</span>` : `<span class="fg-dim">\u25cf</span>`;
	rows.push(row(
		` <span class="fg-dim">mcp</span> ` +
		data.mcps.map((m) => `<span class="fg-fg">${mcpAbbr[m.name]}</span>${dotFor(m.state)}`).join(" "),
	));
	rows.push(blank());
	// Spacer rows
	while (rows.length < 24) rows.push(blank());
	return rows;
}

// ─────────────────────────────────────────────────────────────────────────
// V2 — EDITORIAL / MAGAZINE
//   Bold tracked-out section names, heavy underline rule. Generous space.
//   Hero values displayed prominently. Magazine-card aesthetic at small scale.
// ─────────────────────────────────────────────────────────────────────────
function buildEditorial() {
	const rows = [];
	// Masthead
	rows.push(blank());
	rows.push(row(`  <span class="fg-accent">REGISTRY</span>`));
	rows.push(row(`  <span class="fg-dim">\u2014 v 1.0.0</span>`));
	rows.push(blank());
	rows.push(row(`  <span class="fg-fg">\u25c6 C\u202fO\u202fN\u202fT\u202fE\u202fX\u202fT</span>`));
	rows.push(row(`  <span class="fg-dim">\u25a2 M\u202fE\u202fM\u202fO\u202fR\u202fY</span>`));
	rows.push(blank());
	rows.push(row(`  <span class="fg-divider">${rep("\u2501", 26)}</span>`));
	rows.push(blank());
	// Hero project name
	rows.push(row(`  <span class="fg-fg">${data.project}</span>`));
	rows.push(row(`  <span class="fg-dim">on ${data.branch}</span>`));
	rows.push(blank());
	// Big token block
	rows.push(row(`  <span class="fg-dim">CONTEXT</span>`));
	const filled = 5;
	const barLen = 22;
	rows.push(row(
		`  <span class="fg-idle">${rep("\u2589", filled)}</span><span class="fg-divider">${rep("\u2591", barLen - filled)}</span>`,
	));
	rows.push(row(`  <span class="fg-fg">${data.ctxTokens}</span> <span class="fg-dim">/ ${data.ctxWindow}</span>`));
	rows.push(blank());
	rows.push(row(`  <span class="fg-dim">SESSION</span>`));
	rows.push(row(`  <span class="fg-fg">$${data.cost}</span> <span class="fg-dim">\u00b7 ${data.cumul} cumul</span>`));
	rows.push(blank());
	rows.push(row(`  <span class="fg-divider">${rep("\u2501", 26)}</span>`));
	rows.push(blank());
	rows.push(row(`  <span class="fg-dim">M\u202fC\u202fP</span>`));
	rows.push(blank());
	for (const mcp of data.mcps) {
		const dotClass = mcp.state === "ok" ? "fg-idle" : "fg-dim";
		const stateText = mcp.state;
		const pad = SIDEBAR_COLS - 4 - mcp.name.length - stateText.length - 2;
		rows.push(row(
			`  <span class="${dotClass}">\u25cf</span> <span class="fg-fg">${mcp.name}</span>` +
			rep(" ", Math.max(1, pad)) +
			`<span class="fg-dim">${stateText}</span>  `,
		));
	}
	return rows;
}

// ─────────────────────────────────────────────────────────────────────────
// V3 — MARGINALIA / MANUSCRIPT NOTES
//   Hand-scribed feel. Dotted rules between sections. Indented like
//   marginal notes. Sparing accent color. Field-label style: `key · value`.
// ─────────────────────────────────────────────────────────────────────────
function buildMarginalia() {
	const rows = [];
	const dotRule = `<span class="fg-dim">${rep("\u00b7 ", 13)}</span>`; // · · · · · · · · · · · · ·
	rows.push(blank());
	rows.push(row(`   <span class="fg-accent">REGISTRY</span>`));
	rows.push(row(`   <span class="fg-dim">v 1.0.0</span>`));
	rows.push(blank());
	rows.push(row(`   <span class="fg-accent">\u203a</span> <span class="fg-fg">context</span>`));
	rows.push(row(`     <span class="fg-dim">memory</span>`));
	rows.push(blank());
	rows.push(row(` ${dotRule}`));
	rows.push(blank());
	// Field-label style for context
	const fieldRow = (label, valueHTML) => {
		const pad = "         "; // 9-space label column (incl leading 3)
		const labelStr = `   <span class="fg-dim">${label}</span>`;
		const labelLen = visibleLen(labelStr);
		return row(labelStr + rep(" ", 9 - (labelLen - 3)) + `<span class="fg-divider">\u00b7</span> ${valueHTML}`);
	};
	rows.push(fieldRow("project", `<span class="fg-fg">${data.project}</span>`));
	rows.push(fieldRow("branch", `<span class="fg-fg">${data.branch}</span>`));
	rows.push(blank());
	rows.push(fieldRow("tokens", `<span class="fg-fg">${data.ctxTokens}</span> <span class="fg-dim">of ${data.ctxWindow}</span>`));
	const barLen = 14;
	const filled = 3;
	rows.push(row(`            <span class="fg-idle">${rep("\u25aa", filled)}</span><span class="fg-divider">${rep("\u00b7", barLen - filled)}</span>`));
	rows.push(fieldRow("cost", `<span class="fg-fg">$${data.cost}</span>`));
	rows.push(fieldRow("cumul", `<span class="fg-dim">${data.cumul}</span>`));
	rows.push(blank());
	rows.push(row(` ${dotRule}`));
	rows.push(blank());
	for (const mcp of data.mcps) {
		const dotClass = mcp.state === "ok" ? "fg-idle" : "fg-dim";
		const lbl = `mcp.${mcp.name}`;
		// truncate label to fit 30 - leading 3 - " · state" 
		const stateStr = mcp.state;
		const used = 3 + lbl.length + 3 + stateStr.length;
		const pad = SIDEBAR_COLS - used;
		rows.push(row(
			`   <span class="fg-dim">${lbl}</span>` +
			rep(" ", Math.max(1, pad)) +
			`<span class="${dotClass}">\u2014</span> <span class="fg-dim">${stateStr}</span>`,
		));
	}
	return rows;
}

// ─── HTML page wrapper ──────────────────────────────────────────────────
function htmlPage({ title, label, blurb, gridRows }) {
	const grid = gridRows.join("\n");
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
  <div data-render-rect class="term" style="--term-cols: ${SIDEBAR_COLS}; --term-rows: ${gridRows.length};">
    <pre class="grid">${grid}</pre>
  </div>
</div>
</body>
</html>
`;
}

const explorations = [
	{
		filename: "01-sidebar-v1-dense.html",
		title: "Bible \u00b7 Element 1 \u00b7 V1 DENSE / TMUX",
		label: "element 1 \u00b7 V1 DENSE/TMUX \u00b7 30 cols",
		blurb: "info-first. no section headers. inline mcp pills. status-bar density. less ceremony, more glance.",
		build: buildDense,
	},
	{
		filename: "01-sidebar-v2-editorial.html",
		title: "Bible \u00b7 Element 1 \u00b7 V2 EDITORIAL",
		label: "element 1 \u00b7 V2 EDITORIAL \u00b7 30 cols",
		blurb: "magazine display. tracked-out section names (C\u202fO\u202fN\u202fT\u202fE\u202fX\u202fT). thick \u2501\u2501\u2501 underline rules. hero values. generous whitespace.",
		build: buildEditorial,
	},
	{
		filename: "01-sidebar-v3-marginalia.html",
		title: "Bible \u00b7 Element 1 \u00b7 V3 MARGINALIA",
		label: "element 1 \u00b7 V3 MARGINALIA \u00b7 30 cols",
		blurb: "manuscript hand-notes feel. \u00b7\u00b7\u00b7\u00b7\u00b7\u00b7 dotted-rule transitions. \u203a chevron tab markers. field-label style (\u201cproject \u00b7 sumo-deus\u201d). em-dash mcp state.",
		build: buildMarginalia,
	},
];

for (const e of explorations) {
	const gridRows = e.build();
	const path = resolve(out, e.filename);
	writeFileSync(path, htmlPage({ ...e, gridRows }));
	console.log(`wrote ${e.filename}  (${SIDEBAR_COLS}\u00d7${gridRows.length})`);
}
