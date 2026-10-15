/**
 * Constraint-driven sketch geometry (points, lines, arcs, circles plus
 * constraints), shared by the solver in the kernel worker, the sketcher UI and
 * the design API. Solving happens in packages/kernel/src/solver.ts; this file
 * reads its results, turns solved geometry into profiles, and edits geometry.
 */
import type { ConstraintType, GeomType, Id, PolyPoint, SketchConstraint, SketchEntity, SketchFeature, SketchGeom, Vec2 } from "./model";
import { uid } from "./factory";
import { smoothClosed, smoothOpen } from "./sketch";

/** Fixed references every sketch has: the origin point and the two axes. */
export const SKETCH_REFS: Record<string, GeomType> = { origin: "point", xaxis: "line", yaxis: "line" };

export interface SketchSolution {
  /** Solved point positions and circle radii (mm). */
  points: Record<Id, Vec2>;
  radii: Record<Id, number>;
  /** Remaining degrees of freedom (0 = fully defined). */
  dof: number;
  /** "over": conflicting or redundant constraints; "error": the solver found no solution. */
  state: "under" | "full" | "over" | "error";
  /** Geometry that can't move any more (drawn as fully defined). */
  defined: Id[];
  /** Constraints at fault when over-constrained (drawn red). */
  bad: Id[];
  message?: string;
}

export type GeomResolved =
  | { id: Id; type: "point"; p: Vec2; construction: boolean }
  | { id: Id; type: "line"; a: Vec2; b: Vec2; construction: boolean }
  /** Counter-clockwise from angle a0 by `sweep` (radians). */
  | { id: Id; type: "arc"; c: Vec2; r: number; a0: number; sweep: number; a: Vec2; b: Vec2; construction: boolean }
  | { id: Id; type: "circle"; c: Vec2; r: number; construction: boolean }
  /** Through the fit points; `closed` joins the last back to the first. */
  | { id: Id; type: "spline"; pts: Vec2[]; closed: boolean; construction: boolean };

const TAU = Math.PI * 2;
const ccw = (x: number) => ((x % TAU) + TAU) % TAU;
const dist = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const polar = (c: Vec2, r: number, t: number): Vec2 => [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)];

export function geomById(sk: Pick<SketchFeature, "geometry">, id: Id): SketchGeom | undefined {
  return sk.geometry?.find((g) => g.id === id);
}

/** Type of a geometry id, including the fixed references. */
export function geomType(sk: Pick<SketchFeature, "geometry">, id: Id): GeomType | undefined {
  return SKETCH_REFS[id] ?? geomById(sk, id)?.type;
}

/** Position of a point (solved when a solution is given). */
export function pointAt(sk: Pick<SketchFeature, "geometry">, id: Id, sol?: SketchSolution): Vec2 {
  if (id === "origin") return [0, 0];
  const s = sol?.points[id];
  if (s) return s;
  const g = geomById(sk, id);
  return g?.type === "point" ? [g.x, g.y] : [0, 0];
}

/** Numeric geometry with solved positions where available. */
export function resolveGeometry(sk: Pick<SketchFeature, "geometry">, sol?: SketchSolution): GeomResolved[] {
  const P = (id: Id) => pointAt(sk, id, sol);
  return (sk.geometry ?? []).map((g): GeomResolved => {
    const construction = !!g.construction;
    switch (g.type) {
      case "point":
        return { id: g.id, type: "point", p: P(g.id), construction };
      case "line":
        return { id: g.id, type: "line", a: P(g.a), b: P(g.b), construction };
      case "circle":
        return { id: g.id, type: "circle", c: P(g.c), r: sol?.radii[g.id] ?? g.r, construction };
      case "spline":
        return { id: g.id, type: "spline", pts: g.pts.map(P), closed: !!g.closed && g.pts.length >= 3, construction };
      case "arc": {
        const c = P(g.c);
        const a = P(g.a);
        const b = P(g.b);
        const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
        const sweep = ccw(Math.atan2(b[1] - c[1], b[0] - c[0]) - a0) || TAU;
        return { id: g.id, type: "arc", c, r: dist(c, a), a0, sweep, a, b, construction };
      }
    }
  });
}

