/** Parameters, export, start screen, shortcuts and the guided first-part coach. */
import { useEffect, useMemo, useState } from "react";
import {
  type Parameter,
  type QuantityKind,
  documentEvaluator,
  formatQuantity,
  referencedNames,
  renameParameter,
  uid,
  validateParamName,
} from "@whittle/core";
import { COMMANDS } from "../state/commands";
import {
  type RecentFile,
  type VersionItem,
  exportDesign,
  forgetRecent,
  listVersions,
  loadDocumentConfirm,
  newDesign,
  openFromComputer,
  openPath,
  openServerDesign,
  openVersionAsCopy,
  readAutosave,
  recentFiles,
  restoreVersion,
} from "../state/files";
import { apiJson, ask } from "../state/platform";
import { exportParametersCsv } from "../state/files";
import { mutate, selectedBodyId, useApp } from "../state/store";
import { promptDialog } from "../state/dialogs";
import { TEMPLATES } from "../state/templates";
import { Icon } from "./icons";
import { Checkbox, Select } from "./controls";
import { ProfilePicker } from "./Settings";
import { Modal } from "./Modal";
import { Spinner } from "./feedback";
export { Modal };
import type { ExportFormat } from "@whittle/kernel";


/* ───────────────────────────── Parameters ───────────────────────────── */

/** Name field: edited freely, applied on Enter/blur, and every formula that uses the old name follows. */
function ParamName({ p, params }: { p: Parameter; params: Parameter[] }) {
  const [text, setText] = useState(p.name);
  useEffect(() => setText(p.name), [p.name]);
  const error = text === p.name ? null : validateParamName(text, params, p.id);
  const apply = () => {
    if (text === p.name) return;
    if (error) return setText(p.name);
    mutate(`Rename ${p.name} to ${text}`, (d) => renameParameter(d, p.name, text));
  };
  return (
    <input
      className={`input mono ${error ? "is-error" : ""}`}
      value={text}
      title={error ?? ""}
      onChange={(e) => setText(e.target.value)}
      onBlur={apply}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      aria-label="Name"
    />
  );
}

const KIND_OPTIONS: { value: QuantityKind; label: string; hint: string }[] = [
  { value: "length", label: "Length", hint: "Sizes and distances" },
  { value: "angle", label: "Angle", hint: "Degrees by default" },
  { value: "number", label: "Number", hint: "Ratios and factors" },
  { value: "count", label: "Count", hint: "Whole numbers: copies, teeth" },
];

