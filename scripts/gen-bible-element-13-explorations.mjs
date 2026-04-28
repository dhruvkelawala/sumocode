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

function padRight(line, cols) {
	const need = cols - visibleLen(line);
	return need > 0 ? line + rep(" ", need) : line;
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

// ─── tool pill renderers ────────────────────────────────────────────────
// Spec default: ━━━ [name]  target ━━━ status
// Returns array of HTML row strings, NOT padded (caller pads with prefix)
function toolPillSpecDefault(tool, innerCols) {
	const left = `[${tool.name}]  ${tool.target}`;
	const statusGlyph = STATUS_GLYPH[tool.status];
	const statusClass = STATUS_CLASS[tool.status];
	const note = tool.note ? `  ${tool.note}` : "";
	const right = `${statusGlyph}${note}`;
	const rule = "━━━";
	// Layout: ━━━ [name]  target  ━━━ ✓ note
	const used = visibleLen(`${rule} ${left} ${rule} ${right}`);
	const padLen = Math.max(1, innerCols - used);
	return (
		`<span class="fg-divider">${rule}</span> ` +
		`<span class="fg-accent">[${tool.name}]</span>` +
		`<span class="fg-fg">  ${tool.target}</span>` +
		rep(" ", padLen) +
		`<span class="fg-divider">${rule}</span> ` +
		`<span class="${statusClass}">${statusGlyph}</span>` +
		(tool.note ? `<span class="fg-dim">  ${tool.note}</span>` : "")
	);
}

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

function buildIlluminated({ messages, cols }) {
	const rows = [];
	const indent = "   ";
	const innerCols = cols - 3;
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const glyph = msg.role === "USER" ? "◊" : "❧";
		const glyphClass = msg.role === "USER" ? "fg-fg" : "fg-accent";

		// First body line on glyph row
		const wrapped = msg.body ? wrap(msg.body, innerCols) : [""];
		const first = wrapped[0];
		rows.push(padRight(
			`<span class="${glyphClass}">${glyph}</span>  ` +
				(first ? `<span class="fg-fg">${first}</span>` : ""),
			cols,
		));
		for (let j = 1; j < wrapped.length; j++) {
			rows.push(padRight(`${indent}<span class="fg-fg">${wrapped[j]}</span>`, cols));
		}

		// Tool pills (compact style for illuminated)
		if (msg.tools) {
			for (const tool of msg.tools) {
				rows.push(padRight("", cols)); // spacer above
				rows.push(padRight(`${indent}${toolPillCompact(tool)}`, cols));
			}
		}

		// Footer text after tools
		if (msg.footer) {
			const footerLines = wrap(msg.footer, innerCols);
			rows.push(padRight("", cols));
			for (const line of footerLines) {
				rows.push(padRight(`${indent}<span class="fg-fg">${line}</span>`, cols));
			}
		}

		// Metadata rule (sumo only)
		if (msg.role === "SUMO") {
			rows.push(padRight(
				`${indent}<span class="fg-divider">─</span> <span class="fg-dim">${msg.model} · ${msg.time}</span>`,
				cols,
			));
		}

		if (i < messages.length - 1) rows.push(padRight("", cols));
	}
	return rows;
}

function buildStele({ messages, cols }) {
	const rows = [];
	const trackOut = (s) => s.split("").join(" ");
	const rail = `<span class="fg-divider">│</span> `;
	const innerCols = cols - 2;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

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
		rows.push(padRight(rail + `<span class="fg-accent">─────</span>`, cols));

		if (msg.body) {
			const wrapped = wrap(msg.body, innerCols);
			for (const line of wrapped) {
				rows.push(padRight(rail + `<span class="fg-fg">${line}</span>`, cols));
			}
		}

		if (msg.tools) {
			for (const tool of msg.tools) {
				rows.push(padRight(rail.replace(/ $/, ""), cols));
				rows.push(padRight(rail + toolPillCompact(tool), cols));
			}
		}

		if (msg.footer) {
			const wrapped = wrap(msg.footer, innerCols);
			rows.push(padRight(rail.replace(/ $/, ""), cols));
			for (const line of wrapped) {
				rows.push(padRight(rail + `<span class="fg-fg">${line}</span>`, cols));
			}
		}

		if (i < messages.length - 1) {
			rows.push(padRight(rail.replace(/ $/, ""), cols));
			rows.push(padRight(rail.replace(/ $/, ""), cols));
		}
	}
	return rows;
}

