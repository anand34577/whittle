/** Title bar, toolbar, status bar and toasts: the quiet frame around the viewport. */
import { useEffect, useRef, useState } from "react";
import { COMMANDS, CONSTRAINT_COMMANDS, type Command, commandById, isAvailable, whyUnavailable } from "../state/commands";
import { aiAvailable } from "../state/platform";
import { hintFor } from "../state/hints";
import { problemsOf } from "../state/problems";
import { retryKernel } from "../state/kernel";
import { noteClick, noteRun, recentCommands } from "../state/learn";
import { Activity, ActivityStrip } from "./Activity";
import { Spinner } from "./feedback";
import { history, mutate, setTheme, toast, useApp } from "../state/store";
import { AccountButton } from "./Account";
import { type Profile, THEMES } from "../state/prefs";
import { Popover } from "./controls";
import { Icon } from "./icons";

/* ───────────────────────────── Title bar ───────────────────────────── */

export function TitleBar() {
  const doc = useApp((s) => s.doc);
  const dirty = useApp((s) => s.dirty);
  const fileName = useApp((s) => s.fileName);
  const theme = useApp((s) => s.theme);
  const assistant = useApp((s) => s.assistant);
  const browserOpen = useApp((s) => s.browserOpen);
  const panelOpen = useApp((s) => s.panelOpen);
  const aiAllowed = useApp((s) => aiAvailable(s.platform));
  const dark = THEMES.find((t) => t.id === theme)?.dark ?? true;
  useApp((s) => s.historyTick);
  const session = useApp((s) => s.session);
  const [name, setName] = useState(doc.name);
  useEffect(() => setName(doc.name), [doc.name]);

  const run = (id: string) => commandById(id).run();

  return (
    <header className="titlebar">
      <button className={`iconbtn titlebar__side ${browserOpen ? "is-on" : ""}`} onClick={() => useApp.setState({ browserOpen: !browserOpen })} title="Browser panel" aria-label="Browser panel" aria-pressed={browserOpen}>
        <Icon name="sidebarLeft" size={18} />
      </button>
      <div className="brand" aria-label="Whittle">
        <svg width="22" height="22" viewBox="0 0 64 64" aria-hidden="true">
          <path d="M14 46 L30 14 L50 40 Z" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinejoin="round" />
          <path d="M30 14 L34 50" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity=".5" />
          <path d="M10 52 H54" stroke="var(--accent)" strokeWidth="5" strokeLinecap="round" />
        </svg>
        <span className="brand__word">whittle</span>
      </div>

      <nav className="filemenu" aria-label="File">
        <button className="iconbtn titlebar__opt" onClick={() => run("new")} title="New design">
          <Icon name="file" size={18} />
        </button>
        <button className="iconbtn titlebar__opt" onClick={() => run("open")} title="Open (Ctrl+O)">
          <Icon name="open" size={18} />
        </button>
        <button className="iconbtn" onClick={() => run("save")} title="Save (Ctrl+S)">
          <Icon name="save" size={18} />
        </button>
        <button className="iconbtn titlebar__opt" onClick={() => run("history")} title="Version history">
          <Icon name="history" size={18} />
        </button>
        <button className="iconbtn titlebar__opt" onClick={() => run("export")} title="Export (STEP, 3MF, STL)">
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
        {/* Only a design that really is in a file says Saved; a new or template design isn't stored anywhere yet. Clicking saves. */}
        <button
          type="button"
          className={`docname__state ${dirty ? "is-dirty" : fileName ? "" : "is-new"}`}
          onClick={() => run("save")}
          title={dirty || !fileName ? "Save (Ctrl+S)" : `Saved as ${fileName}`}
        >
          {dirty ? "Unsaved" : fileName ? "Saved" : doc.features.length ? "Not saved yet" : "New"}
        </button>
      </div>

      <div className="titlebar__right">
        <button className="searchbtn" onClick={() => useApp.setState({ panel: "palette" })}>
          <Icon name="search" size={16} />
          <span>Find a command</span>
          <kbd>Ctrl K</kbd>
        </button>
        <button className="iconbtn titlebar__opt" onClick={() => useApp.setState({ panel: "params" })} title="Parameters">
          <Icon name="params" size={18} />
        </button>
        {aiAllowed && (
          <button className={`iconbtn titlebar__opt--phone ${assistant ? "is-on" : ""}`} onClick={() => useApp.setState({ assistant: !assistant })} title="AI assistant (Ctrl+I)" aria-pressed={assistant}>
            <Icon name="assistant" size={18} />
          </button>
        )}
        <button className="iconbtn titlebar__opt" onClick={() => setTheme(theme.startsWith("daylight") ? (dark ? "daylight" : "daylightdark") : dark ? "paper" : "graphite")} title={dark ? "Light theme" : "Dark theme"}>
          <Icon name={dark ? "sun" : "moon"} size={18} />
        </button>
        <button className="iconbtn titlebar__opt" onClick={() => useApp.setState({ panel: "settings" })} title="Settings (Ctrl+,)">
          <Icon name="settings" size={18} />
        </button>
        <HelpMenu />
        <AccountButton />
        <button className={`iconbtn titlebar__side ${panelOpen ? "is-on" : ""}`} onClick={() => useApp.setState({ panelOpen: !panelOpen })} title="Properties panel" aria-label="Properties panel" aria-pressed={panelOpen}>
          <Icon name="sidebarRight" size={18} />
        </button>
      </div>
    </header>
  );
}