export function ParamsDialog() {
  const doc = useApp((s) => s.doc);
  const ev = useMemo(() => documentEvaluator(doc), [doc]);
  const [draft, setDraft] = useState<{ name: string; expr: string; kind: QuantityKind }>({ name: "", expr: "", kind: "length" });
  const nameError = draft.name ? validateParamName(draft.name, doc.parameters) : null;

  const usedBy = (name: string) =>
    doc.features.filter((f) => new RegExp(`\\b${name}\\b`).test(JSON.stringify(f))).length +
    doc.parameters.filter((p) => referencedNames(p.expr).includes(name)).length;

  const update = (id: string, patch: Partial<Parameter>) =>
    mutate(
      "Edit parameter",
      (d) => {
        const p = d.parameters.find((x) => x.id === id);
        if (p) Object.assign(p, patch);
      },
      "param" + id + Object.keys(patch).join(),
    );

  const add = () => {
    if (!draft.name || nameError || !draft.expr) return;
    mutate("Add parameter", (d) => {
      d.parameters.push({ id: uid("p"), name: draft.name, expr: draft.expr, kind: draft.kind });
    });
    setDraft({ name: "", expr: "", kind: draft.kind });
  };

  return (
    <Modal title="Parameters" wide>
      <p className="modal__lede">
        Name the numbers that matter (wall thickness, screw size, overall width) and use those names in any field: <code>width / 2 + 3</code>. Change one value and the whole
        design follows.
      </p>
      <div className="ptable" role="table">
        <div className="ptable__row ptable__row--head" role="row">
          <span>Name</span>
          <span>Value or formula</span>
          <span>Kind</span>
          <span>Result</span>
          <span>Note</span>
          <span />
        </div>
        {doc.parameters.map((p) => {
          const v = ev.params.get(p.name);
          const n = usedBy(p.name);
          return (
            <div className="ptable__row" role="row" key={p.id}>
              <ParamName p={p} params={doc.parameters} />
              <input className={`input mono ${v?.ok ? "" : "is-error"}`} value={p.expr} onChange={(e) => update(p.id, { expr: e.target.value })} aria-label="Formula" title={v?.error} />
              <Select<QuantityKind> size="sm" ariaLabel="Kind" value={p.kind} onChange={(v) => update(p.id, { kind: v })} options={KIND_OPTIONS} />
              <span className={`mono ptable__result ${v?.ok ? "" : "is-error"}`} title={v?.error}>
                {v?.ok ? formatQuantity(v.value, p.kind, doc.units) : v?.error ?? ""}
              </span>
              <input className="input" placeholder={n ? `Used ${n}\u00d7` : "Unused"} value={p.comment ?? ""} onChange={(e) => update(p.id, { comment: e.target.value })} aria-label="Note" />
              <button
                className="iconbtn"
                aria-label={`Delete ${p.name}`}
                title={n ? `Used by ${n} feature(s)` : "Delete"}
                onClick={async () => {
                  if (n && !(await ask({ title: `Delete ${p.name}?`, message: `${p.name} is used ${n} time${n > 1 ? "s" : ""} in this design. Formulas that use it will show an error until you change them.`, confirmLabel: "Delete", danger: true }))) return;
                  mutate("Delete parameter", (d) => {
                    d.parameters = d.parameters.filter((x) => x.id !== p.id);
                  });
                }}
              >
                <Icon name="trash" size={16} />
              </button>
            </div>
          );
        })}
        <form
          className="ptable__row ptable__row--new"
          role="row"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input className={`input mono ${nameError ? "is-error" : ""}`} placeholder="name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} title={nameError ?? ""} aria-label="New parameter name" />
          <input className="input mono" placeholder="e.g. 40 or width / 2" value={draft.expr} onChange={(e) => setDraft({ ...draft, expr: e.target.value })} aria-label="New parameter formula" />
          <Select<QuantityKind> size="sm" ariaLabel="New parameter kind" value={draft.kind} onChange={(v) => setDraft({ ...draft, kind: v })} options={KIND_OPTIONS} />
          <span className="muted small">{nameError}</span>
          <span />
          <button className="btn btn--accent btn--small" type="submit" disabled={!draft.name || !!nameError || !draft.expr}>
            Add
          </button>
        </form>
      </div>
      {doc.parameters.length > 0 && (
        <div className="variants" role="group" aria-label="Variants">
          <div className="field__label">Variants</div>
          <p className="muted small">Save the current sizes under a name, then switch the whole design between them with one click.</p>
          <div className="variants__list">
            {(doc.variants ?? []).map((v) => {
              const active = doc.parameters.every((p) => v.values[p.name] === undefined || v.values[p.name] === p.expr);
              return (
                <span key={v.id} className={`variant ${active ? "is-on" : ""}`}>
                  <button
                    className="variant__main"
                    aria-pressed={active}
                    title={Object.entries(v.values).map(([k, x]) => `${k} = ${x}`).join("\n")}
                    onClick={() =>
                      mutate(`Use variant ${v.name}`, (d) => {
                        for (const p of d.parameters) if (v.values[p.name] !== undefined) p.expr = v.values[p.name]!;
                      })
                    }
                  >
                    {v.name}
                  </button>
                  <button
                    className="variant__x"
                    aria-label={`Delete variant ${v.name}`}
                    onClick={() =>
                      mutate("Delete variant", (d) => {
                        d.variants = (d.variants ?? []).filter((x) => x.id !== v.id);
                      })
                    }
                  >
                    <Icon name="close" size={12} />
                  </button>
                </span>
              );
            })}
            <button
              className="btn btn--small"
              onClick={async () => {
                const name = await promptDialog({
                  title: "Save variant",
                  label: "Name",
                  message: "Remembers the current value of every parameter.",
                  placeholder: "e.g. Large",
                  confirmLabel: "Save",
                  validate: (v) => (!v.trim() ? "Give it a name" : (doc.variants ?? []).some((x) => x.name.toLowerCase() === v.trim().toLowerCase()) ? "That name is taken" : null),
                });
                if (!name) return;
                mutate("Save variant", (d) => {
                  d.variants = [...(d.variants ?? []), { id: uid("va"), name: name.trim(), values: Object.fromEntries(d.parameters.map((p) => [p.name, p.expr])) }];
                });
              }}
            >
              <Icon name="plus" size={14} /> Save current as variant
            </button>
          </div>
        </div>
      )}
      {doc.parameters.length > 0 && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button
            className="btn btn--small"
            onClick={() =>
              exportParametersCsv(
                doc.parameters.map((p) => {
                  const v = ev.params.get(p.name);
                  return [p.name, p.expr, p.kind, v?.ok ? formatQuantity(v.value, p.kind, doc.units) : (v?.error ?? ""), p.comment ?? ""];
                }),
                doc.name,
              )
            }
          >
            <Icon name="export" size={16} /> Export CSV
          </button>
        </div>
      )}
    </Modal>
  );
}

