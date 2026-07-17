#!/usr/bin/env node
// Herdr Terminal theme — deterministic Bible target.
//
// Generates docs/ui/bible/theme-herdr-active.html: the 160×45 active-session
// runtime scene (same layout/content structure as scene-active-runtime.html)
// restyled with the Herdr token set and Herdr chrome from
// docs/ui/stitch/herdr-terminal/DESIGN.md / src/themes/herdr.ts.
//
// Layout is IDENTICAL to the Cathedral runtime target — Herdr recolours the
// locked V2 layout and swaps chrome glyphs only:
//   - message/input frames use sharp 90° corners (┌ ┐ └ ┘)
//   - sidebar section headers are untracked with ASCII sigils (> # @ $ %)
//   - tab markers are ▸ (active) / · (inactive), rules are ─
//   - palette is the approved v7 green-black set; electric-green focus/body,
//     amber tool/learning, red approval (no cyan/teal/blue/purple)

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(repoRoot, "docs", "ui", "bible");

const COLS = 160;
const ROWS = 45;
const SIDEBAR_COLS = 30;

// ── Herdr palette v7 (src/themes/herdr.ts is the source of truth) ──────
const HERDR = {
	background: "#040704",
	surface: "#070C08",
	surfaceRecess: "#050905",
	surfaceLifted: "#0F3D17",
	foreground: "#39FF14",
	foregroundDim: "#29B938",
	divider: "#176B22",
	accent: "#39FF14",
	stateIdle: "#29B938",
	stateThinking: "#39FF14",
	stateTool: "#FFB000",
	stateApproval: "#FF706D",
	stateLearning: "#FFD166",
};

const rep = (ch, n) => ch.repeat(n);
const visibleLen = (s) =>
	s.replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").length;
const padRight = (s, n) => {
	const need = n - visibleLen(s);
	return need > 0 ? s + rep(" ", need) : s;
};

// ─── Sidebar (V2 EDITORIAL layout, Herdr chrome: sigils, ▸/·, ─ rules) ──
function buildSidebarRows() {
	const rows = [];
	const cell = (h) =>
		`<span class="box-fill" style="background: var(--surface); width: ${SIDEBAR_COLS}ch">` +
		padRight(h, SIDEBAR_COLS) +
		`</span>`;
	const blank = () => cell("");

	rows.push(blank());
	rows.push(cell(`  <span class="fg-accent">% REGISTRY</span>`));
	rows.push(blank());

	rows.push(cell(`  <span class="fg-accent">\u25b8</span> <span class="fg-fg">&gt;  CONTEXT</span>`));
	rows.push(cell(`  <span class="fg-dim">\u00b7 #  MEMORY</span>`));
	rows.push(blank());
	rows.push(cell(`  <span class="fg-divider">${rep("\u2500", 26)}</span>`));
	rows.push(blank());

	rows.push(cell(`  <span class="fg-fg">sumocode</span>`));
	rows.push(cell(`  <span class="fg-dim">on main</span>`));
	rows.push(blank());

	rows.push(cell(`  <span class="fg-dim">&gt;  CONTEXT</span>`));
	rows.push(cell(`  <span class="fg-idle">${rep("\u2589", 5)}</span><span class="fg-divider">${rep("\u2591", 17)}</span>`));
	rows.push(cell(`  <span class="fg-fg">42k</span> <span class="fg-dim">/ 200k</span>`));
	rows.push(blank());

	rows.push(cell(`  <span class="fg-dim">$  SESSION</span>`));
	rows.push(cell(`  <span class="fg-fg">$0.42</span> <span class="fg-dim">\u00b7 3.4M cumul</span>`));
	rows.push(blank());
	rows.push(cell(`  <span class="fg-divider">${rep("\u2500", 26)}</span>`));
	rows.push(blank());

	rows.push(cell(`  <span class="fg-dim">@  MCP</span>`));
	rows.push(blank());
	const mcps = [
		{ name: "github", state: "idle" },
		{ name: "stitch", state: "ok" },
		{ name: "context7", state: "idle" },
		{ name: "chrome-dev", state: "idle" },
	];
	for (const m of mcps) {
		const dotClass = m.state === "ok" ? "fg-idle" : "fg-dim";
		const stateText = m.state;
		const pad = SIDEBAR_COLS - 4 - m.name.length - stateText.length - 2;
		rows.push(cell(
			`  <span class="${dotClass}">\u25cf</span> <span class="fg-fg">${m.name}</span>` +
			rep(" ", Math.max(1, pad)) +
			`<span class="fg-dim">${stateText}</span>  `,
		));
	}

	while (rows.length < 36) rows.push(blank());
	return rows;
}

