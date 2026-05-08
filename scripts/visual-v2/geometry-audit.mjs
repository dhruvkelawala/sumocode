/**
 * Geometry audit for V2 visual parity.
 *
 * Analyses a terminal snapshot's plainText to produce a per-row geometry table,
 * then compares it against a reference spec (expected row regions, horizontal
 * bounds, content categories). Mismatches are flagged in a structured report.
 *
 * Usage inside the review pipeline:
 *   import { auditGeometry } from "./geometry-audit.mjs";
 *   const audit = auditGeometry(snapshot, spec);
 *   // audit.passed, audit.rows, audit.mismatches
 *
 * The reference spec is declared per scenario in scenarios.json under a
 * `geometrySpec` key (optional; scenarios without one skip the audit).
 */

import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * Classify a row by its visible content.
 */
function classifyRow(line) {
	const trimmed = line.trim();
	if (trimmed.length === 0) return "blank";
	// Input frame borders must be checked before generic frame-border.
	if (/^┌─/.test(trimmed) && /┐$/.test(trimmed)) return "input-top";
	if (/^└─/.test(trimmed) && /┘$/.test(trimmed)) return "input-bottom";
	// Overlays are spliced into existing rows; detect them before chat frame rows.
	if (trimmed.includes("COMMAND PALETTE")) return "overlay";
	if (/^╭\s*(USER|SUMO|TOOL)/.test(trimmed)) return "chat-frame-top";
	if (/^╰─/.test(trimmed)) return "chat-frame-bottom";
	if (/^│/.test(trimmed) && /│\s*$/.test(trimmed)) return "chat-frame-body";
	if (/^[┌┐└┘╭╮╰╯─│]+$/.test(trimmed)) return "frame-border";
	if (trimmed.includes("SUMOCODE") && trimmed.includes("║")) return "top-bar";
	if (trimmed.includes("CTRL+/") && trimmed.includes("COMMANDS")) return "hint-row";
	if (/^●\s/.test(trimmed) || /^[●○]\s*(READY|MEDITATING|ILLUMINATING|DEFERRING|INSCRIBING)/.test(trimmed)) return "footer";
	if (trimmed.includes("REGISTRY") || trimmed.includes("CONTEXT") || trimmed.includes("MEMORY")) return "sidebar";
	if (trimmed.includes("Working...")) return "working";
	return "content";
}

/**
 * Analyse a row's horizontal bounds.
 */
function rowBounds(line) {
	const chars = Array.from(line);
	let first = null;
	let last = null;
	for (let i = 0; i < chars.length; i++) {
		if (chars[i] !== " ") {
			if (first === null) first = i;
			last = i;
		}
	}
	return { first, last, length: line.length, visibleWidth: visibleWidth(line) };
}

/**
 * Run geometry audit on a terminal snapshot.
 * @param {object} snapshot - { plainText, cols, rows }
 * @param {object|null} spec - Optional reference geometry spec
 * @returns {{ passed: boolean, rows: object[], mismatches: object[], summary: string }}
 */
