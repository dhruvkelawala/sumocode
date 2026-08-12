export const FAST_MODE_STATUS_KEY = "sumocode.fast-mode";
export const FAST_MODE_STATUS_TEXT = "fast";

export function hasActiveFastModeStatus(statuses: ReadonlyMap<string, string | undefined> | undefined): boolean {
	return statuses?.get(FAST_MODE_STATUS_KEY) === FAST_MODE_STATUS_TEXT;
}