/** "?": lessons, keys, templates and the assistant in one place. */
function HelpMenu() {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={setAnchor} className={`iconbtn titlebar__opt--phone ${open ? "is-on" : ""}`} onClick={() => setOpen(!open)} title="Help, lessons and templates" aria-haspopup="menu" aria-expanded={open}>
        <Icon name="help" size={18} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} className="groupmenu__pop" placement="bottom-end">
        <MenuItems
          ids={["coach", "shortcuts", "welcome", "palette", "assistant"].filter((id) => COMMANDS.some((c) => c.id === id))}
          onPick={(c) => {
            setOpen(false);
            c.run();
          }}
        />
      </Popover>
    </>
  );
}

/* ───────────────────────────── Toolbar ───────────────────────────── */

function ToolButton({ c, active, big }: { c: Command; active?: boolean; big?: boolean }) {
  const state = useApp();
  const why = whyUnavailable(c, state);
  active ||= c.on?.(state);
  return (
    <button
      className={`tool ${active ? "is-active" : ""} ${big ? "tool--big" : ""}`}
      onClick={() => {
        noteClick(c);
        c.run();
      }}
      disabled={!!why}
      data-tour={c.id}
      aria-pressed={active}
      title={`${c.label}${c.keys ? `  (${c.keys})` : ""}${why ? "\n" + why : c.hint ? "\n" + c.hint : ""}`}
    >
      <Icon name={c.icon ?? "more"} size={big ? 22 : 20} />
      <span className="tool__label">{c.short ?? c.label}</span>
    </button>
  );
}

/** Menu rows for commands ("#Heading" entries become section heads), with hints or the reason one can't run. */
function MenuItems({ ids, onPick }: { ids: string[]; onPick: (c: Command) => void }) {
  const state = useApp();
  return (
    <div role="menu">
      {ids.map((id) => {
        if (id.startsWith("#")) return <div key={id} className="groupmenu__head">{id.slice(1)}</div>;
        const c = commandById(id);
        const why = whyUnavailable(c, state);
        return (
          <button key={id} role="menuitem" disabled={!!why} className={`groupmenu__item ${c.on?.(state) ? "is-on" : ""}`} onClick={() => onPick(c)}>
            <Icon name={c.icon ?? "more"} size={20} />
            <span className="groupmenu__text">
              <b>{c.label}</b>
              {why ? <small className="groupmenu__why">{why}</small> : c.hint && <small>{c.hint}</small>}
            </span>
            {c.keys && <kbd>{c.keys}</kbd>}
          </button>
        );
      })}
    </div>
  );
}

/** The variant of each tool family used last, so its button repeats it (this session). */
const lastVariant: Record<string, string> = {};

/**
 * A tool with variants (rectangle: 2-point, center, 3-point): the button runs the variant used last, the narrow
 * arrow beside it lists the others. One button per kind of shape keeps the bar short without hiding anything.
 */