/** Points along a curve, for drawing and hit testing. */
export function geomOutline(g: GeomResolved, segments = 64): Vec2[] {
  switch (g.type) {
    case "point":
      return [g.p];
    case "line":
      return [g.a, g.b];
    case "circle": {
      const out: Vec2[] = [];
      for (let i = 0; i <= segments; i++) out.push(polar(g.c, g.r, (i / segments) * TAU));
      return out;
    }
    case "spline": {
      if (g.pts.length < 3) return g.pts;
      const per = Math.max(4, Math.round(segments / 6));
      return g.closed ? [...smoothClosed(g.pts, per), g.pts[0]!] : smoothOpen(g.pts, per);
    }
    case "arc": {
      const n = Math.max(4, Math.ceil((segments * g.sweep) / TAU));
      const out: Vec2[] = [];
      for (let i = 0; i <= n; i++) out.push(polar(g.c, g.r, g.a0 + (g.sweep * i) / n));
      return out;
    }
  }
}

/* ───────────────────────── Profiles ───────────────────────── */

// Derived entities hold numbers (millimetres) where expressions normally go; the
// evaluator takes numbers as already-resolved values.
const n = (v: number) => v as unknown as string;

/**
 * The sketch with its solved geometry turned into ordinary entities: every
 * closed loop of lines and arcs becomes an outline, other chains become open
 * paths, circles become circles and construction lines become construction
 * paths (revolve axes). Everything downstream (holes, thin walls, sweeps)
 * then works unchanged.
 */
export function expandSketch(sk: SketchFeature, sol?: SketchSolution): SketchFeature {
  if (!sk.geometry?.length) return sk;
  const geo = resolveGeometry(sk, sol);
  const byId = new Map((sk.geometry ?? []).map((g) => [g.id, g]));
  const out: SketchEntity[] = [];

  // Points joined by coincident constraints are the same node.
  const parent = new Map<Id, Id>();
  const root = (id: Id): Id => {
    const p = parent.get(id);
    if (!p || p === id) return id;
    const r = root(p);
    parent.set(id, r);
    return r;
  };
  for (const c of sk.constraints ?? []) {
    if (c.type !== "coincident" || c.refs.length !== 2) continue;
    if (c.refs.every((r) => byId.get(r)?.type === "point")) parent.set(root(c.refs[0]!), root(c.refs[1]!));
  }

  const pt = (p: Vec2): PolyPoint => [n(p[0]), n(p[1])];
  interface Seg {
    id: Id;
    ends: [Id, Id];
    at: [Vec2, Vec2];
    mid?: Vec2;
    /** A spline's fit points between its ends, in order from the first end. */
    through?: Vec2[];
  }
  const segs: Seg[] = [];
  for (const g of geo) {
    const src = byId.get(g.id)!;
    if (g.type === "circle") {
      out.push({ id: g.id, type: "circle", cx: n(g.c[0]), cy: n(g.c[1]), r: n(g.r), construction: g.construction || undefined });
    } else if (g.type === "line" && src.type === "line") {
      if (g.construction) out.push({ id: g.id, type: "polyline", points: [[n(g.a[0]), n(g.a[1])], [n(g.b[0]), n(g.b[1])]], open: true, construction: true });
      else segs.push({ id: g.id, ends: [root(src.a), root(src.b)], at: [g.a, g.b] });
    } else if (g.type === "spline" && src.type === "spline") {
      if (g.closed || g.construction) {
        // A closed spline is a whole outline by itself; a construction one is a guide.
        const pts = g.pts.map((p) => pt(p));
        out.push({ id: g.id, type: "polyline", points: pts, ...(g.closed ? {} : { open: true }), ...(pts.length >= 3 ? { smooth: true } : {}), ...(g.construction ? { construction: true, open: true } : {}) });
      } else if (g.pts.length >= 2) {
        // An open spline joins lines and arcs into one outline or path.
        const last = g.pts.length - 1;
        segs.push({ id: g.id, ends: [root(src.pts[0]!), root(src.pts[last]!)], at: [g.pts[0]!, g.pts[last]!], ...(last >= 2 ? { through: g.pts.slice(1, last) } : {}) });
      }
    } else if (g.type === "arc" && src.type === "arc" && !g.construction) {
      segs.push({ id: g.id, ends: [root(src.a), root(src.b)], at: [g.a, g.b], mid: polar(g.c, g.r, g.a0 + g.sweep / 2) });
    }
  }

  const at = new Map<Id, Seg[]>();
  for (const s of segs) for (const e of s.ends) at.set(e, [...(at.get(e) ?? []), s]);
  const used = new Set<Seg>();
  // Follow segments from `node` until a node that isn't a plain joint, or back to the start.
  const walk = (node: Id, first: Seg): { pts: PolyPoint[]; closed: boolean } => {
    const pts: PolyPoint[] = [];
    let s = first;
    let cur = node;
    for (;;) {
      used.add(s);
      const fwd = s.ends[0] === cur;
      pts.push(pt(fwd ? s.at[0] : s.at[1]));
      if (s.mid) pts.push([n(s.mid[0]), n(s.mid[1]), "arc"]);
      if (s.through) for (const p of fwd ? s.through : [...s.through].reverse()) pts.push([n(p[0]), n(p[1]), "spline"]);
      cur = fwd ? s.ends[1] : s.ends[0];
      if (cur === node) return { pts, closed: true };
      const next = at.get(cur) ?? [];
      const s2 = next.length === 2 ? next.find((x) => x !== s) : undefined;
      if (!s2 || used.has(s2)) {
        pts.push(pt(fwd ? s.at[1] : s.at[0]));
        return { pts, closed: false };
      }
      s = s2;
    }
  };
  // Open chains start at free ends and junctions; what's left are closed loops.
  for (const [node, list] of at) {
    if (list.length === 2) continue;
    for (const s of list) if (!used.has(s)) out.push({ id: s.id, type: "polyline", points: walk(node, s).pts, open: true });
  }
  for (const s of segs) {
    if (used.has(s)) continue;
    const w = walk(s.ends[0], s);
    out.push({ id: s.id, type: "polyline", points: w.pts, ...(w.closed ? {} : { open: true }) });
  }
  return { ...sk, entities: [...sk.entities, ...out] };
}

