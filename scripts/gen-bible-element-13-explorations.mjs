#!/usr/bin/env node
// Element 13 — chat message DESIGN EXPLORATIONS (round 2).
// 6 distinct cathedral-themed aesthetic directions, all rendering the
// SAME conversation with embedded tool pills so they can be graded
// apples-to-apples.
//
// Round 1 (still rendered): illuminated / stele / versicle
// Round 2 (new): brutalist / ledger / oracle
//
// Same conversation in every direction:
//   USER: hello, refactor the auth flow to use the new session pattern.
//   SUMO: Reading the auth flow.
//         [read] src/auth/session.ts ✓
//         [edit] src/auth/session.ts ✓
//         Done. Updated 14 lines, deleted 6 stale helpers.
//   USER: run tests
//   SUMO: Running tests now.
//         [bash] pnpm test src/auth (22 tests, 1.2s) ✓
//         All 22 tests pass.

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(repoRoot, "docs", "ui", "bible");

function rep(ch, n) { return ch.repeat(n); }

function wrap(text, width) {
	const words = text.split(/\s+/);
	const lines = [];
	let cur = "";
	for (const w of words) {
		if (cur.length === 0) cur = w;
		else if (cur.length + 1 + w.length <= width) cur += " " + w;
		else { lines.push(cur); cur = w; }
	}
	if (cur) lines.push(cur);
	return lines;
}

function visibleLen(s) {
	return s.replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").length;
}


// ─── conversation data (with embedded tool pills) ────────────────────────
const conversation = [
	{ role: "USER", time: "11:42", body: "hello, refactor the auth flow to use the new session pattern." },
	{
		role: "SUMO",
		model: "claude-opus-4-7",
		time: "11:42",
		body: "Reading the auth flow.",
		tools: [
			{ name: "read", target: "src/auth/session.ts", status: "ok" },
			{ name: "edit", target: "src/auth/session.ts", status: "ok" },
		],
		footer: "Done. Updated 14 lines, deleted 6 stale helpers.",
	},
	{ role: "USER", time: "11:43", body: "run tests" },
	{
		role: "SUMO",
		model: "claude-opus-4-7",
		time: "11:43",
		body: "Running tests now.",
		tools: [
			{ name: "bash", target: "pnpm test src/auth", status: "ok", note: "22 tests, 1.2s" },
		],
		footer: "All 22 tests pass.",
	},
];

const STATUS_GLYPH = { ok: "✓", running: "▶", failed: "✗" };
const STATUS_CLASS = { ok: "fg-idle", running: "fg-tool", failed: "fg-approve" };


// Compact tool pill: ✓ [name]  target  · note
// Used by minimalist directions
function toolPillCompact(tool) {
	const statusGlyph = STATUS_GLYPH[tool.status];
	const statusClass = STATUS_CLASS[tool.status];
	const note = tool.note ? `<span class="fg-dim">  · ${tool.note}</span>` : "";
	return (
		`<span class="${statusClass}">${statusGlyph}</span> ` +
		`<span class="fg-accent">[${tool.name}]</span>` +
		`<span class="fg-fg">  ${tool.target}</span>` +
		note
	);
}

// ═════════════════════════════════════════════════════════════════════════
// ROUND 1 — Illuminated · Stele · Versicle
// ═════════════════════════════════════════════════════════════════════════




// ═════════════════════════════════════════════════════════════════════════
// ROUND 2 — Brutalist · Ledger · Oracle
// ═════════════════════════════════════════════════════════════════════════




// ═════════════════════════════════════════════════════════════════════════

// Direction 7A — BOXED / REFINED ROUNDED (the LOCKED default)
//   Each message in its own ╭─╮ │ │ ╰─╯ box. ALL boxes are TRANSPARENT
//   (no bg fill) — just the frame chars sitting on terminal default bg.
//   Single-tone simplicity. Dual-tone (7C) is the opt-in toggle.
function buildBoxedRefinedHTML({ messages, cols }) {
	return buildBoxedGeneric({
		messages, cols,
		corners: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
		bgFor: () => null, // transparent — no bg fill
		spacingBetweenBoxes: 1,
		headerDivider: false,
	});
}

// Direction 7B — BOXED / SHARP TABLET
//   Sharp corners ┌─┐ │ │ └─┘, surface-recess (darker) bg, ═══ header
//   divider rule inside each box, tight inter-box spacing (no blank rows).
//   Feels like stacked stone tablets.
function buildBoxedSharpTabletHTML({ messages, cols }) {
	return buildBoxedGeneric({
		messages, cols,
		corners: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
		bgFor: () => "var(--surface-recess)",
		spacingBetweenBoxes: 0,
		headerDivider: true,
	});
}

