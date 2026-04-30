import { describe, expect, it, vi } from "vitest";
import {
	filterPiNoiseChildren,
	forceHardwareCursorVisible,
	installPiNoiseFilter,
	isPiNoiseTextComponent,
	shouldForceHardwareCursor,
	shouldHidePiNoise,
	type PiNoiseFilterState,
} from "./pi-interactive-adapter.js";

class TextNode {
	public constructor(public text: string) {}
}

class Spacer {}

describe("Pi interactive adapter", () => {
	it("matches Pi startup noise Text components after ANSI styling", () => {
		expect(isPiNoiseTextComponent(new TextNode("\x1b[33m[Skill conflicts]\x1b[0m\n  \"use-railway\" collision:"))).toBe(true);
		expect(isPiNoiseTextComponent(new TextNode("\x1b[33m[Prompt conflicts]\x1b[0m\nconflict"))).toBe(true);
		expect(isPiNoiseTextComponent(new TextNode("\x1b[33m[Extension issues]\x1b[0m\nshortcut conflict"))).toBe(true);
		expect(isPiNoiseTextComponent(new TextNode("\x1b[33m[Theme conflicts]\x1b[0m\nconflict"))).toBe(true);
		expect(isPiNoiseTextComponent(new TextNode("\x1b[33mWarning: Anthropic subscription auth is active. Third-party harness usage draws from extra usage.\x1b[0m"))).toBe(true);
		expect(isPiNoiseTextComponent(new TextNode("Warning: Wait for the current response to finish before reloading."))).toBe(false);
	});

	it("filters known noise and the spacer Pi appends after it", () => {
		const keep = new TextNode("real chat message");
		const state: PiNoiseFilterState = { removedNodes: [], skipNextSpacer: false };
		const container = {
			children: [new TextNode("[Extension issues]\nconflict"), new Spacer(), keep],
		};

		expect(filterPiNoiseChildren(container, state)).toBe(2);
		expect(container.children).toEqual([keep]);
		expect(state.removedNodes).toHaveLength(2);
	});

	it("patches chatContainer.addChild so late Anthropic warnings never enter chat", () => {
		const state: PiNoiseFilterState = { removedNodes: [], skipNextSpacer: false };
		const children: unknown[] = [];
		const upstream = {
			chatContainer: {
				children,
				addChild(component: unknown) {
					children.push(component);
				},
			},
		};
		const keep = new TextNode("real warning");

		expect(installPiNoiseFilter(upstream, state)).toBe(true);
		upstream.chatContainer.addChild(new TextNode("Warning: Anthropic subscription auth is active. Third-party harness usage draws from extra usage."));
		upstream.chatContainer.addChild(new Spacer());
		upstream.chatContainer.addChild(keep);

		expect(children).toEqual([keep]);
		expect(state.removedNodes).toHaveLength(2);
	});

	it("defaults SUMO_TUI_HIDE_PI_NOISE and hardware cursor forcing on, with env opt-outs", () => {
		expect(shouldHidePiNoise({})).toBe(true);
		expect(shouldHidePiNoise({ SUMO_TUI_HIDE_PI_NOISE: "0" })).toBe(false);
		expect(shouldForceHardwareCursor({})).toBe(true);
		expect(shouldForceHardwareCursor({ SUMO_TUI_SHOW_HARDWARE_CURSOR: "false" })).toBe(false);
	});

	it("forces Pi's TUI hardware cursor visible", () => {
		const setShowHardwareCursor = vi.fn();
		const upstream = { ui: { setShowHardwareCursor } };

		expect(forceHardwareCursorVisible(upstream)).toBe(true);
		expect(setShowHardwareCursor).toHaveBeenCalledWith(true);
	});
});
