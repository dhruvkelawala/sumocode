#!/usr/bin/env node
// Element 1 — Sidebar DESIGN EXPLORATIONS (CANONICAL V2 EDITORIAL — magazine display, tracked-out masthead.
// 3 mockups: context / over-budget / metrics.

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(repoRoot, "docs", "ui", "bible");
const COLS = 30;

// ─── primitives ─────────────────────────────────────────────────────────
const rep = (ch, n) => ch.repeat(n);
const visibleLen = (s) =>
	s.replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").length;
const padRight = (s, n) => {
	const need = n - visibleLen(s);
	return need > 0 ? s + rep(" ", need) : s;
};
const row = (h) =>
	`<span class="box-fill" style="background: var(--surface); width: ${COLS}ch">` + padRight(h, COLS) + `</span>`;
const blank = () => row("");

const trackOut = (s) => s.split("").join("\u202f"); // narrow no-break space

// ─── data ───────────────────────────────────────────────────────────────
const standardCtx = {
	project: "sumocode",
	branch: "main",
	ctxTokens: "42k",
	ctxWindow: "200k",
	cumul: "3.4M",
	cost: "0.42",
	mcps: [
		{ name: "github",     state: "idle" },
		{ name: "stitch",     state: "ok" },
		{ name: "context7",   state: "idle" },
		{ name: "chrome-dev", state: "idle" },
	],
	overBudget: false,
};

const overCtx = { ...standardCtx, ctxTokens: "3.4M", ctxWindow: "1.0M", overBudget: true };

// ═════════════════════════════════════════════════════════════════════════
// V2 — EDITORIAL / MAGAZINE
// ═════════════════════════════════════════════════════════════════════════
const v2 = {
	chrome() {
		return [
			blank(),
			row(`  <span class="fg-accent">REGISTRY</span>`),
			blank(),
		];
	},
	tabs() {
		return [
			row(`  <span class="fg-accent">\u25c6</span> <span class="fg-fg">${trackOut("CONTEXT")}</span>`),
			blank(),
			row(`  <span class="fg-divider">${rep("\u2501", 26)}</span>`),
			blank(),
		];
	},
	context(spec) {
		const rows = [];
		rows.push(row(`  <span class="fg-fg">${spec.project}</span>`));
		rows.push(row(`  <span class="fg-dim">on ${spec.branch}</span>`));
		rows.push(blank());
		rows.push(row(`  <span class="fg-dim">${trackOut("CONTEXT")}</span>`));
		const barLen = 22;
		const filled = spec.overBudget ? barLen : 5;
		const barClass = spec.overBudget ? "fg-approve" : "fg-idle";
		rows.push(row(
			`  <span class="${barClass}">${rep("\u2589", filled)}</span><span class="fg-divider">${rep("\u2591", barLen - filled)}</span>`,
		));
		const overTag = spec.overBudget ? ` <span class="fg-approve">OVER</span>` : "";
		rows.push(row(`  <span class="fg-fg">${spec.ctxTokens}</span> <span class="fg-dim">/ ${spec.ctxWindow}</span>${overTag}`));
		rows.push(blank());
		rows.push(row(`  <span class="fg-dim">${trackOut("SESSION")}</span>`));
		rows.push(row(`  <span class="fg-fg">$${spec.cost}</span> <span class="fg-dim">\u00b7 ${spec.cumul} cumul</span>`));
		rows.push(blank());
		rows.push(row(`  <span class="fg-divider">${rep("\u2501", 26)}</span>`));
		rows.push(blank());
		rows.push(row(`  <span class="fg-dim">${trackOut("MCP")}</span>`));
		rows.push(blank());
		for (const mcp of spec.mcps) {
			const dotClass = mcp.state === "ok" ? "fg-idle" : (mcp.state === "down" ? "fg-approve" : "fg-dim");
			const stateText = mcp.state;
			const pad = COLS - 4 - mcp.name.length - stateText.length - 2;
			rows.push(row(
				`  <span class="${dotClass}">\u25cf</span> <span class="fg-fg">${mcp.name}</span>` +
				rep(" ", Math.max(1, pad)) +
				`<span class="fg-dim">${stateText}</span>  `,
			));
		}
		return rows;
	},
	metrics({ cpu, mem, fps }) {
		const rows = [];
		rows.push(blank());
		rows.push(row(`  <span class="fg-divider">${rep("\u2501", 26)}</span>`));
		rows.push(blank());
		rows.push(row(`  <span class="fg-dim">${trackOut("METRICS")}</span>`));
		rows.push(blank());
		const bar = 10;
		const cpuFill = Math.round(bar * cpu / 100);
		rows.push(row(`  <span class="fg-dim">CPU</span> <span class="fg-think">${rep("\u2589", cpuFill)}</span><span class="fg-divider">${rep("\u2591", bar - cpuFill)}</span> <span class="fg-fg">${cpu}%</span>`));
		const memFill = 6;
		rows.push(row(`  <span class="fg-dim">MEM</span> <span class="fg-approve">${rep("\u2589", memFill)}</span><span class="fg-divider">${rep("\u2591", bar - memFill)}</span> <span class="fg-fg">${mem}</span>`));
		rows.push(row(`  <span class="fg-dim">FPS</span> <span class="fg-divider">${rep("\u2591", bar)}</span> <span class="fg-fg">${fps}/s</span>`));
		return rows;
	},
};

// ─── compose sidebar ────────────────────────────────────────────────────
function buildSidebar(variant, spec) {
	const { contextSpec, metrics } = spec;
	const rows = [
		...variant.chrome(),
		...variant.tabs(),
		...variant.context(contextSpec),
		...(metrics ? variant.metrics(metrics) : []),
	];
	return rows;
}

// ─── HTML page ──────────────────────────────────────────────────────────
function htmlPage({ title, label, blurb, gridRows }) {
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
  <div data-render-rect class="term" style="--term-cols: ${COLS}; --term-rows: ${gridRows.length};">
    <pre class="grid">${gridRows.join("\n")}</pre>
  </div>
</div>
</body>
</html>
`;
}

// ─── variant × state matrix ─────────────────────────────────────────────
const states = [
	{ suffix: "context",          spec: { contextSpec: standardCtx }, blurb: "CONTEXT active, standard token state." },
	{ suffix: "context-over-budget",     spec: { contextSpec: overCtx }, blurb: "CONTEXT over-budget. bar fills + OVER badge in approval color." },
	{ suffix: "with-metrics",          spec: { contextSpec: standardCtx, metrics: { cpu: 16, mem: "414M", fps: 0 } }, blurb: "/metrics on — htop sparklines below." },
];

const variants = [
	{ name: "v2-editorial",   variant: v2, label: "V2 EDITORIAL",   tagline: "magazine display, tracked-out masthead, hero values" },
];

for (const v of variants) {
	for (const s of states) {
		const filename = `01-sidebar-${s.suffix}.html`;
		const gridRows = buildSidebar(v.variant, s.spec);
		const path = resolve(out, filename);
		writeFileSync(path, htmlPage({
			title: `Bible · Element 1 · ${v.label} · ${s.suffix}`,
			label: `element 1 · ${v.label} · ${s.suffix} · 30 cols`,
			blurb: `${v.tagline}. ${s.blurb}`,
			gridRows,
		}));
		console.log(`wrote ${filename}  (${COLS}×${gridRows.length})`);
	}
}
