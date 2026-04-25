import { describe, expect, it, vi } from "vitest";
import { runPersonaCommand } from "./persona.js";

describe("runPersonaCommand", () => {
	it("returns an error and does not open the editor when the persona file is missing", () => {
		const runEditor = vi.fn();

		const result = runPersonaCommand({
			personaPath: "/missing/APPEND_SYSTEM.md",
			isTTY: true,
			editor: "vi",
			fileExists: () => false,
			runEditor,
		});

		expect(result.kind).toBe("error");
		expect(result.opened).toBe(false);
		expect(result.message).toContain("/missing/APPEND_SYSTEM.md");
		expect(runEditor).not.toHaveBeenCalled();
	});

	it("in non-TTY context, prints the persona path and does not open the editor", () => {
		const runEditor = vi.fn();

		const result = runPersonaCommand({
			personaPath: "/Users/me/.pi/agent/APPEND_SYSTEM.md",
			isTTY: false,
			editor: "vi",
			fileExists: () => true,
			runEditor,
		});

		expect(result.kind).toBe("instructions");
		expect(result.opened).toBe(false);
		expect(result.message).toContain("/Users/me/.pi/agent/APPEND_SYSTEM.md");
		expect(runEditor).not.toHaveBeenCalled();
	});

	it("opens the editor and confirms the update when the editor exits cleanly", () => {
		const runEditor = vi.fn().mockReturnValue({ status: 0 });

		const result = runPersonaCommand({
			personaPath: "/Users/me/.pi/agent/APPEND_SYSTEM.md",
			isTTY: true,
			editor: "nvim",
			fileExists: () => true,
			runEditor,
		});

		expect(result.kind).toBe("success");
		expect(result.opened).toBe(true);
		expect(result.message).toBe("persona updated — reload Pi to apply");
		expect(runEditor).toHaveBeenCalledWith("nvim", "/Users/me/.pi/agent/APPEND_SYSTEM.md");
	});

	it("reports a clear error when the editor exits non-zero", () => {
		const runEditor = vi.fn().mockReturnValue({ status: 130 });

		const result = runPersonaCommand({
			personaPath: "/Users/me/.pi/agent/APPEND_SYSTEM.md",
			isTTY: true,
			editor: "vi",
			fileExists: () => true,
			runEditor,
		});

		expect(result.kind).toBe("error");
		expect(result.opened).toBe(true);
		expect(result.message).toContain("vi");
		expect(result.message).toContain("130");
	});

	it("reports a clear error when the editor cannot be launched", () => {
		const runEditor = vi.fn().mockReturnValue({ status: 1, error: "ENOENT" });

		const result = runPersonaCommand({
			personaPath: "/Users/me/.pi/agent/APPEND_SYSTEM.md",
			isTTY: true,
			editor: "missing-editor",
			fileExists: () => true,
			runEditor,
		});

		expect(result.kind).toBe("error");
		expect(result.message).toContain("missing-editor");
		expect(result.message).toContain("ENOENT");
	});
});
