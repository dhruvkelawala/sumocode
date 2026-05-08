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
	rows.push(blank());

	rows.push(cell(`  <span class="fg-accent">\u25c6</span> <span class="fg-fg">${trackOut("CONTEXT")}</span>`));
	rows.push(cell(`  <span class="fg-dim">\u25a2 ${trackOut("MEMORY")}</span>`));
	rows.push(blank());
	rows.push(cell(`  <span class="fg-divider">${rep("\u2501", 26)}</span>`));
	rows.push(blank());

	rows.push(cell(`  <span class="fg-fg">sumocode</span>`));
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
function buildChatHTML(cols, toolStyle = "inline") {
	const innerCols = cols - 4;
	const blocks = [];

	let messages = [
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

	if (toolStyle === "code") {
		messages = [
			{ role: "USER", body: "show me the new auth helper shape before implementing it." },
			{ role: "SUMO", time: "11:44", body: "Here is the proposed TypeScript shape:", code: {
				language: "ts",
				lines: [
					`<span class="fg-keyword">export async function</span> <span class="fg-fn">authenticate</span>(<span class="fg-fg">token</span>: <span class="fg-fg">string</span>) {`,
					`  <span class="fg-keyword">const</span> <span class="fg-fg">session</span> = <span class="fg-keyword">await</span> <span class="fg-fn">Session</span>.<span class="fg-fn">fromToken</span>(<span class="fg-fg">token</span>);`,
					`  <span class="fg-keyword">if</span> (!<span class="fg-fg">session</span> || <span class="fg-fg">session</span>.<span class="fg-fg">expired</span>) <span class="fg-keyword">return</span> <span class="fg-keyword">null</span>;`,
					``,
					`  <span class="fg-comment">// emit auth event for telemetry</span>`,
					`  <span class="fg-fn">emit</span>(<span class="fg-string">"auth.success"</span>, { <span class="fg-fg">userId</span>: <span class="fg-fg">session</span>.<span class="fg-fg">user</span>.<span class="fg-fg">id</span> });`,
					`  <span class="fg-keyword">return</span> <span class="fg-fg">session</span>.<span class="fg-fg">user</span>;`,
					`}`,
				],
			}, footer: "If this looks right, I’ll wire it into the session boundary." },
		];
	}

	if (toolStyle === "skill") {
		messages = [
			{ role: "USER", body: "use the frontend-design skill and sketch the command palette polish plan." },
			{ role: "SUMO", time: "11:45", body: "Loading the design skill and keeping it inline, Pi-minimal, and non-decorative.", skill: "frontend-design", footer: "I’ll apply the skill guidance to the Scriptorium palette without changing the locked interaction model." },
		];
	}

	if (toolStyle === "scroll") {
		messages = [
			{ role: "USER", body: "delegate a focused pass to inspect the renderer crash and report back." },
			{ role: "SUMO", time: "11:46", body: "I’m assigning this as a scroll so the scribe can inspect independently and return the summary.", scroll: {
				title: "inspect renderer crash at 40 columns",
				model: "gpt-5.5",
				thinking: "medium",
				status: "running",
				calls: [
					{ name: "read", target: "src/sumo-tui/render/compositor.ts", state: "ok" },
					{ name: "read", target: "src/sumo-tui/render/buffer.ts", state: "ok" },
					{ name: "bash", target: "pnpm test src/sumo-tui/render", state: "running" },
				],
				tokensIn: "6k",
				tokensOut: "1.1k",
				elapsed: "18s",
			} },
		];
	}

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
		if (msg.code) {
			rows.push(blankRow());
			const codeInner = Math.min(innerCols - 4, 96);
			const lang = msg.code.language;
			const langTag = `─ <span class="fg-dim">${lang}</span> ─`;
			const langLen = 2 + lang.length + 3;
			rows.push(bodyRow(`<span class="fg-divider">╭─ </span><span class="fg-dim">${lang}</span><span class="fg-divider"> ${rep("─", Math.max(1, codeInner - langLen))}╮</span>`, codeInner));
			for (let i = 0; i < msg.code.lines.length; i++) {
				const lineNum = String(i + 1).padStart(3);
				const code = msg.code.lines[i];
				const left = `<span class="fg-divider">│</span> <span class="fg-dim">${lineNum} </span>${code}`;
				const leftLen = visibleLen(left);
				const rowHTML = left + rep(" ", Math.max(0, codeInner - leftLen - 1)) + `<span class="fg-divider">│</span>`;
				rows.push(bodyRow(rowHTML, codeInner));
			}
			rows.push(bodyRow(`<span class="fg-divider">╰${rep("─", codeInner - 2)}╯</span>`, codeInner));
		}

		if (msg.skill) {
			rows.push(blankRow());
			const skillHTML = `<span class="fg-accent">[skill]</span><span class="fg-fg"> ${msg.skill}</span> <span class="fg-dim">(⌘O to expand)</span>`;
			rows.push(bodyRow(skillHTML, visibleLen(skillHTML)));
		}

		if (msg.scroll) {
			rows.push(blankRow());
			const stateGlyph = { ok: "✓", running: "▶", failed: "✗" }[msg.scroll.status];
			const stateClass = { ok: "fg-idle", running: "fg-tool", failed: "fg-approve" }[msg.scroll.status];
			const stateLabel = { ok: "done", running: "running", failed: "failed" }[msg.scroll.status];
			const left = `[scroll]  ${msg.scroll.title}`;
			const right = `${stateGlyph} ${stateLabel}`;
			const dashCount = innerCols - 10 - left.length - right.length;
			const scrollTop =
				`<span class="fg-divider">━━━</span> ` +
				`<span class="fg-accent">[scroll]</span>` +
				`<span class="fg-fg">  ${msg.scroll.title}</span>` +
				` <span class="fg-divider">${rep("━", Math.max(3, dashCount))}</span> ` +
				`<span class="fg-divider">━━━</span> ` +
				`<span class="${stateClass}">${stateGlyph}</span> ` +
				`<span class="fg-fg">${stateLabel}</span>`;
			rows.push(bodyRow(scrollTop, innerCols));
			rows.push(blankRow());

			const ledgerIndent = "   ";
			const scribeTitle = `scribe · ${msg.scroll.model} · ${msg.scroll.thinking}`;
			const ledgerTopPlain = `${ledgerIndent}┌ ${scribeTitle} `;
			const ledgerTop = `${ledgerIndent}<span class="fg-divider">┌ </span><span class="fg-dim">${scribeTitle}</span> <span class="fg-divider">${rep("─", Math.max(3, innerCols - ledgerTopPlain.length - 1))}</span>`;
			rows.push(bodyRow(ledgerTop, visibleLen(ledgerTop)));
			for (const call of msg.scroll.calls) {
				const glyph = { ok: "✓", running: "▶", failed: "✗" }[call.state] ?? "·";
				const glyphClass = { ok: "fg-idle", running: "fg-tool", failed: "fg-approve" }[call.state] ?? "fg-dim";
				const callHTML = `${ledgerIndent}<span class="fg-divider">│</span> <span class="${glyphClass}">${glyph}</span> <span class="fg-accent">[${call.name}]</span><span class="fg-fg">  ${call.target}</span>`;
				rows.push(bodyRow(callHTML, visibleLen(callHTML)));
			}
			rows.push(bodyRow(`${ledgerIndent}<span class="fg-divider">│</span>`, ledgerIndent.length + 1));
			const tokenHTML = `${ledgerIndent}<span class="fg-divider">│</span> <span class="fg-dim">Tokens: ↑${msg.scroll.tokensIn} ↓${msg.scroll.tokensOut} · ${msg.scroll.elapsed} elapsed</span>`;
			rows.push(bodyRow(tokenHTML, visibleLen(tokenHTML)));
			rows.push(bodyRow(`${ledgerIndent}<span class="fg-divider">└${rep("─", innerCols - ledgerIndent.length - 1)}</span>`, innerCols));
		}

		if (msg.tools) {
			for (const tool of msg.tools) {
				rows.push(blankRow());
				const dotClass = { ok: "fg-idle", running: "fg-tool", failed: "fg-approve" }[tool.state] ?? "fg-dim";
				const glyph = { ok: "\u2713", running: "\u25b6", failed: "\u2717" }[tool.state] ?? "\u00b7";

				if (toolStyle === "live" && tool.name === "bash") {
					const title = `live bash · ${tool.target}`;
					const timer = ` 4.2s `;
					const titleLen = title.length + 2;
					const timerLen = timer.length;
					const top =
						`<span class="fg-tool">╭ </span><span class="fg-fg">${title}</span><span class="fg-tool"> ` +
						`${rep("─", Math.max(1, innerCols - titleLen - timerLen - 2))}</span>` +
						`<span class="fg-dim">${timer}</span><span class="fg-tool">╮</span>`;
					rows.push(bodyRow(top, innerCols));
					const liveRows = [
						`<span class="fg-fg">$ pnpm test src/auth</span>`,
						`<span class="fg-fg">> vitest run src/auth</span>`,
						`<span class="fg-idle">✓</span> <span class="fg-fg">src/auth/session.test.ts</span> <span class="fg-dim">(22 tests)</span>`,
						`<span class="fg-tool">▶</span> <span class="fg-fg">watching stdout…</span> <span class="fg-dim">press ⌘O expand</span>`,
						`<span class="fg-fg">[</span><span class="fg-tool">███████████</span><span class="fg-divider">░░░░</span><span class="fg-fg">] 73%</span>`,
					];
					for (const liveRow of liveRows) {
						rows.push(bodyRow(`<span class="fg-tool">│</span> ${liveRow}`, visibleLen(liveRow) + 2));
					}
					rows.push(bodyRow(`<span class="fg-tool">╰${rep("─", innerCols - 1)}</span>`, innerCols));
					continue;
				}

				if (toolStyle === "ledger") {
					const status = tool.note ? `${glyph} ${tool.note}` : glyph;
					const statusHTML = `<span class="${dotClass}">${glyph}</span>${tool.note ? `<span class="fg-dim"> ${tool.note}</span>` : ""}`;
					const title = `[${tool.name}]  ${tool.target}`;
					const leftHTML = `<span class="fg-divider">╭─ </span><span class="fg-accent">[${tool.name}]</span><span class="fg-fg">  ${tool.target}</span> `;
					const leftLen = 3 + title.length + 1;
					const rightLen = visibleLen(statusHTML) + 2;
					rows.push(bodyRow(leftHTML + `<span class="fg-divider">${rep("─", Math.max(1, innerCols - leftLen - rightLen))}</span> ` + statusHTML, innerCols));

					const outputLines = tool.name === "bash"
						? [
							`<span class="fg-fg">> pnpm test src/auth</span>`,
							`<span class="fg-idle">✓</span> <span class="fg-fg">src/auth/session.test.ts (22 tests)</span>`,
							`<span class="fg-dim">22 passed in 1.2s</span>`,
						]
						: tool.name === "edit"
							? [`<span class="fg-idle">+14</span> <span class="fg-approve">-6</span> <span class="fg-dim">session flow updated</span>`]
							: [`<span class="fg-dim">preview collapsed</span>`];
					for (const outputLine of outputLines) {
						rows.push(bodyRow(`<span class="fg-divider">│</span> ${outputLine}`, visibleLen(outputLine) + 2));
					}
					rows.push(bodyRow(`<span class="fg-divider">╰${rep("─", innerCols - 1)}</span>`, innerCols));
					continue;
				}

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
const PAD = 1; // 1-char l/r padding for chrome rows

// In portrait (sidebar hidden), hint row carries the project name + branch
// on the LEFT (since sidebar can't show them). In landscape, hint row is
// right-keybinds-only (sidebar shows project).
function buildHintRow(cols, sidebarVisible) {
	const rightHTML =
		`<span class="fg-accent">CTRL+/</span>` +
		`<span class="fg-dim"> \u00b7 COMMANDS</span>`;
	const rightLen = 17;

	if (sidebarVisible) {
		const lead = cols - rightLen - PAD * 2;
		return rep(" ", PAD) + rep(" ", Math.max(0, lead)) + rightHTML + rep(" ", PAD);
	}

	// Sidebar hidden: project + branch on the left
	const leftHTML = `<span class="fg-fg">sumocode</span> <span class="fg-dim">(main)</span>`;
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
		left = `<span class="fg-accent">SUMOCODE</span><span class="fg-dim">  \u2551 </span><span class="fg-accent">\u2022</span><span class="fg-dim"> 019dd3d8 \u2551</span>`;
		right = `<span class="fg-dim">ARCHIVE   </span><span class="fg-fg">\uf489</span><span class="fg-dim">  </span><span class="fg-fg">\uf423</span>`;
	} else {
		// Portrait: same SUMOCODE + active-session marker as landscape, just no
		// recent-session tabs and no ARCHIVE. Drop those entirely.
		left = `<span class="fg-accent">SUMOCODE</span><span class="fg-dim">  \u2551 </span><span class="fg-accent">\u2022</span><span class="fg-dim"> 019dd3d8 \u2551</span>`;
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
	// Gutter:
	//   landscape: 2 cols between chat and sidebar (column separator)
	//   portrait : 1 col on right of chat (matches chrome row padding)
	const GUTTER = sidebarVisible ? 2 : 1;
	const CHAT_COLS = sidebarVisible ? cols - sidebarCols - GUTTER : cols - GUTTER;

	const sidebarRows = sidebarVisible ? buildSidebarRows(sidebarCols) : [];
	const toolStyle = variant.toolStyle ?? "inline";
	const chatHTML = buildChatHTML(CHAT_COLS, toolStyle);
	const inputRows = buildInputFrameRows(cols);
	const hintRow = buildHintRow(cols, sidebarVisible);
	const footerRow = buildFooterRow(cols, sidebarVisible);
	const topBarRow = buildTopBarPlaceholder(cols);

	const middleCols = sidebarVisible
		? `${CHAT_COLS}ch ${GUTTER}ch ${sidebarCols}ch`
		: `${CHAT_COLS}ch ${GUTTER}ch`;

	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Bible · Scene · Active ${cols}×${TERM_ROWS}${toolStyle === "ledger" ? " · Tool Ledger" : toolStyle === "live" ? " · Bash Live View" : toolStyle === "code" ? " · Code Block" : toolStyle === "skill" ? " · Skill Pill" : toolStyle === "scroll" ? " · Scroll + Scribe" : ""}</title>
<link rel="stylesheet" href="_assets/tokens.css">
<style>
  .stage-blurb { max-width: ${Math.max(60, CHAT_COLS)}ch; color: var(--foreground-dim); font-size: 11px; line-height: 1.6; padding: 0 8px; text-align: center; }
  .scene { display: grid; grid-template-rows: var(--cell-h) var(--cell-h) var(--cell-h) auto var(--cell-h) calc(var(--cell-h) * 3) var(--cell-h) var(--cell-h) var(--cell-h) var(--cell-h); }
  .scene .middle { display: grid; grid-template-columns: ${middleCols}; grid-row: 4; min-height: 0; overflow: hidden; }
  .scene .middle .chat-col, .scene .middle .sidebar-col { overflow: hidden; min-height: 0; }
  .scene .middle pre { margin: 0; }
</style>
</head>
<body>
<div class="stage">
  <div class="stage-label">${toolStyle === "ledger" ? "scene · active state + ledger tool cards" : toolStyle === "live" ? "scene · active state + bash live-view card" : toolStyle === "code" ? "scene · active state + code block in SUMO chat" : toolStyle === "skill" ? "scene · active state + inline skill pill" : toolStyle === "scroll" ? "scene · active state + scroll/scribe delegation" : `scene · active state · ${cols}×${TERM_ROWS} ${sidebarVisible ? "landscape" : "portrait (sidebar hidden)"}`}</div>
  <div class="stage-blurb">${toolStyle === "ledger"
		? "Option 3A preview for Element 9: tool calls render as nested ledger cards inside the SUMO message box. Tests vertical rhythm, containment, and density in the full active scene."
		: toolStyle === "live"
			? "Option 3B preview inspired by lucasmeijer/pi-bash-live-view: bash renders as a live PTY viewport card with elapsed timer; non-bash tools remain compact."
			: toolStyle === "code"
				? "Element 10 preview in context: a framed, line-numbered TypeScript code block embedded inside a SUMO chat message."
				: toolStyle === "skill"
					? "Element 9a preview in context: Pi-minimal inline skill pill inside a SUMO chat message, with no decorative frame."
					: toolStyle === "scroll"
						? "Element 12 preview in context: delegated work appears as a [scroll] with a nested scribe ledger inside the SUMO chat frame."
						: sidebarVisible
			? "first scene composition: combines all 5 locked elements (top-bar placeholder, sidebar V2 editorial CONTEXT, chat boxed 7A, input frame, footer READY). validates the full visual gestalt before adding remaining elements."
			: "portrait variant. sidebar hidden (per Element 1 rule: < 120 col). chat takes full term width. footer collapses right zone (drops project + branch + $cost; keeps tokens). hint row: keybinds only (left flavour dropped at narrow widths)."}</div>
  <div data-render-rect class="term scene" style="--term-cols: ${cols}; --term-rows: ${TERM_ROWS};">
    <pre class="grid" style="grid-row: 1;"> </pre>
    <pre class="grid" style="grid-row: 2;">${topBarRow}</pre>
    <pre class="grid" style="grid-row: 3;"> </pre>
    <div class="middle">
      <div class="chat-col">${chatHTML}</div>
      <div class="gutter-col"></div>
      ${sidebarVisible ? `<div class="sidebar-col"><pre class="grid">${sidebarRows.join("\n")}</pre></div>` : ""}
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

for (const v of [
	{ filename: "scene-active.html", spec: LANDSCAPE },
	{ filename: "scene-active-portrait.html", spec: PORTRAIT },
	{ filename: "scene-active-tool-ledger.html", spec: { ...LANDSCAPE, toolStyle: "ledger" } },
	{ filename: "scene-active-bash-live-view.html", spec: { ...LANDSCAPE, toolStyle: "live" } },
	{ filename: "scene-active-code-block.html", spec: { ...LANDSCAPE, toolStyle: "code" } },
	{ filename: "scene-active-skill-pill.html", spec: { ...LANDSCAPE, toolStyle: "skill" } },
	{ filename: "scene-active-scroll-scribe.html", spec: { ...LANDSCAPE, toolStyle: "scroll" } },
]) {
	writeFileSync(resolve(out, v.filename), buildScene(v.spec));
	console.log(`wrote ${v.filename}  (${v.spec.cols}\u00d7${v.spec.rows})`);
}
