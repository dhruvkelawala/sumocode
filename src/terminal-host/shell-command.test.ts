import { describe, expect, it } from "vitest";
import { buildShellCommand, shellEscape } from "./shell-command.js";

describe("terminal-host shell commands", () => {
	it("builds commands with a real executable before shell operators", () => {
		const command = buildShellCommand("/repo worktree", "pnpm install && exec sumocode");

		expect(command).toMatch(/^bash -lc /);
		expect(command).toContain("cd '\\''/repo worktree'\\'' && pnpm install && exec sumocode");
	});

	it("escapes literal single quotes", () => {
		expect(shellEscape("it's safe")).toBe("'it'\\''s safe'");
	});
});
