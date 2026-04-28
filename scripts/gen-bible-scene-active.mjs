#!/usr/bin/env node
// Scene composition — full 160×45 active state.
// Combines locked elements: chat (Element 13 boxed 7A) on the left, sidebar
// (Element 1 V2 EDITORIAL CONTEXT) on the right, input frame (Element 4) +
// footer (Element 5 idle) at the bottom.
//
// Top bar (Element 2) is a 1-row placeholder until that element ships.

import { writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ansToHTMLLines } from "./lib/ansi-to-html.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(repoRoot, "docs", "ui", "bible");

const TERM_COLS = 160;
const TERM_ROWS = 45;
const SIDEBAR_COLS = 30;
const CHAT_COLS = TERM_COLS - SIDEBAR_COLS; // 130
const FOOTER_COLS = TERM_COLS;

const rep = (ch, n) => ch.repeat(n);
const visibleLen = (s) =>
	s.replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").length;
const padRight = (s, n) => {
	const need = n - visibleLen(s);
	return need > 0 ? s + rep(" ", need) : s;
};

// ── Reuse the locked-element generators by dynamic import ───────────────
const trackOut = (s) => s.split("").join("\u202f");

// Sidebar (V2 EDITORIAL, CONTEXT active) — minimal inline build to avoid
// cross-module deps.
function buildSidebarRows() {
	const rows = [];
	const COLS = SIDEBAR_COLS;
	const cell = (h) =>
		`<span class="box-fill" style="background: var(--surface)">` +
		padRight(h, COLS) +
		`</span>`;
	const blank = () => cell("");

	// chrome
	rows.push(blank());
	rows.push(cell(`  <span class="fg-accent">REGISTRY</span>`));
	rows.push(cell(`  <span class="fg-dim">\u2014 v 1.0.0</span>`));
	rows.push(blank());

	// tabs
	rows.push(cell(`  <span class="fg-accent">\u25c6</span> <span class="fg-fg">${trackOut("CONTEXT")}</span>`));
	rows.push(cell(`  <span class="fg-dim">\u25a2 ${trackOut("MEMORY")}</span>`));
	rows.push(blank());
	rows.push(cell(`  <span class="fg-divider">${rep("\u2501", 26)}</span>`));
	rows.push(blank());

	// project + branch
	rows.push(cell(`  <span class="fg-fg">sumo-deus</span>`));
	rows.push(cell(`  <span class="fg-dim">on main</span>`));
	rows.push(blank());

	// CONTEXT
	rows.push(cell(`  <span class="fg-dim">${trackOut("CONTEXT")}</span>`));
	rows.push(cell(`  <span class="fg-idle">${rep("\u2589", 5)}</span><span class="fg-divider">${rep("\u2591", 17)}</span>`));
	rows.push(cell(`  <span class="fg-fg">42k</span> <span class="fg-dim">/ 200k</span>`));
	rows.push(blank());

	// SESSION
	rows.push(cell(`  <span class="fg-dim">${trackOut("SESSION")}</span>`));
	rows.push(cell(`  <span class="fg-fg">$0.42</span> <span class="fg-dim">\u00b7 3.4M cumul</span>`));
	rows.push(blank());
	rows.push(cell(`  <span class="fg-divider">${rep("\u2501", 26)}</span>`));
	rows.push(blank());

	// MCP
	rows.push(cell(`  <span class="fg-dim">${trackOut("MCP")}</span>`));
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
		const pad = COLS - 4 - m.name.length - stateText.length - 2;
		rows.push(cell(
			`  <span class="${dotClass}">\u25cf</span> <span class="fg-fg">${m.name}</span>` +
			rep(" ", Math.max(1, pad)) +
			`<span class="fg-dim">${stateText}</span>  `,
		));
	}

	// pad to fill remaining rows
	while (rows.length < 36) rows.push(blank());
	return rows;
}

