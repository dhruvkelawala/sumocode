import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Editor, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnPiPty, spawnSumocodePty, waitForScreenText, type SpawnedPiPty } from "./spawn-pi-pty.js";
import { stripAnsi } from "../../src/sumo-tui/cathedral/ansi.js";

const BRACKETED_PASTE_ENABLE = "\x1b[?2004h";

const editorTheme: EditorTheme = {
	borderColor: (text) => text,
	selectList: {
		selectedPrefix: (text) => text,
		selectedText: (text) => text,
		description: (text) => text,
		scrollInfo: (text) => text,
		noMatch: (text) => text,
	},
};

let app: SpawnedPiPty | undefined;

afterEach(async () => {
	await app?.cleanupAndWait();
	app = undefined;
});

function fakeTui(): TUI {
	// SAFETY: fake supplies the requestRender/terminal surface Editor reads.
	return {
		requestRender: vi.fn(),
		terminal: { columns: 80, rows: 24, setTitle: vi.fn() },
	} as never;
}

describe("multiline paste and newline handling", () => {
	it("preserves bracketed paste newlines, uses Shift+Enter for newline, and plain Enter submits", () => {
		const editor = new Editor(fakeTui(), editorTheme);
		let submitted: string | undefined;
		editor.onSubmit = (text) => {
			submitted = text;
		};

		editor.handleInput('\x1b[200~echo "a\nb\nc"\x1b[201~');

		expect(editor.getText()).toBe('echo "a\nb\nc"');
		expect(submitted).toBeUndefined();

		editor.handleInput("\x1b[13;2u");
		editor.handleInput("tail");

		expect(editor.getText()).toBe('echo "a\nb\nc"\ntail');
		expect(submitted).toBeUndefined();

		editor.handleInput("\r");

		expect(submitted).toBe('echo "a\nb\nc"\ntail');
		expect(editor.getText()).toBe("");
	});

	it("keeps raw CR multiline paste chunks as one draft instead of submitting each line", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-pi-agent-"));
		app = spawnPiPty({ cols: 80, rows: 30, env: { PI_CODING_AGENT_DIR: agentDir } });

		await app.waitForOutput(BRACKETED_PASTE_ENABLE, 10_000);
		await waitForScreenText(app, "DIVINE INVOCATION", 10_000);

		app.sendInput("line one\rline two\rline three");
		const screen = await waitForScreenText(app, "line three", 5_000);

		expect(screen.text).toContain("line one");
		expect(screen.text).toContain("line two");
		expect(screen.text).toContain("line three");
		// A submission or failure must be absent from the whole emitted byte
		// history, not just the settled frame, and the control sequences have to be
		// removed first: a repaint can split the literal across frames.
		expect(stripAnsi(app.getOutput())).not.toContain("Working...");
		expect(stripAnsi(app.getOutput())).not.toContain("Error:");
	}, 20_000);

	it("enables bracketed paste in the RPC SumoCode runtime and does not submit pasted newlines", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-pi-agent-"));
		app = spawnSumocodePty({
			cols: 80,
			rows: 30,
			env: {
				PI_CODING_AGENT_DIR: agentDir,
			},
		});

		await app.waitForOutput(BRACKETED_PASTE_ENABLE, 10_000);
		await waitForScreenText(app, "DIVINE INVOCATION", 10_000);

		app.sendInput('\x1b[200~echo "a\nb\nc"\x1b[201~');
		const screen = await waitForScreenText(app, 'c"', 5_000);

		const output = app.getOutput();
		expect(output).toContain(BRACKETED_PASTE_ENABLE);
		expect(screen.text).toContain('echo "a');
		expect(screen.text).toContain("b");
		expect(screen.text).toContain('c"');
		expect(stripAnsi(output)).not.toContain("Error:");
		expect(output).not.toContain("\x1b[200~");
		expect(output).not.toContain("\x1b[201~");
	}, 20_000);
});
