#!/usr/bin/env node
// Element 9 — Tool pills (standalone).
// Inline form (lifted from chat box body):  ✓ [name]  target  · note
// Spec form (Element 9 framing):  ━━━ [name]  target  ━━━ ✓
//
// State variants:
//   - read ✓ done
//   - bash ▶ running (with progress bar)
//   - bash ✓ done (with summary)
//   - bash ✗ failed (with error)
//   - edit ✓ done (with diff body)
//   - write ✓ done

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

const STATE_GLYPH = { ok: "\u2713", running: "\u25b6", failed: "\u2717" };
const STATE_CLASS = { ok: "fg-idle", running: "fg-tool", failed: "fg-approve" };

// Inline tool pill (compact, used inside chat boxes):
//   ✓ [bash]  pnpm test src/auth  · 22 tests, 1.2s
function toolPillInline({ name, target, state, note }) {
	const glyph = STATE_GLYPH[state];
	const stateClass = STATE_CLASS[state];
	const noteHTML = note ? `<span class="fg-dim">  \u00b7 ${note}</span>` : "";
	return (
		`<span class="${stateClass}">${glyph}</span> ` +
		`<span class="fg-accent">[${name}]</span>` +
		`<span class="fg-fg">  ${target}</span>` +
		noteHTML
	);
}

// Framed tool pill (Element 9 spec):
//   ━━━ [bash]  pnpm test src/auth  ━━━━━━━━━━━━━━━━━━━━━ ✓ 22 tests, 1.2s
function toolPillFramed({ name, target, state, note }, cols) {
	const glyph = STATE_GLYPH[state];
	const stateClass = STATE_CLASS[state];
	const left = `[${name}]  ${target}`;
	const leftLen = left.length;
	const right = note ? `${glyph} ${note}` : `${glyph}`;
	const rightLen = right.length;

	// Layout: ━━━ <space> left <space> dashes <space> ━━━ <space> right
	// 3 + 1 + leftLen + 1 + dashes + 1 + 3 + 1 + rightLen = cols
	// dashes = cols - 10 - leftLen - rightLen
	const dashes = cols - 10 - leftLen - rightLen;
	const safeDashes = Math.max(3, dashes);

	return (
		`<span class="fg-divider">\u2501\u2501\u2501</span> ` +
		`<span class="fg-accent">[${name}]</span>` +
		`<span class="fg-fg">  ${target}</span>` +
		` ` +
		`<span class="fg-divider">${rep("\u2501", safeDashes)}</span>` +
		` ` +
		`<span class="fg-divider">\u2501\u2501\u2501</span> ` +
		`<span class="${stateClass}">${glyph}</span>` +
		(note ? `<span class="fg-dim"> ${note}</span>` : "")
	);
}

// Build full pill block — title row + body rows + status
function buildPillBlock({ tool, body = [], cols }) {
	const rows = [];
	rows.push(toolPillFramed(tool, cols));
	if (body.length > 0) {
		rows.push("");
		for (const line of body) rows.push("  " + line);
	}
	return rows.map((r) => padRight(r, cols)).join("\n");
}

