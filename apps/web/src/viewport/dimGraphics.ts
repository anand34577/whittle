/**
 * How a sketch dimension is drawn, the way drawings show it: a length gets extension lines and a
 * dimension line with an arrow at each end and its value in the middle; a radius or diameter a leader
 * with an arrow on the curve. Everything is in sketch millimetres. A dragged label keeps its place on
 * the constraint relative to what it measures, so it follows the geometry when that moves.
 */
import type { GeomResolved, Id, SketchConstraint, Vec2 } from "@whittle/core";

export interface DimGraphic {
  /** Where the value sits. */
  label: Vec2;
  lines: [Vec2, Vec2][];
  /** Arrowheads: the tip and the way it points. */
  arrows: { tip: Vec2; dir: Vec2 }[];
}

type Geo = ReadonlyMap<Id, GeomResolved>;
type Line = { a: Vec2; b: Vec2 };

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const mid = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

function pointOf(id: Id, geo: Geo): Vec2 | null {
  if (id === "origin") return [0, 0];
  const g = geo.get(id);
  return g?.type === "point" ? g.p : null;
}

function lineOf(id: Id, geo: Geo): Line | null {
  if (id === "xaxis") return { a: [0, 0], b: [1, 0] };
  if (id === "yaxis") return { a: [0, 0], b: [0, 1] };
  const g = geo.get(id);
  return g?.type === "line" ? { a: g.a, b: g.b } : null;
}

/** The foot of the perpendicular from `p` to the (endless) line. */
function foot(p: Vec2, l: Line): Vec2 {
  const d = sub(l.b, l.a);
  return add(l.a, mul(d, dot(sub(p, l.a), d) / (dot(d, d) || 1)));
}

/** The two points a length is measured between (on its first and second item), or null. */
export function lengthEnds(c: SketchConstraint, geo: Geo): [Vec2, Vec2] | null {
  const [p, q] = c.refs;
  if (!p) return null;
  if (!q) {
    const l = lineOf(p, geo);
    return l && p !== "xaxis" && p !== "yaxis" ? [l.a, l.b] : null;
  }
  const P = pointOf(p, geo);
  const Q = pointOf(q, geo);
  const LP = lineOf(p, geo);
  const LQ = lineOf(q, geo);
  if (P && Q) return [P, Q];
  if (P && LQ) return [P, foot(P, LQ)];
  if (LP && Q) return [foot(Q, LP), Q];
  if (LP && LQ) {
    // Between two parallel lines: across from the middle of a drawn one (an axis has no middle).
    if (p === "xaxis" || p === "yaxis") {
      const m = mid(LQ.a, LQ.b);
      return [foot(m, LP), m];
    }
    const m = mid(LP.a, LP.b);
    return [m, foot(m, LQ)];
  }
  return null;
}

/** A length's direction and the side normal its offset is measured along. */
function frame(a: Vec2, b: Vec2): { u: Vec2; n: Vec2; l: number } | null {
  const d = sub(b, a);
  const l = Math.hypot(d[0], d[1]);
  if (l < 1e-9) return null;
  const u = mul(d, 1 / l);
  return { u, n: [-u[1], u[0]], l };
}

/** Where two (endless) lines cross, or null when they are parallel. */
function cross(A: Line, B: Line): Vec2 | null {
  const d1 = sub(A.b, A.a);
  const d2 = sub(B.b, B.a);
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((B.a[0] - A.a[0]) * d2[1] - (B.a[1] - A.a[1]) * d2[0]) / den;
  return add(A.a, mul(d1, t));
}

/**
 * An angle's corner and the two rays it is measured between (counter-clockwise by `sweep`). A single
 * line's angle is from the horizontal through its start, as the solver measures it. The rays point
 * at the lines themselves where they can (turning both round keeps the same angle).
 */
function angleFrame(c: SketchConstraint, geo: Geo): { V: Vec2; u0: Vec2; u1: Vec2; sweep: number; lines: Line[] } | null {
  const L0 = c.refs[0] ? lineOf(c.refs[0], geo) : null;
  if (!L0) return null;
  const single = c.refs.length === 1;
  const L1 = single ? null : c.refs[1] ? lineOf(c.refs[1], geo) : null;
  if (!single && !L1) return null;
  const A: Line = single ? { a: L0.a, b: add(L0.a, [1, 0]) } : L0;
  const B: Line = single ? L0 : L1!;
  const f0 = frame(A.a, A.b);
  const f1 = frame(B.a, B.b);
  const V = single ? L0.a : cross(A, B);
  if (!f0 || !f1 || !V) return null;
  let sweep = Math.atan2(f1.u[1], f1.u[0]) - Math.atan2(f0.u[1], f0.u[0]);
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep <= -Math.PI) sweep += 2 * Math.PI;
  const toward = (l: Line, u: Vec2) => {
    const far = Math.hypot(...sub(l.a, V)) > Math.hypot(...sub(l.b, V)) ? l.a : l.b;
    return dot(sub(far, V), u) > 0 ? 1 : 0;
  };
  const lines = single ? [B] : [A, B];
  const score = (u0: Vec2, u1: Vec2) => (single ? 0 : toward(A, u0)) + toward(B, u1);
  const flip = score(mul(f0.u, -1), mul(f1.u, -1)) > score(f0.u, f1.u);
  return { V, u0: flip ? mul(f0.u, -1) : f0.u, u1: flip ? mul(f1.u, -1) : f1.u, sweep, lines };
}