/* ───────────────────────── Constraints ───────────────────────── */

export const CONSTRAINT_LABELS: Record<ConstraintType, string> = {
  coincident: "Coincident",
  horizontal: "Horizontal",
  vertical: "Vertical",
  parallel: "Parallel",
  perpendicular: "Perpendicular",
  tangent: "Tangent",
  equal: "Equal",
  fixed: "Fixed",
  symmetric: "Symmetric",
  midpoint: "Midpoint",
  collinear: "Collinear",
  distance: "Distance",
  radius: "Radius",
  angle: "Angle",
};

/** Dimensions carry a value; the rest are relations. */
export const DIMENSIONS: ConstraintType[] = ["distance", "radius", "angle"];

const round = (k: GeomType) => k === "arc" || k === "circle";

/**
 * The fit point next to the end where a spline meets another curve, and that end
 * point: a spline leaves its end heading for its next fit point, so "tangent" there
 * is "the next fit point lies on the other curve's tangent line".
 */
export function splineJoin(sk: Pick<SketchFeature, "geometry" | "constraints">, spline: Id, other: Id): { end: Id; next: Id } | null {
  const s = geomById(sk, spline);
  const o = geomById(sk, other);
  if (s?.type !== "spline" || s.pts.length < 3 || (o?.type !== "line" && o?.type !== "arc")) return null;
  const joined = (p: Id, q: Id) => p === q || !!sk.constraints?.some((c) => c.type === "coincident" && c.refs.includes(p) && c.refs.includes(q));
  const last = s.pts.length - 1;
  for (const [end, next] of [[s.pts[0]!, s.pts[1]!], [s.pts[last]!, s.pts[last - 1]!]] as [Id, Id][]) {
    if (joined(end, o.a) || joined(end, o.b)) return { end, next };
  }
  return null;
}

