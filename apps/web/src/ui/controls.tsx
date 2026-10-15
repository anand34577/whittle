/**
 * Whittle's own form controls. Nothing here renders a native browser widget:
 * selects, checkboxes, switches, sliders, number steppers and the color
 * picker are drawn and driven by the app, so they look and behave the same
 * on every platform and theme, and are fully keyboard accessible.
 */
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./icons";

/* ───────────────────────────── Popover ───────────────────────────── */

/**
 * A floating layer anchored to an element, rendered at the document root so
 * panels with overflow never clip it. Flips above the anchor when there's no
 * room below, and closes on outside press or Escape.
 */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  matchWidth,
  className = "",
  placement = "bottom-start",
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  matchWidth?: boolean;
  className?: string;
  placement?: "bottom-start" | "bottom-end";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const el = ref.current;
      const h = el?.offsetHeight ?? 0;
      const w = Math.max(el?.offsetWidth ?? 0, matchWidth ? a.width : 0);
      const below = window.innerHeight - a.bottom - 8;
      const top = below >= h || a.top < h ? Math.min(a.bottom + 4, window.innerHeight - h - 8) : a.top - h - 4;
      let left = placement === "bottom-end" ? a.right - w : a.left;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      setStyle({ top: Math.max(8, top), left, minWidth: matchWidth ? a.width : undefined });
    };
    place();
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, matchWidth, placement]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor?.contains(t)) onClose();
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        anchor?.focus();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open, onClose, anchor]);

  if (!open) return null;
  return createPortal(
    <div ref={ref} className={`popover ${className}`} style={style} onKeyDown={(e) => e.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}

/* ───────────────────────────── Select ───────────────────────────── */

export interface Option<T extends string> {
  value: T;
  label: string;
  hint?: string;
  group?: string;
  icon?: IconName;
  /** A color dot before the label (e.g. a body's color). */
  swatch?: string;
  disabled?: boolean;
}

/** A dropdown list: type to jump, arrows to move, Enter to choose. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder = "Choose…",
  label,
  size = "md",
  ariaLabel,
  className = "",
}: {
  value: T | "" | undefined;
  options: Option<T>[];
  onChange: (v: T) => void;
  placeholder?: string;
  label?: string;
  size?: "sm" | "md";
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const id = useId();
  const current = options.find((o) => o.value === value);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);

  const openList = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    setOpen(false);
    btn.current?.focus();
    if (o.value !== value) onChange(o.value);
  };
  const move = (dir: number) => {
    if (!enabled.length) return;
    const pos = enabled.indexOf(active);
    const next = enabled[Math.max(0, Math.min(enabled.length - 1, (pos < 0 ? 0 : pos) + dir))]!;
    setActive(next);
  };

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const onKey = (e: KeyboardEvent) => {
    // A closed list lets Escape and Tab reach the dialog around it.
    if (!open && (e.key === "Escape" || e.key === "Tab")) return;
    e.stopPropagation();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return openList();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Home" && open) {
      e.preventDefault();
      setActive(enabled[0] ?? 0);
    } else if (e.key === "End" && open) {
      e.preventDefault();
      setActive(enabled[enabled.length - 1] ?? 0);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open) choose(active);
      else openList();
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "Tab") {
      setOpen(false);
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      // Type-ahead: jump to the first option starting with what was typed.
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + e.key.toLowerCase(), at: now };
      const hit = options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(typed.current.text));
      if (hit >= 0) {
        if (open) setActive(hit);
        else if (options[hit]!.value !== value) onChange(options[hit]!.value);
      }
    }
  };

  let lastGroup: string | undefined;
  const control = (
    <>
      <button
        ref={btn}
        type="button"
        className={`select-btn select-btn--${size} ${open ? "is-open" : ""} ${className}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={ariaLabel ?? label}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKey}
      >
        {current?.swatch && <span className="select-btn__swatch" style={{ background: current.swatch }} />}
        {current?.icon && <Icon name={current.icon} size={15} />}
        <span className={`select-btn__text ${current ? "" : "is-placeholder"}`}>{current?.label ?? placeholder}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} matchWidth className="listbox">
        <div ref={list} role="listbox" id={id} aria-label={ariaLabel ?? label}>
          {options.length === 0 && <div className="listbox__empty">Nothing to choose</div>}
          {options.map((o, i) => {
            const head = o.group && o.group !== lastGroup ? o.group : null;
            lastGroup = o.group;
            return (
              <div key={o.value}>
                {head && <div className="listbox__group">{head}</div>}
                <div
                  role="option"
                  data-i={i}
                  aria-selected={o.value === value}
                  aria-disabled={o.disabled}
                  className={`listbox__item ${i === active ? "is-active" : ""} ${o.value === value ? "is-selected" : ""} ${o.disabled ? "is-disabled" : ""}`}
                  onPointerEnter={() => !o.disabled && setActive(i)}
                  onClick={() => choose(i)}
                >
                  {o.swatch && <span className="select-btn__swatch" style={{ background: o.swatch }} />}
                  {o.icon && <Icon name={o.icon} size={15} />}
                  <span className="listbox__text">
                    <span>{o.label}</span>
                    {o.hint && <small>{o.hint}</small>}
                  </span>
                  {o.value === value && <Icon name="check" size={14} />}
                </div>
              </div>
            );
          })}
        </div>
      </Popover>
    </>
  );
  if (!label) return control;
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      {control}
    </div>
  );
}

/* ───────────────────────────── Checkbox & switch ───────────────────────────── */

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled,
  mixed,
  className = "",
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  hint?: string;
  disabled?: boolean;
  /** Partly selected (shows a dash). */
  mixed?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={mixed ? "mixed" : checked}
      disabled={disabled}
      className={`check ${checked ? "is-on" : ""} ${className}`}
      onClick={() => onChange(!checked)}
    >
      <span className="check__box" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          {mixed ? <path d="M4 8 H12" /> : <path d="M3.5 8.5 L6.5 11.5 L12.5 4.5" />}
        </svg>
      </span>
      {label !== undefined && (
        <span className="check__text">
          <span>{label}</span>
          {hint && <small>{hint}</small>}
        </span>
      )}
    </button>
  );
}

