export interface ActiveEditorDraftController {
	hasDraft(): boolean;
	clearDraft(): void;
}

// Forward-looking accessor: exposed for editor-draft-state.test.ts and future attachment UI.
export interface EditorImageAttachment {
	readonly token: string;
	readonly path: string;
}

/**
 * Pasted text that should collapse into an `[Image N]` token: pi/SumoCode
 * clipboard temp files (`pi-clipboard-<uuid>.<ext>`, any directory), or any
 * single-line absolute/home/relative-dot path ending in an image extension
 * (e.g. a screenshot dragged into the terminal). Multi-line pastes and paths
 * embedded in sentences never match — the pasted chunk must BE the path.
 */
const IMAGE_PATH_PATTERN = /^(?:(?:\/|~\/|\.\.?\/)[^\n]+|(?:[^\n/]*\/)?pi-clipboard-[\w-]+)\.(?:png|jpe?g|gif|webp)$/i;

export class EditorImageDraftState {
	private nextImageIndex = 1;
	private readonly images = new Map<string, string>();

	addImage(path: string): string {
		const token = `[Image ${this.nextImageIndex}]`;
		this.nextImageIndex += 1;
		this.images.set(token, path);
		return token;
	}

	expandTokensToPaths(text: string): string {
		let expanded = text;
		for (const [token, path] of this.images) {
			// Quote paths containing whitespace so the agent (and any tool it
			// forwards the path to) sees an unambiguous boundary.
			const replacement = /\s/.test(path) ? `"${path}"` : path;
			expanded = expanded.split(token).join(replacement);
		}
		return expanded;
	}

	pruneMissingTokens(text: string): void {
		for (const token of this.images.keys()) {
			if (!text.includes(token)) this.images.delete(token);
		}
	}

	clear(): void {
		this.images.clear();
		this.nextImageIndex = 1;
	}

	list(): EditorImageAttachment[] {
		return [...this.images.entries()].map(([token, path]) => ({ token, path }));
	}
}

export function isLikelyClipboardImagePath(value: string): boolean {
	return IMAGE_PATH_PATTERN.test(value.trim());
}

/**
 * Normalize a pasted/dropped path candidate: strip surrounding quotes (some
 * terminals quote dropped files) and unescape backslash-escaped spaces
 * (macOS terminals escape `Screenshot 2026….png` as `Screenshot\ 2026….png`
 * when a file is dragged or its path pasted). Returns the real on-disk path.
 */
export function normalizePastedImagePath(value: string): string {
	let candidate = value.trim();
	if (
		candidate.length >= 2
		&& ((candidate.startsWith('"') && candidate.endsWith('"')) || (candidate.startsWith("'") && candidate.endsWith("'")))
	) {
		candidate = candidate.slice(1, -1);
	}
	return candidate.replace(/\\ /g, " ");
}

let activeController: ActiveEditorDraftController | undefined;

export function setActiveEditorDraftController(controller: ActiveEditorDraftController | undefined): void {
	activeController = controller;
}

export function activeEditorHasDraft(): boolean {
	return activeController?.hasDraft() ?? false;
}

export function consumeActiveEditorDraftClear(): boolean {
	if (!activeController?.hasDraft()) return false;
	activeController.clearDraft();
	return true;
}