/* ───────────────────────────── Export ───────────────────────────── */

export function ExportDialog() {
  const bodies = useApp((s) => s.regen?.bodies.length ?? 0);
  useApp((s) => s.selection);
  const selected = bodies > 1 ? selectedBodyId() : undefined;
  const selectedName = useApp((s) => (selected ? s.doc.bodies[selected]?.name : undefined));
  const [onlySelected, setOnlySelected] = useState(true);
  const items: { f: ExportFormat; title: string; sub: string; body: string }[] = [
    { f: "step", title: "STEP", sub: "Engineering & manufacturing", body: "Exact geometry for other CAD (Fusion, SolidWorks, Onshape, FreeCAD), CNC machining, CAM and manufacturers." },
    { f: "glb", title: "glTF (GLB)", sub: "Web, AR, games, rendering", body: "Colors and finishes included. For Blender, Unity, Unreal, three.js, product viewers and AR." },
    { f: "obj", title: "OBJ", sub: "Rendering & visualisation", body: "Opens in virtually every 3D and rendering tool: Blender, KeyShot, Cinema 4D, Rhino." },
    { f: "3mf", title: "3MF", sub: "3D printing", body: "Best for slicers (Bambu Studio, PrusaSlicer, OrcaSlicer, Cura). Keeps units, names and colors." },
    { f: "stl", title: "STL", sub: "3D printing & meshes", body: "The universal mesh format. Works with every slicer, printing service and mesh tool." },
    { f: "drawing", title: "2D drawing (SVG)", sub: "Drawings & documentation", body: "Front, top, right and isometric views on an A3 sheet with hidden lines, overall dimensions and a title block. Opens in any browser or vector editor; print to PDF." },
    { f: "ply", title: "PLY", sub: "Scanning & mesh analysis", body: "For MeshLab, CloudCompare and scan-comparison workflows." },
  ];
  return (
    <Modal title="Export">
      {bodies === 0 ? (
        <p className="modal__lede">There's nothing to export yet. Create a body first.</p>
      ) : (
        <div className="export-grid">
          {items.map((it) => (
            <button
              key={it.f}
              className="export-card"
              onClick={() => {
                useApp.setState({ panel: null });
                void exportDesign(it.f, selected && onlySelected ? selected : undefined);
              }}
            >
              <span className="export-card__fmt mono">.{it.f}</span>
              <span className="export-card__title">
                {it.title} <small>{it.sub}</small>
              </span>
              <span className="export-card__body">{it.body}</span>
            </button>
          ))}
          {selected && (
            <Checkbox className="checkrow" checked={onlySelected} onChange={setOnlySelected} label={`Only the selected body (${selectedName ?? "Body"})`} />
          )}
        </div>
      )}
    </Modal>
  );
}

/* ───────────────────────────── Shortcuts ───────────────────────────── */

