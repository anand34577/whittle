/**
 * A text field whose value is applied when the typing pauses, or on Enter, Tab or leaving it: typing "120" builds
 * the model once, not for "1" and "12" on the way (audit U-2). Escape puts the value back as it was.
 */
import { useEffect, useRef, useState } from "react";

export function DeferredInput({
  value,
  onCommit,
  delay = 350,
  autoFocus,
  onDone,
  ...rest
}: {
  value: string;
  onCommit: (v: string) => void;
  delay?: number;
  autoFocus?: boolean;
  /** Called after Enter, Escape or leaving the field (an inline editor closes itself here). */
  onDone?: () => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "defaultValue">) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  const start = useRef(value);
  const timer = useRef<number | undefined>(undefined);
  // A change from elsewhere (undo, another field) shows unless this field is being typed in.
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const flush = (v: string) => {
    window.clearTimeout(timer.current);
    if (v !== value) onCommit(v);
  };
  return (
    <input
      {...rest}
      autoFocus={autoFocus}
      value={text}
      data-pending={text !== value || undefined}
      onFocus={(e) => {
        focused.current = true;
        start.current = value;
        if (autoFocus) e.currentTarget.select();
        rest.onFocus?.(e);
      }}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => flush(v), delay);
      }}
      onBlur={(e) => {
        focused.current = false;
        flush(text);
        rest.onBlur?.(e);
        onDone?.();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          flush(text);
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          window.clearTimeout(timer.current);
          setText(start.current);
          if (start.current !== value) onCommit(start.current);
          focused.current = false;
          onDone?.();
          e.currentTarget.blur();
        }
        rest.onKeyDown?.(e);
      }}
    />
  );
}
