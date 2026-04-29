// Convert ANSI-color text (24-bit SGR escapes) into HTML span chain.
// Designed for chafa-output .ans files: \x1b[38;2;R;G;Bm <chars> \x1b[39m ...
// Strips cursor visibility + reset escapes. Returns one HTML string per
// input line.

import { readFileSync } from "node:fs";

export function ansToHTMLLines(path) {
	const raw = readFileSync(path, "utf8");
	// Strip cursor-show/hide
	const cleaned = raw.replace(/\x1b\[\?25[lh]/g, "");
	const lines = cleaned.split(/\r?\n/).filter((l) => l.length > 0);
	return lines.map((line) => parseAnsiLine(line));
}

function parseAnsiLine(line) {
	const out = [];
	let currentFg = null;
	let currentBg = null;
	let buffer = "";

	const flush = () => {
		if (buffer.length === 0) return;
		const escaped = buffer
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;");
		const styles = [];
		if (currentFg) styles.push(`color: ${currentFg}`);
		if (currentBg) styles.push(`background: ${currentBg}`);
		if (styles.length === 0) {
			out.push(escaped);
		} else {
			out.push(`<span style="${styles.join("; ")}">${escaped}</span>`);
		}
		buffer = "";
	};

	let i = 0;
	while (i < line.length) {
		if (line[i] === "\x1b" && line[i + 1] === "[") {
			// Find end of escape sequence
			let j = i + 2;
			while (j < line.length && !/[a-zA-Z]/.test(line[j])) j++;
			const params = line.slice(i + 2, j).split(";");
			const cmd = line[j];

			if (cmd === "m") {
				// SGR — interpret params
				flush();
				let p = 0;
				while (p < params.length) {
					const code = parseInt(params[p], 10);
					if (code === 0 || code === 39) {
						currentFg = null;
						p++;
					} else if (code === 49) {
						currentBg = null;
						p++;
					} else if (code === 38 && params[p + 1] === "2") {
						const r = parseInt(params[p + 2], 10);
						const g = parseInt(params[p + 3], 10);
						const b = parseInt(params[p + 4], 10);
						currentFg = `rgb(${r},${g},${b})`;
						p += 5;
					} else if (code === 48 && params[p + 1] === "2") {
						const r = parseInt(params[p + 2], 10);
						const g = parseInt(params[p + 3], 10);
						const b = parseInt(params[p + 4], 10);
						currentBg = `rgb(${r},${g},${b})`;
						p += 5;
					} else {
						p++; // unknown, skip
					}
				}
			}
			i = j + 1;
		} else {
			buffer += line[i];
			i++;
		}
	}
	flush();
	return out.join("");
}
