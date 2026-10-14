/**
 * Numeric field that accepts expressions ("width / 2 + 3"), shows the
 * evaluated result, and lets you drag its label to scrub the value, with
 * arrow keys nudging it (Shift x10, Alt x0.1).
 */
import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { type QuantityKind, documentEvaluator, formatQuantity, trim } from "@whittle/core";
import { commitSession, useApp } from "../state/store";

interface Props {
  label: string;
  value: string;
  kind: QuantityKind;
  onChange: (expr: string, live: boolean) => void;
  hint?: string;
  autoFocus?: boolean;
  min?: number;
}

export function ExprInput({ label, value, kind, onChange, hint, autoFocus, min }: Props) {
  const doc = useApp((s) => s.doc);
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrub = useRef<{ x: number; base: number; moved: boolean } | null>(null);

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
  const showResult = result.ok && !isPlainNumber;

  const commit = (t: string, live = false) => {
    if (ev.eval(t, kind).ok) onChange(t, live);
  };

  const nudge = (dir: number, e: KeyboardEvent) => {
    if (!result.ok) return;
    const step = (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * (kind === "count" ? 1 : 1);
    let display = result.value / factor + dir * step;
    if (min !== undefined) display = Math.max(min, display);
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
    <div className={`field ${result.ok ? "" : "field--error"}`}>
      <label className="field__label scrub" title="Drag to change" onPointerDown={onLabelDown} onPointerMove={onLabelMove} onPointerUp={onLabelUp}>
        {label}
      </label>
      <div className="field__box">
        <input
          ref={inputRef}
          className="field__input mono"
          value={text}
          spellCheck={false}
          onFocus={(e) => {
            setFocused(true);
            e.target.select();
          }}
          onBlur={() => {
            setFocused(false);
            if (ev.eval(text, kind).ok) onChange(text, false);
            else setText(value);
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
              (e.target as HTMLInputElement).blur();
              // In a feature panel, Enter also means OK (like every dialog).
              const s = useApp.getState();
              if (s.session && s.mode.kind === "model") setTimeout(commitSession, 0);
            } else if (e.key === "Escape") {
              setText(value);
              (e.target as HTMLInputElement).blur();
              e.stopPropagation();
            }
            e.stopPropagation();
          }}
        />
        {unitLabel && <span className="field__unit">{unitLabel}</span>}
      </div>
      {showResult && <div className="field__result mono">= {formatQuantity(result.value, kind, unit)}</div>}
      {!result.ok && <div className="field__error">{result.error}</div>}
      {hint && result.ok && !showResult && <div className="field__hint">{hint}</div>}
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
  return (
    <div className="field">
      {label && <span className="field__label">{label}</span>}
      <div className="seg" role="radiogroup">
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

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle__track" aria-hidden="true" />
      <span className="toggle__label">{label}</span>
      {hint && <span className="toggle__hint">{hint}</span>}
    </label>
  );
}