// Chat conversation (Element 13 boxed 7A refined, 130 cols wide) — inline.
function buildChatHTML() {
	const cols = CHAT_COLS;
	const innerCols = cols - 4;
	const blocks = [];

	const messages = [
		{ role: "USER", body: "hello, refactor the auth flow to use the new session pattern." },
		{ role: "SUMO", time: "11:42",
			body: "Reading the auth flow.",
			tools: [
				{ name: "read", target: "src/auth/session.ts", state: "ok" },
				{ name: "edit", target: "src/auth/session.ts", state: "ok" },
			],
			footer: "Done. Updated 14 lines, deleted 6 stale helpers.",
		},
		{ role: "USER", body: "run tests" },
		{ role: "SUMO", time: "11:43",
			body: "Running tests now.",
			tools: [{ name: "bash", target: "pnpm test src/auth", state: "ok", note: "22 tests, 1.2s" }],
			footer: "All 22 tests pass.",
		},
	];

	function wrap(text, w) {
		const words = text.split(/\s+/);
		const lines = [];
		let cur = "";
		for (const word of words) {
			if (!cur) cur = word;
			else if (cur.length + 1 + word.length <= w) cur += " " + word;
			else { lines.push(cur); cur = word; }
		}
		if (cur) lines.push(cur);
		return lines;
	}

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const rows = [];

		// Top border with role + time
		let leftPart, leftLen, rightPart, rightLen;
		if (msg.role === "USER") {
			leftPart = `<span class="fg-divider">\u256d </span><span class="fg-fg">USER</span> `;
			leftLen = 7;
			rightPart = `<span class="fg-divider">\u256e</span>`;
			rightLen = 1;
		} else {
			leftPart = `<span class="fg-divider">\u256d </span><span class="fg-accent">SUMO</span> `;
			leftLen = 7;
			rightPart = ` <span class="fg-dim">${msg.time}</span> <span class="fg-divider">\u256e</span>`;
			rightLen = 8;
		}
		const dashLen = cols - leftLen - rightLen;
		rows.push(leftPart + `<span class="fg-divider">${rep("\u2500", dashLen)}</span>` + rightPart);

		const bodyRow = (h, len) => {
			const padLen = innerCols - len;
			return `<span class="fg-divider">\u2502</span><span class="box-fill"> ` + h + rep(" ", padLen) + ` </span><span class="fg-divider">\u2502</span>`;
		};
		const blankRow = () => bodyRow("", 0);

		if (msg.body) {
			for (const line of wrap(msg.body, innerCols)) {
				rows.push(bodyRow(`<span class="fg-fg">${line}</span>`, line.length));
			}
		}
		if (msg.tools) {
			for (const tool of msg.tools) {
				rows.push(blankRow());
				const dotClass = { ok: "fg-idle", running: "fg-tool", failed: "fg-approve" }[tool.state] ?? "fg-dim";
				const glyph = { ok: "\u2713", running: "\u25b6", failed: "\u2717" }[tool.state] ?? "\u00b7";
				const note = tool.note ? `<span class="fg-dim">  \u00b7 ${tool.note}</span>` : "";
				const pillHTML =
					`<span class="${dotClass}">${glyph}</span> ` +
					`<span class="fg-accent">[${tool.name}]</span>` +
					`<span class="fg-fg">  ${tool.target}</span>` +
					note;
				const pillLen = visibleLen(pillHTML);
				rows.push(bodyRow(pillHTML, pillLen));
			}
		}
		if (msg.footer) {
			rows.push(blankRow());
			for (const line of wrap(msg.footer, innerCols)) {
				rows.push(bodyRow(`<span class="fg-fg">${line}</span>`, line.length));
			}
		}

		// Bottom border
		rows.push(`<span class="fg-divider">\u2570${rep("\u2500", cols - 2)}\u256f</span>`);

		blocks.push(`<pre class="grid">${rows.join("\n")}</pre>`);
		if (i < messages.length - 1) blocks.push(`<pre class="grid"> </pre>`);
	}

	return blocks.join("\n");
}

// Input frame (Element 4) — 3 rows
function buildInputFrameRows() {
	const rows = [];
	const cols = TERM_COLS;
	const innerCols = cols - 2;
	const cell = (h) =>
		`<span class="box-fill" style="background: var(--surface-recess)">` +
		padRight(h, cols) +
		`</span>`;
	const top = `<span class="fg-divider">\u250c${rep("\u2500", innerCols)}\u2510</span>`;
	const bot = `<span class="fg-divider">\u2514${rep("\u2500", innerCols)}\u2518</span>`;
	const cursorRow =
		`<span class="fg-divider">\u2502</span> <span class="fg-accent">&gt;</span> ` +
		`<span class="cursor"> </span>` +
		rep(" ", cols - 6) +
		`<span class="fg-divider">\u2502</span>`;
	rows.push(cell(top));
	rows.push(cell(cursorRow));
	rows.push(cell(bot));
	return rows;
}

// Hint row (right-aligned)
function buildHintRow() {
	const rightHTML =
		`<span class="fg-dim">TAB \u00b7 AGENTS  </span>` +
		`<span class="fg-accent">CTRL+/</span>` +
		`<span class="fg-dim"> \u00b7 COMMANDS</span>`;
	const rightLen = 31;
	const pad = TERM_COLS - rightLen;
	return rep(" ", pad) + rightHTML;
}

