/** One periodic fallback for active terminals; no filesystem notification is required. */
export class TerminalSupervisor {
	private readonly active = new Set<string>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private disposed = false;
	public callbacks = 0;

	public constructor(private readonly intervalMs: number, private readonly tick: (ids: readonly string[]) => void) {}

	public add(id: string): void {
		if (this.disposed) return;
		this.active.add(id);
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.callbacks += 1;
			this.tick([...this.active]);
		}, this.intervalMs);
		this.timer.unref?.();
	}

	public delete(id: string): void {
		this.active.delete(id);
		if (this.active.size > 0) return;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	public dispose(): void {
		this.disposed = true;
		this.active.clear();
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}
