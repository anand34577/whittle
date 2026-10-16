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
  endTangent,
  resolveGeometry,
  tangentArcThrough,
  addCircle,
  addConstraint,
  addLine,
  bakeSolution,
  constraintsFor,
  deleteGeometry,
  type SketchEntity,
  addEntityGeometry,
  addPoint,
  addProjectedPolyline,
  addSpline,
  circularPattern,
  linearPattern,
  mirrorGeometry,
  offsetGeometry,
  documentEvaluator,
  extendGeometry,
  filletCorner,
  resolveEntity,
  geomById,
  geomType,
  measureDimension,
  trim,
  trimGeometry,
} from "@whittle/core";
import { promptDialog } from "./dialogs";
import { breakLine, moveGeometry, rectPattern, scaleGeometry } from "@whittle/core";
import { smartSketchOn } from "./prefs";
import { type Pick, findFeature, sketchMutate, toast, useApp } from "./store";

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

/** An arc that leaves the end of a line or arc smoothly (tangent), ending at `to`. */
export function addTangentArcGeometry(from: Id | undefined, to: Vec2) {
  const o = openSketch();
  if (!o) return;
  if (!from) return void toast("info", "Start a tangent arc on the end of a line or arc.");
  const geo = resolveGeometry(o.sk, o.sol);
  const p = geo.find((g) => g.id === from);
  const t = p?.type === "point" ? endTangent(geo, p.p) : null;
  const arc = p?.type === "point" && t ? tangentArcThrough(p.p, t.dir, to) : null;
  if (!t || !arc) return void toast("info", t ? "Pick an end point that isn't straight ahead of the line." : "Start a tangent arc on the end of a line or arc.");
  geoMutate("Draw tangent arc", (sk) => {
    const id = addArc(sk, from, to, arc.through);
    if (id) addConstraint(sk, "tangent", [t.curve, id]);
  });
}

/** A circle tangent to two or three curves; `guess` is where its center roughly is (picks one of the solutions). */
export function addTangentCircleGeometry(refs: Id[], guess: Vec2) {
  const o = openSketch();
  if (!o || refs.length < 2) return;
  const geo = resolveGeometry(o.sk, o.sol);
  const gap = (id: Id): number => {
    const g = geo.find((x) => x.id === id);
    if (g?.type === "line") {
      const [dx, dy] = [g.b[0] - g.a[0], g.b[1] - g.a[1]];
      const l = Math.hypot(dx, dy) || 1;
      return Math.abs((guess[0] - g.a[0]) * dy - (guess[1] - g.a[1]) * dx) / l;
    }
    if (g?.type === "circle" || g?.type === "arc") return Math.abs(Math.hypot(guess[0] - g.c[0], guess[1] - g.c[1]) - g.r);
    return Infinity;
  };
  const r = Math.min(...refs.map(gap));
  if (!isFinite(r) || r < 1e-6) return void toast("info", "Click a spot between the curves, away from them, for the circle's center.");
  let failed: string | undefined;
  geoMutate("Draw tangent circle", (sk) => {
    const id = addCircle(sk, guess, r);
    if (!id) return;
    for (const ref of refs) {
      const res = addConstraint(sk, "tangent", [id, ref]);
      if ("error" in res) failed = res.error;
    }
    // Two tangents leave one freedom: keep the radius it was drawn with (change it with a dimension).
    if (refs.length === 2) addConstraint(sk, "radius", [id], String(Math.round(r * 1000) / 1000));
  });
  if (failed) toast("info", failed);
}

export function addCircleGeometry(c: Vec2 | Id, r: number) {
  if (r <= 1e-9) return;
  geoMutate("Draw circle", (sk) => void addCircle(sk, c, r));
}

