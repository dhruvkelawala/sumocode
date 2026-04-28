#!/usr/bin/env node
// Element 1 — Sidebar (active state only).
// Per CATHEDRAL_UX_SPEC_V2.md §3.1:
//   Width: 30 cols (down from 49)
//   Sub-tabs: CONTEXT (Ctrl+1) + MEMORY (Ctrl+2). SCRIPTOR + FILES deferred.
//   Chrome: REGISTRY header + v 1.0.0
//   Section headers: ┌ ACTIVE_CONTEXT ──── etc.
//   ❧ memory bullets, ● MCP pills with state colors
//   ALL rows have surface bg fill (uniform sidebar panel, no inter-section
//   gaps that fall through to terminal default — the bug from screenshots).
//   Hidden when terminal width < 120 cols.

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(repoRoot, "docs", "ui", "bible");

function rep(ch, n) { return ch.repeat(n); }

function visibleLen(s) {
	return s.replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").length;
}

function padRight(line, cols) {
	const need = cols - visibleLen(line);
	return need > 0 ? line + rep(" ", need) : line;
}

const SIDEBAR_COLS = 30;
const PAD = "  "; // 2-char left padding inside the sidebar panel

// ─── row helpers ────────────────────────────────────────────────────────
// Each row gets the .box-fill class so the surface bg fills the FULL line
// height (no thin gaps between rows from line-height > content height).

function row(contentHTML) {
	return (
		`<span class="box-fill" style="background: var(--surface)">` +
		padRight(contentHTML, SIDEBAR_COLS) +
		`</span>`
	);
}

function blankRow() { return row(""); }

// ─── section header: ┌ NAME ──── filling to col 30 ──────────────────────
function sectionHeader(name) {
	const inner = `${PAD}<span class="fg-divider">\u250c </span><span class="fg-accent">${name}</span><span class="fg-divider"> `;
	const visualLen = PAD.length + 2 + name.length + 1; // "  " + "┌ " + name + " "
	const dashLen = SIDEBAR_COLS - visualLen;
	return row(inner + rep("\u2500", dashLen) + `</span>`);
}

// ─── chrome: REGISTRY header + v 1.0.0 ──────────────────────────────────
function buildChrome() {
	return [
		row(`${PAD}<span class="fg-accent">REGISTRY</span>`),
		row(`${PAD}<span class="fg-dim">v 1.0.0</span>`),
		blankRow(),
	];
}

// ─── sub-tab row: ◆ active or ▢ inactive ────────────────────────────────
function subTabRow(label, active) {
	const glyph = active ? "\u25c6" : "\u25a2";
	const glyphClass = active ? "fg-accent" : "fg-dim";
	const labelClass = active ? "fg-fg" : "fg-dim";
	return row(`${PAD}<span class="${glyphClass}">${glyph}</span> <span class="${labelClass}">${label}</span>`);
}

// ─── CONTEXT sub-tab content ────────────────────────────────────────────
function buildContextContent({ project, branch, ctxTokens, ctxWindow, cumulSession, cost, mcps, overBudget }) {
	const rows = [];

	rows.push(sectionHeader("ACTIVE_CONTEXT"));

	// Project (branch) line
	rows.push(row(`${PAD}<span class="fg-fg">${project}</span>${branch ? ` <span class="fg-dim">(${branch})</span>` : ""}`));

	// Token bar [██████░░░░] tokens/window  [OVER]
	const barLen = 10; // bar width in cells (10 fits OVER badge at 30 cols)
	const filled = overBudget ? barLen : Math.max(1, Math.min(barLen, Math.round(barLen * (parseTokens(ctxTokens) / parseTokens(ctxWindow)))));
	const empty = barLen - filled;
	const barColor = overBudget ? "fg-approve" : (filled / barLen > 0.8 ? "fg-think" : "fg-idle");
	const tokenStr = `${ctxTokens}/${ctxWindow}`;
	const overTag = overBudget ? ` <span class="fg-approve">OVER</span>` : "";
	rows.push(row(
		`${PAD}<span class="${barColor}">[${rep("\u2588", filled)}${rep("\u2591", empty)}]</span>` +
		` <span class="fg-fg">${tokenStr}</span>${overTag}`,
	));

	// $cost line
	rows.push(row(`${PAD}<span class="fg-fg">$${cost}</span> <span class="fg-dim">spent</span>`));

	// Cumulative session tokens (if provided)
	if (cumulSession) {
		rows.push(row(`${PAD}<span class="fg-dim">session: ${cumulSession}</span>`));
	}

	rows.push(blankRow());

	// MCP block
	rows.push(sectionHeader("MCP"));
	for (const mcp of mcps) {
		const dotClass = { ok: "fg-idle", idle: "fg-dim", down: "fg-approve" }[mcp.state] ?? "fg-dim";
		const stateText = mcp.state === "down" ? "down" : mcp.state;
		const stateClass = mcp.state === "down" ? "fg-approve" : "fg-dim";
		// Layout: PAD + ● + sp + name + (pad) + state + RPAD
		const nameLen = mcp.name.length;
		const stateLen = stateText.length;
		const used = PAD.length + 1 + 1 + nameLen + stateLen + PAD.length;
		const middlePad = SIDEBAR_COLS - used;
		rows.push(row(
			`${PAD}<span class="${dotClass}">\u25cf</span> <span class="fg-fg">${mcp.name}</span>` +
			rep(" ", Math.max(1, middlePad)) +
			`<span class="${stateClass}">${stateText}</span>${PAD}`,
		));
	}

	return rows;
}

