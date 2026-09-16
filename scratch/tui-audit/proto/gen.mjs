#!/usr/bin/env node
// SumoCode TUI — Ultraviolet prototypes (2026-09 TUI audit).
//
// Self-contained generator for scratch/tui-audit/proto/. Helpers, cell
// arithmetic, and the .term/.grid/.box-fill structure are copied from
// scripts/gen-bible-theme-ultraviolet-core.mjs so these explorations share the
// bible pipeline's conventions byte-for-byte. Nothing here is canon: winners
// get promoted into docs/ui/bible later.

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ansToHTMLLines } from "../../../scripts/lib/ansi-to-html.mjs";

const outDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(outDir, "..", "..", "..");

const COLS = 160;
const ROWS = 45;
const CHAT_COLS = 128;
const GUTTER = 2;
const SIDEBAR_COLS = 30;
const P_COLS = 60;
const P_ROWS = 100;

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

// ── primitives (copied from the bible generator) ──────────────────────────
const rep = (ch, n) => ch.repeat(Math.max(0, n));
const visibleLen = (s) =>
	s
		.replace(/<[^>]+>/g, "")
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&amp;/g, "&")
		.replace(/&nbsp;/g, " ").length;
const padRight = (s, n) => {
	const need = n - visibleLen(s);
	return need > 0 ? s + rep(" ", need) : s;
};
const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const gridLine = (text) => `<pre class="grid">${text}</pre>`;

/** A colored run. `len` is exact terminal cells (every glyph used is 1 cell). */
const S = (text, cls) => ({ html: cls ? `<span class="${cls}">${esc(text)}</span>` : esc(text), len: text.length });
const cat = (...parts) => ({
	html: parts.map((p) => p.html).join(""),
	len: parts.reduce((a, p) => a + p.len, 0),
});
const BLANK = { html: "", len: 0 };
/** A bg-painted span of exact width — the only safe way to fill a row's bg. */
const fill = (html, width, bgVar) =>
	`<span class="box-fill" style="${bgVar ? `background: var(${bgVar}); ` : ""}width: ${width}ch">${padRight(html, width)}</span>`;

// ── message frames ────────────────────────────────────────────────────────
/**
 * `╭ ROLE ──── right ─╮` … `╰────╯`. Every row closes at exactly `cols`.
 * `right` is an {html,len} run shown in the header's right zone.
 */
function frameMessage({ role, body, right = null, cols = CHAT_COLS }) {
	const inner = cols - 4;
	const roleClass = role === "SUMO" ? "fg-accent" : "fg-fg";
	const rightLen = right ? right.len + 2 : 0;
	const dashes = cols - 4 - role.length - rightLen;
	const rows = [];
	rows.push(
		`<span class="fg-divider">╭ </span><span class="${roleClass}">${role}</span> ` +
			`<span class="fg-divider">${rep("─", dashes)}</span>` +
			(right ? ` ${right.html} ` : "") +
			`<span class="fg-divider">╮</span>`,
	);
	for (const r of body) {
		rows.push(
			`<span class="fg-divider">│</span>` +
				`<span class="box-fill" style="width: ${inner + 2}ch"> ${r.html}${rep(" ", Math.max(0, inner - r.len))} </span>` +
				`<span class="fg-divider">│</span>`,
		);
	}
	rows.push(`<span class="fg-divider">╰${rep("─", cols - 2)}╯</span>`);
	return rows;
}

/** Compact USER row (variant 01b): no frame, `❯ text` fg + dim time right. */
function compactUser(text, time, cols = CHAT_COLS) {
	const left = `<span class="fg-accent">❯</span> <span class="fg-fg">${esc(text)}</span>`;
	const gap = cols - 2 - text.length - time.length;
	return [`${left}${rep(" ", Math.max(1, gap))}<span class="fg-dim">${time}</span>`];
}

// ── tool ledgers ──────────────────────────────────────────────────────────
const STATUS_CLS = { queued: "fg-dim", running: "fg-tool", settled: "fg-idle", failed: "fg-approve" };

/**
 * Consecutive tool calls share ONE box: `╭─ … ─╮` / `├─ … ─┤` / `╰───╯`.
 * `W` is the full box width; the caller guarantees W ≤ frame inner width.
 */
function ledgerStack(entries, W) {
	const rows = [];
	entries.forEach((entry, i) => {
		const { name, target, state = "settled", status = "", borderCls = "fg-tool-border" } = entry;
		const lead = i === 0 ? "╭─ " : "├─ ";
		const tail = i === 0 ? " ─╮" : " ─┤";
		const nb = name.length + 2;
		let shown = target;
		let dash = W - 9 - nb - shown.length - status.length;
		if (dash < 3) {
			shown = `${target.slice(0, Math.max(1, target.length - (3 - dash) - 1))}…`;
			dash = W - 9 - nb - shown.length - status.length;
		}
		const html =
			`<span class="${borderCls}">${lead}</span>` +
			`<span class="fg-tool-label">[${name}]</span>` +
			`<span class="fg-tool-target"> ${esc(shown)}</span> ` +
			`<span class="${borderCls}">${rep("─", Math.max(1, dash))}</span> ` +
			`<span class="${STATUS_CLS[state]}">${esc(status)}</span>` +
			`<span class="${borderCls}">${tail}</span>`;
		rows.push(html);
		// Header sits flush to its body; one row of air after each entry so the
		// next divider (or the bottom rule) never touches content.
		for (const b of [...entry.body, BLANK]) {
			rows.push(
				`<span class="${borderCls}">│</span> ${b.html}${rep(" ", Math.max(0, W - 4 - b.len))} <span class="${borderCls}">│</span>`,
			);
		}
	});
	rows.push(`<span class="fg-tool-border">╰${rep("─", W - 2)}╯</span>`);
	return rows.map((html) => ({ html: fill(html, W, "--tool-ledger-surface"), len: W }));
}

/** Today's open-right, one-box-per-call ledger (the "before" shape). */
function legacyLedger({ name, target, status = "✓", body }, W) {
	const rows = [];
	const title = `[${name}]  ${target}`;
	rows.push(
		`<span class="fg-tool-border">╭─ </span><span class="fg-tool-label">[${name}]</span>` +
			`<span class="fg-tool-target">  ${esc(target)}</span> ` +
			`<span class="fg-tool-border">${rep("─", Math.max(1, W - title.length - status.length - 5))}</span> ` +
			`<span class="fg-idle">${esc(status)}</span>`,
	);
	for (const b of body) rows.push(b.html);
	rows.push(`<span class="fg-tool-border">╰${rep("─", W - 1)}</span>`);
	return rows.map((html) => ({ html: fill(html, W, "--tool-ledger-surface"), len: W }));
}

// ── ledger body content ───────────────────────────────────────────────────
const gutterLine = (n, code) => cat(S(String(n).padStart(3) + "  ", "fg-tool-muted"), S(code, "fg-tool-body"));
const fold = (text) => S(text, "fg-tool-muted");
const diff = (line) =>
	S(line, line.startsWith("+") ? "fg-learn" : line.startsWith("-") ? "fg-approve" : line.startsWith("@@") ? "fg-tool-muted" : "fg-tool-body");

const READ_ENTRY = (W) => ({
	name: "read",
	target: "src/auth/session.ts",
	state: "settled",
	status: "✓ 340 lines",
	body: [
		gutterLine(1, 'import { z } from "zod";'),
		gutterLine(2, 'import type { User } from "./user.js";'),
		gutterLine(3, 'import { Result } from "../result.js";'),
		fold("↓ 337 more lines"),
	],
});
const EDIT_ENTRY = {
	name: "edit",
	target: "src/auth/session.ts",
	state: "settled",
	status: "✓ +14 −6",
	body: [
		diff("@@ 41,7 @@ export function getSession"),
		diff("-   return user;"),
		diff("+   return Result.ok(user);"),
		fold("↓ 2 more hunks"),
	],
};
const BASH_ENTRY = {
	name: "bash",
	target: "pnpm test src/auth",
	state: "settled",
	status: "✓ 22 tests",
	body: [
		cat(S("> ", "fg-tool-muted"), S("pnpm test src/auth --reporter=verbose", "fg-tool-body")),
		fold("↑ 230 earlier lines"),
		cat(S("✓ ", "fg-idle"), S("src/auth/session.test.ts > revoke > idempotent", "fg-tool-body")),
		S(" Tests  22 passed (22)", "fg-tool-body"),
	],
};

// ── chrome ────────────────────────────────────────────────────────────────
function topBarLegacy() {
	const left = `<span class="fg-accent">SUMOCODE</span><span class="fg-dim">  ║ </span><span class="fg-accent">•</span><span class="fg-dim"> 019dd3d8 ║</span>`;
	const right = `<span class="fg-dim">ARCHIVE   </span><span class="fg-fg">\uF489</span><span class="fg-dim">  </span><span class="fg-fg">\uF423</span>`;
	return ` ${left}${rep(" ", COLS - visibleLen(left) - visibleLen(right) - 2)}${right} `;
}

/** After: one question only — where am I. Active session, then dim recents. */
function topBar(cols = COLS, { active = "auth-refactor", recents = ["ledger-audit", "bible-render", "tree-triage"] } = {}) {
	let left =
		`<span class="fg-accent">SUMOCODE</span>` +
		`<span class="fg-dim">  ║ </span><span class="fg-accent">•</span> <span class="fg-fg">${esc(active)}</span><span class="fg-dim"> ║</span>`;
	for (const r of recents) left += `<span class="fg-dim">   ${esc(r)}</span>`;
	return ` ${padRight(left, cols - 2)} `;
}

const FOOTER_STATES = {
	ready: { glyph: "●", cls: "fg-idle", label: "READY" },
	tool: { glyph: "●", cls: "fg-tool", label: "TOOL" },
	thinking: { glyph: "◐", cls: "fg-think", label: "THINKING" },
	awaiting: { glyph: "◆", cls: "fg-approve", label: "AWAITING" },
};

function footerLegacy() {
	const left = `<span class="fg-idle">●</span> <span class="fg-fg">READY</span><span class="fg-dim"> · </span><span class="fg-fg">gpt-5.5</span><span class="fg-dim"> · </span><span class="fg-fg">medium</span>`;
	const right = `<span class="fg-accent">CTRL+/</span><span class="fg-dim"> · COMMANDS</span>`;
	return ` ${left}${rep(" ", COLS - visibleLen(left) - visibleLen(right) - 2)}${right} `;
}

