#!/usr/bin/env node
// Element 10 — Code blocks. Per CATHEDRAL_UX_SPEC_V2.md §3.10:
// Full frame ╭───╮│╰───╯ + surface-recess bg + line numbers + cathedral
// syntax (keywords accent, strings idle, numbers thinking, comments dim brown).

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

function buildCodeBlock({ cols, language, lines }) {
	const innerWidth = cols - 2; // ╭ and ╮ on edges
	const gutterWidth = 4; // "  N "
	const codeWidth = innerWidth - gutterWidth - 2; // -2 for left padding inside frame

	const rows = [];
	const langTag = language ? `<span class="fg-divider">\u2500 </span><span class="fg-dim">${language}</span><span class="fg-divider"> \u2500</span>` : "";
	const langLen = visibleLen(langTag);
	const topDashes = innerWidth - langLen - 2;
	const top = `<span class="fg-divider">\u256d\u2500</span>${langTag}<span class="fg-divider">${rep("\u2500", topDashes)}\u256e</span>`;
	rows.push(top);

	for (let i = 0; i < lines.length; i++) {
		const lineNum = String(i + 1).padStart(3);
		const code = lines[i];
		const codeVis = visibleLen(code);
		const padCode = innerWidth - 2 - 4 - codeVis;
		rows.push(
			`<span class="fg-divider">\u2502</span>` +
			`<span class="box-fill" style="background: var(--surface-recess); width: ${innerWidth}ch">` +
			` <span class="fg-dim">${lineNum} </span>` +
			code +
			rep(" ", Math.max(1, padCode + 1)) +
			`</span>` +
			`<span class="fg-divider">\u2502</span>`,
		);
	}

	const bot = `<span class="fg-divider">\u2570${rep("\u2500", innerWidth)}\u256f</span>`;
	rows.push(bot);
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
    <pre class="grid">${content}</pre>
  </div>
</div>
</body>
</html>
`;
}

const COLS = 100;

const variants = [
	{
		filename: "10-code-typescript.html",
		title: "Bible · Element 10 · Code · TypeScript",
		label: "element 10 · TypeScript code block · 100 cols",
		blurb: "cathedral syntax. keywords accent, strings sage, numbers amber, comments dim brown.",
		spec: {
			language: "ts",
			lines: [
				`<span class="fg-keyword">async function</span> <span class="fg-fn">authenticate</span>(<span class="fg-fg">token</span>: <span class="fg-fg">string</span>) {`,
				`  <span class="fg-keyword">const</span> <span class="fg-fg">session</span> = <span class="fg-keyword">await</span> <span class="fg-fn">Session</span>.<span class="fg-fn">fromToken</span>(<span class="fg-fg">token</span>);`,
				`  <span class="fg-keyword">if</span> (!<span class="fg-fg">session</span> || <span class="fg-fg">session</span>.<span class="fg-fg">expired</span>) <span class="fg-keyword">return</span> <span class="fg-keyword">null</span>;`,
				``,
				`  <span class="fg-comment">// emit auth event for telemetry</span>`,
				`  <span class="fg-fn">emit</span>(<span class="fg-string">"auth.success"</span>, { <span class="fg-fg">userId</span>: <span class="fg-fg">session</span>.<span class="fg-fg">user</span>.<span class="fg-fg">id</span> });`,
				`  <span class="fg-keyword">return</span> <span class="fg-fg">session</span>.<span class="fg-fg">user</span>;`,
				`}`,
			],
		},
	},
	{
		filename: "10-code-bash.html",
		title: "Bible · Element 10 · Code · bash",
		label: "element 10 · bash script · 100 cols",
		blurb: "shell script with comment, command substitution, conditional.",
		spec: {
			language: "bash",
			lines: [
				`<span class="fg-comment">#!/usr/bin/env bash</span>`,
				`<span class="fg-comment"># archive sessions older than 30 days</span>`,
				``,
				`<span class="fg-fg">cd</span> <span class="fg-string">"\${HOME}/.pi/agent/sessions"</span>`,
				``,
				`<span class="fg-keyword">for</span> <span class="fg-fg">f</span> <span class="fg-keyword">in</span> $(<span class="fg-fn">find</span> . <span class="fg-string">-name "*.jsonl"</span> <span class="fg-string">-mtime +30</span>); <span class="fg-keyword">do</span>`,
				`  <span class="fg-fn">gzip</span> <span class="fg-string">"\${f}"</span> && <span class="fg-fn">mv</span> <span class="fg-string">"\${f}.gz"</span> <span class="fg-string">archive/</span>`,
				`<span class="fg-keyword">done</span>`,
				``,
				`<span class="fg-fn">echo</span> <span class="fg-string">"archived <span class="fg-number">$(ls archive/ | wc -l)</span> sessions"</span>`,
			],
		},
	},
];

for (const v of variants) {
	const content = buildCodeBlock({ cols: COLS, ...v.spec });
	const rows = content.split("\n").length;
	writeFileSync(resolve(out, v.filename), htmlPage({ ...v, cols: COLS, content, rows }));
	console.log(`wrote ${v.filename}  (${COLS}\u00d7${rows})`);
}