// ─── MEMORY sub-tab content ─────────────────────────────────────────────
function buildMemoryContent({ facts, totalCount, daemonDown, empty }) {
	const rows = [];
	rows.push(sectionHeader("ACTIVE_MEMORY"));

	if (daemonDown) {
		rows.push(row(`${PAD}<span class="fg-dim">memory unavailable</span>`));
		return rows;
	}

	if (empty || facts.length === 0) {
		rows.push(row(`${PAD}<span class="fg-dim">no memory match</span>`));
		return rows;
	}

	for (const fact of facts) {
		// PAD + ❧ + space + content (truncate to fit if needed)
		const maxContentLen = SIDEBAR_COLS - PAD.length - 2 - PAD.length; // "  ❧ " ... "  "
		const truncated = fact.length > maxContentLen
			? fact.slice(0, maxContentLen - 1) + "\u2026"
			: fact;
		rows.push(row(
			`${PAD}<span class="fg-accent">\u2767</span> <span class="fg-fg">${truncated}</span>`,
		));
	}

	const moreCount = totalCount - facts.length;
	if (moreCount > 0) {
		rows.push(row(`${PAD}<span class="fg-dim">${moreCount} more \u00b7 \u2318M</span>`));
	}

	return rows;
}

// ─── METRICS HUD (htop-style sparklines, optional) ──────────────────────
function buildMetricsContent({ cpu, mem, fps, compact }) {
	const rows = [];
	rows.push(sectionHeader("METRICS"));
	if (compact) {
		// Compact text-only: CPU 16% MEM 414M
		rows.push(row(
			`${PAD}<span class="fg-dim">CPU</span> <span class="fg-think">${cpu}%</span>` +
			` <span class="fg-dim">MEM</span> <span class="fg-fg">${mem}</span>`,
		));
		rows.push(row(
			`${PAD}<span class="fg-dim">FPS</span> <span class="fg-fg">${fps}/s</span>`,
		));
	} else {
		// Sparkline bars (textual approximation)
		const barLen = 10;
		const cpuFill = Math.round(barLen * (cpu / 100));
		const memFill = Math.round(barLen * 0.6); // fake fraction for visual
		rows.push(row(
			`${PAD}<span class="fg-dim">CPU</span> <span class="fg-think">[${rep("\u2588", cpuFill)}${rep("\u2591", barLen - cpuFill)}]</span> <span class="fg-fg">${cpu}%</span>`,
		));
		rows.push(row(
			`${PAD}<span class="fg-dim">MEM</span> <span class="fg-approve">[${rep("\u2588", memFill)}${rep("\u2591", barLen - memFill)}]</span> <span class="fg-fg">${mem}</span>`,
		));
		rows.push(row(
			`${PAD}<span class="fg-dim">FPS</span> <span class="fg-fg">[${rep("\u2591", barLen)}]</span> <span class="fg-fg">${fps}/s</span>`,
		));
	}
	return rows;
}

// ─── helpers ────────────────────────────────────────────────────────────
function parseTokens(s) {
	// Parse "42k", "200k", "3.4M", "1.0M" into number
	const m = s.match(/^([\d.]+)([kKmM]?)$/);
	if (!m) return 0;
	const n = parseFloat(m[1]);
	const unit = m[2].toLowerCase();
	return unit === "m" ? n * 1_000_000 : unit === "k" ? n * 1_000 : n;
}

