// Generic bounded undo/redo history stack.
// The controller captures/restores snapshots; this class only manages the stacks.

export class HistoryStack<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];

  constructor(private limit = 50) {}

  /** Push a new snapshot; clears the redo stack and trims to `limit`. */
  push(snapshot: T): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Drop the most recently pushed snapshot (e.g. a rejected edit). */
  discardLast(): void {
    this.undoStack.pop();
  }

  /** Pop an undo snapshot; `current` is pushed onto the redo stack. */
  undo(current: T): T | null {
    const snap = this.undoStack.pop();
    if (snap === undefined) return null;
    this.redoStack.push(current);
    return snap;
  }

  /** Pop a redo snapshot; `current` is pushed onto the undo stack. */
  redo(current: T): T | null {
    const snap = this.redoStack.pop();
    if (snap === undefined) return null;
    this.undoStack.push(current);
    return snap;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
