export interface ActiveEditorDraftController {
	hasDraft(): boolean;
	clearDraft(): void;
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
