/**
 * Numeric field that accepts expressions ("width / 2 + 3"), shows the
 * evaluated result, and lets you drag its label to scrub the value, with
 * arrow keys nudging it (Shift x10, Alt x0.1).
 */
import { type KeyboardEvent, type PointerEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { type QuantityKind, documentEvaluator, formatQuantity, trim } from "@whittle/core";
import { cancelSession, commitSession, toast, useApp } from "../state/store";
import { Switch } from "./controls";

interface Props {
  label: string;
  value: string;
  kind: QuantityKind;
  onChange: (expr: string, live: boolean) => void;
  hint?: string;
  autoFocus?: boolean;
  /** Smallest allowed value (in the units shown): anything less is refused with a message, not applied. */
  min?: number;
  /** Largest allowed value, such as the biggest corner radius that fits: anything more is refused, not applied. */
  max?: number;
}

export function ExprInput({ label, value, kind, onChange, hint, autoFocus, min, max }: Props) {
  const doc = useApp((s) => s.doc);
  const id = useId();
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrub = useRef<{ x: number; base: number; moved: boolean } | null>(null);
  // The value when editing started: what an out-of-range entry goes back to.
  const before = useRef(value);

  useEffect(() => {
    if (!focused) setText(value);
  }, [value, focused]);

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [autoFocus]);

  const ev = useMemo(() => documentEvaluator(doc), [doc]);
  const result = ev.eval(text, kind);
  const unit = doc.units;
  const factor = kind === "length" ? (unit === "in" ? 25.4 : unit === "cm" ? 10 : unit === "m" ? 1000 : unit === "ft" ? 304.8 : 1) : kind === "angle" ? Math.PI / 180 : 1;
  const unitLabel = kind === "length" ? unit : kind === "angle" ? "\u00b0" : "";
  const isPlainNumber = /^\s*-?\d*\.?\d+\s*$/.test(text);
  /** Why a typed value can't be used: it doesn't evaluate, or it is outside the field's range. */
  const problem = (t: string): string | null => {
    const r = ev.eval(t, kind);
    if (!r.ok) return r.error;
    const v = r.value / factor;
    const u = kind === "length" ? ` ${unitLabel}` : unitLabel;
    if (min !== undefined && v < min - 1e-9) return `${label} can't be less than ${trim(min, 2)}${u}.`;
    if (max !== undefined && v > max + 1e-6) return `${label}: ${trim(v, 2)}${u} is too big. The largest that fits is ${trim(max, 2)}${u}.`;
    return null;
  };
  const error = problem(text);
  const showResult = result.ok && !error && !isPlainNumber;

  const commit = (t: string, live = false) => {
    if (!problem(t)) onChange(t, live);
    // While the entry is out of range the model keeps the value it had, not the last keystroke that fitted.
    else if (ev.eval(t, kind).ok && before.current !== value) onChange(before.current, live);
  };

  const nudge = (dir: number, e: KeyboardEvent) => {
    if (!result.ok) return;
    const step = (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * (kind === "count" ? 1 : 1);
    let display = result.value / factor + dir * step;
    if (min !== undefined) display = Math.max(min, display);
    if (max !== undefined) display = Math.min(max, display);
    const t = trim(display, 4);
    setText(t);
    commit(t, true);
  };

  const onLabelDown = (e: PointerEvent<HTMLLabelElement>) => {
    if (!result.ok) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    scrub.current = { x: e.clientX, base: result.value / factor, moved: false };
  };
  const onLabelMove = (e: PointerEvent<HTMLLabelElement>) => {
    const s = scrub.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    if (Math.abs(dx) > 2) s.moved = true;
    if (!s.moved) return;
    const per = kind === "count" ? 0.1 : e.shiftKey ? 1 : e.altKey ? 0.01 : 0.1 * Math.max(1, Math.abs(s.base) / 20);
    let v = s.base + dx * per;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    const t = kind === "count" ? String(Math.round(v)) : trim(Math.round(v * 100) / 100, 2);
    setText(t);
    commit(t, true);
  };
  const onLabelUp = () => {
    const s = scrub.current;
    scrub.current = null;
    if (s && !s.moved) inputRef.current?.focus();
  };

  return (
    <div className={`field ${error ? "field--error" : ""}`}>
      <label htmlFor={id} className="field__label scrub" title="Drag to change" onPointerDown={onLabelDown} onPointerMove={onLabelMove} onPointerUp={onLabelUp} onPointerCancel={() => (scrub.current = null)}>
        {label}
      </label>
      <div className="field__box">
        <input
          id={id}
          ref={inputRef}
          className="field__input mono"

          value={text}
          spellCheck={false}
          onFocus={(e) => {
            before.current = value;
            setFocused(true);
            e.target.select();
          }}
          onBlur={() => {
            setFocused(false);
            if (!error) onChange(text, false);
            else {
              // Refused, as a dialog would: say why and keep the value it had.
              if (result.ok) toast("info", error);
              setText(before.current);
              if (before.current !== value) onChange(before.current, false);
            }
          }}
          onChange={(e) => {
            setText(e.target.value);
            commit(e.target.value, true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              nudge(1, e);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              nudge(-1, e);
            } else if (e.key === "Enter") {
              // A refused value stays in the box with its message, to fix or Esc.
              if (error) {
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              (e.target as HTMLInputElement).blur();
              // In a feature panel, Enter also means OK (like every dialog).
              const s = useApp.getState();
              if (s.session && s.mode.kind === "model") setTimeout(() => commitSession(true), 0);
            } else if (e.key === "Escape") {
              // First Esc undoes the typing; with nothing typed, Esc cancels the feature as it does everywhere else.
              const typed = text !== value;
              setText(value);
              (e.target as HTMLInputElement).blur();
              const s = useApp.getState();
              if (!typed && s.session && s.mode.kind === "model") setTimeout(cancelSession, 0);
            }
            e.stopPropagation();
          }}
        />
        {unitLabel && <span className="field__unit">{unitLabel}</span>}
      </div>
      {showResult && <div className="field__result mono">= {formatQuantity(result.value, kind, unit)}</div>}
      {error && <div className="field__error" role="alert">{error}</div>}
      {hint && !error && !showResult && <div className="field__hint">{hint}</div>}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  // Three or more choices get the panel's full width under their label: beside it they wrapped into ragged rows.
  return (
    <div className={`field ${options.length > 2 ? "field--stack" : ""}`}>
      {label && <span className="field__label">{label}</span>}
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            className={`seg__btn ${o.value === value ? "is-on" : ""}`}
            title={o.title}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** On/off option (an app-drawn switch, never a native checkbox). */
export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return <Switch label={label} checked={checked} onChange={onChange} hint={hint} />;
}
