#!/usr/bin/env node
// Element 6 — Approval modal.
// Per CATHEDRAL_UX_SPEC_V2.md §3.6:
//   - flat-hybrid card on surface-lifted bg
//   - APPROVAL REQUIRED title accent
//   - command in inner ┌─┐ frame on surface-recess bg
//   - explanation row dim, em-dash prefix
//   - ■ SYSTEM NOTICE in approval (terracotta) color
//   - [Y]ES [N]O [A]LWAYS buttons, [N]O focused by default for safety

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
const center = (s, n) => {
	const need = n - visibleLen(s);
	if (need <= 0) return s;
	const left = Math.floor(need / 2);
	const right = need - left;
	return rep(" ", left) + s + rep(" ", right);
};

function buildApprovalModal({ cols, command, explanation, focusedButton = "no" }) {
	const rows = [];
	const blank = () => padRight("", cols);

	rows.push(blank());
	rows.push(center(`<span class="fg-accent">APPROVAL REQUIRED</span>`, cols));
	rows.push(blank());
	rows.push(`   <span class="fg-divider">${rep("\u2500", cols - 6)}</span>   `);
	rows.push(blank());

	rows.push(`   <span class="fg-fg">You are about to execute:</span>${rep(" ", cols - 28)}`);
	rows.push(blank());

	// Command frame — all 3 rows on surface-recess bg (frame chars + interior).
	// Wrap each row in a single box-fill span at the inner width so the
	// recess color extends across the entire frame including borders.
	const cmdInnerWidth = cols - 14;
	const cmdFullWidth = cmdInnerWidth + 2; // includes left + right border chars
	const cmdRow = (inner) =>
		`   <span class="box-fill" style="background: var(--surface-recess); width: ${cmdFullWidth}ch">${inner}</span>   `;
	const cmdTopBorder = cmdRow(`<span class="fg-divider">\u250c${rep("\u2500", cmdInnerWidth)}\u2510</span>`);
	const cmdContent = cmdRow(`<span class="fg-divider">\u2502</span> <span class="fg-fg">${command}</span>${rep(" ", cmdInnerWidth - command.length - 1)}<span class="fg-divider">\u2502</span>`);
	const cmdBotBorder = cmdRow(`<span class="fg-divider">\u2514${rep("\u2500", cmdInnerWidth)}\u2518</span>`);
	rows.push(padRight(cmdTopBorder, cols));
	rows.push(padRight(cmdContent, cols));
	rows.push(padRight(cmdBotBorder, cols));
	rows.push(blank());

	// Explanation
	rows.push(`   <span class="fg-dim">\u2014 ${explanation}</span>${rep(" ", Math.max(1, cols - 6 - explanation.length))}`);
	rows.push(blank());
	rows.push(`   <span class="fg-divider">${rep("\u2500", cols - 6)}</span>   `);
	rows.push(blank());

	// Bottom row: ■ SYSTEM NOTICE  ............  [Y]ES  [N]O  [A]LWAYS
	const buttonStr = (label, focused) => {
		if (focused) {
			return `<span class="fg-fg" style="background: var(--accent); color: var(--background);">  ${label}  </span>`;
		}
		return `<span class="fg-divider">[</span><span class="fg-fg">${label[0]}</span><span class="fg-divider">]</span><span class="fg-fg">${label.slice(1)}</span>`;
	};
	const yes = buttonStr("YES", focusedButton === "yes");
	const no = buttonStr("NO", focusedButton === "no");
	const always = buttonStr("ALWAYS", focusedButton === "always");
	const buttons = `${yes}  ${no}  ${always}`;
	const buttonsLen = visibleLen(buttons);

	const left = `<span class="fg-approve">\u25a0</span> <span class="fg-dim">SYSTEM NOTICE</span>`;
	const leftLen = visibleLen(left);
	const middle = cols - 6 - leftLen - buttonsLen;
	rows.push(`   ${left}${rep(" ", Math.max(1, middle))}${buttons}   `);
	rows.push(blank());

	return rows.join("\n");
}

function htmlPage({ title, label, blurb, cols, content, rows }) {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="_assets/tokens.css">
<style>
  .stage-blurb { max-width: ${cols}ch; color: var(--foreground-dim); font-size: 11px; line-height: 1.6; padding: 0 8px; text-align: center; }
</style>
</head>
<body>
<div class="stage">
  <div class="stage-label">${label}</div>
  <div class="stage-blurb">${blurb}</div>
  <div data-render-rect class="term" style="--term-cols: ${cols}; --term-rows: ${rows};">
    <pre class="grid" style="background: var(--surface-lifted)">${content}</pre>
  </div>
</div>
</body>
</html>
`;
}

const COLS = 80;

const variants = [
	{
		filename: "06-approval-rm.html",
		title: "Bible · Element 6 · Approval · rm -rf",
		label: "element 6 · approval modal · destructive bash · 80 cols",
		blurb: "rm -rf approval. focus on [N]O for safety. ■ SYSTEM NOTICE in approval-red.",
		spec: {
			command: "rm -rf node_modules/",
			explanation: "This will remove 234MB and is irreversible.",
			focusedButton: "no",
		},
	},
	{
		filename: "06-approval-curl.html",
		title: "Bible · Element 6 · Approval · curl",
		label: "element 6 · approval modal · network call · 80 cols",
		blurb: "curl-pipe-shell pattern. classic risky operation.",
		spec: {
			command: "curl -fsSL https://get.example.com | sh",
			explanation: "Pipes a remote script directly into your shell. Inspect the source first.",
			focusedButton: "no",
		},
	},
	{
		filename: "06-approval-yes-focused.html",
		title: "Bible · Element 6 · Approval · YES focused",
		label: "element 6 · approval modal · YES button focused · 80 cols",
		blurb: "after user pressed Tab to move focus to YES.",
		spec: {
			command: "git push --force origin main",
			explanation: "Force-push will overwrite remote history. Other contributors will need to rebase.",
			focusedButton: "yes",
		},
	},
];

for (const v of variants) {
	const content = buildApprovalModal({ cols: COLS, ...v.spec });
	const rows = content.split("\n").length;
	writeFileSync(resolve(out, v.filename), htmlPage({ ...v, cols: COLS, content, rows }));
	console.log(`wrote ${v.filename}  (${COLS}\u00d7${rows})`);
}
