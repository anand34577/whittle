/**
 * The areas enclosed by loose sketch curves: lines and arcs that cross, overshoot each other's ends, meet partway
 * along another curve, or meet three or more at a point. Every curve is split where it meets another, loose tails
 * are dropped, and the outline round each connected group of what is left is traced, so the sketch gives the
 * closed shapes it shows on screen.
 */
import type { PolyPoint, Vec2 } from "./model";

export type LooseCurve = { kind: "line"; a: Vec2; b: Vec2 } | { kind: "arc"; c: Vec2; r: number; a0: number; sweep: number };
type Arc = Extract<LooseCurve, { kind: "arc" }>;

/** Past this many curves the pairwise intersections get slow; such sketches keep only their joined loops. */
const CURVE_LIMIT = 600;

const TAU = Math.PI * 2;

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);
const num = (v: number) => v as unknown as string;

function at(c: LooseCurve, t: number): Vec2 {
  if (c.kind === "line") return [c.a[0] + (c.b[0] - c.a[0]) * t, c.a[1] + (c.b[1] - c.a[1]) * t];
  const ang = c.a0 + c.sweep * t;
  return [c.c[0] + c.r * Math.cos(ang), c.c[1] + c.r * Math.sin(ang)];
}

type Box = [number, number, number, number];
function box(c: LooseCurve): Box {
  if (c.kind === "line") return [Math.min(c.a[0], c.b[0]), Math.min(c.a[1], c.b[1]), Math.max(c.a[0], c.b[0]), Math.max(c.a[1], c.b[1])];
  // The ends, plus each axis extreme the arc passes.
  const pts = [at(c, 0), at(c, 1)];
  for (let k = 0; k < 4; k++) if (arcParam(c, (k * Math.PI) / 2) !== null) pts.push([c.c[0] + c.r * Math.cos((k * Math.PI) / 2), c.c[1] + c.r * Math.sin((k * Math.PI) / 2)]);
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}
const apart = (a: Box, b: Box, tol: number) => a[0] > b[2] + tol || b[0] > a[2] + tol || a[1] > b[3] + tol || b[1] > a[3] + tol;

/** Where an angle falls along an arc (0..1), or null when it is off the arc. */
function arcParam(c: Arc, ang: number): number | null {
  let d = (ang - c.a0) % TAU;
  if (d < 0) d += TAU;
  const t = d / c.sweep;
  return t <= 1 + 1e-12 ? Math.min(1, t) : null;
}

/** Parameter of the point on the curve nearest `p`, with its distance. */
function nearest(c: LooseCurve, p: Vec2): { t: number; d: number } {
  if (c.kind === "line") {
    const ab = sub(c.b, c.a);
    const l2 = dot(ab, ab);
    const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, c.a), ab) / l2)) : 0;
    return { t, d: len(sub(p, at(c, t))) };
  }
  const t = arcParam(c, Math.atan2(p[1] - c.c[1], p[0] - c.c[0]));
  let best = { t: 0, d: Infinity };
  for (const x of t === null ? [0, 1] : [t, 0, 1]) {
    const d = len(sub(p, at(c, x)));
    if (d < best.d) best = { t: x, d };
  }
  return best;
}

/** Points where a line through `p` along `d` meets a circle, as line parameters. */
function lineCircle(p: Vec2, d: Vec2, c: Vec2, r: number, tol: number): number[] {
  const f = sub(p, c);
  const A = dot(d, d);
  if (A === 0) return [];
  const B = 2 * dot(f, d);
  const C = dot(f, f) - r * r;
  const disc = B * B - 4 * A * C;
  // A line that only grazes the circle (within tolerance) touches it once.
  if (disc <= 0) return [-B / (2 * A)];
  const s = Math.sqrt(disc);
  return [(-B - s) / (2 * A), (-B + s) / (2 * A)];
}

