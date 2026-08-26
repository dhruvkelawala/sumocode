import { describe, expect, it, vi } from "vitest";
import { executeSumoReload, registerSumoReloadCommand, SUMOCODE_RELOAD_EXIT_CODE } from "./reload.js";

function makeCtx(notify = vi.fn()) {
	return { ui: { notify } };
}

describe("executeSumoReload", () => {
	it("notifies and exits with the reload code when running under the launcher", async () => {
		const notify = vi.fn();
		const exit = vi.fn();
		const delay = vi.fn(async () => undefined);

		// SAFETY: ctx double carries ui.notify, the only member executeSumoReload reads.
		await executeSumoReload(makeCtx(notify) as never, {
			env: { SUMOCODE_LAUNCHER: "/usr/local/bin/sumocode" },
			exit,
			delay,
		});

		expect(notify).toHaveBeenCalledWith("hard reloading SumoCode\u2026", "info");
		expect(delay).toHaveBeenCalled();
		expect(exit).toHaveBeenCalledWith(SUMOCODE_RELOAD_EXIT_CODE);
	});

	it("warns and does not exit when the launcher env is missing", async () => {
		const notify = vi.fn();
		const exit = vi.fn();

		// SAFETY: ctx double carries ui.notify, the only member executeSumoReload reads.
		await executeSumoReload(makeCtx(notify) as never, {
			env: {},
			exit,
		});

		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/launcher/), "warning");
		expect(exit).not.toHaveBeenCalled();
	});
});

describe("registerSumoReloadCommand", () => {
	it("registers the /reload slash command", () => {
		const registerCommand = vi.fn();
		// SAFETY: test double only exercises the members this test asserts on.
		registerSumoReloadCommand({ registerCommand, on: vi.fn() } as never);
		expect(registerCommand).toHaveBeenCalledWith(
			"reload",
			expect.objectContaining({
				description: expect.any(String),
				handler: expect.any(Function),
			}),
		);
	});
});
