/**
 * Copying constraint geometry: mirror, rectangular and circular patterns, and
 * offset. Copies keep the relations between their own parts (level, tangent,
 * equal, dimensions); a mirror is also held symmetric to its original.
 * Everything works on stored positions: bake the solution first.
 */
import type { Id, SketchConstraint, SketchFeature, SketchGeom, Vec2 } from "./model";
import { addConstraint, addLine, addPoint, circleCircle, geomById, geomType, lineCircle, lineLine, pointAt } from "./constraints";
import { uid } from "./factory";

type Geo = Pick<SketchFeature, "geometry" | "constraints">;
const dist = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** The selected curves and points, and every point they depend on. */
function closure(sk: Geo, ids: Id[]): { curves: Exclude<SketchGeom, { type: "point" }>[]; points: Set<Id> } {
  const curves: Exclude<SketchGeom, { type: "point" }>[] = [];
  const points = new Set<Id>();
  for (const id of ids) {
    const g = geomById(sk, id);
    if (!g) continue;
    if (g.type === "point") points.add(g.id);
    else {
      curves.push(g);
      if (g.type === "line") points.add(g.a).add(g.b);
      else if (g.type === "spline") g.pts.forEach((p) => points.add(p));
      else if (g.type === "arc") points.add(g.a).add(g.b).add(g.c);
      else if (g.type === "ellipse") points.add(g.c).add(g.a);
      else points.add(g.c);
    }
  }
  return { curves, points };
}

/**
 * Copy the selection through a transform. `flip` is for mirrors (arcs run the
 * other way round). `keep` points are shared with the original, not copied.
 * Returns the new curve and point ids, or null when nothing was selected.
 */
function copyThrough(sk: Geo, ids: Id[], map: (p: Vec2) => Vec2, opts: { flip?: boolean; relations?: boolean; keep?: (id: Id, p: Vec2) => boolean } = {}): { map: Map<Id, Id>; added: Id[] } | null {
  const { curves, points } = closure(sk, ids);
  if (!points.size) return null;
  const idMap = new Map<Id, Id>();
  const added: Id[] = [];
  for (const id of points) {
    const p = pointAt(sk, id);
    if (opts.keep?.(id, p)) {
      idMap.set(id, id);
      continue;
    }
    const g = geomById(sk, id);
    const n = addPoint(sk, map(p), g?.construction);
    idMap.set(id, n);
    added.push(n);
  }
  for (const g of curves) {
    const id = uid(g.type === "line" ? "l" : g.type === "arc" ? "a" : g.type === "spline" ? "s" : g.type === "ellipse" ? "e" : "c");
    const construction = g.construction ? { construction: true } : {};
    if (g.type === "line") sk.geometry!.push({ id, type: "line", a: idMap.get(g.a)!, b: idMap.get(g.b)!, ...construction });
    else if (g.type === "spline") sk.geometry!.push({ id, type: "spline", pts: g.pts.map((p) => idMap.get(p)!), ...(g.closed ? { closed: true } : {}), ...construction });
    else if (g.type === "arc") {
      const [a, b] = opts.flip ? [g.b, g.a] : [g.a, g.b];
      sk.geometry!.push({ id, type: "arc", c: idMap.get(g.c)!, a: idMap.get(a)!, b: idMap.get(b)!, ...construction });
    } else if (g.type === "ellipse") sk.geometry!.push({ id, type: "ellipse", c: idMap.get(g.c)!, a: idMap.get(g.a)!, r: g.r, ...construction });
    else sk.geometry!.push({ id, type: "circle", c: idMap.get(g.c)!, r: g.r, ...construction });
    idMap.set(g.id, id);
    added.push(id);
  }
  // Relations among the copied parts carry over; ones that tie the original to the sheet or its angle sign don't.
  for (const c of opts.relations === false ? [] : [...(sk.constraints ?? [])]) {
    if (c.type === "fixed" || (opts.flip && c.type === "angle")) continue;
    if (!c.refs.every((r) => idMap.has(r))) continue;
    if (c.refs.every((r) => idMap.get(r) === r)) continue;
    addConstraint(sk, c.type, c.refs.map((r) => idMap.get(r)!), c.value);
  }
  return { map: idMap, added };
}

/** The mirror line as two points: the axes, or a line of the sketch. */
function axisOf(sk: Geo, line: Id): [Vec2, Vec2] | null {
  if (line === "xaxis") return [[0, 0], [1, 0]];
  if (line === "yaxis") return [[0, 0], [0, 1]];
  const g = geomById(sk, line);
  return g?.type === "line" ? [pointAt(sk, g.a), pointAt(sk, g.b)] : null;
}