/** Crossing parameters on curves `a` and `b`. */
function crossings(a: LooseCurve, b: LooseCurve, tol: number): [number, number][] {
  const out: [number, number][] = [];
  const keep = (p: Vec2) => {
    const x = nearest(a, p);
    const y = nearest(b, p);
    if (x.d <= tol && y.d <= tol) out.push([x.t, y.t]);
  };
  if (a.kind === "line" && b.kind === "line") {
    const r = sub(a.b, a.a);
    const s = sub(b.b, b.a);
    const den = cross(r, s);
    if (Math.abs(den) > 1e-12 * len(r) * len(s)) keep(at(a, cross(sub(b.a, a.a), s) / den));
  } else if (a.kind === "line" || b.kind === "line") {
    const [l, c] = (a.kind === "line" ? [a, b] : [b, a]) as [Extract<LooseCurve, { kind: "line" }>, Arc];
    for (const t of lineCircle(l.a, sub(l.b, l.a), c.c, c.r, tol)) keep(at(l, t));
  } else {
    const [p, q] = [a as Arc, b as Arc];
    const d = len(sub(q.c, p.c));
    if (d > 1e-12 && d <= p.r + q.r + tol && d >= Math.abs(p.r - q.r) - tol) {
      const x = (d * d + p.r * p.r - q.r * q.r) / (2 * d);
      const h = Math.sqrt(Math.max(0, p.r * p.r - x * x));
      const u: Vec2 = [(q.c[0] - p.c[0]) / d, (q.c[1] - p.c[1]) / d];
      const m: Vec2 = [p.c[0] + u[0] * x, p.c[1] + u[1] * x];
      keep([m[0] - u[1] * h, m[1] + u[0] * h]);
      if (h > tol) keep([m[0] + u[1] * h, m[1] - u[0] * h]);
    }
  }
  // Ends that land on the other curve: T-joints, shared corners and overlapping pieces of the same line or circle.
  for (const p of [at(a, 0), at(a, 1), at(b, 0), at(b, 1)]) keep(p);
  return out;
}

interface Edge {
  curve: number;
  t0: number;
  t1: number;
  u: number;
  v: number;
}

/**
 * The outline of the area each connected group of loose curves encloses, with the joined loops (closed outlines)
 * they touch: such a loop is taken into the group, and listed in `covered` because its area is now in the
 * outlines. Lines inside a group (a rectangle's diagonal) don't split it: the solid is the same, and handing the
 * geometry engine the pieces to fuse back together fails where they share an arc and takes minutes for hundreds.
 * Outlines are polyline points with arcs kept as arcs; both lists are empty when the curves enclose nothing.
 */