/** After: state left, exactly four keybinds right. */
function footerRow(state = "ready", cols = COLS) {
	const s = FOOTER_STATES[state];
	const left =
		`<span class="${s.cls}">${s.glyph}</span> <span class="fg-fg">${s.label}</span>` +
		`<span class="fg-dim"> · </span><span class="fg-fg">gpt-5.5</span><span class="fg-dim"> · </span><span class="fg-fg">medium</span>`;
	const hints = [
		["⌃O", "ledgers"],
		["⇧⇥", "thinking"],
		["⌃P", "model"],
		["⌃/", "commands"],
	];
	const right = hints
		.map(([k, l]) => `<span class="fg-accent">${k}</span> <span class="fg-dim">${l}</span>`)
		.join(`<span class="fg-divider"> · </span>`);
	return ` ${left}${rep(" ", cols - visibleLen(left) - visibleLen(right) - 2)}${right} `;
}

function inputFrame({ corners = "round", cols = COLS, placeholder = null } = {}) {
	const [tl, tr, bl, br] = corners === "round" ? ["╭", "╮", "╰", "╯"] : ["┌", "┐", "└", "┘"];
	const inner = cols - 2;
	const mid = placeholder
		? `<span class="fg-divider">│</span> <span class="fg-accent">❯</span> <span class="fg-dim">${esc(placeholder)}</span>${rep(" ", cols - 5 - placeholder.length)}<span class="fg-divider">│</span>`
		: `<span class="fg-divider">│</span> <span class="fg-accent">${corners === "round" ? "❯" : "&gt;"}</span> <span class="cursor"> </span>${rep(" ", cols - 6)}<span class="fg-divider">│</span>`;
	return [
		fill(`<span class="fg-divider">${tl}${rep("─", inner)}${tr}</span>`, cols, "--surface-recess"),
		fill(mid, cols, "--surface-recess"),
		fill(`<span class="fg-divider">${bl}${rep("─", inner)}${br}</span>`, cols, "--surface-recess"),
	];
}

// ── docked Scriptorium panel (replaces centered modals) ───────────────────
let PANEL_COLS = COLS; // Q11: (a) full band = 160, (b) chat width = 128
const panelRow = (run, cols = PANEL_COLS) =>
	fill(
		`<span class="fg-divider">│</span> ${run.html}${rep(" ", Math.max(0, cols - 4 - run.len))} <span class="fg-divider">│</span>`,
		cols,
		"--surface-lifted",
	);

function panelTop(title, note = null, cols = PANEL_COLS) {
	const t = `✾ ${title} ✾`;
	const noteLen = note ? note.length + 2 : 0;
	const inner = cols - 2;
	const block = t.length + 2;
	const left = Math.floor((inner - block - noteLen) / 2);
	const right = inner - block - noteLen - left;
	const html =
		`<span class="fg-divider">╭${rep("─", left)} </span>` +
		`<span class="fg-accent">${esc(t)}</span>` +
		`<span class="fg-divider"> ${rep("─", right)}</span>` +
		(note ? ` <span class="fg-dim">${esc(note)}</span> ` : "") +
		`<span class="fg-divider">╮</span>`;
	return fill(html, cols, "--surface-lifted");
}

const panelBottom = (cols = PANEL_COLS) =>
	fill(`<span class="fg-divider">╰${rep("─", cols - 2)}╯</span>`, cols, "--surface-lifted");

/** Scriptorium split rule: `──── · ────`, centered in the panel's content. */
function splitRule(cols = PANEL_COLS) {
	const width = cols - 4;
	const ruleLen = Math.max(1, Math.min(30, Math.floor((width - 5) / 2)));
	const piece = ruleLen * 2 + 5;
	const lead = Math.floor((width - piece) / 2);
	return cat(
		S(rep(" ", lead)),
		S(rep("─", ruleLen), "fg-divider"),
		S("  ·  ", "fg-divider"),
		S(rep("─", ruleLen), "fg-divider"),
	);
}

const hintRow = (pairs) =>
	cat(...pairs.flatMap(([k, l], i) => [S(i ? "   " : ""), S(k, "fg-accent"), S(" "), S(l, "fg-dim")]));

/** `❋` focused / `·` unfocused, per cathedral/scriptorium-chrome.ts. */
const mark = (focused, cls = "fg-accent") => (focused ? S("❋", cls) : S("·", "fg-divider"));

// ── sidebar ───────────────────────────────────────────────────────────────
const sbCell = (h) => fill(h, SIDEBAR_COLS, "--surface");
const sbRule = () => sbCell(`  <span class="fg-divider">${rep("─", 26)}</span>`);
const sbBlank = () => sbCell("");

/** Today's sidebar: tab row + MEMORY + the `> > CONTEXT` glyph doubling bug. */
function sidebarLegacy() {
	const rows = [sbBlank(), sbCell(`  <span class="fg-accent"># REGISTRY</span>`), sbBlank()];
	rows.push(sbCell(`  <span class="fg-accent">&gt;</span> <span class="fg-fg">&gt; CONTEXT</span>`));
	rows.push(sbCell(`  <span class="fg-dim">. + MEMORY</span>`));
	rows.push(sbBlank(), sbRule(), sbBlank());
	rows.push(sbCell(`  <span class="fg-fg">sumocode</span>`), sbCell(`  <span class="fg-dim">on main</span>`), sbBlank());
	rows.push(sbCell(`  <span class="fg-dim">&gt; CONTEXT</span>`));
	rows.push(sbCell(`  <span class="fg-idle">${rep("▉", 5)}</span><span class="fg-divider">${rep("░", 17)}</span>`));
	rows.push(sbCell(`  <span class="fg-fg">42k</span> <span class="fg-dim">/ 200k</span>`), sbBlank());
	rows.push(sbCell(`  <span class="fg-dim">~ SESSION</span>`));
	rows.push(sbCell(`  <span class="fg-fg">$0.42</span> <span class="fg-dim">· 3.4M cumul</span>`));
	rows.push(sbBlank(), sbRule(), sbBlank(), sbCell(`  <span class="fg-dim">* MCP</span>`), sbBlank());
	for (const [name, state] of [
		["github", "idle"],
		["stitch", "ok"],
		["context7", "idle"],
		["chrome-dev", "idle"],
	]) {
		const cls = state === "ok" ? "fg-idle" : "fg-dim";
		const pad = SIDEBAR_COLS - 4 - name.length - state.length - 2;
		rows.push(sbCell(`  <span class="${cls}">●</span> <span class="fg-fg">${name}</span>${rep(" ", Math.max(1, pad))}<span class="fg-dim">${state}</span>  `));
	}
	return rows;
}

/**
 * `  ▶ name        right`. Keeps a 2-col right margin when the row has slack;
 * falls back to flush when it does not (the spec's own AGENTS sample row is
 * 32 cells wide and 30 is the whole sidebar — flush is the only exact fit).
 */
const rosterMargin = (rows) =>
	Math.min(...rows.map(([, , name, right]) => (SIDEBAR_COLS - 4 - name.length - right.length >= 3 ? 2 : 0)));

const rosterRow = (glyph, glyphCls, name, right, margin = 2, rightCls = "fg-dim") => {
	const body = 4 + name.length + right.length; // indent + glyph + space + …
	const pad = SIDEBAR_COLS - body - margin;
	return sbCell(
		`  <span class="${glyphCls}">${glyph}</span> <span class="fg-fg">${esc(name)}</span>` +
			`${rep(" ", Math.max(1, pad))}<span class="${rightCls}">${esc(right)}</span>${rep(" ", margin)}`,
	);
};

/**
 * After: five sections, no tab row, no MEMORY. `gap` is the spacing-scale gap
 * between section groups (2 rows when there is room, 1 when the docked panel
 * has eaten the middle band).
 */
function sidebar({ gap = 2, agents = null, terminals = null } = {}) {
	const g = () => Array.from({ length: gap }, sbBlank);
	const rows = [sbBlank()];
	rows.push(sbCell(`  <span class="fg-accent"># REGISTRY</span>`));
	rows.push(sbRule());
	rows.push(sbCell(`  <span class="fg-fg">sumocode</span>`));
	rows.push(sbCell(`  <span class="fg-dim">on main</span>`));
	rows.push(...g());
	rows.push(sbCell(`  <span class="fg-dim">&gt; CONTEXT</span>`));
	rows.push(sbCell(`  <span class="fg-idle">${rep("▉", 5)}</span><span class="fg-divider">${rep("░", 17)}</span>`));
	rows.push(sbCell(`  <span class="fg-fg">42k</span> <span class="fg-dim">/ 200k</span>`));
	rows.push(sbBlank());
	rows.push(sbCell(`  <span class="fg-dim">~ SESSION</span>`));
	rows.push(sbCell(`  <span class="fg-fg">$0.42</span> <span class="fg-dim">· 3.4M cumul</span>`));
	rows.push(sbBlank());
	rows.push(sbRule());
	rows.push(sbCell(`  <span class="fg-dim">* MCP</span>`));
	rows.push(rosterRow("●", "fg-dim", "github", "idle"));
	rows.push(rosterRow("●", "fg-idle", "stitch", "ok"));
	rows.push(sbBlank());
	rows.push(sbRule());
	rows.push(sbCell(`  <span class="fg-dim">● AGENTS</span>`));
	const agentRows = agents ?? [
		["▶", "fg-tool", "audit-render", "research 4:12"],
		["▶", "fg-tool", "audit-ux", "research 3:58"],
		["✓", "fg-idle", "bible-tooling", "research"],
	];
	if (agentRows.length === 0) rows.push(sbCell(`    <span class="fg-dim">no agents running</span>`));
	const agentMargin = agentRows.length ? rosterMargin(agentRows) : 2;
	for (const [gl, cls, name, right] of agentRows) rows.push(rosterRow(gl, cls, name, right, agentMargin));
	rows.push(sbBlank());
	rows.push(sbRule());
	rows.push(sbCell(`  <span class="fg-dim">▶ TERMINALS</span>`));
	const termRows = terminals ?? [["▶", "fg-tool", "pnpm dev", ":8797"]];
	if (termRows.length === 0) rows.push(sbCell(`    <span class="fg-dim">no terminals</span>`));
	for (const [gl, cls, name, right] of termRows) rows.push(rosterRow(gl, cls, name, right));
	return rows;
}

/** Pick the densest sidebar that fits `height` rows without clipping. */
function sidebarFor(height, opts = {}) {
	for (const gap of [2, 1]) {
		const rows = sidebar({ ...opts, gap });
		if (rows.length <= height) return rows;
	}
	const rows = sidebar({ ...opts, gap: 1 }).slice(1);
	return rows;
}

// ── sidebar variants (impeccable bolder: one decisive move each) ─────────
const NNBSP = "\u202f";
const tracked = (label) => label.split("").join(NNBSP);
const right = (left, rightText, leftCls = "fg-fg", rightCls = "fg-dim", indent = 2) =>
	sbCell(
		`${rep(" ", indent)}<span class="${leftCls}">${esc(left)}</span>` +
			`${rep(" ", Math.max(1, SIDEBAR_COLS - indent - left.length - rightText.length - 2))}<span class="${rightCls}">${esc(rightText)}</span>  `,
	);
