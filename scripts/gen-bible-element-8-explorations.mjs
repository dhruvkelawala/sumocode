#!/usr/bin/env node
// Element 8 — Command palette DESIGN EXPLORATIONS.
// 3 distinct aesthetic directions, each with a different search bar treatment.
// Same content (6 modes, MODEL focused) so user grades the IDEA not the data.

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

const COLS = 80;

const MODES = [
	{ key: "SESSION",  num: "1", glyph: "\uf064", value: "auth-flow-refactor" },  // arrow-circle-right
	{ key: "MODEL",    num: "2", glyph: "\uf2db", value: "claude-opus-4-7" },     // microchip
	{ key: "THINKING", num: "3", glyph: "\uf0eb", value: "xhigh" },                // lightbulb
	{ key: "MEMORY",   num: "4", glyph: "\uf1c0", value: "55 facts" },             // database
	{ key: "THEME",    num: "5", glyph: "\uf53f", value: "cathedral" },            // palette
	{ key: "SETTINGS", num: "6", glyph: "\uf013", value: "" },                     // gear
];

// ─────────────────────────────────────────────────────────────────────────
// VARIANT A — RAYCAST / SPOTLIGHT
//   Search-first. Big input row at top with magnifying-glass glyph (\uf002).
//   No formal title — search IS the entry point.
//   Mode rows have icon + label + dim subtitle, focused row in accent fill.
// ─────────────────────────────────────────────────────────────────────────
function buildRaycast({ selectedIdx }) {
	const rows = [];
	const blank = () => padRight("", COLS);
	rows.push(blank());

	// Big search bar — full width minus margins, no border, just glyph + dim placeholder
	const searchInner = COLS - 6;
	const placeholder = "type a command…";
	const search =
		`  <span class="fg-accent">\uf002</span>  ` +
		`<span class="fg-dim">${placeholder}</span>` +
		rep(" ", searchInner - 5 - placeholder.length);
	rows.push(padRight(search, COLS));
	rows.push(blank());
	rows.push(`  <span class="fg-divider">${rep("\u2500", COLS - 4)}</span>  `);

	// Mode rows: glyph icon | label | dim subtitle
	for (let i = 0; i < MODES.length; i++) {
		const m = MODES[i];
		const focused = i === selectedIdx;
		const icon = `<span class="fg-accent">${m.glyph}</span>`;
		const label = m.key;
		const subtitle = m.value || "";
		const subtitleLen = subtitle.length;
		const labelLen = label.length;
		const innerLen = 4 + 2 + 2 + labelLen + 2 + subtitleLen; // icon + 2sp + 2pad + label + 2sp + value
		const innerPad = COLS - 4 - innerLen;

		if (focused) {
			rows.push(
				`  ${icon}<span class="fg-fg" style="background: var(--accent); color: var(--background);">  ${label}${rep(" ", Math.max(2, innerPad))} ${subtitle} </span>  `,
			);
		} else {
			rows.push(
				padRight(`  ${icon}  <span class="fg-fg">${label}</span>${rep(" ", Math.max(2, innerPad))}<span class="fg-dim">${subtitle}</span>`, COLS),
			);
		}
	}

	rows.push(blank());
	rows.push(`  <span class="fg-divider">${rep("\u2500", COLS - 4)}</span>  `);
	rows.push(center(`<span class="fg-dim">\u2191\u2193 navigate    \u23ce select    \u238b close</span>`, COLS));
	rows.push(blank());

	return rows.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// VARIANT B — SCRIPTORIUM / ILLUMINATED
//   Display title with floral marks ❦. Search as a reading rule (no box).
//   Mode rows with Roman numerals + ❧ bullets.
//   Hand-scribed feel.
// ─────────────────────────────────────────────────────────────────────────
function buildScriptorium({ selectedIdx }) {
	const rows = [];
	const blank = () => padRight("", COLS);
	rows.push(blank());

	// Title with ✾ floral mark (six-petalled black & white florette).
	rows.push(center(`<span class="fg-accent">✾</span>  <span class="fg-accent">COMMAND PALETTE</span>  <span class="fg-accent">✾</span>`, COLS));
	rows.push(blank());

	// Decorative rule with center floral mark
	const halfRule = rep("─", 22);
	rows.push(center(`<span class="fg-divider">${halfRule}</span>  <span class="fg-divider">·</span>  <span class="fg-divider">${halfRule}</span>`, COLS));
	rows.push(blank());

	// Search: ❯ chevron + cursor + placeholder
	const placeholder = "what shall we attend to…";
	rows.push(
		padRight(`     <span class="fg-accent">❯</span>  <span class="cursor"> </span><span class="fg-dim">${placeholder}</span>`, COLS),
	);
	rows.push(blank());

	// Mode rows: ❧/· marker + label + value (NO per-row icons — keep simple)
	for (let i = 0; i < MODES.length; i++) {
		const m = MODES[i];
		const focused = i === selectedIdx;
		const labelClass = focused ? "fg-fg" : "fg-dim";
		const valueClass = focused ? "fg-fg" : "fg-dim";
		const markerClass = focused ? "fg-accent" : "fg-divider";
		const marker = focused ? "❈" : "·"; // ❈ heavy sparkle vs ·

		const labelStr =
			`     <span class="${markerClass}">${marker}</span>   ` +
			`<span class="${labelClass}">${m.key}</span>`;
		const labelLen = visibleLen(labelStr);
		const valueStr = m.value ? `<span class="${valueClass}">${m.value}</span>` : "";
		const valueLen = m.value.length;
		const padBetween = COLS - labelLen - valueLen - 5;
		rows.push(padRight(`${labelStr}${rep(" ", Math.max(2, padBetween))}${valueStr}`, COLS));
	}

	rows.push(blank());
	rows.push(center(`<span class="fg-divider">${halfRule}</span>  <span class="fg-divider">·</span>  <span class="fg-divider">${halfRule}</span>`, COLS));
	rows.push(center(`<span class="fg-dim">↑↓ wander    ⏎ attend    ⎋ retreat</span>`, COLS));
	rows.push(blank());

	return rows.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// VARIANT C — TERMINAL DENSE / BBS
//   Bracketed all-caps title. Classic > _ shell prompt search.
//   Mode rows with [N] number-key bindings on the left for direct access.
//   Plus right-aligned values/status.
// ─────────────────────────────────────────────────────────────────────────
function buildTerminalDense({ selectedIdx }) {
	const rows = [];
	const blank = () => padRight("", COLS);
	rows.push(blank());

	rows.push(center(`<span class="fg-accent">[ COMMAND PALETTE ]</span>`, COLS));
	rows.push(blank());

	// Shell-prompt search bar: > _<placeholder>
	const placeholder = "search or type number...";
	rows.push(
		padRight(`   <span class="fg-accent">$</span> <span class="cursor"> </span><span class="fg-dim">${placeholder}</span>`, COLS),
	);
	rows.push(blank());
	rows.push(`   <span class="fg-divider">${rep("\u2501", COLS - 6)}</span>   `);
	rows.push(blank());

	// Mode rows with [N] number access
	for (let i = 0; i < MODES.length; i++) {
		const m = MODES[i];
		const focused = i === selectedIdx;
		const numTag = `<span class="fg-divider">[</span><span class="fg-accent">${m.num}</span><span class="fg-divider">]</span>`;
		const labelClass = focused ? "fg-fg" : "fg-fg";
		const valueClass = focused ? "fg-fg" : "fg-dim";
		const arrow = focused ? `<span class="fg-accent">\u25b6</span>` : `<span class="fg-dim">\u00b7</span>`;
		const labelStr = `   ${numTag} <span class="${labelClass}">${m.key.padEnd(8)}</span>  ${arrow}`;
		const labelLen = visibleLen(labelStr);
		const valueStr = m.value ? `<span class="${valueClass}">${m.value}</span>` : "";
		const padBetween = COLS - labelLen - m.value.length - 4;
		rows.push(`${labelStr}  ${valueStr}${rep(" ", Math.max(0, padBetween))}    `);
	}

	rows.push(blank());
	rows.push(`   <span class="fg-divider">${rep("\u2501", COLS - 6)}</span>   `);
	rows.push(
		padRight(`   <span class="fg-dim">\u2191\u2193:nav  1\u20136:jump  enter:run  esc:exit</span>`, COLS),
	);
	rows.push(blank());

	return rows.join("\n");
}

// ─── HTML page wrapper ──────────────────────────────────────────────────
function htmlPage({ title, label, blurb, content, rows }) {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="_assets/tokens.css">
<style>
  .stage-blurb { max-width: ${COLS}ch; color: var(--foreground-dim); font-size: 11px; line-height: 1.6; padding: 0 8px; text-align: center; }
</style>
</head>
<body>
<div class="stage">
  <div class="stage-label">${label}</div>
  <div class="stage-blurb">${blurb}</div>
  <div data-render-rect class="term" style="--term-cols: ${COLS}; --term-rows: ${rows};">
    <pre class="grid" style="background: var(--surface-lifted)">${content}</pre>
  </div>
</div>
</body>
</html>
`;
}

const explorations = [
	{
		filename: "08-palette-v1-raycast.html",
		title: "Bible · Element 8 · Palette V1 · RAYCAST/SPOTLIGHT",
		label: "element 8 · V1 RAYCAST/SPOTLIGHT · 80 cols",
		blurb: "search-first. no formal title. magnifying glass icon prefix on a borderless search bar. mode rows have Nerd Font glyph icons + dim subtitles. focused row accent-filled. utility-forward, raycast-inspired.",
		build: buildRaycast,
	},
	{
		filename: "08-palette-v2-scriptorium.html",
		title: "Bible · Element 8 · Palette V2 · SCRIPTORIUM",
		label: "element 8 · V2 SCRIPTORIUM · 80 cols",
		blurb: "ornamental. ❦ floral marks framing the title. dotted-rule \u2500\u2500\u00b7\u00b7\u00b7\u2500\u2500 dividers. search bar without a box, just \u25b8 arrow + 'what shall we attend to…'. mode rows numbered with Roman numerals (Ⅰ Ⅱ Ⅲ) + ❧ bullets on focused.",
		build: buildScriptorium,
	},
	{
		filename: "08-palette-v3-terminal.html",
		title: "Bible · Element 8 · Palette V3 · TERMINAL DENSE",
		label: "element 8 · V3 TERMINAL DENSE · 80 cols",
		blurb: "BBS-era brackets. \"[ COMMAND PALETTE ]\" title. shell-prompt search '$ █ search or type number...'. mode rows with [1] [2] [3]... number-key access for direct jumps. heavy ━ rules.",
		build: buildTerminalDense,
	},
];

for (const e of explorations) {
	const content = e.build({ selectedIdx: 1 });
	const rows = content.split("\n").length;
	writeFileSync(resolve(out, e.filename), htmlPage({ ...e, content, rows }));
	console.log(`wrote ${e.filename}  (${COLS}\u00d7${rows})`);
}
