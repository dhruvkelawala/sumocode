export interface KeyEvent {
	key: string;
	sequence?: string;
	ctrl?: boolean;
	alt?: boolean;
	shift?: boolean;
}

export type KeyHandler = (event: KeyEvent) => boolean | void;

export interface KeyTarget {
	handleKey(event: KeyEvent): boolean | void;
}

function normalizeKey(event: string | KeyEvent): KeyEvent {
	return typeof event === "string" ? { key: event } : event;
}

/** Minimal focus-aware keybinding registry for sumo-tui widgets. */
export class KeyRouter {
	private readonly bindings = new Map<string, KeyHandler>();
	private focusedTarget: KeyTarget | undefined;

	public setFocus(target: KeyTarget | undefined): void {
		this.focusedTarget = target;
	}

	public getFocus(): KeyTarget | undefined {
		return this.focusedTarget;
	}

	public bind(key: string, handler: KeyHandler): () => void {
		this.bindings.set(key, handler);
		return () => this.unbind(key);
	}

	public unbind(key: string): void {
		this.bindings.delete(key);
	}

	public dispatch(event: string | KeyEvent): boolean {
		const keyEvent = normalizeKey(event);
		if (this.focusedTarget?.handleKey(keyEvent) === true) return true;
		return this.bindings.get(keyEvent.key)?.(keyEvent) === true;
	}
}