export function auditGeometry(snapshot, spec = null) {
	const lines = snapshot.plainText.split("\n");
	const rows = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const bounds = rowBounds(line);
		const category = classifyRow(line);
		rows.push({ row: i, category, ...bounds, text: line.slice(0, 80) });
	}

	const mismatches = [];

	if (spec) {
		// Check expected regions
		if (spec.regions) {
			for (const region of spec.regions) {
				for (let r = region.startRow; r <= region.endRow; r++) {
					const actual = rows[r];
					if (!actual) {
						mismatches.push({ row: r, type: "missing-row", expected: region.category, actual: null });
						continue;
					}
					if (region.category && actual.category !== region.category && region.category !== "any") {
						mismatches.push({
							row: r,
							type: "category",
							expected: region.category,
							actual: actual.category,
							text: actual.text,
						});
					}
					if (region.firstCol !== undefined && actual.first !== region.firstCol) {
						mismatches.push({
							row: r,
							type: "first-col",
							expected: region.firstCol,
							actual: actual.first,
							text: actual.text,
						});
					}
					if (region.lastCol !== undefined && actual.last !== region.lastCol) {
						mismatches.push({
							row: r,
							type: "last-col",
							expected: region.lastCol,
							actual: actual.last,
							text: actual.text,
						});
					}
				}
			}
		}

		// Check no content outside expected bounds
		if (spec.contentBounds) {
			for (const row of rows) {
				if (row.category === "blank") continue;
				if (row.first !== null && spec.contentBounds.minFirst !== undefined && row.first < spec.contentBounds.minFirst) {
					mismatches.push({ row: row.row, type: "out-of-bounds-left", expected: spec.contentBounds.minFirst, actual: row.first, text: row.text });
				}
				if (row.last !== null && spec.contentBounds.maxLast !== undefined && row.last > spec.contentBounds.maxLast) {
					mismatches.push({ row: row.row, type: "out-of-bounds-right", expected: spec.contentBounds.maxLast, actual: row.last, text: row.text });
				}
			}
		}
	}

	const passed = mismatches.length === 0;
	const summary = passed
		? `Geometry audit passed: ${rows.length} rows, no mismatches`
		: `Geometry audit FAILED: ${mismatches.length} mismatch(es) in ${rows.length} rows`;

	return { passed, rows, mismatches, summary };
}

/**
 * Format audit result as an HTML table for embedding in review packs.
 */
export function auditToHtml(audit, scenarioId) {
	const escape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const statusClass = audit.passed ? "ok" : "fail";
	let html = `<div class="geometry-audit">
<h3>Geometry Audit: ${escape(scenarioId)}</h3>
<div class="${statusClass}">${escape(audit.summary)}</div>`;

	if (audit.mismatches.length > 0) {
		html += `\n<table class="audit-mismatches">
<tr><th>Row</th><th>Type</th><th>Expected</th><th>Actual</th><th>Content</th></tr>`;
		for (const m of audit.mismatches) {
			html += `\n<tr><td>${m.row}</td><td>${escape(m.type)}</td><td>${escape(m.expected ?? "")}</td><td>${escape(m.actual ?? "")}</td><td><code>${escape(m.text ?? "").slice(0, 60)}</code></td></tr>`;
		}
		html += `\n</table>`;
	}

	html += `\n<details><summary>Full row table (${audit.rows.length} rows)</summary>
<table class="audit-rows">
<tr><th>#</th><th>Category</th><th>First</th><th>Last</th><th>Len</th><th>Content</th></tr>`;
	for (const r of audit.rows) {
		const highlight = audit.mismatches.some((m) => m.row === r.row) ? ' class="mismatch"' : "";
		html += `\n<tr${highlight}><td>${r.row}</td><td>${escape(r.category)}</td><td>${r.first ?? "-"}</td><td>${r.last ?? "-"}</td><td>${r.length}</td><td><code>${escape(r.text).slice(0, 60)}</code></td></tr>`;
	}
	html += `\n</table></details></div>`;
	return html;
}

/**
 * Format audit result as a compact CLI table.
 */
export function auditToText(audit) {
	const lines = [audit.summary, ""];
	if (audit.mismatches.length > 0) {
		lines.push("MISMATCHES:");
		for (const m of audit.mismatches) {
			lines.push(`  row ${String(m.row).padStart(3)} ${m.type.padEnd(18)} expected=${String(m.expected ?? "").padEnd(16)} actual=${String(m.actual ?? "").padEnd(16)} ${(m.text ?? "").slice(0, 50)}`);
		}
		lines.push("");
	}
	lines.push("ROW TABLE:");
	lines.push(`${"#".padStart(3)} ${"Category".padEnd(18)} ${"First".padStart(5)} ${"Last".padStart(5)} ${"Len".padStart(4)}`);
	for (const r of audit.rows) {
		const mark = audit.mismatches.some((m) => m.row === r.row) ? "!" : " ";
		lines.push(`${mark}${String(r.row).padStart(2)} ${r.category.padEnd(18)} ${String(r.first ?? "-").padStart(5)} ${String(r.last ?? "-").padStart(5)} ${String(r.length).padStart(4)}`);
	}
	return lines.join("\n");
}
