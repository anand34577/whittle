/**
 * Command history built on Immer patches. Every user action is a labelled
 * command that records forward and inverse patches, giving unlimited undo/redo
 * and a replayable log (the basis for autosave, recovery and future collab).
 */
import { type Draft, type Patch, applyPatches, enablePatches, produceWithPatches } from "immer";

enablePatches();

export interface HistoryEntry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  at: number;
  /** Commands with the same merge key within a short window collapse into one undo step. */
  mergeKey?: string;
}

export class History<T> {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(private readonly limit = 500) {}

  apply(
    state: T,
    label: string,
    recipe: (draft: Draft<T>) => void,
    mergeKey?: string,
  ): T {
    const [next, patches, inverse] = produceWithPatches(state, recipe);
    if (patches.length === 0) return state;
    const now = Date.now();
    const top = this.undoStack[this.undoStack.length - 1];
    if (mergeKey && top && top.mergeKey === mergeKey && now - top.at < 1500) {
      top.patches = [...top.patches, ...patches];
      top.inverse = [...inverse, ...top.inverse];
      top.at = now;
    } else {
      this.undoStack.push({ label, patches, inverse, at: now, mergeKey });
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.redoStack = [];
    return next as T;
  }

  undo(state: T): { state: T; label: string } | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(entry);
    return { state: applyPatches(state as object, entry.inverse) as T, label: entry.label };
  }

  redo(state: T): { state: T; label: string } | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push({ ...entry, mergeKey: undefined });
    return { state: applyPatches(state as object, entry.patches) as T, label: entry.label };
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get undoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label;
  }
  get redoLabel(): string | undefined {
    return this.redoStack[this.redoStack.length - 1]?.label;
  }
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}