/** Mounts the viewport engine and keeps it in sync with application state. */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type ConstraintType,
  type Id,
  type SketchEntity,
  type SketchFeature,
  type SketchSolution,
  type Vec2,
  type Vec3,
  CONSTRAINT_LABELS,
  LENGTH_TO_MM,
  activeEnd,
  documentEvaluator,
  entityLoops,
  geomOutline,
  isSketchConsumed,
  geomType,
  pointAt,
  resolveEntity,
  resolveGeometry,
  trim,
} from "@whittle/core";
import { handlePick, matchEdge, matchFace } from "../state/actions";
import { addSplineGeometry, projectPick, dimensionPick, addArcGeometry, addTangentArcGeometry, addTangentCircleGeometry, addCircleGeometry, addFreePoint, addLines, addShapeAsGeometry, cornerAt, editDimension, extendAt, movePoints, openSketch, trimAt } from "../state/constraintOps";
import { type Command, commandById, isAvailable } from "../state/commands";
import { thumbnailHook } from "../state/files";
import { measure } from "../state/measure";
import { cancelImagePick, imagePickPointer, placeImage, useImagePick } from "../state/refImage";
import { type Pick, editFeature, findFeature, setSketchTool, setView, sketchMutate, toast, useApp } from "../state/store";
import { type SketchUIState, SketchController } from "../viewport/sketchTools";
import { type PickFilter, type SketchDrawable, Viewport } from "../viewport/Viewport";
import { Icon } from "./icons";
import { ViewCube } from "./ViewCube";
import { Slider } from "./controls";

/** Lets App.tsx route key presses to the sketch controller first. */
export const sketchKeys: { handle: ((e: KeyboardEvent) => boolean) | null; typeDigit: ((key: string) => boolean) | null } = {
  handle: null,
  typeDigit: null,
};

const GLYPHS: Partial<Record<ConstraintType, string>> = {
  horizontal: "H",
  vertical: "V",
  parallel: "∥",
  perpendicular: "⊥",
  equal: "=",
  tangent: "⌒",
  fixed: "⌖",
  symmetric: "⇔",
  midpoint: "½",
  collinear: "⋯",
};

interface ConstraintMark {
  key: string;
  id: Id;
  /** Sketch mm. */
  at: Vec2;
  text: string;
  dim: boolean;
}

/** Where to label each constraint on the canvas: dimensions show their value, relations a glyph on each thing they relate. */
function constraintMarks(sk: SketchFeature, sol?: SketchSolution): ConstraintMark[] {
  const geo = new Map(resolveGeometry(sk, sol).map((g) => [g.id, g]));
  const mid = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  // ponytail: the axes get no label of their own; a dimension to one sits at the other end.
  const anchor = (id: Id): Vec2 | null => {
    const g = geo.get(id);
    if (!g) return id === "origin" ? [0, 0] : null;
    if (g.type === "point") return g.p;
    if (g.type === "line") return mid(g.a, g.b);
    if (g.type === "spline") return g.pts[Math.floor(g.pts.length / 2)] ?? null;
    const t = g.type === "arc" ? g.a0 + g.sweep / 2 : Math.PI / 4;
    return [g.c[0] + g.r * Math.cos(t), g.c[1] + g.r * Math.sin(t)];
  };
  const out: ConstraintMark[] = [];
  for (const c of sk.constraints ?? []) {
    if (c.value !== undefined) {
      const pts = c.refs.map(anchor).filter((p): p is Vec2 => !!p);
      if (!pts.length) continue;
      const prefix = c.type === "radius" ? "R" : c.type === "angle" ? "∠" : "";
      out.push({ key: c.id, id: c.id, at: pts.length > 1 ? mid(pts[0]!, pts[1]!) : pts[0]!, text: prefix + c.value, dim: true });
      continue;
    }
    const glyph = GLYPHS[c.type];
    if (!glyph) continue;
    let at: (Vec2 | null)[];
    if (c.type === "symmetric") {
      // Halfway between the mirrored points, which is on the mirror.
      const mirror = c.refs.find((r) => geomType(sk, r) === "line") ?? c.refs[2];
      const [a, b] = c.refs.filter((r) => r !== mirror).map(anchor);
      at = [a && b ? mid(a, b) : null];
    } else if (c.type === "midpoint") at = c.refs.filter((r) => geomType(sk, r) === "point").map(anchor);
    else at = c.refs.map(anchor);
    at.forEach((p, i) => p && out.push({ key: `${c.id}.${i}`, id: c.id, at: p, text: glyph, dim: false }));
  }
  return out;
}

const PLAIN = /^\s*-?\d*\.?\d+\s*$/;