function buildVersicle({ messages, cols }) {
	const rows = [];
	const indent = "    ";
	const innerCols = cols - 4;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const symbol = msg.role === "USER" ? "℣." : "℟.";
		const symbolClass = msg.role === "USER" ? "fg-fg" : "fg-accent";

		const wrapped = msg.body ? wrap(msg.body, innerCols) : [""];
		const first = wrapped[0];
		rows.push(padRight(
			`<span class="${symbolClass}">${symbol}</span>  ` +
				(first ? `<span class="fg-fg">${first}</span>` : ""),
			cols,
		));
		for (let j = 1; j < wrapped.length; j++) {
			rows.push(padRight(`${indent}<span class="fg-fg">${wrapped[j]}</span>`, cols));
		}

		if (msg.tools) {
			for (const tool of msg.tools) {
				rows.push(padRight("", cols));
				rows.push(padRight(`${indent}${toolPillCompact(tool)}`, cols));
			}
		}

		if (msg.footer) {
			const wrapped = wrap(msg.footer, innerCols);
			rows.push(padRight("", cols));
			for (const line of wrapped) {
				rows.push(padRight(`${indent}<span class="fg-fg">${line}</span>`, cols));
			}
		}

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

// ═════════════════════════════════════════════════════════════════════════
// ROUND 2 — Brutalist · Ledger · Oracle
// ═════════════════════════════════════════════════════════════════════════

// Direction 4 — BRUTALIST / RAW
//   Heavy ━━━ rules above each turn. [USER] / [SUMO] brackets.
//   metadata in (parens, lowercase). No frame, no decoration.
function buildBrutalist({ messages, cols }) {
	const rows = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		// Heavy rule
		rows.push(padRight(`<span class="fg-divider">${rep("━", cols)}</span>`, cols));

		// Role + metadata
		let roleLine;
		if (msg.role === "USER") {
			roleLine = `<span class="fg-fg">[USER]</span>`;
		} else {
			roleLine =
				`<span class="fg-accent">[SUMO]</span>` +
				`<span class="fg-dim"> (${msg.model}, ${msg.time})</span>`;
		}
		rows.push(padRight(roleLine, cols));
		rows.push(padRight("", cols));

		// Body (no indent)
		if (msg.body) {
			const wrapped = wrap(msg.body, cols);
			for (const line of wrapped) rows.push(padRight(`<span class="fg-fg">${line}</span>`, cols));
		}

		if (msg.tools) {
			for (const tool of msg.tools) {
				rows.push(padRight("", cols));
				rows.push(padRight(toolPillSpecDefault(tool, cols), cols));
			}
		}

		if (msg.footer) {
			rows.push(padRight("", cols));
			const wrapped = wrap(msg.footer, cols);
			for (const line of wrapped) rows.push(padRight(`<span class="fg-fg">${line}</span>`, cols));
		}

		if (i < messages.length - 1) rows.push(padRight("", cols));
	}
	// Trailing rule
	rows.push(padRight(`<span class="fg-divider">${rep("━", cols)}</span>`, cols));
	return rows;
}

// Direction 5 — LEDGER / SCRIPTORIUM-LEDGER
//   Numbered entries with right-aligned timestamp.
//   001 │ USER                                                  11:42:33
//       │ body
//   002 │ SUMO · model                                          11:42:48
//       │ body
function buildLedger({ messages, cols }) {
	const rows = [];
	const numWidth = 3; // "001"
	const sepWidth = 3; // " │ "
	const prefixWidth = numWidth + sepWidth; // 6
	const innerCols = cols - prefixWidth;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const num = String(i + 1).padStart(numWidth, "0");
		const numHTML = `<span class="fg-dim">${num}</span>`;
		const sepHTML = `<span class="fg-dim"> │ </span>`;
		const indentBlank = `<span class="fg-dim">${rep(" ", numWidth)} │ </span>`;

		// First row: NUM │ ROLE [· model] ………… time:ss
		let leftRole;
		let timestamp = `${msg.time}:33`; // fake seconds
		if (msg.role === "USER") {
			leftRole = `<span class="fg-fg">USER</span>`;
		} else {
			leftRole =
				`<span class="fg-accent">SUMO</span>` +
				`<span class="fg-dim"> · ${msg.model}</span>`;
		}
		const leftLen = visibleLen(leftRole);
		const tsLen = timestamp.length;
		const padLen = innerCols - leftLen - tsLen;
		rows.push(padRight(
			numHTML + sepHTML + leftRole + rep(" ", Math.max(1, padLen)) + `<span class="fg-dim">${timestamp}</span>`,
			cols,
		));

		// Body rows with continuation prefix
		if (msg.body) {
			const wrapped = wrap(msg.body, innerCols);
			for (const line of wrapped) rows.push(padRight(indentBlank + `<span class="fg-fg">${line}</span>`, cols));
		}

		if (msg.tools) {
			for (const tool of msg.tools) {
				rows.push(padRight(indentBlank.replace(" │ ", " │ ").replace(/ $/, ""), cols));
				rows.push(padRight(indentBlank + toolPillCompact(tool), cols));
			}
		}

		if (msg.footer) {
			rows.push(padRight(indentBlank.replace(/ $/, ""), cols));
			const wrapped = wrap(msg.footer, innerCols);
			for (const line of wrapped) rows.push(padRight(indentBlank + `<span class="fg-fg">${line}</span>`, cols));
		}

		if (i < messages.length - 1) rows.push(padRight("", cols));
	}
	return rows;
}