export function ShortcutsDialog() {
  const groups = new Map<string, typeof COMMANDS>();
  for (const c of COMMANDS) {
    if (!c.keys) continue;
    groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
  }
  const mouse = [
    ["Left-drag", "Orbit"],
    ["Right-drag / middle-drag", "Pan"],
    ["Wheel", "Zoom to cursor"],
    ["Click", "Select (Shift adds)"],
    ["Double-click", "Edit the feature"],
    ["Right-click", "Quick actions (radial menu)"],
    ["Drop a file", "Open .whittle, import STEP / STL"],
    ["Ctrl+K", "Find any command"],
  ];
  return (
    <Modal title="Keyboard & mouse" wide>
      <div className="shortcuts">
        <section>
          <h3 className="eyebrow">Mouse</h3>
          <dl>
            {mouse.map(([k, v]) => (
              <div key={k}>
                <dt>
                  <kbd>{k}</kbd>
                </dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
        {[...groups].map(([g, cs]) => (
          <section key={g}>
            <h3 className="eyebrow">{g}</h3>
            <dl>
              {cs.map((c) => (
                <div key={c.id}>
                  <dt>
                    <kbd>{c.keys}</kbd>
                  </dt>
                  <dd>{c.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}

/* ───────────────────────────── Start screen ───────────────────────────── */

function TemplateArt({ id }: { id: string }) {
  // Small isometric line drawings, in the same hand as the icon set.
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
  if (id === "plate")
    return (
      <svg viewBox="0 0 120 80" {...common}>
        <path d="M14 46 L64 22 L108 38 L58 62 Z" />
        <path d="M14 46 V52 L58 68 V62 M58 68 L108 44 V38" opacity=".6" />
        <ellipse cx="33" cy="45" rx="4" ry="2.2" />
        <ellipse cx="62" cy="31" rx="4" ry="2.2" />
        <ellipse cx="88" cy="40" rx="4" ry="2.2" />
        <ellipse cx="60" cy="54" rx="4" ry="2.2" />
        <path d="M52 44 L68 37" strokeWidth="5" opacity=".35" />
      </svg>
    );
  if (id === "box")
    return (
      <svg viewBox="0 0 120 80" {...common}>
        <path d="M22 30 L62 14 L100 28 L60 44 Z" />
        <path d="M30 31 L62 18.5 L92 29 L60 41 Z" opacity=".6" />
        <path d="M22 30 V56 L60 72 V44 M60 72 L100 54 V28" />
      </svg>
    );
  if (id === "knob")
    return (
      <svg viewBox="0 0 120 80" {...common}>
        <ellipse cx="60" cy="24" rx="24" ry="8" />
        <ellipse cx="60" cy="24" rx="4" ry="1.6" opacity=".6" />
        <path d="M36 24 V36 C36 44 34 48 32 52 M84 24 V36 C84 44 86 48 88 52" />
        <path d="M32 52 A28 9 0 0 0 88 52" />
      </svg>
    );
  if (id === "bolt")
    return (
      <svg viewBox="0 0 120 80" {...common}>
        <path d="M44 14 L60 8 L76 14 L76 22 L60 28 L44 22 Z" />
        <path d="M44 14 L60 20 L76 14 M60 20 V28" opacity=".6" />
        <path d="M54 26 V70 M66 26 V70" />
        {[32, 38, 44, 50, 56, 62].map((y) => (
          <path key={y} d={`M54 ${y} L66 ${y + 4}`} opacity=".7" />
        ))}
      </svg>
    );
  if (id === "vase")
    return (
      <svg viewBox="0 0 120 80" {...common}>
        <ellipse cx="60" cy="12" rx="16" ry="5" />
        <path d="M44 12 C 40 30, 52 40, 46 70 M76 12 C 80 30, 68 40, 74 70 M54 15 C 60 35, 50 50, 58 74 M66 15 C 72 35, 62 50, 66 74" opacity=".7" />
        <path d="M46 70 Q 60 78 74 70" />
      </svg>
    );
  if (id === "bottle")
    return (
      <svg viewBox="0 0 120 80" {...common}>
        <path d="M54 6 H66 V16 L76 26 V72 Q60 77 44 72 V26 L54 16 Z" />
        <path d="M44 34 Q60 38 76 34" opacity=".5" />
      </svg>
    );
  if (id === "bracket")
    return (
      <svg viewBox="0 0 120 80" {...common}>
        <path d="M30 10 V70 H40 V36 L78 20 H96 V10 Z" />
        <path d="M30 10 L36 6 H102 L96 10 M96 20 L102 16 V6" opacity=".6" />
        <circle cx="35" cy="30" r="2.5" />
        <circle cx="35" cy="56" r="2.5" />
      </svg>
    );
  if (id === "handle")
    return (
      <svg viewBox="0 0 120 80" {...common}>
        <path d="M28 64 V44 C 28 26, 44 22, 60 22 C 76 22, 92 26, 92 44 V64" strokeWidth="5" opacity=".9" />
        <path d="M20 66 H100" opacity=".4" strokeDasharray="3 3" />
      </svg>
    );
  return (
    <svg viewBox="0 0 120 80" {...common}>
      <path d="M30 56 L60 42 L90 56" opacity=".4" strokeDasharray="3 3" />
      <path d="M60 18 V42" opacity=".4" strokeDasharray="3 3" />
    </svg>
  );
}

/** Relative time like "3 min ago" / "yesterday" / a date. */
export function ago(ms: number): string {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 2 * 86400) return "yesterday";
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

interface ServerDesign {
  id: string;
  name: string;
  size: number;
  version: number;
  hasThumbnail: boolean;
  updatedAt: number;
}

/** Server: the signed-in user's designs. */
function ServerLibrary() {
  const [list, setList] = useState<ServerDesign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const load = () =>
    apiJson<ServerDesign[]>("/designs")
      .then(setList)
      .catch((e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  const remove = async (d: ServerDesign) => {
    if (!(await ask({ title: `Delete "${d.name}"?`, message: "The design and all of its versions will be removed from the server. This can't be undone.", confirmLabel: "Delete design", danger: true }))) return;
    try {
      await apiJson(`/designs/${encodeURIComponent(d.id)}`, { method: "DELETE" });
      void load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const shown = (list ?? []).filter((d) => d.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <section className="library">
      <div className="library__head">
        <h3 className="eyebrow">Your designs</h3>
        {(list?.length ?? 0) > 6 && (
          <label className="parts__search">
            <Icon name="search" size={14} />
            <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          </label>
        )}
      </div>
      {error && <p className="note note--error">{error}</p>}
      {list === null && !error && <p className="loading-line"><Spinner /> Loading…</p>}
      {list?.length === 0 && <p className="muted small">Nothing saved yet. Designs you save appear here, with their full version history.</p>}
      <div className="lib-grid">
        {shown.map((d) => (
          <div key={d.id} className="lib-card">
            <button className="lib-card__open" onClick={() => void openServerDesign(d.id)} title={`Open ${d.name}`}>
              <span className="lib-card__thumb">
                {d.hasThumbnail ? <img src={`./api/designs/${encodeURIComponent(d.id)}/thumbnail?v=${d.version}`} alt="" loading="lazy" /> : <Icon name="cube" size={28} />}
              </span>
              <span className="lib-card__name">{d.name}</span>
              <small className="muted">
                {ago(d.updatedAt)} · v{d.version}
              </small>
            </button>
            <button className="iconbtn iconbtn--small lib-card__del" aria-label={`Delete ${d.name}`} onClick={() => void remove(d)}>
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Desktop: recently opened files. */
function RecentLibrary() {
  const [list, setList] = useState<RecentFile[] | null>(null);
  useEffect(() => void recentFiles().then(setList), []);
  if (!list || list.length === 0) return null;
  return (
    <section className="library">
      <h3 className="eyebrow">Recent</h3>
      <ul className="recent">
        {list.map((r) => (
          <li key={r.path} className={r.exists ? "" : "is-missing"}>
            <button className="recent__open" disabled={!r.exists} onClick={() => void openPath(r.path)} title={r.path}>
              <Icon name="file" size={16} />
              <span className="recent__name">{r.name}</span>
              <small className="recent__path muted">{r.exists ? r.path : "Moved or deleted"}</small>
              <small className="muted">{ago(r.openedAt)}</small>
            </button>
            <button
              className="iconbtn iconbtn--small"
              aria-label={`Remove ${r.name} from the list`}
              title="Remove from list"
              onClick={() => void forgetRecent(r.path).then(() => setList(list.filter((x) => x.path !== r.path)))}
            >
              <Icon name="close" size={12} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Welcome() {
  const [recovered, setRecovered] = useState<Awaited<ReturnType<typeof readAutosave>>>(null);
  const who = useApp((s) => (s.platform.kind === "server" ? (s.platform.user?.id ?? "-") : s.platform.kind));
  const ready = useApp((s) => s.platformReady);
  useEffect(() => {
    if (ready) void readAutosave().then(setRecovered);
  }, [ready, who]);
  const platform = useApp((s) => s.platform.kind);
  const profile = useApp((s) => s.prefs.profile);
  const [asked, setAsked] = useState(false);
  const close = () => useApp.setState({ panel: null });
  if (profile === null && !asked) {
    return (
      <Modal title="Welcome to Whittle" wide onClose={close}>
        <ProfilePicker onDone={() => setAsked(true)} />
      </Modal>
    );
  }
  return (
    <Modal title="Welcome to Whittle" wide onClose={close}>
      <div className="welcome">
        <section className="welcome__start">
          <h3 className="eyebrow">Start</h3>
          <button className="start-card start-card--primary" onClick={() => void newDesign("mm")}>
            <Icon name="file" />
            <span>
              <b>New design</b>
              <small>Millimetres</small>
            </span>
          </button>
          <button className="start-card" onClick={() => void newDesign("in")}>
            <Icon name="file" />
            <span>
              <b>New design</b>
              <small>Inches</small>
            </span>
          </button>
          <button className="start-card" onClick={() => void openFromComputer()}>
            <Icon name="folder" />
            <span>
              <b>{platform === "server" ? "Open from this computer" : "Open a file"}</b>
              <small>.whittle</small>
            </span>
          </button>
          {recovered && (
            <button className="start-card start-card--recover" onClick={() => void loadDocumentConfirm(recovered.doc, recovered.fileName, true)}>
              <Icon name="undo" />
              <span>
                <b>Continue where you left off</b>
                <small>
                  {recovered.doc.name} · {new Date(recovered.at).toLocaleString()}
                </small>
              </span>
            </button>
          )}
          <button className="start-card" onClick={() => useApp.setState({ panel: "parts" })}>
            <Icon name="library" />
            <span>
              <b>Start from a part</b>
              <small>Gears, fasteners, brackets, enclosures…</small>
            </span>
          </button>
          <button
            className="start-card start-card--learn"
            onClick={() =>
              void newDesign("mm", "My first part").then((ok) => {
                if (ok) useApp.setState({ coach: true, panel: null });
              })
            }
          >
            <Icon name="sparkStep" />
            <span>
              <b>Make your first part</b>
              <small>A 2-minute guided start</small>
            </span>
          </button>
        </section>
        <div className="welcome__right">
          {platform === "server" && <ServerLibrary />}
          {platform === "desktop" && <RecentLibrary />}
          <section className="welcome__templates">
            <h3 className="eyebrow">Templates: real, editable designs</h3>
            <div className="tpl-grid">
              {TEMPLATES.map((t) => (
                <button key={t.id} className="tpl" onClick={() => void loadDocumentConfirm(t.build(), null)}>
                  <span className="tpl__art">
                    <TemplateArt id={t.id} />
                  </span>
                  <span className="tpl__title">
                    {t.title} <span className="badge">{t.tag}</span>
                  </span>
                  <span className="tpl__blurb">{t.blurb}</span>
                </button>
              ))}
            </div>
            <div className="welcome__keys">
              <span>
                <kbd>S</kbd> Sketch
              </span>
              <span>
                <kbd>E</kbd> Extrude
              </span>
              <span>
                <kbd>F</kbd> Fillet
              </span>
              <span>
                <kbd>Ctrl K</kbd> Find anything
              </span>
            </div>
          </section>
        </div>
      </div>
    </Modal>
  );
}

/* ───────────────────────────── Version history ───────────────────────────── */

export function VersionsDialog() {
  const [list, setList] = useState<VersionItem[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const platform = useApp((s) => s.platform.kind);
  useEffect(() => {
    listVersions()
      .then(setList)
      .catch((e: Error) => setError(e.message));
  }, []);
  const where = platform === "server" ? "on the server" : platform === "desktop" ? "on this computer" : "in this browser";
  return (
    <Modal title="Version history">
      <div className="modal__body">
        <p className="modal__lede">Every save keeps a version {where}. Restoring makes an old version current; the one it replaces stays in the list.</p>
        {error && <p className="note note--error">{error}</p>}
        {list === undefined && !error && <p className="loading-line"><Spinner /> Loading…</p>}
        {list === null && <p className="muted">Save this design first. After that, every save is kept here.</p>}
        {list && list.length === 0 && <p className="muted">No earlier versions yet. They appear after you save again.</p>}
        {list && list.length > 0 && (
          <ol className="versions">
            {list.map((v) => (
              <li key={v.id} className={v.current ? "is-current" : ""}>
                <span className="versions__when">
                  <b>{ago(v.at)}</b>
                  <small className="muted">
                    {new Date(v.at).toLocaleString()} · {kb(v.size)}
                    {v.author ? ` · ${v.author}` : ""}
                  </small>
                </span>
                {v.current ? (
                  <span className="pill">Current</span>
                ) : (
                  <span className="btnrow">
                    <button className="btn btn--small btn--ghost" onClick={() => void openVersionAsCopy(v)} title="Open it as a separate, unsaved design">
                      Open copy
                    </button>
                    <button className="btn btn--small" onClick={() => void restoreVersion(v)}>
                      Restore
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </Modal>
  );
}

/* ───────────────────────────── Guided first part ───────────────────────────── */

export function Coach() {
  const s = useApp();
  if (!s.coach) return null;
  const doc = s.doc;
  const sketches = doc.features.filter((f) => f.type === "sketch");
  const hasShape = sketches.some((f) => f.type === "sketch" && f.entities.length > 0);
  const extruded = doc.features.some((f) => f.type === "extrude");
  const filleted = doc.features.some((f) => f.type === "fillet" && f.edges.length > 0) && !s.session;
  const exported = false;
  const steps = [
    { done: sketches.length > 0 || s.mode.kind === "pickPlane", title: "Start a sketch", body: "Press S (or the Sketch button), then click the flat XY plane." },
    { done: hasShape, title: "Draw a rectangle", body: "Click one corner, then the other. Or type 60, Tab, 40, Enter for an exact size." },
    { done: hasShape && s.mode.kind !== "sketch", title: "Finish the sketch", body: "Press Esc or click Finish sketch (top right)." },
    { done: extruded && !(s.session && doc.features.find((f) => f.id === s.session?.featureId)?.type === "extrude"), title: "Extrude it", body: "Press E, type a height (try 12), press Enter." },
    { done: filleted, title: "Round the edges", body: "Click an edge (Shift-click for more), press F, set a radius, press Enter." },
    { done: exported, title: "Share or make it", body: "Export: STEP for other CAD and machining, 3MF or STL for 3D printing." },
  ];
  const current = steps.findIndex((x) => !x.done);
  return (
    <aside className="coach" aria-label="Guided first part">
      <header>
        <b>Your first part</b>
        <button className="iconbtn" onClick={() => useApp.setState({ coach: false })} aria-label="Close guide">
          <Icon name="close" size={16} />
        </button>
      </header>
      <ol>
        {steps.map((st, i) => (
          <li key={st.title} className={st.done ? "is-done" : i === current ? "is-current" : ""}>
            <span className="coach__dot">{st.done ? <Icon name="check" size={12} /> : i + 1}</span>
            <div>
              <b>{st.title}</b>
              {i === current && <p>{st.body}</p>}
            </div>
          </li>
        ))}
      </ol>
      {current === steps.length - 1 && (
        <button className="btn btn--accent btn--small" onClick={() => useApp.setState({ panel: "export", coach: false })}>
          Export now
        </button>
      )}
    </aside>
  );
}