import type { ChatMessage } from "../widgets/chat-message.js";
import type { ChatPager } from "../widgets/chat-pager.js";
import { logDiagnostic } from "../runtime/diagnostics.js";

/**
 * Subset of Pi's `BashExecutionComponent` we depend on. Detected structurally
 * so we never import Pi's private component module.
 *
 * Pi source for reference:
 * `node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/components/bash-execution.js`
 */
export interface BashExecutionLike {
	render(width: number): string[];
	invalidate?(): void;
	getCommand(): string;
	getOutput(): string;
	appendOutput(chunk: string): void;
	setComplete(exitCode?: number, cancelled?: boolean, truncationResult?: unknown, fullOutputPath?: string): void;
}

interface BashCompletionState {
	readonly exitCode: number | undefined;
	readonly cancelled: boolean;
	readonly truncationResult: unknown;
	readonly fullOutputPath: string | undefined;
}

interface BashMirrorEntry {
	readonly message: ChatMessage;
	readonly originalAppendOutput: (chunk: string) => void;
	readonly originalSetComplete: BashExecutionLike["setComplete"];
	completion: BashCompletionState | undefined;
	disposed: boolean;
}

export interface BashMirrorScheduler {
	requestRender(): void;
	markRenderDirty?(): void;
}

/**
 * Detect Pi's `BashExecutionComponent` by shape. The component is
 * `Container`-based so it has `render(width)` + `invalidate()`, plus the
 * bash-specific public methods: `getCommand`, `getOutput`, `appendOutput`,
 * `setComplete`.
 */
export function isBashExecutionLike(value: unknown): value is BashExecutionLike {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.render === "function" &&
		typeof record.getCommand === "function" &&
		typeof record.getOutput === "function" &&
		typeof record.appendOutput === "function" &&
		typeof record.setComplete === "function"
	);
}

/**
 * Render a stable text representation of a bash component for the retained
 * `ChatPager`. Pi's component has its own block/border rendering, but we want a
 * plain-text mirror that fits the existing chat-message body.
 */
export function renderBashMirrorText(component: BashExecutionLike, completion: BashCompletionState | undefined): string {
	const command = component.getCommand();
	const output = component.getOutput().replace(/\s+$/u, "");
	const lines: string[] = [`$ ${command}`];
	if (output.length > 0) {
		lines.push("");
		lines.push(output);
	}
	if (!completion) {
		lines.push("");
		lines.push("running…");
	} else if (completion.cancelled) {
		lines.push("");
		lines.push("cancelled");
	} else if (typeof completion.exitCode === "number" && completion.exitCode !== 0) {
		lines.push("");
		lines.push(`exit ${completion.exitCode}`);
	}
	if (completion?.fullOutputPath) {
		lines.push("");
		lines.push(`output truncated → ${completion.fullOutputPath}`);
	}
	return lines.join("\n");
}

/**
 * Mirrors Pi `BashExecutionComponent` instances into SumoCode's retained
 * `ChatPager`. Pi adds the component directly to its `chatContainer` from
 * `handleBashCommand`; in owned-shell mode that container's render is
 * short-circuited, so without mirroring `!`/`!!` output is invisible (#207).
 *
 * The mirror keeps Pi's component live (so Pi's session recording, truncation,
 * cancellation still work) and updates a chat message in retained chat each
 * time `appendOutput` or `setComplete` runs.
 */
export class BashExecutionMirror {
	private readonly entries = new WeakMap<BashExecutionLike, BashMirrorEntry>();

	public constructor(
		private readonly chat: ChatPager,
		private readonly scheduler: BashMirrorScheduler,
	) {}

	public attach(component: unknown): boolean {
		if (!isBashExecutionLike(component)) return false;
		if (this.entries.has(component)) return false;

		const message = this.chat.addMessage("bash", renderBashMirrorText(component, undefined));
		const entry: BashMirrorEntry = {
			message,
			originalAppendOutput: component.appendOutput.bind(component),
			originalSetComplete: component.setComplete.bind(component),
			completion: undefined,
			disposed: false,
		};
		this.entries.set(component, entry);

		component.appendOutput = (chunk: string): void => {
			entry.originalAppendOutput(chunk);
			if (entry.disposed) return;
			this.refresh(component, entry);
		};
		component.setComplete = (exitCode?: number, cancelled?: boolean, truncationResult?: unknown, fullOutputPath?: string): void => {
			entry.originalSetComplete(exitCode, cancelled, truncationResult, fullOutputPath);
			if (entry.disposed) return;
			entry.completion = {
				exitCode,
				cancelled: cancelled === true,
				truncationResult,
				fullOutputPath,
			};
			this.refresh(component, entry);
		};

		logDiagnostic("foreign_bash_component_attached", { command: component.getCommand() });
		this.scheduler.markRenderDirty?.();
		this.scheduler.requestRender();
		return true;
	}

	public has(component: unknown): boolean {
		return isBashExecutionLike(component) && this.entries.has(component);
	}

	private refresh(component: BashExecutionLike, entry: BashMirrorEntry): void {
		entry.message.setText(renderBashMirrorText(component, entry.completion));
		this.scheduler.markRenderDirty?.();
		this.scheduler.requestRender();
	}
}
