#!/usr/bin/env node
// Element 13 — DESIGN EXPLORATIONS using frontend-design skill principles.
// Three distinctive cathedral-themed directions for chat messages.
// User compares them in the gallery, picks one, we lock the chosen direction
// and delete the others.

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

function padRight(line, cols) {
	const visible = line.replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").length;
	const need = cols - visible;
	return need > 0 ? line + rep(" ", need) : line;
}

const conversation = [
	{ role: "USER", body: "hello, refactor the auth flow to use the new session pattern." },
	{
		role: "SUMO",
		model: "claude-opus-4-7",
		time: "11:42",
		body: "Reading the auth flow now to understand the current pattern.\n\nDone. Updated 14 lines, deleted 6 stale helpers.",
	},
	{ role: "USER", body: "run tests" },
	{
		role: "SUMO",
		model: "claude-opus-4-7",
		time: "11:43",
		body: "All 22 tests pass.",
	},
];

// ─────────────────────────────────────────────────────────────────────────
// Direction 1 — ILLUMINATED MANUSCRIPT
//   Drop-cap glyph, body indented to col 4, no frame, metadata rule after sumo.
//   ◊  user message wrapped to (cols-3)
//      continued
//
//   ❧  sumo message wrapped
//      ─ model · time
// ─────────────────────────────────────────────────────────────────────────
function buildIlluminated({ messages, cols }) {
	const rows = [];
	const indent = "   "; // 3 chars
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const glyph = msg.role === "USER" ? "◊" : "❧";
		const glyphClass = msg.role === "USER" ? "fg-fg" : "fg-accent";
		const bodyLines = msg.body.split("\n").flatMap((seg) =>
			seg.length === 0 ? [""] : wrap(seg, cols - 3),
		);

		// First body line on the same row as the glyph
		const first = bodyLines[0] ?? "";
		const firstRow =
			`<span class="${glyphClass}">${glyph}</span>` +
			`  ` +
			(first ? `<span class="fg-fg">${first}</span>` : "");
		rows.push(padRight(firstRow, cols));

		// Remaining body lines indented
		for (let j = 1; j < bodyLines.length; j++) {
			const line = bodyLines[j];
			const r = line ? `${indent}<span class="fg-fg">${line}</span>` : indent;
			rows.push(padRight(r, cols));
		}

		// SUMO metadata rule — `─ model · time` indented
		if (msg.role === "SUMO") {
			rows.push(padRight(
				`${indent}<span class="fg-divider">─</span> <span class="fg-dim">${msg.model} · ${msg.time}</span>`,
				cols,
			));
		}

		// Blank separator between messages
		if (i < messages.length - 1) rows.push(padRight("", cols));
	}
	return rows;
}

// ─────────────────────────────────────────────────────────────────────────
// Direction 2 — STELE / INSCRIPTION
//   Left-rail │, tracked-out role labels, accent underline rule, body lines.
//   │
//   │ U S E R
//   │ ─────
//   │ user message wrapped
//   │
//   │ S U M O · model · time
//   │ ─────
//   │ sumo message wrapped
// ─────────────────────────────────────────────────────────────────────────
function buildStele({ messages, cols }) {
	const rows = [];
	const trackOut = (s) => s.split("").join(" ");
	const rail = `<span class="fg-divider">│</span> `; // 2 chars

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		// Role line
		let roleLine;
		if (msg.role === "USER") {
			roleLine = rail + `<span class="fg-fg">${trackOut("USER")}</span>`;
		} else {
			roleLine =
				rail +
				`<span class="fg-accent">${trackOut("SUMO")}</span>` +
				`<span class="fg-dim"> · ${msg.model} · ${msg.time}</span>`;
		}
		rows.push(padRight(roleLine, cols));

		// Underline rule (5 dashes in accent)
		rows.push(padRight(rail + `<span class="fg-accent">─────</span>`, cols));

		// Body lines, each prefixed by rail
		const bodyLines = msg.body.split("\n").flatMap((seg) =>
			seg.length === 0 ? [""] : wrap(seg, cols - 2),
		);
		for (const line of bodyLines) {
			const r = line ? rail + `<span class="fg-fg">${line}</span>` : rail.replace(/ $/, "");
			rows.push(padRight(r, cols));
		}

		// 2 blank-rail rows between messages
		if (i < messages.length - 1) {
			rows.push(padRight(rail.replace(/ $/, ""), cols));
			rows.push(padRight(rail.replace(/ $/, ""), cols));
		}
	}
	return rows;
}