export function looseAreas(loose: LooseCurve[], loops: LooseCurve[][] = []): { faces: PolyPoint[][]; covered: number[] } {
  const none = { faces: [], covered: [] };
  if (!loose.length || loose.length + loops.reduce((n, l) => n + l.length, 0) > CURVE_LIMIT) return none;
  let lo: Vec2 = [Infinity, Infinity];
  let hi: Vec2 = [-Infinity, -Infinity];
  for (const c of [...loose, ...loops.flat()]) {
    const b = box(c);
    lo = [Math.min(lo[0], b[0]), Math.min(lo[1], b[1])];
    hi = [Math.max(hi[0], b[2]), Math.max(hi[1], b[3])];
  }
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1]);
  if (!(size > 0) || !Number.isFinite(size)) return none;
  const tol = 1e-7 * size;

  // A loop the loose curves touch joins them (and then so does any loop it touches in turn).
  const curves = [...loose];
  const boxes = curves.map(box);
  const covered: number[] = [];
  const meets = (c: LooseCurve) => {
    const b = box(c);
    return curves.some((x, i) => !apart(b, boxes[i]!, tol) && crossings(c, x, tol).length > 0);
  };
  for (let grew = true; grew; ) {
    grew = false;
    loops.forEach((loop, i) => {
      if (covered.includes(i) || !loop.some(meets)) return;
      covered.push(i);
      for (const c of loop) {
        curves.push(c);
        boxes.push(box(c));
      }
      grew = true;
    });
  }
  if (curves.length < 2) return none;

  // Split parameters on every curve.
  // A whole circle is split once anyway, so being touched exactly at its seam can't lose it.
  const cuts = curves.map((c) => (c.kind === "arc" && c.sweep >= TAU - 1e-12 ? [0, 0.5, 1] : [0, 1]));
  for (let i = 0; i < curves.length; i++) {
    for (let j = i + 1; j < curves.length; j++) {
      if (apart(boxes[i]!, boxes[j]!, tol)) continue;
      for (const [ti, tj] of crossings(curves[i]!, curves[j]!, tol)) {
        cuts[i]!.push(ti);
        cuts[j]!.push(tj);
      }
    }
  }

  // Vertices merge when they are within tolerance (looked up in a grid of cells that size).
  const verts: Vec2[] = [];
  const near = tol * 10;
  const grid = new Map<string, number[]>();
  const vertex = (p: Vec2) => {
    const [gx, gy] = [Math.floor(p[0] / near), Math.floor(p[1] / near)];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const k of grid.get(`${gx + dx},${gy + dy}`) ?? []) if (len(sub(verts[k]!, p)) <= near) return k;
    verts.push(p);
    const key = `${gx},${gy}`;
    grid.set(key, [...(grid.get(key) ?? []), verts.length - 1]);
    return verts.length - 1;
  };
  let edges: Edge[] = [];
  const between = new Map<string, Edge[]>();
  curves.forEach((c, i) => {
    const ts = [...new Set(cuts[i]!)].sort((x, y) => x - y);
    for (let k = 0; k + 1 < ts.length; k++) {
      const [t0, t1] = [ts[k]!, ts[k + 1]!];
      const u = vertex(at(c, t0));
      const v = vertex(at(c, t1));
      // A zero-length piece; a whole circle with nothing cutting it is a loop of its own and stays one.
      if (u === v) continue;
      // Pieces of overlapping lines or arcs, or a curve drawn twice, give the same edge more than once.
      const m = at(c, (t0 + t1) / 2);
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      const list = between.get(key) ?? [];
      if (list.some((e) => len(sub(at(curves[e.curve]!, (e.t0 + e.t1) / 2), m)) <= near)) continue;
      const e = { curve: i, t0, t1, u, v };
      edges.push(e);
      between.set(key, [...list, e]);
    }
  });

  // Tracing repeats after dropping the bridges (edges with the same face on both sides) it finds.
  for (let pass = 0; pass < 50; pass++) {
    edges = pruneTails(edges);
    if (!edges.length) break;
    const traced = traceFaces(edges, verts, curves, size);
    if (traced.bridges.size === 0) return traced.faces.length ? { faces: traced.faces, covered } : none;
    edges = edges.filter((_, i) => !traced.bridges.has(i));
  }
  return none;
}

/** Drop edges that dangle from a vertex nothing else reaches: they can't bound an area. */
function pruneTails(edges: Edge[]): Edge[] {
  let list = edges;
  for (;;) {
    const deg = new Map<number, number>();
    for (const e of list) {
      deg.set(e.u, (deg.get(e.u) ?? 0) + 1);
      deg.set(e.v, (deg.get(e.v) ?? 0) + 1);
    }
    const next = list.filter((e) => deg.get(e.u)! > 1 && deg.get(e.v)! > 1);
    if (next.length === list.length) return list;
    list = next;
  }
}

