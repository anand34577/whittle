/** Title bar, toolbar, status bar and toasts: the quiet frame around the viewport. */
import { useEffect, useRef, useState } from "react";
import { COMMANDS, type Command, commandById, isAvailable } from "../state/commands";
import { hintFor } from "../state/hints";
import { history, mutate, setTheme, useApp } from "../state/store";
import { AccountButton } from "./Account";
import { Icon } from "./icons";

/* ───────────────────────────── Title bar ───────────────────────────── */

export function TitleBar() {
  const doc = useApp((s) => s.doc);
  const dirty = useApp((s) => s.dirty);
  const theme = useApp((s) => s.theme);
  useApp((s) => s.historyTick);
  const session = useApp((s) => s.session);
  const [name, setName] = useState(doc.name);
  useEffect(() => setName(doc.name), [doc.name]);

  const run = (id: string) => commandById(id).run();

  return (
    <header className="titlebar">
      <div className="brand" aria-label="Whittle">
        <svg width="22" height="22" viewBox="0 0 64 64" aria-hidden="true">
          <path d="M14 46 L30 14 L50 40 Z" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinejoin="round" />
          <path d="M30 14 L34 50" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity=".5" />
          <path d="M10 52 H54" stroke="var(--accent)" strokeWidth="5" strokeLinecap="round" />
        </svg>
        <span className="brand__word">whittle</span>
      </div>

      <nav className="filemenu" aria-label="File">
        <button className="iconbtn" onClick={() => run("new")} title="New design">
          <Icon name="file" size={18} />
        </button>
        <button className="iconbtn" onClick={() => run("open")} title="Open (Ctrl+O)">
          <Icon name="open" size={18} />
        </button>
        <button className="iconbtn" onClick={() => run("save")} title="Save (Ctrl+S)">
          <Icon name="save" size={18} />
        </button>
        <button className="iconbtn" onClick={() => run("history")} title="Version history">
          <Icon name="history" size={18} />
        </button>
        <button className="iconbtn" onClick={() => run("export")} title="Export (STEP, 3MF, STL)">
          <Icon name="export" size={18} />
        </button>
        <span className="sep" />
        <button className="iconbtn" onClick={() => run("undo")} disabled={!history.canUndo && !session} title={`Undo${history.undoLabel ? " " + history.undoLabel : ""} (Ctrl+Z)`}>
          <Icon name="undo" size={18} />
        </button>
        <button className="iconbtn" onClick={() => run("redo")} disabled={!history.canRedo || !!session} title={`Redo${history.redoLabel ? " " + history.redoLabel : ""} (Ctrl+Shift+Z)`}>
          <Icon name="redo" size={18} />
        </button>
      </nav>

      <div className="docname">
        <input
          className="docname__input"
          value={name}
          aria-label="Design name"
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== doc.name && mutate("Rename design", (d) => void (d.name = name.trim()))}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        <span className={`docname__state ${dirty ? "is-dirty" : ""}`}>{dirty ? "Unsaved" : "Saved"}</span>
      </div>

      <div className="titlebar__right">
        <button className="searchbtn" onClick={() => useApp.setState({ panel: "palette" })}>
          <Icon name="search" size={16} />
          <span>Find a command</span>
          <kbd>Ctrl K</kbd>
        </button>
        <button className="iconbtn" onClick={() => useApp.setState({ panel: "params" })} title="Parameters">
          <Icon name="params" size={18} />
        </button>
        <button className="iconbtn" onClick={() => setTheme(theme === "graphite" ? "paper" : "graphite")} title={theme === "graphite" ? "Paper theme" : "Graphite theme"}>
          <Icon name={theme === "graphite" ? "sun" : "moon"} size={18} />
        </button>
        <button className="iconbtn" onClick={() => useApp.setState({ panel: "welcome" })} title="Start screen, your designs, templates & help">
          <Icon name="help" size={18} />
        </button>
        <AccountButton />
      </div>
    </header>
  );
}

