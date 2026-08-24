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

interface SequenceMessage {
	readonly source: string;
	readonly from: string;
	readonly to: string;
}

interface SimpleSequence {
	readonly declarations: ReadonlyMap<string, string>;
	readonly participantOrder: readonly string[];
	readonly messages: readonly SequenceMessage[];
}

const SEQUENCE_OPERATORS = ["-->>", "->>", "--x", "-x", "--)", "-)", "-->", "->"] as const;
const SEQUENCE_ID = /^[\p{L}\p{N}_.$-]+$/u;

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
		// Prefer narrow-and-tall alternatives because the transcript already
		// scrolls vertically but deliberately has no hidden horizontal viewport.
		const rotated = renderTopDownRetry(source, width);
		if (rotated) return rotated;
		const sequenceBands = renderSequenceBandsRetry(source, width);
		if (sequenceBands) return sequenceBands;
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

function renderSequenceBandsRetry(source: string, width: number): MermaidRenderOutcome | undefined {
	if (diagramKind(source) !== "sequence") return undefined;
	const sequence = parseSimpleSequence(source);
	if (!sequence || sequence.messages.length === 0) return undefined;

	const bands: MermaidArt[] = [];
	let currentMessages: SequenceMessage[] = [];
	let currentArt: MermaidArt | undefined;
	for (const message of sequence.messages) {
		const candidateMessages = [...currentMessages, message];
		const candidateArt = renderSequenceBand(sequence, candidateMessages);
		if (candidateArt && candidateArt.width <= width) {
			currentMessages = candidateMessages;
			currentArt = candidateArt;
			continue;
		}
		if (!currentArt) return undefined;
		bands.push(currentArt);
		currentMessages = [message];
		currentArt = renderSequenceBand(sequence, currentMessages) ?? undefined;
		if (!currentArt || currentArt.width > width) return undefined;
	}
	if (currentArt) bands.push(currentArt);

	const rowCount = bands.reduce((count, band) => count + band.styled.length, Math.max(0, bands.length - 1));
	if (rowCount > MAX_VISIBLE_ROWS) return undefined;
	const colors = activeThemeColors();
	return {
		kind: "rendered",
		rows: bands.flatMap((band, index) => [
			...(index === 0 ? [] : [""]),
			...renderRows(band, colors),
		]),
		warnings: [...new Set(bands.flatMap((band) => band.warnings))],
	};
}

/**
 * Parse the conservative sequence subset that can be split without changing
 * meaning. Structured blocks, notes, activation, and autonumber keep the
 * normal source fallback rather than risk a misleading diagram.
 */
function parseSimpleSequence(source: string): SimpleSequence | undefined {
	const declarations = new Map<string, string>();
	const participantOrder: string[] = [];
	const explicitParticipants = new Set<string>();
	const messages: SequenceMessage[] = [];
	let sawHeader = false;

	const rememberParticipant = (id: string, declaration = `participant ${id}`): void => {
		if (!declarations.has(id)) participantOrder.push(id);
		declarations.set(id, declaration);
	};

	for (const rawLine of source.split("\n")) {
		const statement = rawLine.trim();
		if (statement === "" || statement.startsWith("%%")) continue;
		if (!sawHeader) {
			if (!/^sequenceDiagram$/i.test(statement)) return undefined;
			sawHeader = true;
			continue;
		}
		// grok-mermaid splits unquoted semicolons into separate statements.
		// This conservative parser works line-by-line, so decline banding rather
		// than risk losing participant aliases or grouping multiple messages as one.
		if (statement.includes(";")) return undefined;

		const declaration = /^(?:participant|actor)\s+(\S+)(?:\s+as\s+.+)?$/i.exec(statement);
		if (declaration) {
			const id = declaration[1]!;
			if (!SEQUENCE_ID.test(id)) return undefined;
			rememberParticipant(id, statement);
			explicitParticipants.add(id);
			continue;
		}

		const participants = sequenceMessageParticipants(statement);
		if (!participants) return undefined;
		const [from, to] = participants;
		rememberParticipant(from, declarations.get(from));
		rememberParticipant(to, declarations.get(to));
		messages.push({ source: statement, from, to });
	}

	const activeParticipants = new Set(messages.flatMap((message) => [message.from, message.to]));
	if ([...explicitParticipants].some((id) => !activeParticipants.has(id))) return undefined;
	return sawHeader ? { declarations, participantOrder, messages } : undefined;
}

function sequenceMessageParticipants(statement: string): readonly [string, string] | undefined {
	for (let position = 1; position < statement.length; position++) {
		for (const operator of SEQUENCE_OPERATORS) {
			if (!statement.startsWith(operator, position)) continue;
			const from = statement.slice(0, position).trim();
			const rest = statement.slice(position + operator.length).trimStart().replace(/^[+-]+/, "");
			const colon = rest.indexOf(":");
			const to = (colon === -1 ? rest : rest.slice(0, colon)).trim();
			// Positions are visited left-to-right and operators longest-first, so
			// `A-->>B` cannot be re-read as participant `A-` using `->>`.
			if (SEQUENCE_ID.test(from) && SEQUENCE_ID.test(to)) return [from, to];
		}
	}
	return undefined;
}

function renderSequenceBand(sequence: SimpleSequence, messages: readonly SequenceMessage[]): MermaidArt | null {
	const participants = new Set(messages.flatMap((message) => [message.from, message.to]));
	const declarations = sequence.participantOrder
		.filter((id) => participants.has(id))
		.map((id) => sequence.declarations.get(id) ?? `participant ${id}`);
	try {
		return render(["sequenceDiagram", ...declarations, ...messages.map((message) => message.source)].join("\n"));
	} catch {
		return null;
	}
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
