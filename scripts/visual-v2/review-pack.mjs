import { relative } from "node:path";
import { outDir, repoRoot } from "./paths.mjs";
import { writeFile, writeJson } from "./fs-utils.mjs";

export function writeReviewPack(results, options = {}) {
	const resultsPath = `${outDir}/results.json`;
	const summaryPath = `${outDir}/summary.md`;
	const indexPath = `${outDir}/index.html`;
	writeJson(resultsPath, results);
	writeFile(summaryPath, summaryMarkdown(results));
	writeFile(indexPath, indexHtml(results));
	return { resultsPath, summaryPath, indexPath };
}

function summaryMarkdown(results) {
	const totals = summarize(results);
	const lines = [
		"# V2 Cathedral Visual Harness Review Pack",
		"",
		`- Commit: \`${results.commit}\``,
		`- Generated: ${results.generatedAt}`,
		`- Scenarios: ${totals.scenarios}`,
		`- Crops: ${totals.crops}`,
		`- Hard failures: ${totals.failed}`,
		`- Required failures: ${totals.requiredFailed}`,
		`- Review diffs: ${totals.reviewDiffs}`,
		"",
		"| Scenario | Lane | Status | Result | Crops |",
		"|---|---|---|---|---|",
	];
	for (const scenario of results.scenarios) {
		lines.push(`| ${scenario.id} | ${scenario.lane} | ${scenario.status} | ${scenario.result} | ${scenario.crops.length} |`);
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}

function indexHtml(results) {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>V2 Cathedral Visual Harness</title>
<style>
:root { color-scheme: dark; --bg:#0B0806; --surface:#1A1511; --card:#241D17; --fg:#F5E6C8; --dim:#8B7A63; --accent:#D97706; --divider:#5A4D3C; --bad:#C1443E; --ok:#7FB069; --warn:#E8B339; }
html, body { margin:0; background:var(--bg); color:var(--fg); font-family:'JetBrains Mono', ui-monospace, Menlo, monospace; }
body { padding:24px; }
h1 { color:var(--accent); font-size:18px; letter-spacing:.08em; text-transform:uppercase; margin:0 0 8px; }
h2 { color:var(--fg); font-size:14px; margin:28px 0 8px; letter-spacing:.05em; text-transform:uppercase; }
h3 { color:var(--dim); font-size:12px; letter-spacing:.08em; text-transform:uppercase; margin:20px 0 8px; }
.meta { color:var(--dim); font-size:12px; margin-bottom:18px; }
.guide { border:1px solid var(--divider); background:var(--surface); padding:14px 16px; margin:18px 0 18px; max-width:1180px; }
.guide-title { color:var(--accent); font-weight:700; font-size:13px; letter-spacing:.08em; text-transform:uppercase; margin-bottom:8px; }
.guide p { margin:8px 0; color:var(--fg); font-size:12px; line-height:1.55; }
.guide ol { margin:8px 0 0 20px; padding:0; color:var(--dim); font-size:12px; line-height:1.7; }
.summary { display:flex; flex-wrap:wrap; gap:10px; margin:16px 0 24px; }
.pill { border:1px solid var(--divider); background:var(--surface); padding:6px 10px; font-size:12px; }
.ok { color:var(--ok); } .fail { color:var(--bad); } .review { color:var(--warn); } .dim { color:var(--dim); }
.section-note { color:var(--dim); font-size:12px; line-height:1.5; margin:-2px 0 14px; max-width:1040px; }
.scenario { border:1px solid var(--divider); background:var(--surface); margin:20px 0; padding:14px; max-width:1280px; }
.scenario-header { display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; border-bottom:1px solid var(--divider); padding-bottom:8px; }
.scenario-title { color:var(--accent); font-weight:700; }
.scenario-description { color:var(--dim); font-size:12px; line-height:1.5; margin:10px 0 0; }
.artifacts { display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:12px; margin-top:12px; align-items:stretch; }
.artifact { background:var(--card); border:1px solid var(--divider); overflow:hidden; display:flex; flex-direction:column; min-height:0; }
.artifact-title { color:var(--dim); font-size:10px; letter-spacing:.08em; text-transform:uppercase; padding:6px 8px; border-bottom:1px solid var(--divider); }
.artifact-frame { height:220px; background:#120D0A; display:flex; align-items:center; justify-content:center; overflow:hidden; }
.crop .artifact-frame { height:150px; }
.artifact img { display:block; width:100%; height:100%; object-fit:contain; background:#1A1511; image-rendering:pixelated; }
.artifact-caption { color:var(--dim); font-size:10px; padding:6px 8px; border-top:1px solid rgba(90,77,60,.55); }
.debug-diffs { margin-top:10px; border:1px dashed rgba(90,77,60,.75); background:#120D0A; }
.debug-diffs summary { cursor:pointer; color:var(--dim); font-size:11px; letter-spacing:.06em; text-transform:uppercase; padding:8px 10px; }
.debug-diffs .artifacts { margin:0; padding:0 10px 10px; }
.crop { margin-top:18px; padding-top:12px; border-top:1px solid var(--divider); }
.crop-head { display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; margin-bottom:8px; }
.metric { color:var(--dim); font-size:11px; }
pre { white-space:pre-wrap; color:var(--dim); font-size:11px; border:1px solid var(--divider); background:#120D0A; padding:8px; overflow:auto; }
a { color:var(--accent); }
</style>
</head>
<body>
<h1>V2 Cathedral Visual Harness</h1>
<div class="meta">Commit ${escapeHtml(results.commit)} · generated ${escapeHtml(results.generatedAt)} · mode ${escapeHtml(results.mode)}</div>
${reviewGuideHtml()}
${summaryHtml(results)}
${scenarioGroupsHtml(results)}
</body>
</html>`;
}

function reviewGuideHtml() {
	return `<section class="guide">
  <div class="guide-title">How to read this page</div>
  <p>This is a <strong>review pack</strong>, not a claim that V2 already matches the Bible. Each card compares the Visual Bible target against the current SumoCode capture and highlights drift.</p>
  <ol>
    <li>Review <strong>Component scenarios</strong> first. They are small, deterministic, and intended to become the first promoted crops.</li>
    <li>For each card, primarily compare <strong>Bible target</strong> → <strong>Current capture</strong>. That is the human review path.</li>
    <li><strong>Debug pixel diffs</strong> are diagnostic/gating artifacts. They are useful for agents and CI, but they are not the main human approval surface.</li>
    <li><strong>review</strong> means drift is reported but does not fail CI. <strong>required</strong> means drift fails CI against an approved runtime golden when present, otherwise against the Bible target.</li>
    <li>Visual mismatch is expected today. Bad signs are blank captures, stack traces, missing images, or crops pointed at the wrong region.</li>
  </ol>
</section>`;
}

function summaryHtml(results) {
	const totals = summarize(results);
	return `<div class="summary">
  <div class="pill">Scenarios: ${totals.scenarios}</div>
  <div class="pill">Crops: ${totals.crops}</div>
  <div class="pill ${totals.failed ? "fail" : "ok"}">Hard failures: ${totals.failed}</div>
  <div class="pill ${totals.requiredFailed ? "fail" : "ok"}">Required failures: ${totals.requiredFailed}</div>
  <div class="pill review">Review diffs: ${totals.reviewDiffs}</div>
</div>`;
}

function scenarioGroupsHtml(results) {
	const component = results.scenarios.filter((scenario) => scenario.lane === "component");
	const fixture = results.scenarios.filter((scenario) => scenario.lane === "fixture");
	const runtime = results.scenarios.filter((scenario) => scenario.lane === "runtime");
	return `${scenarioSectionHtml("Component scenarios — review these first", "Small deterministic component captures. Use these cards to decide whether the harness is useful for component-by-component V2 work.", component)}\n${scenarioSectionHtml("Fixture scenes — deterministic completed states", "Full-scene captures from TranscriptViewModel fixtures. These cover completed assistant/tool states without live model or tool nondeterminism.", fixture)}\n${scenarioSectionHtml("Runtime scenarios — required RPC parity gates", "Real SumoCode runtime captures. Required crops fail CI when RPC-default UI drifts from the original Cathedral UX target.", runtime)}`;
}

function scenarioSectionHtml(title, note, scenarios) {
	if (scenarios.length === 0) return "";
	return `<h2>${escapeHtml(title)}</h2>\n<div class="section-note">${escapeHtml(note)}</div>\n${scenarios.map(scenarioHtml).join("\n")}`;
}

function scenarioHtml(scenario) {
	const statusClass = scenario.result === "failed" ? "fail" : scenario.result === "passed" ? "ok" : "review";
	return `<section class="scenario">
  <div class="scenario-header">
    <div class="scenario-title">${escapeHtml(scenario.id)}</div>
    <div class="metric">lane ${escapeHtml(scenario.lane)}</div>
    <div class="metric">status ${escapeHtml(scenario.status)}</div>
    <div class="${statusClass}">${escapeHtml(scenario.result)}</div>
  </div>
  <div class="scenario-description">${escapeHtml(scenarioDescription(scenario))}</div>
  ${scenario.error ? `<pre>${escapeHtml(scenario.error)}</pre>` : ""}
  ${finalScreenRejectionHtml(scenario.finalScreenRejection)}
  <div class="artifacts">
    ${artifact("Bible target", scenario.artifacts?.targetFull)}
    ${artifact(scenario.lane === "fixture" ? "Fixture capture" : "Runtime", scenario.artifacts?.runtimeFull)}
  </div>
  ${scenario.crops.map(cropHtml).join("\n")}
</section>`;
}

function finalScreenRejectionHtml(rejection) {
	if (!rejection) return "";
	return `<pre>Final-screen rejection matched ${escapeHtml(JSON.stringify(rejection.pattern))}\n${escapeHtml(rejection.snippet)}</pre>`;
}

function scenarioDescription(scenario) {
	const descriptions = {
		"input-typed-component": "Focused component capture for the active typed input frame. Review this before input-frame implementation work.",
		"footer-ready-component": "Focused component capture for the Cathedral footer status row. Review state labels, dot ownership, and spacing.",
		"sidebar-editorial-component": "Focused component capture for the editorial REGISTRY sidebar. Review width, masthead, section rhythm, and hierarchy.",
		"splash-runtime": "Real runtime splash capture. Required full-frame gate for the RPC-default splash surface.",
		"active-landscape-runtime": "Real 160x45 post-submit active-working capture. Offline runtime is expected to show SUMO working/meditating, not a completed model answer.",
		"active-portrait-runtime": "Real portrait post-submit active-working capture. Offline runtime is expected to show SUMO working/meditating, not a completed model answer.",
		"fixture-completed-landscape": "Deterministic 160x45 completed transcript fixture with read/edit/bash tool blocks.",
		"fixture-completed-portrait": "Deterministic 60x100 completed transcript fixture using the no-sidebar portrait policy.",
		"fixture-command-palette-overlay": "Deterministic completed transcript fixture with the V2 Scriptorium command palette centered as an overlay.",
		"fixture-tool-ledger-landscape": "Deterministic tool-heavy fixture for reviewing completed tool state composition.",
	};
	return descriptions[scenario.id] ?? "Visual parity scenario.";
}

function cropHtml(crop) {
	const bible = crop.comparison?.bible;
	const statusClass = crop.result === "failed" ? "fail" : crop.result === "passed" ? "ok" : "review";
	const metric = bible ? `${formatPercent(bible.diffRatio)} diff · ${bible.diffPixels}/${bible.totalPixels} px · threshold ${formatPercent(bible.threshold)}${bible.dimensionMismatch ? " · dimension mismatch" : ""}` : "not compared";
	return `<div class="crop">
  <div class="crop-head">
    <h3>${escapeHtml(crop.id)}</h3>
    <div class="metric">status ${escapeHtml(crop.status)}</div>
    <div class="${statusClass}">${escapeHtml(crop.result)}</div>
    <div class="metric">${escapeHtml(metric)}</div>
  </div>
  <div class="artifacts">
    ${artifact("Bible target crop", crop.artifacts?.target)}
    ${artifact("Current capture crop", crop.artifacts?.runtime)}
    ${artifact("Approved golden", crop.artifacts?.golden)}
  </div>
  ${debugDiffsHtml(crop)}
</div>`;
}

function debugDiffsHtml(crop) {
	const diffs = [
		artifact("Debug pixel diff vs Bible", crop.artifacts?.bibleDiff),
		artifact("Debug pixel diff vs golden", crop.artifacts?.goldenDiff),
	].filter(Boolean).join("\n");
	if (!diffs) return "";
	return `<details class="debug-diffs"><summary>Debug diffs — diagnostic, not primary human review</summary><div class="artifacts">${diffs}</div></details>`;
}

function artifact(title, path) {
	if (!path) return "";
	const rel = toOutRelative(path);
	return `<div class="artifact"><div class="artifact-title">${escapeHtml(title)}</div><a class="artifact-frame" href="${encodeURI(rel)}"><img src="${encodeURI(rel)}" alt="${escapeHtml(title)}"></a><div class="artifact-caption">click to open full-size PNG</div></div>`;
}

function toOutRelative(path) {
	return relative(outDir, path).split("/").map(encodeURIComponent).join("/");
}

function summarize(results) {
	let crops = 0;
	let failed = 0;
	let requiredFailed = 0;
	let reviewDiffs = 0;
	for (const scenario of results.scenarios) {
		if (scenario.result === "failed") failed += 1;
		for (const crop of scenario.crops) {
			crops += 1;
			if (crop.result === "failed" && crop.status === "required") requiredFailed += 1;
			if (crop.result === "review-diff") reviewDiffs += 1;
		}
	}
	return { scenarios: results.scenarios.length, crops, failed, requiredFailed, reviewDiffs };
}

function formatPercent(value) {
	return `${(value * 100).toFixed(2)}%`;
}

function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}
