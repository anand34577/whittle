import { useApp } from "../state/store";
import { Icon } from "./icons";

export function Modal({ title, children, wide, onClose }: { title: string; children: React.ReactNode; wide?: boolean; onClose?: () => void }) {
  const close = onClose ?? (() => useApp.setState({ panel: null }));
  return (
    <div className="scrim" onMouseDown={close}>
      <div
        className={`modal ${wide ? "modal--wide" : ""}`}
        role="dialog"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
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
