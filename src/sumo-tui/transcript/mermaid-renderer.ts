import { render, type Cls, type MermaidArt } from "grok-mermaid";
import { activeThemeColors, type ThemeColors } from "../../themes/index.js";
import { lineToAnsi, span, textLine } from "../render/primitives.js";

export interface MermaidRenderResult {
	readonly rows: readonly string[];
	readonly warnings: readonly string[];
}

/** Render Mermaid source as width-safe Cathedral Unicode art. */
export function renderCathedralMermaid(source: string, availableWidth: number): MermaidRenderResult | undefined {
	const width = Math.max(0, Math.floor(availableWidth));
	if (width === 0) return undefined;
	const art = render(source);
	if (!art || art.width > width) return undefined;
	return { rows: renderRows(art, activeThemeColors()), warnings: art.warnings };
}

function colorFor(cls: Cls, colors: ThemeColors): string | undefined {
	switch (cls) {
		case "border":
			return colors.divider;
		case "text":
			return colors.foreground;
		case "edge":
		case "title":
			return colors.accent;
		case "edgeLabel":
			return colors.foregroundDim;
		case "none":
			return undefined;
	}
}

function renderRows(art: MermaidArt, colors: ThemeColors): string[] {
	return art.styled.map((row) => lineToAnsi(textLine(row.map((part) => {
		const color = colorFor(part.cls, colors);
		return color
			? span(part.text, { fg: color, bold: part.cls === "title" })
			: span(part.text);
	}))));
}
