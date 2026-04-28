#!/usr/bin/env node
// Element — Skill pill (NEW). When the agent invokes a skill, Pi shows it
// inline in the assistant turn as a pill. Three design variants.

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

const COLS = 130;
const innerCols = COLS - 4;

// Builds a SUMO message box wrapper with 3 body rows: thinking line, skill pill
// (variant), and a result line. Showcases the pill in real chat context.
function buildSumoWithSkill({ skillName, skillDesc, pillBuilder }) {
	const rows = [];
	const meta = ` \u00b7 claude-opus-4-7 \u00b7 11:42`;
	const headerLeftLen = 7;
	const headerRightLen = 1 + meta.length + 1 + 1;
	const dashLen = COLS - headerLeftLen - headerRightLen;

	rows.push(
		`<span class="fg-divider">\u256d </span><span class="fg-accent">SUMO</span> ` +
		`<span class="fg-divider">${rep("\u2500", dashLen)}</span>` +
		` <span class="fg-dim">${meta}</span> <span class="fg-divider">\u256e</span>`,
	);

	const bodyRow = (h, len) => {
		const padLen = innerCols - len;
		return `<span class="fg-divider">\u2502</span><span class="box-fill" style="width: ${innerCols + 2}ch"> ` + h + rep(" ", padLen) + ` </span><span class="fg-divider">\u2502</span>`;
	};
	const blankRow = () => bodyRow("", 0);

	const intro = `Let me design that frontend with a fresh aesthetic.`;
	rows.push(bodyRow(`<span class="fg-fg">${intro}</span>`, intro.length));
	rows.push(blankRow());

	// Skill pill (variant content)
	const pillHTML = pillBuilder(skillName, skillDesc);
	const pillLen = visibleLen(pillHTML);
	rows.push(bodyRow(pillHTML, pillLen));

	rows.push(blankRow());
	const closing = `Picking direction "brutally minimal" \u2014 generating now.`;
	rows.push(bodyRow(`<span class="fg-fg">${closing}</span>`, closing.length));

	rows.push(`<span class="fg-divider">\u2570${rep("\u2500", COLS - 2)}\u256f</span>`);

	return rows.join("\n");
}

// ─── Three pill builders ────────────────────────────────────────────────

// V1 — INLINE NOTICE (Pi default style, just cleaner cathedral colors)
//   [skill] frontend-design (⌘O to expand)
function pillInline(name) {
	return (
		`<span class="fg-divider">[</span>` +
		`<span class="fg-accent">skill</span>` +
		`<span class="fg-divider">]</span> ` +
		`<span class="fg-fg">${name}</span> ` +
		`<span class="fg-dim">(\u2318O to expand)</span>`
	);
}

// V2 — TOOL-PILL STYLE (matches Element 9 framing)
//   ━━━ [skill] frontend-design ━━━━━━━━━━━━━━━━━ ✓ loaded · ⌘O expand
function pillToolStyle(name) {
	const left = `[skill]  ${name}`;
	const right = `\u2713 loaded \u00b7 \u2318O expand`;
	const dashes = innerCols - 6 - left.length - right.length - 4;
	return (
		`<span class="fg-divider">\u2501\u2501\u2501</span> ` +
		`<span class="fg-accent">[skill]</span>` +
		`<span class="fg-fg">  ${name}</span>` +
		` <span class="fg-divider">${rep("\u2501", Math.max(3, dashes))}</span> ` +
		`<span class="fg-divider">\u2501\u2501\u2501</span> ` +
		`<span class="fg-idle">\u2713</span> ` +
		`<span class="fg-dim">loaded \u00b7 \u2318O expand</span>`
	);
}

// V3 — DECORATIVE / DESCRIPTION PREVIEW
//   ❧  SKILL · frontend-design
//      Create distinctive, production-grade frontend interfaces…
//      ⌘O to expand
// (Multiple lines)
function pillDecorative(name, desc) {
	const truncDesc = desc.length > innerCols - 8 ? desc.slice(0, innerCols - 9) + "\u2026" : desc;
	return (
		`<span class="fg-accent">\u2767</span>  <span class="fg-dim">SKILL \u00b7 </span><span class="fg-accent">${name}</span>` +
		`</span><span class="fg-divider">\u2502</span></span></span>\n` + // close + reopen the box-fill row
		// Hack: we can't break inside one bodyRow; this approach won't work cleanly
		// Use a different strategy — pass multi-row content in this builder
		``
	);
}

// V3 needs multi-row support; simpler: render it inline with line break and
// re-wrap with bodyRow externally. Let me restructure as a separate builder.