// Direction 7C — BOXED / DUAL-TONE
//   Rounded corners. USER box stays TRANSPARENT (just the frame, like default).
//   SUMO box gets `surface-lifted` warm-amber fill on its interior. Role
//   distinction is one-sided: only the assistant pops; the user reads as
//   typed input flush against the terminal bg.
function buildBoxedDualToneHTML({ messages, cols }) {
	return buildBoxedGeneric({
		messages, cols,
		corners: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
		bgFor: (msg) => msg.role === "USER" ? null : "var(--surface-lifted)",
		spacingBetweenBoxes: 1,
		headerDivider: false,
	});
}

// Generic boxed builder — driven by config object.
// IMPORTANT: bg is applied to the body CONTENT span only, NOT to frame chars
// or the <pre> wrapper. So the rounded/sharp corners sit on terminal-default
// bg and the warm/recess fill is ONLY the interior of the box (between │
// verticals), matching how a real terminal would render box-with-bg-fill.
function buildBoxedGeneric({ messages, cols, corners, bgFor, spacingBetweenBoxes, headerDivider }) {
	const innerCols = cols - 4;
	const blocks = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const rows = [];

		// Top border: ╭ <ROLE> <dashes> [<time>] <corner-tr>
		// USER:  ╭ USER ───────...──────╮            (no metadata)
		// SUMO:  ╭ SUMO ───────...─ 11:42 ╮        (time right-aligned)
		let leftPart, leftLen, rightPart, rightLen;
		if (msg.role === "USER") {
			leftPart =
				`<span class="fg-divider">${corners.tl} </span>` +
				`<span class="fg-fg">USER</span> `;
			leftLen = 7; // tl + sp + USER(4) + sp
			rightPart = `<span class="fg-divider">${corners.tr}</span>`;
			rightLen = 1;
		} else {
			leftPart =
				`<span class="fg-divider">${corners.tl} </span>` +
				`<span class="fg-accent">SUMO</span> `;
			leftLen = 7; // tl + sp + SUMO(4) + sp
			rightPart =
				` <span class="fg-dim">${msg.time}</span> ` +
				`<span class="fg-divider">${corners.tr}</span>`;
			rightLen = 1 + msg.time.length + 1 + 1; // sp + time + sp + tr
		}
		const topDashLen = cols - leftLen - rightLen;
		rows.push(
			leftPart +
			`<span class="fg-divider">${rep(corners.h, topDashLen)}</span>` +
			rightPart,
		);

		const bg = bgFor(msg);
		const bgStyle = bg ? ` style="background: ${bg}"` : "";
		const bodyRow = (contentHTML, contentLen) => {
			const padLen = innerCols - contentLen;
			// Frame verticals: no bg (terminal default).
			// Interior content + padding: wrap in a single inline-block span with
			// bg fill that covers the FULL row height (matches TUI uniform render).
			const innerCellWidth = innerCols + 2; // content + 2 padding spaces
			const widthStyle = `width: ${innerCellWidth}ch`;
			const combinedStyle = bgStyle ? bgStyle.replace('"', `"${widthStyle}; `) : ` style="${widthStyle}"`;
			return (
				`<span class="fg-divider">${corners.v}</span>` +
				`<span class="box-fill"${combinedStyle}> ` + contentHTML + rep(" ", padLen) + ` </span>` +
				`<span class="fg-divider">${corners.v}</span>`
			);
		};
		const blankRow = () => bodyRow("", 0);

		// Optional header divider rule (═══ inside) immediately after the title row
		if (headerDivider) {
			rows.push(
				`<span class="fg-divider">${corners.v}</span>` +
				`<span class="box-fill"${bgStyle}> <span class="fg-divider">${rep("═", innerCols)}</span> </span>` +
				`<span class="fg-divider">${corners.v}</span>`,
			);
		}

		if (msg.body) {
			const wrapped = wrap(msg.body, innerCols);
			for (const line of wrapped) {
				rows.push(bodyRow(`<span class="fg-fg">${line}</span>`, line.length));
			}
		}

		if (msg.tools) {
			for (const tool of msg.tools) {
				rows.push(blankRow());
				const pillHTML = toolPillCompact(tool);
				rows.push(bodyRow(pillHTML, visibleLen(pillHTML)));
			}
		}

		if (msg.footer) {
			rows.push(blankRow());
			const wrapped = wrap(msg.footer, innerCols);
			for (const line of wrapped) {
				rows.push(bodyRow(`<span class="fg-fg">${line}</span>`, line.length));
			}
		}

		rows.push(`<span class="fg-divider">${corners.bl}${rep(corners.h, cols - 2)}${corners.br}</span>`);

		blocks.push({ rows });

		if (i < messages.length - 1) {
			for (let s = 0; s < spacingBetweenBoxes; s++) {
				blocks.push({ rows: [""] });
			}
		}
	}

	// Single <pre> per block. No bg on the pre — each body row paints its own
	// interior bg via inline span. Frame chars stay transparent (terminal default).
	return blocks
		.map((b) => `<pre class="grid">${b.rows.join("\n")}</pre>`)
		.join("\n");
}