/** True when a constraint type applies to geometry of these kinds (in any order). */
export function constraintFits(type: ConstraintType, kinds: GeomType[]): boolean {
  const [a, b] = kinds;
  const two = kinds.length === 2;
  const pair = (x: (k: GeomType) => boolean, y: (k: GeomType) => boolean) => two && ((x(a!) && y(b!)) || (y(a!) && x(b!)));
  const is = (t: GeomType) => (k: GeomType) => k === t;
  switch (type) {
    case "coincident":
      return pair(is("point"), () => true);
    case "horizontal":
    case "vertical":
      return (kinds.length === 1 && a === "line") || pair(is("point"), is("point"));
    case "parallel":
    case "perpendicular":
      return pair(is("line"), is("line"));
    case "tangent":
      return pair(is("line"), round) || pair(round, round) || pair(is("spline"), is("line")) || pair(is("spline"), is("arc"));
    case "equal":
      return pair(is("line"), is("line")) || pair(round, round);
    case "fixed":
      return kinds.length === 1;
    case "symmetric": {
      // Two points mirrored about a line, or about a centre point (the last one picked).
      const pts = kinds.filter(is("point")).length;
      return kinds.length === 3 && (pts === 3 || (pts === 2 && kinds.includes("line")));
    }
    case "midpoint":
      return pair(is("point"), is("line"));
    case "collinear":
      return pair(is("line"), is("line"));
    case "distance":
      return (kinds.length === 1 && a === "line") || pair(is("point"), is("point")) || pair(is("point"), is("line")) || pair(is("line"), is("line"));
    case "radius":
      return kinds.length === 1 && round(a!);
    case "angle":
      return (kinds.length === 1 && a === "line") || pair(is("line"), is("line"));
  }
}

/** Constraint types that apply to a selection, relations first. */
export function constraintsFor(sk: Pick<SketchFeature, "geometry">, refs: Id[]): ConstraintType[] {
  const kinds = refs.map((r) => geomType(sk, r));
  if (!kinds.length || kinds.some((k) => !k)) return [];
  return (Object.keys(CONSTRAINT_LABELS) as ConstraintType[]).filter((t) => constraintFits(t, kinds as GeomType[]));
}

/** Current value of a dimension: mm for distance and radius, radians for angles. */
export function measureDimension(sk: Pick<SketchFeature, "geometry">, type: ConstraintType, refs: Id[], sol?: SketchSolution): number {
  const geo = new Map(resolveGeometry(sk, sol).map((g) => [g.id, g]));
  const line = (id: Id): [Vec2, Vec2] => {
    if (id === "xaxis") return [[0, 0], [1, 0]];
    if (id === "yaxis") return [[0, 0], [0, 1]];
    const g = geo.get(id);
    return g?.type === "line" ? [g.a, g.b] : [[0, 0], [0, 0]];
  };
  const point = (id: Id) => pointAt(sk, id, sol);
  const kind = (id: Id) => SKETCH_REFS[id] ?? geo.get(id)?.type;
  const dir = ([a, b]: [Vec2, Vec2]) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  if (type === "radius") {
    const g = geo.get(refs[0]!);
    return g && (g.type === "circle" || g.type === "arc") ? g.r : 0;
  }
  if (type === "angle") {
    if (refs.length === 1) return dir(line(refs[0]!));
    let d = dir(line(refs[1]!)) - dir(line(refs[0]!));
    while (d > Math.PI) d -= TAU;
    while (d <= -Math.PI) d += TAU;
    return d;
  }
  if (refs.length === 1) {
    const [a, b] = line(refs[0]!);
    return dist(a, b);
  }
  const [r0, r1] = refs as [Id, Id];
  if (kind(r0) === "point" && kind(r1) === "point") return dist(point(r0), point(r1));
  const [p, l] = kind(r0) === "point" ? [point(r0), line(r1)] : kind(r1) === "point" ? [point(r1), line(r0)] : [line(r0)[0], line(r1)];
  return pointLineDistance(p, l[0], l[1]);
}

function pointLineDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const l = dist(a, b) || 1;
  return Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / l;
}

/** A short readable name for a constraint, e.g. "Horizontal" or "Distance 25". */
export function describeConstraint(c: SketchConstraint): string {
  return CONSTRAINT_LABELS[c.type] + (c.value !== undefined ? ` ${c.value}` : "");
}

