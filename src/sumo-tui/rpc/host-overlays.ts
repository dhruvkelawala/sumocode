import type { Component } from "@earendil-works/pi-tui";

export class RpcHostOverlayManager implements Component {
	private active: Component | undefined;
	private activeKind: string | undefined;
	private finish: ((value: unknown) => void) | undefined;

	public constructor(private readonly onChange: () => void = () => undefined) {}

	public show<T>(
		kind: string,
		create: (done: (value: T) => void) => Component,
	): Promise<T> {
		this.close();
		return new Promise<T>((resolve) => {
			this.activeKind = kind;
			this.finish = (value: unknown) => {
				this.active = undefined;
				this.activeKind = undefined;
				this.finish = undefined;
				resolve(value as T);
				this.onChange();
			};
			this.active = create((value) => this.finish?.(value));
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
}
