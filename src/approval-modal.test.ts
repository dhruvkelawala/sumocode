import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_APPROVAL_CONFIG,
	installApprovalGate,
	isDangerousBashCommand,
	renderApprovalModal,
	setApprovalConfig,
	showApprovalModal,
	showRpcApprovalPrompt,
	updateApprovalSnapshot,
	type ApprovalModalSnapshot,
} from "./approval-modal.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");
const originalHerdrEnv = {
	HERDR_ENV: process.env.HERDR_ENV,
	HERDR_PANE_ID: process.env.HERDR_PANE_ID,
	CMUX_WORKSPACE_ID: process.env.CMUX_WORKSPACE_ID,
};

afterEach(() => {
	setApprovalConfig(DEFAULT_APPROVAL_CONFIG);
	if (originalHerdrEnv.HERDR_ENV === undefined) delete process.env.HERDR_ENV;
	else process.env.HERDR_ENV = originalHerdrEnv.HERDR_ENV;
	if (originalHerdrEnv.HERDR_PANE_ID === undefined) delete process.env.HERDR_PANE_ID;
	else process.env.HERDR_PANE_ID = originalHerdrEnv.HERDR_PANE_ID;
	if (originalHerdrEnv.CMUX_WORKSPACE_ID === undefined) delete process.env.CMUX_WORKSPACE_ID;
	else process.env.CMUX_WORKSPACE_ID = originalHerdrEnv.CMUX_WORKSPACE_ID;
});

function snapshot(overrides: Partial<ApprovalModalSnapshot> = {}): ApprovalModalSnapshot {
	return {
		command: "rm -rf node_modules/",
		descriptionLines: ["This will remove 234MB and is irreversible."],
		activeButton: "no",
		...overrides,
	};
}

