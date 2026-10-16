/** Things the person is waiting for (saving, opening, exporting, checking), shown in the status bar. */
import { create } from "zustand";

export interface Task {
  id: number;
  label: string;
  /** 0..1, or null when the length of the wait isn't known. */
  progress: number | null;
}

export const useTasks = create<{ tasks: Task[] }>(() => ({ tasks: [] }));

let next = 0;

export interface TaskHandle {
  update(progress: number | null, label?: string): void;
  done(): void;
}

export function startTask(label: string, progress: number | null = null): TaskHandle {
  const id = ++next;
  useTasks.setState((s) => ({ tasks: [...s.tasks, { id, label, progress }] }));
  return {
    update: (p, l) => useTasks.setState((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, progress: p, label: l ?? t.label } : t)) })),
    done: () => useTasks.setState((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
  };
}

/** Run `fn` with a visible task for as long as it takes. */
export async function withTask<T>(label: string, fn: (task: TaskHandle) => Promise<T>): Promise<T> {
  const task = startTask(label);
  try {
    return await fn(task);
  } finally {
    task.done();
  }
}
