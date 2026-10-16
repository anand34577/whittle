import { Component, type ReactNode } from "react";
import { downloadCopy } from "../state/files";

/**
 * Catches a crash while drawing the interface, so one broken value can't leave a blank window:
 * the person can try again, keep a copy of the design, or reload (autosave brings the work back).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error("The interface crashed:", error);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-boundary" role="alert" style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", background: "var(--bg-0)", color: "var(--text-1)", fontFamily: "var(--font-ui)", padding: 24 }}>
        <div style={{ maxWidth: 480 }}>
          <h1 style={{ fontSize: "var(--fs-xl)", margin: "0 0 12px" }}>Whittle ran into a problem</h1>
          <p style={{ color: "var(--text-2)", margin: "0 0 8px" }}>Something in the design or the window couldn't be shown. Your work is not lost: it is kept for recovery, and you can save a copy now.</p>
          <p style={{ color: "var(--text-3)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-sm)", margin: "0 0 16px", wordBreak: "break-word" }}>{error.message}</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn--accent" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <button className="btn" onClick={() => void downloadCopy()}>
              Save a copy
            </button>
            <button className="btn btn--ghost" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
