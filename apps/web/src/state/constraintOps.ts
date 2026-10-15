/**
 * Constraint-driven sketch editing for the UI and the design API: drawing
 * lines, arcs and circles, constraining, dimensioning, trimming and extending.
 * Every edit first copies the solver's last answer into the geometry, so it
 * starts from what the user sees.
 */
import type { Draft } from "immer";
import {
  type ConstraintType,
  type Id,
  type SketchFeature,
  type SketchSolution,
  type Vec2,
  CONSTRAINT_LABELS,
  DIMENSIONS,
  LENGTH_TO_MM,
  addArc,
  addCircle,
  addConstraint,
  addLine,
  bakeSolution,
  constraintsFor,
  deleteGeometry,
  documentEvaluator,
  extendGeometry,
  geomById,
  measureDimension,
  trim,
  trimGeometry,
} from "@whittle/core";
import { promptDialog } from "./dialogs";
import { findFeature, sketchMutate, toast, useApp } from "./store";

/** The open sketch and its latest solution. */
export function openSketch(): { sk: SketchFeature; sol?: SketchSolution } | null {
  const s = useApp.getState();
  if (s.mode.kind !== "sketch") return null;
  const sk = findFeature(s.doc, s.mode.sketchId, "sketch");
  if (!sk) return null;
  return { sk, sol: s.regen?.sketches.find((x) => x.id === sk.id)?.solution };
}

/** Selected geometry / constraint ids that still exist. */
export function sketchSelection(): Id[] {
  const o = openSketch();
  if (!o) return [];
  return useApp.getState().sketchSel.filter((id) => id === "origin" || id === "xaxis" || id === "yaxis" || geomById(o.sk, id) || o.sk.constraints?.some((c) => c.id === id));
}

/** Edit the open sketch's geometry, starting from the solved positions. */
export function geoMutate(label: string, recipe: (sk: Draft<SketchFeature>) => void, mergeKey?: string) {
  // Only a solution of the current document: baking an older one (mid-drag) would undo the latest move.
  const { builtDoc, doc } = useApp.getState();
  const sol = builtDoc === doc ? openSketch()?.sol : undefined;
  sketchMutate(
    label,
    (sk) => {
      bakeSolution(sk, sol);
      recipe(sk);
    },
    mergeKey,
  );
}

const AXIS_TOL = 1e-3;

/** A chain of lines through the points (ids reuse existing points); nearly level lines get Horizontal/Vertical. */
export function addLines(pts: (Vec2 | Id)[], closed: boolean, at: (p: Vec2 | Id) => Vec2) {
  if (pts.length < 2) return;
  geoMutate("Draw lines", (sk) => {
    const ends = [...pts];
    if (closed) ends.push(pts[0]!);
    let prev: Vec2 | Id = ends[0]!;
    let firstPoint: Id | undefined;
    for (let i = 1; i < ends.length; i++) {
      const next = closed && i === ends.length - 1 ? firstPoint! : ends[i]!;
      const id = addLine(sk, prev, next);
      const line = geomById(sk, id);
      if (line?.type !== "line") continue;
      if (i === 1) firstPoint = line.a;
      const [a, b] = [at(ends[i - 1]!), at(ends[i]!)];
      if (Math.abs(a[1] - b[1]) < AXIS_TOL) addConstraint(sk, "horizontal", [id]);
      else if (Math.abs(a[0] - b[0]) < AXIS_TOL) addConstraint(sk, "vertical", [id]);
      prev = line.b;
    }
  });
}

export function addArcGeometry(a: Vec2 | Id, b: Vec2 | Id, through: Vec2) {
  let failed = false;
  geoMutate("Draw arc", (sk) => {
    failed = addArc(sk, a, b, through) === null;
  });
  if (failed) toast("info", "Those three points are in a straight line. Pick a point off the line for the arc's bulge.");
}

export function addCircleGeometry(c: Vec2 | Id, r: number) {
  if (r <= 1e-9) return;
  geoMutate("Draw circle", (sk) => void addCircle(sk, c, r));
}

/** Constraint types that apply to the current selection. */
export function availableConstraints(): ConstraintType[] {
  const o = openSketch();
  const sel = sketchSelection().filter((id) => !o?.sk.constraints?.some((c) => c.id === id));
  return o ? constraintsFor(o.sk, sel) : [];
}

/** Value text for a dimension's starting value, in the document's units. */
export function measuredText(type: ConstraintType, refs: Id[]): string {
  const o = openSketch();
  if (!o) return "";
  const v = measureDimension(o.sk, type, refs, o.sol);
  if (type === "angle") return trim((v * 180) / Math.PI, 3);
  return trim(v / LENGTH_TO_MM[useApp.getState().doc.units], 4);
}