const AGENTS = [
	["▶", "fg-tool", "audit-render", "research", "4:12", 0.62, "comparing 14 parity renders"],
	["▶", "fg-tool", "audit-ux", "research", "3:58", 0.41, "reading rpc/host-actions.ts"],
	["✓", "fg-idle", "bible-tooling", "research", "6:41", 1, "9 findings · settled"],
];
const TERMS = [["▶", "fg-tool", "pnpm dev", ":8797", "ready on localhost:8797"]];

/** A · EDITORIAL — the Bible's locked Element-1 masthead voice: tracked-out labels, thick ━ rules, no sigils. */
function sidebarEditorial() {
	const head = (t) => sbCell(`  <span class="fg-dim">${tracked(t)}</span>`);
	const rule = () => sbCell(`  <span class="fg-divider">${rep("━", 26)}</span>`);
	const rows = [sbBlank()];
	rows.push(sbCell(`  <span class="fg-accent">${tracked("REGISTRY")}</span>`));
	rows.push(rule());
	rows.push(sbBlank());
	rows.push(sbCell(`  <span class="fg-fg">sumocode</span>`));
	rows.push(sbCell(`  <span class="fg-dim">on main</span>`));
	rows.push(sbBlank());
	rows.push(head("CONTEXT"));
	rows.push(sbCell(`  <span class="fg-idle">${rep("▉", 5)}</span><span class="fg-divider">${rep("░", 17)}</span>`));
	rows.push(sbCell(`  <span class="fg-fg">42k</span> <span class="fg-dim">/ 200k</span>`));
	rows.push(sbBlank());
	rows.push(head("SESSION"));
	rows.push(sbCell(`  <span class="fg-fg">$0.42</span> <span class="fg-dim">· 3.4M cumul</span>`));
	rows.push(sbBlank());
	rows.push(rule());
	rows.push(sbBlank());
	rows.push(head("MCP"));
	rows.push(rosterRow("●", "fg-dim", "github", "idle"));
	rows.push(rosterRow("●", "fg-idle", "stitch", "ok"));
	rows.push(sbBlank());
	rows.push(head("AGENTS"));
	for (const [g, c, n, , el] of AGENTS) rows.push(rosterRow(g, c, n, el));
	rows.push(sbBlank());
	rows.push(head("TERMINALS"));
	for (const [g, c, n, p] of TERMS) rows.push(rosterRow(g, c, n, p));
	return rows;
}

/** B · LEDGER — every section is a two-column ledger; agents carry a budget bar. Data-first. */
function sidebarLedger() {
	const head = (sig, t, note = "") => right(`${sig} ${t}`, note, "fg-accent", "fg-dim");
	const bar = (f, w = 8) => {
		const n = Math.round(f * w);
		return `<span class="fg-tool">${rep("▉", n)}</span><span class="fg-divider">${rep("░", w - n)}</span>`;
	};
	const rows = [sbBlank()];
	rows.push(head("#", "REGISTRY", "sumocode · main"));
	rows.push(sbRule());
	rows.push(head(">", "CONTEXT", "42k / 200k"));
	rows.push(sbCell(`  <span class="fg-idle">${rep("▉", 5)}</span><span class="fg-divider">${rep("░", 17)}</span>`));
	rows.push(head("~", "SESSION", "$0.42"));
	rows.push(right("cumulative", "3.4M tok", "fg-dim"));
	rows.push(right("turns", "14", "fg-dim"));
	rows.push(sbRule());
	rows.push(head("*", "MCP", "2 servers"));
	rows.push(right("github", "idle", "fg-fg", "fg-dim", 4));
	rows.push(right("stitch", "ok", "fg-fg", "fg-idle", 4));
	rows.push(sbRule());
	rows.push(head("●", "AGENTS", "2 running"));
	for (const [g, c, n, , el, f] of AGENTS) {
		rows.push(sbCell(`  <span class="${c}">${g}</span> <span class="fg-fg">${esc(n)}</span>${rep(" ", Math.max(1, SIDEBAR_COLS - 4 - n.length - el.length - 2))}<span class="fg-dim">${el}</span>  `));
		rows.push(sbCell(`    ${bar(f)}${rep(" ", SIDEBAR_COLS - 4 - 8 - 6)}<span class="fg-dim">${String(Math.round(f * 100)).padStart(3)}%</span> `));
	}
	rows.push(sbRule());
	rows.push(head("▶", "TERMINALS", "1 live"));
	for (const [g, c, n, p] of TERMS) rows.push(rosterRow(g, c, n, p));
	return rows;
}

/** C · QUIET — no rules, no sigils; dim labels, generous air. The transcript owns the eye. */
function sidebarQuiet() {
	const head = (t) => sbCell(`  <span class="fg-divider">${t}</span>`);
	const rows = [sbBlank(), sbBlank()];
	rows.push(sbCell(`  <span class="fg-fg">sumocode</span> <span class="fg-dim">on main</span>`));
	rows.push(sbBlank(), sbBlank());
	rows.push(head("context"));
	rows.push(sbCell(`  <span class="fg-idle">${rep("▉", 5)}</span><span class="fg-divider">${rep("░", 17)}</span> <span class="fg-dim">21%</span>`));
	rows.push(sbBlank(), sbBlank());
	rows.push(head("session"));
	rows.push(sbCell(`  <span class="fg-fg">$0.42</span> <span class="fg-dim">· 3.4M cumul</span>`));
	rows.push(sbBlank(), sbBlank());
	rows.push(head("mcp"));
	rows.push(rosterRow("●", "fg-dim", "github", "idle"));
	rows.push(rosterRow("●", "fg-idle", "stitch", "ok"));
	rows.push(sbBlank(), sbBlank());
	rows.push(head("agents"));
	for (const [g, c, n, , el] of AGENTS) rows.push(rosterRow(g, c, n, el));
	rows.push(sbBlank(), sbBlank());
	rows.push(head("terminals"));
	for (const [g, c, n, p] of TERMS) rows.push(rosterRow(g, c, n, p));
	return rows;
}

/** D · MONITOR — agents and terminals get a second row: last activity line in dim. Built for watching. */
function sidebarMonitor() {
	const rows = [sbBlank()];
	rows.push(sbCell(`  <span class="fg-accent"># REGISTRY</span>`));
	rows.push(sbRule());
	rows.push(sbCell(`  <span class="fg-fg">sumocode</span> <span class="fg-dim">on main</span>`));
	rows.push(sbBlank());
	rows.push(right("> CONTEXT", "42k / 200k", "fg-dim"));
	rows.push(sbCell(`  <span class="fg-idle">${rep("▉", 5)}</span><span class="fg-divider">${rep("░", 17)}</span>`));
	rows.push(right("~ SESSION", "$0.42 · 3.4M", "fg-dim"));
	rows.push(sbBlank());
	rows.push(sbRule());
	rows.push(sbCell(`  <span class="fg-dim">* MCP</span>`));
	rows.push(rosterRow("●", "fg-dim", "github", "idle"));
	rows.push(rosterRow("●", "fg-idle", "stitch", "ok"));
	rows.push(sbBlank());
	rows.push(sbRule());
	rows.push(sbCell(`  <span class="fg-dim">● AGENTS</span>`));
	for (const [g, c, n, , el, , last] of AGENTS) {
		rows.push(rosterRow(g, c, n, el));
		rows.push(sbCell(`    <span class="fg-dim">${esc(last.length > SIDEBAR_COLS - 6 ? last.slice(0, SIDEBAR_COLS - 7) + "…" : last)}</span>`));
	}
	rows.push(sbBlank());
	rows.push(sbRule());
	rows.push(sbCell(`  <span class="fg-dim">▶ TERMINALS</span>`));
	for (const [g, c, n, p, last] of TERMS) {
		rows.push(rosterRow(g, c, n, p));
		rows.push(sbCell(`    <span class="fg-dim">${esc(last.length > SIDEBAR_COLS - 6 ? last.slice(0, SIDEBAR_COLS - 7) + "…" : last)}</span>`));
	}
	return rows;
}

/**
 * E · HYBRID — B's counts on every heading + D's second row, but only where the
 * host actually has data: headless children stream liveText/liveTools
 * (`manager.ts:1411-1419`) so they get a last-activity row; visible (pane)
 * children are liveness-only (`manager.ts:1581`) so they get one row with a
 * pane marker instead. A stalled child (budget policy) flips its glyph to ◆
 * in approval pink on either kind — the one signal a pane cannot show you.
 */
function sidebarHybrid() {
	const head = (sig, t, note = "") => right(`${sig} ${t}`, note, "fg-accent", "fg-dim");
	// Section boundary: air above the heading (blank · rule · blank); heading flush to its content.
	const section = () => [sbBlank(), sbRule(), sbBlank()];
	const rows = [sbBlank()];
	rows.push(head("#", "REGISTRY", "sumocode · main"));
	rows.push(sbRule()); // masthead underline stays flush, like the wordmark rule
	rows.push(sbBlank());
	rows.push(head(">", "CONTEXT", "42k / 200k"));
	rows.push(sbCell(`  <span class="fg-idle">${rep("▉", 5)}</span><span class="fg-divider">${rep("░", 17)}</span>`));
	rows.push(sbBlank());
	rows.push(head("~", "SESSION", "$0.42 · 3.4M"));
	rows.push(...section());
	rows.push(head("*", "MCP", "2 servers"));
	rows.push(rosterRow("●", "fg-dim", "github", "idle"));
	rows.push(rosterRow("●", "fg-idle", "stitch", "ok"));
	rows.push(...section());
	rows.push(head("●", "AGENTS", "3 running · 1 pane"));
	// [glyph, cls, name, elapsed, kind, second]
	const agents = [
		["▶", "fg-tool", "audit-render", "4:12", "headless", "read parity/summary.md"],
		["▶", "fg-tool", "yoga3-migration", "18:40", "pane", "w32:p5"],
		["◆", "fg-approve", "audit-ux", "9:58", "headless", "no progress for 6m"],
		["✓", "fg-idle", "bible-tooling", "6:41", "headless", "9 findings"],
	];
	agents.forEach(([g, c, n, el, kind, second], i) => {
		if (i > 0) rows.push(sbBlank()); // one blank between agent units
		if (kind === "pane") {
			rows.push(rosterRow(g, c, n, `⧉ ${second}`));
		} else {
			rows.push(rosterRow(g, c, n, el));
			const cls = g === "◆" ? "fg-approve" : "fg-dim";
			rows.push(sbCell(`    <span class="${cls}">${esc(second.length > SIDEBAR_COLS - 6 ? second.slice(0, SIDEBAR_COLS - 7) + "…" : second)}</span>`));
		}
	});
	rows.push(...section());
	rows.push(head("▶", "TERMINALS", "1 live"));
	for (const [g, c, n, p, last] of TERMS) {
		rows.push(rosterRow(g, c, n, p));
		rows.push(sbCell(`    <span class="fg-dim">${esc(last.length > SIDEBAR_COLS - 6 ? last.slice(0, SIDEBAR_COLS - 7) + "…" : last)}</span>`));
	}
	return rows;
}