/* ───────────────────────────── Toolbar ───────────────────────────── */

function ToolButton({ c, active, big }: { c: Command; active?: boolean; big?: boolean }) {
  const state = useApp();
  const enabled = isAvailable(c, state);
  active ||= c.on?.(state);
  return (
    <button
      className={`tool ${active ? "is-active" : ""} ${big ? "tool--big" : ""}`}
      onClick={c.run}
      disabled={!enabled}
      data-tour={c.id}
      aria-pressed={active}
      title={`${c.label}${c.keys ? `  (${c.keys})` : ""}${c.hint ? "\n" + c.hint : ""}`}
    >
      <Icon name={c.icon ?? "more"} size={big ? 22 : 20} />
      <span className="tool__label">{c.short ?? c.label}</span>
    </button>
  );
}

/** Every command of a group, with hints, in a dropdown. */
function GroupMenu({ label, ids }: { label: string; ids: string[] }) {
  const [open, setOpen] = useState(false);
  const state = useApp();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className="groupmenu" ref={ref}>
      <button className={`groupmenu__btn ${open ? "is-open" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu">
        {label}
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div className="groupmenu__pop" role="menu">
          {ids.map((id) => {
            const c = commandById(id);
            const enabled = isAvailable(c, state);
            return (
              <button
                key={id}
                role="menuitem"
                disabled={!enabled}
                className="groupmenu__item"
                onClick={() => {
                  setOpen(false);
                  c.run();
                }}
              >
                <Icon name={c.icon ?? "more"} size={20} />
                <span className="groupmenu__text">
                  <b>{c.label}</b>
                  {c.hint && <small>{c.hint}</small>}
                </span>
                {c.keys && <kbd>{c.keys}</kbd>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Group({ label, ids, more, activeId }: { label: string; ids: string[]; more?: string[]; activeId?: string }) {
  return (
    <div className="toolgroup" role="group" aria-label={label}>
      <div className="toolgroup__tools">
        {ids.map((id) => (
          <ToolButton key={id} c={commandById(id)} active={id === activeId} />
        ))}
      </div>
      {more ? <GroupMenu label={label} ids={[...ids, ...more]} /> : <span className="toolgroup__label">{label}</span>}
    </div>
  );
}

export function Toolbar() {
  const mode = useApp((s) => s.mode);
  if (mode.kind === "sketch") {
    const active = mode.tool === "select" ? "tool-select" : mode.tool === "polyline" ? "tool-line" : `tool-${mode.tool}`;
    return (
      <div className="toolbar toolbar--sketch" role="toolbar" aria-label="Sketch tools">
        <div className="toolbar__mode">
          <span className="pill pill--accent">Sketch</span>
        </div>
        <Group label="Draw" ids={["tool-line", "tool-rect", "tool-circle", "tool-ellipse", "tool-polygon", "tool-slot"]} activeId={active} />
        <Group label="Special" ids={["tool-text", "tool-gear", "import-svg"]} more={["export-sketch-svg", "export-sketch-dxf"]} activeId={active} />
        <Group label="Arrange" ids={["tool-select", "duplicate", "mirror-shape-y", "rotate-shape", "construction"]} more={["mirror-shape-x", "delete"]} activeId={active} />
        <div className="toolbar__spacer" />
        <button className="btn btn--accent" onClick={commandById("finish-sketch").run} data-tour="finish-sketch">
          <Icon name="finish" size={18} /> Finish sketch
        </button>
      </div>
    );
  }
  return (
    <div className="toolbar" role="toolbar" aria-label="Modeling tools">
      <div className="toolgroup toolgroup--primary">
        <div className="toolgroup__tools">
          <ToolButton c={commandById("sketch")} active={mode.kind === "pickPlane"} big />
        </div>
        <span className="toolgroup__label">Start</span>
      </div>
      <Group label="Create" ids={["extrude", "revolve", "loft", "hole"]} more={["import"]} />
      <Group label="Shapes" ids={["box", "cylinder", "sphere"]} more={["cone", "torus", "tube"]} />
      <Group label="Modify" ids={["fillet", "chamfer", "shell", "move"]} more={["combine", "mirror", "pattern"]} />
      <Group label="Inspect" ids={["measure", "section", "overhang"]} more={["display-edges", "display-shaded", "display-wire", "display-xray", "ortho", "screenshot"]} />
      <div className="toolbar__spacer" />
      <div className="toolgroup toolgroup--feature">
        <div className="toolgroup__tools">
          <ToolButton c={commandById("parts")} />
        </div>
        <span className="toolgroup__label">Library</span>
      </div>
      <Group label="Export" ids={["export"]} more={["export-step", "export-3mf", "export-stl", "screenshot", "history"]} />
    </div>
  );
}

/* ───────────────────────────── Status bar ───────────────────────────── */

export function StatusBar() {
  const state = useApp();
  const hint = hintFor(state);
  const r = state.regen;
  return (
    <footer className="statusbar">
      <span className="statusbar__hint" aria-live="polite">
        <Icon name="sparkStep" size={14} />
        {hint}
      </span>
      <span className="statusbar__meta">
        {state.kernelError ? (
          <span className="status-dot status-dot--error">Engine error</span>
        ) : !state.kernelReady ? (
          <span className="status-dot status-dot--busy">Loading engine</span>
        ) : (
          <span className={`status-dot ${state.regenBusy ? "status-dot--busy" : "status-dot--ok"}`}>
            {state.regenBusy ? "Building" : r ? `Built in ${Math.max(1, Math.round(r.ms))} ms` : "Ready"}
          </span>
        )}
        <span className="mono">{state.doc.units}</span>
      </span>
    </footer>
  );
}

/* ───────────────────────────── Toasts ───────────────────────────── */

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          <span>{t.text}</span>
          {t.action && (
            <button className="link" onClick={t.action.run}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────────── Command palette ───────────────────────────── */

function score(c: Command, q: string): number {
  if (!q) return 1;
  const hay = `${c.label} ${c.keywords ?? ""} ${c.group}`.toLowerCase();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  let s = 0;
  for (const w of words) {
    if (c.label.toLowerCase().startsWith(w)) s += 5;
    else if (c.label.toLowerCase().includes(w)) s += 3;
    else if (hay.includes(w)) s += 1;
    else return 0;
  }
  return s;
}

export function CommandPalette() {
  const state = useApp();
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const list = COMMANDS.map((c) => ({ c, s: score(c, q) }))
    .filter((x) => x.s > 0 && isAvailable(x.c, state))
    .sort((a, b) => b.s - a.s)
    .slice(0, 12)
    .map((x) => x.c);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => setI(0), [q]);
  const close = () => useApp.setState({ panel: null });
  const run = (c: Command | undefined) => {
    if (!c) return;
    close();
    setTimeout(c.run, 0);
  };
  return (
    <div className="scrim" onMouseDown={close}>
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette__search">
          <Icon name="search" size={18} />
          <input
            autoFocus
            placeholder="What do you want to do? Try 'round edges' or 'hollow'"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setI((x) => Math.min(list.length - 1, x + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setI((x) => Math.max(0, x - 1));
              } else if (e.key === "Enter") run(list[i]);
              else if (e.key === "Escape") close();
            }}
          />
        </div>
        <ul className="palette__list" ref={listRef} role="listbox">
          {list.length === 0 && <li className="palette__empty">No matching command</li>}
          {list.map((c, k) => (
            <li
              key={c.id}
              role="option"
              aria-selected={k === i}
              className={`palette__item ${k === i ? "is-on" : ""}`}
              onMouseEnter={() => setI(k)}
              onClick={() => run(c)}
            >
              <Icon name={c.icon ?? "more"} size={18} />
              <span className="palette__label">{c.label}</span>
              {c.hint && <span className="palette__hint">{c.hint}</span>}
              <span className="palette__group">{c.group}</span>
              {c.keys && <kbd>{c.keys}</kbd>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}