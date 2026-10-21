/** A value box that opens on the canvas, right beside what you clicked, instead of a dialog in the middle of the screen. */
import { useEffect, useRef, useState } from "react";
import { type InlinePromptRequest, inlinePromptHost } from "../state/dialogs";
import { useApp } from "../state/store";

export function InlinePrompt() {
  const [req, setReq] = useState<InlinePromptRequest | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Where the box sits when the canvas moves it (it follows the pointer while a drag drives it). */
  const [pos, setPos] = useState<[number, number] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  /** The sketch (or mode) the box belongs to: leaving it drops the box. */
  const where = useApp((s) => (s.mode.kind === "sketch" ? s.mode.sketchId : s.mode.kind));
  /** The latest text and whether it was typed, for the canvas driving the box (its callbacks outlive a render). */
  const live = useRef({ text: "", typed: false, submit: () => {}, cancel: () => {} });

  useEffect(() => {
    inlinePromptHost.show = (r) => {
      setReq((old) => (old?.resolve(null), r));
      setText(r.initial);
      setPos(null);
      setError(null);
      live.current.text = r.initial;
      live.current.typed = false;
      r.bind?.({
        set: (v, at) => {
          if (live.current.typed) return;
          live.current.text = v;
          if (at) setPos(at);
          setText(v);
          setError(null);
          // Keep the value selected, so typing replaces what the drag put there.
          requestAnimationFrame(() => input.current?.select());
        },
        submit: () => live.current.submit(),
        cancel: () => live.current.cancel(),
      });
    };
    return () => {
      inlinePromptHost.show = null;
    };
  }, []);
  useEffect(() => {
    if (!req) return;
    input.current?.select();
    // The click that opened the box focuses the canvas once its handlers are done: take the focus back after it.
    const f = requestAnimationFrame(() => input.current?.select());
    return () => cancelAnimationFrame(f);
  }, [req]);
  useEffect(() => {
    if (req) req.onInput?.(text.trim());
  }, [req, text]);
  useEffect(() => {
    live.current.cancel();
  }, [where]);
  useEffect(() => {
    if (!req) return;
    // A click anywhere else applies the value (as Enter would) when it is valid, else drops it; Esc drops it.
    // A box the canvas drives is placed by the canvas itself.
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || req.bind || boxRef.current?.contains(e.target as Node)) return;
      if (req.validate?.(live.current.text.trim())) live.current.cancel();
      else live.current.submit();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") live.current.cancel();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [req]);
  if (!req) return null;
  // Problems show while typing, not only after Enter.
  const problem = error ?? req.validate?.(text.trim()) ?? null;

  const done = (v: string | null) => {
    req.resolve(v);
    setReq(null);
  };
  const submit = () => {
    const t = live.current.text.trim();
    const why = req.validate?.(t) ?? null;
    if (why) return setError(why);
    done(t);
  };
  live.current.submit = submit;
  live.current.cancel = () => done(null);
  return (
    <div
      ref={boxRef}
      className="inline-prompt"
      role="dialog"
      aria-label={req.title}
      style={{ left: Math.max(8, (pos ?? req.at)[0] + (req.bind ? 28 : 12)), top: Math.max(8, (pos ?? req.at)[1] + (req.bind ? 28 : 12)) }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="inline-prompt__row">
        <input
          ref={input}
          className="inline-prompt__input mono"
          aria-label={req.label}
          aria-invalid={!!error}
          value={text}
          onChange={(e) => {
            live.current.text = e.target.value;
            live.current.typed = true;
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") submit();
            else if (e.key === "Escape") done(null);
          }}
        />
        {req.unit && <span className="muted">{req.unit}</span>}
        <button type="button" className="btn btn--small btn--accent" onClick={submit} aria-label="Apply">
          OK
        </button>
      </div>
      {problem ? (
        <div className="inline-prompt__error">{problem}</div>
      ) : (
        <div className="inline-prompt__hint muted">
          {req.label} · {req.bind && !live.current.typed ? "move the pointer or type, click to apply" : "Enter to apply"}, Esc to cancel
        </div>
      )}
    </div>
  );
}