/* ───────────────────────── Editing ───────────────────────── */

type Geo = Pick<SketchFeature, "geometry" | "constraints">;

/** Copy solved positions into the geometry, so the next edit starts from what the user sees. */
export function bakeSolution(sk: Geo, sol: SketchSolution | undefined) {
  if (!sol || sol.state === "error") return;
  for (const g of sk.geometry ?? []) {
    const p = sol.points[g.id];
    if (g.type === "point" && p) {
      g.x = p[0];
      g.y = p[1];
    }
    if (g.type === "circle" && sol.radii[g.id] !== undefined) g.r = sol.radii[g.id]!;
  }
}

export function addPoint(sk: Geo, p: Vec2, construction = false): Id {
  const id = uid("p");
  (sk.geometry ??= []).push({ id, type: "point", x: p[0], y: p[1], ...(construction ? { construction } : {}) });
  return id;
}

const pointId = (sk: Geo, p: Vec2 | Id) => (typeof p === "string" ? p : addPoint(sk, p));

export function addLine(sk: Geo, a: Vec2 | Id, b: Vec2 | Id, construction = false): Id {
  const id = uid("l");
  const pa = pointId(sk, a);
  const pb = pointId(sk, b);
  sk.geometry!.push({ id, type: "line", a: pa, b: pb, ...(construction ? { construction } : {}) });
  return id;
}

export function addCircle(sk: Geo, c: Vec2 | Id, r: number, construction = false): Id {
  const id = uid("c");
  const pc = pointId(sk, c);
  sk.geometry!.push({ id, type: "circle", c: pc, r, ...(construction ? { construction } : {}) });
  return id;
}

/** A smooth spline through the points (new points are made for positions; ids are reused). Needs two or more; closing needs three. */
export function addSpline(sk: Geo, pts: (Vec2 | Id)[], closed = false, construction = false): Id | null {
  if (pts.length < 2 || (closed && pts.length < 3)) return null;
  const id = uid("s");
  const ids = pts.map((p) => pointId(sk, p));
  sk.geometry!.push({ id, type: "spline", pts: ids, ...(closed ? { closed: true } : {}), ...(construction ? { construction } : {}) });
  return id;
}

/** An arc from `a` to `b` bulging through `through`. Returns null when the three points are in a line. */
export function addArc(sk: Geo, a: Vec2 | Id, b: Vec2 | Id, through: Vec2, construction = false): Id | null {
  const pa = typeof a === "string" ? pointAt(sk, a) : a;
  const pb = typeof b === "string" ? pointAt(sk, b) : b;
  const c = circleCenter(pa, through, pb);
  if (!c) return null;
  const ang = (p: Vec2) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  // Arcs run counter-clockwise: swap the ends when the bulge is on the other side.
  const forward = ccw(ang(through) - ang(pa)) < ccw(ang(pb) - ang(pa));
  const id = uid("a");
  const ia = pointId(sk, a);
  const ib = pointId(sk, b);
  const ic = addPoint(sk, c, true);
  sk.geometry!.push({ id, type: "arc", c: ic, a: forward ? ia : ib, b: forward ? ib : ia, ...(construction ? { construction } : {}) });
  return id;
}

function circleCenter(a: Vec2, m: Vec2, b: Vec2): Vec2 | null {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-9 * Math.max(1, dist(a, b) ** 2)) return null;
  const sa = a[0] ** 2 + a[1] ** 2;
  const sm = m[0] ** 2 + m[1] ** 2;
  const sb = b[0] ** 2 + b[1] ** 2;
  return [(sa * (m[1] - b[1]) + sm * (b[1] - a[1]) + sb * (a[1] - m[1])) / d, (sa * (b[0] - m[0]) + sm * (a[0] - b[0]) + sb * (m[0] - a[0])) / d];
}

