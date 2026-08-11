import { describe, expect, it, vi } from "vitest";
import { InitialHydrationActionGate } from "./initial-hydration-action-gate.js";

describe("InitialHydrationActionGate", () => {
	it("defers and coalesces child-dependent actions until hydration", async () => {
		let release!: () => void;
		const hydration = new Promise<void>((resolve) => { release = resolve; });
		const gate = new InitialHydrationActionGate(hydration);
		const first = vi.fn();
		const latest = vi.fn();
		const other = vi.fn();

		gate.run("model", first);
		gate.run("model", latest);
		gate.run("palette", other);
		expect(first).not.toHaveBeenCalled();
		expect(latest).not.toHaveBeenCalled();
		expect(other).not.toHaveBeenCalled();

		release();
		await hydration;
		await Promise.resolve();
		expect(first).not.toHaveBeenCalled();
		expect(latest).toHaveBeenCalledOnce();
		expect(other).toHaveBeenCalledOnce();
	});

	it("runs new actions immediately after hydration", async () => {
		const gate = new InitialHydrationActionGate(Promise.resolve());
		await Promise.resolve();
		const action = vi.fn();
		gate.run("model", action);
		expect(action).toHaveBeenCalledOnce();
	});
});