// ── scene skeleton ────────────────────────────────────────────────────────
/**
 * Row budget: 3 chrome rows (blank / top bar / blank) + middle + 1 blank +
 * band + footer + 1 trailing blank === rows. `.middle` is the only flexible
 * track, so every scene is exactly cols × rows.
 */
function buildScene({ title, cols, rows, chatCols, sidebarCols, chatRows, sidebarRows, bandRows, footerRows, topBarHtml, gapRow = " " }) {
	const footerCount = footerRows.length;
	const middleRows = rows - 5 - bandRows.length - footerCount;
	const chat = chatRows.slice(0, middleRows);
	while (chat.length < middleRows) chat.push("");
	const chatLines = chat.map((r) => padRight(r, chatCols));
	let sideLines = null;
	if (sidebarCols) {
		const side = (sidebarRows ?? []).slice(0, middleRows);
		while (side.length < middleRows) side.push(fill("", sidebarCols, "--surface"));
		sideLines = side;
	}
	const middleCols = sidebarCols ? `${chatCols}ch ${GUTTER}ch ${sidebarCols}ch` : `${chatCols}ch`;
	const middleInner = sidebarCols
		? `<div class="chat-col"><pre class="grid">${chatLines.join("\n")}</pre></div><div class="gutter-col"></div><div class="sidebar-col"><pre class="grid">${sideLines.join("\n")}</pre></div>`
		: `<div class="chat-col"><pre class="grid">${chatLines.join("\n")}</pre></div>`;
	const template = [
		"var(--cell-h)",
		"var(--cell-h)",
		"var(--cell-h)",
		`calc(var(--cell-h) * ${middleRows})`,
		"var(--cell-h)",
		`calc(var(--cell-h) * ${bandRows.length})`,
		`calc(var(--cell-h) * ${footerCount})`,
		"var(--cell-h)",
	].join(" ");
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="_assets/tokens.css">
<style>
  :root {
    --background: ${UV.background}; --surface: ${UV.surface}; --surface-recess: ${UV.surfaceRecess}; --surface-lifted: ${UV.surfaceLifted};
    --divider: ${UV.divider}; --foreground: ${UV.foreground}; --foreground-dim: ${UV.foregroundDim}; --accent: ${UV.accent};
    --state-idle: ${UV.stateIdle}; --state-thinking: ${UV.stateThinking}; --state-tool: ${UV.stateTool}; --state-approval: ${UV.stateApproval}; --state-learning: ${UV.stateLearning};
    --syntax-keyword: ${UV.codeKeyword}; --syntax-string: ${UV.codeString}; --syntax-number: ${UV.codeNumber}; --syntax-comment: ${UV.codeComment}; --syntax-function: ${UV.codeFunction};
    --tool-ledger-surface: ${UV.toolSurface}; --tool-ledger-border: ${UV.toolBorder}; --tool-ledger-label: ${UV.toolLabel}; --tool-ledger-target: ${UV.toolTarget}; --tool-ledger-body: ${UV.toolBody}; --tool-ledger-muted: ${UV.toolMuted};
    --code-surface: ${UV.codeSurface}; --code-border: ${UV.codeBorder}; --code-foreground: ${UV.codeForeground}; --code-gutter: ${UV.codeGutter}; --code-comment: ${UV.codeComment}; --code-keyword: ${UV.codeKeyword}; --code-string: ${UV.codeString}; --code-number: ${UV.codeNumber}; --code-function: ${UV.codeFunction};
  }
  .fg-tool-border { color: var(--tool-ledger-border); } .fg-tool-label { color: var(--tool-ledger-label); } .fg-tool-target { color: var(--tool-ledger-target); } .fg-tool-body { color: var(--tool-ledger-body); } .fg-tool-muted { color: var(--tool-ledger-muted); }
  .fg-code-border { color: var(--code-border); } .fg-code { color: var(--code-foreground); } .fg-code-gutter { color: var(--code-gutter); }
  .scene { display: grid; grid-template-rows: ${template}; }
  .scene .middle { display: grid; grid-template-columns: ${middleCols}; grid-row: 4; min-height: 0; overflow: hidden; }
  .scene .middle .chat-col, .scene .middle .sidebar-col { overflow: hidden; min-height: 0; }
  .scene .middle pre { margin: 0; }
  body.runtime-target { background: var(--background); }
  body.runtime-target .stage { min-height: 0; align-items: flex-start; justify-content: flex-start; padding: 0; gap: 0; }
</style>
</head>
<body class="runtime-target">
<div class="stage">
  <div data-render-rect class="term scene" style="--term-cols: ${cols}; --term-rows: ${rows};">
    ${gridLine(" ")}
    ${gridLine(topBarHtml)}
    ${gridLine(" ")}
    <div class="middle">${middleInner}</div>
    ${gridLine(gapRow)}
    ${gridLine(bandRows.join("\n"))}
    ${gridLine(footerRows.join("\n"))}
    ${gridLine(" ")}
  </div>
</div>
</body>
</html>
`;
}

const landscape = (o) =>
	buildScene({ cols: COLS, rows: ROWS, chatCols: CHAT_COLS, sidebarCols: SIDEBAR_COLS, ...o });

// ── transcripts ───────────────────────────────────────────────────────────
const LW = CHAT_COLS - 4; // ledger box width inside a chat frame: 124

/** Scene 00 — today's runtime, reproduced from the tool-ledger parity render. */
function baselineChat() {
	const rows = [];
	rows.push(...frameMessage({ role: "USER", body: [S("hello, refactor the auth flow to use the new session pattern.", "fg-fg")] }));
	rows.push("");
	rows.push(
		...frameMessage({
			role: "SUMO",
			right: S("11:42", "fg-dim"),
			body: [
				S("Reading the auth flow.", "fg-fg"),
				BLANK,
				...legacyLedger(
					{ name: "read", target: "src/auth/session.ts", body: [S("no output captured", "fg-tool-muted")] },
					LW,
				),
				BLANK,
				...legacyLedger(
					{
						name: "edit",
						target: "src/auth/session.ts",
						body: [cat(S("+14 ", "fg-idle"), S("-6 ", "fg-approve"), S("session flow updated", "fg-tool-muted"))],
					},
					LW,
				),
				BLANK,
				S("Done. Updated 14 lines, deleted 6 stale helpers.", "fg-fg"),
			],
		}),
	);
	rows.push("");
	rows.push(...frameMessage({ role: "USER", body: [S("run tests", "fg-fg")] }));
	rows.push("");
	rows.push(
		...frameMessage({
			role: "SUMO",
			right: S("11:43", "fg-dim"),
			body: [
				S("Running tests now.", "fg-fg"),
				BLANK,
				...legacyLedger(
					{
						name: "bash",
						target: "pnpm test src/auth",
						status: "✓ 22 tests, 1.2s",
						body: [
							S("> pnpm test src/auth", "fg-tool-body"),
							cat(S("✓ ", "fg-idle"), S("src/auth/session.test.ts (22 tests)", "fg-tool-body")),
							S("22 passed in 1.2s", "fg-tool-muted"),
						],
					},
					LW,
				),
				BLANK,
				S("All 22 tests pass.", "fg-fg"),
			],
		}),
	);
	return rows;
}

/**
 * Scenes 01/04/04b/05/06 — same transcript on the spacing scale:
 * gap 0 USER→SUMO and inside the stack, gap 1 prose↔stack and between turns.
 */
function rhythmChat({ compactUsers = false } = {}) {
	const rows = [];
	const user = (text, time) =>
		compactUsers ? compactUser(text, time) : frameMessage({ role: "USER", body: [S(text, "fg-fg")] });
	rows.push(...user("hello, refactor the auth flow to use the new session pattern.", "11:42"));
	rows.push(
		...frameMessage({
			role: "SUMO",
			right: S("11:42", "fg-dim"),
			body: [
				S("Reading the auth flow.", "fg-fg"),
				BLANK,
				...ledgerStack([READ_ENTRY(LW), EDIT_ENTRY], LW),
				BLANK,
				S("Done. Updated 14 lines, deleted 6 stale helpers.", "fg-fg"),
			],
		}),
	);
	rows.push("");
	rows.push(...user("run tests", "11:43"));
	rows.push(
		...frameMessage({
			role: "SUMO",
			right: S("11:43", "fg-dim"),
			body: [
				S("Running tests now.", "fg-fg"),
				BLANK,
				...ledgerStack([BASH_ENTRY], LW),
				BLANK,
				S("All 22 tests pass.", "fg-fg"),
			],
		}),
	);
	return rows;
}

/** Keep the newest turn pinned to the bottom when a docked panel steals rows. */
const tail = (rows, n) => (rows.length <= n ? rows : rows.slice(rows.length - n));

// ── scene 02: every ledger body policy in one stack ───────────────────────
function ledgerStatesChat() {
	const entries = [
		{
			name: "read",
			target: "src/auth/session.ts",
			state: "settled",
			status: "✓ 340 lines",
			body: [gutterLine(1, 'import { z } from "zod";'), fold("↓ 339 more lines")],
		},
		{
			name: "edit",
			target: "src/auth/session.ts",
			state: "settled",
			status: "✓ +14 −6",
			body: [diff("-   return user;"), diff("+   return Result.ok(user);")],
		},
		{
			name: "write",
			target: "src/auth/session.types.ts",
			state: "settled",
			status: "✓ 62 lines",
			body: [S("62 lines written", "fg-tool-muted")],
		},
		{
			name: "bash",
			target: "pnpm test src/auth",
			state: "running",
			status: "▶ 00:12",
			body: [
				cat(S("> ", "fg-tool-muted"), S("pnpm test src/auth --reporter=verbose", "fg-tool-body")),
				fold("↑ 230 earlier lines"),
				cat(S("✓ ", "fg-idle"), S("src/auth/session.test.ts > revoke > idempotent", "fg-tool-body")),
			],
		},
		{
			name: "bash",
			target: "pnpm lint --max-warnings 0",
			state: "failed",
			status: "✗ exit 1",
			body: [
				cat(S("> ", "fg-tool-muted"), S("pnpm lint --max-warnings 0", "fg-tool-body")),
				S("✗ 1 error, 0 warnings - oxlint exited 1", "fg-approve"),
				S("src/auth/session.ts:52:9  no-unused-vars  'legacyUser' is never read", "fg-tool-body"),
				S("src/auth/session.ts:52:9  run `pnpm lint --fix` to autofix 0 of 1", "fg-tool-body"),
			],
		},
		{
			name: "subagent",
			target: "audit-render · research · gpt-5.5",
			state: "running",
			status: "▶ 04:12",
			body: [
				S("read docs/ui/bible/renders/theme-ultraviolet-core-active.png", "fg-tool-body"),
				S("compared 14 parity renders against the bible targets", "fg-tool-body"),
				fold("18.4k tokens · $0.06 · 04:12 elapsed"),
			],
		},
		{
			name: "subagent",
			target: "bible-tooling · research · gpt-5.5",
			state: "settled",
			status: "✓ 9 findings",
			body: [
				S("reported 9 findings on the render pipeline", "fg-tool-body"),
				fold("31.2k tokens · $0.11 · 06:41 elapsed"),
			],
		},
		{
			name: "mcp",
			target: "github · create_pull_request",
			state: "settled",
			status: "✓ #1482",
			body: [
				cat(S("number ", "fg-tool-muted"), S("1482", "fg-learn"), S("  state ", "fg-tool-muted"), S("open", "fg-learn")),
				fold("↓ 22 more result lines"),
			],
		},
		{
			name: "terminal",
			target: "pnpm dev",
			state: "running",
			status: "▶ 12:04",
			body: [
				cat(S("> ", "fg-tool-muted"), S("pnpm dev --host", "fg-tool-body")),
				S("ready on http://localhost:8797", "fg-tool-body"),
			],
		},
	];
	return [
		...frameMessage({
			role: "SUMO",
			right: S("11:47", "fg-dim"),
			body: [S("Working through the auth refactor.", "fg-fg"), BLANK, ...ledgerStack(entries, LW)],
		}),
	];
}

// ── scene 03: streaming ───────────────────────────────────────────────────
// phase: "reasoning" (thinking on, reasoning streaming, no answer yet)
//        "answer"    (reasoning done, stays visible, answer streaming)
//        "settled"   (turn done, thinking folded to its header row)
//        "off"       (thinking disabled: placeholder row until first token)
const REASONING_LINES = [
	"The user wants the tests run and failures fixed, not just reported. Run the",
	"suite first so I know the real failure set before touching anything.",
	"refresh() still returns the raw user; the new Result<User> boundary from the",
	"last edit will make the expired-token test fail. Expect that one.",
];
const thinkingHeader = (tokens, secs, folded = false) =>
	cat(S(`· thinking ${tokens} · ${secs}`, "fg-dim"), folded ? S("  ^O", "fg-divider") : S(""));
const reasoningRows = (lines) => lines.map((l) => S(`  ${l}`, "fg-dim"));

function streamingBody(phase) {
	const answer = cat(
		S("Running the suite now. The refresh path is the one I expect to fail, because ", "fg-fg"),
		S("getSession", "fg-learn"),
	);
	const bashRunning = ledgerStack(
		[
			{
				name: "bash",
				target: "pnpm test src/auth",
				state: "running",
				status: "▶ 00:12",
				body: [
					cat(S("> ", "fg-tool-muted"), S("pnpm test src/auth --reporter=verbose", "fg-tool-body")),
					fold("↑ 230 earlier lines"),
					cat(S("✓ ", "fg-idle"), S("src/auth/session.test.ts > revoke > idempotent", "fg-tool-body")),
					cat(S("✓ ", "fg-idle"), S("src/auth/session.test.ts > revoke > clears the cookie", "fg-tool-body")),
				],
			},
		],
		LW,
	);
	const bashDone = ledgerStack(
		[
			{
				name: "bash",
				target: "pnpm test src/auth",
				state: "failed",
				status: "✗ exit 1",
				body: [
					cat(S("> ", "fg-tool-muted"), S("pnpm test src/auth --reporter=verbose", "fg-tool-body")),
					fold("↑ 236 earlier lines"),
					cat(S("✗ ", "fg-approve"), S("src/auth/session.test.ts > refresh > rejects expired", "fg-tool-body")),
					S("  AssertionError: expected Result to be User", "fg-tool-body"),
					cat(S("✗ 1 failed, 21 passed - 1.4s", "fg-approve")),
				],
			},
		],
		LW,
	);
	switch (phase) {
		case "reasoning":
			return {
				right: cat(S("@", "fg-accent"), S(" 00:03", "fg-dim")),
				body: [thinkingHeader("0.8k tokens", "00:03"), ...reasoningRows(REASONING_LINES.slice(0, 3)), cat(S(`  ${REASONING_LINES[3].slice(0, 41)}`, "fg-dim"), S("▌", "fg-accent"))],
			};
		case "answer":
			return {
				right: cat(S("@", "fg-accent"), S(" 00:09", "fg-dim")),
				body: [thinkingHeader("1.2k tokens", "4s"), ...reasoningRows(REASONING_LINES), BLANK, cat(answer, S("▌", "fg-accent")), BLANK, ...bashRunning],
			};
		case "settled":
			return {
				right: S("11:43", "fg-dim"),
				body: [thinkingHeader("1.2k tokens", "4s", true), BLANK, cat(answer, S(" returns the raw user.", "fg-fg")), BLANK, ...bashDone, BLANK, S("One failure, as expected. Fixing refresh() to unwrap the Result.", "fg-fg")],
			};
		case "off":
			return {
				right: cat(S("@", "fg-accent"), S(" 00:02", "fg-dim")),
				body: [cat(S("@", "fg-accent"), S(" Sumo is thinking…", "fg-dim"))],
			};
	}
}

function streamingChat(phase = "answer") {
	const rows = [];
	rows.push(...frameMessage({ role: "USER", body: [S("review src/auth/session.ts and tighten the return type", "fg-fg")] }));
	rows.push(
		...frameMessage({
			role: "SUMO",
			right: S("11:42", "fg-dim"),
			body: [S("Reading the current shape.", "fg-fg"), BLANK, ...ledgerStack([READ_ENTRY(LW)], LW)],
		}),
	);
	rows.push("");
	rows.push(...frameMessage({ role: "USER", body: [S("now run the auth tests and fix whatever breaks", "fg-fg")] }));
	rows.push(
		...frameMessage({
			role: "SUMO",
			...streamingBody(phase),
		}),
	);
	return rows;
}

const workingRow = (label = "Working…") => ` <span class="fg-accent">@</span>  <span class="fg-dim">${label}</span>`;

// ── scene 02b: failure ink ─────────────────────────────────────────────────
function failureInkChat() {
	const failed = (borderCls) => ({
		name: "bash",
		target: "pnpm lint --max-warnings 0",
		state: "failed",
		status: "✗ exit 1",
		borderCls,
		body: [
			cat(S("> ", "fg-tool-muted"), S("pnpm lint --max-warnings 0", "fg-tool-body")),
			fold("↑ 41 earlier lines"),
			cat(S("✗ ", "fg-approve"), S("src/auth/session.ts:52:9  no-unused-vars  'legacyUser' is never read", "fg-tool-body")),
			S("  run `pnpm lint --fix` to autofix 0 of 1", "fg-tool-muted"),
			cat(S("✗ 1 error, 0 warnings - oxlint exited 1", "fg-approve")),
		],
	});
	const ok = {
		name: "bash", target: "pnpm typecheck", state: "settled", status: "✓ 0 errors",
		body: [cat(S("> ", "fg-tool-muted"), S("pnpm typecheck", "fg-tool-body")), S("tsc --noEmit  0 errors", "fg-tool-body")],
	};
	return [
		...frameMessage({ role: "USER", body: [S("lint and typecheck", "fg-fg")] }),
		...frameMessage({
			role: "SUMO", right: S("11:51", "fg-dim"),
			body: [
				S("A — border stays violet; state lives in glyph + ink only.", "fg-dim"), BLANK,
				...ledgerStack([ok, failed("fg-tool-border")], LW),
				BLANK, S("Lint failed on one unused import; fixing.", "fg-fg"),
			],
		}),
		"",
		...frameMessage({
			role: "SUMO", right: S("11:52", "fg-dim"),
			body: [
				S("B — failed card's own border turns approval pink.", "fg-dim"), BLANK,
				...ledgerStack([ok, failed("fg-approve")], LW),
				BLANK, S("Lint failed on one unused import; fixing.", "fg-fg"),
			],
		}),
	];
}

// ── scene 02c: subagent ledger bodies ───────────────────────────────────────
function subagentLedgerChat() {
	const headless = {
		name: "subagent", target: "audit-render · research · deepseek-flash", state: "running", status: "▶ 04:12",
		body: [
			S("read docs/ui/bible/renders/theme-ultraviolet-core-active.png", "fg-tool-body"),
			S("compared 14 parity renders against the bible targets", "fg-tool-body"),
			cat(S("▶ ", "fg-tool"), S("read parity/summary.md", "fg-tool-body")),
			S("18.4k tokens · $0.06 · 04:12", "fg-tool-muted"),
		],
	};
	const paneA = {
		name: "subagent", target: "yoga3-migration · implement-smart · gpt-5.6", state: "running", status: "▶ 18:40",
		body: [cat(S("⧉ w32:p5", "fg-tool-body"), S(" · running in a visible pane · 18:40", "fg-tool-muted"))],
	};
	const paneB = {
		name: "subagent", target: "yoga3-migration · implement-smart · gpt-5.6", state: "running", status: "▶ 18:40",
		body: [
			S("no event stream (pane) — watch w32:p5", "fg-tool-muted"),
			S("— tokens · — cost · 18:40", "fg-tool-muted"),
		],
	};
	const settled = {
		name: "subagent", target: "shiki-highlighting · implement-smart · gpt-5.6", state: "settled", status: "✓ 31:07",
		body: [
			cat(S("sumo/shiki-highlighting", "fg-tool-body"), S(" · +5 commits · 8 files · clean", "fg-tool-muted")),
			S("Switched to the Oniguruma engine: cold path Node 178→102 ms, Bun 1024→109 ms.", "fg-tool-body"),
			S("412k tokens · $1.84 · 31:07", "fg-tool-muted"),
		],
	};
	const stalled = {
		name: "subagent", target: "audit-ux · research · deepseek-flash", state: "failed", status: "◆ stalled 9:58",
		body: [
			S("no progress for 6m · last: reading rpc/host-actions.ts", "fg-approve"),
			S("41.0k tokens · $0.12 · 09:58", "fg-tool-muted"),
		],
	};
	return [
		...frameMessage({ role: "USER", body: [S("migrate yoga and add shiki, in parallel", "fg-fg")] }),
		...frameMessage({
			role: "SUMO", right: cat(S("@", "fg-accent"), S(" 31:07", "fg-dim")),
			body: [
				S("Option (a) for the pane child — one honest row.", "fg-dim"), BLANK,
				...ledgerStack([headless, paneA, settled, stalled], LW),
			],
		}),
		"",
		...frameMessage({
			role: "SUMO", right: cat(S("@", "fg-accent"), S(" 31:07", "fg-dim")),
			body: [
				S("Option (b) for the pane child — headless shape with an explanation.", "fg-dim"), BLANK,
				...ledgerStack([paneB], LW),
			],
		}),
	];
}

// ── scene 10: splash ────────────────────────────────────────────────────────
const CAT_LINES = ansToHTMLLines(resolve(repoRoot, "src/assets/sumo-face.ans"));
const WORDMARK = {
	S: ["█████ ", "█     ", "█████ ", "    █ ", "█████ "], U: ["█   █ ", "█   █ ", "█   █ ", "█   █ ", "█████ "],
	M: ["█   █ ", "██ ██ ", "█ █ █ ", "█   █ ", "█   █ "], O: ["█████ ", "█   █ ", "█   █ ", "█   █ ", "█████ "],
	C: ["█████ ", "█     ", "█     ", "█     ", "█████ "], D: ["████  ", "█   █ ", "█   █ ", "█   █ ", "████  "],
	E: ["█████ ", "█     ", "████  ", "█     ", "█████ "],
};
const WORDMARK_ROWS = Array.from({ length: 5 }, (_, i) => "SUMOCODE".split("").map((ch) => WORDMARK[ch][i]).join(""));
const centerHtml = (html, cols) => { const need = cols - visibleLen(html); const l = Math.max(0, Math.floor(need / 2)); return rep(" ", l) + html + rep(" ", Math.max(0, need - l)); };

/** variant: "today" | "proposed" | "recents" */
function splashRows(variant, cols, total) {
	const blank = rep(" ", cols);
	const rows = [];
	const cat = CAT_LINES.map((l) => { const lp = Math.floor((cols - 24) / 2); return rep(" ", lp) + l + rep(" ", cols - 24 - lp); });
	const wm = WORDMARK_ROWS.map((l) => centerHtml(`<span class="fg-accent">${l}</span>`, cols));
	const quote = [centerHtml(`<span class="fg-dim">"Meow meow meow... meow meow"</span>`, cols), centerHtml(`<span class="fg-dim">— SUMO</span>`, cols)];
	const inner = 60;
	const round = variant !== "today";
	const [tl, tr, bl, br] = round ? ["╭", "╮", "╰", "╯"] : ["┌", "┐", "└", "┘"];
	const label = "DIVINE INVOCATION";
	const ph = `Ask anything... "Refactor the auth flow."`;
	const frame = [
		`<span class="fg-divider">${tl}─ </span><span class="fg-accent">${label}</span> <span class="fg-divider">${rep("─", inner - 5 - label.length)}${tr}</span>`,
		`<span class="fg-divider">│</span> <span class="fg-accent">${round ? "❯" : "&gt;"}</span> <span class="fg-dim">${esc(ph)}</span><span class="cursor"> </span>${rep(" ", inner - 6 - ph.length)}<span class="fg-divider">│</span>`,
		`<span class="fg-divider">${bl}${rep("─", inner - 2)}${br}</span>`,
	].map((h) => centerHtml(h, cols));
	const lp = Math.floor((cols - inner) / 2);
	let hint;
	if (variant === "today") {
		const left = `<span class="fg-dim">╰─ </span><span class="fg-accent">gpt-5.5</span><span class="fg-dim"> · medium</span>`;
		const rt = `<span class="fg-accent">CTRL+/</span><span class="fg-dim"> · COMMANDS</span>`;
		hint = rep(" ", lp) + left + rep(" ", inner - visibleLen(left) - visibleLen(rt)) + rt;
	} else {
		const pairs = [["↵", "send"], ["⇧⇥", "thinking"], ["^P", "model"], ["^R", "resume"], ["^/", "commands"]];
		const h = pairs.map(([k, l]) => `<span class="fg-accent">${k}</span> <span class="fg-dim">${l}</span>`).join(`<span class="fg-divider"> · </span>`);
		hint = centerHtml(h, cols);
	}
	const recents = variant === "recents" ? [
		[`<span class="fg-divider">·</span> <span class="fg-fg">auth-refactor</span>`, `<span class="fg-dim">main</span>`, `<span class="fg-dim">2h ago</span>`],
		[`<span class="fg-divider">·</span> <span class="fg-dim">ledger-audit</span>`, `<span class="fg-dim">ui/bible</span>`, `<span class="fg-dim">4h ago</span>`],
		[`<span class="fg-divider">·</span> <span class="fg-dim">tree-triage</span>`, `<span class="fg-dim">main</span>`, `<span class="fg-dim">6h ago</span>`],
	].map(([a, b, c]) => rep(" ", lp) + a + rep(" ", 24 - visibleLen(a)) + b + rep(" ", inner - 24 - visibleLen(b) - visibleLen(c)) + c) : [];
	const version = variant === "today"
		? centerHtml(`<span class="fg-dim">SUMOCODE V0.7.1 · CATHEDRAL · 160 × 45 MONOSPACE</span>`, cols)
		: centerHtml(`<span class="fg-dim">SUMOCODE v0.9.2 · ULTRAVIOLET CORE · ${cols} × ${ROWS}</span>`, cols);
	const content = cat.length + 2 + 5 + 2 + 2 + 2 + 3 + 1 + 1 + (recents.length ? recents.length + 1 : 0);
	const top = Math.max(1, Math.floor((total - content - 2) / 2));
	for (let i = 0; i < top; i++) rows.push(blank);
	rows.push(...cat, blank, blank, ...wm, blank, blank, ...quote, blank, blank, ...frame, blank, hint);
	if (recents.length) rows.push(blank, ...recents);
	while (rows.length < total - 1) rows.push(blank);
	rows.length = total - 1;
	rows.push(version);
	return rows;
}

function splashScene(variant, title) {
	const middleRows = ROWS - 3; // top blank + top bar + blank; splash owns the rest incl. footer rows
	const body = splashRows(variant, COLS, middleRows).map((r) => gridLine(r)).join("\n    ");
	const topBarHtml = variant === "today" ? topBarLegacy() : topBar(COLS, { active: "new session", recents: [] });
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="_assets/tokens.css">
<style>
  :root { --background: ${UV.background}; --surface: ${UV.surface}; --surface-recess: ${UV.surfaceRecess}; --surface-lifted: ${UV.surfaceLifted}; --divider: ${UV.divider}; --foreground: ${UV.foreground}; --foreground-dim: ${UV.foregroundDim}; --accent: ${UV.accent}; --state-idle: ${UV.stateIdle}; --state-thinking: ${UV.stateThinking}; --state-tool: ${UV.stateTool}; --state-approval: ${UV.stateApproval}; --state-learning: ${UV.stateLearning}; }
  body.runtime-target { background: var(--background); }
  body.runtime-target .stage { min-height: 0; align-items: flex-start; justify-content: flex-start; padding: 0; gap: 0; }
</style>
</head>
<body class="runtime-target">
<div class="stage">
  <div data-render-rect class="term" style="--term-cols: ${COLS}; --term-rows: ${ROWS};">
    ${gridLine(" ")}
    ${gridLine(topBarHtml)}
    ${gridLine(" ")}
    ${body}
  </div>
</div>
</body>
</html>
`;
}

