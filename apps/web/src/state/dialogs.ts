/**
 * In-app confirmation and input dialogs. They replace the browser's confirm()
 * and prompt(): same look on every platform, keyboard friendly, and they
 * can validate input before it's accepted. Each call returns a promise.
 */
import { create } from "zustand";

export interface ConfirmRequest {
  kind: "confirm";
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  /** Extra detail lines (e.g. what will be affected). */
  details?: string[];
  resolve: (ok: boolean) => void;
}

export interface PromptRequest {
  kind: "prompt";
  title: string;
  message?: string;
  label: string;
  initial: string;
  placeholder?: string;
  confirmLabel: string;
  type: "text" | "password" | "number" | "email";
  /** Unit shown after a number. */
  unit?: string;
  validate?: (v: string) => string | null;
  resolve: (v: string | null) => void;
}

export type DialogRequest = ConfirmRequest | PromptRequest;

export const useDialogs = create<{ queue: DialogRequest[] }>(() => ({ queue: [] }));

function open(req: DialogRequest) {
  useDialogs.setState((s) => ({ queue: [...s.queue, req] }));
}

export function closeDialog(req: DialogRequest) {
  useDialogs.setState((s) => ({ queue: s.queue.filter((x) => x !== req) }));
}

/** Ask a yes/no question. Resolves true when confirmed. */
export function confirmDialog(opts: { title: string; message: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; details?: string[] }): Promise<boolean> {
  return new Promise((resolve) =>
    open({
      kind: "confirm",
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? "OK",
      cancelLabel: opts.cancelLabel ?? "Cancel",
      danger: opts.danger ?? false,
      details: opts.details,
      resolve,
    }),
  );
}

/** Ask for a value. Resolves null when cancelled. */
export function promptDialog(opts: {
  title: string;
  label: string;
  message?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  type?: PromptRequest["type"];
  unit?: string;
  validate?: (v: string) => string | null;
}): Promise<string | null> {
  return new Promise((resolve) =>
    open({
      kind: "prompt",
      title: opts.title,
      message: opts.message,
      label: opts.label,
      initial: opts.initial ?? "",
      placeholder: opts.placeholder,
      confirmLabel: opts.confirmLabel ?? "OK",
      type: opts.type ?? "text",
      unit: opts.unit,
      validate: opts.validate,
      resolve,
    }),
  );
}
