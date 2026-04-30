const ANSI_16: readonly string[] = [
	"#000000",
	"#800000",
	"#008000",
	"#808000",
	"#000080",
	"#800080",
	"#008080",
	"#c0c0c0",
	"#808080",
	"#ff0000",
	"#00ff00",
	"#ffff00",
	"#0000ff",
	"#ff00ff",
	"#00ffff",
	"#ffffff",
];

export function isColorByte(value: number | undefined): value is number {
	return value !== undefined && Number.isInteger(value) && value >= 0 && value <= 255;
}

export function normalizeHexColor(red: number, green: number, blue: number): string {
	const toHex = (value: number) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
	return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

export function parseHexColor(color: string | undefined): [number, number, number] | undefined {
	if (!color) return undefined;
	const hex = color.startsWith("#") ? color.slice(1) : color;
	if (!/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
	return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
}

export function indexedColor(index: number): string | undefined {
	if (!isColorByte(index)) return undefined;
	if (index < ANSI_16.length) return ANSI_16[index];
	if (index >= 16 && index <= 231) {
		const value = index - 16;
		const red = Math.floor(value / 36);
		const green = Math.floor((value % 36) / 6);
		const blue = value % 6;
		const cube = [0, 95, 135, 175, 215, 255];
		return normalizeHexColor(cube[red] ?? 0, cube[green] ?? 0, cube[blue] ?? 0);
	}
	if (index >= 232 && index <= 255) {
		const gray = 8 + (index - 232) * 10;
		return normalizeHexColor(gray, gray, gray);
	}
	return undefined;
}