function moveEntity(e: SketchEntity, dx: number, dy: number): SketchEntity | null {
  const add = (v: string, d: number) => (PLAIN.test(v) ? trim(parseFloat(v) + d, 4) : null);
  const c = structuredClone(e) as SketchEntity;
  const pairs: [string, number][] =
    c.type === "rect" || c.type === "text" ? [["x", dx], ["y", dy]] : c.type === "polyline" ? [] : [["cx", dx], ["cy", dy]];
  for (const [k, d] of pairs) {
    const r = add((c as unknown as Record<string, string>)[k]!, d);
    if (r === null) return null;
    (c as unknown as Record<string, string>)[k] = r;
  }
  if (c.type === "polyline") {
    for (const p of c.points) {
      const x = add(p[0], dx);
      const y = add(p[1], dy);
      if (x === null || y === null) return null;
      p[0] = x;
      p[1] = y;
    }
  }
  return c;
}

/** Commands offered by the radial menu for what was right-clicked. */
function radialFor(p: Pick | null): string[] {
  const s = useApp.getState();
  if (s.mode.kind === "sketch") return ["tool-line", "tool-rect", "tool-circle", "tool-ellipse", "tool-polygon", "tool-slot", "tool-text", "import-svg", "tool-select"];
  if (s.session) return ["ok", "cancel", "view-fit", "measure"];
  if (!p) return ["sketch", "box", "cylinder", "parts", "extrude", "import", "view-fit", "measure"];
  switch (p.kind) {
    case "face":
      return ["sketch", "hole", "shell", "move", "measure", "hide", "isolate", "section"];
    case "edge":
      return ["fillet", "chamfer", "measure", "move", "hide", "isolate"];
    case "body":
      return ["move", "mirror", "pattern", "combine", "hide", "isolate", "delete", "measure"];
    case "sketch":
      return ["extrude", "revolve", "loft", "export-sketch-svg", "export-sketch-dxf", "delete"];
    default:
      return ["sketch", "box", "view-fit"];
  }
}

function RadialMenu({ x, y, ids }: { x: number; y: number; ids: string[] }) {
  const state = useApp();
  const items = ids.map(commandById).filter((c): c is Command => !!c && isAvailable(c, state));
  const close = () => useApp.setState({ radial: null });
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);
  const R = 128;
  // Keep the whole ring inside the view.
  const host = document.querySelector(".viewport");
  const cx = host ? Math.min(Math.max(x, R + 70), host.clientWidth - R - 70) : x;
  const cy = host ? Math.min(Math.max(y, R + 30), host.clientHeight - R - 30) : y;
  return (
    <div className="radial" style={{ left: cx, top: cy }} role="menu" aria-label="Quick actions" onPointerDown={(e) => e.stopPropagation()}>
      <button className="radial__hub" onClick={close} aria-label="Close">
        <Icon name="close" size={14} />
      </button>
      {items.map((c, i) => {
        const a = -Math.PI / 2 + (i / items.length) * Math.PI * 2;
        return (
          <button
            key={c.id}
            role="menuitem"
            className={`radial__item ${c.on?.(state) ? "is-on" : ""}`}
            style={{ transform: `translate(${Math.cos(a) * R}px, ${Math.sin(a) * R}px)`, animationDelay: `${i * 14}ms` }}
            onClick={() => {
              close();
              c.run();
            }}
          >
            <Icon name={c.icon ?? "more"} size={18} />
            <span>{c.label}</span>
            {c.keys && <kbd>{c.keys}</kbd>}
          </button>
        );
      })}
    </div>
  );
}

function DockButton({ id, label }: { id: string; label?: string }) {
  const state = useApp();
  const c = commandById(id);
  const on = c.on?.(state);
  return (
    <button
      className={`dock__btn ${on ? "is-on" : ""}`}
      onClick={c.run}
      disabled={!isAvailable(c, state)}
      aria-pressed={c.on ? !!on : undefined}
      title={`${c.label}${c.keys ? `  (${c.keys})` : ""}${c.hint ? "\n" + c.hint : ""}`}
    >
      <Icon name={c.icon ?? "more"} size={18} />
      {label && <span>{label}</span>}
    </button>
  );
}

/** The floating view dock: display style, inspection tools and capture. */
function ViewDock() {
  return (
    <div className="dock" role="toolbar" aria-label="View">
      <div className="dock__group" aria-label="Display style">
        <DockButton id="display-edges" />
        <DockButton id="display-shaded" />
        <DockButton id="display-wire" />
        <DockButton id="display-xray" />
      </div>
      <div className="dock__group">
        <DockButton id="measure" label="Measure" />
        <DockButton id="section" label="Section" />
      </div>
      <div className="dock__group" aria-label="Analysis">
        <DockButton id="overhang" label="Overhangs" />
        <DockButton id="draft-analysis" label="Draft" />
        <DockButton id="zebra" label="Zebra" />
      </div>
      <div className="dock__group">
        <DockButton id="grid" />
        <DockButton id="ortho" />
        <DockButton id="view-fit" />
        <DockButton id="screenshot" />
      </div>
    </div>
  );
}

