#!/usr/bin/env node
// Element 12 — Scroll + scribe delegated-work UI.
// The underlying Pi tool may still be called task, but the runtime UI presents
// delegated sub-agent work as a written scroll assigned to a scribe.

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

const STATE_GLYPH = { ok: "\u2713", running: "\u25b6", failed: "\u2717" };
const STATE_CLASS = { ok: "fg-idle", running: "fg-tool", failed: "fg-approve" };
const STATE_LABEL = { ok: "done", running: "running", failed: "failed" };

function buildScroll({ cols, title, model, thinking, calls, tokensIn, tokensOut, elapsed, status }) {
	const rows = [];

	// Outer framed pill: ━━━ [scroll] <title> ━━━ ▶ running
	const left = `[scroll]  ${title}`;
	const right = `${STATE_GLYPH[status]} ${STATE_LABEL[status]}`;
	const dashes = cols - 10 - left.length - right.length;
	rows.push(
		`<span class="fg-divider">\u2501\u2501\u2501</span> ` +
		`<span class="fg-accent">[scroll]</span>` +
		`<span class="fg-fg">  ${title}</span>` +
		` <span class="fg-divider">${rep("\u2501", Math.max(3, dashes))}</span> ` +
		`<span class="fg-divider">\u2501\u2501\u2501</span> ` +
		`<span class="${STATE_CLASS[status]}">${STATE_GLYPH[status]}</span> ` +
		`<span class="fg-fg">${STATE_LABEL[status]}</span>`,
	);
	rows.push("");

	// Inner ledger: the scribe owns nested tool calls and token accounting.
	const innerWidth = cols - 6;
	const scribeTitle = `scribe \u00b7 ${model} \u00b7 ${thinking}`;
	const innerDashes = innerWidth - scribeTitle.length - 4;
	rows.push(
		`   <span class="fg-divider">\u250c </span>` +
		`<span class="fg-dim">${scribeTitle}</span>` +
		` <span class="fg-divider">${rep("\u2500", Math.max(3, innerDashes))}</span>`,
	);

	for (const call of calls) {
		const glyph = STATE_GLYPH[call.state] || "\u00b7";
		const glyphClass = STATE_CLASS[call.state] || "fg-dim";
		rows.push(
			`   <span class="fg-divider">\u2502</span> ` +
			`<span class="${glyphClass}">${glyph}</span> ` +
			`<span class="fg-accent">[${call.name}]</span>` +
			`<span class="fg-fg">  ${call.target}</span>`,
		);
	}

	rows.push(`   <span class="fg-divider">\u2502</span>`);
	rows.push(
		`   <span class="fg-divider">\u2502</span> ` +
		`<span class="fg-dim">Tokens: \u2191${tokensIn} \u2193${tokensOut} \u00b7 ${elapsed} elapsed</span>`,
	);
	rows.push(`   <span class="fg-divider">\u2514${rep("\u2500", innerWidth)}</span>`);

	return rows.map((r) => padRight(r, cols)).join("\n");
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
    <pre class="grid">${content}</pre>
  </div>
</div>
</body>
</html>
`;
}

const COLS = 130;

const variants = [
	{
		filename: "12-scroll-running.html",
		title: "Bible · Element 12 · scroll + scribe · running",
		label: "element 12 · [scroll] + scribe running · 130×10",
		blurb: "delegated work appears as a scroll assigned to a scribe. nested tool calls stay indented inside the scribe ledger.",
		spec: {
			title: "refactor auth flow into smaller modules",
			model: "gpt-5.5",
			thinking: "medium",
			status: "running",
			calls: [
				{ name: "read", target: "src/auth.ts", state: "ok" },
				{ name: "edit", target: "src/auth.ts", state: "ok" },
				{ name: "edit", target: "src/auth-helpers.ts", state: "ok" },
				{ name: "bash", target: "pnpm test src/auth", state: "running" },
			],
			tokensIn: "8k",
			tokensOut: "3k",
			elapsed: "22s",
		},
	},
	{
		filename: "12-scroll-done.html",
		title: "Bible · Element 12 · scroll + scribe · done",
		label: "element 12 · [scroll] + scribe done · 130×9",
		blurb: "after the scribe completes. all nested tool calls ✓, outer scroll marks ✓ done.",
		spec: {
			title: "audit imports across all .ts files",
			model: "claude-haiku-4-5",
			thinking: "low",
			status: "ok",
			calls: [
				{ name: "bash", target: "find . -name '*.ts'", state: "ok" },
				{ name: "read", target: "(247 files in batches)", state: "ok" },
				{ name: "write", target: "/tmp/import-audit.txt", state: "ok" },
			],
			tokensIn: "12k",
			tokensOut: "1.4k",
			elapsed: "1m 18s",
		},
	},
];

for (const v of variants) {
	const content = buildScroll({ cols: COLS, ...v.spec });
	const rows = content.split("\n").length;
	writeFileSync(resolve(out, v.filename), htmlPage({ ...v, cols: COLS, content, rows }));
	console.log(`wrote ${v.filename}  (${COLS}\u00d7${rows})`);
}
