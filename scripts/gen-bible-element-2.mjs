#!/usr/bin/env node
// Element 2 — Top bar.
// Per CATHEDRAL_DECISIONS.md Element 2:
//   SUMOCODE   ║ ● refactor-auth-flow ║   │ debug-balance-tx   │ ARCHIVE   ⏵_  ⚙
// Single-row hybrid:
//   - SUMOCODE accent left (always)
//   - ║ ● <session-name> ║ active session marker, dot color = agent state
//   - │ <session-name> recent sessions (mtime desc, dim)
//   - │ ARCHIVE opens session list overlay
//   - Octicons icons: \uf489 terminal, \uf423 gear

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

const STATE_CLASS = {
	idle:      "fg-idle",
	thinking:  "fg-think",
	tool:      "fg-tool",
	approval:  "fg-approve",
	learning:  "fg-learn",
};

function buildTopBar({ cols, state, activeSession, recents = [], showTabs = true, showArchive = true }) {
	const PAD = 1;
	const dotClass = STATE_CLASS[state];

	// Left: SUMOCODE + active session marker
	const left =
		`<span class="fg-accent">SUMOCODE</span>` +
		`<span class="fg-dim">  \u2551 </span>` +
		`<span class="${dotClass}">\u25cf</span>` +
		`<span class="fg-fg"> ${activeSession}</span>` +
		`<span class="fg-dim"> \u2551</span>`;

	// Recent session tabs (only if showTabs and there's room)
	let middleRecents = "";
	if (showTabs && recents.length > 0) {
		const parts = recents.map((name) => `<span class="fg-dim">   \u2502 ${name}</span>`);
		middleRecents = parts.join("");
	}

	// ARCHIVE link (always there if showArchive)
	const archive = showArchive ? `<span class="fg-dim">   \u2502 ARCHIVE</span>` : "";

	// Right: icons
	const right =
		`<span class="fg-fg">\uf489</span>` +
		`<span class="fg-dim">  </span>` +
		`<span class="fg-fg">\uf423</span>`;

	const leftFull = left + middleRecents + archive;
	const leftLen = visibleLen(leftFull);
	const rightLen = visibleLen(right);
	const middle = cols - PAD * 2 - leftLen - rightLen;

	if (middle < 1) {
		// Not enough space — drop recents progressively, then archive, then session marker
		// Simplest: render with truncated structure
		const fallbackLeft = left;
		const fallbackLen = visibleLen(fallbackLeft);
		const fallbackMid = cols - PAD * 2 - fallbackLen - rightLen;
		return rep(" ", PAD) + fallbackLeft + rep(" ", Math.max(1, fallbackMid)) + right + rep(" ", PAD);
	}

	return rep(" ", PAD) + leftFull + rep(" ", middle) + right + rep(" ", PAD);
}

function htmlPage({ title, label, blurb, cols, content }) {
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
  <div data-render-rect class="term" style="--term-cols: ${cols}; --term-rows: 1;">
    <pre class="grid">${content}</pre>
  </div>
</div>
</body>
</html>
`;
}

const standardSessions = {
	active: "auth-flow-refactor",
	recents: ["debug-balance-tx", "index-issues"],
};

const variants = [
	// 5 state variants (landscape, with recent tabs)
	{
		filename: "02-topbar-idle.html",
		title: "Bible · Element 2 · Top bar · IDLE",
		label: "element 2 · top bar · IDLE state · 160 cols",
		blurb: "active session dot in sage (idle / READY). full landscape with 2 recent session tabs and ARCHIVE.",
		cols: 160,
		spec: { state: "idle", activeSession: standardSessions.active, recents: standardSessions.recents },
	},
	{
		filename: "02-topbar-thinking.html",
		title: "Bible · Element 2 · Top bar · THINKING",
		label: "element 2 · top bar · THINKING state · 160 cols",
		blurb: "active session dot in amber (thinking / MEDITATING).",
		cols: 160,
		spec: { state: "thinking", activeSession: standardSessions.active, recents: standardSessions.recents },
	},
	{
		filename: "02-topbar-tool.html",
		title: "Bible · Element 2 · Top bar · TOOL",
		label: "element 2 · top bar · TOOL state · 160 cols",
		blurb: "active session dot in blue (tool running / ILLUMINATING).",
		cols: 160,
		spec: { state: "tool", activeSession: standardSessions.active, recents: standardSessions.recents },
	},
	{
		filename: "02-topbar-approval.html",
		title: "Bible · Element 2 · Top bar · APPROVAL",
		label: "element 2 · top bar · APPROVAL state · 160 cols",
		blurb: "active session dot in terracotta (approval needed / DEFERRING).",
		cols: 160,
		spec: { state: "approval", activeSession: standardSessions.active, recents: standardSessions.recents },
	},
	{
		filename: "02-topbar-learning.html",
		title: "Bible · Element 2 · Top bar · LEARNING",
		label: "element 2 · top bar · LEARNING state · 160 cols",
		blurb: "active session dot in violet (memory write / INSCRIBING).",
		cols: 160,
		spec: { state: "learning", activeSession: standardSessions.active, recents: standardSessions.recents },
	},
	// Without recents (fewer sessions)
	{
		filename: "02-topbar-no-recents.html",
		title: "Bible · Element 2 · Top bar · no recent tabs",
		label: "element 2 · top bar · no recent sessions · 160 cols",
		blurb: "first-boot or single-session state. just SUMOCODE + active marker + ARCHIVE.",
		cols: 160,
		spec: { state: "idle", activeSession: "first-session", recents: [] },
	},
	// Tabs hidden (`/sumo:tabs hide`)
	{
		filename: "02-topbar-tabs-hidden.html",
		title: "Bible · Element 2 · Top bar · tabs hidden",
		label: "element 2 · top bar · /sumo:tabs hide · 160 cols",
		blurb: "minimal mode. just SUMOCODE + active session + icons. activated via /sumo:tabs hide.",
		cols: 160,
		spec: { state: "idle", activeSession: standardSessions.active, recents: [], showTabs: false, showArchive: false },
	},
	// Portrait narrow
	{
		filename: "02-topbar-portrait.html",
		title: "Bible · Element 2 · Top bar · portrait",
		label: "element 2 · top bar · portrait 60 cols",
		blurb: "narrow form. drops recent tabs and ARCHIVE. SUMOCODE + active session + icons only.",
		cols: 60,
		spec: { state: "idle", activeSession: "019dd3d8", recents: [], showTabs: false, showArchive: false },
	},
];

for (const v of variants) {
	const content = buildTopBar({ cols: v.cols, ...v.spec });
	writeFileSync(resolve(out, v.filename), htmlPage({ ...v, content }));
	console.log(`wrote ${v.filename}  (${v.cols}\u00d71)`);
}