// ─── Chat (runtime-target content, Herdr sharp-corner frames) ──────────
function buildChatHTML(cols) {
	const innerCols = cols - 4;
	const blocks = [];
	// The top USER/SUMO exchange mirrors the runtime scenario for a meaningful
	// runtime-vs-target comparison; the SUMO `extras` below are independent
	// design intent that exercise the full state palette (idle green, amber
	// tool, red approval, bright-amber learning) so a reviewer sees every
	// semantic colour in one target. Runtime capture stays minimal (review-only).
	const messages = [
		{ role: "USER", body: "review src/auth/session.ts and tighten the return type" },
		{
			role: "SUMO",
			time: "11:42",
			body: "inspecting src/auth/session.ts",
			extras: [
				{ cls: "fg-idle", glyph: "\u2713", label: "[read]", target: "src/auth/session.ts" },
				{ cls: "fg-tool", glyph: "\u25b6", label: "[edit]", target: "src/auth/session.ts · tightening return type" },
				{ cls: "fg-approve", glyph: "\u25cf", label: "approval", target: "run bash `pnpm test src/auth`?" },
				{ cls: "fg-learn", glyph: "\u2605", label: "learned", target: "session.authenticate now returns Result<User>" },
			],
		},
	];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const rows = [];

		let leftPart, leftLen, rightPart, rightLen;
		if (msg.role === "USER") {
			leftPart = `<span class="fg-divider">\u250c </span><span class="fg-fg">USER</span> `;
			leftLen = 7;
			rightPart = `<span class="fg-divider">\u2510</span>`;
			rightLen = 1;
		} else {
			leftPart = `<span class="fg-divider">\u250c </span><span class="fg-accent">SUMO</span> `;
			leftLen = 7;
			rightPart = ` <span class="fg-dim">${msg.time}</span> <span class="fg-divider">\u2510</span>`;
			rightLen = 8;
		}
		const dashLen = cols - leftLen - rightLen;
		rows.push(leftPart + `<span class="fg-divider">${rep("\u2500", dashLen)}</span>` + rightPart);

		const bodyRow = (h, len) => {
			const padLen = innerCols - len;
			return `<span class="fg-divider">\u2502</span><span class="box-fill" style="width: ${innerCols + 2}ch"> ` + h + rep(" ", padLen) + ` </span><span class="fg-divider">\u2502</span>`;
		};
		for (const line of [msg.body]) {
			rows.push(bodyRow(`<span class="fg-fg">${line}</span>`, line.length));
		}
		for (const extra of msg.extras ?? []) {
			const html = `<span class="${extra.cls}">${extra.glyph}</span> <span class="fg-accent">${extra.label}</span> <span class="fg-fg">${extra.target}</span>`;
			const len = 1 + 1 + extra.label.length + 1 + extra.target.length;
			rows.push(bodyRow(html, len));
		}
		rows.push(`<span class="fg-divider">\u2514${rep("\u2500", cols - 2)}\u2518</span>`);

		blocks.push(`<pre class="grid">${rows.join("\n")}</pre>`);
		if (i < messages.length - 1) blocks.push(`<pre class="grid"> </pre>`);
	}

	return blocks.join("\n");
}

// ─── Input frame (sharp Herdr corners, electric-green cursor block) ─────
function buildInputFrameRows(cols) {
	const innerCols = cols - 2;
	const cell = (h) =>
		`<span class="box-fill" style="background: var(--surface-recess); width: ${cols}ch">` +
		padRight(h, cols) +
		`</span>`;
	const top = `<span class="fg-divider">\u250c${rep("\u2500", innerCols)}\u2510</span>`;
	const bot = `<span class="fg-divider">\u2514${rep("\u2500", innerCols)}\u2518</span>`;
	const cursorRow =
		`<span class="fg-divider">\u2502</span> <span class="fg-accent">&gt;</span> ` +
		`<span class="cursor"> </span>` +
		rep(" ", cols - 6) +
		`<span class="fg-divider">\u2502</span>`;
	return [cell(top), cell(cursorRow), cell(bot)];
}

// ─── Chrome rows (identical structure to the Cathedral runtime target) ─
const PAD = 1;

function buildHintRow(cols) {
	const rightHTML =
		`<span class="fg-accent">CTRL+/</span>` +
		`<span class="fg-dim"> \u00b7 COMMANDS</span>`;
	const rightLen = 17;
	const lead = cols - rightLen - PAD * 2;
	return rep(" ", PAD) + rep(" ", Math.max(0, lead)) + rightHTML + rep(" ", PAD);
}

function buildFooterRow(cols) {
	const left = `<span class="fg-idle">\u25cf</span> <span class="fg-fg">READY</span><span class="fg-dim"> \u00b7 </span><span class="fg-fg">gpt-5.5</span><span class="fg-dim"> \u00b7 </span><span class="fg-fg">medium</span>`;
	const leftLen = visibleLen(left);
	const tokens = [
		{ html: `<span class="fg-fg">42k/200k</span>`, len: 8 },
		{ html: `<span class="fg-fg">$0.42</span>`, len: 5 },
	];
	let rightHTML = "";
	let rightLen = 0;
	for (let i = 0; i < tokens.length; i++) {
		if (i > 0) {
			rightHTML += `<span class="fg-dim"> \u00b7 </span>`;
			rightLen += 3;
		}
		rightHTML += tokens[i].html;
		rightLen += tokens[i].len;
	}
	const middle = cols - PAD * 2 - leftLen - rightLen;
	return rep(" ", PAD) + left + rep(" ", Math.max(1, middle)) + rightHTML + rep(" ", PAD);
}