/** Add a constraint. Returns its id, or a message saying why it doesn't apply. */
export function addConstraint(sk: Geo, type: ConstraintType, refs: Id[], value?: string): { id: Id } | { error: string } {
  const kinds = refs.map((r) => geomType(sk, r));
  if (kinds.some((k) => !k)) return { error: "Some of that geometry no longer exists." };
  if (new Set(refs).size !== refs.length) return { error: "Pick different items." };
  if (!constraintFits(type, kinds as GeomType[])) return { error: `${CONSTRAINT_LABELS[type]} doesn't apply to ${describeKinds(kinds as GeomType[])}.` };
  if (DIMENSIONS.includes(type) && !value?.trim()) return { error: "A dimension needs a value." };
  if (type === "tangent" && kinds.includes("spline")) {
    const [s, o] = kinds[0] === "spline" ? [refs[0]!, refs[1]!] : [refs[1]!, refs[0]!];
    if (!splineJoin(sk, s, o)) return { error: "A spline needs at least three points and must end where the line or arc ends. Make that end coincident first, then add Tangent." };
  }
  const id = uid("k");
  (sk.constraints ??= []).push({ id, type, refs, ...(DIMENSIONS.includes(type) ? { value } : {}) });
  return { id };
}

function describeKinds(kinds: GeomType[]): string {
  if (!kinds.length) return "nothing";
  return kinds.map((k) => `a ${k}`).join(" and ");
}

/** Delete geometry, with the constraints on it and the points only it used. */
export function deleteGeometry(sk: Geo, ids: Id[]) {
  const gone = new Set(ids);
  // Deleting a point takes the curves that need it.
  for (const g of sk.geometry ?? []) {
    if ((g.type === "line" || g.type === "arc") && (gone.has(g.a) || gone.has(g.b))) gone.add(g.id);
    if ((g.type === "arc" || g.type === "circle") && gone.has(g.c)) gone.add(g.id);
    // A spline just loses a deleted fit point; it goes when fewer than two are left.
    if (g.type === "spline" && g.pts.some((p) => gone.has(p))) {
      g.pts = g.pts.filter((p) => !gone.has(p));
      if (g.pts.length < 2) gone.add(g.id);
    }
  }
  const before = usedPoints(sk);
  sk.geometry = (sk.geometry ?? []).filter((g) => !gone.has(g.id));
  dropUnused(sk, before);
}

/** Remove points that curves used before an edit but no longer do, and constraints on removed geometry. */
export function dropUnused(sk: Geo, before: Set<Id>) {
  const after = usedPoints(sk);
  sk.geometry = (sk.geometry ?? []).filter((g) => g.type !== "point" || !before.has(g.id) || after.has(g.id));
  pruneConstraints(sk);
}

export function usedPoints(sk: Geo): Set<Id> {
  const used = new Set<Id>();
  for (const g of sk.geometry ?? []) {
    if (g.type === "line") used.add(g.a).add(g.b);
    if (g.type === "arc") used.add(g.a).add(g.b).add(g.c);
    if (g.type === "spline") g.pts.forEach((p) => used.add(p));
    if (g.type === "circle") used.add(g.c);
  }
  return used;
}

/** Drop constraints that refer to geometry that's gone. */
function pruneConstraints(sk: Geo) {
  const alive = new Set([...(sk.geometry ?? []).map((g) => g.id), ...Object.keys(SKETCH_REFS)]);
  sk.constraints = (sk.constraints ?? []).filter((c) => c.refs.every((r) => alive.has(r)));
}

/* ───────────────────────── Trim and extend ───────────────────────── */

type Curve = Exclude<GeomResolved, { type: "point" | "spline" }>;
const EPS = 1e-7;

