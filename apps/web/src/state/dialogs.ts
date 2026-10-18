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
  /** Quick values shown as chips under the field. */
  choices?: { label: string; value: string }[];
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

/** Where on the canvas a value is asked for in place, instead of in a dialog (set by the viewport). */
export interface InlinePromptRequest {
  at: [number, number];
  title: string;
  label: string;
  initial: string;
  unit?: string;
  validate?: (v: string) => string | null;
  /** Called with the text as it is typed (and once at the start), e.g. to preview the result. */
  onInput?: (v: string) => void;
  resolve: (v: string | null) => void;
}
export const inlinePromptHost: { show: ((r: InlinePromptRequest) => void) | null } = { show: null };

/** Ask for a value. Resolves null when cancelled. With `at` (canvas pixels) the box opens right there. */
export function promptDialog(opts: {
  at?: [number, number];
  title: string;
  label: string;
  message?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  type?: PromptRequest["type"];
  unit?: string;
  validate?: (v: string) => string | null;
  onInput?: (v: string) => void;
  choices?: { label: string; value: string }[];
}): Promise<string | null> {
  if (opts.at && inlinePromptHost.show) {
    const show = inlinePromptHost.show;
    return new Promise((resolve) => show({ at: opts.at!, title: opts.title, label: opts.label, initial: opts.initial ?? "", unit: opts.unit, validate: opts.validate, onInput: opts.onInput, resolve }));
  }
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
      choices: opts.choices,
      resolve,
    }),
  );
}
