import { afterEach, describe, expect, it, vi } from "vitest";
import { resetThemeRegistryForTests, setActiveTheme } from "../themes/index.js";
import { ULTRAVIOLET_RUNCAT_FRAMES } from "../themes/ultraviolet-core.js";
import { formatActiveSpinnerInspection, registerSpinnerCommand } from "./spinner.js";

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, "");

describe("formatActiveSpinnerInspection", () => {
	afterEach(() => resetThemeRegistryForTests());

	it("reports the Cathedral default indicator", () => {
		setActiveTheme("cathedral");
		const report = stripAnsi(formatActiveSpinnerInspection({ SUMOCODE_RUNCAT_FONT: "1" }));

		expect(report).toContain("theme=cathedral");
		expect(report).toContain("variant=default");
		expect(report).not.toContain("capability=SUMOCODE_RUNCAT_FONT");
		expect(report).toContain("6 frames · 150ms per frame");
		expect(report).toContain("◌");
	});

	it("reports the Ultraviolet fallback indicator", () => {
		setActiveTheme("ultraviolet-core");
		const report = stripAnsi(formatActiveSpinnerInspection({ SUMOCODE_RUNCAT_FONT: "0" }));

		expect(report).toContain("theme=ultraviolet-core");
		expect(report).toContain("variant=default");
		expect(report).toContain("capability=SUMOCODE_RUNCAT_FONT");
		expect(report).toContain("capabilityState=disabled");
		expect(report).toContain("8 frames · 120ms per frame");
		expect(report).toContain(".  .");
	});

	it("reports and previews every Ultraviolet RunCat frame", () => {
		setActiveTheme("ultraviolet-core");
		const report = formatActiveSpinnerInspection({ SUMOCODE_RUNCAT_FONT: "yes" });
		const plain = stripAnsi(report);

		expect(plain).toContain("variant=runcat");
		expect(plain).toContain("capabilityState=enabled");
		expect(plain).toContain("5 frames · 167ms per frame");
		for (const frame of ULTRAVIOLET_RUNCAT_FRAMES) expect(report).toContain(frame);
	});

	it("warns and previews fallback frames for an unrecognized capability value", () => {
		setActiveTheme("ultraviolet-core");
		const report = stripAnsi(formatActiveSpinnerInspection({ SUMOCODE_RUNCAT_FONT: "maybe" }));

		expect(report).toContain("capabilityState=unrecognized");
		expect(report).toContain("warning: SUMOCODE_RUNCAT_FONT=maybe is unrecognized; previewing fallback frames");
		expect(report).toContain("8 frames · 120ms per frame");
	});
});

describe("registerSpinnerCommand", () => {
	afterEach(() => resetThemeRegistryForTests());

	it("prints to stdout in non-TTY contexts", async () => {
		setActiveTheme("ultraviolet-core");
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		let handler: ((args: string[], ctx: { hasUI: boolean }) => Promise<void>) | undefined;
		const pi = { registerCommand: vi.fn((_name: string, command: { handler: typeof handler }) => { handler = command.handler; }) };

		registerSpinnerCommand(pi as never);
		await handler?.([], { hasUI: false });

		expect(stdout).toHaveBeenCalledWith(expect.stringContaining("theme=ultraviolet-core"));
		stdout.mockRestore();
	});

	it("notifies in interactive contexts", async () => {
		let handler: ((args: string[], ctx: { hasUI: boolean; ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>) | undefined;
		const pi = { registerCommand: vi.fn((_name: string, command: { handler: typeof handler }) => { handler = command.handler; }) };
		const notify = vi.fn();

		registerSpinnerCommand(pi as never);
		await handler?.([], { hasUI: true, ui: { notify } });

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("variant=default"), "info");
	});
});
