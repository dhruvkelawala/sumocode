export interface WorkerJobContext {
	readonly id: number;
	readonly name: string;
	readonly exclusiveGroup?: string;
	readonly signal: AbortSignal;
	isCurrent(): boolean;
}

export interface WorkerStartOptions<T> {
	readonly name: string;
	readonly exclusiveGroup?: string;
	run(context: WorkerJobContext): Promise<T> | T;
}

export type WorkerRunResult<T> =
	| { readonly status: "completed"; readonly value: T }
	| { readonly status: "cancelled"; readonly id: number; readonly name: string; readonly exclusiveGroup?: string }
	| { readonly status: "failed"; readonly error: unknown };

export interface WorkerHandle<T> {
	readonly id: number;
	readonly name: string;
	readonly exclusiveGroup?: string;
	readonly signal: AbortSignal;
	readonly result: Promise<WorkerRunResult<T>>;
	isCurrent(): boolean;
	cancel(): void;
}

interface MutableWorkerHandle<T> extends WorkerHandle<T> {
	readonly controller: AbortController;
}

/**
 * Small in-process async worker coordinator.
 *
 * Jobs are still normal JS promises; cancellation is cooperative via
 * `AbortSignal`. For work that cannot be interrupted, exclusive groups still
 * invalidate stale completions so older async results cannot overwrite newer UI
 * state when they eventually resolve.
 */
export class CancellableWorkerRuntime {
	private nextId = 0;
	private readonly exclusiveWorkers = new Map<string, MutableWorkerHandle<unknown>>();

	public start<T>(options: WorkerStartOptions<T>): WorkerHandle<T> {
		const id = ++this.nextId;
		const controller = new AbortController();
		let handle: MutableWorkerHandle<T>;
		let resolveResult!: (result: WorkerRunResult<T>) => void;
		const result = new Promise<WorkerRunResult<T>>((resolve) => {
			resolveResult = resolve;
		});
		const isCurrent = (): boolean => !options.exclusiveGroup || this.exclusiveWorkers.get(options.exclusiveGroup) === handle;
		handle = {
			id,
			name: options.name,
			exclusiveGroup: options.exclusiveGroup,
			signal: controller.signal,
			controller,
			isCurrent,
			cancel: () => controller.abort(),
			result,
		};

		if (options.exclusiveGroup) {
			this.exclusiveWorkers.get(options.exclusiveGroup)?.cancel();
			this.exclusiveWorkers.set(options.exclusiveGroup, handle as MutableWorkerHandle<unknown>);
		}

		void this.execute(options, handle).then(resolveResult);
		return handle;
	}

	public cancelGroup(exclusiveGroup: string): boolean {
		const current = this.exclusiveWorkers.get(exclusiveGroup);
		if (!current) return false;
		current.cancel();
		this.exclusiveWorkers.delete(exclusiveGroup);
		return true;
	}

	private async execute<T>(options: WorkerStartOptions<T>, handle: MutableWorkerHandle<T>): Promise<WorkerRunResult<T>> {
		try {
			const value = await options.run({
				id: handle.id,
				name: options.name,
				exclusiveGroup: options.exclusiveGroup,
				signal: handle.signal,
				isCurrent: handle.isCurrent,
			});
			if (handle.signal.aborted || !handle.isCurrent()) return this.cancelled(handle);
			return { status: "completed", value };
		} catch (error) {
			if (handle.signal.aborted || !handle.isCurrent()) return this.cancelled(handle);
			return { status: "failed", error };
		} finally {
			if (handle.exclusiveGroup && this.exclusiveWorkers.get(handle.exclusiveGroup) === handle) {
				this.exclusiveWorkers.delete(handle.exclusiveGroup);
			}
		}
	}

	private cancelled(handle: WorkerHandle<unknown>): WorkerRunResult<never> {
		return {
			status: "cancelled",
			id: handle.id,
			name: handle.name,
			exclusiveGroup: handle.exclusiveGroup,
		};
	}
}