function SplitTool({ family, ids, activeId }: { family: string; ids: string[]; activeId?: string }) {
  const state = useApp();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const [, redraw] = useState(0);
  const current = activeId && ids.includes(activeId) ? activeId : ids.includes(lastVariant[family] ?? "") ? lastVariant[family]! : ids[0]!;
  const c = commandById(current);
  const why = whyUnavailable(c, state);
  const active = (!!activeId && ids.includes(activeId)) || ids.some((id) => commandById(id).on?.(state));
  const run = (cmd: Command) => {
    lastVariant[family] = cmd.id;
    setOpen(false);
    redraw((n) => n + 1);
    noteClick(cmd);
    cmd.run();
  };
  return (
    <div className={`split ${active ? "is-active" : ""}`} ref={setAnchor}>
      <button
        className={`tool ${active ? "is-active" : ""}`}
        onClick={() => run(c)}
        disabled={!!why}
        data-tour={c.id}
        aria-pressed={active}
        title={`${c.label}${c.keys ? `  (${c.keys})` : ""}${why ? "\n" + why : c.hint ? "\n" + c.hint : ""}`}
      >
        <Icon name={c.icon ?? "more"} size={20} />
        <span className="tool__label">{family}</span>
      </button>
      {ids.length > 1 && (
        <button
          className={`split__more ${open ? "is-open" : ""}`}
          onClick={() => setOpen(!open)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`${family}: ${ids.length} ways`}
          title={`${family}: ${ids.length} ways`}
        >
          <Icon name="chevronDown" size={10} />
        </button>
      )}
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} className="groupmenu__pop" placement="bottom-start">
        <MenuItems ids={ids} onPick={run} />
      </Popover>
    </div>
  );
}

/** Small icon-only buttons in two rows: every sketch constraint at a glance. */
function ConstraintGrid({ ids }: { ids: string[] }) {
  const state = useApp();
  return (
    <div className="cgrid">
      {ids.map((id) => {
        const c = commandById(id);
        const on = !!c.on?.(state);
        return (
          <button key={id} className={`cgrid__btn ${on ? "is-active" : ""}`} onClick={c.run} aria-pressed={on} aria-label={c.label} title={`${c.label}\n${c.hint ?? ""}`} data-tour={id}>
            <Icon name={c.icon ?? "link"} size={16} />
          </button>
        );
      })}
    </div>
  );
}

/** Every command of a group, with hints, in a dropdown that stays inside the window and scrolls. */
function GroupMenu({ label, ids, asTool }: { label: string; ids: string[]; asTool?: boolean }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
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
        <MenuItems
          ids={ids}
          onPick={(c) => {
            setOpen(false);
            noteClick(c);
            c.run();
          }}
        />
      </Popover>
    </div>
  );
}

function Group({ label, ids, more, menu, activeId }: { label: string; ids: string[]; more?: string[]; menu?: string[]; activeId?: string }) {
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
        {ids.map((id) =>
          MODEL_FAMILIES[id] ? <SplitTool key={id} family={MODEL_FAMILIES[id].name} ids={MODEL_FAMILIES[id].ids} activeId={activeId} /> : <ToolButton key={id} c={commandById(id)} active={id === activeId} />,
        )}
      </div>
      {more ? <GroupMenu label={label} ids={menu ?? (ids.every((i) => more.includes(i)) ? more : [...ids, ...more.filter((i) => !ids.includes(i))])} /> : <span className="toolgroup__label">{label}</span>}
    </div>
  );
}

/** Modeling tools with variants: the toolbar button repeats the one used last, its arrow lists the rest. */
const MODEL_FAMILIES: Record<string, { name: string; ids: string[] }> = {
  box: { name: "Shape", ids: ["box", "cylinder", "sphere", "cone", "torus", "tube"] },
  fillet: { name: "Fillet", ids: ["fillet", "fillet-all"] },
  chamfer: { name: "Chamfer", ids: ["chamfer", "chamfer-all"] },
  sweep: { name: "Sweep", ids: ["sweep", "pipe"] },
  measure: { name: "Measure", ids: ["measure", "check-geometry"] },
  pattern: { name: "Pattern", ids: ["pattern", "mirror"] },
};