function traceFaces(edges: Edge[], verts: Vec2[], curves: LooseCurve[], size: number): { faces: PolyPoint[][]; bridges: Set<number> } {
  // Half-edge 2i runs u→v along edge i, 2i+1 runs back.
  const from = (h: number) => (h % 2 ? edges[h >> 1]!.v : edges[h >> 1]!.u);
  const to = (h: number) => (h % 2 ? edges[h >> 1]!.u : edges[h >> 1]!.v);
  const curve = (h: number) => curves[edges[h >> 1]!.curve]!;
  const param = (h: number, s: number) => {
    const e = edges[h >> 1]!;
    return h % 2 ? e.t1 + (e.t0 - e.t1) * s : e.t0 + (e.t1 - e.t0) * s;
  };
  // The exact direction each half-edge leaves its corner in (0..2π), and how it bends: curves that leave in the same
  // direction (a line and an arc tangent to it) sort by bend, the one turning left coming counter-clockwise after.
  const leave = (h: number): [number, number] => {
    const c = curve(h);
    const back = h % 2 === 1;
    let ang: number;
    let bend = 0;
    if (c.kind === "line") ang = back ? Math.atan2(c.a[1] - c.b[1], c.a[0] - c.b[0]) : Math.atan2(c.b[1] - c.a[1], c.b[0] - c.a[0]);
    else {
      // Arcs run counter-clockwise with growing parameter: forward the tangent is a quarter turn on from the radius.
      ang = c.a0 + c.sweep * param(h, 0) + (back ? -Math.PI / 2 : Math.PI / 2);
      bend = (back ? -1 : 1) / c.r;
    }
    ang %= TAU;
    if (ang < 0) ang += TAU;
    if (ang > TAU - 1e-9) ang = 0;
    return [ang, bend];
  };
  const out = new Map<number, number[]>();
  for (let h = 0; h < edges.length * 2; h++) {
    const list = out.get(from(h));
    if (list) list.push(h);
    else out.set(from(h), [h]);
  }
  const pos = new Map<number, number>();
  for (const list of out.values()) {
    const key = new Map(list.map((h) => [h, leave(h)]));
    list.sort((x, y) => {
      const [a, b] = [key.get(x)!, key.get(y)!];
      return Math.abs(a[0] - b[0]) > 1e-9 ? a[0] - b[0] : a[1] - b[1];
    });
    list.forEach((h, i) => pos.set(h, i));
  }
  // Keep the face on the left: at the far end, take the edge just clockwise of the way back.
  const next = (h: number) => {
    const list = out.get(to(h))!;
    return list[(pos.get(h ^ 1)! - 1 + list.length) % list.length]!;
  };

  const faceOf = new Map<number, number>();
  const cycles: number[][] = [];
  for (let h = 0; h < edges.length * 2; h++) {
    if (faceOf.has(h)) continue;
    const cyc: number[] = [];
    for (let x = h; !faceOf.has(x); x = next(x)) {
      faceOf.set(x, cycles.length);
      cyc.push(x);
    }
    cycles.push(cyc);
  }
  const bridges = new Set<number>();
  for (let i = 0; i < edges.length; i++) if (faceOf.get(2 * i) === faceOf.get(2 * i + 1)) bridges.add(i);
  if (bridges.size) return { faces: [], bridges };

  const signed = (cyc: number[]) => {
    let area = 0;
    for (const h of cyc) {
      const steps = curve(h).kind === "arc" ? 32 : 1;
      for (let s = 0; s < steps; s++) area += cross(at(curve(h), param(h, s / steps)), at(curve(h), param(h, (s + 1) / steps)));
    }
    return area / 2;
  };
  const sliver = 1e-9 * size * size;
  // Connected groups of edges.
  const group = new Map<number, number>();
  const root = (v: number): number => {
    const p = group.get(v);
    if (p === undefined || p === v) return v;
    const r = root(p);
    group.set(v, r);
    return r;
  };
  for (const e of edges) group.set(root(e.u), root(e.v));
  // Counter-clockwise cycles are the areas; the one clockwise cycle of each group runs round its outside.
  const inside = new Set<number>();
  const outside = new Map<number, number[]>();
  for (const cyc of cycles) {
    const g = root(from(cyc[0]!));
    const a = signed(cyc);
    if (a > sliver) inside.add(g);
    else if (a < 0 && (!outside.has(g) || a < signed(outside.get(g)!))) outside.set(g, cyc);
  }
  const faces: PolyPoint[][] = [];
  for (const g of inside) {
    const cyc = outside.get(g);
    if (!cyc) continue;
    // An outline that touches itself at a corner (two shapes meeting at a point) is split there into simple loops.
    for (const loop of simpleLoops(cyc, from)) if (Math.abs(signed(loop)) > sliver) faces.push(outline(loop, verts, curves, edges, from, param));
  }
  return { faces, bridges };
}

/** A closed run of half-edges cut wherever it comes back to a corner it already passed: loops that touch at points. */
function simpleLoops(cyc: number[], from: (h: number) => number): number[][] {
  const loops: number[][] = [];
  const stack: number[] = [];
  const seen = new Map<number, number>();
  for (const h of cyc) {
    const v = from(h);
    const i = seen.get(v);
    if (i !== undefined) {
      const loop = stack.splice(i);
      for (const x of loop) seen.delete(from(x));
      loops.push(loop);
    }
    seen.set(v, stack.length);
    stack.push(h);
  }
  if (stack.length) loops.push(stack);
  return loops;
}