// Direction 6 — ORACLE TABLET / TWO-COLUMN
//   Speaker on left (right-aligned in fixed column), content on right.
//             USER  │  body...
//                   │  more body
//
//             SUMO  │  Reading the auth flow.
//   claude-opus-4-7  │  ...
//             11:42  │
//                   │  Done.
function buildOracle({ messages, cols }) {
	const rows = [];
	const speakerCol = 16; // width of left column (right-aligned)
	const sepCol = 3;       // " │ "
	const innerCols = cols - speakerCol - sepCol;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		// Build left-column lines (speaker name, model, time as separate rows
		// for SUMO; just speaker for USER)
		const speakerLines = [];
		if (msg.role === "USER") {
			speakerLines.push({ text: "USER", cls: "fg-fg" });
		} else {
			speakerLines.push({ text: "SUMO", cls: "fg-accent" });
			speakerLines.push({ text: msg.model, cls: "fg-dim" });
			speakerLines.push({ text: msg.time, cls: "fg-dim" });
		}

		// Build right-column body lines
		const rightLines = [];
		if (msg.body) rightLines.push(...wrap(msg.body, innerCols));
		if (msg.tools) {
			for (const tool of msg.tools) {
				rightLines.push("");
				rightLines.push({ tool });
			}
		}
		if (msg.footer) {
			rightLines.push("");
			rightLines.push(...wrap(msg.footer, innerCols));
		}

		const totalLines = Math.max(speakerLines.length, rightLines.length);
		for (let r = 0; r < totalLines; r++) {
			const speaker = speakerLines[r];
			const right = rightLines[r];
			const speakerStr = speaker
				? `<span class="${speaker.cls}">${speaker.text}</span>`
				: "";
			const speakerPad = speakerCol - (speaker ? speaker.text.length : 0);
			const sep = `<span class="fg-divider"> │ </span>`;
			let rightStr = "";
			if (right && typeof right === "string") {
				rightStr = right ? `<span class="fg-fg">${right}</span>` : "";
			} else if (right && typeof right === "object" && right.tool) {
				rightStr = toolPillCompact(right.tool);
			}
			rows.push(padRight(rep(" ", speakerPad) + speakerStr + sep + rightStr, cols));
		}

		if (i < messages.length - 1) rows.push(padRight("", cols));
	}
	return rows;
}

// ═════════════════════════════════════════════════════════════════════════

