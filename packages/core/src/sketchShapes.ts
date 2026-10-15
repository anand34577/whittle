/**
 * Turns whole-shape sketch entities (rectangle, circle, polygon, slot,
 * outline) into constraint-driven geometry, so every drawn shape can be
 * dimensioned, constrained, trimmed and filleted like any other geometry.
 * Also holds fillet and chamfer for corners of that geometry.
 */
import type { Id, SketchFeature, SketchGeom, Vec2 } from "./model";
import { addArc, addCircle, addSpline, addConstraint, addLine, addPoint, dropLengths, dropUnused, geomType, pointAt, usedPoints } from "./constraints";
import type { ResolvedEntity } from "./sketch";

type Geo = Pick<SketchFeature, "geometry" | "constraints">;

const AXIS_TOL = 1e-3;
const dist = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** A point of a chain: a corner, or (`arc`) a point the arc between its two neighbours passes through. */
export interface ChainPoint {
  p: Vec2;
  arc?: boolean;
}

/**
 * Lines and arcs through the points. Near-level lines get Horizontal or
 * Vertical; `tangent` joins arcs to their neighbouring lines.
 */
export function addChain(sk: Geo, pts: ChainPoint[], closed: boolean, opts: { construction?: boolean; tangent?: boolean } = {}): Id[] {
  const nodes: { id: Id; p: Vec2; through?: Vec2 }[] = [];
  for (const c of pts) {
    if (c.arc) nodes[nodes.length - 1]!.through = c.p;
    else nodes.push({ id: addPoint(sk, c.p, opts.construction), p: c.p });
  }
  const segs: { id: Id; arc: boolean }[] = [];
  const n = nodes.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = nodes[i]!;
    const b = nodes[(i + 1) % n]!;
    const arcId = a.through ? addArc(sk, a.id, b.id, a.through, opts.construction) : null;
    if (arcId) {
      segs.push({ id: arcId, arc: true });
      continue;
    }
    const id = addLine(sk, a.id, b.id, opts.construction);
    segs.push({ id, arc: false });
    if (Math.abs(a.p[1] - b.p[1]) < AXIS_TOL) addConstraint(sk, "horizontal", [id]);
    else if (Math.abs(a.p[0] - b.p[0]) < AXIS_TOL) addConstraint(sk, "vertical", [id]);
  }
  if (opts.tangent) {
    segs.forEach((s, i) => {
      const next = segs[i + 1] ?? (closed ? segs[0] : undefined);
      if (next && next !== s && s.arc !== next.arc) addConstraint(sk, "tangent", [s.id, next.id]);
    });
  }
  return segs.map((s) => s.id);
}

const rot = (p: Vec2, c: Vec2, a: number): Vec2 => {
  const cs = Math.cos(a);
  const sn = Math.sin(a);
  return [c[0] + (p[0] - c[0]) * cs - (p[1] - c[1]) * sn, c[1] + (p[0] - c[0]) * sn + (p[1] - c[1]) * cs];
};

/** A rectangle from its four corners in order: four lines, with right angles held by Horizontal/Vertical or Perpendicular. */
export function addRectGeometry(sk: Geo, corners: [Vec2, Vec2, Vec2, Vec2], construction = false): Id[] {
  const lines = addChain(sk, corners.map((p) => ({ p })), true, { construction });
  const level = lines.every((id) => (sk.constraints ?? []).some((c) => c.refs[0] === id && (c.type === "horizontal" || c.type === "vertical")));
  if (!level) for (let i = 0; i < 3; i++) addConstraint(sk, "perpendicular", [lines[i]!, lines[i + 1]!]);
  return lines;
}