function htmlPage({ title, label, blurb, cols, rows, content }) {
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

const COLS = 130;

const variants = [
	{
		filename: "09-pill-read-done.html",
		title: "Bible · Element 9 · pill · read done",
		label: "element 9 · [read] done · 130×1",
		blurb: "framed tool pill, read tool completed.",
		rows: 1,
		content: padRight(toolPillFramed({ name: "read", target: "src/auth/session.ts", state: "ok" }, COLS), COLS),
	},
	{
		filename: "09-pill-bash-running.html",
		title: "Bible · Element 9 · pill · bash running",
		label: "element 9 · [bash] running with progress · 130×8",
		blurb: "bash running. blue ▶ glyph + progress bar in tool color.",
		rows: 8,
		content: buildPillBlock({
			tool: { name: "bash", target: "pnpm test", state: "running" },
			body: [
				`<span class="fg-fg">> sumocode@1.0.4 test /usr/src/app</span>`,
				`<span class="fg-fg">> vitest run</span>`,
				``,
				`<span class="fg-idle">\u2713</span> <span class="fg-fg">src/core/parser.test.ts (14 tests)</span>`,
				`<span class="fg-tool">\u25b6</span> <span class="fg-fg">src/engine/runner.test.ts (running\u2026)</span>`,
				``,
				`<span class="fg-fg">[</span><span class="fg-tool">\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588</span><span class="fg-divider">\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591</span><span class="fg-fg">] </span><span class="fg-fg">57%</span>`,
			],
			cols: COLS,
		}),
	},
	{
		filename: "09-pill-bash-done.html",
		title: "Bible · Element 9 · pill · bash done",
		label: "element 9 · [bash] done with summary · 130×3",
		blurb: "bash completed. ✓ glyph + tests-passed summary inline.",
		rows: 3,
		content: buildPillBlock({
			tool: { name: "bash", target: "pnpm test src/auth", state: "ok", note: "22 tests, 1.2s" },
			body: [
				`<span class="fg-idle">\u2713</span> <span class="fg-fg">22 passed in 1.2s</span>`,
			],
			cols: COLS,
		}),
	},
	{
		filename: "09-pill-bash-failed.html",
		title: "Bible · Element 9 · pill · bash failed",
		label: "element 9 · [bash] failed · 130×6",
		blurb: "bash failed. ✗ glyph in approval color + error output.",
		rows: 6,
		content: buildPillBlock({
			tool: { name: "bash", target: "pnpm test src/auth", state: "failed", note: "1 failed" },
			body: [
				`<span class="fg-fg">\u2713 src/core/parser.test.ts (14 tests)</span>`,
				`<span class="fg-approve">\u2717 src/auth/session.test.ts (3 tests, 1 failed)</span>`,
				``,
				`<span class="fg-approve">\u2717 session expiry should reject expired tokens</span>`,
				`<span class="fg-fg">  expected: false</span>`,
				`<span class="fg-fg">  received: true</span>`,
			],
			cols: COLS,
		}),
	},
	{
		filename: "09-pill-edit-done.html",
		title: "Bible · Element 9 · pill · edit with diff",
		label: "element 9 · [edit] done with diff · 130×9",
		blurb: "edit completed with file diff. green +lines, red -lines, line numbers in dim.",
		rows: 9,
		content: buildPillBlock({
			tool: { name: "edit", target: "src/auth/session.ts", state: "ok" },
			body: [
				`<span class="fg-dim">  12  </span><span class="fg-approve" style="background: rgba(193,68,62,0.15)">- const session = new Session(token);</span>`,
				`<span class="fg-dim">  13  </span><span class="fg-approve" style="background: rgba(193,68,62,0.15)">- if (session.expired) return null;</span>`,
				`<span class="fg-dim">  14  </span><span class="fg-fg">    return session.user;</span>`,
				`<span class="fg-dim">  15  </span><span class="fg-fg">  }</span>`,
				`<span class="fg-dim">  16  </span><span class="fg-idle" style="background: rgba(127,176,105,0.15)">+ const session = await Session.fromToken(token);</span>`,
				`<span class="fg-dim">  17  </span><span class="fg-idle" style="background: rgba(127,176,105,0.15)">+ if (!session || session.expired) return null;</span>`,
				`<span class="fg-dim">  18  </span><span class="fg-idle" style="background: rgba(127,176,105,0.15)">+ return session.user;</span>`,
				`<span class="fg-dim">  19  </span><span class="fg-fg">  }</span>`,
			],
			cols: COLS,
		}),
	},
	{
		filename: "09-pill-write-done.html",
		title: "Bible · Element 9 · pill · write done",
		label: "element 9 · [write] done · 130×3",
		blurb: "new file written. shows preview of first lines + total line count.",
		rows: 3,
		content: buildPillBlock({
			tool: { name: "write", target: "src/auth/jwt-helpers.ts", state: "ok", note: "47 lines" },
			body: [
				`<span class="fg-dim">  1   </span><span class="fg-keyword">import</span> <span class="fg-fg">{ jwtVerify }</span> <span class="fg-keyword">from</span> <span class="fg-string">"jose"</span>;`,
				`<span class="fg-dim">  2   </span><span class="fg-comment">// ... 45 lines collapsed</span>`,
			],
			cols: COLS,
		}),
	},
	{
		filename: "09-pill-collapsed.html",
		title: "Bible · Element 9 · pill · long output collapsed",
		label: "element 9 · [bash] long output collapsed · 130×7",
		blurb: "auto-collapse to last 20 lines + 'N lines collapsed' marker.",
		rows: 7,
		content: buildPillBlock({
			tool: { name: "bash", target: "find . -name '*.ts'", state: "ok", note: "247 files" },
			body: [
				`<span class="fg-dim">  ... 240 lines collapsed</span>`,
				`<span class="fg-fg">  src/sumo-tui/widgets/scrollbox.ts</span>`,
				`<span class="fg-fg">  src/sumo-tui/widgets/scrolled-up-banner.ts</span>`,
				`<span class="fg-fg">  src/sumo-tui/widgets/sidebar-rendering.ts</span>`,
				`<span class="fg-fg">  src/tab-bar.ts</span>`,
				`<span class="fg-fg">  src/voice.ts</span>`,
			],
			cols: COLS,
		}),
	},
];

for (const v of variants) {
	writeFileSync(resolve(out, v.filename), htmlPage({ ...v, cols: COLS }));
	console.log(`wrote ${v.filename}  (${COLS}\u00d7${v.rows})`);
}