// ── docked panels ─────────────────────────────────────────────────────────
function divineQueryPanel() {
	const opt = (focused, letter, text) =>
		panelRow(cat(mark(focused), S(" "), S(`${letter}) ${text}`, focused ? "fg-fg" : "fg-dim")));
	return [
		panelTop("DIVINE QUERY"),
		panelRow(
			cat(
				S("Should I rename ", "fg-fg"),
				S("`getUser`", "fg-learn"),
				S(" to ", "fg-fg"),
				S("`fetchUser`", "fg-learn"),
				S(" across the auth module?", "fg-fg"),
			),
		),
		panelRow(BLANK),
		opt(true, "A", "Yes, rename it everywhere"),
		opt(false, "B", "No, leave it as-is"),
		opt(false, "C", "Use a different name"),
		panelRow(splitRule()),
		panelRow(hintRow([["↑↓", "wander"], ["⏎", "answer"], ["⎋", "retreat"]])),
		panelBottom(),
	];
}

function approvalPanel() {
	const inner = PANEL_COLS - 4;
	const boxW = 60;
	const recess = (html, len) =>
		panelRow({ html: fill(html, boxW, "--surface-recess"), len: boxW });
	const opt = (focused, text, danger = false) => {
		const cls = danger ? "fg-approve" : "fg-accent";
		return panelRow(cat(mark(focused, cls), S(" "), S(text, focused ? (danger ? "fg-approve" : "fg-fg") : "fg-dim")));
	};
	return [
		panelTop("APPROVAL · bash"),
		panelRow(cat(S("SUMO wants to run a shell command in ", "fg-fg"), S("sumocode", "fg-learn"), S(" (main):", "fg-fg"))),
		panelRow(BLANK),
		recess(`<span class="fg-divider">┌${rep("─", boxW - 2)}┐</span>`, boxW),
		recess(
			`<span class="fg-divider">│</span> <span class="fg-fg">rm -rf node_modules &amp;&amp; pnpm install</span>${rep(" ", boxW - 4 - 35)} <span class="fg-divider">│</span>`,
			boxW,
		),
		recess(`<span class="fg-divider">└${rep("─", boxW - 2)}┘</span>`, boxW),
		panelRow(BLANK),
		opt(false, "allow once"),
		opt(false, "allow for session"),
		opt(true, "deny", true),
		panelRow(splitRule()),
		panelRow(hintRow([["↑↓", "wander"], ["⏎", "choose"], ["⎋", "deny"]])),
		panelBottom(),
	];
}

