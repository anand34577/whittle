import { useEffect, useRef } from "react";
import { useApp } from "../state/store";
import { Icon } from "./icons";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, children, wide, onClose }: { title: string; children: React.ReactNode; wide?: boolean; onClose?: () => void }) {
  const close = onClose ?? (() => useApp.setState({ panel: null }));
  const box = useRef<HTMLDivElement>(null);
  // Focus moves into the dialog and comes back to where it was when it closes (audit UI-2).
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    if (box.current && !box.current.contains(document.activeElement)) box.current.focus();
    return () => {
      if (before && document.contains(before)) before.focus();
    };
  }, []);
  return (
    <div className="scrim" onMouseDown={close}>
      <div
        ref={box}
        className={`modal ${wide ? "modal--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          // Tab stays inside the dialog instead of walking into the page behind it.
          if (e.key === "Tab" && box.current) {
            const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
            const [first, last] = [items[0], items[items.length - 1]];
            if (first && last) {
              if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) (e.preventDefault(), last.focus());
              else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
            }
          }
          e.stopPropagation();
        }}
      >
        <header className="modal__head">
          <h2>{title}</h2>
          <button className="iconbtn" onClick={close} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
