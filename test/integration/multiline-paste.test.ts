import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Editor, type EditorTheme, type TUI } from "@mariozechner/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnPiPty, type SpawnedPiPty } from "./spawn-pi-pty.js";

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;
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

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "").replaceAll("\r", "");
}

function fakeTui(): TUI {
	return {
		requestRender: vi.fn(),
		terminal: { columns: 80, rows: 24, setTitle: vi.fn() },
	} as unknown as TUI;
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

	it("enables bracketed paste in the real SumoCode runtime and does not submit pasted newlines", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-pi-agent-"));
		app = spawnPiPty({
			cols: 80,
			rows: 30,
			env: {
				PI_CODING_AGENT_DIR: agentDir,
				SUMO_TUI: "1",
				SUMO_TUI_HIDE_PI_NOISE: "1",
				SUMO_TUI_MODULE: pathToFileURL(join(process.cwd(), "sumo-interactive-mode.js")).href,
			},
		});

		await app.waitForOutput(BRACKETED_PASTE_ENABLE, 10_000);
		await app.waitForOutput("DIVINE INVOCATION", 10_000);

		app.sendInput('\x1b[200~echo "a\nb\nc"\x1b[201~');
		await app.waitForOutput("c\"", 5_000);

		const output = app.getOutput();
		const plain = stripAnsi(output);
		expect(output).toContain(BRACKETED_PASTE_ENABLE);
		expect(plain).toContain('echo "a');
		expect(plain).toContain("b");
		expect(plain).toContain('c"');
		expect(plain).not.toContain("Error:");
		expect(output).not.toContain("\x1b[200~");
		expect(output).not.toContain("\x1b[201~");
	}, 20_000);
});
