#!/usr/bin/env node
// Additional scene compositions beyond active state.
// - splash (full screen, 160×45 + 60×100)
// - streaming (sumo currently typing, with thinking indicator)
// - approval-overlay (modal over active scene)
// - palette-overlay (Ctrl+/ palette over active scene)

import { writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(repoRoot, "docs", "ui", "bible");

// Helper: extract the inner term content from an existing mockup file
function extractTermContent(filename) {
	const html = readFileSync(resolve(out, filename), "utf8");
	const match = html.match(/<div data-render-rect class="term[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/body>/);
	return match ? match[1].trim() : "";
}

// Helper: read just the inner <pre> content from a single-element mockup
function extractPreContent(filename) {
	const html = readFileSync(resolve(out, filename), "utf8");
	const match = html.match(/<pre class="grid"[^>]*>([\s\S]+?)<\/pre>/);
	return match ? match[1] : "";
}

// ─── Scene: splash overlay over active scene ───────────────────────────
// We compose the splash full-screen scene by reusing 03-splash.html as the
// target. So this scene just confirms splash IS the splash element.
//
// For modal overlay scenes we need the active scene's middle pane visible
// behind a centered modal. Use CSS positioning.

function buildOverlayScene({ baseFilename, modalFilename, modalCols, modalRows, label, blurb }) {
	const baseHtml = readFileSync(resolve(out, baseFilename), "utf8");
	// The base is a complete .term scene. We need to insert a modal layer
	// positioned absolute on top.
	const modalHtml = readFileSync(resolve(out, modalFilename), "utf8");
	const modalContent = modalHtml.match(/<pre class="grid"[^>]*>([\s\S]+?)<\/pre>/)?.[0] ?? "";

	// Inject modal absolute-positioned over the term in the base
	const injected = baseHtml.replace(
		'<pre class="grid" style="grid-row: 8;">',
		`<div class="modal-overlay" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 10; box-shadow: 0 12px 40px rgba(0,0,0,0.6);">${modalContent}</div>\n    <pre class="grid" style="grid-row: 8;">`,
	);
	// Update title + label + blurb
	const final = injected
		.replace(/<title>[^<]+<\/title>/, `<title>Bible · Scene · ${label}</title>`)
		.replace(/<div class="stage-label">[^<]+<\/div>/, `<div class="stage-label">${label}</div>`)
		.replace(/<div class="stage-blurb">[^<]+<\/div>/, `<div class="stage-blurb">${blurb}</div>`);
	return final;
}

// ─── Scene: build & write ──────────────────────────────────────────────
const scenes = [
	{
		filename: "scene-approval-overlay.html",
		base: "scene-active.html",
		modal: "06-approval-rm.html",
		label: "scene · active + approval modal overlay · 160×45",
		blurb: "approval modal centered over active state. underlying chat + sidebar visible behind. modal sits on surface-lifted bg with subtle elevation shadow.",
	},
	{
		filename: "scene-palette-overlay.html",
		base: "scene-active.html",
		modal: "08-palette-default.html",
		label: "scene · active + Ctrl+/ palette overlay · 160×45",
		blurb: "command palette opened. centered modal over chat + sidebar. drill-down on Enter opens sub-overlay.",
	},
	{
		filename: "scene-divine-query-overlay.html",
		base: "scene-active.html",
		modal: "11-divine-query-rename.html",
		label: "scene · active + DIVINE QUERY overlay · 160×45",
		blurb: "DIVINE QUERY (Pi ask/confirm) centered over active scene. user picks via arrow keys + Enter.",
	},
];

for (const s of scenes) {
	const content = buildOverlayScene({
		baseFilename: s.base,
		modalFilename: s.modal,
		label: s.label,
		blurb: s.blurb,
	});
	writeFileSync(resolve(out, s.filename), content);
	console.log(`wrote ${s.filename}`);
}
