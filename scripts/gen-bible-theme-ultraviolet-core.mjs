#!/usr/bin/env node
// Ultraviolet Core theme — deterministic Bible targets.
// Generates active runtime, tool-ledger fixture, and code-block fixture design
// targets from the canonical role table in docs/ui/stitch/ultraviolet-core/DESIGN.md.

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(repoRoot, "docs", "ui", "bible");

const COLS = 160;
const ROWS = 45;
const CHAT_COLS = 128;
const GUTTER = 2;
const SIDEBAR_COLS = 30;

const UV = {
	background: "#06050B",
	surface: "#0D0917",
	surfaceRecess: "#0A0711",
	surfaceLifted: "#1B102E",
	foreground: "#DCC7FF",
	foregroundDim: "#9B7BBE",
	divider: "#56347A",
	accent: "#B974FF",
	stateIdle: "#DCC7FF",
	stateThinking: "#B974FF",
	stateTool: "#FFC857",
	stateApproval: "#FF668F",
	stateLearning: "#75E8FF",
	toolSurface: "#100A1D",
	toolBorder: "#56347A",
	toolLabel: "#B974FF",
	toolTarget: "#DCC7FF",
	toolBody: "#DCC7FF",
	toolMuted: "#9B7BBE",
	codeSurface: "#100A1D",
	codeBorder: "#56347A",
	codeForeground: "#DCC7FF",
	codeGutter: "#9B7BBE",
	codeComment: "#9B7BBE",
	codeKeyword: "#B974FF",
	codeString: "#75E8FF",
	codeNumber: "#FFC857",
	codeFunction: "#75E8FF",
};

const rep = (ch, n) => ch.repeat(Math.max(0, n));
const visibleLen = (s) => s.replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").length;
const padRight = (s, n) => {
	const need = n - visibleLen(s);
	return need > 0 ? s + rep(" ", need) : s;
};
const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function gridLine(text) {
	return `<pre class="grid">${text}</pre>`;
}

function buildSidebarRows() {
	const rows = [];
	const cell = (h) => `<span class="box-fill" style="background: var(--surface); width: ${SIDEBAR_COLS}ch">${padRight(h, SIDEBAR_COLS)}</span>`;
	const blank = () => cell("");
	rows.push(blank());
	rows.push(cell(`  <span class="fg-accent"># REGISTRY</span>`));
	rows.push(blank());
	rows.push(cell(`  <span class="fg-accent">&gt;</span> <span class="fg-fg">&gt; CONTEXT</span>`));
	rows.push(cell(`  <span class="fg-dim">. + MEMORY</span>`));
	rows.push(blank());
	rows.push(cell(`  <span class="fg-divider">${rep("─", 26)}</span>`));
	rows.push(blank());
	rows.push(cell(`  <span class="fg-fg">sumocode</span>`));
	rows.push(cell(`  <span class="fg-dim">on main</span>`));
	rows.push(blank());
	rows.push(cell(`  <span class="fg-dim">&gt; CONTEXT</span>`));
	rows.push(cell(`  <span class="fg-idle">${rep("▉", 5)}</span><span class="fg-divider">${rep("░", 17)}</span>`));
	rows.push(cell(`  <span class="fg-fg">42k</span> <span class="fg-dim">/ 200k</span>`));
	rows.push(blank());
	rows.push(cell(`  <span class="fg-dim">~ SESSION</span>`));
	rows.push(cell(`  <span class="fg-fg">$0.42</span> <span class="fg-dim">· 3.4M cumul</span>`));
	rows.push(blank());
	rows.push(cell(`  <span class="fg-divider">${rep("─", 26)}</span>`));
	rows.push(blank());
	rows.push(cell(`  <span class="fg-dim">* MCP</span>`));
	rows.push(blank());
	for (const [name, state] of [["github", "idle"], ["stitch", "ok"], ["context7", "idle"], ["chrome-dev", "idle"]]) {
		const stateClass = state === "ok" ? "fg-idle" : "fg-dim";
		const pad = SIDEBAR_COLS - 4 - name.length - state.length - 2;
		rows.push(cell(`  <span class="${stateClass}">●</span> <span class="fg-fg">${name}</span>${rep(" ", Math.max(1, pad))}<span class="fg-dim">${state}</span>  `));
	}
	while (rows.length < 36) rows.push(blank());
	return rows;
}

