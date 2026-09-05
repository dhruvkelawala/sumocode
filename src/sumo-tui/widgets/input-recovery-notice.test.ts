import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { stripAnsi } from "../cathedral/ansi.js";
import { InputRecoveryNotice } from "./input-recovery-notice.js";

describe("InputRecoveryNotice", () => {
	it.each([24, 60, 120])("keeps one persistent notice with readable wrapped guidance at %i columns", (width) => {
		const notice = new InputRecoveryNotice();
		expect(notice.render(width)).toEqual([]);
		notice.setMessage("INPUT PAUSED — incomplete paste; 5/65536 bytes retained; 0 bytes truncated. end the paste stream in the terminal, then restart the session from outside input.");
		const lines = notice.render(width);
		expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
		expect(lines.map(stripAnsi).join(" ")).toContain("INPUT PAUSED");
		expect(lines.map(stripAnsi).join(" ")).toContain("restart");
		notice.invalidate();
		expect(notice.render(width)).toEqual(lines);
		notice.setMessage("input resumed — 5 bytes retained; 0 bytes truncated");
		expect(notice.render(width).map(stripAnsi).join(" ")).not.toContain("INPUT PAUSED");
	});
});