function SectionControl({ vp }: { vp: Viewport | null }) {
  const section = useApp((s) => s.view.section);
  const units = useApp((s) => s.doc.units);
  useApp((s) => s.regen);
  if (!section) return null;
  const [lo, hi] = vp?.sectionRange(section.axis) ?? [-50, 50];
  const f = LENGTH_TO_MM[units];
  return (
    <div className="floatcard section-card" role="group" aria-label="Section view">
      <div className="floatcard__head">
        <Icon name="section" size={16} />
        <b>Section</b>
        <button className="iconbtn iconbtn--small" onClick={() => setView({ section: null })} aria-label="Close section view">
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="seg seg--small" role="radiogroup">
        {(["x", "y", "z"] as const).map((a) => (
          <button key={a} role="radio" aria-checked={section.axis === a} className={section.axis === a ? "is-on" : ""} onClick={() => setView({ section: { ...section, axis: a, offset: 0 } })}>
            {a.toUpperCase()}
          </button>
        ))}
        <button title="Flip which side is kept" onClick={() => setView({ section: { ...section, flip: !section.flip } })}>
          Flip
        </button>
      </div>
      <Slider
        min={lo - 0.01}
        max={hi + 0.01}
        step={(hi - lo) / 400 || 0.1}
        value={Math.min(hi, Math.max(lo, section.offset))}
        onChange={(v) => setView({ section: { ...section, offset: v } })}
        ariaLabel="Section position"
        format={(v) => `${trim(v / f, 2)} ${units}`}
      />
      <div className="mono small muted">
        {section.axis.toUpperCase()} = {trim(section.offset / f, 2)} {units}
      </div>
    </div>
  );
}