function frameMessage(role, bodyRows, time = "11:42") {
	const rows = [];
	const innerCols = CHAT_COLS - 4;
	const roleClass = role === "SUMO" ? "fg-accent" : "fg-fg";
	const right = role === "SUMO" ? ` <span class="fg-dim">${time}</span> <span class="fg-divider">╮</span>` : `<span class="fg-divider">╮</span>`;
	const rightLen = role === "SUMO" ? 8 : 1;
	rows.push(`<span class="fg-divider">╭ </span><span class="${roleClass}">${role}</span> <span class="fg-divider">${rep("─", CHAT_COLS - 7 - rightLen)}</span>${right}`);
	const bodyRow = (html, len, bg = "") => {
		const fill = bg ? ` style="background: var(${bg}); width: ${innerCols + 2}ch"` : ` style="width: ${innerCols + 2}ch"`;
		return `<span class="fg-divider">│</span><span class="box-fill"${fill}> ${html}${rep(" ", Math.max(0, innerCols - len))} </span><span class="fg-divider">│</span>`;
	};
	for (const row of bodyRows) rows.push(bodyRow(row.html, row.len, row.bg));
	rows.push(`<span class="fg-divider">╰${rep("─", CHAT_COLS - 2)}╯</span>`);
	return rows;
}

const textRow = (text, cls = "fg-fg") => ({ html: `<span class="${cls}">${esc(text)}</span>`, len: text.length });
const blankRow = () => ({ html: "", len: 0 });

function toolLedgerRows(tool) {
	const rows = [blankRow()];
	const inner = CHAT_COLS - 8;
	const title = `[${tool.name}]  ${tool.target}`;
	const status = tool.status ?? "✓";
	const top = `<span class="fg-tool-border">╭─ </span><span class="fg-tool-label">[${tool.name}]</span><span class="fg-tool-target">  ${esc(tool.target)}</span> <span class="fg-tool-border">${rep("─", Math.max(1, inner - title.length - status.length))}</span> <span class="fg-idle">${status}</span>`;
	rows.push({ html: top, len: inner, bg: "--tool-ledger-surface" });
	for (const output of tool.output) rows.push({ html: output.html, len: output.len, bg: "--tool-ledger-surface" });
	rows.push({ html: `<span class="fg-tool-border">╰${rep("─", inner - 1)}</span>`, len: inner, bg: "--tool-ledger-surface" });
	return rows;
}

function codeBlockRows() {
	const codeInner = 96;
	const rows = [blankRow()];
	rows.push({ html: `<span class="fg-code-border">╭─ </span><span class="fg-code-gutter">ts</span><span class="fg-code-border"> ${rep("─", codeInner - 7)}╮</span>`, len: codeInner, bg: "--code-surface" });
	const source = [
		`<span class="fg-code-keyword">export async function</span> <span class="fg-code-function">authenticate</span>(<span class="fg-code">token</span>: <span class="fg-code">string</span>) {`,
		`  <span class="fg-code-keyword">const</span> <span class="fg-code">session</span> = <span class="fg-code-keyword">await</span> <span class="fg-code-function">Session</span>.<span class="fg-code-function">fromToken</span>(<span class="fg-code">token</span>);`,
		`  <span class="fg-code-keyword">if</span> (!<span class="fg-code">session</span> || <span class="fg-code">session</span>.<span class="fg-code">expired</span>) <span class="fg-code-keyword">return</span> <span class="fg-code-keyword">null</span>;`,
		``,
		`  <span class="fg-code-comment">// emit auth event for telemetry</span>`,
		`  <span class="fg-code-function">emit</span>(<span class="fg-code-string">"auth.success"</span>, { <span class="fg-code">userId</span>: <span class="fg-code">session</span>.<span class="fg-code">user</span>.<span class="fg-code">id</span>, <span class="fg-code">attempt</span>: <span class="fg-code-number">1</span> });`,
		`  <span class="fg-code-keyword">return</span> <span class="fg-code">session</span>.<span class="fg-code">user</span>;`,
		`}`,
	];
	for (let i = 0; i < source.length; i++) {
		const gutter = String(i + 1).padStart(3);
		const html = `<span class="fg-code-border">│</span> <span class="fg-code-gutter">${gutter} </span>${source[i]}`;
		rows.push({ html, len: Math.min(codeInner, visibleLen(html)), bg: "--code-surface" });
	}
	rows.push({ html: `<span class="fg-code-border">╰${rep("─", codeInner - 2)}╯</span>`, len: codeInner, bg: "--code-surface" });
	return rows;
}

