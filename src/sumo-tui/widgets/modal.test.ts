import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalManager } from "./modal.js";

const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|_[^\u0007]*(?:\u0007|\u001b\\))/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

afterEach(() => {
	vi.useRealTimers();
});

describe("ModalManager", () => {
	it("queues concurrent selects and resolves them FIFO", async () => {
		const modals = new ModalManager();
		const first = modals.select("First", ["alpha", "beta"]);
		const second = modals.select("Second", ["gamma", "delta"]);

		expect(stripAnsi(modals.render(80).join("\n"))).toContain("First");
		modals.handleInput("down");
		modals.handleInput("enter");
		await expect(first).resolves.toBe("beta");

		expect(stripAnsi(modals.render(80).join("\n"))).toContain("Second");
		modals.handleInput("enter");
		await expect(second).resolves.toBe("gamma");
		expect(modals.getActiveKind()).toBeUndefined();
	});

	it("keeps a dismissed modal timer from dismissing the next active modal", async () => {
		vi.useFakeTimers();
		const modals = new ModalManager();
		const first = modals.select("First", ["alpha"], { timeout: 50 });
		const second = modals.select("Second", ["beta"], { timeout: 500 });

		await vi.advanceTimersByTimeAsync(50);

		await expect(first).resolves.toBeUndefined();
		expect(stripAnsi(modals.render(80).join("\n"))).toContain("Second");
		modals.handleInput("enter");
		await expect(second).resolves.toBe("beta");
	});

	it("lets a queued modal timeout dismiss only itself", async () => {
		vi.useFakeTimers();
		const modals = new ModalManager();
		const first = modals.select("First", ["alpha"]);
		const second = modals.select("Second", ["beta"], { timeout: 50 });

		await vi.advanceTimersByTimeAsync(50);

		await expect(second).resolves.toBeUndefined();
		expect(stripAnsi(modals.render(80).join("\n"))).toContain("First");
		modals.handleInput("enter");
		await expect(first).resolves.toBe("alpha");
	});

	it("wraps multi-line approval titles so every line is visible", () => {
		const modals = new ModalManager();
		void modals.select("APPROVAL REQUIRED\n\nrm -rf node_modules\n\nThis will permanently delete files.", ["No"]);

		const plain = stripAnsi(modals.render(80).join("\n"));

		expect(plain).toContain("APPROVAL REQUIRED");
		expect(plain).toContain("rm -rf node_modules");
		expect(plain).toContain("This will permanently delete files.");
	});

	it("strips ANSI and control sequences from painted dialog text", () => {
		const modals = new ModalManager();
		void modals.select("\u001b[31mTitle\u001b[0m\u0007", ["\u001b]2;spoof\u0007Option"]);

		const rendered = modals.render(80).join("\n");

		expect(rendered).not.toContain("\u001b");
		expect(rendered).not.toContain("\u0007");
		expect(rendered).toContain("Title");
		expect(rendered).toContain("Option");
	});

	it("displays sanitized select labels but resolves the original raw option value", async () => {
		const modals = new ModalManager();
		const rawOption = "\u001b[31mStyled\tChoice\u001b[0m\nextra\u0007";
		const result = modals.select("Pick", [rawOption]);

		const renderedLines = modals.render(80);
		const rendered = renderedLines.join("\n");
		const optionRows = renderedLines.filter((line) => line.includes("Styled") || line.includes("extra"));

		expect(optionRows).toHaveLength(1);
		expect(optionRows[0]).toContain("Styled Choice extra");
		expect(rendered).not.toContain("\u001b[31m");
		expect(rendered).not.toContain("\u0007");
		expect(renderedLines.every((line) => !line.includes("\n") && !line.includes("\r"))).toBe(true);

		modals.handleInput("enter");
		await expect(result).resolves.toBe(rawOption);
	});

	it("renders input placeholder newlines and control bytes as a single sanitized row", () => {
		const modals = new ModalManager();
		void modals.input("Path", "Line one\n\u001b[31mline two\u001b[0m\u0001");

		const renderedLines = modals.render(80);
		const rendered = renderedLines.join("\n");
		const placeholderRows = renderedLines.filter((line) => line.includes("Line one") || line.includes("line two"));

		expect(placeholderRows).toHaveLength(1);
		expect(placeholderRows[0]).toContain("> Line one line two");
		expect(rendered).not.toContain("\u001b[31m");
		expect(rendered).not.toContain("\u0001");
		expect(renderedLines.every((line) => !line.includes("\n") && !line.includes("\r"))).toBe(true);
	});

	it("accepts multi-character pasted text in input modals", async () => {
		const modals = new ModalManager();
		const result = modals.input("Path");

		modals.handleInput("\u001b[200~/Volumes/SumoDeus NVMe/code/sumocode\u001b[201~");
		modals.handleInput("enter");

		await expect(result).resolves.toBe("/Volumes/SumoDeus NVMe/code/sumocode");
	});
});
