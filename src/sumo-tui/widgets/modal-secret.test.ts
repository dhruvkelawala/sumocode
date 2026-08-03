import { describe, expect, it } from "vitest";
import { ModalManager } from "./modal.js";

describe("ModalManager secret input", () => {
	it("masks secret input values in rendered output and dialog snapshots", () => {
		const modals = new ModalManager();
		void modals.input("API key", "sk-...", { secret: true });
		modals.handleInput("sk-secret");

		const rendered = modals.render(40).join("\n");
		const snapshot = modals.getActiveDialogSnapshot();
		expect(rendered).not.toContain("sk-secret");
		expect(snapshot?.value).not.toContain("sk-secret");
		expect(rendered).toContain("•••••••••");
	});
});