export function lineLine(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2[] {
  const r: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const s: Vec2 = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return [];
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  return [[a[0] + r[0] * t, a[1] + r[1] * t]];
}

export function lineCircle(a: Vec2, b: Vec2, c: Vec2, r: number): Vec2[] {
  const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const f: Vec2 = [a[0] - c[0], a[1] - c[1]];
  const A = d[0] ** 2 + d[1] ** 2;
  const B = 2 * (f[0] * d[0] + f[1] * d[1]);
  const C = f[0] ** 2 + f[1] ** 2 - r * r;
  const disc = B * B - 4 * A * C;
  if (A < 1e-18 || disc < -1e-9 * A * r * r) return [];
  const q = Math.sqrt(Math.max(0, disc));
  const ts = q < 1e-12 ? [-B / (2 * A)] : [(-B - q) / (2 * A), (-B + q) / (2 * A)];
  return ts.map((t): Vec2 => [a[0] + d[0] * t, a[1] + d[1] * t]);
}

export function circleCircle(c1: Vec2, r1: number, c2: Vec2, r2: number): Vec2[] {
  const d = dist(c1, c2);
  if (d < 1e-12 || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const x = (d * d + r1 * r1 - r2 * r2) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - x * x));
  const u: Vec2 = [(c2[0] - c1[0]) / d, (c2[1] - c1[1]) / d];
  const m: Vec2 = [c1[0] + u[0] * x, c1[1] + u[1] * x];
  return h < 1e-12 ? [m] : [[m[0] - u[1] * h, m[1] + u[0] * h], [m[0] + u[1] * h, m[1] - u[0] * h]];
}

function lineParam(l: { a: Vec2; b: Vec2 }, p: Vec2): number {
  const d: Vec2 = [l.b[0] - l.a[0], l.b[1] - l.a[1]];
  return ((p[0] - l.a[0]) * d[0] + (p[1] - l.a[1]) * d[1]) / (d[0] ** 2 + d[1] ** 2 || 1);
}

/** Where `g` (taken as an infinite line or a full circle) meets curve `o` (within o's extent). */
function meet(g: Curve, o: Curve): Vec2[] {
  const pts =
    g.type === "line"
      ? o.type === "line"
        ? lineLine(g.a, g.b, o.a, o.b)
        : lineCircle(g.a, g.b, o.c, o.r)
      : o.type === "line"
        ? lineCircle(o.a, o.b, g.c, g.r)
        : circleCircle(g.c, g.r, o.c, o.r);
  return pts.filter((p) => {
    if (o.type === "line") {
      const t = lineParam(o, p);
      return t > -EPS && t < 1 + EPS;
    }
    if (o.type === "arc") {
      const t = ccw(Math.atan2(p[1] - o.c[1], p[0] - o.c[0]) - o.a0);
      return t < o.sweep + EPS || t > TAU - EPS;
    }
    return true;
  });
}

/** Position along a curve: 0..1 on lines, radians counter-clockwise from the start on arcs and circles. */
function param(g: Curve, p: Vec2): number {
  if (g.type === "line") return lineParam(g, p);
  const t = ccw(Math.atan2(p[1] - g.c[1], p[0] - g.c[0]) - (g.type === "arc" ? g.a0 : 0));
  return g.type === "arc" && t > TAU - 1e-6 ? 0 : t;
}

/** Every place other curves cross `g` (as an infinite line / full circle), and which curve crosses there. */
function crossings(g: Curve, geo: GeomResolved[]): { t: number; p: Vec2; by: Id }[] {
  const out: { t: number; p: Vec2; by: Id }[] = [];
  for (const o of geo) {
    if (o.type === "point" || o.type === "spline" || o.id === g.id) continue;
    for (const p of meet(g, o)) out.push({ t: param(g, p), p, by: o.id });
  }
  return out.sort((x, y) => x.t - y.t);
}

/** A new point at `p`, constrained onto curve `on`. */
function pointOn(sk: Geo, p: Vec2, on: Id): Id {
  const id = addPoint(sk, p);
  addConstraint(sk, "coincident", [id, on]);
  return id;
}

/** Lines whose length changes lose their length and equal-length constraints. */
export function dropLengths(sk: Geo, id: Id) {
  sk.constraints = (sk.constraints ?? []).filter((c) => !(c.refs.includes(id) && (c.type === "equal" || (c.type === "distance" && c.refs.length === 1))));
}

/**
 * Trim a line, arc or circle back to the nearest crossings on either side of
 * `click` (sketch mm), removing that piece. A curve nothing crosses is deleted.
 * Works on the stored positions: bake the solution first. Returns a message
 * when nothing could be trimmed.
 */