/** A face's outline, with neighbouring pieces of the same line or arc (split where a loose tail was) joined up again. */
function outline(cyc: number[], verts: Vec2[], curves: LooseCurve[], edges: Edge[], from: (h: number) => number, param: (h: number, s: number) => number): PolyPoint[] {
  // Runs of half-edges along one curve, in the same direction.
  const runs: { curve: number; t0: number; t1: number; start: number }[] = [];
  for (const h of cyc) {
    const c = edges[h >> 1]!.curve;
    const [t0, t1] = [param(h, 0), param(h, 1)];
    const last = runs[runs.length - 1];
    if (last && last.curve === c && Math.abs(last.t1 - t0) < 1e-12 && Math.sign(t1 - t0) === Math.sign(last.t1 - last.t0)) last.t1 = t1;
    else runs.push({ curve: c, t0, t1, start: from(h) });
  }
  const first = runs[0]!;
  const tail = runs[runs.length - 1]!;
  if (runs.length > 1 && tail.curve === first.curve && Math.abs(tail.t1 - first.t0) < 1e-12 && Math.sign(tail.t1 - tail.t0) === Math.sign(first.t1 - first.t0)) {
    first.t0 = tail.t0;
    first.start = tail.start;
    runs.pop();
  }
  const pts: PolyPoint[] = [];
  for (const r of runs) {
    const a = verts[r.start]!;
    pts.push([num(a[0]), num(a[1])]);
    const c = curves[r.curve]!;
    if (c.kind === "arc") {
      // A three-point arc can't go all the way round: a joined-up circle, or more than half of one, goes in halves.
      const halves = Math.abs(r.t1 - r.t0) * c.sweep > Math.PI + 1e-9;
      const marks = halves ? [0.25, 0.5, 0.75] : [0.5];
      marks.forEach((f, k) => {
        const m = at(c, r.t0 + (r.t1 - r.t0) * f);
        pts.push([num(m[0]), num(m[1]), ...(k === 1 ? [] : ["arc" as const])] as PolyPoint);
      });
    }
  }
  // Straight pieces of different lines that carry straight on are one side.
  return pts.filter((p, i) => {
    if (p[2] || pts.length <= 3) return true;
    const prev = pts[(i - 1 + pts.length) % pts.length]!;
    const nxt = pts[(i + 1) % pts.length]!;
    if (prev[2] || nxt[2]) return true;
    const P = (q: PolyPoint): Vec2 => [q[0] as unknown as number, q[1] as unknown as number];
    const u = sub(P(p), P(prev));
    const w = sub(P(nxt), P(p));
    return Math.abs(cross(u, w)) > 1e-9 * len(u) * len(w) || dot(u, w) < 0;
  });
}

/**
 * The smallest gap between the free end of a curve and another curve, when there is one smaller than a twentieth
 * of the drawing: what keeps the shape from closing when the ends look joined. Null when every end touches.
 */
export function nearestGap(curves: LooseCurve[]): { at: Vec2; gap: number } | null {
  if (curves.length < 2 || curves.length > CURVE_LIMIT) return null;
  const boxes = curves.map(box);
  const size = Math.max(Math.max(...boxes.map((b) => b[2])) - Math.min(...boxes.map((b) => b[0])), Math.max(...boxes.map((b) => b[3])) - Math.min(...boxes.map((b) => b[1])));
  if (!(size > 0)) return null;
  const tol = 1e-7 * size;
  let best: { at: Vec2; gap: number } | null = null;
  curves.forEach((c, i) => {
    // A whole circle has no ends.
    if (c.kind === "arc" && c.sweep >= TAU - 1e-12) return;
    for (const p of [at(c, 0), at(c, 1)]) {
      const d = curves.map((o, j) => (j === i ? Infinity : nearest(o, p).d));
      const gap = Math.min(...d);
      if (gap > tol && gap < size / 20 && (!best || gap < best.gap)) best = { at: p, gap };
    }
  });
  return best;
}
