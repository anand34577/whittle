import type { CSSProperties } from "react";

/** A small turning ring for things that are in progress. */
export function Spinner({ large, label }: { large?: boolean; label?: string }) {
  return <span className={`spinner ${large ? "spinner--lg" : ""}`} role="status" aria-label={label ?? "Working"} />;
}

/** A progress bar: filled to `value` (0..1), or sliding when the length of the wait isn't known. */
export function ProgressBar({ value, label }: { value?: number | null; label?: string }) {
  const known = typeof value === "number";
  const style: CSSProperties | undefined = known ? { width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` } : undefined;
  return (
    <div className={`progress ${known ? "" : "progress--indeterminate"}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? Math.round(value * 100) : undefined}>
      <div className="progress__fill" style={style} />
    </div>
  );
}