// ─────────────────────────────────────────────────────────────────────────
// Direction 3 — VERSICLE & RESPONSE
//   ℣. user message
//      continued
//
//   ℟. sumo message
//      continued
//      model · time
// ─────────────────────────────────────────────────────────────────────────
function buildVersicle({ messages, cols }) {
	const rows = [];
	const indent = "    "; // 4 chars (after `℣. `)

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const symbol = msg.role === "USER" ? "℣." : "℟.";
		const symbolClass = msg.role === "USER" ? "fg-fg" : "fg-accent";

		const bodyLines = msg.body.split("\n").flatMap((seg) =>
			seg.length === 0 ? [""] : wrap(seg, cols - 4),
		);

		const first = bodyLines[0] ?? "";
		const firstRow =
			`<span class="${symbolClass}">${symbol}</span>` +
			`  ` +
			(first ? `<span class="fg-fg">${first}</span>` : "");
		rows.push(padRight(firstRow, cols));

		for (let j = 1; j < bodyLines.length; j++) {
			const line = bodyLines[j];
			const r = line ? `${indent}<span class="fg-fg">${line}</span>` : indent;
			rows.push(padRight(r, cols));
		}

		// SUMO metadata as last row of the message, indented, dim
		if (msg.role === "SUMO") {
			rows.push(padRight(
				`${indent}<span class="fg-dim">${msg.model} · ${msg.time}</span>`,
				cols,
			));
		}

		if (i < messages.length - 1) rows.push(padRight("", cols));
	}
	return rows;
}

function htmlPage({ title, label, cols, rows, gridRows, blurb }) {
	const grid = gridRows.join("\n");
	const blurbHTML = blurb ? `\n  <div class="stage-blurb">${blurb}</div>` : "";
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="_assets/tokens.css">
<style>
  .stage-blurb {
    max-width: 130ch;
    color: var(--foreground-dim);
    font-size: 11px;
    line-height: 1.6;
    letter-spacing: 0.04em;
    padding: 0 8px;
    text-align: center;
  }
</style>
</head>
<body>
<div class="stage">
  <div class="stage-label">${label}</div>${blurbHTML}
  <div data-render-rect class="term" style="--term-cols: ${cols}; --term-rows: ${rows};">
    <pre class="grid">${grid}</pre>
  </div>
</div>
</body>
</html>
`;
}

const explorations = [
	{
		filename: "13-chat-illuminated.html",
		title: "Bible · Element 13 · ILLUMINATED MANUSCRIPT",
		label: "element 13 · direction 1 · ILLUMINATED MANUSCRIPT · 130×17",
		blurb: "drop-cap glyphs (◊ user, ❧ sumo), body indented to col 4, no frame. metadata rule after sumo turn. reads like an illuminated codex page.",
		cols: 130,
		build: buildIlluminated,
	},
	{
		filename: "13-chat-stele.html",
		title: "Bible · Element 13 · STELE / INSCRIPTION",
		label: "element 13 · direction 2 · STELE / INSCRIPTION · 130×24",
		blurb: "tracked-out role labels (U S E R), accent underline rule under each label, single left-rail │ anchoring the conversation column. feels carved.",
		cols: 130,
		build: buildStele,
	},
	{
		filename: "13-chat-versicle.html",
		title: "Bible · Element 13 · VERSICLE & RESPONSE",
		label: "element 13 · direction 3 · VERSICLE & RESPONSE · 130×17",
		blurb: "liturgical call-and-response symbols (℣. versicle / ℟. response). indented body. cathedral-as-liturgy: the conversation literally takes the form of an oratory exchange.",
		cols: 130,
		build: buildVersicle,
	},
];

for (const e of explorations) {
	const gridRows = e.build({ messages: conversation, cols: e.cols });
	const path = resolve(out, e.filename);
	writeFileSync(path, htmlPage({
		...e,
		rows: gridRows.length,
		gridRows,
	}));
	console.log(`wrote ${e.filename}  (${e.cols}×${gridRows.length})`);
}