function buildChatRows(kind) {
	if (kind === "active") {
		return [
			...frameMessage("USER", [textRow("review src/auth/session.ts and tighten the return type")]),
			"",
			...frameMessage("SUMO", [
				textRow("inspecting src/auth/session.ts"),
				textRow("✓ [read] src/auth/session.ts", "fg-idle"),
				textRow("▶ [edit] tightening return type", "fg-tool"),
				textRow("★ learned Result<User> boundary", "fg-learn"),
			]),
		];
	}
	if (kind === "tool") {
		return [
			...frameMessage("USER", [textRow("hello, refactor the auth flow to use the new session pattern.")]),
			"",
			...frameMessage("SUMO", [
				textRow("Reading the auth flow."),
				...toolLedgerRows({ name: "read", target: "src/auth/session.ts", output: [{ html: `<span class="fg-tool-muted">preview collapsed</span>`, len: 17 }] }),
				...toolLedgerRows({ name: "edit", target: "src/auth/session.ts", output: [{ html: `<span class="fg-idle">+14</span> <span class="fg-approve">-6</span> <span class="fg-tool-muted">session flow updated</span>`, len: 28 }] }),
				textRow("Done. Updated 14 lines, deleted 6 stale helpers."),
			]),
			"",
			...frameMessage("SUMO", [
				textRow("Running tests now."),
				...toolLedgerRows({ name: "bash", target: "pnpm test src/auth", status: "✓ 22 tests", output: [
					{ html: `<span class="fg-tool-body">&gt; pnpm test src/auth</span>`, len: 20 },
					{ html: `<span class="fg-idle">✓</span> <span class="fg-tool-body">src/auth/session.test.ts (22 tests)</span>`, len: 38 },
					{ html: `<span class="fg-tool-muted">22 passed in 1.2s</span>`, len: 18 },
				] }),
			]),
		];
	}
	return [
		...frameMessage("USER", [textRow("show me the new auth helper shape before implementing it.")]),
		"",
		...frameMessage("SUMO", [textRow("Here is the proposed TypeScript shape:"), ...codeBlockRows(), textRow("If this looks right, I’ll wire it into the session boundary.")]),
	];
}

function buildInputFrameRows() {
	const innerCols = COLS - 2;
	const cell = (h) => `<span class="box-fill" style="background: var(--surface-recess); width: ${COLS}ch">${padRight(h, COLS)}</span>`;
	return [
		cell(`<span class="fg-divider">┌${rep("─", innerCols)}┐</span>`),
		cell(`<span class="fg-divider">│</span> <span class="fg-accent">&gt;</span> <span class="cursor"> </span>${rep(" ", COLS - 6)}<span class="fg-divider">│</span>`),
		cell(`<span class="fg-divider">└${rep("─", innerCols)}┘</span>`),
	];
}

function buildHintRow() {
	const right = `<span class="fg-accent">CTRL+/</span><span class="fg-dim"> · COMMANDS</span>`;
	return ` ${rep(" ", COLS - visibleLen(right) - 2)}${right} `;
}

function buildFooterRow() {
	const left = `<span class="fg-idle">●</span> <span class="fg-fg">READY</span><span class="fg-dim"> · </span><span class="fg-fg">gpt-5.5</span><span class="fg-dim"> · </span><span class="fg-fg">medium</span>`;
	const right = `<span class="fg-fg">42k/200k</span><span class="fg-dim"> · </span><span class="fg-fg">$0.42</span>`;
	return ` ${left}${rep(" ", COLS - visibleLen(left) - visibleLen(right) - 2)}${right} `;
}

function buildTopBar() {
	const left = `<span class="fg-accent">SUMOCODE</span><span class="fg-dim">  ║ </span><span class="fg-accent">•</span><span class="fg-dim"> 019dd3d8 ║</span>`;
	const right = `<span class="fg-dim">ARCHIVE   </span><span class="fg-fg"></span><span class="fg-dim">  </span><span class="fg-fg"></span>`;
	return ` ${left}${rep(" ", COLS - visibleLen(left) - visibleLen(right) - 2)}${right} `;
}