describe("renderApprovalModal", () => {
	it("renders 'APPROVAL REQUIRED' title in approval red with scriptorium marks", () => {
		const lines = renderApprovalModal(snapshot(), 80);
		const titleLine = lines.find((line) => stripAnsi(line).includes("APPROVAL REQUIRED"));
		expect(titleLine).toBeDefined();
		expect(stripAnsi(titleLine!)).toContain("✾  APPROVAL REQUIRED  ✾");
		// approval #C1443E -> 193;68;62
		expect(titleLine).toContain("\u001b[38;2;193;68;62m");
	});

	it("renders the command in a recessed carved code block frame", () => {
		const lines = renderApprovalModal(snapshot(), 80);
		const text = lines.map(stripAnsi).join("\n");
		expect(text).toContain("┌");
		expect(text).toContain("└");
		expect(text).toContain("rm -rf node_modules/");
		const commandFrameRows = lines.filter((line) => stripAnsi(line).includes("│") || stripAnsi(line).includes("┌") || stripAnsi(line).includes("└"));
		expect(commandFrameRows).toHaveLength(3);
		for (const row of commandFrameRows) expect(row).toContain("\u001b[48;2;18;13;10m"); // surfaceRecess
	});

	it("renders em-dash explanation in dim", () => {
		const lines = renderApprovalModal(snapshot(), 80);
		const dimColor = "\u001b[38;2;139;122;99m"; // foregroundDim
		const expLine = lines.find((l) => stripAnsi(l).includes("This will remove"));
		expect(expLine).toBeDefined();
		expect(expLine).toContain(dimColor);
	});

	it("renders ■ SYSTEM NOTICE indicator in approval color (#C1443E)", () => {
		const lines = renderApprovalModal(snapshot(), 80);
		const sysLine = lines.find((l) => stripAnsi(l).includes("SYSTEM NOTICE"));
		expect(sysLine).toBeDefined();
		// 193;68;62 = #C1443E
		expect(sysLine).toContain("\u001b[38;2;193;68;62m");
	});

	it("renders all three buttons with NO focused by default", () => {
		const lines = renderApprovalModal(snapshot(), 80).map(stripAnsi);
		const text = lines.join("\n");
		expect(text).toContain("[Y]ES");
		expect(text).toContain("  NO  ");
		expect(text).toContain("[A]LWAYS");
	});

	it("highlights the active button with approval fill (default NO)", () => {
		const lines = renderApprovalModal(snapshot({ activeButton: "no" }), 80);
		const buttonLine = lines.find((line) => stripAnsi(line).includes("NO"));
		// approval bg 193;68;62
		expect(buttonLine).toContain("\u001b[48;2;193;68;62m");
		expect(stripAnsi(buttonLine!)).toContain("  NO  ");
	});

	it("when activeButton=yes, YES is filled with approval red", () => {
		const lines = renderApprovalModal(snapshot({ activeButton: "yes" }), 80);
		const buttonLine = lines.find((line) => stripAnsi(line).includes("YES"));
		expect(buttonLine).toContain("\u001b[48;2;193;68;62m");
		const matches = buttonLine!.match(/\u001b\[48;2;193;68;62m/g) ?? [];
		expect(matches.length).toBe(1);
	});

	it("paints every modal row with surfaceLifted background", () => {
		const lines = renderApprovalModal(snapshot(), 80);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) expect(line).toContain("\u001b[48;2;61;48;36m");
	});

	it("wraps long commands and descriptions inside the modal width", () => {
		const longCommand = `cd \"/Volumes/SumoDeus NVMe/code/sumocode\" && gh issue create --title \"Approval modal leaks long commands across the terminal\" --body \"long quoted body with spaces\"`;
		const lines = renderApprovalModal(snapshot({
			command: longCommand,
			descriptionLines: ["This command mutates GitHub state and has a very long quoted body that should wrap inside the lifted modal without leaking past the terminal edge."],
		}), 80);
		const plain = lines.map(stripAnsi);
		for (const row of plain) expect(row.length).toBeLessThanOrEqual(80);
		expect(plain.filter((row) => row.includes("│")).length).toBeGreaterThan(1);
		expect(plain.join("\n")).toContain("Approval modal leaks long commands");
	});

	it("caps the command box height for very long commands and shows a truncation marker", () => {
		// Twenty pipe-separated subcommands that each wrap once at width 80 →
		// far more than MAX_COMMAND_ROWS = 12 once expanded into the modal.
		const longCommand = Array.from({ length: 20 }, (_, i) => `subcmd${i} --flag-${i}=very-long-value-${i}-${i}-${i}-${i}-${i}-${i}-${i}-${i}-${i}-${i}`).join(" | ");
		const lines = renderApprovalModal(snapshot({ command: longCommand }), 80);
		const plain = lines.map(stripAnsi);
		const commandRows = plain.filter((row) => row.includes("│") && !row.includes("┌") && !row.includes("└"));
		// Cap is MAX_COMMAND_ROWS = 12, so the bash region must not blow up the modal height.
		expect(commandRows.length).toBeLessThanOrEqual(12);
		expect(plain.some((row) => row.includes("more lines hidden"))).toBe(true);
		// Total modal height stays bounded.
		expect(lines.length).toBeLessThanOrEqual(28);
	});

	it("caps the description region for verbose multi-line explanations", () => {
		const lines = renderApprovalModal(snapshot({
			descriptionLines: Array.from({ length: 12 }, (_, i) => `Reason ${i + 1}: this command is dangerous because of an unusual edge case.`),
		}), 80);
		const plain = lines.map(stripAnsi).join("\n");
		expect(plain).toContain("more lines hidden");
		expect(lines.length).toBeLessThanOrEqual(28);
	});
});

describe("updateApprovalSnapshot — direct letter selection", () => {
	it("Y/y returns 'yes' immediately", () => {
		expect(updateApprovalSnapshot(snapshot(), "y").done).toBe("yes");
		expect(updateApprovalSnapshot(snapshot(), "Y").done).toBe("yes");
	});

	it("N/n returns 'no' immediately", () => {
		expect(updateApprovalSnapshot(snapshot(), "n").done).toBe("no");
		expect(updateApprovalSnapshot(snapshot(), "N").done).toBe("no");
	});

	it("A/a returns 'always' immediately", () => {
		expect(updateApprovalSnapshot(snapshot(), "a").done).toBe("always");
		expect(updateApprovalSnapshot(snapshot(), "A").done).toBe("always");
	});
});

