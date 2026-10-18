/**
 * Drawing guidance for the sketch tools: where curves cross, the nearest point
 * on a curve, and the directions a new line would line up with (parallel or
 * perpendicular to an existing line, tangent to the arc it starts from).
 * Pure functions on solved geometry, so they're tested without a viewport.
 */
import type { GeomResolved, Id, Vec2 } from "@whittle/core";

type Curve = Extract<GeomResolved, { type: "line" | "arc" | "circle" }>;

const TAU = Math.PI * 2;
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);

/** Whether a point on the circle of an arc lies within its counter-clockwise sweep. */
function onArc(g: Extract<GeomResolved, { type: "arc" }>, p: Vec2, eps = 1e-9) {
  const t = (((Math.atan2(p[1] - g.c[1], p[0] - g.c[0]) - g.a0) % TAU) + TAU) % TAU;
  return t <= g.sweep + eps || t >= TAU - eps;
}

/** Whether a point found on the full line / circle is on the actual curve (segment or arc). */
function within(g: Curve, p: Vec2) {
  if (g.type === "line") {
    const d = sub(g.b, g.a);
    const t = dot(sub(p, g.a), d) / (dot(d, d) || 1);
    return t >= -1e-9 && t <= 1 + 1e-9;
  }
  return g.type === "circle" || onArc(g, p);
}

const curves = (geo: GeomResolved[]) => geo.filter((g): g is Curve => g.type === "line" || g.type === "arc" || g.type === "circle");

function lineCircle(a: Vec2, b: Vec2, c: Vec2, r: number): Vec2[] {
  const d = sub(b, a);
  const f = sub(a, c);
  const A = dot(d, d);
  if (A < 1e-18) return [];
  const B = 2 * dot(f, d);
  const disc = B * B - 4 * A * (dot(f, f) - r * r);
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  return [(-B - s) / (2 * A), (-B + s) / (2 * A)].map((t) => [a[0] + d[0] * t, a[1] + d[1] * t] as Vec2);
}

function circleCircle(c1: Vec2, r1: number, c2: Vec2, r2: number): Vec2[] {
  const d = len(sub(c2, c1));
  if (d < 1e-12 || d > r1 + r2 || d < Math.abs(r1 - r2)) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const u: Vec2 = [(c2[0] - c1[0]) / d, (c2[1] - c1[1]) / d];
  const m: Vec2 = [c1[0] + u[0] * a, c1[1] + u[1] * a];
  return [
    [m[0] - u[1] * h, m[1] + u[0] * h],
    [m[0] + u[1] * h, m[1] - u[0] * h],
  ];
}

type Ellipse = Extract<GeomResolved, { type: "ellipse" }>;

/** A point in an ellipse's own frame (major axis along x), and back. */
const toLocal = (e: Ellipse, p: Vec2): Vec2 => {
  const d = sub(p, e.c);
  const [cs, sn] = [Math.cos(e.angle), Math.sin(e.angle)];
  return [d[0] * cs + d[1] * sn, -d[0] * sn + d[1] * cs];
};
const toSketch = (e: Ellipse, [x, y]: Vec2): Vec2 => {
  const [cs, sn] = [Math.cos(e.angle), Math.sin(e.angle)];
  return [e.c[0] + x * cs - y * sn, e.c[1] + x * sn + y * cs];
};

/** Where a segment crosses an ellipse: the ellipse squashed to a unit circle makes it a line and a circle. */
function lineEllipse(a: Vec2, b: Vec2, e: Ellipse): Vec2[] {
  const unit = (p: Vec2): Vec2 => {
    const [x, y] = toLocal(e, p);
    return [x / e.rx, y / e.ry];
  };
  return lineCircle(unit(a), unit(b), [0, 0], 1).map(([x, y]) => toSketch(e, [x * e.rx, y * e.ry]));
}

/** The closest point on an ellipse (Newton steps on the parameter from the angular guess). */
export function nearestOnEllipse(e: Ellipse, p: Vec2): Vec2 {
  const [x, y] = toLocal(e, p);
  let t = Math.atan2(y * e.rx, x * e.ry);
  for (let i = 0; i < 12; i++) {
    const [s, c] = [Math.sin(t), Math.cos(t)];
    const f = (e.rx * e.rx - e.ry * e.ry) * s * c - x * e.rx * s + y * e.ry * c;
    const df = (e.rx * e.rx - e.ry * e.ry) * (c * c - s * s) - x * e.rx * c - y * e.ry * s;
    if (Math.abs(df) < 1e-12) break;
    const step = f / df;
    t -= step;
    if (Math.abs(step) < 1e-12) break;
  }
  return toSketch(e, [e.rx * Math.cos(t), e.ry * Math.sin(t)]);
}

