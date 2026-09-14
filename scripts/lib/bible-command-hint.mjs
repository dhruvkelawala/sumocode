// Shared palette-keybind markup for the Bible footer right zone (#559).
//
// The runtime paints the keybind from src/cathedral/input-frame.ts; the
// generators are plain .mjs and cannot import TypeScript, so the markup and its
// visible length live here once instead of once per generator.

const COMMAND_HINT_KEYS = "CTRL+/";
const COMMAND_HINT_LABEL = "COMMANDS";

export const COMMAND_HINT_HTML =
	`<span class="fg-accent">${COMMAND_HINT_KEYS}</span>` +
	`<span class="fg-dim"> \u00b7 ${COMMAND_HINT_LABEL}</span>`;

/** Visible columns of COMMAND_HINT_HTML once its tags are stripped. */
export const COMMAND_HINT_LEN = `${COMMAND_HINT_KEYS} \u00b7 ${COMMAND_HINT_LABEL}`.length;