/** Check a dimension formula; null when it's fine. */
function checkValue(type: ConstraintType, text: string): string | null {
  const r = documentEvaluator(useApp.getState().doc).eval(text, type === "angle" ? "angle" : "length");
  if (!r.ok) return r.error;
  if (type !== "angle" && r.value < (type === "radius" ? 1e-9 : 0)) return type === "radius" ? "A radius must be greater than zero" : "A distance can't be negative";
  return null;
}

/** Add a constraint to the selection (asking for the value of a dimension). Returns an error message, if any. */
export async function constrainSelection(type: ConstraintType, value?: string): Promise<string | undefined> {
  const refs = sketchSelection();
  if (DIMENSIONS.includes(type) && value === undefined) {
    const v = await promptDialog({
      title: CONSTRAINT_LABELS[type],
      label: type === "angle" ? "Angle (degrees)" : "Value",
      message: "A number or a formula using parameters, e.g. width / 2.",
      initial: measuredText(type, refs),
      unit: type === "angle" ? "°" : useApp.getState().doc.units,
      validate: (t) => checkValue(type, t),
    });
    if (v === null) return undefined;
    value = v;
  }
  if (value !== undefined) {
    const bad = checkValue(type, value);
    if (bad) return bad;
  }
  let error: string | undefined;
  geoMutate(CONSTRAINT_LABELS[type], (sk) => {
    const r = addConstraint(sk, type, refs, value);
    if ("error" in r) error = r.error;
  });
  if (error) toast("info", error);
  else useApp.setState({ sketchSel: [] });
  return error;
}

/** Change a dimension's value. */
export async function editDimension(id: Id) {
  const c = openSketch()?.sk.constraints?.find((x) => x.id === id);
  if (!c || c.value === undefined) return;
  const v = await promptDialog({
    title: `Edit ${CONSTRAINT_LABELS[c.type].toLowerCase()}`,
    label: c.type === "angle" ? "Angle (degrees)" : "Value",
    initial: c.value,
    unit: c.type === "angle" ? "°" : useApp.getState().doc.units,
    validate: (t) => checkValue(c.type, t),
  });
  if (v !== null) setDimension(id, v);
}

export function setDimension(id: Id, value: string) {
  geoMutate("Edit dimension", (sk) => {
    const c = sk.constraints?.find((x) => x.id === id);
    if (c) c.value = value;
  });
}

/** Delete the selected geometry and constraints. */
export function deleteSketchSelection() {
  const ids = sketchSelection();
  if (!ids.length) return;
  geoMutate("Delete", (sk) => {
    sk.constraints = (sk.constraints ?? []).filter((c) => !ids.includes(c.id));
    deleteGeometry(sk, ids);
  });
  useApp.setState({ sketchSel: [] });
}

export function toggleGeometryConstruction() {
  const ids = sketchSelection();
  geoMutate("Toggle construction", (sk) => {
    for (const g of sk.geometry ?? []) if (ids.includes(g.id)) g.construction = !g.construction;
  });
}

export function trimAt(id: Id, p: Vec2) {
  let msg: string | undefined;
  geoMutate("Trim", (sk) => void (msg = trimGeometry(sk, id, p)));
  if (msg) toast("info", msg);
}

export function extendAt(id: Id, p: Vec2) {
  let msg: string | undefined;
  geoMutate("Extend", (sk) => void (msg = extendGeometry(sk, id, p)));
  if (msg) toast("info", msg);
}

/** Drag points (or every point of the given curves); the solver keeps the constraints. */
export function movePoints(ids: Id[], dx: number, dy: number) {
  geoMutate(
    "Move",
    (sk) => {
      const pts = new Set<Id>();
      for (const id of ids) {
        const g = geomById(sk, id);
        if (g?.type === "point") pts.add(g.id);
        else if (g?.type === "line") pts.add(g.a).add(g.b);
        else if (g?.type === "arc") pts.add(g.a).add(g.b).add(g.c);
        else if (g?.type === "circle") pts.add(g.c);
      }
      for (const g of sk.geometry ?? []) {
        if (g.type === "point" && pts.has(g.id)) {
          g.x += dx;
          g.y += dy;
        }
      }
    },
    "move" + ids.join(),
  );
}

/** Resize a circle by dragging its edge. */
export function setCircleRadius(id: Id, r: number) {
  geoMutate(
    "Resize circle",
    (sk) => {
      const g = geomById(sk, id);
      if (g?.type === "circle" && r > 1e-6) g.r = r;
    },
    "radius" + id,
  );
}