function buildSumoWithDecorativePill({ skillName, skillDesc }) {
	const rows = [];
	const meta = ` \u00b7 claude-opus-4-7 \u00b7 11:42`;
	const headerLeftLen = 7;
	const headerRightLen = 1 + meta.length + 1 + 1;
	const dashLen = COLS - headerLeftLen - headerRightLen;

	rows.push(
		`<span class="fg-divider">\u256d </span><span class="fg-accent">SUMO</span> ` +
		`<span class="fg-divider">${rep("\u2500", dashLen)}</span>` +
		` <span class="fg-dim">${meta}</span> <span class="fg-divider">\u256e</span>`,
	);

	const bodyRow = (h, len) => {
		const padLen = innerCols - len;
		return `<span class="fg-divider">\u2502</span><span class="box-fill" style="width: ${innerCols + 2}ch"> ` + h + rep(" ", padLen) + ` </span><span class="fg-divider">\u2502</span>`;
	};
	const blankRow = () => bodyRow("", 0);

	const intro = `Let me design that frontend with a fresh aesthetic.`;
	rows.push(bodyRow(`<span class="fg-fg">${intro}</span>`, intro.length));
	rows.push(blankRow());

	// Decorative pill spans 3 rows
	const pillRow1 = `<span class="fg-accent">\u2767</span>  <span class="fg-dim">SKILL \u00b7 </span><span class="fg-accent">${skillName}</span>`;
	rows.push(bodyRow(pillRow1, visibleLen(pillRow1)));
	const truncDesc = skillDesc.length > innerCols - 6 ? skillDesc.slice(0, innerCols - 7) + "\u2026" : skillDesc;
	const pillRow2 = `   <span class="fg-fg">${truncDesc}</span>`;
	rows.push(bodyRow(pillRow2, visibleLen(pillRow2)));
	const pillRow3 = `   <span class="fg-dim">\u2318O to expand</span>`;
	rows.push(bodyRow(pillRow3, visibleLen(pillRow3)));

	rows.push(blankRow());
	const closing = `Picking direction "brutally minimal" \u2014 generating now.`;
	rows.push(bodyRow(`<span class="fg-fg">${closing}</span>`, closing.length));

	rows.push(`<span class="fg-divider">\u2570${rep("\u2500", COLS - 2)}\u256f</span>`);
	return rows.join("\n");
}

// ─── HTML wrapper ───────────────────────────────────────────────────────
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
    <pre class="grid">${content}</pre>
  </div>
</div>
</body>
</html>
`;
}

const SKILL_NAME = "frontend-design";
const SKILL_DESC = "Create distinctive, production-grade frontend interfaces with high design quality. Generates creative, polished code that avoids generic AI aesthetics.";

const variants = [
	{
		filename: "skill-v1-inline.html",
		title: "Bible · Skill pill V1 · INLINE NOTICE",
		label: "skill state · V1 inline notice (Pi default style)",
		blurb: "minimal — single line inline in SUMO box body. matches Pi's stock pill. \"[skill] name (\u2318O to expand)\". cleanest, least visual weight.",
		content: buildSumoWithSkill({
			skillName: SKILL_NAME,
			skillDesc: SKILL_DESC,
			pillBuilder: pillInline,
		}),
	},
	{
		filename: "skill-v2-tool-pill.html",
		title: "Bible · Skill pill V2 · TOOL-PILL STYLE",
		label: "skill state · V2 framed like a tool pill",
		blurb: "matches Element 9 tool-pill framing. \u2501\u2501\u2501 [skill] name \u2501\u2501\u2501 \u2713 loaded \u00b7 \u2318O expand. visually consistent with bash/edit pills, treats skills as a class of tool.",
		content: buildSumoWithSkill({
			skillName: SKILL_NAME,
			skillDesc: SKILL_DESC,
			pillBuilder: pillToolStyle,
		}),
	},
	{
		filename: "skill-v3-decorative.html",
		title: "Bible · Skill pill V3 · DECORATIVE",
		label: "skill state · V3 decorative with description preview",
		blurb: "ornamental. \u2767 SKILL \u00b7 name + dim description preview + expand hint. 3 rows. shows the skill is a meaningful interaction not just a tool call. cathedral-elevated.",
		content: buildSumoWithDecorativePill({
			skillName: SKILL_NAME,
			skillDesc: SKILL_DESC,
		}),
	},
];

for (const v of variants) {
	const rows = v.content.split("\n").length;
	writeFileSync(resolve(out, v.filename), htmlPage({ ...v, rows }));
	console.log(`wrote ${v.filename}  (${COLS}\u00d7${rows})`);
}
