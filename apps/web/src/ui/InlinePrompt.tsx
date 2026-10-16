/** A value box that opens on the canvas, right beside what you clicked, instead of a dialog in the middle of the screen. */
import { useEffect, useRef, useState } from "react";
import { type InlinePromptRequest, inlinePromptHost } from "../state/dialogs";

export function InlinePrompt() {
  const [req, setReq] = useState<InlinePromptRequest | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inlinePromptHost.show = (r) => {
      setReq((old) => (old?.resolve(null), r));
      setText(r.initial);
      setError(null);
    };
    return () => {
      inlinePromptHost.show = null;
    };
  }, []);
  useEffect(() => {
    if (req) input.current?.select();
  }, [req]);
  if (!req) return null;

  const done = (v: string | null) => {
    req.resolve(v);
    setReq(null);
  };
  const submit = () => {
    const bad = req.validate?.(text.trim()) ?? null;
    if (bad) return setError(bad);
    done(text.trim());
  };
  return (
    <div
      className="inline-prompt"
      role="dialog"
      aria-label={req.title}
      style={{ left: Math.max(8, req.at[0] + 12), top: Math.max(8, req.at[1] + 12) }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="inline-prompt__row">
        <input
          ref={input}
          className="inline-prompt__input mono"
          aria-label={req.label}
          aria-invalid={!!error}
          value={text}
          onChange={(e) => (setText(e.target.value), setError(null))}
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
      {error ? <div className="inline-prompt__error">{error}</div> : <div className="inline-prompt__hint muted">{req.label} · Enter to apply, Esc to cancel</div>}
    </div>
  );
}
