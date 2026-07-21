export function validateFinalCellAssertions(scenario) {
	const assertions = scenario.finalCellAssertions;
	if (assertions === undefined) return;
	if (!Array.isArray(assertions)) throw new Error(`Scenario ${scenario.id} finalCellAssertions must be an array`);
	for (const [index, assertion] of assertions.entries()) {
		if (!assertion || typeof assertion !== "object") throw new Error(`Scenario ${scenario.id} finalCellAssertions[${index}] must be an object`);
		for (const field of ["row", "col"]) {
			if (!Number.isInteger(assertion[field]) || assertion[field] < 0) throw new Error(`Scenario ${scenario.id} finalCellAssertions[${index}].${field} must be a non-negative integer`);
		}
		const rows = scenario.dimensions?.rows;
		const cols = scenario.dimensions?.cols;
		if (Number.isInteger(rows) && assertion.row >= rows) throw new Error(`Scenario ${scenario.id} finalCellAssertions[${index}].row must be less than dimensions.rows (${rows})`);
		if (Number.isInteger(cols) && assertion.col >= cols) throw new Error(`Scenario ${scenario.id} finalCellAssertions[${index}].col must be less than dimensions.cols (${cols})`);
		if (assertion.text !== undefined && typeof assertion.text !== "string") throw new Error(`Scenario ${scenario.id} finalCellAssertions[${index}].text must be a string`);
		if (assertion.charPattern !== undefined) {
			if (typeof assertion.charPattern !== "string" || assertion.charPattern.length === 0) throw new Error(`Scenario ${scenario.id} finalCellAssertions[${index}].charPattern must be a non-empty string`);
			try { new RegExp(assertion.charPattern, "u"); }
			catch (error) { throw new Error(`Scenario ${scenario.id} finalCellAssertions[${index}].charPattern is invalid: ${error.message}`); }
		}
		if (assertion.width !== undefined && (!Number.isInteger(assertion.width) || assertion.width < 0)) throw new Error(`Scenario ${scenario.id} finalCellAssertions[${index}].width must be a non-negative integer`);
		if (assertion.fg !== undefined && normalizeHex(assertion.fg) === null) throw new Error(`Scenario ${scenario.id} finalCellAssertions[${index}].fg must be #rrggbb`);
	}
}

export function evaluateFinalCellAssertions(snapshot, assertions = []) {
	const mismatches = [];
	for (const [index, assertion] of assertions.entries()) {
		const cell = snapshot.cells[assertion.row]?.[assertion.col];
		if (!cell) {
			mismatches.push({ index, row: assertion.row, col: assertion.col, reason: "out-of-bounds" });
			continue;
		}
		if (assertion.text !== undefined) {
			const actual = readText(snapshot, assertion.row, assertion.col, assertion.text.length);
			if (actual !== assertion.text) mismatches.push({ index, row: assertion.row, col: assertion.col, reason: "text", expected: assertion.text, actual });
		}
		if (assertion.charPattern !== undefined) {
			const pattern = new RegExp(`^(?:${assertion.charPattern})$`, "u");
			if (!pattern.test(cell.char)) mismatches.push({ index, row: assertion.row, col: assertion.col, reason: "charPattern", expected: assertion.charPattern, actual: cell.char });
		}
		if (assertion.width !== undefined && cell.width !== assertion.width) {
			mismatches.push({ index, row: assertion.row, col: assertion.col, reason: "width", expected: assertion.width, actual: cell.width });
		}
		if (assertion.fg !== undefined) {
			const expected = normalizeHex(assertion.fg);
			const actual = normalizeHex(cell.fg ?? "");
			if (actual !== expected) mismatches.push({ index, row: assertion.row, col: assertion.col, reason: "fg", expected, actual });
		}
	}
	return { passed: mismatches.length === 0, count: assertions.length, mismatches };
}

export function finalCellContractToText(result) {
	const lines = [result.passed ? `Final cell contract: PASS (${result.count} assertion(s))` : `Final cell contract: FAIL (${result.mismatches.length} mismatch(es))`];
	for (const mismatch of result.mismatches) lines.push(`${mismatch.index}: row ${mismatch.row} col ${mismatch.col} ${mismatch.reason} expected=${JSON.stringify(mismatch.expected)} actual=${JSON.stringify(mismatch.actual)}`);
	return `${lines.join("\n")}\n`;
}

function readText(snapshot, row, col, length) {
	return Array.from({ length }, (_value, offset) => snapshot.cells[row]?.[col + offset]?.char ?? "").join("");
}

function normalizeHex(value) {
	const match = String(value).trim().match(/^#?([0-9a-fA-F]{6})$/);
	return match ? `#${match[1].toLowerCase()}` : null;
}
