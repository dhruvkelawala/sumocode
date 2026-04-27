export type MouseEventType = "down" | "up" | "drag" | "scroll" | "move";
export type MouseScrollDirection = "up" | "down";

export interface MouseModifiers {
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
}

export interface MouseEvent {
	type: MouseEventType;
	button?: number;
	scrollDir?: MouseScrollDirection;
	row: number;
	col: number;
	modifiers: MouseModifiers;
}

export interface ParsedMouseStream {
	events: MouseEvent[];
	rest: string;
}

const ESCAPE = "\x1b";
const SGR_MOUSE_SEQUENCE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
const COMPLETE_SGR_MOUSE_SEQUENCE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

function parseButton(code: number): number | undefined {
	const button = code & 3;
	return button === 3 ? undefined : button;
}

function parseModifiers(code: number): MouseModifiers {
	return {
		shift: (code & 4) !== 0,
		alt: (code & 8) !== 0,
		ctrl: (code & 16) !== 0,
	};
}

/**
 * Parse one xterm SGR mouse sequence into a zero-based terminal event.
 *
 * Source: the SGR bit layout follows opentui-island's parser
 * (`docs/spike-research/opentui-island/src/core/terminal-mouse.ts:28-87`):
 * bits 2/3/4 are Shift/Alt/Ctrl, bit 5 is motion, and bit 6 marks wheel
 * events. Sumo-tui keeps the same zero-based col/row convention for direct
 * CellBuffer hit-testing.
 */
export function parseSgrMouseEvent(input: string): MouseEvent | undefined {
	const match = input.match(SGR_MOUSE_SEQUENCE_PATTERN);
	if (!match) return undefined;

	const code = Number.parseInt(match[1] ?? "", 10);
	const col = Number.parseInt(match[2] ?? "", 10) - 1;
	const row = Number.parseInt(match[3] ?? "", 10) - 1;
	const suffix = match[4];
	if (!Number.isFinite(code) || !Number.isFinite(col) || !Number.isFinite(row) || col < 0 || row < 0) return undefined;

	const modifiers = parseModifiers(code);

	if ((code & 64) !== 0) {
		const directionCode = code & 3;
		// SGR mouse buttons 64/65 = vertical wheel up/down, 66/67 = horizontal
		// wheel left/right (Mac trackpad two-finger swipe with any horizontal
		// component emits these). Map left/right to undefined scrollDir so the
		// chat scrollbox ignores them, but still report them as scroll events
		// so the bridge classifies the bytes as consumed mouse input.
		const scrollDir: MouseScrollDirection | undefined =
			directionCode === 0 ? "up" : directionCode === 1 ? "down" : undefined;
		return {
			type: "scroll",
			button: 64 + directionCode,
			scrollDir,
			row,
			col,
			modifiers,
		};
	}

	if ((code & 32) !== 0) {
		const button = parseButton(code);
		return {
			type: button === undefined ? "move" : "drag",
			button,
			row,
			col,
			modifiers,
		};
	}

	return {
		type: suffix === "M" ? "down" : "up",
		button: parseButton(code),
		row,
		col,
		modifiers,
	};
}

/** Consume complete SGR mouse sequences from an arbitrary terminal input chunk. */
export function parseSgrMouseStream(input: string): ParsedMouseStream {
	const events: MouseEvent[] = [];
	let index = 0;

	while (index < input.length) {
		const start = input.indexOf(`${ESCAPE}[<`, index);
		if (start === -1) return { events, rest: "" };

		const candidate = input.slice(start);
		const match = candidate.match(COMPLETE_SGR_MOUSE_SEQUENCE_PATTERN);
		if (!match) return { events, rest: candidate };

		const sequence = match[0];
		const event = parseSgrMouseEvent(sequence);
		if (event) events.push(event);
		index = start + sequence.length;
	}

	return { events, rest: "" };
}