function buildScene(kind, title) {
	const middleRows = ROWS - 11;
	const chatKind = kind === "runcat-active" ? "active" : kind;
	const chatRows = buildChatRows(chatKind).map((row) => typeof row === "string" ? row : row).slice(0, middleRows);
	while (chatRows.length < middleRows) chatRows.push("");
	// Two-cell gap after the glyph (labelGapCells: 2 — the icomoon cat overdraws its cell).
	if (kind === "runcat-active") chatRows[middleRows - 1] = ` <span class="fg-accent runcat-glyph"></span>  <span class="fg-dim">Working…</span>`;
	const sidebarRows = buildSidebarRows();
	while (sidebarRows.length < middleRows) sidebarRows.push(`<span class="box-fill" style="background: var(--surface); width: ${SIDEBAR_COLS}ch">${rep(" ", SIDEBAR_COLS)}</span>`);
	const chatLines = chatRows.map((row) => padRight(row, CHAT_COLS));
	const sidebarLines = sidebarRows.slice(0, middleRows);
	const inputRows = buildInputFrameRows();
	const runCatCss = kind === "runcat-active" ? `
  @font-face {
    font-family: 'RunCat';
    font-style: normal;
    font-weight: 400;
    font-display: block;
    src: url('../../../assets/fonts/runcat.ttf') format('truetype');
    unicode-range: U+E900-E904;
  }
  .term { font-family: 'RunCat', 'JetBrains Mono', ui-monospace, Menlo, monospace; }` : "";
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="_assets/tokens.css">
<style>${runCatCss}
  :root {
    --background: ${UV.background}; --surface: ${UV.surface}; --surface-recess: ${UV.surfaceRecess}; --surface-lifted: ${UV.surfaceLifted};
    --divider: ${UV.divider}; --foreground: ${UV.foreground}; --foreground-dim: ${UV.foregroundDim}; --accent: ${UV.accent};
    --state-idle: ${UV.stateIdle}; --state-thinking: ${UV.stateThinking}; --state-tool: ${UV.stateTool}; --state-approval: ${UV.stateApproval}; --state-learning: ${UV.stateLearning};
    --syntax-keyword: ${UV.codeKeyword}; --syntax-string: ${UV.codeString}; --syntax-number: ${UV.codeNumber}; --syntax-comment: ${UV.codeComment}; --syntax-function: ${UV.codeFunction};
    --tool-ledger-surface: ${UV.toolSurface}; --tool-ledger-border: ${UV.toolBorder}; --tool-ledger-label: ${UV.toolLabel}; --tool-ledger-target: ${UV.toolTarget}; --tool-ledger-body: ${UV.toolBody}; --tool-ledger-muted: ${UV.toolMuted};
    --code-surface: ${UV.codeSurface}; --code-border: ${UV.codeBorder}; --code-foreground: ${UV.codeForeground}; --code-gutter: ${UV.codeGutter}; --code-comment: ${UV.codeComment}; --code-keyword: ${UV.codeKeyword}; --code-string: ${UV.codeString}; --code-number: ${UV.codeNumber}; --code-function: ${UV.codeFunction};
  }
  .fg-tool-border { color: var(--tool-ledger-border); } .fg-tool-label { color: var(--tool-ledger-label); } .fg-tool-target { color: var(--tool-ledger-target); } .fg-tool-body { color: var(--tool-ledger-body); } .fg-tool-muted { color: var(--tool-ledger-muted); }
  .fg-code-border { color: var(--code-border); } .fg-code { color: var(--code-foreground); } .fg-code-gutter { color: var(--code-gutter); } .fg-code-comment { color: var(--code-comment); } .fg-code-keyword { color: var(--code-keyword); } .fg-code-string { color: var(--code-string); } .fg-code-number { color: var(--code-number); } .fg-code-function { color: var(--code-function); }
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
    ${gridLine(" ")}
    ${gridLine(buildTopBar())}
    ${gridLine(" ")}
    <div class="middle"><div class="chat-col"><pre class="grid">${chatLines.join("\n")}</pre></div><div class="gutter-col"></div><div class="sidebar-col"><pre class="grid">${sidebarLines.join("\n")}</pre></div></div>
    ${gridLine(" ")}
    ${gridLine(inputRows.join("\n"))}
    ${gridLine(buildHintRow())}
    ${gridLine(" ")}
    ${gridLine(buildFooterRow())}
    ${gridLine(" ")}
  </div>
</div>
</body>
</html>
`;
}

const outputs = [
	["theme-ultraviolet-core-active.html", buildScene("active", "Bible · Theme · Ultraviolet Core · Active")],
	["theme-ultraviolet-core-runcat-active.html", buildScene("runcat-active", "Bible · Theme · Ultraviolet Core · RunCat Active")],
	["theme-ultraviolet-core-tool-ledger.html", buildScene("tool", "Bible · Theme · Ultraviolet Core · Tool Ledger")],
	["theme-ultraviolet-core-code-block.html", buildScene("code", "Bible · Theme · Ultraviolet Core · Code Block")],
];

for (const [file, html] of outputs) {
	writeFileSync(resolve(out, file), html);
	console.log(`wrote ${file} (${COLS}×${ROWS})`);
}