// Footer (Element 5 idle / READY)
function buildFooterRow() {
	const left = `<span class="fg-idle">\u25cf</span> <span class="fg-fg">READY</span><span class="fg-dim"> \u00b7 </span><span class="fg-fg">claude-opus-4-7</span><span class="fg-dim"> \u00b7 </span><span class="fg-fg">xhigh</span>`;
	const leftLen = 1 + 1 + 5 + 3 + 15 + 3 + 5;
	const rightStr = `sumo-deus (main) \u00b7 42k/200k \u00b7 $0.42`;
	const right =
		`<span class="fg-fg">sumo-deus</span> <span class="fg-dim">(main)</span>` +
		`<span class="fg-dim"> \u00b7 </span><span class="fg-fg">42k/200k</span>` +
		`<span class="fg-dim"> \u00b7 </span><span class="fg-fg">$0.42</span>`;
	const rightLen = rightStr.length;
	const pad = TERM_COLS - leftLen - rightLen;
	return left + rep(" ", Math.max(1, pad)) + right;
}

// Top bar placeholder (1 row)
function buildTopBarPlaceholder() {
	const left = `<span class="fg-accent">SUMOCODE</span><span class="fg-dim">  \u2551 \u25cf 019dd3d8 \u2551</span>`;
	const leftLen = 8 + 16; // "SUMOCODE  ‖ • 019dd3d8 ‖"
	const right = `<span class="fg-dim">ARCHIVE   [terminal]  [\u2699]</span>`;
	const rightLen = 28;
	const pad = TERM_COLS - leftLen - rightLen - 2;
	return ` ` + left + rep(" ", Math.max(1, pad)) + right + ` `;
}

// ── Compose the full scene ─────────────────────────────────────────────
function buildScene() {
	const sidebarRows = buildSidebarRows();
	const chatHTML = buildChatHTML();
	const inputRows = buildInputFrameRows();
	const hintRow = buildHintRow();
	const footerRow = buildFooterRow();
	const topBarRow = buildTopBarPlaceholder();

	// Construct the layout
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Bible · Scene · Active 160×45</title>
<link rel="stylesheet" href="_assets/tokens.css">
<style>
  .stage-blurb { max-width: 130ch; color: var(--foreground-dim); font-size: 11px; line-height: 1.6; padding: 0 8px; text-align: center; }
  .scene { display: grid; grid-template-rows: var(--cell-h) var(--cell-h) auto var(--cell-h) calc(var(--cell-h) * 3) var(--cell-h) var(--cell-h) var(--cell-h); }
  .scene .middle { display: grid; grid-template-columns: ${CHAT_COLS}ch ${SIDEBAR_COLS}ch; grid-row: 3; min-height: 0; overflow: hidden; }
  .scene .middle .chat-col { overflow: hidden; min-height: 0; }
  .scene .middle .sidebar-col { overflow: hidden; min-height: 0; }
  .scene .middle .chat-col pre, .scene .middle .sidebar-col pre { margin: 0; }
</style>
</head>
<body>
<div class="stage">
  <div class="stage-label">scene · active state · 160×45 landscape</div>
  <div class="stage-blurb">first scene composition: combines all 5 locked elements (top-bar placeholder, sidebar V2 editorial CONTEXT, chat boxed 7A, input frame, footer READY). validates the full visual gestalt before adding remaining elements.</div>
  <div data-render-rect class="term scene" style="--term-cols: ${TERM_COLS}; --term-rows: ${TERM_ROWS};">
    <pre class="grid" style="grid-row: 1;">${topBarRow}</pre>
    <pre class="grid" style="grid-row: 2;"> </pre>
    <div class="middle">
      <div class="chat-col">${chatHTML}</div>
      <div class="sidebar-col">
        <pre class="grid">${sidebarRows.join("\n")}</pre>
      </div>
    </div>
    <pre class="grid" style="grid-row: 4;"> </pre>
    <pre class="grid" style="grid-row: 5;">${inputRows.join("\n")}</pre>
    <pre class="grid" style="grid-row: 6;">${hintRow}</pre>
    <pre class="grid" style="grid-row: 7;"> </pre>
    <pre class="grid" style="grid-row: 8;">${footerRow}</pre>
  </div>
</div>
</body>
</html>
`;
}

writeFileSync(resolve(out, "scene-active.html"), buildScene());
console.log(`wrote scene-active.html  (${TERM_COLS}\u00d7${TERM_ROWS})`);