/** Where two curves cross, except where they merely share an end (those points snap already). */
export function curveIntersections(geo: GeomResolved[], limit = 300): Vec2[] {
  const cs = curves(geo).slice(0, limit);
  const out: Vec2[] = [];
  const ends = (g: Curve): Vec2[] => (g.type === "circle" ? [] : [g.a, g.b]);
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      const g = cs[i]!;
      const h = cs[j]!;
      let pts: Vec2[];
      if (g.type === "line" && h.type === "line") {
        const d1 = sub(g.b, g.a);
        const d2 = sub(h.b, h.a);
        const den = cross(d1, d2);
        if (Math.abs(den) < 1e-12) continue;
        const t = cross(sub(h.a, g.a), d2) / den;
        pts = [[g.a[0] + d1[0] * t, g.a[1] + d1[1] * t]];
      } else if (g.type === "line") pts = lineCircle(g.a, g.b, (h as Exclude<Curve, { type: "line" }>).c, (h as Exclude<Curve, { type: "line" }>).r);
      else if (h.type === "line") pts = lineCircle(h.a, h.b, g.c, g.r);
      else pts = circleCircle(g.c, g.r, h.c, h.r);
      for (const p of pts) {
        if (!within(g, p) || !within(h, p)) continue;
        if ([...ends(g), ...ends(h)].some((e) => len(sub(e, p)) < 1e-6)) continue;
        out.push(p);
      }
    }
  }
  for (const e of geo.filter((g): g is Ellipse => g.type === "ellipse").slice(0, limit)) {
    for (const g of cs) {
      if (g.type !== "line") continue;
      for (const p of lineEllipse(g.a, g.b, e)) if (within(g, p) && ![g.a, g.b].some((q) => len(sub(q, p)) < 1e-6)) out.push(p);
    }
  }
  return out;
}

/** The closest point on any curve within `tol`, and that curve. */
export function nearestOnCurve(geo: GeomResolved[], p: Vec2, tol: number, skip: ReadonlySet<Id> = new Set()): { p: Vec2; curve: Id } | null {
  let best: { p: Vec2; curve: Id; d: number } | null = null;
  for (const g of curves(geo)) {
    if (skip.has(g.id)) continue;
    let q: Vec2;
    if (g.type === "line") {
      const d = sub(g.b, g.a);
      const t = Math.max(0, Math.min(1, dot(sub(p, g.a), d) / (dot(d, d) || 1)));
      q = [g.a[0] + d[0] * t, g.a[1] + d[1] * t];
    } else {
      const v = sub(p, g.c);
      const l = len(v);
      if (l < 1e-12) continue;
      q = [g.c[0] + (v[0] / l) * g.r, g.c[1] + (v[1] / l) * g.r];
      if (g.type === "arc" && !onArc(g, q)) continue;
    }
    const d = len(sub(q, p));
    if (d < tol && (!best || d < best.d)) best = { p: q, curve: g.id, d };
  }
  for (const g of geo) {
    if (g.type !== "ellipse" || skip.has(g.id)) continue;
    const q = nearestOnEllipse(g, p);
    const d = len(sub(q, p));
    if (d < tol && (!best || d < best.d)) best = { p: q, curve: g.id, d };
  }
  return best && { p: best.p, curve: best.curve };
}

export type Relation = "parallel" | "perpendicular" | "tangent";

/** A direction a new line can line up with; `ref` is the line (or arc) it relates to. */
export interface Direction {
  dir: Vec2;
  type: Relation;
  ref: Id;
  /** Where to draw the reference as a guide. */
  guide: [Vec2, Vec2];
}

/** Level and upright directions are left to the horizontal / vertical guides. */
const axisAligned = (d: Vec2) => Math.abs(d[0]) < 1e-9 || Math.abs(d[1]) < 1e-9;

/** Directions to line up with when drawing a line from `from`: parallel and perpendicular to lines, tangent to an arc ending there. */
export function directionsFrom(lines: { id: Id; a: Vec2; b: Vec2 }[], arcs: GeomResolved[], from: Vec2): Direction[] {
  const out: Direction[] = [];
  for (const l of lines) {
    const d = sub(l.b, l.a);
    const n = len(d);
    if (n < 1e-9) continue;
    const u: Vec2 = [d[0] / n, d[1] / n];
    if (!axisAligned(u)) out.push({ dir: u, type: "parallel", ref: l.id, guide: [l.a, l.b] });
    const p: Vec2 = [-u[1], u[0]];
    if (!axisAligned(p)) out.push({ dir: p, type: "perpendicular", ref: l.id, guide: [l.a, l.b] });
  }
  for (const g of arcs) {
    if (g.type !== "arc") continue;
    const atB = len(sub(g.b, from)) < 1e-6;
    if (!atB && len(sub(g.a, from)) >= 1e-6) continue;
    const r = sub(from, g.c);
    const l = len(r) || 1;
    const s = atB ? 1 : -1;
    const dir: Vec2 = [(-r[1] / l) * s, (r[0] / l) * s];
    if (!axisAligned(dir)) out.push({ dir, type: "tangent", ref: g.id, guide: [g.c, from] });
  }
  return out;
}

/** The direction (if any) the pointer is within `tol` of, measured across the ray from `from`, and the point on it. */
export function lineUp(from: Vec2, raw: Vec2, dirs: Direction[], tol: number): { p: Vec2; d: Direction } | null {
  const v = sub(raw, from);
  if (len(v) < tol * 2) return null;
  let best: { p: Vec2; d: Direction; off: number } | null = null;
  for (const d of dirs) {
    const t = dot(v, d.dir);
    // A tangent continues forward only; parallel and perpendicular work both ways.
    if (d.type === "tangent" && t <= 0) continue;
    const off = Math.abs(cross(d.dir, v));
    if (off < tol && (!best || off < best.off)) best = { p: [from[0] + d.dir[0] * t, from[1] + d.dir[1] * t], d, off };
  }
  return best && { p: best.p, d: best.d };
}

/** Where the ray from `from` along `dir` meets a line (for "perpendicular onto that line"). */
export function rayMeetsLine(from: Vec2, dir: Vec2, a: Vec2, b: Vec2): Vec2 | null {
  const e = sub(b, a);
  const den = cross(dir, e);
  if (Math.abs(den) < 1e-12) return null;
  const t = cross(sub(a, from), e) / den;
  return [from[0] + dir[0] * t, from[1] + dir[1] * t];
}