function resumePanel() {
	const header = (text) => panelRow(S(text, "fg-dim"));
	// `turns` rides with `age` in one right-aligned block: right-aligning it
	// alone against a 160-col panel opens a dead 60-col void mid-row.
	const session = (focused, name, branch, turns, age) => {
		const left = cat(mark(focused), S(" "), S(name.padEnd(22), focused ? "fg-fg" : "fg-dim"), S(branch, "fg-dim"));
		const right = cat(S(turns.padStart(9), "fg-dim"), S("   "), S(age.padStart(7), focused ? "fg-fg" : "fg-dim"));
		const gap = PANEL_COLS - 4 - left.len - right.len;
		return panelRow(cat(left, S(rep(" ", Math.max(1, gap))), right));
	};
	return [
		panelTop("RESUME", "12 sessions"),
		panelRow(cat(S("❯", "fg-accent"), S(" "), S("type to search…", "fg-dim"))),
		panelRow(BLANK),
		header("TODAY"),
		session(true, "auth-refactor", "main", "14 turns", "2h ago"),
		session(false, "ledger-audit", "ui/bible", "8 turns", "4h ago"),
		session(false, "tree-triage", "main", "3 turns", "6h ago"),
		header("YESTERDAY"),
		session(false, "runcat-font", "ui/runcat", "21 turns", "1d ago"),
		session(false, "portrait-parity", "ui/portrait", "9 turns", "1d ago"),
		session(false, "mcp-roster", "main", "5 turns", "1d ago"),
		header("OLDER"),
		session(false, "theme-ultraviolet", "ui/themes", "37 turns", "6d ago"),
		session(false, "scriptorium-chrome", "ui/cathedral", "12 turns", "2w ago"),
		panelRow(splitRule()),
		panelRow(hintRow([["↑↓", "choose"], ["⏎", "select"], ["⇥", "scope"], ["⎋", "cancel"]])),
		panelBottom(),
	];
}

