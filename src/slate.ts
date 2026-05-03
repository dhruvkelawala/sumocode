/**
 * Slate — session-scoped idea parking lot.
 *
 * Pure state module: an ordered list of freeform text items the user parks
 * for later. Items are added via `/slate <text>`, reviewed via a Divine Query
 * modal, and resolved after the agent completes them with user approval.
 *
 * Persistence: `pi.appendEntry("slate", { items })` on session_shutdown;
 * reconstruct from session entries on session_start.
 */

const SLATE_ENTRY_TYPE = "slate";

export interface SlateEntry {
	readonly customType: string;
	readonly data?: { items?: string[] };
	readonly type?: string;
}

export class Slate {
	private items: string[] = [];

	public add(text: string): number {
		this.items.push(text);
		return this.items.length;
	}

	public list(): readonly string[] {
		return this.items;
	}

	public get length(): number {
		return this.items.length;
	}

	public get isEmpty(): boolean {
		return this.items.length === 0;
	}

	/**
	 * Remove item at 1-based index. No argument or 0 pops the first item.
	 * Returns the removed text, or undefined if index is out of bounds.
	 */
	public remove(oneBasedIndex?: number): string | undefined {
		const index = (oneBasedIndex ?? 1) - 1;
		if (index < 0 || index >= this.items.length) return undefined;
		return this.items.splice(index, 1)[0];
	}

	/** Remove and return the first item (stack pop). */
	public pop(): string | undefined {
		return this.remove(1);
	}

	public clear(): number {
		const count = this.items.length;
		this.items = [];
		return count;
	}

	/** Serialize for `pi.appendEntry`. */
	public toJSON(): { items: string[] } {
		return { items: [...this.items] };
	}

	/**
	 * Reconstruct from session entries. Takes the latest slate entry
	 * (last write wins across compactions/resumes).
	 */
	public static fromEntries(entries: readonly SlateEntry[]): Slate {
		const slate = new Slate();
		let latestItems: string[] | undefined;
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === SLATE_ENTRY_TYPE && Array.isArray(entry.data?.items)) {
				latestItems = entry.data!.items!;
			}
		}
		if (latestItems) slate.items = [...latestItems];
		return slate;
	}

	/** Format for the agent's `slate_list` tool response. */
	public formatForAgent(): string {
		if (this.items.length === 0) return "The slate is empty. No parked ideas.";
		const lines = this.items.map((item, index) => `${index + 1}. ${item}`);
		return `Slated items (${this.items.length}):\n${lines.join("\n")}`;
	}
}

export const SLATE_CUSTOM_TYPE = SLATE_ENTRY_TYPE;
