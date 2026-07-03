import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { RpcHostOverlayManager } from "./host-overlays.js";

class FakeOverlayComponent implements Component {
	public inputs: string[] = [];
	public constructor(private readonly label: string) {}
	public invalidate(): void {}
	public handleInput(data: string): void {
		this.inputs.push(data);
	}
	public render(): string[] {
		return [this.label];
	}
}

describe("RpcHostOverlayManager", () => {
	it("queues show() B while A is active; A resolves only on its own completion, then B presents", async () => {
		const overlays = new RpcHostOverlayManager();
		let doneA: ((value: string) => void) | undefined;
		let doneB: ((value: string) => void) | undefined;

		const orderResolved: string[] = [];
		const a = overlays.show<string>("A", (done) => {
			doneA = done;
			return new FakeOverlayComponent("A");
		}).then((value) => {
			orderResolved.push("A");
			return value;
		});
		const b = overlays.show<string>("B", (done) => {
			doneB = done;
			return new FakeOverlayComponent("B");
		}).then((value) => {
			orderResolved.push("B");
			return value;
		});

		// A is active, B is queued -- B's create() has not been invoked yet.
		expect(overlays.getActiveKind()).toBe("A");
		expect(doneB).toBeUndefined();

		doneA?.("resolved-a");
		await expect(a).resolves.toBe("resolved-a");

		// B should now be active.
		expect(overlays.getActiveKind()).toBe("B");
		expect(doneB).toBeDefined();

		doneB?.("resolved-b");
		await expect(b).resolves.toBe("resolved-b");

		expect(orderResolved).toEqual(["A", "B"]);
		expect(overlays.getActiveKind()).toBeUndefined();
	});

	it("does not resolve the active overlay's promise merely because a second show() is queued", async () => {
		const overlays = new RpcHostOverlayManager();
		let aResolvedValue: string | undefined;
		let aResolved = false;

		const a = overlays.show<string>("A", () => new FakeOverlayComponent("A"));
		void a.then((value) => {
			aResolved = true;
			aResolvedValue = value;
		});

		overlays.show<string>("B", () => new FakeOverlayComponent("B"));

		// Give any microtasks a chance to run -- A must still be pending.
		await Promise.resolve();
		await Promise.resolve();

		expect(aResolved).toBe(false);
		expect(aResolvedValue).toBeUndefined();
		expect(overlays.getActiveKind()).toBe("A");
	});

	it("close() during a queue closes only the active overlay and promotes the next", async () => {
		const overlays = new RpcHostOverlayManager();

		const a = overlays.show<string | undefined>("A", () => new FakeOverlayComponent("A"));
		const b = overlays.show<string | undefined>("B", () => new FakeOverlayComponent("B"));
		const c = overlays.show<string | undefined>("C", () => new FakeOverlayComponent("C"));

		expect(overlays.getActiveKind()).toBe("A");

		overlays.close("cancelled-a");
		await expect(a).resolves.toBe("cancelled-a");

		// B is promoted; C remains queued and untouched.
		expect(overlays.getActiveKind()).toBe("B");

		overlays.close();
		await expect(b).resolves.toBeUndefined();

		expect(overlays.getActiveKind()).toBe("C");
		overlays.close("done-c");
		await expect(c).resolves.toBe("done-c");
		expect(overlays.getActiveKind()).toBeUndefined();
	});

	it("regression: Ctrl-C interrupt-tier dismissal (close on the active overlay) cancels only the active overlay, queued ones stay pending", async () => {
		// Mirrors host.ts's handlePreEditorInput "dismiss-modal" branch, which
		// calls overlays.close() when an overlay has focus during a Ctrl-C
		// interrupt. This must behave like "cancel the front overlay", not
		// "clobber whatever happens to be pending."
		const overlays = new RpcHostOverlayManager();

		const approval = overlays.show<"yes" | "no">("approval", () => new FakeOverlayComponent("approval"));
		const queuedApproval = overlays.show<"yes" | "no">("approval2", () => new FakeOverlayComponent("approval2"));

		let queuedSettled = false;
		void queuedApproval.then(() => { queuedSettled = true; });

		// Simulate Ctrl-C dismiss tier: overlay is active, so we dismiss it.
		overlays.close("no");
		await expect(approval).resolves.toBe("no");

		// The queued approval must still be pending -- Ctrl-C on the first
		// overlay must not silently resolve the second, unanswered one.
		expect(queuedSettled).toBe(false);
		expect(overlays.getActiveKind()).toBe("approval2");
	});

	it("invalidate/handleInput/render only affect the active overlay", () => {
		const overlays = new RpcHostOverlayManager();
		let activeComponent: FakeOverlayComponent | undefined;

		overlays.show("A", () => {
			activeComponent = new FakeOverlayComponent("A");
			return activeComponent;
		});
		overlays.show("B", () => new FakeOverlayComponent("B"));

		overlays.handleInput("x");
		expect(activeComponent?.inputs).toEqual(["x"]);
		expect(overlays.render(80)).toEqual(["A"]);
	});

	it("calls onChange when a show() is queued (not just when activated)", () => {
		const onChange = vi.fn();
		const overlays = new RpcHostOverlayManager(onChange);

		overlays.show("A", () => new FakeOverlayComponent("A"));
		onChange.mockClear();

		overlays.show("B", () => new FakeOverlayComponent("B"));
		expect(onChange).toHaveBeenCalled();
	});
});