function treePanel() {
	const node = ({ focused = false, current = false, connector = "", glyph, text, age = "" }) => {
		const left = cat(
			mark(focused),
			S(" "),
			current ? S("●", "fg-accent") : S(" "),
			S(" "),
			S(connector, "fg-divider"),
			S(glyph, glyph === "▷" ? "fg-fg" : "fg-dim"),
			S(" "),
			S(text, focused ? "fg-fg" : glyph === "▷" ? "fg-fg" : "fg-dim"),
		);
		const gap = PANEL_COLS - 4 - left.len - age.length;
		return panelRow(cat(left, S(rep(" ", Math.max(1, gap))), S(age, focused ? "fg-fg" : "fg-dim")));
	};
	return [
		panelTop("SESSION TREE"),
		panelRow(cat(S("❯", "fg-accent"), S(" "), S("type to search…", "fg-dim"))),
		panelRow(BLANK),
		node({ glyph: "▷", text: "run the smoke tests on this branch", age: "5h ago" }),
		node({ glyph: "✦", text: "Running the suite now - 1541 tests green." }),
		node({ glyph: "▷", text: "fix the queued messages UI", age: "4h ago" }),
		node({ connector: "├ ", glyph: "✦", text: "Rendered as lifted banner rows above the editor." }),
		node({ connector: "└ ", glyph: "✦", text: "Rendered as a bordered QUEUED chat card instead.", age: "3h ago" }),
		node({ connector: "  ", glyph: "▷", text: "[refactor] now fix image paste collapse" }),
		node({ connector: "  ├ ", glyph: "✦", text: "Shadowed handlePaste to collapse bracketed paste.", age: "2h ago" }),
		node({
			focused: true,
			current: true,
			connector: "  └ ",
			glyph: "✦",
			text: "Alternative: normalize in insertTextAtCursor only.",
			age: "1h ago",
		}),
		panelRow(splitRule()),
		panelRow(hintRow([["↑↓", "choose"], ["⏎", "select"], ["⇥", "scope"], ["⎋", "cancel"]])),
		panelBottom(),
	];
}

// ── scene 07: portrait ────────────────────────────────────────────────────
const PLW = P_COLS - 4; // 56

function portraitChat() {
	const rows = [];
	rows.push(
		...frameMessage({
			role: "USER",
			cols: P_COLS,
			body: [S("hello, refactor the auth flow to use", "fg-fg"), S("the new session pattern.", "fg-fg")],
		}),
	);
	rows.push(
		...frameMessage({
			role: "SUMO",
			cols: P_COLS,
			right: S("11:42", "fg-dim"),
			body: [
				S("Reading the auth flow.", "fg-fg"),
				BLANK,
				...ledgerStack(
					[
						{
							name: "read",
							target: "src/auth/session.ts",
							state: "settled",
							status: "✓ 340",
							body: [
								gutterLine(1, 'import { z } from "zod";'),
								gutterLine(2, 'import type { User } from'),
								gutterLine(3, '  "./user.js";'),
								fold("↓ 337 more lines"),
							],
						},
						{
							name: "edit",
							target: "src/auth/session.ts",
							state: "settled",
							status: "✓ +14 −6",
							body: [
								diff("@@ 41,7 @@ getSession"),
								diff("-   return user;"),
								diff("+   return Result.ok(user);"),
								fold("↓ 2 more hunks"),
							],
						},
					],
					PLW,
				),
				BLANK,
				S("Done. Updated 14 lines, deleted 6", "fg-fg"),
				S("stale helpers.", "fg-fg"),
			],
		}),
	);
	rows.push("");
	rows.push(...frameMessage({ role: "USER", cols: P_COLS, body: [S("run tests", "fg-fg")] }));
	rows.push(
		...frameMessage({
			role: "SUMO",
			cols: P_COLS,
			right: cat(S("@", "fg-accent"), S(" 00:04", "fg-dim")),
			body: [
				S("· thinking 1.2k tokens", "fg-dim"),
				BLANK,
				cat(S("Running the suite now.", "fg-fg"), S("▌", "fg-accent")),
				BLANK,
				...ledgerStack(
					[
						{
							name: "bash",
							target: "pnpm test src/auth",
							state: "running",
							status: "▶ 00:12",
							body: [
								cat(S("> ", "fg-tool-muted"), S("pnpm test src/auth", "fg-tool-body")),
								cat(S("  ", "fg-tool-muted"), S("--reporter=verbose", "fg-tool-body")),
								fold("↑ 230 earlier lines"),
								cat(S("✓ ", "fg-idle"), S("revoke > idempotent", "fg-tool-body")),
								cat(S("✓ ", "fg-idle"), S("revoke > clears cookie", "fg-tool-body")),
							],
						},
					],
					PLW,
				),
			],
		}),
	);
	return rows;
}

function portraitFooter({ agents = null } = {}) {
	// Q15 (b): agent count in the footer left zone; approval pink when any child is stalled.
	const agentTag = agents
		? `<span class="fg-dim"> · </span><span class="${agents.stalled ? "fg-approve" : "fg-fg"}">${agents.stalled ? "◆" : "●"} ${agents.count} agents</span>`
		: "";
	const left = `<span class="fg-think">◐</span> <span class="fg-fg">THINKING</span><span class="fg-dim"> · </span><span class="fg-fg">gpt-5.5</span>${agentTag}`;
	const right = `<span class="fg-fg">42k</span><span class="fg-dim">/200k · </span><span class="fg-fg">$0.42</span>`;
	const hints = `<span class="fg-accent">⌃O</span> <span class="fg-dim">ledgers</span><span class="fg-divider"> · </span><span class="fg-accent">⌃/</span> <span class="fg-dim">commands</span>`;
	const branch = `<span class="fg-dim">sumocode (main)</span>`;
	return [
		` ${branch}${rep(" ", P_COLS - visibleLen(branch) - visibleLen(hints) - 2)}${hints} `,
		` ${left}${rep(" ", P_COLS - visibleLen(left) - visibleLen(right) - 2)}${right} `,
	];
}

// ── scene 08: empty ───────────────────────────────────────────────────────
function emptyChat(middleRows = 36) {
	const center = (html, len) => `${rep(" ", Math.max(0, Math.floor((CHAT_COLS - len) / 2)))}${html}`;
	const quote = "\"A cathedral is not drawn. It is set, stone by stone, until the light has somewhere to fall.\"";
	const legend = [
		["⌃/", "commands"],
		["⌃O", "expand ledgers"],
		["⇧⇥", "thinking level"],
		["⌃P", "model"],
	];
	const legendWidth = 4 + 16;
	const rows = [];
	const top = Math.max(1, Math.floor((middleRows - 8) / 2));
	for (let i = 0; i < top; i++) rows.push("");
	rows.push(center(`<span class="fg-dim">${esc(quote)}</span>`, quote.length));
	rows.push("");
	rows.push("");
	for (const [k, l] of legend) {
		const html = `<span class="fg-accent">${k}</span>  <span class="fg-dim">${l}</span>`;
		rows.push(center(html, legendWidth));
	}
	return rows;
}

// ── scenes ────────────────────────────────────────────────────────────────
const MIDDLE_BASE = ROWS - 5 - 3 - 1; // 36

const scenes = [];
const add = (file, html) => scenes.push([file, html]);

add(
	"00-baseline.html",
	landscape({
		title: "Proto 00 · Baseline (today)",
		topBarHtml: topBarLegacy(),
		chatRows: baselineChat(),
		sidebarRows: sidebarLegacy(),
		bandRows: inputFrame({ corners: "square" }),
		footerRows: [footerLegacy()],
	}),
);

add(
	"01-rhythm.html",
	landscape({
		title: "Proto 01 · Rhythm",
		topBarHtml: topBar(),
		chatRows: rhythmChat(),
		sidebarRows: sidebarFor(MIDDLE_BASE),
		bandRows: inputFrame(),
		footerRows: [footerRow("ready")],
	}),
);

add(
	"01b-rhythm-compact-user.html",
	landscape({
		title: "Proto 01b · Rhythm · compact USER rows",
		topBarHtml: topBar(),
		chatRows: rhythmChat({ compactUsers: true }),
		sidebarRows: sidebarFor(MIDDLE_BASE),
		bandRows: inputFrame(),
		footerRows: [footerRow("ready")],
	}),
);

add(
	"02-ledger-states.html",
	landscape({
		title: "Proto 02 · Ledger states",
		topBarHtml: topBar(),
		chatRows: ledgerStatesChat(),
		sidebarRows: sidebarFor(MIDDLE_BASE),
		bandRows: inputFrame(),
		footerRows: [footerRow("tool")],
	}),
);

add(
	"02b-failure-ink.html",
	landscape({
		title: "Proto 02b · Failure ink A vs B",
		topBarHtml: topBar(),
		chatRows: failureInkChat(),
		sidebarRows: sidebarHybrid(),
		bandRows: inputFrame(),
		footerRows: [footerRow("ready")],
	}),
);

add(
	"02c-subagent-ledgers.html",
	landscape({
		title: "Proto 02c · Subagent ledger bodies",
		topBarHtml: topBar(),
		chatRows: subagentLedgerChat(),
		sidebarRows: sidebarHybrid(),
		bandRows: inputFrame(),
		footerRows: [footerRow("tool")],
	}),
);

add("10-splash-today.html", splashScene("today", "Proto 10 · Splash · today"));
add("10b-splash-proposed.html", splashScene("proposed", "Proto 10b · Splash · items 1+2+4"));
add("10c-splash-recents.html", splashScene("recents", "Proto 10c · Splash · + item 3 recents"));

for (const [file, title, phase, footer] of [
	["03-thinking-reasoning.html", "Proto 03 · Thinking on — reasoning streaming", "reasoning", "thinking"],
	["03b-thinking-answer.html", "Proto 03b · Thinking on — answer streaming, reasoning stays", "answer", "thinking"],
	["03c-thinking-settled.html", "Proto 03c · Turn settled — thinking folded to its header", "settled", "ready"],
	["03d-thinking-off.html", "Proto 03d · Thinking off — placeholder until first token", "off", "thinking"],
]) {
	const chat = streamingChat(phase);
	const streaming = phase !== "settled";
	const target = streaming ? MIDDLE_BASE - 1 : MIDDLE_BASE;
	while (chat.length < target) chat.push("");
	chat.length = target;
	if (streaming) chat.push(workingRow());
	add(
		file,
		landscape({
			title,
			topBarHtml: topBar(),
			chatRows: chat,
			sidebarRows: sidebarFor(MIDDLE_BASE),
			bandRows: inputFrame(),
			footerRows: [footerRow(footer)],
		}),
	);
}

