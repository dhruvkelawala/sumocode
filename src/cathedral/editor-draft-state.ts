export interface ActiveEditorDraftController {
	hasDraft(): boolean;
	clearDraft(): void;
}

// Forward-looking accessor: exposed for editor-draft-state.test.ts and future attachment UI.
export interface EditorImageAttachment {
	readonly token: string;
	readonly path: string;
}

const IMAGE_PATH_PATTERN = /(?:^|\/)pi-clipboard-[\w-]+\.(?:png|jpe?g|gif|webp)$/i;

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
			expanded = expanded.split(token).join(path);
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