/**
 * The drawing for a dimension, or null when it isn't drawn this way (angles, ellipses).
 * `px` is a screen pixel in mm (sizes the gaps and the default offset); `centre` is the middle of
 * the sketch, which an unplaced length stands away from.
 */
export function dimGraphic(c: SketchConstraint, geo: Geo, px: number, centre: Vec2): DimGraphic | null {
  const gap = 4 * px;
  const over = 6 * px;
  const away = 28 * px;
  if (c.type === "distance") {
    const ends = lengthEnds(c, geo);
    const f = ends && frame(ends[0], ends[1]);
    if (!ends || !f) return null;
    const [a, b] = ends;
    const { u, n, l } = f;
    const m = mid(a, b);
    const off = c.label?.[0] ?? (dot(sub(centre, m), n) > 0 ? -away : away);
    const along = c.label?.[1] ?? 0;
    const s = Math.sign(off) || 1;
    const A = add(a, mul(n, off));
    const B = add(b, mul(n, off));
    const label = add(add(m, mul(n, off)), mul(u, along));
    const lines: [Vec2, Vec2][] = [];
    if (Math.abs(off) > gap) lines.push([add(a, mul(n, s * gap)), add(A, mul(n, s * over))], [add(b, mul(n, s * gap)), add(B, mul(n, s * over))]);
    // A value moved past either end takes the dimension line out to it.
    const t = dot(sub(label, a), u);
    lines.push([add(A, mul(u, Math.min(0, t))), add(A, mul(u, Math.max(l, t)))]);
    return { label, lines, arrows: [{ tip: A, dir: mul(u, -1) }, { tip: B, dir: u }] };
  }
  if (c.type === "radius" || c.type === "diameter") {
    const g = c.refs[0] ? geo.get(c.refs[0]) : undefined;
    if (!g || (g.type !== "circle" && g.type !== "arc")) return null;
    const ang = c.label?.[0] ?? (g.type === "arc" ? g.a0 + g.sweep / 2 : Math.PI / 4);
    const beyond = c.label?.[1] ?? away;
    const d: Vec2 = [Math.cos(ang), Math.sin(ang)];
    const p = add(g.c, mul(d, g.r));
    const label = add(g.c, mul(d, g.r + beyond));
    if (c.type === "diameter") {
      const q = sub(g.c, mul(d, g.r));
      const lines: [Vec2, Vec2][] = [[q, p]];
      if (beyond > 0) lines.push([p, label]);
      return { label, lines, arrows: [{ tip: p, dir: d }, { tip: q, dir: mul(d, -1) }] };
    }
    // Outside: a leader from the value to the curve. Inside: along the radius from the center.
    return beyond >= 0 ? { label, lines: [[p, label]], arrows: [{ tip: p, dir: mul(d, -1) }] } : { label, lines: [[g.c, p]], arrows: [{ tip: p, dir: d }] };
  }
  if (c.type === "angle") {
    const f = angleFrame(c, geo);
    if (!f) return null;
    const { V, u0, u1, sweep } = f;
    const r = Math.max(c.label?.[0] ?? away * 1.6, 2 * gap);
    const t0 = Math.atan2(u0[1], u0[0]);
    const at = (t: number, rad = r): Vec2 => [V[0] + rad * Math.cos(t), V[1] + rad * Math.sin(t)];
    const lines: [Vec2, Vec2][] = [];
    const n = 32;
    for (let i = 0; i < n; i++) lines.push([at(t0 + (sweep * i) / n), at(t0 + (sweep * (i + 1)) / n)]);
    // Extension lines where the arc reaches past a line (and the horizontal a single line is measured from).
    const rays: [Vec2, Line | null][] = c.refs.length === 1 ? [[u0, null], [u1, f.lines[0]!]] : [[u0, f.lines[0]!], [u1, f.lines[1]!]];
    for (const [u, l] of rays) {
      const reach = l ? Math.max(dot(sub(l.a, V), u), dot(sub(l.b, V), u), 0) : 0;
      if (reach < r) lines.push([add(V, mul(u, reach + (l ? gap : 0))), add(V, mul(u, r + over))]);
    }
    const tan = (t: number): Vec2 => [-Math.sin(t), Math.cos(t)];
    const s = Math.sign(sweep) || 1;
    return {
      label: at(t0 + sweep / 2),
      lines,
      arrows: [
        { tip: at(t0), dir: mul(tan(t0), -s) },
        { tip: at(t0 + sweep), dir: mul(tan(t0 + sweep), s) },
      ],
    };
  }
  return null;
}

/** Where to keep a dimension's label when it is dragged to `p` (sketch mm), or null when it can't move. */
export function labelFor(c: SketchConstraint, geo: Geo, p: Vec2): [number, number] | null {
  if (c.type === "distance") {
    const ends = lengthEnds(c, geo);
    const f = ends && frame(ends[0], ends[1]);
    if (!ends || !f) return null;
    const m = mid(ends[0], ends[1]);
    return [dot(sub(p, m), f.n), dot(sub(p, m), f.u)];
  }
  if (c.type === "radius" || c.type === "diameter") {
    const g = c.refs[0] ? geo.get(c.refs[0]) : undefined;
    if (!g || (g.type !== "circle" && g.type !== "arc")) return null;
    const v = sub(p, g.c);
    return [Math.atan2(v[1], v[0]), Math.hypot(v[0], v[1]) - g.r];
  }
  if (c.type === "angle") {
    const f = angleFrame(c, geo);
    return f ? [Math.hypot(...sub(p, f.V)), 0] : null;
  }
  return null;
}