/** An on/off switch with a label (and optional hint underneath). */
export function Switch({ label, checked, onChange, hint, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; hint?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} className={`switch ${checked ? "is-on" : ""}`} onClick={() => onChange(!checked)}>
      <span className="switch__track" aria-hidden="true">
        <span className="switch__thumb" />
      </span>
      <span className="switch__text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
    </button>
  );
}

/* ───────────────────────────── Number stepper ───────────────────────────── */

/** A compact number field with − / + buttons (no native spinners). */
export function NumberField({
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  ariaLabel,
  unit,
  width,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  ariaLabel: string;
  unit?: string;
  width?: number;
}) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const commit = (t: string) => {
    const v = parseFloat(t);
    if (Number.isFinite(v)) onChange(clamp(v));
    else setText(String(value));
  };
  const bump = (dir: number, big = false) => onChange(clamp(Math.round((value + dir * step * (big ? 10 : 1)) * 1e6) / 1e6));
  return (
    <span className="stepper" style={width ? { width } : undefined}>
      <button type="button" className="stepper__btn" aria-label={`Decrease ${ariaLabel}`} disabled={value <= min} onClick={(e) => bump(-1, e.shiftKey)}>
        <Icon name="minus" size={12} />
      </button>
      <input
        className="stepper__input mono"
        value={text}
        inputMode="decimal"
        aria-label={ariaLabel}
        spellCheck={false}
        onFocus={(e) => {
          setFocused(true);
          e.target.select();
        }}
        onBlur={() => {
          setFocused(false);
          commit(text);
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            bump(e.key === "ArrowUp" ? 1 : -1, e.shiftKey);
          }
        }}
      />
      {unit && <span className="stepper__unit">{unit}</span>}
      <button type="button" className="stepper__btn" aria-label={`Increase ${ariaLabel}`} disabled={value >= max} onClick={(e) => bump(1, e.shiftKey)}>
        <Icon name="plus" size={12} />
      </button>
    </span>
  );
}

/* ───────────────────────────── Slider ───────────────────────────── */

