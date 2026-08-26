import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { renderDivineQuery } from "../../divine-query.js";
import { fg as scriptoriumFg } from "../../cathedral/scriptorium-chrome.js";
import { SumoNode } from "../layout/node.js";
import type { YogaNode } from "../layout/yoga.js";
import type { CellBuffer, Rect } from "../render/buffer.js";
import { activeThemeChrome, activeThemeColors } from "../../themes/index.js";
import { ModalManager, type ModalManagerOptions } from "./modal.js";
import { cathedralBackdropCell } from "../cathedral/theme-bridge.js";

export interface TerminalSizeProvider {
	columns: number;
	rows: number;
}

export interface ModalLayerOptions extends ModalManagerOptions {
	readonly getTerminalSize?: () => TerminalSizeProvider;
}

const RESET = "\u001b[0m";
const OSC8_CLOSE = "\u001b]8;;\u001b\\";

function linkedHttpUrl(text: string, color: string): string {
	if (!/^https?:\/\/[^\s]+$/u.test(text)) return scriptoriumFg(text, color);
	// OSC 8 is the terminal-native hyperlink protocol. Keeping it here, next to
	// ModalSurfaceComponent's low-level terminal chrome, gives a short label one
	// complete clickable target without teaching generic text spans about links.
	return `\u001b]8;;${text}\u001b\\${scriptoriumFg("open authentication page", color)}${OSC8_CLOSE}`;
}

function rgb(hex: string) {
	const normalized = hex.replace("#", "");
	return {
		r: Number.parseInt(normalized.slice(0, 2), 16),
		g: Number.parseInt(normalized.slice(2, 4), 16),
		b: Number.parseInt(normalized.slice(4, 6), 16),
	};
}

function fg(hex: string): string {
	const { r, g, b } = rgb(hex);
	return `\u001b[38;2;${r};${g};${b}m`;
}

function bg(hex: string): string {
	const { r, g, b } = rgb(hex);
	return `\u001b[48;2;${r};${g};${b}m`;
}

function padVisible(text: string, width: number): string {
	const clipped = visibleWidth(text) > width ? truncateToWidth(text, width, "") : text;
	const pad = Math.max(0, width - visibleWidth(clipped));
	return `${clipped}${" ".repeat(pad)}`;
}

export class ModalSurfaceComponent implements Component {
	public constructor(private readonly inner: Component & { dispose?(): void }) {}
	public invalidate(): void {
		this.inner.invalidate?.();
	}
	public handleInput(data: string): void {
		this.inner.handleInput?.(data);
	}
	public dispose(): void {
		this.inner.dispose?.();
	}
	public isVisible(width: number): boolean {
		return this.inner.render(Math.max(1, width - 2)).length > 0;
	}
	public render(width: number): string[] {
		const outerWidth = Math.max(12, width);
		const innerWidth = Math.max(1, outerWidth - 2);
		const border = fg(activeThemeColors().divider);
		const surface = bg(activeThemeColors().surfaceLifted);
		const childRows = this.inner.render(innerWidth);
		if (childRows.length === 0) return [];
		const lines: string[] = [];
		const chrome = activeThemeChrome();
		lines.push(`${surface}${border}${chrome.frame.topLeft}${chrome.frame.horizontal.repeat(innerWidth)}${chrome.frame.topRight}${RESET}`);
		for (const row of childRows) {
			lines.push(`${surface}${border}${chrome.frame.vertical}${RESET}${surface}${padVisible(row, innerWidth)}${border}${chrome.frame.vertical}${RESET}`);
		}
		lines.push(`${surface}${border}${chrome.frame.bottomLeft}${chrome.frame.horizontal.repeat(innerWidth)}${chrome.frame.bottomRight}${RESET}`);
		return lines;
	}
}

export class ModalBackdropNode extends SumoNode {
	public constructor(yogaNode: YogaNode, parent: SumoNode | undefined, private readonly isVisible: () => boolean = () => true) {
		super(yogaNode, parent);
	}
	public render(buffer: CellBuffer, rect: Rect): void {
		if (!this.isVisible()) return;
		buffer.paint(rect, cathedralBackdropCell());
	}
}

/**
 * Modal manager component rendered as a bordered card. The card is the ONLY
 * thing returned — positioning is the overlay renderer's job (the RPC host
 * registers this with `anchor: "center"`), and the UI behind it stays
 * visible. The previous full-frame `surfaceRecess` fill blacked out the
 * whole terminal behind the card.
 */
export class ModalLayer extends ModalManager {
	private readonly getTerminalSize: () => TerminalSizeProvider;

	public constructor(options: ModalLayerOptions = {}) {
		super(options);
		this.getTerminalSize = options.getTerminalSize ?? (() => ({ columns: 80, rows: 24 }));
	}

	public override render(width: number): string[] {
		if (!this.getActiveKind()) return [];
		const frameWidth = Math.max(1, width || this.getTerminalSize().columns);
		const modalWidth = Math.min(80, frameWidth);

		// Bible parity (docs/ui/bible scene-divine-query-overlay): the RPC
		// child's question tool and slash flows arrive here as generic
		// select/confirm/input requests — render them in the same Divine Query
		// language the owned shell used, not a bare debug card.
		const dialog = this.getActiveDialogSnapshot();
		if (dialog?.kind === "select" && dialog.options) {
			return renderDivineQuery(
				{ title: dialog.title, options: dialog.options, focusedIndex: dialog.selectedIndex },
				modalWidth,
			);
		}
		if (dialog?.kind === "confirm") {
			const title = dialog.message ? `${dialog.title}\n\n${dialog.message}` : dialog.title;
			return renderDivineQuery(
				{ title, options: ["Yes", "No"], focusedIndex: dialog.selectedIndex },
				modalWidth,
			);
		}
		if (dialog?.kind === "input") {
			const colors = activeThemeColors();
			const inputWidth = Math.max(1, modalWidth - 6); // 5-col Cathedral indent + 1-col right margin
			const shown = dialog.value
				? scriptoriumFg(`> ${dialog.value}█`, colors.foreground)
				: `${scriptoriumFg("> █", colors.foreground)}${scriptoriumFg(dialog.placeholder ?? "", colors.foregroundDim)}`;
			const detailRows = (dialog.details ?? []).flatMap((detail) =>
				detail.split("\n").flatMap((paragraph) =>
					wrapTextWithAnsi(linkedHttpUrl(paragraph, colors.foregroundDim), inputWidth).map((row) => `     ${row}`),
				),
			);
			const inputRows = wrapTextWithAnsi(shown, inputWidth).map((row) => `     ${row}`);
			return renderDivineQuery(
				{ title: dialog.title, options: [], focusedIndex: 0 },
				modalWidth,
				{
					compact: true,
					extras: [
						...detailRows,
						...(detailRows.length > 0 ? [""] : []),
						...inputRows,
						...(dialog.copyAvailable ? [`     ${scriptoriumFg("ctrl+y copy link · ctrl+click open", colors.foregroundDim)}`] : []),
						`     ${scriptoriumFg("⏎ submit · ⎋ retreat", colors.foregroundDim)}`,
					],
				},
			);
		}

		// Editor kind (rare) keeps the generic bordered card. Clamp: the
		// overlay host probes visibility with render(1); the inner content
		// width must stay ≥ 1 or the probe sees zero rows and hides the modal.
		const surface = new ModalSurfaceComponent({
			invalidate: () => undefined,
			handleInput: (data: string) => this.handleInput(data),
			render: () => super.render(Math.max(1, modalWidth - 2)),
		});
		return surface.render(modalWidth);
	}
}