/** Add the geometry for an entity. Returns a message when that kind of shape can't be converted. */
export function addEntityGeometry(sk: Geo, r: ResolvedEntity): string | undefined {
  const construction = r.construction;
  switch (r.type) {
    case "rect": {
      const c: Vec2 = [r.x + r.w / 2, r.y + r.h / 2];
      const raw: Vec2[] = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
      const corners = raw.map((p) => (r.angle ? rot(p, c, r.angle) : p)) as [Vec2, Vec2, Vec2, Vec2];
      if (!r.corner) {
        addRectGeometry(sk, corners, construction);
        return undefined;
      }
      // Rounded corners: a line, then an arc around each corner.
      const k = r.corner;
      const pts: ChainPoint[] = [];
      corners.forEach((p, i) => {
        const toward = (q: Vec2): Vec2 => {
          const l = dist(p, q) || 1;
          return [p[0] + ((q[0] - p[0]) / l) * k, p[1] + ((q[1] - p[1]) / l) * k];
        };
        const a = toward(corners[(i + 3) % 4]!);
        const b = toward(corners[(i + 1) % 4]!);
        const centre: Vec2 = [a[0] + b[0] - p[0], a[1] + b[1] - p[1]];
        const l = dist(centre, p) || 1;
        pts.push({ p: a }, { p: [centre[0] + ((p[0] - centre[0]) / l) * k, centre[1] + ((p[1] - centre[1]) / l) * k], arc: true }, { p: b });
      });
      addChain(sk, pts, true, { construction, tangent: true });
      return undefined;
    }
    case "circle":
      addCircle(sk, [r.cx, r.cy], r.r, construction);
      return undefined;
    case "polygon": {
      const pts: ChainPoint[] = [];
      for (let i = 0; i < r.sides; i++) {
        const a = r.angle + (i / r.sides) * Math.PI * 2;
        pts.push({ p: [r.cx + r.r * Math.cos(a), r.cy + r.r * Math.sin(a)] });
      }
      const ids = addChain(sk, pts, true, { construction });
      for (let i = 1; i < ids.length; i++) addConstraint(sk, "equal", [ids[0]!, ids[i]!]);
      return undefined;
    }
    case "slot": {
      const w = r.width / 2;
      if (r.length < 1e-9) {
        addCircle(sk, [r.cx, r.cy], w, construction);
        return undefined;
      }
      const d: Vec2 = [Math.cos(r.angle), Math.sin(r.angle)];
      const h = r.length / 2;
      const at = (along: number, across: number): Vec2 => [r.cx + d[0] * along - d[1] * across, r.cy + d[1] * along + d[0] * across];
      const pts: ChainPoint[] = [{ p: at(-h, w) }, { p: at(h, w) }, { p: at(h + w, 0), arc: true }, { p: at(h, -w) }, { p: at(-h, -w) }, { p: at(-h - w, 0), arc: true }];
      addChain(sk, pts, true, { construction, tangent: true });
      return undefined;
    }
    case "polyline": {
      if (r.corner || (r.smooth && r.arcs.some(Boolean))) return "Outlines with rounded corners, or smooth ones that also have arcs, can't be converted. Turn the rounding off first.";
      if (r.splines.some(Boolean)) return "Outlines that mix lines with spline points can't be converted yet.";
      if (r.smooth && r.points.length >= 3) {
        addSpline(sk, r.points, !r.open, construction);
        return undefined;
      }
      addChain(sk, r.points.map((p, i) => ({ p, arc: r.arcs[i] })), !r.open, { construction });
      return undefined;
    }
    default:
      return "This kind of shape (ellipse, text or gear) can't be converted to constrainable geometry.";
  }
}

/**
 * Round (or, with `chamfer`, cut) the corner where exactly two lines meet.
 * `size` is the fillet radius or the chamfer setback along each line (mm);
 * `text` is the same value as typed, kept as the radius dimension. Works on the
 * stored positions: bake the solution first. Returns a message when the corner
 * can't be treated.
 */
export function filletCorner(sk: Geo, corner: Id, size: number, text: string, chamfer = false): string | undefined {
  if (corner === "origin" || geomType(sk, corner) !== "point") return "Pick a corner point where two lines meet.";
  type Line = Extract<SketchGeom, { type: "line" }>;
  const touching = (sk.geometry ?? []).filter((g) => ((g.type === "line" || g.type === "arc") && (g.a === corner || g.b === corner)) || (g.type === "spline" && g.pts.includes(corner)));
  const lines = touching.filter((g): g is Line => g.type === "line");
  if (lines.length !== 2 || touching.length !== 2) return "Pick a corner where exactly two lines meet.";
  if (!(size > 1e-9)) return chamfer ? "The chamfer distance must be greater than zero." : "The radius must be greater than zero.";
  const [l1, l2] = lines as [Line, Line];
  const P = pointAt(sk, corner);
  const far = (l: Line) => pointAt(sk, l.a === corner ? l.b : l.a);
  const [Q1, Q2] = [far(l1), far(l2)];
  const len1 = dist(P, Q1);
  const len2 = dist(P, Q2);
  if (len1 < 1e-9 || len2 < 1e-9) return "One of those lines has no length.";
  const u1: Vec2 = [(Q1[0] - P[0]) / len1, (Q1[1] - P[1]) / len1];
  const u2: Vec2 = [(Q2[0] - P[0]) / len2, (Q2[1] - P[1]) / len2];
  const theta = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
  if (theta < 1e-3 || theta > Math.PI - 1e-3) return "Those lines are straight through each other, so there's no corner.";
  const t = chamfer ? size : size / Math.tan(theta / 2);
  const room = Math.min(len1, len2);
  if (t >= room - 1e-9) return `That's too big for this corner: at most ${(chamfer ? room : room * Math.tan(theta / 2)).toFixed(2)} mm.`;

  const before = usedPoints(sk);
  const i1 = addPoint(sk, [P[0] + u1[0] * t, P[1] + u1[1] * t]);
  const i2 = addPoint(sk, [P[0] + u2[0] * t, P[1] + u2[1] * t]);
  if (l1.a === corner) l1.a = i1;
  else l1.b = i1;
  if (l2.a === corner) l2.a = i2;
  else l2.b = i2;
  dropLengths(sk, l1.id);
  dropLengths(sk, l2.id);

  if (chamfer) addLine(sk, i1, i2);
  else {
    const bis: Vec2 = [u1[0] + u2[0], u1[1] + u2[1]];
    const k = size / Math.sin(theta / 2) / Math.hypot(bis[0], bis[1]);
    const C: Vec2 = [P[0] + bis[0] * k, P[1] + bis[1] * k];
    const m = dist(P, C) || 1;
    const arc = addArc(sk, i1, i2, [C[0] + ((P[0] - C[0]) / m) * size, C[1] + ((P[1] - C[1]) / m) * size]);
    if (arc) {
      addConstraint(sk, "tangent", [l1.id, arc]);
      addConstraint(sk, "tangent", [l2.id, arc]);
      addConstraint(sk, "radius", [arc], text);
    }
  }
  dropUnused(sk, before);
  return undefined;
}

