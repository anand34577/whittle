/**
 * The timeline: the design's history as a row of steps. Click to select,
 * double-click to edit, right-click for more. The marker shows how far the
 * model is built; drag it (or "Roll back to here") to insert steps earlier.
 */
import { useEffect, useRef, useState } from "react";
import type { Feature } from "@whittle/core";
import { activeEnd, dependents, featureInputs, reorderProblem } from "@whittle/core";
import { confirmDeleteFeature, editFeature, moveFeature, mutate, updateFeature, useApp } from "../state/store";
import { Icon } from "./icons";
import { copySteps, folderSteps, timelinePick } from "../state/steps";
import { promptDialog } from "../state/dialogs";
import { FEATURE_ICONS } from "./PropertiesPanel";

/** A menu opened at `x` stays inside the window, even for the last steps at the right end. */
const menuLeft = (x: number) => Math.max(8, Math.min(x, window.innerWidth - 248));

/** An open menu closes on a click elsewhere, on Escape (before Escape means anything else) and when the window resizes. */
function useMenuDismiss(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", close);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

interface Menu {
  f: Feature;
  index: number;
  x: number;
  y: number;
}

/** The key values of a step, for its tooltip: "10 mm · Join", "R 2 mm · 4 edges". */
export function summary(f: Feature, units: string): string {
  const v = (e: string | undefined) => (e === undefined ? "" : /^\s*-?[\d.]+\s*$/.test(e) ? `${e.trim()} ${units}` : e);
  const op = "op" in f && typeof f.op === "string" ? { new: "New body", join: "Join", cut: "Cut", intersect: "Keep overlap" }[f.op as string] : undefined;
  const n = (k: number, what: string) => `${k} ${what}${k === 1 ? "" : "s"}`;
  const parts: (string | undefined)[] = (() => {
    switch (f.type) {
      case "sketch":
        return [n(f.entities.length + (f.geometry?.length ?? 0), "shape")];
      case "extrude":
        return [f.extent === "through" ? "Through all" : f.extent === "face" ? "Up to a face" : v(f.distance) + (f.extent === "symmetric" ? " both ways" : ""), op];
      case "revolve":
        return [`${f.angle}°`, op];
      case "fillet":
        return [`R ${v(f.radius)}`, n(f.edges.length, "edge")];
      case "chamfer":
        return [v(f.distance), n(f.edges.length, "edge")];
      case "shell":
        return [`${v(f.thickness)} wall`, n(f.faces.length, "open face")];
      case "hole":
        return [`Ø ${v(f.diameter)}`, f.through ? "through" : v(f.depth) + " deep", n(f.points.length, "hole")];
      case "primitive":
        return [f.shape === "box" ? `${f.width} × ${f.depth} × ${f.height} ${units}` : `R ${v(f.radius)}`, op];
      default:
        return [op];
    }
  })();
  return parts.filter(Boolean).join(" · ");
}

export function Timeline() {
  const doc = useApp((s) => s.doc);
  const regen = useApp((s) => s.regen);
  const session = useApp((s) => s.session);
  const selection = useApp((s) => s.selection);
  const hover = useApp((s) => s.hover);
  // The step under the pointer: its parents and children are marked, and its geometry glows in the model.
  const [hot, setHot] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [dragStep, setDragStep] = useState<{ from: number; over: number } | null>(null);
  // Steps picked for copying or folding (Shift/Ctrl+click adds); mirrored where the commands can see them.
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => void (timelinePick.ids = picked), [picked]);
  const [folderMenu, setFolderMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  useMenuDismiss(!!folderMenu, () => setFolderMenu(null));
  const folders = (doc.folders ?? []).filter((x) => x.features.some((id) => doc.features.some((f) => f.id === id)));
  const folderOf = new Map(folders.flatMap((x) => x.features.map((id) => [id, x] as const)));
  const firstOf = new Set(folders.map((x) => doc.features.find((f) => x.features.includes(f.id))!.id));
  const setFolder = (id: string, label: string, recipe: (x: { name: string; open: boolean; features: string[] }) => void) =>
    mutate(label, (d) => {
      const x = d.folders?.find((y) => y.id === id);
      if (x) recipe(x);
    });
  const track = useRef<HTMLDivElement>(null);
  const end = activeEnd(doc);

  useMenuDismiss(!!menu, () => setMenu(null));

  const setRollback = (i: number | null) =>
    mutate("Move timeline marker", (d) => {
      d.rollback = i === null || i >= d.features.length ? null : i;
    });

  const markerFromPointer = (clientX: number): number => {
    const items = track.current?.querySelectorAll<HTMLElement>(".step");
    if (!items || items.length === 0) return 0;
    let idx = items.length;
    items.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (clientX < r.left + r.width / 2 && idx === items.length) idx = i;
    });
    return idx;
  };

  const isSelected = (f: Feature) =>
    session?.featureId === f.id || selection.some((p) => (p.kind === "sketch" && p.sketchId === f.id) || ((p.kind === "body" || p.kind === "face" || p.kind === "edge") && p.bodyId === f.id));

  const markerAt = drag ?? end;
  const hotFeature = doc.features.find((x) => x.id === hot);
  const parents = new Set(hotFeature ? featureInputs(hotFeature) : []);
  const children = new Set(hotFeature ? dependents(doc, hotFeature.id).map((x) => x.id) : []);
  // Hovering geometry in the model lights the step that made it.
  const hovered = hover && (hover.kind === "sketch" ? hover.sketchId : "bodyId" in hover ? hover.bodyId : null);
  const glow = (f: Feature) => {
    const target = f.type === "sketch" ? { kind: "sketch" as const, sketchId: f.id } : doc.bodies[f.id] ? { kind: "body" as const, bodyId: f.id } : null;
    const body = featureInputs(f).find((i) => doc.bodies[i]);
    useApp.setState({ hover: target ?? (body ? { kind: "body", bodyId: body } : null) });
  };

  return (
    <div className="timeline" aria-label="Timeline">
      <div className="timeline__controls">
        <button className="iconbtn" title="Go to start" aria-label="Roll back to start" onClick={() => setRollback(0)} disabled={doc.features.length === 0}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 4 V16 M15 4 L8 10 L15 16" /></svg>
        </button>
        <button className="iconbtn" title="Step back" aria-label="Step back" onClick={() => setRollback(Math.max(0, end - 1))} disabled={end === 0}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M13 4 L7 10 L13 16" /></svg>
        </button>
        <button className="iconbtn" title="Step forward" aria-label="Step forward" onClick={() => setRollback(end + 1)} disabled={end >= doc.features.length}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M7 4 L13 10 L7 16" /></svg>
        </button>
        <button className="iconbtn" title="Go to end" aria-label="Go to end" onClick={() => setRollback(null)} disabled={doc.rollback === null}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M15 4 V16 M5 4 L12 10 L5 16" /></svg>
        </button>
      </div>

      <div className="timeline__track" ref={track}>
        {doc.features.length === 0 && <span className="timeline__empty">Your design history appears here, one step per feature.</span>}
        {doc.features.map((f, i) => {
          const st = regen?.status.find((s) => s.id === f.id);
          const state = i >= end ? "rolledback" : f.suppressed ? "suppressed" : st?.state ?? "ok";
          return (
            <div key={f.id} className={`step-wrap ${folderOf.get(f.id) && !folderOf.get(f.id)!.open ? "is-folded" : ""}`}>
              {firstOf.has(f.id) && (() => {
                const fo = folderOf.get(f.id)!;
                return (
                  <button
                    className={`folder ${fo.open ? "is-open" : ""}`}
                    title={`${fo.name}: ${fo.features.length} step${fo.features.length > 1 ? "s" : ""} · click to ${fo.open ? "fold" : "open"} · right-click to rename or ungroup`}
                    onClick={() => setFolder(fo.id, fo.open ? "Fold folder" : "Open folder", (x) => void (x.open = !x.open))}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setFolderMenu({ id: fo.id, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <Icon name="folder" size={16} />
                    <span>{fo.name}</span>
                  </button>
                );
              })()}
              {i === markerAt && <Marker onDown={(e) => startDrag(e)} />}
              <button
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", f.name);
                  setDragStep({ from: i, over: i });
                }}
                onDragOver={(e) => {
                  if (!dragStep) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = reorderProblem(doc, dragStep.from, i) ? "none" : "move";
                  if (dragStep.over !== i) setDragStep({ ...dragStep, over: i });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragStep) moveFeature(dragStep.from, i);
                  setDragStep(null);
                }}
                onDragEnd={() => setDragStep(null)}
                className={`step step--${state} ${isSelected(f) || (picked.length > 1 && picked.includes(f.id)) ? "is-selected" : ""} ${folderOf.has(f.id) ? "is-in-folder" : ""} ${dragStep && dragStep.over === i && dragStep.from !== i ? (reorderProblem(doc, dragStep.from, i) ? "is-drop-blocked" : "is-drop-before") : ""} ${parents.has(f.id) ? "is-parent" : ""} ${children.has(f.id) ? "is-child" : ""} ${hovered === f.id ? "is-hovered" : ""}`}
                onPointerEnter={() => (setHot(f.id), glow(f))}
                onPointerLeave={() => (setHot(null), useApp.setState({ hover: null }))}
                title={`${f.name}${summary(f, doc.units) ? " · " + summary(f, doc.units) : ""}${st?.message ? "\n" + st.message : ""}\nDouble-click (or Enter) to edit · drag, or Alt + arrow keys, to reorder`}
                onClick={(e) => {
                  if (e.shiftKey || e.ctrlKey || e.metaKey) return setPicked((p) => (p.includes(f.id) ? p.filter((x) => x !== f.id) : [...p, f.id]));
                  setPicked([f.id]);
                  useApp.setState({
                    selection: f.type === "sketch" ? [{ kind: "sketch", sketchId: f.id }] : doc.bodies[f.id] ? [{ kind: "body", bodyId: f.id }] : [],
                  });
                }}
                onDoubleClick={() => editFeature(f.id)}
                onKeyDown={(e) => {
                  // Reordering without a mouse: Alt + arrow moves the step earlier or later, Enter edits it.
                  if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
                    e.preventDefault();
                    const to = i + (e.key === "ArrowLeft" ? -1 : 1);
                    if (to >= 0 && to < doc.features.length) moveFeature(i, to);
                  } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    editFeature(f.id);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ f, index: i, x: e.clientX, y: e.clientY });
                }}
              >
                <Icon name={FEATURE_ICONS[f.type]!} size={18} />
                {(state === "error" || state === "warning") && <span className={`step__badge step__badge--${state}`} />}
              </button>
            </div>
          );
        })}
        {markerAt >= doc.features.length && doc.features.length > 0 && <Marker onDown={(e) => startDrag(e)} />}
      </div>

      {folderMenu && (
        <div className="menu" style={{ left: menuLeft(folderMenu.x), top: folderMenu.y - 8 }} role="menu" onPointerDown={(e) => e.stopPropagation()}>
          <button
            role="menuitem"
            onClick={async () => {
              const fo = folders.find((x) => x.id === folderMenu.id);
              setFolderMenu(null);
              const name = fo && (await promptDialog({ title: "Rename folder", label: "Name", initial: fo.name, confirmLabel: "Rename" }));
              if (fo && name?.trim()) setFolder(fo.id, "Rename folder", (x) => void (x.name = name.trim()));
            }}
          >
            <Icon name="edit" size={16} /> Rename
          </button>
          <button
            role="menuitem"
            onClick={() => {
              const id = folderMenu.id;
              setFolderMenu(null);
              mutate("Ungroup folder", (d) => void (d.folders = d.folders?.filter((x) => x.id !== id)));
            }}
          >
            <Icon name="unlink" size={16} /> Ungroup
          </button>
        </div>
      )}

      {menu && (
        <div className="menu" style={{ left: menuLeft(menu.x), top: menu.y - 8 }} role="menu" onPointerDown={(e) => e.stopPropagation()}>
          <div className="menu__title">{menu.f.name}</div>
          <button role="menuitem" onClick={() => (setMenu(null), editFeature(menu.f.id))}>
            <Icon name="edit" size={16} /> Edit
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMenu(null);
              updateFeature(menu.f.id, menu.f.suppressed ? "Unsuppress" : "Suppress", (d) => void (d.suppressed = !d.suppressed));
            }}
          >
            <Icon name="suppress" size={16} /> {menu.f.suppressed ? "Turn back on" : "Turn off (suppress)"}
          </button>
          <button role="menuitem" disabled={menu.index === 0} onClick={() => (setMenu(null), moveFeature(menu.index, menu.index - 1))}>
            <Icon name="arrowLeft" size={16} /> Move earlier
          </button>
          <button role="menuitem" disabled={menu.index >= doc.features.length - 1} onClick={() => (setMenu(null), moveFeature(menu.index, menu.index + 1))}>
            <Icon name="arrowRight" size={16} /> Move later
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMenu(null);
              if (!picked.includes(menu.f.id)) timelinePick.ids = [menu.f.id];
              copySteps();
            }}
          >
            <Icon name="copy" size={16} /> Copy {picked.length > 1 && picked.includes(menu.f.id) ? `${picked.length} steps` : ""}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMenu(null);
              if (!picked.includes(menu.f.id)) timelinePick.ids = [menu.f.id];
              void folderSteps().then(() => setPicked([]));
            }}
          >
            <Icon name="folder" size={16} /> Put in a folder{picked.length > 1 && picked.includes(menu.f.id) ? ` (${picked.length} steps)` : ""}
          </button>
          <button role="menuitem" onClick={() => (setMenu(null), setRollback(menu.index))}>
            <Icon name="rollback" size={16} /> Roll back to before this
          </button>
          <button
            role="menuitem"
            className="danger"
            onClick={() => {
              setMenu(null);
              void confirmDeleteFeature(menu.f.id);
            }}
          >
            <Icon name="trash" size={16} /> Delete
          </button>
        </div>
      )}
    </div>
  );

  function startDrag(e: React.PointerEvent) {
    e.preventDefault();
    const move = (ev: PointerEvent) => setDrag(markerFromPointer(ev.clientX));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      setDrag(null);
      setRollback(markerFromPointer(ev.clientX));
    };
    // A cancelled touch puts the marker back where it was.
    const cancel = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }
}

function Marker({ onDown }: { onDown: (e: React.PointerEvent) => void }) {
  return <span className="marker" onPointerDown={onDown} title="Drag to roll the design back in time" role="slider" aria-label="Timeline marker" />;
}