/** Mirror the selection across a line (an axis or a line of the sketch), holding the copy symmetric to the original (which is all it needs: its own relations follow). */
export function mirrorGeometry(sk: Geo, ids: Id[], line: Id): string | undefined {
  const axis = axisOf(sk, line);
  if (!axis) return "Pick a line to mirror across.";
  const [A, B] = axis;
  const len = dist(A, B);
  if (len < 1e-9) return "That line has no length.";
  const u: Vec2 = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
  const side = (p: Vec2) => (p[0] - A[0]) * -u[1] + (p[1] - A[1]) * u[0];
  const reflect = (p: Vec2): Vec2 => {
    const d = side(p);
    return [p[0] - 2 * d * -u[1], p[1] - 2 * d * u[0]];
  };
  const sel = ids.filter((i) => i !== line);
  const res = copyThrough(sk, sel, reflect, { flip: true, relations: false, keep: (_id, p) => Math.abs(side(p)) < 1e-6 });
  if (!res) return "Select the geometry to mirror first.";
  for (const [from, to] of res.map) {
    if (from !== to && geomType(sk, from) === "point") addConstraint(sk, "symmetric", [from, to, line]);
  }
  return undefined;
}

/** Copies in a row: `count` in total, each `dx`/`dy` from the last (mm). */
export function linearPattern(sk: Geo, ids: Id[], count: number, dx: number, dy: number): string | undefined {
  if (count < 2) return "A pattern needs at least two copies.";
  if (Math.abs(dx) + Math.abs(dy) < 1e-9) return "The copies need a gap between them.";
  for (let i = 1; i < count; i++) if (!copyThrough(sk, ids, ([x, y]) => [x + dx * i, y + dy * i])) return "Select the geometry to repeat first.";
  return undefined;
}

/** Copies evenly round a centre: `count` in total over `sweep` degrees (360 closes the circle). */
export function circularPattern(sk: Geo, ids: Id[], count: number, centre: Vec2 = [0, 0], sweep = 360): string | undefined {
  if (count < 2) return "A pattern needs at least two copies.";
  const step = (sweep / (Math.abs(sweep) >= 360 ? count : count - 1)) * (Math.PI / 180);
  for (let i = 1; i < count; i++) {
    const c = Math.cos(step * i);
    const s = Math.sin(step * i);
    if (!copyThrough(sk, ids, (p) => [centre[0] + (p[0] - centre[0]) * c - (p[1] - centre[1]) * s, centre[1] + (p[0] - centre[0]) * s + (p[1] - centre[1]) * c])) return "Select the geometry to repeat first.";
  }
  return undefined;
}

/** A grid of copies: `nx` columns by `ny` rows, `dx`/`dy` apart (the original is the first cell). */
export function rectPattern(sk: Geo, ids: Id[], nx: number, ny: number, dx: number, dy: number): string | undefined {
  if (nx < 1 || ny < 1 || nx * ny < 2) return "A pattern needs at least two cells.";
  if ((nx > 1 && Math.abs(dx) < 1e-9) || (ny > 1 && Math.abs(dy) < 1e-9)) return "The copies need a gap between them.";
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      if (i === 0 && j === 0) continue;
      if (!copyThrough(sk, ids, ([x, y]) => [x + dx * i, y + dy * j])) return "Select the geometry to repeat first.";
    }
  return undefined;
}

/** Move the selection by (dx, dy), or leave it and add a moved copy. */
export function moveGeometry(sk: Geo, ids: Id[], dx: number, dy: number, copy: boolean): string | undefined {
  if (Math.abs(dx) + Math.abs(dy) < 1e-9) return "The move distance must not be zero.";
  if (copy) return copyThrough(sk, ids, ([x, y]) => [x + dx, y + dy]) ? undefined : "Select the geometry to copy first.";
  const { points } = closure(sk, ids);
  if (!points.size) return "Select the geometry to move first.";
  for (const g of sk.geometry ?? []) {
    if (g.type === "point" && points.has(g.id)) {
      g.x += dx;
      g.y += dy;
    }
  }
  return undefined;
}

