import xterm from "@xterm/headless";

const DEFAULT_FG = "#F5E6C8";
const DEFAULT_BG = "#1A1511";
const ANSI_16 = [
	"#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
	"#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
];

export async function replayAnsi(bytes, dimensions, options = {}) {
	const cols = dimensions.cols;
	const rows = dimensions.rows;
	if (!Number.isInteger(cols) || cols <= 0) throw new Error(`Invalid terminal cols: ${cols}`);
	if (!Number.isInteger(rows) || rows <= 0) throw new Error(`Invalid terminal rows: ${rows}`);

	const terminal = new xterm.Terminal({
		cols,
		rows,
		allowProposedApi: true,
		convertEol: false,
		scrollback: 0,
		termName: "xterm-256color",
	});

	await writeTerminal(terminal, bytes);

	const buffer = terminal.buffer.active;
	const cells = [];
	for (let row = 0; row < rows; row += 1) {
		const line = buffer.getLine(row);
		const outRow = [];
		for (let col = 0; col < cols; col += 1) {
			const cell = line?.getCell(col);
			outRow.push(cell ? snapshotCell(cell, options) : blankCell());
		}
		cells.push(outRow);
	}

	return {
		cols,
		rows,
		cursor: { x: buffer.cursorX, y: buffer.cursorY },
		cells,
		plainText: cells.map((row) => row.map((cell) => cell.char || " ").join("")).join("\n"),
	};
}

function writeTerminal(terminal, bytes) {
	return new Promise((resolve, reject) => {
		try {
			terminal.write(bytes, resolve);
		} catch (error) {
			reject(error);
		}
	});
}

function snapshotCell(cell) {
	const width = typeof cell.getWidth === "function" ? cell.getWidth() : 1;
	return {
		char: normalizeChar(cell.getChars?.() ?? "", width),
		width,
		fg: resolveColor(cell, "fg"),
		bg: resolveColor(cell, "bg"),
		bold: Boolean(cell.isBold?.()),
		dim: Boolean(cell.isDim?.()),
		italic: Boolean(cell.isItalic?.()),
		underline: Boolean(cell.isUnderline?.()),
		inverse: Boolean(cell.isInverse?.()),
	};
}

function blankCell() {
	return { char: " ", width: 1, fg: DEFAULT_FG, bg: DEFAULT_BG, bold: false, dim: false, italic: false, underline: false, inverse: false };
}

function normalizeChar(chars, width) {
	if (width === 0) return "";
	return chars && chars.length > 0 ? chars : " ";
}

function resolveColor(cell, channel) {
	const isDefault = channel === "fg" ? cell.isFgDefault?.() : cell.isBgDefault?.();
	if (isDefault) return channel === "fg" ? DEFAULT_FG : DEFAULT_BG;
	const isRgb = channel === "fg" ? cell.isFgRGB?.() : cell.isBgRGB?.();
	const isPalette = channel === "fg" ? cell.isFgPalette?.() : cell.isBgPalette?.();
	const value = channel === "fg" ? cell.getFgColor?.() : cell.getBgColor?.();
	if (isRgb && Number.isInteger(value) && value >= 0) return intToHex(value);
	if (isPalette && Number.isInteger(value) && value >= 0) return ANSI_16[value] ?? DEFAULT_FG;
	return channel === "fg" ? DEFAULT_FG : DEFAULT_BG;
}

function intToHex(value) {
	const red = (value >> 16) & 0xff;
	const green = (value >> 8) & 0xff;
	const blue = value & 0xff;
	return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function toHex(value) {
	return value.toString(16).padStart(2, "0");
}
