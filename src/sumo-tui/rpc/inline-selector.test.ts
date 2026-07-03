import { describe, expect, it, vi } from "vitest";
import { InlineSelectorComponent, InlineSelectorHost } from "./inline-selector.js";

// pi-tui's `SelectList.handleInput` matches raw terminal byte sequences via
// its own `getKeybindings()` (see select-list.js), not the symbolic `Key.*`
// identifiers `ModalManager.handleInput` accepts loosely -- these are the
// actual legacy VT sequences (`keys.js`'s `LEGACY_KEY_SEQUENCES`/enter/escape
// cases) a real terminal would send.
const ARROW_DOWN = "[B";
const ENTER = "\r";
const ESCAPE = "";

class FakeEditor {
	public text = "";
	public readonly inputs: string[] = [];
	public splashProvider: (() => boolean) | undefined;

	public invalidate(): void {}

	public handleInput(data: string): void {
		this.inputs.push(data);
	}

	public render(width: number): string[] {
		return [`editor:${width}`];
	}

	public getText(): string {
		return this.text;
	}

	public setText(text: string): void {
		this.text = text;
	}

	public paste(text: string): void {
		this.text += text;
	}

	public setSplashProvider(provider: () => boolean): void {
		this.splashProvider = provider;
	}
}

describe("InlineSelectorComponent", () => {
	it("renders a Cathedral-styled title heading above the list rows", () => {
		const component = new InlineSelectorComponent("Choose model", ["a", "b"], () => undefined);
		const rows = component.render(40);
		const stripped = rows.join("\n").replace(/\[[0-9;]*m/g, "");
		expect(stripped).toContain("CHOOSE MODEL");
		expect(stripped).toContain("a");
		expect(stripped).toContain("b");
	});

	it("resolves with the selected option's exact string on Enter", () => {
		const done = vi.fn();
		const component = new InlineSelectorComponent("Pick", ["alpha", "beta"], done);
		component.handleInput(ARROW_DOWN);
		component.handleInput(ENTER);
		expect(done).toHaveBeenCalledWith("beta");
	});

	it("resolves with undefined on Escape (cancel)", () => {
		const done = vi.fn();
		const component = new InlineSelectorComponent("Pick", ["alpha", "beta"], done);
		component.handleInput(ESCAPE);
		expect(done).toHaveBeenCalledWith(undefined);
	});
});

describe("InlineSelectorHost", () => {
	it("passes through render/handleInput to the wrapped editor when no selector is active", () => {
		const editor = new FakeEditor();
		const host = new InlineSelectorHost(editor);

		expect(host.getActiveKind()).toBeUndefined();
		expect(host.render(80)).toEqual(["editor:80"]);

		host.handleInput("x");
		expect(editor.inputs).toEqual(["x"]);
	});

	it("occupies the editor slot while a selector is open: render/handleInput route to the selector, not the editor", async () => {
		const editor = new FakeEditor();
		const onChange = vi.fn();
		const host = new InlineSelectorHost(editor, onChange);

		const resultPromise = host.select("Choose model", ["openai/gpt-5", "anthropic/opus"]);
		expect(host.getActiveKind()).toBe("select");
		expect(host.isActive()).toBe(true);

		const rendered = host.render(80).join("\n");
		const stripped = rendered.replace(/\[[0-9;]*m/g, "");
		expect(stripped).toContain("CHOOSE MODEL");
		expect(stripped).toContain("openai/gpt-5");
		expect(rendered).not.toContain("editor:80");

		host.handleInput("x");
		expect(editor.inputs).toEqual([]); // routed to the selector, not the editor

		host.handleInput(ENTER);
		await expect(resultPromise).resolves.toBe("openai/gpt-5");

		// Selector closed: editor slot restored.
		expect(host.getActiveKind()).toBeUndefined();
		expect(host.render(80)).toEqual(["editor:80"]);
	});

	it("Esc closes the selector and restores the editor with an undefined result", async () => {
		const editor = new FakeEditor();
		const host = new InlineSelectorHost(editor);

		const resultPromise = host.select("Pick", ["a", "b"]);
		host.handleInput(ESCAPE);

		await expect(resultPromise).resolves.toBeUndefined();
		expect(host.getActiveKind()).toBeUndefined();
		expect(host.render(80)).toEqual(["editor:80"]);
	});

	it("close() dismisses the active selector externally (e.g. interrupt-tier Ctrl-C) with an undefined result", async () => {
		const editor = new FakeEditor();
		const host = new InlineSelectorHost(editor);

		const resultPromise = host.select("Pick", ["a", "b"]);
		host.close();

		await expect(resultPromise).resolves.toBeUndefined();
		expect(host.getActiveKind()).toBeUndefined();
	});

	it("queues a second select() while one is active; it activates only after the first resolves", async () => {
		const editor = new FakeEditor();
		const host = new InlineSelectorHost(editor);

		const first = host.select("First", ["a", "b"]);
		const second = host.select("Second", ["c", "d"]);

		expect(host.render(80).join("\n").replace(/\[[0-9;]*m/g, "")).toContain("FIRST");
		host.handleInput(ENTER);
		await expect(first).resolves.toBe("a");

		expect(host.render(80).join("\n").replace(/\[[0-9;]*m/g, "")).toContain("SECOND");
		host.handleInput(ENTER);
		await expect(second).resolves.toBe("c");

		expect(host.getActiveKind()).toBeUndefined();
	});

	it("forwards getText/setText/paste/setSplashProvider to the wrapped editor regardless of selector state", () => {
		const editor = new FakeEditor();
		const host = new InlineSelectorHost(editor);

		host.setText("hello");
		expect(host.getText()).toBe("hello");
		host.paste(" world");
		expect(editor.text).toBe("hello world");

		const provider = () => true;
		host.setSplashProvider(provider);
		expect(editor.splashProvider).toBe(provider);

		void host.select("Pick", ["a"]);
		host.setText("still works while selector open");
		expect(editor.getText()).toBe("still works while selector open");
	});

	it("calls onChange when a selector opens, on input, and on close", async () => {
		const editor = new FakeEditor();
		const onChange = vi.fn();
		const host = new InlineSelectorHost(editor, onChange);

		const resultPromise = host.select("Pick", ["a", "b"]);
		expect(onChange).toHaveBeenCalled();
		onChange.mockClear();

		host.handleInput(ARROW_DOWN);
		expect(onChange).toHaveBeenCalled();
		onChange.mockClear();

		host.handleInput(ENTER);
		await resultPromise;
		expect(onChange).toHaveBeenCalled();
	});
});