// Direction 7A — BOXED / REFINED ROUNDED (the default)
//   Each message in its own ╭─╮ │ │ ╰─╯ box with surface bg fill.
//   Returns full HTML (multi-<pre>) so each box can have its own bg.
//
// Variants below (7B, 7C) share the same structural skeleton but differ in:
//   - corner glyphs (rounded vs sharp)
//   - bg color (surface / recess / lifted, sometimes per-role)
//   - inter-box spacing (blank vs tight)
//   - intra-box header divider (none vs ═══)
function buildBoxedRefinedHTML({ messages, cols }) {
	return buildBoxedGeneric({
		messages, cols,
		corners: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
		bgFor: () => "var(--surface)",
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
//   Rounded corners. USER uses surface-recess (darker, like input). SUMO uses
//   surface-lifted (slightly elevated). Role distinction via bg tone instead
//   of via label color alone.
function buildBoxedDualToneHTML({ messages, cols }) {
	return buildBoxedGeneric({
		messages, cols,
		corners: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
		bgFor: (msg) => msg.role === "USER" ? "var(--surface-recess)" : "var(--surface-lifted)",
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
			return (
				`<span class="fg-divider">${corners.v}</span>` +
				`<span class="box-fill"${bgStyle}> ` + contentHTML + rep(" ", padLen) + ` </span>` +
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
	const grid = gridRows ? gridRows.join("\n") : "";
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

const explorations = [
	// ROUND 1
	{ filename: "13-chat-illuminated.html", build: buildIlluminated,
		title: "Bible · Element 13 · ILLUMINATED MANUSCRIPT",
		label: "element 13 · #1 ILLUMINATED MANUSCRIPT · 130 cols",
		blurb: "drop-cap glyphs (◊ user, ❧ sumo). body indented col 4. no frame. metadata rule after sumo. illuminated codex page.",
	},
	{ filename: "13-chat-stele.html", build: buildStele,
		title: "Bible · Element 13 · STELE / INSCRIPTION",
		label: "element 13 · #2 STELE / INSCRIPTION · 130 cols",
		blurb: "tracked-out role labels (U S E R). accent underline rule under each. left-rail │ anchors the column. carved-in-stone.",
	},
	{ filename: "13-chat-versicle.html", build: buildVersicle,
		title: "Bible · Element 13 · VERSICLE & RESPONSE",
		label: "element 13 · #3 VERSICLE & RESPONSE · 130 cols",
		blurb: "liturgical call-and-response (℣. user / ℟. sumo). indented body. cathedral-as-liturgy.",
	},
	// ROUND 2
	{ filename: "13-chat-brutalist.html", build: buildBrutalist,
		title: "Bible · Element 13 · BRUTALIST / RAW",
		label: "element 13 · #4 BRUTALIST · 130 cols",
		blurb: "heavy ━━━ rules above each turn. [USER] / [SUMO] brackets. metadata in (parens, lowercase). raw, function-first, no decoration.",
	},
	{ filename: "13-chat-ledger.html", build: buildLedger,
		title: "Bible · Element 13 · LEDGER / SCRIPTORIUM",
		label: "element 13 · #5 LEDGER / SCRIPTORIUM · 130 cols",
		blurb: "numbered entries (001, 002, …) with right-aligned timestamps. continuation prefix on body rows. structured, audit-trail feel.",
	},
	{ filename: "13-chat-boxed-a-refined.html", buildHTML: buildBoxedRefinedHTML,
		title: "Bible · Element 13 · BOXED 7A · REFINED ROUNDED",
		label: "element 13 · #7A REFINED ROUNDED · 130 cols",
		blurb: "rounded corners ╭─╮ │ │ ╰─╯. surface bg fill (slightly lighter than terminal bg). 1 blank row between boxes. boxes feel elevated — message cards.",
	},
	{ filename: "13-chat-boxed-b-sharp-tablet.html", buildHTML: buildBoxedSharpTabletHTML,
		title: "Bible · Element 13 · BOXED 7B · SHARP TABLET",
		label: "element 13 · #7B SHARP TABLET · 130 cols",
		blurb: "sharp corners ┌─┐ │ │ └─┘. surface-recess bg (DARKER than terminal). ═══ header divider rule inside each box separating title from body. tight inter-box spacing (no blanks). feels like stacked stone tablets.",
	},
	{ filename: "13-chat-boxed-c-dual-tone.html", buildHTML: buildBoxedDualToneHTML,
		title: "Bible · Element 13 · BOXED 7C · DUAL-TONE",
		label: "element 13 · #7C DUAL-TONE · 130 cols",
		blurb: "rounded corners. USER uses surface-recess (darker, like input frame). SUMO uses surface-lifted (slightly elevated). role distinguished by bg tone, not just label color.",
	},
	{ filename: "13-chat-oracle.html", build: buildOracle,
		title: "Bible · Element 13 · ORACLE TABLET / TWO-COLUMN",
		label: "element 13 · #6 ORACLE TABLET · 130 cols",
		blurb: "two-column dialog. speaker right-aligned in left column (16 cells), content in right column. like reading transcribed oratory.",
	},
];

for (const e of explorations) {
	const cols = 130;
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