/** Sketch tool families: one button each, the other ways to draw it behind its arrow. */
const SKETCH_CREATE: Record<string, string[]> = {
  Line: ["tool-line", "tool-segment", "tool-linem", "tool-path"],
  Rectangle: ["tool-rect", "tool-crect", "tool-rect3"],
  Circle: ["tool-circle", "tool-circle2", "tool-circle3", "tool-tan2c", "tool-tan3c"],
  Arc: ["tool-arc", "tool-carc", "tool-tarc"],
  Polygon: ["tool-polygon", "tool-polygonc", "tool-polygone"],
  Ellipse: ["tool-ellipse", "tool-earc"],
  Slot: ["tool-slot", "tool-slotw", "tool-sloto", "tool-slotc", "tool-slota", "tool-slotp"],
  Spline: ["tool-spline", "tool-cspline", "tool-conic"],
};
/** The first five are corners and pieces, the rest copies and moves (the Modify menu splits them there). */
const SKETCH_MODIFY: Record<string, string[]> = {
  Fillet: ["tool-sfillet", "tool-schamfer"],
  Trim: ["tool-trim", "tool-extend", "geo-break"],
  Offset: ["tool-soffset", "geo-offset"],
  Mirror: ["geo-mirror-line", "geo-mirror-y", "geo-mirror-x"],
  Move: ["geo-move", "geo-copy", "geo-stretch", "geo-scale", "geo-grid", "geo-circular"],
};
const SKETCH_CONSTRAINTS = ["coincident", "horizontal", "vertical", "parallel", "perpendicular", "tangent", "equal", "fixed", "symmetric", "midpoint", "collinear", "concentric"].map((t) => `constrain-${t}`);
/** Sketch tools whose command id isn't simply "tool-" and the tool's name. */
const SKETCH_TOOL_IDS: Record<string, string> = { polygonC: "tool-polygonc", polygonE: "tool-polygone", slotW: "tool-slotw", slotO: "tool-sloto", lineM: "tool-linem", slotC: "tool-slotc", slotA: "tool-slota", slotP: "tool-slotp" };

/**
 * Which tools sit on the toolbar and which wait in the group menu depends on
 * the workspace profile: newcomers see the essentials, professionals the lot.
 */
function toolsFor(profile: Profile | null) {
  const pro = profile === "engineer" || profile === "designer";
  // Ordered the way the work flows (Create, Modify, Assemble, Construct, Inspect, Insert), the layout most CAD users already know.
  const solids = ["#From a sketch", "extrude", "revolve", "sweep", "loft", "pipe", "rib", "web", "#Features", "hole", "thread", "thread-face", "spring", "emboss", "engrave", "boundary-fill", "#Repeat", "pattern", "mirror"];
  const primitives = ["#Primitives", "box", "cylinder", "sphere", "cone", "torus", "tube"];
  const curves = ["#3D curves", "curve-3d", "curve-edges", "curve-faces", "curve-project"];
  return {
    create: { primary: pro ? ["extrude", "revolve", "sweep", "loft", "hole", "pattern"] : ["extrude", "revolve", "hole", "box", "pattern"], more: [...solids, ...primitives, ...curves] },
    modify: pro
      ? { primary: ["press-pull", "fillet", "chamfer", "shell", "draft", "move"], more: ["#Faces", "press-pull", "replace-face", "delete-face", "split-faces", "draft", "#Edges", "fillet", "chamfer", "fillet-all", "chamfer-all", "#Bodies", "shell", "move", "combine", "mirror", "pattern", "split", "offset", "scale", "bounding-solid", "align"] }
      : { primary: ["fillet", "chamfer", "shell", "move", "combine"], more: ["#Faces", "press-pull", "replace-face", "delete-face", "split-faces", "draft", "#Edges", "fillet", "chamfer", "fillet-all", "chamfer-all", "#Bodies", "shell", "move", "combine", "mirror", "pattern", "split", "offset", "scale", "bounding-solid", "align"] },
  };
}