// ─── full sidebar builder ───────────────────────────────────────────────
function buildSidebar({ activeTab, contextSpec, memorySpec, metrics }) {
	const rows = [
		...buildChrome(),
		subTabRow("CONTEXT", activeTab === "CONTEXT"),
		subTabRow("MEMORY", activeTab === "MEMORY"),
		blankRow(),
	];

	if (activeTab === "CONTEXT") {
		rows.push(...buildContextContent(contextSpec));
	} else {
		rows.push(...buildMemoryContent(memorySpec));
	}

	if (metrics) {
		rows.push(blankRow());
		rows.push(...buildMetricsContent(metrics));
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
  .stage-blurb { max-width: 130ch; color: var(--foreground-dim); font-size: 11px; line-height: 1.6; letter-spacing: 0.04em; padding: 0 8px; text-align: center; }
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

// ─── variant specs ──────────────────────────────────────────────────────
const standardContext = {
	project: "sumo-deus",
	branch: "main",
	ctxTokens: "42k",
	ctxWindow: "200k",
	cumulSession: "3.4M",
	cost: "0.42",
	mcps: [
		{ name: "github",        state: "idle" },
		{ name: "stitch",        state: "ok" },
		{ name: "context7",      state: "idle" },
		{ name: "chrome-dev",    state: "idle" },
	],
};

const overBudgetContext = {
	...standardContext,
	ctxTokens: "3.4M",
	ctxWindow: "1.0M",
	overBudget: true,
};

const standardMemory = {
	facts: [
		"prefers TS strict",
		"pnpm not npm",
		"based London \u00b7 BST",
		"Argent \u2192 argent-x",
		"imperative commits",
	],
	totalCount: 53, // 5 visible + 48 more
};

const variants = [
	{
		filename: "01-sidebar-context.html",
		title: "Bible \u00b7 Element 1 \u00b7 Sidebar \u00b7 CONTEXT active",
		label: "element 1 \u00b7 sidebar \u00b7 CONTEXT active \u00b7 30 cols",
		blurb: "30-col sidebar (down from 49). REGISTRY chrome, 2 sub-tabs (\u25c6 active / \u25a2 inactive). CONTEXT shows project, token bar, $ spent, cumul session, MCP \u25cf state pills. uniform surface bg across all rows including blanks (the inter-section bg fix from #65).",
		spec: {
			activeTab: "CONTEXT",
			contextSpec: standardContext,
		},
	},
	{
		filename: "01-sidebar-memory.html",
		title: "Bible \u00b7 Element 1 \u00b7 Sidebar \u00b7 MEMORY active",
		label: "element 1 \u00b7 sidebar \u00b7 MEMORY active \u00b7 30 cols",
		blurb: "MEMORY tab active. ACTIVE_MEMORY block with \u2767 fact bullets. 'N more \u00b7 \u2318M' overflow marker hints at \u2318M to open the memory editor (Element 7).",
		spec: {
			activeTab: "MEMORY",
			memorySpec: standardMemory,
		},
	},
	{
		filename: "01-sidebar-context-over-budget.html",
		title: "Bible \u00b7 Element 1 \u00b7 Sidebar \u00b7 CONTEXT over-budget",
		label: "element 1 \u00b7 sidebar \u00b7 CONTEXT over-budget \u00b7 30 cols",
		blurb: "context window overflow state (>100% of model window). token bar fills full and turns terracotta. OVER badge in approval color.",
		spec: {
			activeTab: "CONTEXT",
			contextSpec: overBudgetContext,
		},
	},
	{
		filename: "01-sidebar-memory-empty.html",
		title: "Bible \u00b7 Element 1 \u00b7 Sidebar \u00b7 MEMORY empty",
		label: "element 1 \u00b7 sidebar \u00b7 MEMORY empty \u00b7 30 cols",
		blurb: "no memory facts yet. dim 'no memory match' empty state.",
		spec: {
			activeTab: "MEMORY",
			memorySpec: { facts: [], totalCount: 0, empty: true },
		},
	},
	{
		filename: "01-sidebar-memory-daemon-down.html",
		title: "Bible \u00b7 Element 1 \u00b7 Sidebar \u00b7 MEMORY daemon down",
		label: "element 1 \u00b7 sidebar \u00b7 MEMORY daemon down \u00b7 30 cols",
		blurb: "Remnic daemon offline. dim 'memory unavailable' message instead of facts.",
		spec: {
			activeTab: "MEMORY",
			memorySpec: { facts: [], totalCount: 0, daemonDown: true },
		},
	},
	{
		filename: "01-sidebar-with-metrics.html",
		title: "Bible \u00b7 Element 1 \u00b7 Sidebar \u00b7 with METRICS HUD",
		label: "element 1 \u00b7 sidebar \u00b7 CONTEXT + METRICS HUD \u00b7 30 cols",
		blurb: "/metrics on \u2014 htop-style CPU/MEM/FPS sparklines below MCP. hidden by default; opt-in via slash command.",
		spec: {
			activeTab: "CONTEXT",
			contextSpec: standardContext,
			metrics: { cpu: 16, mem: "414M", fps: "0", compact: false },
		},
	},
];

for (const v of variants) {
	const gridRows = buildSidebar(v.spec);
	const path = resolve(out, v.filename);
	writeFileSync(path, htmlPage({ ...v, gridRows }));
	console.log(`wrote ${v.filename}  (${SIDEBAR_COLS}\u00d7${gridRows.length})`);
}