/** Scale the selection by `k` about `base`. Distances and radii that sit wholly inside it scale too. */
export function scaleGeometry(sk: Geo, ids: Id[], k: number, base: Vec2): string | undefined {
  if (!(k > 0) || Math.abs(k - 1) < 1e-9) return "Give a scale factor above zero and not 1.";
  const { curves, points } = closure(sk, ids);
  if (!points.size) return "Select the geometry to scale first.";
  for (const g of sk.geometry ?? []) {
    if (g.type === "point" && points.has(g.id)) {
      g.x = base[0] + (g.x - base[0]) * k;
      g.y = base[1] + (g.y - base[1]) * k;
    }
  }
  const inside = new Set<Id>([...points, ...curves.map((c) => c.id)]);
  for (const c of curves) if (c.type === "circle" || c.type === "ellipse") c.r *= k;
  for (const c of sk.constraints ?? []) {
    if ((c.type === "distance" || c.type === "radius" || c.type === "diameter") && c.value !== undefined && c.refs.every((r) => inside.has(r) || r === "origin")) c.value = `(${c.value})*${k}`;
  }
  return undefined;
}

/** Split a line where another line crosses it, so each half can be trimmed, moved or dimensioned on its own. */
export function breakLine(sk: Geo, lineId: Id, cutterId: Id): string | undefined {
  const g = geomById(sk, lineId);
  const h = geomById(sk, cutterId);
  if (g?.type !== "line" || h?.type !== "line") return "Pick the line to split, then the line that crosses it.";
  const [a, b, c, d] = [pointAt(sk, g.a), pointAt(sk, g.b), pointAt(sk, h.a), pointAt(sk, h.b)];
  const r: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const q: Vec2 = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * q[1] - r[1] * q[0];
  if (Math.abs(den) < 1e-12) return "Those lines are parallel.";
  const t = ((c[0] - a[0]) * q[1] - (c[1] - a[1]) * q[0]) / den;
  if (t < 1e-6 || t > 1 - 1e-6) return "The lines don't cross inside the first one.";
  const p = addPoint(sk, [a[0] + r[0] * t, a[1] + r[1] * t], g.construction);
  const second = uid("l");
  sk.geometry!.push({ id: second, type: "line", a: p, b: g.b, ...(g.construction ? { construction: true } : {}) });
  g.b = p;
  addConstraint(sk, "coincident", [p, cutterId]);
  for (const k of [...(sk.constraints ?? [])]) {
    if (k.refs.length === 1 && k.refs[0] === lineId && (k.type === "horizontal" || k.type === "vertical")) addConstraint(sk, k.type, [second]);
  }
  return undefined;
}

/* ───────────────────────── Offset ───────────────────────── */

type Line = Extract<SketchGeom, { type: "line" }>;
type Arc = Extract<SketchGeom, { type: "arc" }>;
interface Step {
  g: Line | Arc;
  from: Id;
  to: Id;
}

/** Order the selected lines and arcs into chains by their shared points. */
function chains(_sk: Geo, segs: (Line | Arc)[]): { steps: Step[]; closed: boolean }[] | string {
  const at = new Map<Id, (Line | Arc)[]>();
  for (const s of segs) for (const p of [s.a, s.b]) at.set(p, [...(at.get(p) ?? []), s]);
  for (const list of at.values()) if (list.length > 2) return "Offset can't follow a corner where more than two lines or arcs meet.";
  const used = new Set<Id>();
  const out: { steps: Step[]; closed: boolean }[] = [];
  const walk = (first: Line | Arc, start: Id) => {
    const steps: Step[] = [];
    let s: Line | Arc | undefined = first;
    let from = start;
    let closed = false;
    while (s && !used.has(s.id)) {
      used.add(s.id);
      const to: Id = s.a === from ? s.b : s.a;
      steps.push({ g: s, from, to });
      const next: (Line | Arc) | undefined = at.get(to)?.find((x) => x !== s);
      if (next && steps.length > 0 && next.id === first.id) closed = true;
      from = to;
      s = next;
    }
    out.push({ steps, closed: closed && steps.length > 1 });
  };
  // Open chains start at their free ends, loops anywhere.
  for (const s of segs) {
    for (const p of [s.a, s.b]) if (!used.has(s.id) && (at.get(p)?.length ?? 0) === 1) walk(s, p === s.a ? s.a : s.b);
  }
  for (const s of segs) if (!used.has(s.id)) walk(s, s.a);
  return out;
}

/**
 * The curve and every line or arc joined to it end to end (through shared points), so one click
 * picks a whole outline for Offset. A circle stands alone; construction geometry is left out.
 */
export function connectedCurves(sk: Geo, id: Id): Id[] {
  const start = geomById(sk, id);
  if (!start || start.construction || (start.type !== "line" && start.type !== "arc" && start.type !== "circle")) return [];
  if (start.type === "circle") return [id];
  const segs = (sk.geometry ?? []).filter((g): g is Line | Arc => (g.type === "line" || g.type === "arc") && !g.construction);
  const out = new Set<Id>([id]);
  const todo: (Line | Arc)[] = [start];
  while (todo.length) {
    const s = todo.pop()!;
    for (const t of segs) {
      if (out.has(t.id) || !(t.a === s.a || t.a === s.b || t.b === s.a || t.b === s.b)) continue;
      out.add(t.id);
      todo.push(t);
    }
  }
  return [...out];
}

