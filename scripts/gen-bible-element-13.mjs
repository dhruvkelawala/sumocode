#!/usr/bin/env node
// Element 13 — Chat messages.
// Per CATHEDRAL_UX_SPEC_V2.md §3.13:
//   ┌ USER
//   │ <text>
//   └
//   <blank>
//   ┌ SUMO · <model> · <time>
//   │ <text>
//   └
// Frame chars `┌ │ └` in divider color. USER label fg-fg, SUMO label
// fg-accent. Metadata (· model · time) in fg-dim.

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(repoRoot, "docs", "ui", "bible");

function rep(ch, n) { return ch.repeat(n); }

/** Wrap text to N chars/line, returning array of lines. Naive whitespace wrap. */
function wrap(text, width) {
	const words = text.split(/\s+/);
	const lines = [];
	let cur = "";
	for (const w of words) {
		if (cur.length === 0) cur = w;
		else if (cur.length + 1 + w.length <= width) cur += " " + w;
		else {
			lines.push(cur);
			cur = w;
		}
	}
	if (cur) lines.push(cur);
	return lines;
}

/** Pad a line to `cols` width (trailing spaces). */
function padRight(line, cols) {
	const visible = line.replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").length;
	const need = cols - visible;
	return need > 0 ? line + rep(" ", need) : line;
}

/**
 * Build one message as an array of HTML row strings.
 *  - USER: `┌ USER` opener, `│ <text>` body, `└` closer
 *  - SUMO: `┌ SUMO · <model> · <time>` opener, `│ <text>` body, `└` closer
 * Each row exactly `cols` wide.
 */
function buildMessage({ role, body, model, time, cols }) {
	const rows = [];

	// Opener row
	let opener;
	if (role === "USER") {
		opener =
			`<span class="fg-divider">┌</span>` +
			` ` +
			`<span class="fg-fg">USER</span>`;
	} else {
		// SUMO with metadata
		opener =
			`<span class="fg-divider">┌</span>` +
			` ` +
			`<span class="fg-accent">SUMO</span>` +
			`<span class="fg-dim"> · ${model} · ${time}</span>`;
	}
	rows.push(padRight(opener, cols));

	// Body rows — wrap text to (cols - 2) to leave room for `│ ` prefix
	const bodyLines = body.split("\n");
	for (const segment of bodyLines) {
		if (segment.length === 0) {
			// blank body row → render as `│` followed by spaces
			rows.push(padRight(`<span class="fg-divider">│</span>`, cols));
		} else {
			const wrapped = wrap(segment, cols - 2);
			for (const line of wrapped) {
				rows.push(padRight(
					`<span class="fg-divider">│</span>` +
					` ` +
					`<span class="fg-fg">${line}</span>`,
					cols,
				));
			}
		}
	}

	// Closer row
	rows.push(padRight(`<span class="fg-divider">└</span>`, cols));

	return rows;
}

/** Compose multiple messages with blank-row separators. */
function buildConversation({ messages, cols }) {
	const rows = [];
	for (let i = 0; i < messages.length; i++) {
		const msgRows = buildMessage({ ...messages[i], cols });
		rows.push(...msgRows);
		if (i < messages.length - 1) {
			// blank row separator
			rows.push(padRight("", cols));
		}
	}
	return rows;
}

function htmlPage({ title, label, cols, rows, conversationRows }) {
	const grid = conversationRows.join("\n");
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="_assets/tokens.css">
</head>
<body>
<div class="stage">
  <div class="stage-label">${label}</div>
  <div data-render-rect class="term" style="--term-cols: ${cols}; --term-rows: ${rows};">
    <pre class="grid">${grid}</pre>
  </div>
</div>
</body>
</html>
`;
}

const variants = [
	// 1. Just a user message (landscape chat width = 130)
	{
		filename: "13-chat-user.html",
		title: "Bible · Element 13 · USER message",
		label: "element 13 · user message · 130×4",
		cols: 130, rows: 4,
		messages: [
			{ role: "USER", body: "hello, refactor the auth flow to use the new session pattern." },
		],
	},
	// 2. Just a SUMO message
	{
		filename: "13-chat-sumo.html",
		title: "Bible · Element 13 · SUMO message",
		label: "element 13 · sumo message · 130×6",
		cols: 130, rows: 6,
		messages: [
			{
				role: "SUMO",
				model: "claude-opus-4-7",
				time: "11:42",
				body: "Reading the auth flow now to understand the current pattern.\n\nDone. Updated 14 lines, deleted 6 stale helpers.",
			},
		],
	},
	// 3. Full conversation alternating user+sumo (the spec example)
	{
		filename: "13-chat-conversation.html",
		title: "Bible · Element 13 · conversation",
		label: "element 13 · conversation (4 messages) · 130×20",
		cols: 130, rows: 20,
		messages: [
			{ role: "USER", body: "hello, refactor the auth flow to use the new session pattern." },
			{
				role: "SUMO",
				model: "claude-opus-4-7",
				time: "11:42",
				body: "Reading the auth flow now to understand the current pattern.\n\nDone. Updated 14 lines, deleted 6 stale helpers.",
			},
			{ role: "USER", body: "run tests" },
			{
				role: "SUMO",
				model: "claude-opus-4-7",
				time: "11:43",
				body: "All 22 tests pass.",
			},
		],
	},
	// 4. Portrait variant — narrow chat width (60 cols, no sidebar)
	{
		filename: "13-chat-conversation-portrait.html",
		title: "Bible · Element 13 · conversation · portrait",
		label: "element 13 · conversation · portrait 60×26",
		cols: 60, rows: 26,
		messages: [
			{ role: "USER", body: "hello, refactor the auth flow to use the new session pattern." },
			{
				role: "SUMO",
				model: "gpt-5.5",
				time: "11:42",
				body: "Reading the auth flow now to understand the current pattern.\n\nDone. Updated 14 lines, deleted 6 stale helpers.",
			},
			{ role: "USER", body: "run tests" },
			{
				role: "SUMO",
				model: "gpt-5.5",
				time: "11:43",
				body: "All 22 tests pass.",
			},
		],
	},
];

for (const v of variants) {
	const conversationRows = buildConversation({ messages: v.messages, cols: v.cols });
	const path = resolve(out, v.filename);
	writeFileSync(path, htmlPage({ ...v, conversationRows }));
	console.log(`wrote ${v.filename}  (${v.cols}×${v.rows})  ${conversationRows.length} rows`);
}
