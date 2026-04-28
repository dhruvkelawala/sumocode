#!/usr/bin/env node
// Scene composition — full active state, both landscape (160×45) and portrait
// (60×100). Combines locked elements: top bar placeholder, chat (Element 13
// boxed 7A) on the left, sidebar (Element 1 V2 EDITORIAL CONTEXT) on the
// right (landscape only — hidden in portrait per Element 1 rules), input
// frame (Element 4) + footer (Element 5 idle) at the bottom.
//
// Footer + hint row + top bar all have 1-char left/right padding to match.

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(repoRoot, "docs", "ui", "bible");

const LANDSCAPE = { cols: 160, rows: 45, sidebarCols: 30, sidebarVisible: true };
const PORTRAIT  = { cols: 60,  rows: 100, sidebarCols: 0,  sidebarVisible: false };

const rep = (ch, n) => ch.repeat(n);
const visibleLen = (s) =>
	s.replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").length;
const padRight = (s, n) => {
	const need = n - visibleLen(s);
	return need > 0 ? s + rep(" ", need) : s;
};
const trackOut = (s) => s.split("").join("\u202f");

// ─── Sidebar (V2 EDITORIAL, CONTEXT active) ─────────────────────────────
function buildSidebarRows(SIDEBAR_COLS) {
	const rows = [];
	const cell = (h) =>
		`<span class="box-fill" style="background: var(--surface); width: ${SIDEBAR_COLS}ch">` +
		padRight(h, SIDEBAR_COLS) +
		`</span>`;
	const blank = () => cell("");

	rows.push(blank());
	rows.push(cell(`  <span class="fg-accent">REGISTRY</span>`));
	rows.push(cell(`  <span class="fg-dim">\u2014 v 1.0.0</span>`));
	rows.push(blank());

	rows.push(cell(`  <span class="fg-accent">\u25c6</span> <span class="fg-fg">${trackOut("CONTEXT")}</span>`));
	rows.push(cell(`  <span class="fg-dim">\u25a2 ${trackOut("MEMORY")}</span>`));
	rows.push(blank());
	rows.push(cell(`  <span class="fg-divider">${rep("\u2501", 26)}</span>`));
	rows.push(blank());

	rows.push(cell(`  <span class="fg-fg">sumo-deus</span>`));
	rows.push(cell(`  <span class="fg-dim">on main</span>`));
	rows.push(blank());

	rows.push(cell(`  <span class="fg-dim">${trackOut("CONTEXT")}</span>`));
	rows.push(cell(`  <span class="fg-idle">${rep("\u2589", 5)}</span><span class="fg-divider">${rep("\u2591", 17)}</span>`));
	rows.push(cell(`  <span class="fg-fg">42k</span> <span class="fg-dim">/ 200k</span>`));
	rows.push(blank());

	rows.push(cell(`  <span class="fg-dim">${trackOut("SESSION")}</span>`));
	rows.push(cell(`  <span class="fg-fg">$0.42</span> <span class="fg-dim">\u00b7 3.4M cumul</span>`));
	rows.push(blank());
	rows.push(cell(`  <span class="fg-divider">${rep("\u2501", 26)}</span>`));
	rows.push(blank());

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

// ─── Chat conversation (Element 13 boxed 7A refined) ───────────────────
function buildChatHTML(cols) {
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
			return `<span class="fg-divider">\u2502</span><span class="box-fill" style="width: ${innerCols + 2}ch"> ` + h + rep(" ", padLen) + ` </span><span class="fg-divider">\u2502</span>`;
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

		rows.push(`<span class="fg-divider">\u2570${rep("\u2500", cols - 2)}\u256f</span>`);

		blocks.push(`<pre class="grid">${rows.join("\n")}</pre>`);
		if (i < messages.length - 1) blocks.push(`<pre class="grid"> </pre>`);
	}

	return blocks.join("\n");
}

// ─── Input frame (Element 4) ───────────────────────────────────────────
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

// ─── Hint row (right-aligned keybinds, 1-char l/r padding) ─────────────
const PAD = 1; // 2-char l/r padding for chrome rows

// In portrait (sidebar hidden), hint row carries the project name + branch
// on the LEFT (since sidebar can't show them). In landscape, hint row is
// right-keybinds-only (sidebar shows project).
function buildHintRow(cols, sidebarVisible) {
	const rightHTML =
		`<span class="fg-dim">TAB \u00b7 AGENTS  </span>` +
		`<span class="fg-accent">CTRL+/</span>` +
		`<span class="fg-dim"> \u00b7 COMMANDS</span>`;
	const rightLen = 31;

	if (sidebarVisible) {
		const lead = cols - rightLen - PAD * 2;
		return rep(" ", PAD) + rep(" ", Math.max(0, lead)) + rightHTML + rep(" ", PAD);
	}

	// Sidebar hidden: project + branch on the left
	const leftHTML = `<span class="fg-fg">sumo-deus</span> <span class="fg-dim">(main)</span>`;
	const leftLen = visibleLen(leftHTML);
	const middle = cols - PAD * 2 - leftLen - rightLen;
	return rep(" ", PAD) + leftHTML + rep(" ", Math.max(1, middle)) + rightHTML + rep(" ", PAD);
}