export function trimGeometry(sk: Geo, id: Id, click: Vec2): string | undefined {
  const geo = resolveGeometry(sk);
  const g = geo.find((x) => x.id === id);
  const src = geomById(sk, id);
  if (src?.type === "spline") return "Splines can't be trimmed. Delete the spline, or move its points.";
  if (!g || !src || g.type === "point" || g.type === "spline" || src.type === "point") return "Pick a line, arc or circle to trim.";
  const before = usedPoints(sk);
  const span = g.type === "line" ? 1 : g.type === "arc" ? g.sweep : TAU;
  const cuts = crossings(g, geo).filter((c) => g.type === "circle" || (c.t > EPS && c.t < span - EPS));
  const tc = param(g, click);

  if (src.type === "circle") {
    if (cuts.length < 2) {
      deleteGeometry(sk, [id]);
      return undefined;
    }
    // What's left runs from the crossing after the click round to the one before it.
    const hi = cuts.find((c) => c.t > tc) ?? cuts[0]!;
    const lo = [...cuts].reverse().find((c) => c.t < tc) ?? cuts[cuts.length - 1]!;
    const a = pointOn(sk, hi.p, hi.by);
    const b = pointOn(sk, lo.p, lo.by);
    const i = sk.geometry!.indexOf(src);
    sk.geometry![i] = { id, type: "arc", c: src.c, a, b, ...(src.construction ? { construction: true } : {}) };
    dropUnused(sk, before);
    return undefined;
  }
  const lo = [...cuts].reverse().find((c) => c.t < tc);
  const hi = cuts.find((c) => c.t > tc);
  if (!lo && !hi) {
    deleteGeometry(sk, [id]);
    return undefined;
  }
  if (src.type === "line") dropLengths(sk, id);
  if (!lo) src.a = pointOn(sk, hi!.p, hi!.by);
  else if (!hi) src.b = pointOn(sk, lo.p, lo.by);
  else {
    // Cut out the middle: this curve keeps the start, a new one takes the rest.
    const end = src.b;
    src.b = pointOn(sk, lo.p, lo.by);
    const start = pointOn(sk, hi.p, hi.by);
    const rest = uid(src.type === "line" ? "l" : "a");
    sk.geometry!.push({ ...src, id: rest, a: start, b: end });
    if (src.type === "line") {
      // Keep both pieces on one line.
      addConstraint(sk, "coincident", [start, id]);
      addConstraint(sk, "coincident", [end, id]);
    } else addConstraint(sk, "equal", [id, rest]);
  }
  dropUnused(sk, before);
  return undefined;
}

/**
 * Extend the end of a line or arc nearest `click` until it meets another curve.
 * Works on the stored positions. Returns a message when there's nothing to meet.
 */
export function extendGeometry(sk: Geo, id: Id, click: Vec2): string | undefined {
  const geo = resolveGeometry(sk);
  const g = geo.find((x) => x.id === id);
  const src = geomById(sk, id);
  if (!g || !src || (g.type !== "line" && g.type !== "arc") || (src.type !== "line" && src.type !== "arc")) return "Pick a line or arc to extend.";
  const atEnd = dist(click, g.b) < dist(click, g.a);
  const cuts = crossings(g, geo);
  let hit: { p: Vec2; by: Id } | undefined;
  if (g.type === "line") {
    hit = atEnd ? cuts.find((c) => c.t > 1 + EPS) : [...cuts].reverse().find((c) => c.t < -EPS);
  } else {
    // Arcs grow past their end (or back past their start), never round onto themselves.
    const gap = TAU - g.sweep;
    hit = cuts
      .map((c) => ({ ...c, u: atEnd ? c.t - g.sweep : ccw(-c.t) }))
      .filter((c) => c.u > EPS && c.u < gap - EPS)
      .sort((x, y) => x.u - y.u)[0];
  }
  if (!hit) return "There's nothing to extend to in that direction.";
  const key = atEnd ? "b" : "a";
  const old = src[key];
  const shared = (sk.geometry ?? []).some((x) => x !== src && (x.type === "line" || x.type === "arc") && (x.a === old || x.b === old));
  if (shared) src[key] = pointOn(sk, hit.p, hit.by);
  else {
    const p = geomById(sk, old);
    if (p?.type === "point") [p.x, p.y] = hit.p;
    addConstraint(sk, "coincident", [old, hit.by]);
  }
  if (src.type === "line") dropLengths(sk, id);
  return undefined;
}