function buildTopBarPlaceholder(cols) {
	const left = `<span class="fg-accent">SUMOCODE</span><span class="fg-dim">  \u2551 </span><span class="fg-accent">\u2022</span><span class="fg-dim"> 019dd3d8 \u2551</span>`;
	const right = `<span class="fg-dim">ARCHIVE   </span><span class="fg-fg">\uf489</span><span class="fg-dim">  </span><span class="fg-fg">\uf423</span>`;
	const leftLen = visibleLen(left);
	const rightLen = visibleLen(right);
	const middle = cols - PAD * 2 - leftLen - rightLen;
	return rep(" ", PAD) + left + rep(" ", Math.max(1, middle)) + right + rep(" ", PAD);
}

// ─── Compose scene ──────────────────────────────────────────────────────
function buildScene() {
	const GUTTER = 2;
	const CHAT_COLS = COLS - SIDEBAR_COLS - GUTTER;

	const sidebarRows = buildSidebarRows();
	const chatHTML = buildChatHTML(CHAT_COLS);
	const inputRows = buildInputFrameRows(COLS);
	const hintRow = buildHintRow(COLS);
	const footerRow = buildFooterRow(COLS);
	const topBarRow = buildTopBarPlaceholder(COLS);

	const middleRows = ROWS - 11;

	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Bible · Theme · Herdr Terminal · Active ${COLS}×${ROWS}</title>
<link rel="stylesheet" href="_assets/tokens.css">
<style>
  /* Herdr Terminal token overrides — source of truth: src/themes/herdr.ts
   * and docs/ui/stitch/herdr-terminal/DESIGN.md. Layout is untouched. */
  :root {
    --background:      ${HERDR.background};
    --surface:         ${HERDR.surface};
    --surface-recess:  ${HERDR.surfaceRecess};
    --surface-lifted:  ${HERDR.surfaceLifted};
    --divider:         ${HERDR.divider};
    --foreground:      ${HERDR.foreground};
    --foreground-dim:  ${HERDR.foregroundDim};
    --accent:          ${HERDR.accent};
    --state-idle:      ${HERDR.stateIdle};
    --state-thinking:  ${HERDR.stateThinking};
    --state-tool:      ${HERDR.stateTool};
    --state-approval:  ${HERDR.stateApproval};
    --state-learning:  ${HERDR.stateLearning};
  }
  .scene { display: grid; grid-template-rows: var(--cell-h) var(--cell-h) var(--cell-h) calc(var(--cell-h) * ${middleRows}) var(--cell-h) calc(var(--cell-h) * 3) var(--cell-h) var(--cell-h) var(--cell-h) var(--cell-h); }
  .scene .middle { display: grid; grid-template-columns: ${CHAT_COLS}ch ${GUTTER}ch ${SIDEBAR_COLS}ch; grid-row: 4; min-height: 0; overflow: hidden; }
  .scene .middle .chat-col, .scene .middle .sidebar-col { overflow: hidden; min-height: 0; }
  .scene .middle pre { margin: 0; }
  body.runtime-target { background: var(--background); }
  body.runtime-target .stage { min-height: 0; align-items: flex-start; justify-content: flex-start; padding: 0; gap: 0; }
</style>
</head>
<body class="runtime-target">
<div class="stage">
  <div data-render-rect class="term scene" style="--term-cols: ${COLS}; --term-rows: ${ROWS};">
    <pre class="grid" style="grid-row: 1;"> </pre>
    <pre class="grid" style="grid-row: 2;">${topBarRow}</pre>
    <pre class="grid" style="grid-row: 3;"> </pre>
    <div class="middle">
      <div class="chat-col">${chatHTML}</div>
      <div class="gutter-col"></div>
      <div class="sidebar-col"><pre class="grid">${sidebarRows.join("\n")}</pre></div>
    </div>
    <pre class="grid" style="grid-row: 5;"> </pre>
    <pre class="grid" style="grid-row: 6;">${inputRows.join("\n")}</pre>
    <pre class="grid" style="grid-row: 7;">${hintRow}</pre>
    <pre class="grid" style="grid-row: 8;"> </pre>
    <pre class="grid" style="grid-row: 9;">${footerRow}</pre>
    <pre class="grid" style="grid-row: 10;"> </pre>
  </div>
</div>
</body>
</html>
`;
}

writeFileSync(resolve(out, "theme-herdr-active.html"), buildScene());
console.log(`wrote theme-herdr-active.html  (${COLS}\u00d7${ROWS})`);