describe("updateApprovalSnapshot — Tab/arrow cycling", () => {
	it("Tab cycles no → always → yes → no", () => {
		let snap = snapshot({ activeButton: "no" });
		let result = updateApprovalSnapshot(snap, "tab");
		expect(result.snapshot.activeButton).toBe("always");
		result = updateApprovalSnapshot(result.snapshot, "tab");
		expect(result.snapshot.activeButton).toBe("yes");
		result = updateApprovalSnapshot(result.snapshot, "tab");
		expect(result.snapshot.activeButton).toBe("no");
	});

	it("Shift+Tab cycles backward", () => {
		const result = updateApprovalSnapshot(snapshot({ activeButton: "no" }), "shift+tab");
		expect(result.snapshot.activeButton).toBe("yes");
	});

	it("right arrow cycles forward; left arrow cycles backward", () => {
		const r = updateApprovalSnapshot(snapshot({ activeButton: "no" }), "right");
		expect(r.snapshot.activeButton).toBe("always");
		const l = updateApprovalSnapshot(snapshot({ activeButton: "no" }), "left");
		expect(l.snapshot.activeButton).toBe("yes");
	});
});

describe("updateApprovalSnapshot — Enter + Escape", () => {
	it("Enter selects the active button", () => {
		const r = updateApprovalSnapshot(snapshot({ activeButton: "always" }), "enter");
		expect(r.done).toBe("always");
	});

	it("Escape rejects with 'no' (safety default)", () => {
		const r = updateApprovalSnapshot(snapshot({ activeButton: "always" }), "escape");
		expect(r.done).toBe("no");
		expect(r.snapshot.activeButton).toBe("no");
	});
});

describe("isDangerousBashCommand", () => {
	it("flags rm -rf and rm --recursive", () => {
		expect(isDangerousBashCommand("rm -rf node_modules/")).toBe(true);
		expect(isDangerousBashCommand("rm --recursive dist/")).toBe(true);
		expect(isDangerousBashCommand("rm -r tmp/")).toBe(true);
	});

	it("flags sudo", () => {
		expect(isDangerousBashCommand("sudo apt install foo")).toBe(true);
	});

	it("flags git push --force (without --force-with-lease)", () => {
		expect(isDangerousBashCommand("git push --force origin main")).toBe(true);
		expect(isDangerousBashCommand("git push --force-with-lease")).toBe(false);
	});

	it("flags git reset --hard", () => {
		expect(isDangerousBashCommand("git reset --hard HEAD~1")).toBe(true);
	});

	it("does NOT flag gh CLI commands", () => {
		expect(isDangerousBashCommand("gh pr create --title 'test'")).toBe(false);
		expect(isDangerousBashCommand("gh pr merge 42")).toBe(false);
		expect(isDangerousBashCommand("gh issue create --title 'bug'")).toBe(false);
		expect(isDangerousBashCommand("gh pr list")).toBe(false);
		expect(isDangerousBashCommand("gh issue view 42")).toBe(false);
		expect(isDangerousBashCommand("gh api /repos/foo/bar")).toBe(false);
	});

	it("does NOT flag normal commands", () => {
		expect(isDangerousBashCommand("pnpm test")).toBe(false);
		expect(isDangerousBashCommand("pnpm build")).toBe(false);
		expect(isDangerousBashCommand("git add -A")).toBe(false);
		expect(isDangerousBashCommand("git commit -m 'test'")).toBe(false);
		expect(isDangerousBashCommand("git push origin main")).toBe(false);
		expect(isDangerousBashCommand("cat src/index.ts")).toBe(false);
		expect(isDangerousBashCommand("ls -la")).toBe(false);
	});

	it("does NOT flag edit/write tool names", () => {
		// The gate only intercepts bash, not edit/write
		expect(isDangerousBashCommand("echo hello")).toBe(false);
	});
});