export function ViewportView() {
  const host = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState<Viewport | null>(null);
  const [sketchUI, setSketchUI] = useState<SketchUIState | null>(null);
  const [, setCamTick] = useState(0);
  const [typing, setTyping] = useState<{ key: "a" | "b"; text: string } | null>(null);
  const cameraListeners = useMemo(() => new Set<() => void>(), []);
  const tick = useMemo(() => ({ subscribe: (fn: () => void) => (cameraListeners.add(fn), () => void cameraListeners.delete(fn)) }), [cameraListeners]);

  const doc = useApp((s) => s.doc);
  const regen = useApp((s) => s.regen);
  const mode = useApp((s) => s.mode);
  const session = useApp((s) => s.session);
  const selection = useApp((s) => s.selection);
  const hover = useApp((s) => s.hover);
  const theme = useApp((s) => s.theme);
  const view = useApp((s) => s.view);
  const picks = useApp((s) => s.measure);
  const radial = useApp((s) => s.radial);
  const selectedEntity = useApp((s) => s.selectedEntity);
  const sketchSel = useApp((s) => s.sketchSel);
  const viewRequest = useApp((s) => s.viewRequest);
  const regenBusy = useApp((s) => s.regenBusy);
  const kernelReady = useApp((s) => s.kernelReady);
  const radialPick = useRef<Pick | null>(null);

  const sketchId = mode.kind === "sketch" ? mode.sketchId : null;
  const frame = sketchId ? regen?.sketches.find((s) => s.id === sketchId) ?? null : null;
  const sessionFeature = session ? findFeature(doc, session.featureId) : undefined;

  // Sketch controller (one per viewport).
  const controller = useMemo(
    () =>
      new SketchController({
        pixelSize: () => vpRef.current?.pixelSize ?? 1,
        gridSpacing: () => vpRef.current?.gridSpacing ?? 10,
        entities: () => {
          const s = useApp.getState();
          return s.mode.kind === "sketch" ? findFeature(s.doc, s.mode.sketchId, "sketch")?.entities ?? [] : [];
        },
        evaluator: () => documentEvaluator(useApp.getState().doc),
        add: (e, select) => {
          if (!select && addShapeAsGeometry(e)) return;
          sketchMutate("Add shape", (s) => {
            s.entities.push(e);
          });
          if (select) {
            setSketchTool("select");
            useApp.setState({ selectedEntity: e.id });
          } else useApp.setState({ selectedEntity: null });
        },
        select: (id) => useApp.setState({ selectedEntity: id }),
        selected: () => useApp.getState().selectedEntity,
        move: (id, dx, dy) => {
          const s = useApp.getState();
          if (s.mode.kind !== "sketch") return;
          const e = findFeature(s.doc, s.mode.sketchId, "sketch")?.entities.find((x) => x.id === id);
          if (!e) return;
          const moved = moveEntity(e, dx, dy);
          if (!moved) {
            toast("info", "This shape's position comes from parameters, so it can't be dragged. Edit its values instead.");
            return;
          }
          sketchMutate(
            "Move shape",
            (sk) => {
              const i = sk.entities.findIndex((x) => x.id === id);
              if (i >= 0) sk.entities[i] = moved;
            },
            "move" + id,
          );
        },
        emit: (st) => {
          setSketchUI(st);
          if (useApp.getState().sketchStep !== st.step) useApp.setState({ sketchStep: st.step });
        },
        geometry: () => {
          const o = openSketch();
          return o ? resolveGeometry(o.sk, o.sol) : [];
        },
        addLines: (pts, closed) => {
          const o = openSketch();
          addLines(pts, closed, (p) => (typeof p === "string" ? pointAt(o!.sk, p, o!.sol) : p));
        },
        addArc: addArcGeometry,
        addTangentArc: addTangentArcGeometry,
        addCircle: addCircleGeometry,
        addTangentCircle: addTangentCircleGeometry,
        addSpline: addSplineGeometry,
        addPoint: addFreePoint,
        corner: cornerAt,
        dimension: dimensionPick,
        project: (client) => {
          // While sketching nothing in the model is pickable; open it up for this one click.
          const v = vpRef.current;
          v?.setPickFilter({ faces: true, edges: true, planes: false, sketches: false });
          const pk = v?.pick({ clientX: client[0], clientY: client[1] }) ?? null;
          v?.setPickFilter({ faces: false, edges: false, planes: false, sketches: false });
          projectPick(pk);
        },
        trim: trimAt,
        extend: extendAt,
        selectGeom: (id, additive) => {
          const cur = useApp.getState().sketchSel;
          if (!id) return useApp.setState({ sketchSel: additive ? cur : [] });
          useApp.setState({ sketchSel: additive ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id], selectedEntity: null });
        },
        selectedGeom: () => useApp.getState().sketchSel,
        moveGeom: movePoints,
      }),
    [],
  );
  const vpRef = useRef<Viewport | null>(null);

  // Mount engine.
  useEffect(() => {
    if (!host.current) return;
    const v = new Viewport(host.current, {
      onHover: (p) => useApp.setState({ hover: p }),
      onClick: (p, additive) => {
        useApp.setState({ radial: null });
        handlePick(p, additive);
      },
      onDoubleClick: (p) => {
        if (p?.kind === "sketch") editFeature(p.sketchId);
        else if (p && (p.kind === "face" || p.kind === "edge" || p.kind === "body")) editFeature(p.bodyId);
      },
      onSketchPointer: (e) => {
        if ((e.type === "move" || e.type === "down") && imagePickPointer(e.type, e.p, e.button)) return;
        controller.pointer(e);
      },
      onCamera: () => {
        for (const fn of cameraListeners) fn();
        setCamTick((t) => t + 1);
      },
      onContext: (p, screen) => {
        if (screen[0] < 0) {
          if (useApp.getState().radial) useApp.setState({ radial: null });
          return;
        }
        radialPick.current = p;
        const s = useApp.getState();
        // Right-clicking something selects it, so the menu acts on it.
        if (p && !s.session && s.mode.kind === "model" && p.kind !== "plane" && !s.selection.some((x) => JSON.stringify({ ...x, at: 0 }) === JSON.stringify({ ...p, at: 0 }))) {
          useApp.setState({ selection: [p] });
        }
        useApp.setState({ radial: { x: screen[0], y: screen[1] } });
      },
    });
    vpRef.current = v;
    setVp(v);
    thumbnailHook.get = () => v.thumbnail();
    thumbnailHook.image = (scale) => v.image(scale);
    return () => {
      thumbnailHook.get = null;
      thumbnailHook.image = null;
      v.dispose();
      vpRef.current = null;
    };
  }, [controller, cameraListeners]);

  useEffect(() => vp?.setTheme(theme), [vp, theme]);
  const nav = useApp((s) => s.prefs.nav);
  const invertZoom = useApp((s) => s.prefs.invertZoom);
  useEffect(() => vp?.setNavigation(nav, invertZoom), [vp, nav, invertZoom]);
  useEffect(() => vp?.setView(view), [vp, view]);

  // Bodies.
  useEffect(() => {
    if (!vp || !regen) return;
    vp.setBodies(regen.bodies, doc.bodies);
  }, [vp, regen, doc.bodies]);

  useEffect(() => {
    vp?.setPickBodies(regen?.pickBodies);
  }, [vp, regen]);

  // Initial framing once the first model arrives; re-frame after inserting parts.
  const framed = useRef(false);
  useEffect(() => {
    if (!vp) return;
    // A replaced document (open, template, recovery) clears regen: frame its model when it arrives.
    if (!regen) {
      framed.current = false;
      return;
    }
    if (regen.bodies.length && !framed.current) {
      framed.current = true;
      vp.viewTo("home");
    } else if (useApp.getState().fitOnRegen && !useApp.getState().regenBusy) {
      useApp.setState({ fitOnRegen: false });
      vp.viewTo("fit");
    }
  }, [vp, regen]);

  // Pick filter & planes.
  useEffect(() => {
    if (!vp) return;
    const f = sessionFeature;
    const bodiesOnly: PickFilter = { faces: true, edges: false, planes: false, sketches: false };
    let filter: PickFilter = { faces: true, edges: true, planes: false, sketches: true };
    if (mode.kind === "pickPlane") filter = { faces: true, edges: false, planes: true, sketches: false };
    else if (mode.kind === "measure") filter = { faces: true, edges: true, planes: false, sketches: false };
    else if (f?.type === "fillet" || f?.type === "chamfer") filter = { faces: false, edges: true, planes: false, sketches: false };
    else if (f?.type === "shell" || f?.type === "hole" || f?.type === "draft" || f?.type === "offsetFace") filter = bodiesOnly;
    else if (f?.type === "thread" || f?.type === "replaceFace" || f?.type === "deleteFace" || f?.type === "align") filter = bodiesOnly;
    else if (f?.type === "boundaryFill") filter = bodiesOnly;
    else if (f?.type === "rib") filter = { faces: false, edges: false, planes: false, sketches: true };
    else if (f?.type === "curve") filter = { faces: true, edges: true, planes: false, sketches: f.source === "project" };
    else if (f?.type === "construct") filter = { faces: true, edges: true, planes: false, sketches: false };
    else if (f?.type === "combine" || f?.type === "joint" || f?.type === "move" || f?.type === "mirror" || f?.type === "pattern") filter = bodiesOnly;
    else if (f?.type === "loft") filter = { faces: false, edges: false, planes: false, sketches: true };
    else if (session) filter = { faces: false, edges: false, planes: false, sketches: false };
    vp.setPickFilter(filter);
    vp.setPlanesVisible(mode.kind === "pickPlane");
  }, [vp, mode, session, sessionFeature]);

  // Sketch editing frame.
  const pendingNormal = useRef(false);
  useEffect(() => {
    if (!vp) return;
    vp.setSketchFrame(frame);
    if (frame && pendingNormal.current) {
      pendingNormal.current = false;
      vp.viewNormal(frame);
    }
  }, [vp, frame?.id, frame?.origin.join(), frame?.normal.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mode.kind === "sketch") controller.setTool(mode.tool);
    else controller.reset();
    setTyping(null);
  }, [controller, mode]);

  // View requests.
  useEffect(() => {
    if (!vp || !viewRequest) return;
    if (viewRequest.kind === "normal") {
      if (frame) vp.viewNormal(frame);
      else pendingNormal.current = true;
    } else vp.viewTo(viewRequest.kind);
  }, [vp, viewRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sketch drawables.
  useEffect(() => {
    if (!vp || !regen) return;
    const ev = documentEvaluator(doc);
    const end = activeEnd(doc);
    const list: SketchDrawable[] = [];
    const showAll = sessionFeature?.type === "loft" || sessionFeature?.type === "sweep" || sessionFeature?.type === "rib" || (sessionFeature?.type === "pattern" && sessionFeature.pattern === "path");
    for (const f of doc.features.slice(0, end)) {
      if (f.type !== "sketch") continue;
      const fr = regen.sketches.find((s) => s.id === f.id);
      if (!fr) continue;
      const active = f.id === sketchId;
      const selected = selection.some((p) => p.kind === "sketch" && p.sketchId === f.id);
      const inLoft =
        (sessionFeature?.type === "loft" && sessionFeature.sketches.includes(f.id)) ||
        (sessionFeature?.type === "sweep" && (sessionFeature.profile === f.id || sessionFeature.path === f.id));
      const hovered = hover?.kind === "sketch" && hover.sketchId === f.id;
      if (!active && !selected && !hovered && !showAll && isSketchConsumed(doc, f.id)) continue;
      const shapes: SketchDrawable["shapes"] = [];
      for (const e of f.entities) {
        try {
          const r = resolveEntity(e, ev);
          for (const pts of entityLoops(r)) {
            shapes.push({
              id: e.id,
              pts,
              closed: !(r.type === "polyline" && r.open),
              construction: !!e.construction || r.type === "text",
              selected: active ? e.id === selectedEntity : selected || inLoft,
              hovered: active ? e.id === sketchUI?.hoverEntity : hovered,
            });
          }
        } catch {
          /* errors show in the panel */
        }
      }
      // Constraint-driven geometry, coloured by how well it's defined while editing.
      const sol = fr.solution;
      const bad = new Set((f.constraints ?? []).filter((c) => sol?.bad.includes(c.id)).flatMap((c) => c.refs));
      const defined = new Set(sol?.defined);
      const markers: SketchDrawable["markers"] = [];
      for (const g of resolveGeometry(f, sol)) {
        const tone = !active ? undefined : bad.has(g.id) ? "bad" : defined.has(g.id) ? "defined" : "free";
        const isSel = active ? sketchSel.includes(g.id) : selected || inLoft;
        const isHover = active ? g.id === sketchUI?.hoverEntity : hovered;
        if (g.type === "point") {
          if (active) markers.push({ p: g.p, tone: tone!, selected: isSel, hovered: isHover });
          continue;
        }
        shapes.push({ id: g.id, pts: geomOutline(g), closed: false, construction: g.construction, selected: isSel, hovered: isHover, tone });
      }
      list.push({ id: f.id, frame: fr, active, shapes, markers, fill: active || selected || inLoft || !isSketchConsumed(doc, f.id) ? fr.fill : undefined });
    }
    vp.setSketches(list);
  }, [vp, regen, doc, sketchId, selection, hover, selectedEntity, sketchSel, sketchUI?.hoverEntity, sessionFeature]);

  // Interference boxes.
  const interference = useApp((s) => s.interference);
  useEffect(() => {
    vp?.setFlags(interference.map((i) => i.bbox as unknown as [number[], number[]]));
  }, [vp, interference]);

  // Construction planes.
  useEffect(() => {
    vp?.setConstructionPlanes(regen?.planes ?? []);
  }, [vp, regen]);

  // Reference pictures: the edited sketch's always, others unless hidden.
  useEffect(() => {
    if (!vp || !regen) return;
    const list: Parameters<Viewport["setReferenceImages"]>[0] = [];
    for (const f of doc.features.slice(0, activeEnd(doc))) {
      if (f.type !== "sketch" || !f.image || (f.image.hidden && f.id !== sketchId)) continue;
      const fr = regen.sketches.find((s) => s.id === f.id);
      if (fr) list.push({ frame: fr, image: f.image, active: f.id === sketchId });
    }
    vp.setReferenceImages(list);
  }, [vp, regen, doc, sketchId]);

  const imagePick = useImagePick();
  useEffect(() => {
    if (mode.kind !== "sketch" && imagePick.kind) cancelImagePick();
  }, [mode.kind, imagePick.kind]);
  // Paste a picture (screenshot, copied image) while sketching.
  useEffect(() => {
    if (mode.kind !== "sketch") return;
    const paste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable]")) return;
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith("image/"));
      if (!f) return;
      e.preventDefault();
      void placeImage(f, f.name || "Pasted picture");
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [mode.kind]);

  useEffect(() => {
    if (!vp) return;
    const extra: { pts: Vec2[]; closed: boolean }[] = [];
    if (imagePick.kind) {
      const pts = imagePick.cursor ? [...imagePick.pts, imagePick.cursor] : imagePick.pts;
      extra.push({ pts, closed: imagePick.kind === "flatten" && pts.length === 4 });
      const r = 6 * vp.pixelSize;
      for (const [x, y] of imagePick.pts) extra.push({ pts: [[x - r, y - r], [x + r, y + r], [x, y], [x - r, y + r], [x + r, y - r]], closed: false });
    }
    vp.setSketchPreview(frame, [...(sketchUI?.preview ?? []), ...extra], sketchUI?.guides ?? []);
  }, [vp, frame, sketchUI, imagePick]);

  // Measure.
  const measured = useMemo(() => (mode.kind === "measure" ? measure(picks, regen?.bodies ?? [], doc.units) : null), [mode.kind, picks, regen, doc.units]);
  useEffect(() => {
    vp?.setMeasure(measured?.segment ?? null);
  }, [vp, measured]);
  useEffect(() => {
    if (mode.kind !== "measure" && picks.length) useApp.setState({ measure: [] });
  }, [mode.kind, picks.length]);

  // Highlights.
  useEffect(() => {
    if (!vp) return;
    const items: { pick: Pick; style: "hover" | "select" | "ref" }[] = [];
    const f = sessionFeature;
    const pb = regen?.pickBodies ?? regen?.bodies ?? [];
    if (f && (f.type === "fillet" || f.type === "chamfer")) {
      for (const ref of f.edges) {
        const b = pb.find((x) => x.id === ref.bodyId);
        const i = b ? matchEdge(b.edges, ref) : -1;
        if (b && i >= 0) items.push({ pick: { kind: "edge", bodyId: b.id, index: i }, style: "ref" });
      }
    }
    const faceRefs = f?.type === "shell" ? f.faces : f?.type === "hole" && f.face ? [f.face] : [];
    for (const ref of faceRefs) {
      const b = pb.find((x) => x.id === ref.bodyId);
      const i = b ? matchFace(b.faces, ref) : -1;
      if (b && i >= 0) items.push({ pick: { kind: "face", bodyId: b.id, index: i }, style: "ref" });
    }
    if (f?.type === "combine") {
      if (f.target) items.push({ pick: { kind: "body", bodyId: f.target }, style: "ref" });
      for (const t of f.tools) items.push({ pick: { kind: "body", bodyId: t }, style: "select" });
    }
    if ((f?.type === "move" || f?.type === "mirror" || f?.type === "pattern") && f.bodyId) items.push({ pick: { kind: "body", bodyId: f.bodyId }, style: "ref" });
    if (mode.kind === "measure") for (const p of picks) items.push({ pick: p, style: "select" });
    else for (const p of selection) if (p.kind !== "sketch") items.push({ pick: p, style: "select" });
    if (hover && hover.kind !== "sketch" && mode.kind !== "sketch") items.push({ pick: hover, style: "hover" });
    vp.setHighlights(items);
  }, [vp, regen, selection, hover, sessionFeature, mode.kind, picks]);

  // Keyboard routing for sketch tools and typed dimensions.
  useEffect(() => {
    sketchKeys.handle = (e) => {
      if (mode.kind !== "sketch") return false;
      if (e.key === "Escape" && useImagePick.getState().kind) {
        cancelImagePick();
        return true;
      }
      return controller.key(e);
    };
    sketchKeys.typeDigit = (key) => {
      if (mode.kind !== "sketch" || !controller.busy || !/^([0-9.]|Tab)$/.test(key) || !controller.typable) return false;
      // Tab opens the first size field, digits open it with that first digit.
      setTyping({ key: "a", text: key === "Tab" ? "" : key });
      return true;
    };
    return () => {
      sketchKeys.handle = null;
      sketchKeys.typeDigit = null;
    };
  }, [controller, mode.kind]);

  const unitFactor = LENGTH_TO_MM[doc.units];
  const applyTyped = (key: "a" | "b", text: string) => {
    const v = parseFloat(text);
    const dim = sketchUI?.dims.find((d) => d.key === key);
    const isAngle = dim?.label === "∠";
    controller.setTyped(key, Number.isFinite(v) ? (isAngle ? v : v * unitFactor) : undefined);
  };

  // Snap marker & dimension positions (recomputed each render; camera changes re-render via camTick).
  const snapScreen = sketchUI?.snap && frame ? vp?.sketchToScreen(sketchUI.snap.p, frame) : null;

  const measureAt = (() => {
    if (!vp || !measured) return null;
    const seg = measured.segment;
    const p = picks[picks.length - 1];
    const anchor: Vec3 | undefined = seg
      ? [(seg[0][0] + seg[1][0]) / 2, (seg[0][1] + seg[1][1]) / 2, (seg[0][2] + seg[1][2]) / 2]
      : p && "at" in p
        ? p.at
        : undefined;
    return anchor ? vp.worldToScreen(anchor) : null;
  })();

  const contextActions = (() => {
    if (mode.kind !== "model" || session || selection.length === 0) return null;
    const p = selection[0]!;
    const ids =
      p.kind === "face"
        ? ["sketch", "hole", "shell", "measure"]
        : p.kind === "edge"
          ? ["fillet", "chamfer", "measure"]
          : p.kind === "sketch"
            ? ["extrude", "revolve", "loft"]
            : p.kind === "body"
              ? ["move", "mirror", "pattern", "combine", "hide"]
              : [];
    const list = ids.map(commandById).filter((c) => isAvailable(c));
    return list.length ? list : null;
  })();

  return (
    <section className={`viewport ${mode.kind === "sketch" ? "is-sketching" : ""} ${mode.kind === "pickPlane" || mode.kind === "measure" ? "is-picking" : ""}`} aria-label="3D view">
      <div ref={host} className="viewport__host" />

      {!kernelReady && (
        <div className="viewport__loading">
          <div className="loader" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <p>Warming up the geometry engine</p>
        </div>
      )}

      {regenBusy && kernelReady && <div className="viewport__busy" aria-live="polite" title="Rebuilding" />}

      {mode.kind === "pickPlane" && (
        <div className="viewport__banner">
          <Icon name="plane" size={16} /> Pick a plane or a flat face to sketch on
          <button className="btn btn--small btn--ghost" onClick={() => useApp.setState({ mode: { kind: "model" } })}>
            Cancel
          </button>
        </div>
      )}

      {imagePick.kind && (
        <div className="viewport__banner" role="status">
          <Icon name="image" size={16} />
          {imagePick.kind === "calibrate"
            ? `Calibrate: click ${imagePick.pts.length ? "the second point" : "the first of two points whose distance you know"}`
            : imagePick.kind === "flatten"
              ? `Flatten photo: click corner ${imagePick.pts.length + 1} of 4 of the known rectangle, in order around it`
              : "Trace one area: click inside the shape (or the gap) to outline"}
          <button className="btn btn--small btn--ghost" onClick={cancelImagePick}>
            Cancel
          </button>
        </div>
      )}

      {mode.kind === "measure" && (
        <div className="viewport__banner">
          <Icon name="measure" size={16} /> Measure: click one or two things
          <button className="btn btn--small btn--ghost" onClick={() => useApp.setState({ mode: { kind: "model" }, measure: [] })}>
            Done
          </button>
        </div>
      )}

      {contextActions && (
        <div className="context-bar" role="toolbar" aria-label="Actions for the selection">
          {contextActions.map((c) => (
            <button key={c.id} className="context-bar__btn" onClick={c.run}>
              <Icon name={c.icon ?? "more"} size={16} />
              <span>{c.label}</span>
              {c.keys && c.keys.length === 1 && <kbd>{c.keys}</kbd>}
            </button>
          ))}
          <button className="context-bar__close" onClick={() => useApp.setState({ selection: [] })} aria-label="Clear selection">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      {measured && measured.lines.length > 0 && (
        <div className="measure-card" style={measureAt ? { left: measureAt[0], top: measureAt[1] } : { left: "50%", top: 150 }} role="status">
          {measured.lines.map((l) => (
            <div key={l.label} className={`measure-card__row ${l.primary ? "is-primary" : ""}`}>
              <span>{l.label}</span>
              <b className="mono">{l.value}</b>
            </div>
          ))}
        </div>
      )}

      {snapScreen && sketchUI?.snap && sketchUI.snap.kind !== "free" && (
        <div className={`snap snap--${sketchUI.snap.kind}`} style={{ left: snapScreen[0], top: snapScreen[1] }} aria-hidden="true" />
      )}

      {frame &&
        vp &&
        mode.kind === "sketch" &&
        (() => {
          const sk = findFeature(doc, mode.sketchId, "sketch");
          if (!sk?.constraints?.length) return null;
          const bad = new Set(frame.solution?.bad);
          // Glyphs that land on the same spot line up side by side.
          const taken = new Map<string, number>();
          return constraintMarks(sk, frame.solution).map((m) => {
            const pos = vp.sketchToScreen(m.at, frame);
            if (!pos) return null;
            const spot = `${m.dim}:${Math.round(pos[0] / 6)}:${Math.round(pos[1] / 6)}`;
            const n = taken.get(spot) ?? 0;
            taken.set(spot, n + 1);
            const c = sk.constraints!.find((x) => x.id === m.id)!;
            const unit = c.type === "angle" ? "°" : m.dim ? doc.units : "";
            return (
              <button
                key={m.key}
                className={`cmark ${m.dim ? "cmark--dim mono" : "cmark--glyph"} ${sketchSel.includes(m.id) ? "is-selected" : ""} ${bad.has(m.id) ? "is-bad" : ""}`}
                style={{ left: pos[0] + n * (m.dim ? 0 : 20), top: pos[1] + n * (m.dim ? 22 : 0) }}
                data-constraint={m.id}
                aria-label={`${CONSTRAINT_LABELS[c.type]}${c.value !== undefined ? ` ${c.value}` : ""}`}
                title={m.dim ? `${CONSTRAINT_LABELS[c.type]} · double-click to edit` : CONSTRAINT_LABELS[c.type]}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  const cur = useApp.getState().sketchSel;
                  useApp.setState({ sketchSel: e.shiftKey ? (cur.includes(m.id) ? cur.filter((x) => x !== m.id) : [...cur, m.id]) : [m.id], selectedEntity: null });
                }}
                onDoubleClick={() => m.dim && void editDimension(m.id)}
              >
                {m.text}
                {unit && <small>{unit}</small>}
              </button>
            );
          });
        })()}

      {frame &&
        sketchUI?.dims.map((d) => {
          const pos = vp?.sketchToScreen(d.at as Vec2, frame);
          if (!pos) return null;
          const isAngle = d.label === "∠";
          const shown = isAngle ? trim(d.value, 1) : trim(d.value / unitFactor, 2);
          const editing = typing?.key === d.key;
          return (
            <div
              key={d.key}
              className={`dim ${editing ? "is-editing" : ""}`}
              style={{ left: pos[0], top: pos[1] }}
            >
              <span className="dim__label">{d.label}</span>
              {editing ? (
                <input
                  className="dim__input mono"
                  autoFocus
                  value={typing.text}
                  onChange={(e) => {
                    setTyping({ key: d.key, text: e.target.value });
                    applyTyped(d.key, e.target.value);
                  }}
                  onFocus={(e) => {
                    const el = e.target;
                    requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
                    applyTyped(d.key, typing.text);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Tab") {
                      e.preventDefault();
                      const other = sketchUI.dims.find((x) => x.key !== d.key);
                      if (other) setTyping({ key: other.key, text: "" });
                    } else if (e.key === "Enter") {
                      controller.key(new KeyboardEvent("keydown", { key: "Enter" }));
                      setTyping(null);
                    } else if (e.key === "Escape") {
                      controller.setTyped("a", undefined);
                      controller.setTyped("b", undefined);
                      setTyping(null);
                    }
                  }}
                />
              ) : (
                <span className="dim__value mono">
                  {shown}
                  <small>{isAngle ? "°" : doc.units}</small>
                </span>
              )}
            </div>
          );
        })}

      <SectionControl vp={vp} />
      {mode.kind !== "sketch" && <ViewDock />}
      <ViewCube viewport={vp} tick={tick} />
      {radial && <RadialMenu x={radial.x} y={radial.y} ids={radialFor(radialPick.current)} />}
    </section>
  );
}
