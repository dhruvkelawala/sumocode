import type { Component } from "@earendil-works/pi-tui";

interface QueuedOverlay {
	readonly kind: string;
	readonly create: (done: (value: unknown) => void) => Component;
	readonly resolve: (value: unknown) => void;
}

export class RpcHostOverlayManager implements Component {
	private active: Component | undefined;
	private activeKind: string | undefined;
	private finish: ((value: unknown) => void) | undefined;
	private readonly queue: QueuedOverlay[] = [];

	public constructor(private readonly onChange: () => void = () => undefined) {}

	public show<T>(
		kind: string,
		create: (done: (value: T) => void) => Component,
	): Promise<T> {
		return new Promise<T>((resolve) => {
			const entry: QueuedOverlay = {
				kind,
				create: create as (done: (value: unknown) => void) => Component,
				resolve: resolve as (value: unknown) => void,
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

	public close(value?: unknown): void {
		if (!this.active && !this.finish) return;
		const finish = this.finish;
		this.active = undefined;
		this.activeKind = undefined;
		this.finish = undefined;
		finish?.(value);
		this.activateNext();
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
		this.finish = (value: unknown) => {
			this.active = undefined;
			this.activeKind = undefined;
			this.finish = undefined;
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