export function Slider({
  value,
  min,
  max,
  step = 0,
  onChange,
  ariaLabel,
  format,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  ariaLabel: string;
  format?: (v: number) => string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const span = max - min || 1;
  const t = Math.min(1, Math.max(0, (value - min) / span));
  const snap = (v: number) => {
    const c = Math.min(max, Math.max(min, v));
    return step > 0 ? Math.round((c - min) / step) * step + min : c;
  };
  const fromPointer = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    onChange(snap(min + ((clientX - r.left) / r.width) * span));
  };
  const keyStep = step > 0 ? step : span / 100;
  return (
    <div
      ref={track}
      className="slider"
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={format?.(value)}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        fromPointer(e.clientX);
      }}
      onPointerMove={(e) => e.buttons & 1 && fromPointer(e.clientX)}
      onKeyDown={(e) => {
        const k = e.shiftKey ? 10 : 1;
        if (e.key === "ArrowRight" || e.key === "ArrowUp") onChange(snap(value + keyStep * k));
        else if (e.key === "ArrowLeft" || e.key === "ArrowDown") onChange(snap(value - keyStep * k));
        else if (e.key === "Home") onChange(min);
        else if (e.key === "End") onChange(max);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <span className="slider__rail" />
      <span className="slider__fill" style={{ width: `${t * 100}%` }} />
      <span className="slider__thumb" style={{ left: `${t * 100}%` }} />
    </div>
  );
}

/* ───────────────────────────── Color picker ───────────────────────────── */

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h.padEnd(6, "0").slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) || 0) as [number, number, number];
}
const toHex = (r: number, g: number, b: number) => "#" + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");

function rgbToHsv([r, g, b]: [number, number, number]): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [((h * 60) + 360) % 360, mx ? d / mx : 0, mx];
}

function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return toHex(f(5) * 255, f(3) * 255, f(1) * 255);
}

export const isHex = (s: string) => /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s.trim());

/** Saturation/value square, hue strip, hex entry and preset swatches. */
export function ColorPicker({ value, onChange, presets = [], label = "Color" }: { value: string; onChange: (hex: string, live: boolean) => void; presets?: string[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={btn} type="button" className="colorbtn" style={{ background: value }} aria-label={`${label}: ${value}`} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        <Icon name="plus" size={12} />
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} className="colorpop">
        <ColorPanel value={value} onChange={onChange} presets={presets} />
      </Popover>
    </>
  );
}

