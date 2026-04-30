import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_APPROVAL_CONFIG,
	installApprovalGate,
	isDangerousBashCommand,
	renderApprovalModal,
	setApprovalConfig,
	updateApprovalSnapshot,
	type ApprovalModalSnapshot,
} from "./approval-modal.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

function snapshot(overrides: Partial<ApprovalModalSnapshot> = {}): ApprovalModalSnapshot {
	return {
		command: "rm -rf node_modules/",
		descriptionLines: ["This will remove 234MB and is irreversible."],
		activeButton: "no",
		...overrides,
	};
}

describe("renderApprovalModal", () => {
	it("renders 'APPROVAL REQUIRED' title in accent", () => {
		const lines = renderApprovalModal(snapshot(), 80);
		const titleLine = lines.find((l) => stripAnsi(l).includes("APPROVAL REQUIRED"));
		expect(titleLine).toBeDefined();
		// accent #D97706 -> 217;119;6
		expect(titleLine).toContain("\u001b[38;2;217;119;6m");
	});

	it("renders the command in a carved code block frame", () => {
		const lines = renderApprovalModal(snapshot(), 80).map(stripAnsi);
		const text = lines.join("\n");
		expect(text).toContain("┌");
		expect(text).toContain("└");
		expect(text).toContain("rm -rf node_modules/");
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

	it("renders all three buttons: [Y]ES [N]O [A]LWAYS", () => {
		const lines = renderApprovalModal(snapshot(), 80).map(stripAnsi);
		const text = lines.join("\n");
		expect(text).toContain("[Y]ES");
		expect(text).toContain("[N]O");
		expect(text).toContain("[A]LWAYS");
	});

	it("highlights the active button with accent fill (default [N]O)", () => {
		const lines = renderApprovalModal(snapshot({ activeButton: "no" }), 80);
		const buttonLine = lines.find((l) => stripAnsi(l).includes("[N]O"));
		// accent bg 217;119;6
		expect(buttonLine).toContain("\u001b[48;2;217;119;6m");
	});

	it("when activeButton=yes, [Y]ES is filled", () => {
		const lines = renderApprovalModal(snapshot({ activeButton: "yes" }), 80);
		const text = lines.join("\n");
		// Find the [Y]ES button section after the bg escape
		expect(text).toContain("\u001b[48;2;217;119;6m");
		// And the accent bg should be associated with [Y]ES — by checking there's
		// only ONE accent bg in the line containing buttons
		const buttonLine = lines.find((l) => l.includes("[Y]ES"));
		const matches = buttonLine!.match(/\u001b\[48;2;217;119;6m/g) ?? [];
		expect(matches.length).toBe(1);
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

	it("flags mutating gh CLI commands", () => {
		expect(isDangerousBashCommand("gh pr create --title 'test'")).toBe(true);
		expect(isDangerousBashCommand("gh pr merge 42")).toBe(true);
		expect(isDangerousBashCommand("gh issue create --title 'bug'")).toBe(true);
		expect(isDangerousBashCommand("gh issue close 99")).toBe(true);
		expect(isDangerousBashCommand("gh repo delete foo")).toBe(true);
		expect(isDangerousBashCommand("gh release create v1.0")).toBe(true);
	});

	it("does NOT flag read-only gh commands", () => {
		expect(isDangerousBashCommand("gh pr list")).toBe(false);
		expect(isDangerousBashCommand("gh issue view 42")).toBe(false);
		expect(isDangerousBashCommand("gh pr view 99 --json state")).toBe(false);
		expect(isDangerousBashCommand("gh run list")).toBe(false);
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
	afterEach(() => setApprovalConfig(DEFAULT_APPROVAL_CONFIG));

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
	it("subscribes to tool_call", () => {
		const on = vi.fn();
		installApprovalGate({ on } as never);
		expect(on).toHaveBeenCalledWith("tool_call", expect.any(Function));
	});
});