const DOCKED = [
	["04-divine-query-docked", "Proto 04 · Divine Query docked", divineQueryPanel, "awaiting"],
	["04b-approval-docked", "Proto 04b · Approval docked", approvalPanel, "awaiting"],
	["05-resume-docked", "Proto 05 · /resume docked", resumePanel, "ready"],
	["06-tree-docked", "Proto 06 · /tree docked", treePanel, "ready"],
];

// Q11 (b): panel at chat width; the sidebar continues down beside it.
PANEL_COLS = CHAT_COLS;
for (const [id, title, build, footer] of DOCKED) {
	const panel = build();
	const middle = ROWS - 5 - panel.length - 1;
	const side = sidebarHybrid();
	while (side.length < middle + 1 + panel.length) side.push(sbBlank());
	const gapRow = `${rep(" ", CHAT_COLS + GUTTER)}${side[middle]}`;
	const band = panel.map((row, i) => `${row}${rep(" ", GUTTER)}${side[middle + 1 + i]}`);
	add(
		`${id}-chat-width.html`,
		landscape({
			title: `${title} · chat width`,
			topBarHtml: topBar(),
			chatRows: tail(rhythmChat(), middle),
			sidebarRows: side.slice(0, middle),
			bandRows: band,
			footerRows: [footerRow(footer)],
			gapRow,
		}),
	);
}
PANEL_COLS = COLS;

for (const [file, title, band, footer] of DOCKED.map(([id, t, b, f]) => [`${id}.html`, t, b(), f])) {
	const middle = ROWS - 5 - band.length - 1;
	add(
		file,
		landscape({
			title,
			topBarHtml: topBar(),
			chatRows: tail(rhythmChat(), middle),
			sidebarRows: sidebarFor(middle),
			bandRows: band,
			footerRows: [footerRow(footer)],
		}),
	);
}

{
	const chat = portraitChat();
	const middle = P_ROWS - 5 - 3 - 2;
	while (chat.length < middle - 1) chat.push("");
	chat.length = middle - 1;
	chat.push(workingRow());
	add(
		"07-portrait.html",
		buildScene({
			title: "Proto 07 · Portrait 60×100",
			cols: P_COLS,
			rows: P_ROWS,
			chatCols: P_COLS,
			sidebarCols: 0,
			topBarHtml: topBar(P_COLS, { active: "auth-refactor", recents: [] }),
			chatRows: chat,
			bandRows: inputFrame({ cols: P_COLS }),
			footerRows: portraitFooter(),
		}),
	);
	for (const [suffix, agents] of [["-agents", { count: 3, stalled: false }], ["-agents-stalled", { count: 3, stalled: true }]]) {
		add(
			`07-portrait${suffix}.html`,
			buildScene({
				title: `Proto 07 · Portrait · footer agents${suffix}`,
				cols: P_COLS,
				rows: P_ROWS,
				chatCols: P_COLS,
				sidebarCols: 0,
				topBarHtml: topBar(P_COLS, { active: "auth-refactor", recents: [] }),
				chatRows: chat,
				bandRows: inputFrame({ cols: P_COLS }),
				footerRows: portraitFooter({ agents }),
			}),
		);
	}
}

for (const [file, title, side] of [
	["09a-sidebar-editorial.html", "Proto 09a · Sidebar · Editorial", sidebarEditorial()],
	["09b-sidebar-ledger.html", "Proto 09b · Sidebar · Ledger", sidebarLedger()],
	["09c-sidebar-quiet.html", "Proto 09c · Sidebar · Quiet", sidebarQuiet()],
	["09d-sidebar-monitor.html", "Proto 09d · Sidebar · Monitor", sidebarMonitor()],
	["09e-sidebar-hybrid.html", "Proto 09e · Sidebar · Hybrid", sidebarHybrid()],
]) {
	add(
		file,
		landscape({
			title,
			topBarHtml: topBar(),
			chatRows: rhythmChat(),
			sidebarRows: side,
			bandRows: inputFrame(),
			footerRows: [footerRow("ready")],
		}),
	);
}

// ── gallery ───────────────────────────────────────────────────────────────
const GALLERY = [
	["00-baseline", "Before — today's ultraviolet runtime, reproduced faithfully."],
	["01-rhythm", "After — new chrome, the 0/1/2 spacing scale, one closed ledger stack per turn."],
	["01b-rhythm-compact-user", "01 with unframed compact USER rows: four rows back per turn."],
	["02-ledger-states", "Every ledger body policy and status glyph in one stack."],
	["02b-failure-ink", "Failure ink: A — violet border, pink glyph/ink only (recommended). B — the failed card's border goes pink too."],
	["02c-subagent-ledgers", "Subagent ledgers: headless running (activity lines), pane running (a: one row / b: explained), settled (manifest + first line), stalled (◆ pink)."],
	["03-thinking-reasoning", "Thinking on (default): reasoning streams visibly in dim under its header; @ elapsed in the frame header."],
	["03b-thinking-answer", "Reasoning finished and stays visible while the answer streams and a tool runs."],
	["03c-thinking-settled", "Turn settled: reasoning folds to `· thinking 1.2k tokens · 4s  ^O`; ^O unfolds it like a ledger."],
	["03d-thinking-off", "Thinking disabled: a single `@ Sumo is thinking…` row until the first token lands."],
	["04-divine-query-docked", "Divine Query docked in the input band — transcript stays visible."],
	["04b-approval-docked", "Approval docked, command in a recess box, deny focused in approval pink."],
	["05-resume-docked", "/resume docked: search, TODAY / YESTERDAY / OLDER, 8 sessions."],
	["04-divine-query-docked-chat-width", "Q11 (b): Divine Query at chat width (128) — panel aligns with the frames above; sidebar stays visible beside it."],
	["04b-approval-docked-chat-width", "Q11 (b): approval at chat width."],
	["05-resume-docked-chat-width", "Q11 (b): /resume at chat width — metadata columns tighten."],
	["06-tree-docked-chat-width", "Q11 (b): /tree at chat width."],
	["06-tree-docked", "/tree docked: connectors in border colour, current node in accent."],
	["07-portrait", "60×100 portrait: no sidebar, ledger stack wraps, two-row footer."],
	["07-portrait-agents", "Q15 (b): portrait footer carries `● 3 agents` in the left zone."],
	["07-portrait-agents-stalled", "Q15 (b): same, one child stalled → `◆ 3 agents` in approval pink."],
	["10-splash-today", "Splash today: hardcoded version line, ┌┐ frame, model/keybind row under the frame."],
	["10b-splash-proposed", "Splash items 1+2+4: live version · theme · size line, ╭╮ frame with ❯, chord legend replaces the model row."],
	["10c-splash-recents", "Splash + item 3: three recent sessions under the frame (only when the project has history)."],
	["09a-sidebar-editorial", "Sidebar A · EDITORIAL — the Bible's locked masthead voice in ultraviolet: tracked-out labels, thick ━ rules, no sigils."],
	["09b-sidebar-ledger", "Sidebar B · LEDGER — every section a two-column ledger; agents carry a budget bar; counts on every heading."],
	["09c-sidebar-quiet", "Sidebar C · QUIET — no rules, no sigils, lowercase dim labels, double air. Sidebar recedes; transcript leads."],
	["09d-sidebar-monitor", "Sidebar D · MONITOR — agents and terminals get a second row with their last activity line. Built for watching."],
	["09e-sidebar-hybrid", "Sidebar E · HYBRID — B's counts + D's second row only for headless children (they stream events); pane children get one row with a ⧉ pane id; a stalled child flips to ◆ in approval pink."],
];

function galleryHtml() {
	const card = ([id, intent]) => `    <section class="card">
      <h2>${id}</h2>
      <p>${intent}</p>
      <a href="${id}.html"><img src="renders/${id}.png" alt="${id}"></a>
      <a class="src" href="${id}.html">open ${id}.html →</a>
    </section>`;
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>SumoCode TUI · Ultraviolet prototypes</title>
<link rel="stylesheet" href="_assets/tokens.css">
<style>
  :root { --background: ${UV.background}; --surface: ${UV.surface}; --foreground: ${UV.foreground}; --foreground-dim: ${UV.foregroundDim}; --divider: ${UV.divider}; --accent: ${UV.accent}; }
  html, body { background: ${UV.background}; color: ${UV.foreground}; }
  body { padding: 48px clamp(16px, 4vw, 72px) 96px; }
  h1 { font-size: 22px; letter-spacing: 0.18em; color: ${UV.accent}; margin: 0 0 6px; text-transform: uppercase; }
  .lede { color: ${UV.foregroundDim}; font-size: 13px; margin: 0 0 40px; max-width: 90ch; line-height: 1.7; }
  h2 { font-size: 13px; letter-spacing: 0.16em; text-transform: uppercase; color: ${UV.accent}; margin: 0 0 4px; }
  p { color: ${UV.foregroundDim}; font-size: 13px; margin: 0 0 12px; line-height: 1.6; }
  img { width: 100%; display: block; border: 1px solid ${UV.divider}; }
  a { color: ${UV.accent}; text-decoration: none; }
  a.src { display: inline-block; margin-top: 8px; font-size: 12px; color: ${UV.foregroundDim}; }
  a.src:hover { color: ${UV.accent}; }
  .card { margin: 0 0 56px; }
  .compare { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 0 0 64px; }
  .compare .card { margin: 0; }
  .rule { border: 0; border-top: 1px solid ${UV.divider}; margin: 0 0 40px; }
</style>
</head>
<body>
<h1>SumoCode TUI · Ultraviolet prototypes</h1>
<p class="lede">2026-09 TUI audit explorations. Theme: ultraviolet-core only. Cathedral canon stays — framed messages, Scriptorium panels, five preattentive states, restrained palette. These are not the Bible; winners get promoted.</p>
<div class="compare">
${card(GALLERY[0])}
${card(GALLERY[1])}
</div>
<hr class="rule">
${GALLERY.slice(2).map(card).join("\n")}
</body>
</html>
`;
}

for (const [file, html] of scenes) {
	writeFileSync(resolve(outDir, file), html);
	const cols = file.startsWith("07") ? P_COLS : COLS;
	const rows = file.startsWith("07") ? P_ROWS : ROWS;
	console.log(`wrote ${file} (${cols}×${rows})`);
}
writeFileSync(resolve(outDir, "index.html"), galleryHtml());
console.log("wrote index.html");