function htmlPage({ title, label, blurb, cols, gridRows, customHTML }) {
	const body = customHTML ? customHTML : `<pre class="grid">${gridRows.join("\n")}</pre>`;
	const rowCount = customHTML ? ((customHTML.match(/\n/g)?.length ?? 1) + 1) : gridRows.length;
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
  <div data-render-rect class="term" style="--term-cols: ${cols}; --term-rows: ${rowCount};">
    ${body}
  </div>
</div>
</body>
</html>
`;
}

// ELEMENT 13 LOCKED: 7A REFINED ROUNDED single-tone (rounded corners, surface
// bg interior, 1 blank row between boxes). 7B sharp-tablet + 7C dual-tone are
// available alts via /sumo:chat-style {default|sharp|dual} slash command.
const explorations = [
	{ filename: "13-chat-boxed-a-refined.html", buildHTML: buildBoxedRefinedHTML,
		title: "Bible · Element 13 · BOXED 7A · REFINED ROUNDED · LOCKED DEFAULT",
		label: "element 13 · LOCKED · ╭─╮ refined rounded · single-tone surface bg · 130 cols",
		blurb: "→ LOCKED DEFAULT. rounded corners ╭─╮ │ │ ╰─╯. single warm surface bg fill on box interior. 1 blank row between boxes. boxes feel elevated — message cards.",
	},
	{ filename: "13-chat-boxed-b-sharp-tablet.html", buildHTML: buildBoxedSharpTabletHTML,
		title: "Bible · Element 13 · BOXED 7B · SHARP TABLET · ALT",
		label: "element 13 · alt · ┌─┐ sharp tablet · recess bg · ═ header rule · 130 cols",
		blurb: "alt via /sumo:chat-style sharp. sharp corners ┌─┐ │ │ └─┘. surface-recess bg interior (DARKER than terminal). ═══ header divider rule. tight inter-box spacing (no blanks). stacked stone tablets.",
	},
	{ filename: "13-chat-boxed-c-dual-tone.html", buildHTML: buildBoxedDualToneHTML,
		title: "Bible · Element 13 · BOXED 7C · DUAL-TONE · ALT",
		label: "element 13 · alt · ╭─╮ dual-tone · recess+lifted bg · 130 cols",
		blurb: "alt via /sumo:chat-style dual. rounded corners. USER box recess (darker, like input frame). SUMO box surface-lifted (warm amber). role distinguished by bg tone, not just label color.",
	},
	// Portrait variant of locked default (60 cols, sidebar hidden)
	{ filename: "13-chat-boxed-a-refined-portrait.html", buildHTML: buildBoxedRefinedHTML,
		title: "Bible · Element 13 · BOXED 7A · PORTRAIT · LOCKED DEFAULT",
		label: "element 13 · LOCKED · portrait 60 cols (sidebar hidden, chat full-width)",
		blurb: "→ LOCKED DEFAULT · portrait dim variant. same boxed pattern at 60 cols. sidebar hidden when terminal width < 120 — chat takes full width.",
		cols: 60,
	},
];

for (const e of explorations) {
	const cols = e.cols ?? 130;
	const path = resolve(out, e.filename);
	if (e.buildHTML) {
		const customHTML = e.buildHTML({ messages: conversation, cols });
		writeFileSync(path, htmlPage({ ...e, cols, customHTML }));
		const rowCount = (customHTML.match(/\n/g)?.length ?? 1) + 1;
		console.log(`wrote ${e.filename}  (${cols}×${rowCount}) [boxed]`);
	} else {
		const gridRows = e.build({ messages: conversation, cols });
		writeFileSync(path, htmlPage({ ...e, cols, gridRows }));
		console.log(`wrote ${e.filename}  (${cols}×${gridRows.length})`);
	}
}
