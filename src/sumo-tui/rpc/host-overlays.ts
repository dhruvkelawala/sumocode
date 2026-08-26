import type { Component } from "@earendil-works/pi-tui";

/** Values an overlay can hand back to its opener (palette selections etc.). */
type OverlayValue = string | number | boolean | undefined;

interface QueuedOverlay {
	readonly kind: string;
	readonly create: (done: (value: OverlayValue) => void) => Component;
	readonly resolve: (value: OverlayValue) => void;
}

export class RpcHostOverlayManager implements Component {
	private active: Component | undefined;
	private activeKind: string | undefined;
	private finish: ((value: OverlayValue) => void) | undefined;
	private activeResolve: ((value: OverlayValue) => void) | undefined;
	private readonly queue: QueuedOverlay[] = [];

	public constructor(private readonly onChange: () => void = () => undefined) {}

	public show<T>(
		kind: string,
		create: (done: (value: T) => void) => Component,
	): Promise<T> {
		return new Promise<T>((resolve) => {
			const entry: QueuedOverlay = {
				kind,
				// SAFETY: T is resolved through the paired promise resolver below;
				// the queue only erases the concrete OverlayValue-bound type.
				create: create as (done: (value: OverlayValue) => void) => Component,
				// SAFETY: same OverlayValue bound as create; the promise resolver
				// restores T when the overlay finishes.
				resolve: resolve as (value: OverlayValue) => void,
			};
			if (this.active) {
				this.queue.push(entry);
				this.onChange();
				return;
			}
			this.activate(entry);
			this.onChange();
		});
	}

	public close(value?: OverlayValue): void {
		if (!this.active && !this.finish) return;
		const finish = this.finish;
		this.active = undefined;
		this.activeKind = undefined;
		this.finish = undefined;
		this.activeResolve = undefined;
		finish?.(value);
		this.activateNext();
		this.onChange();
	}

	public drain(value?: OverlayValue): void {
		const activeResolve = this.activeResolve;
		const queued = this.queue.splice(0);
		if (!this.active && !this.finish && activeResolve === undefined && queued.length === 0) return;
		this.active = undefined;
		this.activeKind = undefined;
		this.finish = undefined;
		this.activeResolve = undefined;
		activeResolve?.(value);
		for (const entry of queued) entry.resolve(value);
		this.onChange();
	}

	public getActiveKind(): string | undefined {
		return this.activeKind;
	}

	public invalidate(): void {
		this.active?.invalidate?.();
		this.onChange();
	}

	public handleInput(data: string): void {
		this.active?.handleInput?.(data);
		this.onChange();
	}

	public render(width: number): string[] {
		return this.active?.render(width) ?? [];
	}

	private activate(entry: QueuedOverlay): void {
		this.activeKind = entry.kind;
		this.activeResolve = entry.resolve;
		this.finish = (value: OverlayValue) => {
			this.active = undefined;
			this.activeKind = undefined;
			this.finish = undefined;
			this.activeResolve = undefined;
			entry.resolve(value);
			this.activateNext();
			this.onChange();
		};
		this.active = entry.create((value) => this.finish?.(value));
	}

	private activateNext(): void {
		if (this.active) return;
		const next = this.queue.shift();
		if (!next) return;
		this.activate(next);
	}
}
