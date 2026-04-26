import { describe, expect, it } from "vitest";
import { formatRegistryFooter } from "./footer-registry-tone.js";

describe("registry footer spike", () => {
	it("renders state, thinking level, wire, latency, and scriptorium status when wide", () => {
		const line = formatRegistryFooter({ state: "idle", thinkingLevel: "medium", wire: "wire", latencyMs: 12, scriptorium: "active" }, 130);
		expect(line).toContain("SYSTEM STATUS [ READY · MEDIUM ]");
		expect(line).toContain("LANGS WIRE");
		expect(line).toContain("LATENCY: 12MS");
		expect(line).toContain("SCRIPTORIUM ACTIVE");
	});

	it("collapses to a dot plus state at very narrow widths", () => {
		expect(formatRegistryFooter({ state: "approval", thinkingLevel: "high", wire: "wire", scriptorium: "idle" }, 20)).toBe("● needs you");
	});
});