/** Vertical wheel scrolls an overflowing toolbar sideways. */
const wheelX = (e: React.WheelEvent<HTMLElement>) => {
  const el = e.currentTarget;
  if (el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
};

/** The ribbon: workspace tabs over the tool groups of the chosen tab (a sketch shows its own contextual tab). */
export function Toolbar() {
  const mode = useApp((s) => s.mode);
  const tab = useApp((s) => s.ribbonTab);
  const sketching = mode.kind === "sketch";
  const tabs: { id: "solid" | "surface" | "tools"; label: string }[] = [
    { id: "solid", label: "Solid" },
    { id: "surface", label: "Surface" },
    { id: "tools", label: "Tools" },
  ];
  return (
    <div className="ribbon">
      <div className="ribbon__tabs" role="tablist" aria-label="Workspace">
        {sketching ? (
          <button role="tab" aria-selected className="ribbon__tab ribbon__tab--sketch is-active">
            Sketch
          </button>
        ) : (
          tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={`ribbon__tab ${tab === t.id ? "is-active" : ""}`} onClick={() => useApp.setState({ ribbonTab: t.id })}>
              {t.label}
            </button>
          ))
        )}
      </div>
      <RibbonBody tab={tab} />
    </div>
  );
}

function RibbonBody({ tab }: { tab: "solid" | "surface" | "tools" }) {
  const mode = useApp((s) => s.mode);
  const profile = useApp((s) => s.prefs.profile);
  const labels = useApp((s) => s.prefs.toolLabels);
  const { create, modify } = toolsFor(profile);
  if (mode.kind === "sketch") {
    const active = mode.tool === "select" ? "tool-select" : mode.tool === "polyline" ? "tool-line" : (SKETCH_TOOL_IDS[mode.tool] ?? `tool-${mode.tool}`);
    const modifyIds = Object.values(SKETCH_MODIFY).flat();
    return (
      <div className={`toolbar toolbar--sketch ${labels ? "" : "toolbar--icons"}`} role="toolbar" aria-label="Sketch tools">
        <div className="toolbar__scroll" onWheel={wheelX}>
          <div className="toolgroup" role="group" aria-label="Select">
            <div className="toolgroup__tools">
              <ToolButton c={commandById("tool-select")} active={active === "tool-select"} />
              <ToolButton c={commandById("construction")} />
            </div>
            <span className="toolgroup__label">Select</span>
          </div>
          <div className="toolgroup" role="group" aria-label="Create">
            <div className="toolgroup__tools">
              {Object.entries(SKETCH_CREATE).map(([family, ids]) => (
                <SplitTool key={family} family={family} ids={ids} activeId={active} />
              ))}
            </div>
            <GroupMenu label="Create" ids={[...Object.entries(SKETCH_CREATE).flatMap(([family, ids]) => [`#${family}`, ...ids]), "#More", "tool-gpoint", "tool-text", "tool-gear"]} />
          </div>
          <div className="toolgroup" role="group" aria-label="Modify">
            <div className="toolgroup__tools">
              {Object.entries(SKETCH_MODIFY).map(([family, ids]) => (
                <SplitTool key={family} family={family} ids={ids} activeId={active} />
              ))}
            </div>
            <GroupMenu
              label="Modify"
              ids={["#Corners and pieces", ...modifyIds.slice(0, 5), "#Copy and move", "sketch-copy", "sketch-paste", ...modifyIds.slice(5), "#A whole shape", "make-constrainable", "duplicate", "rotate-shape", "mirror-shape-y", "mirror-shape-x", "offset-shape", "#Remove", "delete"]}
            />
          </div>
          <div className="toolgroup" role="group" aria-label="Constrain">
            <div className="toolgroup__tools">
              <ToolButton c={commandById("tool-dimension")} active={active === "tool-dimension"} />
              <ConstraintGrid ids={SKETCH_CONSTRAINTS} />
            </div>
            <GroupMenu label="Constrain" ids={["#Size", "tool-dimension", "#Relations", "auto-constrain", ...SKETCH_CONSTRAINTS, "#Dimensions", "constrain-distance", "constrain-diameter", "constrain-radius", "constrain-angle"]} />
          </div>
          <Group
            label="Insert"
            ids={[]}
            more={["#From the model", "tool-project", "sketch-intersect", "#Text and parts", "tool-text", "tool-gear", "#Pictures and drawings", "import-image", "calibrate-image", "flatten-image", "trace-image", "trace-area", "import-svg", "import-dxf", "#Save this sketch", "export-sketch-svg", "export-sketch-dxf"]}
          />
        </div>
        <button className="btn btn--accent toolbar__finish" onClick={commandById("finish-sketch").run} data-tour="finish-sketch" aria-label="Finish sketch" title="Finish sketch">
          <Icon name="finish" size={18} /> <span className="toolbar__finish-label">Finish sketch</span>
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
      {tab === "solid" && (
        <>
          <Group label="Create" ids={create.primary} more={create.more} />
          <Group label="Modify" ids={modify.primary} more={modify.more} />
          <Group label="Construct" ids={[]} more={["#Planes", "plane", "construct-midplane", "construct-plane3", "construct-plane2e", "construct-planeEdge", "construct-planeTangent", "construct-planePath", "#Axes", "construct-axisCyl", "construct-axis2p", "construct-axis2pl", "construct-axisEdge", "construct-axisPerp", "#Points", "construct-pointVertex", "construct-point2e", "construct-point3pl", "construct-pointCenter", "construct-pointEdgePlane"]} />
          <Group label="Inspect" ids={["measure", "section"]} more={["#Measure", "measure", "section", "check-geometry", "interference", "#For making", "overhang", "draft-analysis", "min-radius", "accessibility", "#Surface quality", "curvature", "zebra", "#Display", "display-edges", "display-shaded", "display-wire", "display-xray", "ortho"]} />
        </>
      )}
      {tab === "surface" && (
        <>
          <Group label="Create" ids={["extrude", "revolve", "sweep", "loft", "surface-patch", "surface-ruled"]} more={["#Make", "extrude", "revolve", "sweep", "loft", "surface-patch", "surface-ruled", "surface-offset", "surface-extend"]} />
          <Group label="Modify" ids={["surface-trim", "surface-untrim", "surface-stitch", "surface-unstitch", "surface-merge", "surface-reverse", "surface-thicken"]} more={["#Edit", "surface-offset", "surface-extend", "surface-trim", "surface-untrim", "surface-stitch", "surface-unstitch", "surface-merge", "surface-reverse", "#To a solid", "surface-thicken"]} />
          <Group label="Inspect" ids={["curvature", "zebra", "measure"]} more={["#Surface quality", "curvature", "zebra", "min-radius", "#Measure", "measure", "check-geometry"]} />
        </>
      )}
      {tab === "tools" && (
        <>
          <Group label="Inspect" ids={["measure", "section", "check-geometry", "overhang"]} more={["#Measure", "measure", "section", "check-geometry", "#For making", "overhang", "draft-analysis", "min-radius", "accessibility", "#Surface quality", "curvature", "zebra"]} />
          <Group label="Display" ids={["display-shaded", "display-edges", "display-wire", "display-xray", "ortho"]} more={["#Display", "display-edges", "display-shaded", "display-wire", "display-xray", "ortho"]} />
          <Group label="Make" ids={["send-to-slicer", "export-3mf", "export-stl", "export-step"]} more={["send-to-slicer", "export-step", "export-3mf", "export-stl", "screenshot", "history"]} />
        </>
      )}
      </div>
      <div className="toolbar__fixed">
        <Group label="Insert" ids={["parts"]} more={["#Ready-made", "parts", "#From a file", "import"]} />
        <Group label="Export" ids={["export"]} more={["send-to-slicer", "export-step", "export-3mf", "export-stl", "screenshot", "history"]} />
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
      <ActivityStrip />
      <Activity />
      <span className="statusbar__meta">
        {state.kernelError ? (
          <button
            type="button"
            className="status-dot status-dot--error statusbar__retry"
            title={`${state.kernelError}
Click to try again.`}
            onClick={() => {
              toast("error", state.kernelError ?? "The geometry engine stopped.");
              retryKernel();
            }}
          >
            Engine error · Retry
          </button>
        ) : !state.kernelReady ? (
          <span className="busyline">
            <Spinner label="Loading engine" />
            Loading engine
          </span>
        ) : state.regenBusy ? (
          <span className="busyline">
            <Spinner label="Building" />
            Building{state.regenProgress && state.regenProgress.total > 1 ? ` ${state.regenProgress.done}/${state.regenProgress.total}` : ""}
          </span>
        ) : (
          <span className="status-dot status-dot--ok">{r ? `Built in ${Math.max(1, Math.round(r.ms))} ms` : "Ready"}</span>
        )}
        <ProblemsButton />
        <span className="mono">{state.doc.units}</span>
      </span>
    </footer>
  );
}

const SEVERITY_ICON = { error: "error", warning: "warning", info: "info" } as const;

/** IDE-style problem counts in the status bar; click for the list, each with where it is and a fix. */
function ProblemsButton() {
  const state = useApp();
  const list = problemsOf(state);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const count = (sev: string) => list.filter((p) => p.severity === sev).length;
  const [errors, warnings, infos] = [count("error"), count("warning"), count("info")];
  const glow = (id?: string) => {
    const f = state.doc.features.find((x) => x.id === id);
    useApp.setState({ hover: !f ? null : f.type === "sketch" ? { kind: "sketch", sketchId: f.id } : state.doc.bodies[f.id] ? { kind: "body", bodyId: f.id } : null });
  };
  return (
    <>
      <button
        ref={setAnchor}
        className={`problems-btn ${errors ? "has-errors" : warnings ? "has-warnings" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title={list.length ? "Problems and things left to finish" : "No problems found"}
        aria-label={`Problems: ${errors} errors, ${warnings} warnings, ${infos} notes`}
        aria-expanded={open}
      >
        <span className="problems-btn__n problems-btn__n--error">
          <Icon name="error" size={13} />
          {errors}
        </span>
        <span className="problems-btn__n problems-btn__n--warning">
          <Icon name="warning" size={13} />
          {warnings}
        </span>
        {infos > 0 && (
          <span className="problems-btn__n">
            <Icon name="info" size={13} />
            {infos}
          </span>
        )}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-end" className="problems">
        <header className="problems__head">
          <b>Problems</b>
          <span className="muted">{list.length ? `${list.length} item${list.length > 1 ? "s" : ""}` : ""}</span>
        </header>
        {list.length === 0 && (
          <p className="problems__empty">
            <Icon name="check" size={16} /> Everything builds and nothing is left unfinished.
          </p>
        )}
        <ul className="problems__list" onPointerLeave={() => useApp.setState({ hover: null })}>
          {list.map((p) => (
            <li key={p.key} className={`problems__item problems__item--${p.severity}`} onPointerEnter={() => glow(p.featureId)}>
              <Icon name={SEVERITY_ICON[p.severity]} size={16} />
              <div className="problems__text">
                <b>{p.title}</b>
                {p.detail && <span>{p.detail}</span>}
              </div>
              {p.fix && (
                <button
                  className="btn btn--small"
                  onClick={() => {
                    setOpen(false);
                    useApp.setState({ hover: null });
                    p.fix!.run();
                  }}
                >
                  {p.fix.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      </Popover>
    </>
  );
}

/* ───────────────────────────── Toasts ───────────────────────────── */

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => {
        const dismiss = () => useApp.setState({ toasts: useApp.getState().toasts.filter((x) => x.id !== t.id) });
        return (
          // Errors are announced at once; the rest wait for a pause.
          <div key={t.id} className={`toast toast--${t.kind}`} role={t.kind === "error" ? "alert" : undefined}>
            <span>{t.text}</span>
            {t.action && (
              <button
                className="link"
                onClick={() => {
                  // Done once: the toast goes, so a second click can't run it again.
                  dismiss();
                  t.action!.run();
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="toast__close" onClick={dismiss} aria-label="Dismiss" title="Dismiss">
              <Icon name="close" size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* ───────────────────────────── Command palette ───────────────────────────── */

/** Whole words beat word starts, which beat letters inside a word ("round" finds Fillet before Ground). */
function score(c: Command, q: string): number {
  if (!q) return 1;
  const label = c.label.toLowerCase();
  const labelWords = label.split(/[^a-z0-9]+/);
  const keyWords = `${c.keywords ?? ""} ${c.group}`.toLowerCase().split(/[^a-z0-9]+/);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  let s = 0;
  for (const w of words) {
    if (label.startsWith(w)) s += 8;
    else if (labelWords.some((x) => x.startsWith(w))) s += 6;
    else if (keyWords.includes(w)) s += 5;
    else if (keyWords.some((x) => x.startsWith(w))) s += 3;
    else if (label.includes(w) || keyWords.some((x) => x.includes(w))) s += 1;
    else return 0;
  }
  const recent = recentCommands().indexOf(c.id);
  return s + (recent >= 0 ? 1.5 - recent * 0.15 : 0);
}

export function CommandPalette() {
  const state = useApp();
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  // What can't run yet still shows (after what can), with the reason, so a search never comes up empty-handed.
  // With nothing typed, what you used lately comes first.
  const recent = q ? [] : recentCommands();
  const rank = (id: string) => (recent.includes(id) ? recent.indexOf(id) : recent.length);
  const list = COMMANDS.map((c) => ({ c, s: score(c, q), why: q ? whyUnavailable(c, state) : null }))
    .filter((x) => x.s > 0 && (q ? true : isAvailable(x.c, state)))
    .sort((a, b) => Number(!!a.why) - Number(!!b.why) || rank(a.c.id) - rank(b.c.id) || b.s - a.s)
    .slice(0, 12);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => setI(0), [q]);
  const close = () => useApp.setState({ panel: null });
  const run = (x: (typeof list)[number] | undefined) => {
    if (!x) return;
    if (x.why) return toast("info", `${x.c.label}: ${x.why}`);
    close();
    noteRun(x.c.id);
    setTimeout(x.c.run, 0);
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
          {list.map((x, k) => {
            const c = x.c;
            return (
            <li
              key={c.id}
              role="option"
              aria-selected={k === i}
              aria-disabled={!!x.why}
              className={`palette__item ${k === i ? "is-on" : ""} ${x.why ? "is-unavailable" : ""}`}
              onMouseEnter={() => setI(k)}
              onClick={() => run(x)}
            >
              <Icon name={c.icon ?? "more"} size={18} />
              <span className="palette__label">{c.label}</span>
              {x.why ? <span className="palette__hint palette__why">{x.why}</span> : c.hint && <span className="palette__hint">{c.hint}</span>}
              <span className="palette__group">{recent.includes(c.id) ? "Recent" : c.group}</span>
              {c.keys && <kbd>{c.keys}</kbd>}
            </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** Where the pointer last was, so the quick box can open under it. */
const pointer = { x: 400, y: 300 };
if (typeof window !== "undefined") window.addEventListener("pointermove", (e) => ((pointer.x = e.clientX), (pointer.y = e.clientY)), { passive: true });

/** Space: the tools that fit what you're doing, and search, in a small box at the cursor. */
export function QuickBox() {
  const state = useApp();
  const [q, setQ] = useState("");
  const close = () => useApp.setState({ panel: null });
  const kinds = new Set(state.selection.map((p) => p.kind));
  const ids =
    state.mode.kind === "sketch"
      ? ["tool-line", "tool-rect", "tool-circle", "tool-polygon", "tool-slot", "tool-select", "tool-trim", "tool-dimension", "tool-sfillet", "construction", "finish-sketch"]
      : kinds.has("edge")
        ? ["fillet", "chamfer", "measure", "hide"]
        : kinds.has("face")
          ? ["sketch", "press-pull", "hole", "fillet", "shell", "measure"]
          : kinds.has("sketch")
            ? ["extrude", "revolve", "loft", "sweep"]
            : ["sketch", "extrude", "revolve", "fillet", "shell", "hole", "box", "cylinder", "press-pull"];
  const context = ids.map(commandById).filter((c) => isAvailable(c, state));
  const found = q.trim() ? COMMANDS.map((c) => ({ c, s: score(c, q) })).filter((x) => x.s > 0 && isAvailable(x.c, state)).sort((a, b) => b.s - a.s).slice(0, 6).map((x) => x.c) : context;
  const run = (c: Command | undefined) => {
    if (!c) return;
    close();
    setTimeout(c.run, 0);
  };
  return (
    <div className="scrim scrim--clear" onMouseDown={close}>
      <div
        className="quick"
        role="dialog"
        aria-label="Quick tools"
        style={{ left: Math.min(pointer.x, window.innerWidth - 300), top: Math.min(pointer.y, window.innerHeight - 320) }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          className="quick__search"
          placeholder="Search, or pick a tool"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape" || (e.key === " " && !q)) close();
            else if (e.key === "Enter") run(found[0]);
          }}
        />
        <div className="quick__grid">
          {found.map((c) => (
            <button key={c.id} className="quick__btn" onClick={() => run(c)} title={`${c.label}${c.keys ? `  (${c.keys})` : ""}${c.hint ? " · " + c.hint : ""}`}>
              <Icon name={c.icon ?? "more"} size={20} />
              <span>{c.short ?? c.label}</span>
            </button>
          ))}
          {found.length === 0 && <span className="muted">No matching command</span>}
        </div>
      </div>
    </div>
  );
}