export function ColorPanel({ value, onChange, presets = [] }: { value: string; onChange: (hex: string, live: boolean) => void; presets?: string[] }) {
  const [hsv, setHsv] = useState(() => rgbToHsv(hexToRgb(value)));
  const [hex, setHex] = useState(value);
  const sv = useRef<HTMLDivElement>(null);
  const hue = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Follow outside changes without fighting the drag.
    if (value.toLowerCase() !== hsvToHex(...hsv).toLowerCase()) setHsv(rgbToHsv(hexToRgb(value)));
    setHex(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const emit = (h: number, s: number, v: number, live: boolean) => {
    setHsv([h, s, v]);
    const out = hsvToHex(h, s, v);
    setHex(out);
    onChange(out, live);
  };
  const dragSV = (e: { clientX: number; clientY: number }, live: boolean) => {
    const r = sv.current!.getBoundingClientRect();
    emit(hsv[0], Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)), live);
  };
  const dragHue = (e: { clientX: number }, live: boolean) => {
    const r = hue.current!.getBoundingClientRect();
    emit(Math.min(359.9, Math.max(0, ((e.clientX - r.left) / r.width) * 360)), hsv[1], hsv[2], live);
  };
  return (
    <div className="colorpanel">
      <div
        ref={sv}
        className="colorpanel__sv"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hsvToHex(hsv[0], 1, 1)})` }}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          dragSV(e, true);
        }}
        onPointerMove={(e) => e.buttons & 1 && dragSV(e, true)}
        onPointerUp={(e) => dragSV(e, false)}
      >
        <span className="colorpanel__dot" style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%`, background: hex }} />
      </div>
      <div
        ref={hue}
        className="colorpanel__hue"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          dragHue(e, true);
        }}
        onPointerMove={(e) => e.buttons & 1 && dragHue(e, true)}
        onPointerUp={(e) => dragHue(e, false)}
      >
        <span className="colorpanel__huethumb" style={{ left: `${(hsv[0] / 360) * 100}%` }} />
      </div>
      <div className="colorpanel__row">
        <span className="colorpanel__preview" style={{ background: hex }} />
        <input
          className="input mono colorpanel__hex"
          value={hex}
          aria-label="Hex color"
          spellCheck={false}
          onChange={(e) => {
            setHex(e.target.value);
            if (isHex(e.target.value)) {
              const h = e.target.value.startsWith("#") ? e.target.value : "#" + e.target.value;
              setHsv(rgbToHsv(hexToRgb(h)));
              onChange(toHex(...hexToRgb(h)), false);
            }
          }}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>
      {presets.length > 0 && (
        <div className="colorpanel__presets">
          {presets.map((c) => (
            <button key={c} type="button" className={`swatch ${c.toLowerCase() === value.toLowerCase() ? "is-on" : ""}`} style={{ background: c }} aria-label={`Color ${c}`} onClick={() => onChange(c, false)} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── Text field ───────────────────────────── */

/** A labelled text input with an optional leading icon and password reveal. */
export function TextField({
  label,
  value,
  onChange,
  type = "text",
  icon,
  placeholder,
  autoFocus,
  autoComplete,
  required,
  hint,
  error,
  minLength,
  name,
  disabled,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "password" | "email" | "url";
  icon?: IconName;
  placeholder?: string;
  autoFocus?: boolean;
  autoComplete?: string;
  required?: boolean;
  hint?: string;
  error?: string | null;
  minLength?: number;
  name?: string;
  disabled?: boolean;
}) {
  const [reveal, setReveal] = useState(false);
  const id = useId();
  return (
    <div className={`tf ${error ? "tf--error" : ""}`}>
      {label && (
        <label className={`tf__label ${required ? "tf__label--req" : ""}`} htmlFor={id}>
          {label}
        </label>
      )}
      <div className="tf__box">
        {icon && <Icon name={icon} size={15} />}
        <input
          id={id}
          name={name}
          className="tf__input"
          type={type === "password" && reveal ? "text" : type}
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
          disabled={disabled}
          spellCheck={type === "text"}
          aria-invalid={!!error}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        {type === "password" && (
          <button type="button" className="tf__reveal" onClick={() => setReveal(!reveal)} aria-label={reveal ? "Hide password" : "Show password"} data-tip={reveal ? "Hide" : "Show"}>
            <Icon name={reveal ? "eyeOff" : "eye"} size={15} />
          </button>
        )}
      </div>
      {error ? <small className="tf__error">{error}</small> : hint ? <small className="tf__hint">{hint}</small> : null}
    </div>
  );
}

/* ───────────────────────────── Disclosure ───────────────────────────── */

/** A collapsible section (instead of the browser's <details>). */
export function Disclosure({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`disclosure ${open ? "is-open" : ""}`}>
      <button type="button" className="disclosure__head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        {summary}
      </button>
      {open && <div className="disclosure__body">{children}</div>}
    </div>
  );
}

/* ───────────────────────────── Tabs ───────────────────────────── */

export function Tabs<T extends string>({ value, tabs, onChange, vertical }: { value: T; tabs: { value: T; label: string; icon?: IconName }[]; onChange: (v: T) => void; vertical?: boolean }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = useCallback(
    (e: KeyboardEvent, i: number) => {
      const next = e.key === (vertical ? "ArrowDown" : "ArrowRight") ? i + 1 : e.key === (vertical ? "ArrowUp" : "ArrowLeft") ? i - 1 : null;
      if (next === null) return;
      e.preventDefault();
      const j = (next + tabs.length) % tabs.length;
      onChange(tabs[j]!.value);
      refs.current[j]?.focus();
    },
    [tabs, onChange, vertical],
  );
  return (
    <div className={`tabs ${vertical ? "tabs--vertical" : ""}`} role="tablist" aria-orientation={vertical ? "vertical" : "horizontal"}>
      {tabs.map((t, i) => (
        <button
          key={t.value}
          ref={(el) => void (refs.current[i] = el)}
          type="button"
          role="tab"
          aria-selected={t.value === value}
          tabIndex={t.value === value ? 0 : -1}
          className={`tabs__tab ${t.value === value ? "is-on" : ""}`}
          onClick={() => onChange(t.value)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.icon && <Icon name={t.icon} size={16} />}
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Stable memo of option arrays built inline. */
export function useOptions<T extends string>(make: () => Option<T>[], deps: unknown[]): Option<T>[] {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(make, deps);
}
