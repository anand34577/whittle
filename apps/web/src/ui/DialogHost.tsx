/** Renders the in-app confirm / prompt dialogs and the tooltip layer. */
import { useEffect, useRef, useState } from "react";
import { type ConfirmRequest, type PromptRequest, closeDialog, useDialogs } from "../state/dialogs";
import { Icon } from "./icons";
import { GUIDES, GuideCard } from "./toolGuides";

function ConfirmView({ req }: { req: ConfirmRequest }) {
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => ok.current?.focus(), []);
  const done = (v: boolean) => {
    closeDialog(req);
    req.resolve(v);
  };
  return (
    <div className="scrim scrim--dialog" onMouseDown={() => done(false)}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dlg-title"
        aria-describedby="dlg-msg"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") done(false);
        }}
      >
        <div className={`dialog__icon ${req.danger ? "is-danger" : ""}`}>
          <Icon name={req.danger ? "warning" : "info"} size={22} />
        </div>
        <div className="dialog__body">
          <h2 id="dlg-title">{req.title}</h2>
          <p id="dlg-msg">{req.message}</p>
          {req.details && req.details.length > 0 && (
            <ul className="dialog__details">
              {req.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
        <footer className="dialog__foot">
          <button className="btn btn--ghost" onClick={() => done(false)}>
            {req.cancelLabel}
          </button>
          <button ref={ok} className={`btn ${req.danger ? "btn--danger-solid" : "btn--accent"}`} onClick={() => done(true)}>
            {req.confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

function PromptView({ req }: { req: PromptRequest }) {
  const [value, setValue] = useState(req.initial);
  const [touched, setTouched] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const numberError = req.type === "number" && value.trim() !== "" && !Number.isFinite(Number(value)) ? "Enter a number" : null;
  const error = numberError ?? req.validate?.(value) ?? null;
  const done = (v: string | null) => {
    closeDialog(req);
    req.resolve(v);
  };
  const submit = () => {
    setTouched(true);
    if (!error) done(value);
  };
  return (
    <div className="scrim scrim--dialog" onMouseDown={() => done(null)}>
      <form
        className="dialog dialog--prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dlg-title"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") done(null);
        }}
      >
        <div className="dialog__body">
          <h2 id="dlg-title">{req.title}</h2>
          {req.message && <p>{req.message}</p>}
          <label className="tf">
            <span className="tf__label">{req.label}</span>
            <span className={`tf__box ${touched && error ? "is-error" : ""}`}>
              <input
                ref={input}
                className={`tf__input ${req.type === "number" ? "mono" : ""}`}
                type={req.type === "number" ? "text" : req.type}
                inputMode={req.type === "number" ? "decimal" : undefined}
                value={value}
                placeholder={req.placeholder}
                autoComplete={req.type === "password" ? "new-password" : "off"}
                aria-invalid={touched && !!error}
                onChange={(e) => setValue(e.target.value)}
              />
              {req.unit && <span className="tf__unit">{req.unit}</span>}
            </span>
            {touched && error && <small className="tf__error">{error}</small>}
          </label>
          {req.choices && (
            <div className="quick" role="group" aria-label="Common values">
              {req.choices.map((c) => (
                <button key={c.label} type="button" className={`quick__btn ${value === c.value ? "is-on" : ""}`} onClick={() => setValue(c.value)}>
                  {c.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <footer className="dialog__foot">
          <button type="button" className="btn btn--ghost" onClick={() => done(null)}>
            Cancel
          </button>
          <button type="submit" className="btn btn--accent" disabled={touched && !!error}>
            {req.confirmLabel}
          </button>
        </footer>
      </form>
    </div>
  );
}

export function DialogHost() {
  const queue = useDialogs((s) => s.queue);
  const req = queue[0];
  if (!req) return null;
  return req.kind === "confirm" ? <ConfirmView key={queue.length} req={req} /> : <PromptView key={queue.length} req={req} />;
}

/**
 * App-drawn tooltips. Any element with `title` or `data-tip` gets one: the
 * native title is moved to `data-tip` on hover so the browser's own tooltip
 * never shows. Placed above the element, flipped below near the top edge.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; below: boolean; guide?: string } | null>(null);
  const deepTimer = useRef<number | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const current = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const hide = () => {
      window.clearTimeout(timer.current);
      window.clearTimeout(deepTimer.current);
      // Put a borrowed title back: the browser only shows its own tooltip on a
      // sustained hover, so restoring it once the pointer has left is safe.
      const el = current.current;
      const borrowed = el?.getAttribute("data-tip-title");
      if (el && borrowed !== null && borrowed !== undefined) {
        el.setAttribute("title", borrowed);
        el.removeAttribute("data-tip-title");
      }
      current.current = null;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>("[title], [data-tip], [data-tip-title]");
      if (el === current.current) return;
      hide();
      if (!el) return;
      const native = el.getAttribute("title");
      if (native) {
        el.setAttribute("data-tip-title", native);
        el.removeAttribute("title");
        // While borrowed, the title can't name an icon-only button: keep its accessible name.
        if (!el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby") && !el.textContent?.trim()) {
          el.setAttribute("aria-label", native.split("\n")[0]!);
        }
      }
      const text = native ?? el.getAttribute("data-tip");
      if (!text) return;
      current.current = el;
      timer.current = window.setTimeout(() => {
        if (current.current !== el || !el.isConnected) return;
        const r = el.getBoundingClientRect();
        const below = r.top < 64;
        const pos = { text, x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8, below };
        setTip(pos);
        // Keep hovering and a tool's tooltip grows into a picture and the steps.
        const id = el.getAttribute("data-tour") ?? "";
        if (GUIDES[id]) deepTimer.current = window.setTimeout(() => current.current === el && setTip({ ...pos, guide: id }), 1100);
      }, 450);
    };
    window.addEventListener("pointerover", over, true);
    window.addEventListener("pointerdown", hide, true);
    window.addEventListener("keydown", hide, true);
    window.addEventListener("wheel", hide, { passive: true, capture: true });
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("pointerover", over, true);
      window.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("keydown", hide, true);
      window.removeEventListener("wheel", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  const ref = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  useEffect(() => {
    if (!tip || !ref.current) return setShift(0);
    const r = ref.current.getBoundingClientRect();
    const half = r.width / 2;
    setShift(Math.max(8 + half - tip.x, Math.min(0, window.innerWidth - 8 - half - tip.x)));
  }, [tip]);

  if (!tip) return null;
  const [first, ...rest] = tip.text.split("\n");
  return (
    <div
      ref={ref}
      className={`tooltip ${tip.below ? "tooltip--below" : ""}`}
      role="tooltip"
      style={{ left: tip.x + shift, top: tip.y }}
    >
      <b>{first}</b>
      {rest.map((line, i) => (
        <span key={i}>{line}</span>
      ))}
      {tip.guide && GUIDES[tip.guide] && <GuideCard guide={GUIDES[tip.guide]!} />}
    </div>
  );
}