export function addSplineGeometry(pts: (Vec2 | Id)[], closed: boolean) {
  let failed = false;
  geoMutate("Draw spline", (sk) => void (failed = addSpline(sk, pts, closed) === null));
  if (failed) toast("info", "A spline needs at least two points (three to close it).");
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
export async function constrainSelection(type: ConstraintType, value?: string, at?: [number, number]): Promise<string | undefined> {
  const refs = sketchSelection();
  if (DIMENSIONS.includes(type) && value === undefined) {
    const v = await promptDialog({
      at,
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
  let added: Id | undefined;
  // First dimension on a sketch drawn at a very different size: scale it all, so one number doesn't turn the rest inside out.
  const o = openSketch();
  let scale = 1;
  if (o && value !== undefined && (type === "distance" || type === "radius") && !(o.sk.constraints ?? []).some((c) => DIMENSIONS.includes(c.type))) {
    const want = documentEvaluator(useApp.getState().doc).eval(value, "length");
    const have = measureDimension(o.sk, type, refs, o.sol);
    if (want.ok && have > 1e-9 && want.value > 0 && (want.value / have > 2.5 || want.value / have < 0.4)) scale = want.value / have;
  }
  geoMutate(CONSTRAINT_LABELS[type], (sk) => {
    if (scale !== 1) scaleGeometry(sk, (sk.geometry ?? []).map((g) => g.id), scale, [0, 0]);
    const r = addConstraint(sk, type, refs, value);
    if ("error" in r) error = r.error;
    else added = r.id;
  });
  if (error) toast("info", error);
  else {
    useApp.setState({ sketchSel: [] });
    if (scale !== 1) toast("info", "The whole sketch was scaled to fit your first dimension.");
    if (added && DIMENSIONS.includes(type)) void keepOrReference(added);
  }
  return error;
}

/** A dimension that over-constrains the sketch becomes a reference (driven) one, shown in brackets, instead of a conflict. */
async function keepOrReference(id: Id) {
  const ok = await new Promise<boolean>((resolve) => {
    const done = () => (unsub(), clearTimeout(timer), resolve(useApp.getState().builtDoc === useApp.getState().doc));
    const unsub = useApp.subscribe((st) => st.builtDoc === st.doc && done());
    const timer = setTimeout(done, 5000);
    if (useApp.getState().builtDoc === useApp.getState().doc) done();
  });
  const sol = openSketch()?.sol;
  if (!ok || !sol || sol.state !== "over" || !sol.bad.includes(id)) return;
  geoMutate("Reference dimension", (sk) => {
    const c = sk.constraints?.find((x) => x.id === id);
    if (c) c.driven = true;
  });
  toast("info", "The sketch already fixes that, so it was added as a reference dimension (in brackets). It measures; it doesn't drive.");
}

/** Change a dimension's value. */
export async function editDimension(id: Id, at?: [number, number]) {
  const c = openSketch()?.sk.constraints?.find((x) => x.id === id);
  if (!c || c.value === undefined) return;
  const v = await promptDialog({
    at,
    title: `Edit ${CONSTRAINT_LABELS[c.type].toLowerCase()}`,
    label: c.type === "angle" ? "Angle (degrees)" : "Value",
    initial: c.driven ? measuredText(c.type, c.refs) : c.value,
    unit: c.type === "angle" ? "°" : useApp.getState().doc.units,
    validate: (t) => checkValue(c.type, t),
  });
  if (v !== null) setDimension(id, v);
}

export function setDimension(id: Id, value: string) {
  geoMutate("Edit dimension", (sk) => {
    const c = sk.constraints?.find((x) => x.id === id);
    // Typing a value into a reference dimension makes it drive the sketch.
    if (c) (c.value = value), delete c.driven;
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
        else if (g?.type === "spline") g.pts.forEach((p) => pts.add(p));
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

/** Shapes that can become constraint geometry (not ellipses, text or gears, nor rounded outlines). */
export function canConstrain(e: SketchEntity): boolean {
  if (e.type === "polyline") return !e.corner && !e.points.some((p) => p[2] === "spline") && !(e.smooth && e.points.some((p) => p[2]));
  return e.type === "rect" || e.type === "circle" || e.type === "polygon" || e.type === "slot";
}

/** Add a new shape as constraint geometry when the preference is on. Returns false when it should be added as a plain shape. */
export function addShapeAsGeometry(e: SketchEntity): boolean {
  if (!smartSketchOn(useApp.getState().prefs) || !canConstrain(e)) return false;
  try {
    const r = resolveEntity(e, documentEvaluator(useApp.getState().doc));
    geoMutate("Add shape", (sk) => void addEntityGeometry(sk, r));
    useApp.setState({ selectedEntity: null });
    return true;
  } catch {
    return false;
  }
}

/** Turn a drawn shape into constraint geometry so it can be dimensioned, constrained, trimmed and filleted. */
export function makeConstrainable(id: Id | null = useApp.getState().selectedEntity) {
  const o = openSketch();
  const e = o?.sk.entities.find((x) => x.id === id);
  if (!o || !e) return;
  if (!canConstrain(e)) {
    toast("info", "Ellipses, text, gears and rounded outlines can't be converted. Rectangles, circles, polygons, slots and lines can.");
    return;
  }
  let msg: string | undefined;
  try {
    const r = resolveEntity(e, documentEvaluator(useApp.getState().doc));
    geoMutate("Make constrainable", (sk) => {
      msg = addEntityGeometry(sk, r);
      if (!msg) sk.entities = sk.entities.filter((x) => x.id !== e.id);
    });
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  if (msg) toast("info", msg);
  else useApp.setState({ selectedEntity: null });
}

/**
 * The Dimension tool: a click on a circle or arc sets its radius, on a line its
 * length. Click a point (or Shift+click a line) to start a pair, then the second
 * item: two points or a point and a line give a distance, two lines an angle.
 */
export async function dimensionPick(id: Id, additive: boolean, at?: [number, number]) {
  const o = openSketch();
  if (!o) return;
  const kind = geomType(o.sk, id);
  const pending = sketchSelection().filter((x) => x !== id);
  if (pending.length === 1) {
    const first = geomType(o.sk, pending[0]!);
    const type: ConstraintType = first === "line" && kind === "line" ? "angle" : "distance";
    useApp.setState({ sketchSel: [pending[0]!, id] });
    if (!availableConstraints().includes(type)) {
      toast("info", "Those two items can't be dimensioned together.");
      useApp.setState({ sketchSel: [] });
      return;
    }
    await constrainSelection(type, undefined, at);
    return;
  }
  useApp.setState({ sketchSel: [id], selectedEntity: null });
  if (kind === "circle" || kind === "arc") await constrainSelection("radius", undefined, at);
  else if (kind === "line" && !additive && id !== "xaxis" && id !== "yaxis") await constrainSelection("distance", undefined, at);
}

/**
 * The Project tool: copy an edge of the model (or every edge of a face) onto the
 * sketch plane as locked geometry to draw against. `pk` is what the pointer is over.
 */
export function projectPick(pk: Pick | null) {
  const s = useApp.getState();
  if (s.mode.kind !== "sketch") return;
  const frame = s.regen?.sketches.find((x) => x.id === (s.mode as { sketchId: Id }).sketchId);
  if (!frame) return;
  if (!pk || (pk.kind !== "edge" && pk.kind !== "face")) {
    toast("info", "Click an edge or a face of the model to project it into the sketch.");
    return;
  }
  const body = s.regen?.bodies.find((b) => b.id === pk.bodyId);
  if (!body) return;
  const edges = pk.kind === "edge" ? [pk.index] : body.faceEdges[pk.index] ?? [];
  const local = (x: number, y: number, z: number): Vec2 => {
    const d = [x - frame.origin[0], y - frame.origin[1], z - frame.origin[2]];
    return [d[0]! * frame.xDir[0] + d[1]! * frame.xDir[1] + d[2]! * frame.xDir[2], d[0]! * frame.yDir[0] + d[1]! * frame.yDir[1] + d[2]! * frame.yDir[2]];
  };
  const lines: Vec2[][] = [];
  for (const ei of edges) {
    const first = body.edgeRanges[ei * 2]!;
    const count = body.edgeRanges[ei * 2 + 1]!;
    const v = body.edgePositions;
    const pts: Vec2[] = [];
    for (let k = 0; k + 1 < count; k += 2) {
      const a = (first + k) * 3;
      const b = (first + k + 1) * 3;
      if (!pts.length) pts.push(local(v[a]!, v[a + 1]!, v[a + 2]!));
      pts.push(local(v[b]!, v[b + 1]!, v[b + 2]!));
    }
    lines.push(pts);
  }
  let made = 0;
  geoMutate("Project", (sk) => {
    for (const pts of lines) if (addProjectedPolyline(sk, pts)) made++;
  });
  if (!made) toast("info", "That edge points straight at the sketch plane, so it projects to a point.");
}

/** Add a free point (for dimensions and constraints to refer to). */
export function addFreePoint(p: Vec2) {
  geoMutate("Add point", (sk) => void addPoint(sk, p));
}

let lastCorner = "2";

/** Fillet or chamfer the corner at a point where two lines meet. */
export async function cornerAt(id: Id, kind: "fillet" | "chamfer", at?: [number, number]) {
  const o = openSketch();
  if (!o) return;
  const chamfer = kind === "chamfer";
  const text = await promptDialog({
    at,
    title: chamfer ? "Chamfer corner" : "Fillet corner",
    label: chamfer ? "Distance from the corner" : "Radius",
    message: "A number or a formula using parameters.",
    initial: lastCorner,
    unit: useApp.getState().doc.units,
    validate: (t) => checkValue("radius", t),
  });
  if (text === null) return;
  const r = documentEvaluator(useApp.getState().doc).eval(text, "length");
  if (!r.ok) return;
  // Try it on a copy first, so a corner that can't take it leaves no empty step in the history.
  const trial = structuredClone(o.sk);
  bakeSolution(trial, o.sol);
  const why = filletCorner(trial, id, r.value, text, chamfer);
  if (why) {
    toast("info", why);
    return;
  }
  lastCorner = text;
  geoMutate(chamfer ? "Chamfer" : "Fillet", (sk) => void filletCorner(sk, id, r.value, text, chamfer));
}

/** Run a copy-style edit on a trial copy first, so one that can't be done leaves no empty step in the history. */
function copyEdit(label: string, edit: (sk: Draft<SketchFeature>) => string | undefined): boolean {
  const o = openSketch();
  if (!o) return false;
  const trial = structuredClone(o.sk);
  bakeSolution(trial, o.sol);
  const why = edit(trial as Draft<SketchFeature>);
  if (why) {
    toast("info", why);
    return false;
  }
  geoMutate(label, (sk) => void edit(sk));
  return true;
}

const unitMm = () => LENGTH_TO_MM[useApp.getState().doc.units];

/** Mirror the selected geometry across the X axis, the Y axis, or the selected line (the last one picked). */
export function mirrorSelection(across: "x" | "y" | "line") {
  const sel = sketchSelection();
  const o = openSketch();
  if (!o) return;
  let line = across === "x" ? "xaxis" : "yaxis";
  if (across === "line") {
    const lines = sel.filter((id) => geomById(o.sk, id)?.type === "line" || id === "xaxis" || id === "yaxis");
    if (lines.length < 2 && !(lines.length === 1 && sel.length > 1)) {
      toast("info", "Select the geometry to mirror, then the line to mirror across (pick the line last).");
      return;
    }
    line = lines[lines.length - 1]!;
  }
  copyEdit("Mirror", (sk) => mirrorGeometry(sk, sel, line));
}

/** Offset the selected lines, arcs and circles; asks how far (negative goes the other way). */
export async function offsetSelection() {
  const v = await promptDialog({
    title: "Offset",
    label: "Distance",
    message: "Positive grows a closed shape outward, negative shrinks it inward.",
    initial: "2",
    unit: useApp.getState().doc.units,
    validate: (t) => {
      const r = documentEvaluator(useApp.getState().doc).eval(t, "length");
      return !r.ok ? r.error : r.value === 0 ? "The distance can't be zero" : null;
    },
  });
  if (v === null) return;
  const r = documentEvaluator(useApp.getState().doc).eval(v, "length");
  if (!r.ok) return;
  const sel = sketchSelection();
  copyEdit("Offset", (sk) => offsetGeometry(sk, sel, r.value));
}

/** Copies of the selection in a row (`axis`) or evenly round the sketch origin. Gap is in the document's units. */
export function patternSelection(kind: "row" | "column" | "circular", count: number, gap: number) {
  const sel = sketchSelection();
  copyEdit(kind === "circular" ? "Circular pattern" : "Linear pattern", (sk) =>
    kind === "circular" ? circularPattern(sk, sel, count) : linearPattern(sk, sel, count, kind === "row" ? gap * unitMm() : 0, kind === "column" ? gap * unitMm() : 0),
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

/* ───────── Move / scale / grid pattern / break (asks for numbers in the document's units) ───────── */

/** Ask for one or more comma-separated lengths or numbers; null when cancelled or invalid. */
async function askNumbers(title: string, label: string, initial: string, message: string, kinds: ("length" | "number")[]): Promise<number[] | null> {
  const ev = () => documentEvaluator(useApp.getState().doc);
  const parse = (t: string): number[] | string => {
    const parts = t.split(",").map((x) => x.trim());
    if (parts.length !== kinds.length) return `Give ${kinds.length} value${kinds.length > 1 ? "s" : ""}, separated by commas`;
    const out: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      const r = ev().eval(parts[i]!, kinds[i] === "length" ? "length" : "number");
      if (!r.ok) return r.error;
      out.push(r.value);
    }
    return out;
  };
  const v = await promptDialog({ title, label, message, initial, validate: (t) => (typeof parse(t) === "string" ? (parse(t) as string) : null) });
  if (v === null) return null;
  const r = parse(v);
  return typeof r === "string" ? null : r;
}

/** Move the selected geometry, or add a moved copy. Distances are in mm after evaluation. */
/** Pull the selected points; lines and curves attached to them stretch along. */
export async function stretchSelection() {
  const o = openSketch();
  const pts = sketchSelection().filter((id) => o?.sk.geometry?.find((g) => g.id === id)?.type === "point");
  if (!pts.length) return void toast("info", "Select the points you want to pull (click them, Shift+click for more), then Stretch. Lines attached to those points stretch with them.");
  const u = useApp.getState().doc.units;
  const r = await askNumbers("Stretch", `X, Y distance (${u})`, "5, 0", "How far to pull the selected points along the sketch's X and Y.", ["length", "length"]);
  if (r) copyEdit("Stretch", (sk) => moveGeometry(sk, pts, r[0]!, r[1]!, false));
}

export async function moveSelection(copy: boolean) {
  const sel = sketchSelection();
  const u = useApp.getState().doc.units;
  const r = await askNumbers(copy ? "Copy" : "Move", `X, Y distance (${u})`, "10, 0", "How far along the sketch's X and Y. Negative goes the other way.", ["length", "length"]);
  if (r) copyEdit(copy ? "Copy" : "Move", (sk) => moveGeometry(sk, sel, r[0]!, r[1]!, copy));
}

/** Scale the selected geometry about the sketch origin. */
export async function scaleSelection() {
  const sel = sketchSelection();
  const r = await askNumbers("Scale", "Scale factor", "2", "1 keeps the size; 2 doubles it; 0.5 halves it. Scales about the sketch origin.", ["number"]);
  if (r) copyEdit("Scale", (sk) => scaleGeometry(sk, sel, r[0]!, [0, 0]));
}

/** Copies in a grid: columns, rows, and the gap between them. */
export async function gridPatternSelection() {
  const sel = sketchSelection();
  const u = useApp.getState().doc.units;
  const r = await askNumbers("Rectangular pattern", `Columns, rows, X gap, Y gap (gaps in ${u})`, "3, 2, 20, 20", "The original is the first cell. Gaps are measured between copies.", ["number", "number", "length", "length"]);
  if (r) copyEdit("Rectangular pattern", (sk) => rectPattern(sk, sel, Math.round(r[0]!), Math.round(r[1]!), r[2]!, r[3]!));
}

/** Split the first selected line where the second selected line crosses it. */
export function breakSelection() {
  const sel = sketchSelection();
  if (sel.length !== 2) return void toast("info", "Select the line to split, then the line that crosses it.");
  copyEdit("Break", (sk) => breakLine(sk, sel[0]!, sel[1]!));
}