// ─── Footer (Element 5 idle / READY, width-adaptive) ───────────────────
// Project+branch in footer ONLY when sidebar hidden (sidebar shows them otherwise).
function buildFooterRow(cols, sidebarVisible) {
	const leftCompact = cols < 80;
	const left = leftCompact
		? `<span class="fg-idle">\u25cf</span> <span class="fg-fg">READY</span><span class="fg-dim"> \u00b7 </span><span class="fg-fg">gpt-5.5</span><span class="fg-dim"> \u00b7 </span><span class="fg-fg">medium</span>`
		: `<span class="fg-idle">\u25cf</span> <span class="fg-fg">READY</span><span class="fg-dim"> \u00b7 </span><span class="fg-fg">claude-opus-4-7</span><span class="fg-dim"> \u00b7 </span><span class="fg-fg">xhigh</span>`;
	const leftLen = visibleLen(left);

	// Project + branch live in the hint row when sidebar hidden, in the
	// sidebar otherwise. Footer right zone is just ctx tokens + cost.
	const tokens = [];
	if (cols >= 50) tokens.push({ html: `<span class="fg-fg">42k/200k</span>`, len: 8 });
	if (cols >= 50) tokens.push({ html: `<span class="fg-fg">$0.42</span>`, len: 5 });

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

// ─── Top bar placeholder ───────────────────────────────────────────────
function buildTopBarPlaceholder(cols) {
	let left, right;
	// Nerd Font icons: \uf489 = terminal prompt, \uf423 = nf-oct-gear (Octicons)
	if (cols >= 80) {
		left = `<span class="fg-accent">SUMOCODE</span><span class="fg-dim">  \u2551 \u25cf 019dd3d8 \u2551</span>`;
		right = `<span class="fg-dim">ARCHIVE   </span><span class="fg-fg">\uf489</span><span class="fg-dim">  </span><span class="fg-fg">\uf423</span>`;
	} else {
		// Portrait: same SUMOCODE + active-session marker as landscape, just no
		// recent-session tabs and no ARCHIVE. Drop those entirely.
		left = `<span class="fg-accent">SUMOCODE</span><span class="fg-dim">  \u2551 \u25cf 019dd3d8 \u2551</span>`;
		right = `<span class="fg-fg">\uf489</span><span class="fg-dim">  </span><span class="fg-fg">\uf423</span>`;
	}
	const leftLen = visibleLen(left);
	const rightLen = visibleLen(right);
	const middle = cols - PAD * 2 - leftLen - rightLen;
	return rep(" ", PAD) + left + rep(" ", Math.max(1, middle)) + right + rep(" ", PAD);
}

// ─── Compose scene ──────────────────────────────────────────────────────
function buildScene(variant) {
	const { cols, rows: TERM_ROWS, sidebarCols, sidebarVisible } = variant;
	const CHAT_COLS = sidebarVisible ? cols - sidebarCols : cols;

	const sidebarRows = sidebarVisible ? buildSidebarRows(sidebarCols) : [];
	const chatHTML = buildChatHTML(CHAT_COLS);
	const inputRows = buildInputFrameRows(cols);
	const hintRow = buildHintRow(cols, sidebarVisible);
	const footerRow = buildFooterRow(cols, sidebarVisible);
	const topBarRow = buildTopBarPlaceholder(cols);

	const middleCols = sidebarVisible ? `${CHAT_COLS}ch ${sidebarCols}ch` : `1fr`;

	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Bible · Scene · Active ${cols}×${TERM_ROWS}</title>
<link rel="stylesheet" href="_assets/tokens.css">
<style>
  .stage-blurb { max-width: ${Math.max(60, CHAT_COLS)}ch; color: var(--foreground-dim); font-size: 11px; line-height: 1.6; padding: 0 8px; text-align: center; }
  .scene { display: grid; grid-template-rows: var(--cell-h) var(--cell-h) auto var(--cell-h) calc(var(--cell-h) * 3) var(--cell-h) var(--cell-h) var(--cell-h); }
  .scene .middle { display: grid; grid-template-columns: ${middleCols}; grid-row: 3; min-height: 0; overflow: hidden; }
  .scene .middle .chat-col, .scene .middle .sidebar-col { overflow: hidden; min-height: 0; }
  .scene .middle pre { margin: 0; }
</style>
</head>
<body>
<div class="stage">
  <div class="stage-label">scene · active state · ${cols}×${TERM_ROWS} ${sidebarVisible ? "landscape" : "portrait (sidebar hidden)"}</div>
  <div class="stage-blurb">${sidebarVisible
		? "first scene composition: combines all 5 locked elements (top-bar placeholder, sidebar V2 editorial CONTEXT, chat boxed 7A, input frame, footer READY). validates the full visual gestalt before adding remaining elements."
		: "portrait variant. sidebar hidden (per Element 1 rule: < 120 col). chat takes full term width. footer collapses right zone (drops project + branch + $cost; keeps tokens). hint row: keybinds only (left flavour dropped at narrow widths)."}</div>
  <div data-render-rect class="term scene" style="--term-cols: ${cols}; --term-rows: ${TERM_ROWS};">
    <pre class="grid" style="grid-row: 1;">${topBarRow}</pre>
    <pre class="grid" style="grid-row: 2;"> </pre>
    <div class="middle">
      <div class="chat-col">${chatHTML}</div>
      ${sidebarVisible ? `<div class="sidebar-col"><pre class="grid">${sidebarRows.join("\n")}</pre></div>` : ""}
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

for (const v of [
	{ filename: "scene-active.html", spec: LANDSCAPE },
	{ filename: "scene-active-portrait.html", spec: PORTRAIT },
]) {
	writeFileSync(resolve(out, v.filename), buildScene(v.spec));
	console.log(`wrote ${v.filename}  (${v.spec.cols}\u00d7${v.spec.rows})`);
}
