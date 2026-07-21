/**
 * Generic undo stack with clone-on-push semantics.
 *
 * Stores deep clones of state snapshots. Popped snapshots are returned
 * directly (no re-cloning) since they are already detached.
 */
export class UndoStack<S> {
	private static readonly MAX_ENTRIES = 200;

	private stack: S[] = [];

	/** Push a deep clone of the given state onto the stack, dropping the oldest snapshot when full. */
	push(state: S): void {
		if (this.stack.length >= UndoStack.MAX_ENTRIES) {
			this.stack.shift();
		}
		this.stack.push(structuredClone(state));
	}

	/** Pop and return the most recent snapshot, or undefined if empty. */
	pop(): S | undefined {
		return this.stack.pop();
	}

	/** Remove all snapshots. */
	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