type Curve = { type: "line"; a: Vec2; b: Vec2 } | { type: "circle"; c: Vec2; r: number };

/**
 * Offset lines, arcs and circles by `d` mm: positive grows closed shapes outward
 * and moves open chains to their left; negative the reverse. Lines stay parallel
 * to their originals and arcs concentric with theirs. With `value` (the distance as typed, a
 * positive length or formula) each new line also keeps that distance from its original, so the
 * copy follows when the original changes and the offset can be edited like any dimension.
 */
export function offsetGeometry(sk: Geo, ids: Id[], d: number, value?: string): string | undefined {
  if (Math.abs(d) < 1e-9) return "The offset distance must not be zero.";
  const sel = ids.map((i) => geomById(sk, i)).filter((g): g is SketchGeom => !!g && !g.construction);
  const circles = sel.filter((g): g is Extract<SketchGeom, { type: "circle" }> => g.type === "circle");
  const segs = sel.filter((g): g is Line | Arc => g.type === "line" || g.type === "arc");
  if (!circles.length && !segs.length) return "Select lines, arcs or circles to offset.";
  for (const c of circles) {
    if (c.r + d <= 1e-9) return `That would shrink the circle to nothing: the most it can shrink is ${c.r.toFixed(2)} mm.`;
  }
  const found = chains(sk, segs);
  if (typeof found === "string") return found;

  // Work out everything first, so a failure changes nothing.
  const plans: { step: Step; off: Curve; arcR?: number }[][] = [];
  const joints: Vec2[][] = [];
  for (const ch of found) {
    const rawPts = ch.steps.map((s) => pointAt(sk, s.from));
    // Which way is "outward": counter-clockwise loops have it on the right of travel.
    let area = 0;
    if (ch.closed) {
      const poly: Vec2[] = [];
      for (const s of ch.steps) {
        const a = pointAt(sk, s.from);
        poly.push(a);
        if (s.g.type === "arc") {
          const c = pointAt(sk, s.g.c);
          const pa = pointAt(sk, s.g.a);
          const pb = pointAt(sk, s.g.b);
          const a0 = Math.atan2(pa[1] - c[1], pa[0] - c[0]);
          let sw = Math.atan2(pb[1] - c[1], pb[0] - c[0]) - a0;
          sw = ((sw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          const dir = s.from === s.g.a ? 1 : -1;
          const mid = a0 + (dir === 1 ? sw / 2 : sw / 2);
          poly.push([c[0] + dist(c, pa) * Math.cos(mid), c[1] + dist(c, pa) * Math.sin(mid)]);
        }
      }
      area = poly.reduce((s, p, i) => s + (p[0] * poly[(i + 1) % poly.length]![1] - poly[(i + 1) % poly.length]![0] * p[1]), 0);
    }
    const left = ch.closed ? (area > 0 ? -d : d) : d;
    const plan = ch.steps.map((s) => {
      const A = pointAt(sk, s.from);
      const B = pointAt(sk, s.to);
      if (s.g.type === "line") {
        const l = dist(A, B) || 1;
        const n: Vec2 = [(-(B[1] - A[1]) / l) * left, ((B[0] - A[0]) / l) * left];
        return { step: s, off: { type: "line", a: [A[0] + n[0], A[1] + n[1]], b: [B[0] + n[0], B[1] + n[1]] } as Curve };
      }
      const c = pointAt(sk, s.g.c);
      const r = dist(c, pointAt(sk, s.g.a));
      const ccw = s.from === s.g.a;
      const r2 = ccw ? r - left : r + left;
      return { step: s, off: { type: "circle", c, r: r2 } as Curve, arcR: r2 };
    });
    if (plan.some((p) => p.arcR !== undefined && p.arcR <= 1e-9)) return "That would collapse an arc: use a smaller offset.";
    // Where consecutive offset curves meet (nearest to the original corner).
    const meet = (x: Curve, y: Curve, near: Vec2): Vec2 | null => {
      const pts = x.type === "line" ? (y.type === "line" ? lineLine(x.a, x.b, y.a, y.b) : lineCircle(x.a, x.b, y.c, y.r)) : y.type === "line" ? lineCircle(y.a, y.b, x.c, x.r) : circleCircle(x.c, x.r, y.c, y.r);
      return pts.sort((p, q) => dist(p, near) - dist(q, near))[0] ?? null;
    };
    const js: Vec2[] = [];
    const m = plan.length;
    for (let k = 0; k < (ch.closed ? m : m + 1); k++) {
      if (!ch.closed && (k === 0 || k === m)) {
        const p = plan[k === 0 ? 0 : m - 1]!;
        const o = p.off;
        const P = k === 0 ? rawPts[0]! : pointAt(sk, ch.steps[m - 1]!.to);
        if (o.type === "line") js.push(k === 0 ? o.a : o.b);
        else js.push([o.c[0] + ((P[0] - o.c[0]) / (dist(o.c, P) || 1)) * o.r, o.c[1] + ((P[1] - o.c[1]) / (dist(o.c, P) || 1)) * o.r]);
        continue;
      }
      const prev = plan[(k - 1 + m) % m]!;
      const cur = plan[k % m]!;
      const J = pointAt(sk, ch.steps[k % m]!.from);
      const hit = meet(prev.off, cur.off, J);
      if (!hit) return "Those lines don't meet after the offset: try a smaller distance.";
      js.push(hit);
    }
    plans.push(plan);
    joints.push(js);
  }

  for (const c of circles) {
    const id = uid("c");
    sk.geometry!.push({ id, type: "circle", c: c.c, r: c.r + d });
  }
  found.forEach((ch, ci) => {
    const js = joints[ci]!;
    const ids2 = js.map((p) => addPoint(sk, p));
    ch.steps.forEach((s, k) => {
      const p0 = ids2[k]!;
      const p1 = ids2[(k + 1) % ids2.length]!;
      if (s.g.type === "line") {
        const id = addLine(sk, p0, p1);
        addConstraint(sk, "parallel", [s.g.id, id]);
        if (value) addConstraint(sk, "distance", [s.g.id, id], value);
      } else {
        const ccw = s.from === s.g.a;
        sk.geometry!.push({ id: uid("a"), type: "arc", c: s.g.c, a: ccw ? p0 : p1, b: ccw ? p1 : p0 });
      }
    });
  });
  return undefined;
}

/** Copied sketch geometry with the relations among it, for pasting into this or another sketch. */
export interface GeometryClip {
  geometry: SketchGeom[];
  constraints: SketchConstraint[];
}

/** The selection (with its points) and the relations wholly inside it; ties to the sheet (Fix, the origin) stay behind. */
export function clipGeometry(sk: Geo, ids: Id[]): GeometryClip | null {
  const { curves, points } = closure(sk, ids);
  if (!points.size) return null;
  const inside = new Set<Id>([...points, ...curves.map((c) => c.id)]);
  const geometry = (sk.geometry ?? []).filter((g) => inside.has(g.id)).map((g) => (g.type === "point" ? { ...g, ...pointXY(sk, g.id) } : { ...g }));
  const constraints = (sk.constraints ?? []).filter((c) => c.type !== "fixed" && c.refs.every((r) => inside.has(r))).map((c) => ({ ...c, refs: [...c.refs] }));
  return { geometry, constraints };
}

const pointXY = (sk: Geo, id: Id) => {
  const [x, y] = pointAt(sk, id);
  return { x, y };
};

/** Paste a clip, moved by (dx, dy), under fresh ids. Returns the new curves (or points, when only points were copied). */
export function pasteGeometry(sk: Geo, clip: GeometryClip, dx: number, dy: number): Id[] {
  const ids = new Map<Id, Id>(clip.geometry.map((g) => [g.id, uid(g.id.replace(/[^a-z].*$/, "") || "g")]));
  const at = (id: Id) => ids.get(id)!;
  for (const g of clip.geometry) {
    const id = at(g.id);
    if (g.type === "point") (sk.geometry ??= []).push({ ...g, id, x: g.x + dx, y: g.y + dy });
    else if (g.type === "line") sk.geometry!.push({ ...g, id, a: at(g.a), b: at(g.b) });
    else if (g.type === "arc") sk.geometry!.push({ ...g, id, c: at(g.c), a: at(g.a), b: at(g.b) });
    else if (g.type === "ellipse") sk.geometry!.push({ ...g, id, c: at(g.c), a: at(g.a) });
    else if (g.type === "spline") sk.geometry!.push({ ...g, id, pts: g.pts.map(at) });
    else sk.geometry!.push({ ...g, id, c: at(g.c) });
  }
  for (const c of clip.constraints) (sk.constraints ??= []).push({ ...c, id: uid("k"), refs: c.refs.map(at) });
  const curves = clip.geometry.filter((g) => g.type !== "point");
  return (curves.length ? curves : clip.geometry).map((g) => at(g.id));
}