/* ───────────────────────── Projected edges ───────────────────────── */

/** A projected curve's polyline (sketch mm) with its centre and radius when it is round, else null. */
function fitRound(pts: Vec2[]): { c: Vec2; r: number } | null {
  if (pts.length < 4) return null;
  const a = pts[0]!;
  const m = pts[Math.floor(pts.length / 2)]!;
  const b = pts[pts.length - 1]!;
  const closed = dist(a, b) < 1e-6;
  const b2 = closed ? pts[Math.floor(pts.length / 4)]! : b;
  const d = 2 * (a[0] * (m[1] - b2[1]) + m[0] * (b2[1] - a[1]) + b2[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-9) return null;
  const sq = (p: Vec2) => p[0] * p[0] + p[1] * p[1];
  const c: Vec2 = [(sq(a) * (m[1] - b2[1]) + sq(m) * (b2[1] - a[1]) + sq(b2) * (a[1] - m[1])) / d, (sq(a) * (b2[0] - m[0]) + sq(m) * (a[0] - b2[0]) + sq(b2) * (m[0] - a[0])) / d];
  const r = dist(c, a);
  return pts.every((p) => Math.abs(dist(c, p) - r) < Math.max(1e-3, r * 1e-3)) ? { c, r } : null;
}

/**
 * Add an edge projected onto the sketch plane as locked geometry: a line, an
 * arc, a circle, or (for any other curve) a chain of short lines. Points already
 * in the sketch at the same spot are reused, so projected faces come out joined.
 * Returns false when the edge projects to nothing (it points straight at the plane).
 */
export function addProjectedPolyline(sk: Geo, pts: Vec2[]): boolean {
  if (pts.length < 2) return false;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const closed = dist(first, last) < 1e-6;
  const extent = Math.max(...pts.map((p) => dist(first, p)));
  if (extent < 1e-6) return false;
  const near = (p: Vec2): Id | Vec2 => (sk.geometry ?? []).find((g) => g.type === "point" && !g.construction && Math.hypot(g.x - p[0], g.y - p[1]) < 1e-6)?.id ?? p;
  const lock = (ids: Id[]) => ids.forEach((id) => addConstraint(sk, "fixed", [id]));
  const round = fitRound(pts);
  if (round && closed) {
    lock([addCircle(sk, round.c, round.r)]);
    return true;
  }
  if (round) {
    const arc = addArc(sk, near(first), near(last), pts[Math.floor(pts.length / 2)]!);
    if (arc) {
      lock([arc]);
      return true;
    }
  }
  const ends = closed ? pts.slice(0, -1) : pts;
  const ids: Id[] = [];
  // Drop in-between points of straight runs, so a line stays one line.
  const keep = ends.filter((p, i) => {
    if (i === 0 || i === ends.length - 1) return true;
    const a = ends[i - 1]!;
    const b = ends[i + 1]!;
    return Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) > 1e-9 * (dist(a, b) || 1);
  });
  for (let i = 0; i + 1 < keep.length + (closed ? 1 : 0); i++) ids.push(addLine(sk, near(keep[i]!), near(keep[(i + 1) % keep.length]!)));
  lock(ids);
  return ids.length > 0;
}
