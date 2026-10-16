/** Title bar, toolbar, status bar and toasts: the quiet frame around the viewport. */
import { useEffect, useRef, useState } from "react";
import { COMMANDS, CONSTRAINT_COMMANDS, type Command, commandById, isAvailable } from "../state/commands";
import { aiAvailable } from "../state/platform";
import { hintFor } from "../state/hints";
import { stopRebuild } from "../state/kernel";
import { history, mutate, setTheme, useApp } from "../state/store";
import { AccountButton } from "./Account";
import { type Profile, THEMES } from "../state/prefs";
import { Popover } from "./controls";
import { Icon } from "./icons";

/* ───────────────────────────── Title bar ───────────────────────────── */

export function TitleBar() {
  const doc = useApp((s) => s.doc);
  const dirty = useApp((s) => s.dirty);
  const theme = useApp((s) => s.theme);
  const assistant = useApp((s) => s.assistant);
  const aiAllowed = useApp((s) => aiAvailable(s.platform));
  const dark = THEMES.find((t) => t.id === theme)?.dark ?? true;
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
        {aiAllowed && (
          <button className={`iconbtn ${assistant ? "is-on" : ""}`} onClick={() => useApp.setState({ assistant: !assistant })} title="AI assistant (Ctrl+I)" aria-pressed={assistant}>
            <Icon name="assistant" size={18} />
          </button>
        )}
        <button className="iconbtn" onClick={() => setTheme(dark ? "paper" : "graphite")} title={dark ? "Light theme" : "Dark theme"}>
          <Icon name={dark ? "sun" : "moon"} size={18} />
        </button>
        <button className="iconbtn" onClick={() => useApp.setState({ panel: "settings" })} title="Settings (Ctrl+,)">
          <Icon name="settings" size={18} />
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

/** Every command of a group, with hints, in a dropdown that stays inside the window and scrolls. */
function GroupMenu({ label, ids, asTool }: { label: string; ids: string[]; asTool?: boolean }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const state = useApp();
  return (
    <div className="groupmenu">
      {asTool ? (
        <button ref={setAnchor} className={`tool tool--menu ${open ? "is-active" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" title={`${label}: ${ids.length} tools`}>
          <Icon name={commandById(ids.find((i) => !i.startsWith("#"))!).icon ?? "more"} size={20} />
          <span className="tool__label">
            {label}
            <Icon name="chevronDown" size={10} />
          </span>
        </button>
      ) : (
        <button ref={setAnchor} className={`groupmenu__btn ${open ? "is-open" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu">
          {label}
          <Icon name="chevronDown" size={12} />
        </button>
      )}
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} className="groupmenu__pop" placement="bottom-start">
        <div role="menu">
          {ids.map((id) => {
            if (id.startsWith("#")) return <div key={id} className="groupmenu__head">{id.slice(1)}</div>;
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
      </Popover>
    </div>
  );
}

function Group({ label, ids, more, activeId }: { label: string; ids: string[]; more?: string[]; activeId?: string }) {
  // No visible tools: the whole group is one button that opens its list.
  if (!ids.length && more) {
    return (
      <div className="toolgroup toolgroup--menu" role="group" aria-label={label}>
        <GroupMenu label={label} ids={more} asTool />
      </div>
    );
  }
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

/**
 * Which tools sit on the toolbar and which wait in the group menu depends on
 * the workspace profile: newcomers see the essentials, professionals the lot.
 */
function toolsFor(profile: Profile | null) {
  const pro = profile === "engineer" || profile === "designer";
  return {
    create: pro
      ? { primary: ["extrude", "revolve", "sweep", "loft", "hole"], more: ["#More solids", "pipe", "rib", "web", "emboss", "engrave", "thread", "thread-face", "spring", "boundary-fill", "#3D curves", "curve-3d", "curve-edges", "curve-faces", "curve-project", "#Bring in", "import"] }
      : { primary: ["extrude", "revolve", "hole"], more: ["#More solids", "sweep", "loft", "pipe", "rib", "web", "emboss", "engrave", "thread", "thread-face", "spring", "boundary-fill", "#3D curves", "curve-3d", "curve-edges", "curve-faces", "curve-project", "#Bring in", "import"] },
    modify: pro
      ? { primary: ["fillet", "chamfer", "shell", "draft", "move"], more: ["#Faces", "press-pull", "replace-face", "delete-face", "split-faces", "#Bodies", "combine", "mirror", "pattern", "split", "offset", "scale", "align", "#Edges", "fillet-all", "chamfer-all", "#Assembly", "make-component", "ground", "joint"] }
      : { primary: ["fillet", "chamfer", "shell", "move"], more: ["#Faces", "press-pull", "replace-face", "delete-face", "split-faces", "draft", "#Bodies", "combine", "mirror", "pattern", "split", "offset", "scale", "align", "#Edges", "fillet-all", "chamfer-all", "#Assembly", "make-component", "ground", "joint"] },
  };
}

/** Vertical wheel scrolls an overflowing toolbar sideways. */
const wheelX = (e: React.WheelEvent<HTMLElement>) => {
  const el = e.currentTarget;
  if (el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
};

export function Toolbar() {
  const mode = useApp((s) => s.mode);
  const profile = useApp((s) => s.prefs.profile);
  const labels = useApp((s) => s.prefs.toolLabels);
  const { create, modify } = toolsFor(profile);
  if (mode.kind === "sketch") {
    const active = mode.tool === "select" ? "tool-select" : mode.tool === "polyline" ? "tool-line" : `tool-${mode.tool}`;
    return (
      <div className={`toolbar toolbar--sketch ${labels ? "" : "toolbar--icons"}`} role="toolbar" aria-label="Sketch tools">
        <div className="toolbar__mode">
          <span className="pill pill--accent">Sketch</span>
        </div>
        <div className="toolbar__scroll" onWheel={wheelX}>
        <Group label="Draw" ids={["tool-line", "tool-path", "tool-rect", "tool-circle", "tool-ellipse", "tool-polygon", "tool-slot"]} more={["tool-crect", "tool-rect3", "tool-circle2", "tool-circle3", "tool-polygonc", "tool-polygone", "tool-carc", "tool-tarc", "tool-conic", "tool-cspline", "tool-earc", "tool-tan2c", "tool-tan3c"]} activeId={active} />
        <Group label="Insert" ids={[]} more={["tool-project", "sketch-intersect", "tool-text", "tool-gear", "import-image", "import-svg", "import-dxf", "calibrate-image", "flatten-image", "trace-image", "trace-area", "export-sketch-svg", "export-sketch-dxf"]} />
        <Group label="Arrange" ids={["tool-select", "make-constrainable", "duplicate", "mirror-shape-y", "rotate-shape", "construction"]} more={["mirror-shape-x", "geo-stretch", "geo-move", "geo-copy", "geo-scale", "geo-grid", "geo-break", "geo-offset", "geo-mirror-y", "geo-mirror-x", "geo-mirror-line", "delete"]} activeId={active} />
        <Group
          label="Constrain"
          ids={profile === "engineer" || profile === "designer" ? ["tool-segment", "tool-arc", "tool-spline", "tool-pcircle", "tool-dimension", "tool-sfillet", "tool-schamfer", "tool-trim", "tool-extend"] : ["tool-segment", "tool-spline", "tool-dimension", "tool-sfillet"]}
          more={["tool-segment", "tool-arc", "tool-spline", "tool-pcircle", "tool-dimension", "tool-gpoint", "tool-sfillet", "tool-schamfer", "tool-trim", "tool-extend", ...CONSTRAINT_COMMANDS]}
          activeId={active}
        />
        </div>
        <button className="btn btn--accent toolbar__finish" onClick={commandById("finish-sketch").run} data-tour="finish-sketch">
          <Icon name="finish" size={18} /> Finish sketch
        </button>
      </div>
    );
  }
  return (
    <div className={`toolbar ${labels ? "" : "toolbar--icons"}`} role="toolbar" aria-label="Modeling tools">
      <div className="toolbar__scroll" onWheel={wheelX}>
      <div className="toolgroup toolgroup--primary">
        <div className="toolgroup__tools">
          <ToolButton c={commandById("sketch")} active={mode.kind === "pickPlane"} big />
        </div>
        <span className="toolgroup__label">Start</span>
      </div>
      <Group label="Create" ids={create.primary} more={create.more} />
      <Group label="Construct" ids={[]} more={["#Planes", "plane", "construct-midplane", "construct-plane3", "construct-plane2e", "construct-planeEdge", "construct-planeTangent", "construct-planePath", "#Axes", "construct-axisCyl", "construct-axis2p", "construct-axis2pl", "construct-axisEdge", "construct-axisPerp", "#Points", "construct-pointVertex", "construct-point2e", "construct-point3pl", "construct-pointCenter", "construct-pointEdgePlane"]} />
      <Group label="Surface" ids={[]} more={["surface-patch", "surface-stitch", "surface-thicken", "surface-trim", "surface-ruled", "surface-offset", "surface-untrim", "surface-extend", "surface-unstitch", "surface-merge", "surface-reverse"]} />
      <Group label="Shapes" ids={[]} more={["box", "cylinder", "sphere", "cone", "torus", "tube", "spring"]} />
      <Group label="Modify" ids={modify.primary} more={modify.more} />
      <Group label="Inspect" ids={["measure", "section"]} more={["#Check the model", "interference", "clear-interference", "explode", "min-radius", "overhang", "draft-analysis", "#Surface quality", "curvature", "zebra", "accessibility", "#Look", "component-colors", "display-edges", "display-shaded", "display-wire", "display-xray", "ortho", "screenshot"]} />
      </div>
      <div className="toolbar__fixed">
        <div className="toolgroup toolgroup--feature">
          <div className="toolgroup__tools">
            <ToolButton c={commandById("parts")} />
          </div>
          <span className="toolgroup__label">Library</span>
        </div>
        <Group label="Export" ids={["export"]} more={["export-step", "export-3mf", "export-stl", "screenshot", "history"]} />
      </div>
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
        {state.regenBusy && state.kernelReady && !state.kernelError && (
          <button className="link" onClick={stopRebuild} title="Stop the rebuild (it restarts the engine)">
            Stop
          </button>
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