describe("approval config", () => {
	it("extraPatterns adds custom gates", () => {
		expect(isDangerousBashCommand("curl -X POST https://api.example.com")).toBe(false);
		setApprovalConfig({ extraPatterns: [/\bcurl\s+-X\s+POST\b/i] });
		expect(isDangerousBashCommand("curl -X POST https://api.example.com")).toBe(true);
	});

	it("allowList bypasses built-in gates", () => {
		expect(isDangerousBashCommand("sudo docker build .")).toBe(true);
		setApprovalConfig({ allowList: [/\bsudo\s+docker\b/i] });
		expect(isDangerousBashCommand("sudo docker build .")).toBe(false);
		// Other sudo commands still gated
		expect(isDangerousBashCommand("sudo rm -rf /")).toBe(true);
	});
});

describe("installApprovalGate — Pi event subscription", () => {
	type ApprovalHandler = (
		event: { toolName: string; input: { command: string } },
		ctx: unknown,
	) => Promise<unknown>;

	function captureApprovalHandler(): ApprovalHandler {
		let handler: ApprovalHandler | undefined;
		const on = vi.fn((_eventName: string, callback: ApprovalHandler) => {
			handler = callback;
		});
		installApprovalGate({ on } as never);
		expect(on).toHaveBeenCalledWith("tool_call", expect.any(Function));
		expect(handler).toBeDefined();
		return handler!;
	}

	it("uses RPC select and fails closed on cancellation, undefined, errors, and malformed values", async () => {
		const custom = vi.fn();
		for (const select of [
			vi.fn(async () => "No"),
			vi.fn(async () => undefined),
			vi.fn(async () => "Allow"),
			vi.fn(async () => {
				throw new Error("cancelled");
			}),
		]) {
			const result = await showApprovalModal(
				{ mode: "rpc", ui: { custom, select } } as never,
				{ command: "rm -rf node_modules/", descriptionLines: ["This will permanently delete files."] },
			);

			expect(result).toBe("no");
			expect(select).toHaveBeenCalledWith(
				expect.stringContaining("APPROVAL REQUIRED"),
				["No", "Yes", "Always"],
				{ timeout: 60_000 },
			);
		}
		expect(custom).not.toHaveBeenCalled();
	});

	it("maps RPC Yes and Always selections to approval choices", async () => {
		const yesSelect = vi.fn(async () => "Yes");
		const alwaysSelect = vi.fn(async () => "Always");

		await expect(showApprovalModal(
			{ mode: "rpc", ui: { select: yesSelect } } as never,
			{ command: "rm -rf node_modules/", descriptionLines: ["This will permanently delete files."] },
		)).resolves.toBe("yes");
		await expect(showApprovalModal(
			{ mode: "rpc", ui: { select: alwaysSelect } } as never,
			{ command: "rm -rf node_modules/", descriptionLines: ["This will permanently delete files."] },
		)).resolves.toBe("always");
	});

	it.each(["No", "Yes", "Always"])("pairs herdr blocked emissions for RPC %s", async (selection) => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "w1:p1";
		delete process.env.CMUX_WORKSPACE_ID;
		const emit = vi.fn();

		await showRpcApprovalPrompt(
			{ ui: { select: vi.fn(async () => selection) } } as never,
			{ command: "rm -rf node_modules/", descriptionLines: ["This will permanently delete files."] },
			{ events: { emit } } as never,
		);

		expect(emit).toHaveBeenCalledTimes(2);
		expect(emit).toHaveBeenNthCalledWith(1, "herdr:blocked", { active: true, label: "approval" });
		expect(emit).toHaveBeenNthCalledWith(2, "herdr:blocked", { active: false });
	});

	it("releases herdr blocked emission when the RPC prompt throws", async () => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "w1:p1";
		delete process.env.CMUX_WORKSPACE_ID;
		const emit = vi.fn();

		await expect(showRpcApprovalPrompt(
			{ ui: { select: vi.fn(async () => { throw new Error("closed"); }) } } as never,
			{ command: "rm -rf node_modules/", descriptionLines: ["This will permanently delete files."] },
			{ events: { emit } } as never,
		)).resolves.toBe("no");

		expect(emit).toHaveBeenNthCalledWith(1, "herdr:blocked", { active: true, label: "approval" });
		expect(emit).toHaveBeenNthCalledWith(2, "herdr:blocked", { active: false });
	});

	it("does not emit herdr blocked events outside herdr", async () => {
		delete process.env.HERDR_ENV;
		delete process.env.HERDR_PANE_ID;
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		const emit = vi.fn();

		await showRpcApprovalPrompt(
			{ ui: { select: vi.fn(async () => "Yes") } } as never,
			{ command: "rm -rf node_modules/", descriptionLines: ["This will permanently delete files."] },
			{ events: { emit } } as never,
		);

		expect(emit).not.toHaveBeenCalled();
	});

	it("subscribes to tool_call", () => {
		const on = vi.fn();
		installApprovalGate({ on } as never);
		expect(on).toHaveBeenCalledWith("tool_call", expect.any(Function));
	});

	it("blocks dangerous RPC bash when the selection is No", async () => {
		const handler = captureApprovalHandler();
		const custom = vi.fn();
		const select = vi.fn(async () => "No");

		const result = await handler(
			{ toolName: "bash", input: { command: "rm -rf node_modules/" } },
			{ hasUI: true, mode: "rpc", ui: { custom, select } },
		);

		expect(result).toEqual({ block: true, reason: "user denied via cathedral approval modal" });
		expect(custom).not.toHaveBeenCalled();
	});

	it("blocks dangerous RPC bash when the selection is cancelled or unanswered", async () => {
		const handler = captureApprovalHandler();
		const select = vi.fn(async () => undefined);

		const result = await handler(
			{ toolName: "bash", input: { command: "sudo rm -rf /tmp/sumocode-cancelled" } },
			{ hasUI: true, mode: "rpc", ui: { select } },
		);

		expect(result).toEqual({ block: true, reason: "user denied via cathedral approval modal" });
	});

	it("blocks dangerous RPC bash when the approval prompt throws", async () => {
		const handler = captureApprovalHandler();
		const select = vi.fn(async () => {
			throw new Error("transport closed");
		});

		const result = await handler(
			{ toolName: "bash", input: { command: "sudo rm -rf /tmp/sumocode-error" } },
			{ hasUI: true, mode: "rpc", ui: { select } },
		);

		expect(result).toEqual({ block: true, reason: "user denied via cathedral approval modal" });
	});

	it("blocks dangerous bash when no UI is available", async () => {
		const handler = captureApprovalHandler();

		const result = await handler(
			{ toolName: "bash", input: { command: "sudo rm -rf /tmp/sumocode-no-ui" } },
			{ hasUI: false, mode: "rpc", ui: {} },
		);

		expect(result).toEqual({ block: true, reason: "approval modal unavailable; blocked dangerous command" });
	});

	it("allows dangerous RPC bash only when the selection is Yes or Always", async () => {
		const handler = captureApprovalHandler();
		const yesSelect = vi.fn(async () => "Yes");
		const alwaysSelect = vi.fn(async () => "Always");
		const deniedAfterAlways = vi.fn(async () => "No");
		const alwaysCommand = "sudo sumocode-always-test";

		await expect(handler(
			{ toolName: "bash", input: { command: "rm -rf /tmp/sumocode-yes" } },
			{ hasUI: true, mode: "rpc", ui: { select: yesSelect } },
		)).resolves.toBeUndefined();
		await expect(handler(
			{ toolName: "bash", input: { command: alwaysCommand } },
			{ hasUI: true, mode: "rpc", ui: { select: alwaysSelect } },
		)).resolves.toBeUndefined();
		await expect(handler(
			{ toolName: "bash", input: { command: alwaysCommand } },
			{ hasUI: true, mode: "rpc", ui: { select: deniedAfterAlways } },
		)).resolves.toBeUndefined();

		expect(yesSelect).toHaveBeenCalledTimes(1);
		expect(alwaysSelect).toHaveBeenCalledTimes(1);
		expect(deniedAfterAlways).not.toHaveBeenCalled();
	});

	it("opens the TUI approval modal and blocks when the user selects no", async () => {
		const handler = captureApprovalHandler();
		const custom = vi.fn(async () => "no");

		const result = await handler(
			{ toolName: "bash", input: { command: "rm -rf node_modules/" } },
			{ hasUI: true, mode: "tui", ui: { custom } },
		);

		expect(custom).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ block: true, reason: "user denied via cathedral approval modal" });
	});
});
