import { diagramKind, render, type Cls, type MermaidArt } from "grok-mermaid";
import { activeThemeColors, type ThemeColors } from "../../themes/index.js";
import { lineToAnsi, span, textLine } from "../render/primitives.js";

/**
 * Safety valve, not a design constraint: pathological model output should not
 * be able to flood the transcript with thousands of art rows. Any real diagram
 * fits comfortably under this.
 */
const MAX_VISIBLE_ROWS = 500;

export type MermaidRenderOutcome =
	| { readonly kind: "rendered"; readonly rows: readonly string[]; readonly warnings: readonly string[] }
	| { readonly kind: "fallback"; readonly reason: string };

/** Render Mermaid source as width-safe Cathedral Unicode art. */
export function renderCathedralMermaid(source: string, availableWidth: number): MermaidRenderOutcome {
	const width = Math.max(0, Math.floor(availableWidth));
	if (width === 0) return { kind: "fallback", reason: "no horizontal space available" };
	let art: MermaidArt | null;
	try {
		art = render(source);
	} catch (error) {
		// Mermaid source is model-authored and may be incomplete while streaming.
		// A renderer bug must degrade to the existing code-block presentation.
		return { kind: "fallback", reason: `renderer error: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!art) return { kind: "fallback", reason: fallbackReasonForNullArt(source) };
	if (art.width > width) {
		// A horizontal flowchart lays out as wide as it needs; the same graph
		// drawn top-down is narrow-and-tall, which the transcript can scroll.
		const rotated = renderTopDownRetry(source, width);
		if (rotated) return rotated;
		return { kind: "fallback", reason: `diagram needs ${art.width} columns but only ${width} fit` };
	}
	if (art.styled.length > MAX_VISIBLE_ROWS) {
		return { kind: "fallback", reason: `diagram is ${art.styled.length} rows tall (limit ${MAX_VISIBLE_ROWS})` };
	}
	return { kind: "rendered", rows: renderRows(art, activeThemeColors()), warnings: art.warnings };
}

/** Swap a horizontal flowchart/graph header direction for top-down. */
function sourceAsTopDown(source: string): string | undefined {
	const match = /^([ \t]*(?:flowchart|graph)[ \t]+)(LR|RL|BT)\b/im.exec(source);
	if (!match) return undefined;
	return `${source.slice(0, match.index)}${match[1]}TD${source.slice(match.index + match[0].length)}`;
}

function renderTopDownRetry(source: string, width: number): MermaidRenderOutcome | undefined {
	const rotatedSource = sourceAsTopDown(source);
	if (rotatedSource === undefined) return undefined;
	let art: MermaidArt | null;
	try {
		art = render(rotatedSource);
	} catch {
		return undefined;
	}
	if (!art || art.width > width || art.styled.length > MAX_VISIBLE_ROWS) return undefined;
	return { kind: "rendered", rows: renderRows(art, activeThemeColors()), warnings: art.warnings };
}

function fallbackReasonForNullArt(source: string): string {
	if (source.trim().length === 0) return "empty diagram source";
	// `render` returned null for a recognized diagram header → the body failed
	// to parse (or layout was refused); no header → the type is unsupported.
	return diagramKind(source) ? "syntax error in diagram source" : "unsupported diagram type";
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
