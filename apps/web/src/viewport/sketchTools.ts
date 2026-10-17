/**
 * Sketch tool controller: turns pointer events on the sketch plane into
 * shapes. Every tool works with two clicks (or press-drag-release), snaps to
 * the grid, to existing points and to horizontal/vertical alignments, and
 * accepts typed dimensions (just start typing a number).
 */
import {
  type EntityType,
  type Evaluator,
  type GeomResolved,
  type Id,
  type ResolvedEntity,
  type SketchEntity,
  type Vec2,
  arcPoints,
  bsplineSamples,
  endTangent,
  entityOutline,
  entitySnapPoints,
  geomOutline,
  makeEntity,
  polylinePath,
  resolveEntity,
  tangentArcThrough,
} from "@whittle/core";
import type { SketchTool } from "../state/store";
import type { SketchPointerEvent } from "./Viewport";

export interface SnapInfo {
  p: Vec2;
  kind: "grid" | "end" | "mid" | "center" | "origin" | "align" | "free";
  /** The solver point (or "origin") snapped to: new geometry joins it instead of just touching it. */
  ref?: Id;
}

/** Tools that draw constraint-driven geometry. */
const GEOM_TOOLS = new Set<SketchTool>(["segment", "arc", "tarc", "carc", "conic", "pcircle", "spline", "earc", "tan2c", "tan3c"]);
/** Tools that take three clicks (the rest of the simple shapes take two). */
/** Counter-clockwise arc about `c` from `s`, ending on the ray toward `e`. */
function centerArc(c: Vec2, s: Vec2, e: Vec2): { start: Vec2; end: Vec2; through: Vec2 } | null {
  const r = Math.hypot(s[0] - c[0], s[1] - c[1]);
  if (r < 1e-6) return null;
  const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
  let sweep = Math.atan2(e[1] - c[1], e[0] - c[0]) - a0;
  while (sweep <= 1e-6) sweep += 2 * Math.PI;
  const at = (t: number): Vec2 => [c[0] + r * Math.cos(a0 + t), c[1] + r * Math.sin(a0 + t)];
  return { start: s, end: at(sweep), through: at(sweep / 2) };
}

/** Points on an ellipse arc: center, end of the major axis, a point giving the minor radius, then the arc's start and end (counter-clockwise). */
function ellipseArc(c: Vec2, m: Vec2, q: Vec2, s: Vec2, e: Vec2, n = 32): Vec2[] | null {
  const a = Math.hypot(m[0] - c[0], m[1] - c[1]);
  if (a < 1e-6) return null;
  const u: Vec2 = [(m[0] - c[0]) / a, (m[1] - c[1]) / a];
  const v: Vec2 = [-u[1], u[0]];
  const b = Math.abs((q[0] - c[0]) * v[0] + (q[1] - c[1]) * v[1]);
  if (b < 1e-6) return null;
  const param = (p: Vec2) => Math.atan2(((p[0] - c[0]) * v[0] + (p[1] - c[1]) * v[1]) / b, ((p[0] - c[0]) * u[0] + (p[1] - c[1]) * u[1]) / a);
  const t0 = param(s);
  let sweep = param(e) - t0;
  while (sweep <= 1e-6) sweep += 2 * Math.PI;
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + (sweep * i) / n;
    out.push([c[0] + a * Math.cos(t) * u[0] + b * Math.sin(t) * v[0], c[1] + a * Math.cos(t) * u[1] + b * Math.sin(t) * v[1]]);
  }
  return out;
}

/** A full ellipse from the same three points (for the preview). */
function ellipseFull(c: Vec2, m: Vec2, q: Vec2, n = 48): Vec2[] {
  const a = Math.hypot(m[0] - c[0], m[1] - c[1]);
  const u: Vec2 = a > 0 ? [(m[0] - c[0]) / a, (m[1] - c[1]) / a] : [1, 0];
  const v: Vec2 = [-u[1], u[0]];
  const b = Math.abs((q[0] - c[0]) * v[0] + (q[1] - c[1]) * v[1]);
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push([c[0] + a * Math.cos(t) * u[0] + b * Math.sin(t) * v[0], c[1] + a * Math.cos(t) * u[1] + b * Math.sin(t) * v[1]]);
  }
  return out;
}

/** Points on a conic from `s` to `e` whose tangents meet at `apex`; rho 0.5 is a parabola. */
function conicPoints(s: Vec2, e: Vec2, apex: Vec2, rho: number, n = 12): Vec2[] {
  const w = rho / (1 - rho);
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = (1 - t) * (1 - t);
    const b = 2 * w * t * (1 - t);
    const c = t * t;
    const k = a + b + c;
    out.push([(a * s[0] + b * apex[0] + c * e[0]) / k, (a * s[1] + b * apex[1] + c * e[1]) / k]);
  }
  return out;
}

const THREE_POINT = new Set<SketchTool>(["rect3", "circle3"]);

export interface DimField {
  key: "a" | "b";
  label: string;
  value: number;
  /** Anchor in sketch coordinates where the field is drawn. */
  at: Vec2;
}

export interface SketchUIState {
  preview: { pts: Vec2[]; closed: boolean }[];
  guides: [Vec2, Vec2][];
  snap: SnapInfo | null;
  dims: DimField[];
  hoverEntity: Id | null;
  cursor: Vec2 | null;
  /** What a click here would lock in (shown beside the cursor before the click). */
  hint: string | null;
  /** Rubber-band selection: drag right for window (fully inside), left for crossing (touching). */
  box: { a: Vec2; b: Vec2; crossing: boolean } | null;
  step: number; // 0 = waiting for first point
}

export interface SketchEnv {
  pixelSize(): number;
  gridSpacing(): number;
  entities(): SketchEntity[];
  evaluator(): Evaluator;
  /** Add a shape; `select` selects it and switches back to the Select tool. */
  add(e: SketchEntity, select?: boolean): void;
  select(id: Id | null): void;
  selected(): Id | null;
  move(id: Id, dx: number, dy: number, live: boolean): void;
  emit(s: SketchUIState): void;
  /** Constraint-driven geometry of the open sketch, at its solved positions. */
  geometry(): GeomResolved[];
  addLines(pts: (Vec2 | Id)[], closed: boolean): void;
  addArc(a: Vec2 | Id, b: Vec2 | Id, through: Vec2): void;
  /** An arc leaving the end of a line or arc smoothly, ending at the point. */
  addTangentArc(from: Id | undefined, to: Vec2): void;
  addCircle(c: Vec2 | Id, r: number): void;
  /** A circle tangent to the given curves, its center near the point. */
  addTangentCircle(refs: Id[], guess: Vec2): void;
  addSpline(pts: (Vec2 | Id)[], closed: boolean): void;
  addPoint(p: Vec2): void;
  /** The Project tool: pick the model under this window position and copy it into the sketch. */
  project(client: Vec2): void;
  /** The Dimension tool picked this geometry (`additive`: start a pair instead of measuring one item). */
  dimension(id: Id, additive: boolean, at?: Vec2): void;
  /** Fillet or chamfer the corner at this point. */
  corner(id: Id, kind: "fillet" | "chamfer", at?: Vec2): void;
  trim(id: Id, p: Vec2): void;
  extend(id: Id, p: Vec2): void;
  /** Turn a plain shape into constraint geometry so Dimension, Fillet, Trim and Extend can use it. */
  convert(id: Id): void;
  /** Select geometry (null clears); `additive` adds to / removes from the selection. */
  selectGeom(id: Id | null, additive: boolean): void;
  selectedGeom(): Id[];
  moveGeom(ids: Id[], dx: number, dy: number): void;
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

export class SketchController {
  private tool: SketchTool = "select";
  private points: Vec2[] = [];
  private cursor: Vec2 | null = null;
  private snap: SnapInfo | null = null;
  private guides: [Vec2, Vec2][] = [];
  private typed: { a?: number; b?: number } = {};
  /** Where the button went down on screen (pixels): tells a click from a drag without grid snapping in the way. */
  private downScreen: Vec2 | null = null;
  private dragging: { id: Id; last: Vec2; moved: boolean; geom?: Id[] } | null = null;
  /** Solver points the placed points snapped to (parallel to `points`). */
  private refs: (Id | undefined)[] = [];
  /** Tangent-circle tools: the curves picked so far. */
  private tanRefs: Id[] = [];
  private hoverEntity: Id | null = null;
  private erasing = false;
  private box: { a: Vec2; b: Vec2; additive: boolean } | null = null;
  private resolvedCache: ResolvedEntity[] = [];
  /** Outline/path tools: "arc" points (parallel to `points`), arc mode, and an arc's end awaiting its middle. */
  private arcFlags: boolean[] = [];
  private arcMode = false;
  private arcEnd: Vec2 | null = null;

  constructor(private env: SketchEnv) {}

  setTool(tool: SketchTool) {
    if (tool === this.tool) return;
    this.tool = tool;
    this.reset();
  }

  reset() {
    this.points = [];
    this.refs = [];
    this.tanRefs = [];
    this.arcFlags = [];
    this.arcMode = false;
    this.arcEnd = null;
    this.typed = {};
    this.downScreen = null;
    this.dragging = null;
    this.publish();
  }

  get busy() {
    return this.points.length > 0;
  }

  /** Whether the shape being drawn has size fields to type into. */
  get typable() {
    return this.dims().length > 0;
  }

  /** Typed dimension from the overlay input. */
  setTyped(key: "a" | "b", value: number | undefined) {
    this.typed[key] = value;
    this.publish();
  }

  private resolved(): ResolvedEntity[] {
    const ev = this.env.evaluator();
    const out: ResolvedEntity[] = [];
    for (const e of this.env.entities()) {
      try {
        out.push(resolveEntity(e, ev));
      } catch {
        /* invalid entities are skipped for snapping */
      }
    }
    this.resolvedCache = out;
    return out;
  }

  /* ───────────────────────── Snapping ───────────────────────── */

  private snapPoint(raw: Vec2, free: boolean): SnapInfo {
    if (free) return { p: raw, kind: "free" };
    const px = this.env.pixelSize();
    const tol = 10 * px;
    let best: SnapInfo | null = null;
    let bestD = tol;
    const cands: SnapInfo[] = [{ p: [0, 0], kind: "origin", ref: "origin" }];
    // Solver points first, so geometry joins them rather than just landing on them.
    const moving = new Set(this.dragging?.geom ?? []);
    for (const g of this.env.geometry()) {
      if (g.type === "point" && !moving.has(g.id)) cands.push({ p: g.p, kind: g.construction ? "center" : "end", ref: g.id });
      if (g.type === "line" && !moving.has(g.id)) cands.push({ p: [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2], kind: "mid" });
    }
    for (const r of this.resolved()) {
      if (this.dragging && r.id === this.dragging.id) continue;
      for (const s of entitySnapPoints(r)) cands.push({ p: s.p, kind: s.kind });
    }
    // A rectangle's second corner must not lock onto the first one's row or column (that makes it flat).
    const skipFirst = (this.tool === "rect" || this.tool === "crect" || this.tool === "ellipse") && this.points.length === 1;
    if (!skipFirst) this.points.forEach((p, i) => cands.push({ p, kind: "end", ref: this.refs[i] }));
    for (const c of cands) {
      const d = Math.hypot(c.p[0] - raw[0], c.p[1] - raw[1]);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    this.guides = [];
    if (best) return best;

    // Horizontal / vertical alignment with existing points, otherwise the grid.
    const atol = 6 * px;
    const alignX = cands.find((c) => Math.abs(c.p[0] - raw[0]) < atol);
    const alignY = cands.find((c) => Math.abs(c.p[1] - raw[1]) < atol);
    const g = this.env.gridSpacing() / 2;
    const x = alignX ? alignX.p[0] : Math.round(raw[0] / g) * g;
    const y = alignY ? alignY.p[1] : Math.round(raw[1] / g) * g;
    if (alignX) this.guides.push([alignX.p, [x, y]]);
    if (alignY) this.guides.push([alignY.p, [x, y]]);
    return { p: [x, y], kind: alignX || alignY ? "align" : "grid" };
  }

  /* ───────────────────────── Shape construction ───────────────────────── */

  /** The second point, adjusted by any typed dimensions. */
  private secondPoint(a: Vec2, b: Vec2): Vec2 {
    const t = this.typed;
    switch (this.tool) {
      case "rect": {
        const sx = Math.sign(b[0] - a[0]) || 1;
        const sy = Math.sign(b[1] - a[1]) || 1;
        return [t.a !== undefined ? a[0] + sx * t.a : b[0], t.b !== undefined ? a[1] + sy * t.b : b[1]];
      }
      case "crect": {
        const sx = Math.sign(b[0] - a[0]) || 1;
        const sy = Math.sign(b[1] - a[1]) || 1;
        return [t.a !== undefined ? a[0] + (sx * t.a) / 2 : b[0], t.b !== undefined ? a[1] + (sy * t.b) / 2 : b[1]];
      }
      case "circle2": {
        if (t.a === undefined) return b;
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) || 0;
        return [a[0] + t.a * Math.cos(ang), a[1] + t.a * Math.sin(ang)];
      }
      case "rect3": {
        if (t.a === undefined && t.b === undefined) return b;
        const len = t.a ?? Math.hypot(b[0] - a[0], b[1] - a[1]);
        const ang = t.b !== undefined ? (t.b * Math.PI) / 180 : Math.atan2(b[1] - a[1], b[0] - a[0]);
        return [a[0] + len * Math.cos(ang), a[1] + len * Math.sin(ang)];
      }
      case "ellipse": {
        const sx = Math.sign(b[0] - a[0]) || 1;
        const sy = Math.sign(b[1] - a[1]) || 1;
        return [t.a !== undefined ? a[0] + sx * t.a : b[0], t.b !== undefined ? a[1] + sy * t.b : b[1]];
      }
      case "circle":
      case "pcircle":
      case "gear":
      case "polygon": {
        const r = t.a !== undefined ? (this.tool === "polygon" ? t.a : t.a / 2) : null;
        if (r === null) return b;
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) || 0;
        return [a[0] + r * Math.cos(ang), a[1] + r * Math.sin(ang)];
      }
      case "slot":
      case "segment":
      case "path":
      case "polyline": {
        if (t.a === undefined && t.b === undefined) return b;
        const len = t.a ?? Math.hypot(b[0] - a[0], b[1] - a[1]);
        const ang = t.b !== undefined ? (t.b * Math.PI) / 180 : Math.atan2(b[1] - a[1], b[0] - a[0]);
        return [a[0] + len * Math.cos(ang), a[1] + len * Math.sin(ang)];
      }
      default:
        return b;
    }
  }

  private conicRho() {
    const t = this.typed.a;
    return t !== undefined && t > 0.01 && t < 0.99 ? t : 0.5;
  }

  private previewShapes(): { pts: Vec2[]; closed: boolean }[] {
    const c = this.cursor;
    if (!c || this.points.length === 0 || this.tool === "select" || this.tool === "text") return [];
    const a = this.points[0]!;
    if (this.tool === "segment") return [{ pts: [...this.points, this.secondPoint(this.points[this.points.length - 1]!, c)], closed: false }];
    if (this.tool === "spline") {
      const through = [...this.points, c];
      return through.length < 2 ? [] : [{ pts: geomOutline({ id: "", type: "spline", pts: through, closed: false, construction: false }), closed: false }];
    }
    if (this.tool === "earc") {
      if (this.points.length === 1) return [{ pts: [a, c], closed: false }];
      if (this.points.length === 2) return [{ pts: ellipseFull(a, this.points[1]!, c), closed: true }, { pts: [a, this.points[1]!], closed: false }];
      if (this.points.length === 3) return [{ pts: ellipseFull(a, this.points[1]!, this.points[2]!), closed: true }];
      const arc = ellipseArc(a, this.points[1]!, this.points[2]!, this.points[3]!, c, 32);
      return [{ pts: ellipseFull(a, this.points[1]!, this.points[2]!), closed: true }, ...(arc ? [{ pts: arc, closed: false }] : [])];
    }
    if (this.tool === "cspline") {
      const ctrl = [...this.points, c];
      return [{ pts: ctrl, closed: false }, ...(ctrl.length >= 3 ? [{ pts: bsplineSamples(ctrl, false, 12), closed: false }] : [])];
    }
    if (this.tool === "pcircle") {
      const r = Math.hypot(this.secondPoint(a, c)[0] - a[0], this.secondPoint(a, c)[1] - a[1]);
      return r > 0 ? [{ pts: geomOutline({ id: "", type: "circle", c: a, r, construction: false }), closed: true }] : [];
    }
    if (this.tool === "tarc") {
      const geo = this.env.geometry();
      const t = endTangent(geo, a);
      const arc = t ? tangentArcThrough(a, t.dir, c) : null;
      return arc ? [{ pts: [...arcPoints(a, c, arc.through, 32), c], closed: false }] : [{ pts: [a, c], closed: false }];
    }
    if (this.tool === "conic") {
      if (this.points.length === 1) return [{ pts: [a, c], closed: false }];
      if (this.points.length === 2) return [{ pts: conicPoints(a, this.points[1]!, c, this.conicRho(), 24), closed: false }, { pts: [a, c, this.points[1]!], closed: false }];
    }
    if (this.tool === "carc") {
      if (this.points.length === 1) return [{ pts: [a, c], closed: false }];
      const arc = centerArc(a, this.points[1]!, c);
      return [{ pts: [a, this.points[1]!], closed: false }, ...(arc ? [{ pts: [...arcPoints(arc.start, arc.end, arc.through, 32), arc.end], closed: false }] : [])];
    }
    if (this.tool === "arc") {
      if (this.points.length === 1) return [{ pts: [a, c], closed: false }];
      return [{ pts: [...arcPoints(a, c, this.points[1]!, 32), this.points[1]!], closed: false }];
    }
    if (this.multi) {
      const last = this.points[this.points.length - 1]!;
      const done = polylinePath(this.points, this.arcFlags, false);
      const next = this.arcEnd ? polylinePath([last, c, this.arcEnd], [false, true, false], false) : [last, this.secondPoint(last, c)];
      return [{ pts: [...done, ...next.slice(1)], closed: false }];
    }
    if (THREE_POINT.has(this.tool)) {
      if (this.points.length === 1) return [{ pts: [a, this.tool === "rect3" ? this.secondPoint(a, c) : c], closed: false }];
      const e = this.build([a, this.points[1]!, this.tool === "rect3" ? this.thirdPoint(c) : c]);
      return e ? this.outlineOf(e) : [{ pts: [a, this.points[1]!, c], closed: false }];
    }
    const e = this.build([a, this.secondPoint(a, c)]);
    return e ? this.outlineOf(e) : [];
  }

  private outlineOf(e: SketchEntity): { pts: Vec2[]; closed: boolean }[] {
    try {
      return [{ pts: entityOutline(resolveEntity(e, this.env.evaluator())), closed: true }];
    } catch {
      return [];
    }
  }

  /** 3-point rectangle: the third point, with a typed height applied perpendicular to the first edge. */
  private thirdPoint(c: Vec2): Vec2 {
    const [p1, p2] = this.points as [Vec2, Vec2];
    if (this.typed.a === undefined) return c;
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) || 1;
    const n: Vec2 = [-(p2[1] - p1[1]) / len, (p2[0] - p1[0]) / len];
    const sign = (c[0] - p1[0]) * n[0] + (c[1] - p1[1]) * n[1] < 0 ? -1 : 1;
    return [p1[0] + sign * n[0] * this.typed.a, p1[1] + sign * n[1] * this.typed.a];
  }

  /** The finished shape for the points placed so far (null when degenerate). */
  private build(pts: Vec2[]): SketchEntity | null {
    const [a, b, c] = pts as [Vec2, Vec2, Vec2 | undefined];
    switch (this.tool) {
      case "crect": {
        const e = makeEntity("rect", a, b);
        if (e.type !== "rect") return null;
        e.x = fmt(a[0]);
        e.y = fmt(a[1]);
        e.w = fmt(2 * Math.abs(b[0] - a[0]));
        e.h = fmt(2 * Math.abs(b[1] - a[1]));
        e.anchor = "center";
        return e;
      }
      case "rect3": {
        if (!c) return null;
        const w = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n: Vec2 = [-(b[1] - a[1]) / (w || 1), (b[0] - a[0]) / (w || 1)];
        const d = (c[0] - a[0]) * n[0] + (c[1] - a[1]) * n[1];
        if (w < 1e-6 || Math.abs(d) < 1e-6) return null;
        const e = makeEntity("rect", a, b);
        if (e.type !== "rect") return null;
        e.x = fmt((a[0] + b[0]) / 2 + (n[0] * d) / 2);
        e.y = fmt((a[1] + b[1]) / 2 + (n[1] * d) / 2);
        e.w = fmt(w);
        e.h = fmt(Math.abs(d));
        e.anchor = "center";
        e.angle = fmt((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI);
        return e;
      }
      case "circle2": {
        const r = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
        if (r < 1e-6) return null;
        const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        return makeEntity("circle", m, [m[0] + r, m[1]]);
      }
      case "circle3": {
        if (!c) return null;
        const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
        if (Math.abs(d) < 1e-9) return null;
        const sq = (p: Vec2) => p[0] * p[0] + p[1] * p[1];
        const ux = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d;
        const uy = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d;
        return makeEntity("circle", [ux, uy], a);
      }
      case "polygonC": {
        // Circumscribed: the second point is the middle of an edge, so the radius is the apothem.
        const e = makeEntity("polygon", a, b);
        if (e.type !== "polygon") return null;
        const half = Math.PI / 6;
        e.r = fmt(Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.cos(half));
        e.angle = fmt((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI - 30);
        return e;
      }
      case "polygonE": {
        // Edge polygon: the two points are one edge; the polygon grows to the left of a -> b.
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1e-6) return null;
        const R = len / (2 * Math.sin(Math.PI / 6));
        const apo = R * Math.cos(Math.PI / 6);
        const c: Vec2 = [(a[0] + b[0]) / 2 - ((b[1] - a[1]) / len) * apo, (a[1] + b[1]) / 2 + ((b[0] - a[0]) / len) * apo];
        const e = makeEntity("polygon", c, a);
        if (e.type !== "polygon") return null;
        e.r = fmt(R);
        return e;
      }
      default:
        return makeEntity(this.tool as EntityType, a, b);
    }
  }

  private dims(): DimField[] {
    const c = this.cursor;
    if (!c || this.points.length === 0) return [];
    if (this.tool === "rect3" && this.points.length === 2) {
      const [p1, p2] = this.points as [Vec2, Vec2];
      const p3 = this.thirdPoint(c);
      const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) || 1;
      const h = Math.abs(((p3[0] - p1[0]) * -(p2[1] - p1[1]) + (p3[1] - p1[1]) * (p2[0] - p1[0])) / len);
      return [{ key: "a", label: "H", value: h, at: p3 }];
    }
    if (this.tool === "circle3") return [];
    if (this.tool === "conic") return this.points.length === 2 ? [{ key: "a", label: "ρ", value: this.conicRho(), at: c }] : [];
    const a = this.multi || this.tool === "segment" ? this.points[this.points.length - 1]! : this.points[0]!;
    const b = this.secondPoint(a, c);
    switch (this.tool) {
      case "rect":
        return [
          { key: "a", label: "W", value: Math.abs(b[0] - a[0]), at: [(a[0] + b[0]) / 2, Math.min(a[1], b[1])] },
          { key: "b", label: "H", value: Math.abs(b[1] - a[1]), at: [Math.max(a[0], b[0]), (a[1] + b[1]) / 2] },
        ];
      case "crect":
        return [
          { key: "a", label: "W", value: 2 * Math.abs(b[0] - a[0]), at: [(a[0] + b[0]) / 2, Math.min(a[1], b[1])] },
          { key: "b", label: "H", value: 2 * Math.abs(b[1] - a[1]), at: [Math.max(a[0], b[0]), (a[1] + b[1]) / 2] },
        ];
      case "circle2":
        return [{ key: "a", label: "\u00d8", value: Math.hypot(b[0] - a[0], b[1] - a[1]), at: b }];
      case "circle":
      case "pcircle":
        return [{ key: "a", label: "\u00d8", value: 2 * Math.hypot(b[0] - a[0], b[1] - a[1]), at: b }];
      case "gear":
        return [{ key: "a", label: "Pitch Ø", value: 2 * Math.hypot(b[0] - a[0], b[1] - a[1]), at: b }];
      case "ellipse":
        return [
          { key: "a", label: "RX", value: Math.abs(b[0] - a[0]), at: [(a[0] + b[0]) / 2, a[1]] },
          { key: "b", label: "RY", value: Math.abs(b[1] - a[1]), at: [a[0], (a[1] + b[1]) / 2] },
        ];
      case "polygon":
        return [{ key: "a", label: "R", value: Math.hypot(b[0] - a[0], b[1] - a[1]), at: b }];
      case "rect3":
      case "slot":
      case "segment":
      case "path":
      case "polyline": {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
        return [
          { key: "a", label: "L", value: len, at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] },
          { key: "b", label: "\u2220", value: ang, at: b },
        ];
      }
      default:
        return [];
    }
  }

  /** Feedforward badge: the rule a click would apply (snap target, or a straight horizontal/vertical run). */
  private hint(): string | null {
    const s = this.snap;
    if (!s || !this.cursor || this.tool === "select" || this.tool === "dimension") return null;
    const label = { end: "Endpoint", mid: "Midpoint", center: "Center", origin: "Origin", align: "Aligned" }[s.kind as string];
    const a = this.points[this.points.length - 1];
    if (a && s.kind !== "free") {
      const tol = 1e-6;
      if (Math.abs(this.cursor[1] - a[1]) < tol && Math.abs(this.cursor[0] - a[0]) > tol) return "Horizontal";
      if (Math.abs(this.cursor[0] - a[0]) < tol && Math.abs(this.cursor[1] - a[1]) > tol) return "Vertical";
    }
    return label ?? null;
  }

  private publish() {
    this.env.emit({
      preview: this.previewShapes(),
      guides: this.guides,
      snap: this.tool === "select" && !this.dragging ? null : this.snap,
      dims: this.dims(),
      hoverEntity: this.hoverEntity,
      cursor: this.cursor,
      hint: this.hint(),
      box: this.box ? { ...this.box, crossing: this.box.b[0] < this.box.a[0] } : null,
      step: this.points.length,
    });
  }

  private commitTwoPoint(b: Vec2) {
    const a = this.points[0]!;
    const end = this.secondPoint(a, b);
    if (Math.hypot(end[0] - a[0], end[1] - a[1]) < 1e-6) return;
    if ((this.tool === "rect" || this.tool === "crect" || this.tool === "ellipse") && (Math.abs(end[0] - a[0]) < 1e-6 || Math.abs(end[1] - a[1]) < 1e-6)) return;
    if (this.tool === "select" || this.multi || this.tool === "text") return;
    const e = this.build([a, end]);
    if (!e) return;
    this.env.add(e);
    this.points = [];
    this.typed = {};
  }

  /** A click with a three-point tool: the first two points are kept, the third finishes the shape. */
  private commitThreePoint(c: Vec2) {
    const [a, b] = this.points as [Vec2, Vec2];
    const e = this.build([a, b, this.tool === "rect3" ? this.thirdPoint(c) : c]);
    if (!e) return;
    this.env.add(e);
    this.points = [];
    this.typed = {};
  }

  /** Tools that place many points (outlines and open paths). */
  private get multi() {
    return this.tool === "polyline" || this.tool === "path" || this.tool === "cspline";
  }

  private commitPolyline() {
    const open = this.tool === "path" || this.tool === "cspline";
    if (this.points.length >= (this.tool === "cspline" ? 3 : open ? 2 : 3)) {
      const e = makeEntity("polyline", this.points[0]!, this.points[1]!);
      if (e.type === "polyline") {
        e.points = this.points.map(([x, y], i) => (this.arcFlags[i] ? [fmt(x), fmt(y), "arc"] : [fmt(x), fmt(y)]));
        if (open) e.open = true;
        if (this.tool === "cspline") e.ctrl = true;
      }
      this.env.add(e);
    }
    this.points = [];
    this.arcFlags = [];
    this.arcEnd = null;
    this.typed = {};
  }

  /** Outline/path in arc mode: the first click sets the arc's end, the second a point on the arc. */
  private arcClick(p: Vec2, first: Vec2 | undefined, nearFirst: boolean) {
    if (!this.arcEnd) {
      this.arcEnd = nearFirst && this.tool === "polyline" && this.points.length >= 2 ? first! : p;
      return;
    }
    const closing = this.arcEnd === first;
    this.points.push(p);
    this.arcFlags.push(true);
    if (closing) return this.commitPolyline();
    this.points.push(this.arcEnd);
    this.arcFlags.push(false);
    this.arcEnd = null;
  }

  /* ───────────────────────── Events ───────────────────────── */

  private entityAt(p: Vec2): Id | null {
    const tol = 7 * this.env.pixelSize();
    let best: { d: number; id: Id } | null = null;
    for (const r of this.resolvedCache.length ? this.resolvedCache : this.resolved()) {
      const pts = entityOutline(r, 48);
      const segs = r.type === "polyline" && r.open ? pts.length - 1 : pts.length;
      for (let i = 0; i < segs; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % pts.length]!;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
        const d = Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
        if (d < tol && (!best || d < best.d)) best = { d, id: r.id };
      }
    }
    return best?.id ?? null;
  }

  /** Constraint-driven geometry under the pointer: points first, then curves (and the origin and axes). */
  private geomAt(p: Vec2, curvesOnly = false): Id | null {
    const tol = 7 * this.env.pixelSize();
    const geo = this.env.geometry();
    const near = (q: Vec2) => Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (!curvesOnly) {
      let best: { d: number; id: Id } | null = near([0, 0]) < tol ? { d: near([0, 0]), id: "origin" } : null;
      for (const g of geo) if (g.type === "point" && near(g.p) < (best?.d ?? tol)) best = { d: near(g.p), id: g.id };
      if (best) return best.id;
    }
    let best: { d: number; id: Id } | null = null;
    for (const g of geo) {
      if (g.type === "point") continue;
      const pts = geomOutline(g, 96);
      for (let i = 0; i + 1 < pts.length; i++) {
        const d = segDist(p, pts[i]!, pts[i + 1]!);
        if (d < tol && (!best || d < best.d)) best = { d, id: g.id };
      }
    }
    if (best || curvesOnly) return best?.id ?? null;
    if (Math.abs(p[1]) < tol) return "xaxis";
    if (Math.abs(p[0]) < tol) return "yaxis";
    return null;
  }

  /** A click with the Line, Arc or Circle tool. */
  private geomClick() {
    const c = this.cursor!;
    const ref = this.snap?.ref;
    const tol = 10 * this.env.pixelSize();
    const near = (p: Vec2 | undefined) => !!p && Math.hypot(p[0] - c[0], p[1] - c[1]) < tol;
    const typed = this.typed.a !== undefined || this.typed.b !== undefined;
    if (this.tool === "segment") {
      const n = this.points.length;
      // Clicking the first point closes the outline; clicking the last point again finishes an open chain.
      if (n >= 3 && near(this.points[0])) return this.commitSegments(true);
      if (n >= 2 && near(this.points[n - 1])) return this.commitSegments(false);
      this.points.push(n ? this.secondPoint(this.points[n - 1]!, c) : c);
      this.refs.push(typed ? undefined : ref);
      this.typed = {};
      return;
    }
    if (this.tool === "tan2c" || this.tool === "tan3c") {
      const need = this.tool === "tan2c" ? 2 : 3;
      if (this.tanRefs.length < need) {
        const hit = this.geomAt(c, true);
        if (hit && !this.tanRefs.includes(hit)) {
          this.tanRefs.push(hit);
          this.points.push(c);
        }
        return;
      }
      this.env.addTangentCircle(this.tanRefs, c);
      this.reset();
      return;
    }
    if (this.tool === "spline") {
      // Click the first point to close (three or more); click the last point again, Enter or Esc to stop.
      const n = this.points.length;
      if (n >= 3 && near(this.points[0])) return this.commitSpline(true);
      if (n >= 2 && near(this.points[n - 1])) return this.commitSpline(false);
      this.points.push(c);
      this.refs.push(ref);
      this.typed = {};
      return;
    }
    const p = this.points.length ? this.secondPoint(this.points[0]!, c) : c;
    this.points.push(p);
    this.refs.push(typed ? undefined : ref);
    const at = (i: number) => this.refs[i] ?? this.points[i]!;
    if (this.tool === "pcircle" && this.points.length === 2) {
      this.env.addCircle(at(0), Math.hypot(p[0] - this.points[0]![0], p[1] - this.points[0]![1]));
      this.reset();
    } else if (this.tool === "tarc" && this.points.length === 2) {
      this.env.addTangentArc(this.refs[0], p);
      this.reset();
    } else if (this.tool === "conic" && this.points.length === 3) {
      // Start, end, apex; a typed value (0.01 to 0.99) sets rho.
      const [s0, e0, a0] = this.points as [Vec2, Vec2, Vec2];
      this.env.addSpline([s0, ...conicPoints(s0, e0, a0, this.conicRho()).slice(1, -1), e0], false);
      this.reset();
    } else if (this.tool === "carc" && this.points.length === 3) {
      // Center, start, then the end direction (counter-clockwise from the start).
      const [c0, s0, e0] = this.points as [Vec2, Vec2, Vec2];
      const arc = centerArc(c0, s0, e0);
      if (arc) this.env.addArc(arc.start, arc.end, arc.through);
      this.reset();
    } else if (this.tool === "earc" && this.points.length === 5) {
      // Center, end of the major axis, minor radius, then where the arc starts and ends.
      const [c0, m0, q0, s0, e0] = this.points as [Vec2, Vec2, Vec2, Vec2, Vec2];
      const pts = ellipseArc(c0, m0, q0, s0, e0, 24);
      if (pts) {
        const e = makeEntity("polyline", pts[0]!, pts[1]!);
        if (e.type === "polyline") {
          e.points = pts.map(([x, y]) => [fmt(x), fmt(y)]);
          e.open = true;
          e.smooth = true;
        }
        this.env.add(e);
      }
      this.reset();
    } else if (this.tool === "arc" && this.points.length === 3) {
      // Start, end, then a point the arc passes through.
      this.env.addArc(at(0), at(1), this.points[2]!);
      this.reset();
    }
    this.typed = {};
  }

  private commitSpline(closed: boolean) {
    if (this.points.length >= 2) this.env.addSpline(this.points.map((p, i) => this.refs[i] ?? p), closed && this.points.length >= 3);
    this.reset();
  }

  private commitSegments(closed: boolean) {
    if (this.points.length >= 2) this.env.addLines(this.points.map((p, i) => this.refs[i] ?? p), closed && this.points.length >= 3);
    this.reset();
  }

  pointer(e: SketchPointerEvent) {
    if (e.type === "leave") {
      // While drawing, keep the preview and its size fields where they were so they can be clicked and edited.
      if (!this.points.length) this.cursor = null;
      this.publish();
      return;
    }
    if (this.tool === "select") return this.selectPointer(e);
    if (this.tool === "trim" || this.tool === "extend") {
      this.cursor = e.p;
      this.snap = null;
      const hit = this.geomAt(e.p, true);
      const plain = hit ? null : this.entityAt(e.p);
      this.hoverEntity = hit ?? plain;
      // Press and drag across curves to erase them (or, with Shift, to extend them).
      if (e.type === "down") this.erasing = true;
      if (e.type === "up") this.erasing = false;
      if (hit && (e.type === "down" || (e.type === "move" && this.erasing))) this.env[e.shift ? (this.tool === "trim" ? "extend" : "trim") : this.tool](hit, e.p);
      else if (e.type === "down" && plain) this.env.convert(plain);
      this.publish();
      return;
    }
    if (this.tool === "project") {
      this.cursor = e.p;
      this.snap = null;
      if (e.type === "down") this.env.project(e.client);
      this.publish();
      return;
    }
    if (this.tool === "dimension") {
      this.cursor = e.p;
      this.snap = null;
      const plainHit = this.entityAt(e.p);
      // A drawn shape beats the origin axes it happens to cross: it is what the click was aimed at.
      const geom = this.geomAt(e.p);
      const hit = geom && !(plainHit && (geom === "xaxis" || geom === "yaxis" || geom === "origin")) ? geom : null;
      const plain = hit ? null : plainHit;
      this.hoverEntity = hit ?? plain;
      if (e.type === "down") {
        if (hit) this.env.dimension(hit, e.shift, e.screen);
        else if (plain) {
          // One click does it: the shape becomes lines and arcs, then the one under the pointer gets its dimension.
          this.env.convert(plain);
          const now = this.geomAt(e.p);
          if (now) this.env.dimension(now, e.shift, e.screen);
        }
      }
      this.publish();
      return;
    }
    if (this.tool === "sfillet" || this.tool === "schamfer") {
      this.cursor = e.p;
      this.snap = null;
      const hit = this.geomAt(e.p);
      const corner = hit && this.env.geometry().some((g) => g.id === hit && g.type === "point") ? hit : null;
      const plain = hit ? null : this.entityAt(e.p);
      this.hoverEntity = corner ?? plain;
      if (e.type === "down") {
        if (corner) this.env.corner(corner, this.tool === "sfillet" ? "fillet" : "chamfer", e.screen);
        else if (plain) this.env.convert(plain);
      }
      this.publish();
      return;
    }
    this.snap = this.snapPoint(e.p, e.alt);
    this.cursor = this.snap.p;
    if (this.tool === "gpoint") {
      if (e.type === "down" && !this.snap.ref) this.env.addPoint(this.cursor);
      this.publish();
      return;
    }
    if (GEOM_TOOLS.has(this.tool)) {
      if (this.tool === "tan2c" || this.tool === "tan3c") this.hoverEntity = this.tanRefs.length < (this.tool === "tan2c" ? 2 : 3) ? this.geomAt(e.p, true) : null;
      if (e.type === "down") this.geomClick();
      this.publish();
      return;
    }

    if (e.type === "down") {
      this.downScreen = e.screen;
      if (this.tool === "text") {
        // One click places the text; the panel then asks what it says.
        const size = Math.max(1, Math.round(this.env.gridSpacing()));
        const t = makeEntity("text", this.cursor, [this.cursor[0], this.cursor[1] + size]);
        this.env.add(t, true);
        this.publish();
        return;
      }
      if (this.multi) {
        const first = this.points[0];
        const last = this.points[this.points.length - 1];
        const tol = 10 * this.env.pixelSize();
        const near = (p: Vec2 | undefined) => !!p && Math.hypot(p[0] - this.cursor![0], p[1] - this.cursor![1]) < tol;
        // Outlines close on their first point; paths finish when the last point is clicked again.
        if (this.arcMode && this.points.length) {
          this.arcClick(this.cursor, first, near(first));
        } else if ((this.tool === "polyline" && this.points.length >= 3 && near(first)) || ((this.tool === "path" || this.tool === "cspline") && this.points.length >= (this.tool === "cspline" ? 3 : 2) && near(last))) {
          this.commitPolyline();
        } else {
          const last = this.points[this.points.length - 1];
          const p = last ? this.secondPoint(last, this.cursor) : this.cursor;
          this.points.push(p);
          this.arcFlags.push(false);
          this.typed = {};
        }
      } else if (this.points.length === 0) {
        this.points = [this.cursor];
      } else if (THREE_POINT.has(this.tool)) {
        if (this.points.length === 1) {
          this.points.push(this.secondPoint(this.points[0]!, this.cursor));
          this.typed = {};
        } else this.commitThreePoint(this.cursor);
      } else {
        this.commitTwoPoint(this.cursor);
      }
    } else if (e.type === "up") {
      // Press-drag-release also works for two-point tools.
      const d = this.downScreen;
      if (d && !this.multi && !THREE_POINT.has(this.tool) && this.points.length === 1) {
        // Real pointer travel, not snapped travel: a click that wobbles a pixel must stay a click.
        const moved = Math.hypot(d[0] - e.screen[0], d[1] - e.screen[1]) > 6;
        if (moved) this.commitTwoPoint(this.cursor);
      }
      this.downScreen = null;
    }
    this.publish();
  }

  private selectPointer(e: SketchPointerEvent) {
    this.cursor = e.p;
    if (e.type === "move") {
      if (this.dragging?.geom) {
        // Solver geometry moves freely; the constraints decide where it settles.
        const dx = e.p[0] - this.dragging.last[0];
        const dy = e.p[1] - this.dragging.last[1];
        if (Math.hypot(dx, dy) > 2 * this.env.pixelSize() || this.dragging.moved) {
          this.env.moveGeom(this.dragging.geom, dx, dy);
          this.dragging.last = e.p;
          this.dragging.moved = true;
        }
      } else if (this.dragging) {
        this.snap = this.snapPoint(e.p, e.alt);
        const p = this.snap.p;
        const dx = p[0] - this.dragging.last[0];
        const dy = p[1] - this.dragging.last[1];
        if (dx || dy) {
          this.env.move(this.dragging.id, dx, dy, true);
          this.dragging.last = p;
          this.dragging.moved = true;
        }
      } else if (this.box) {
        this.box.b = e.p;
      } else {
        this.resolvedCache = [];
        this.hoverEntity = this.geomAt(e.p) ?? this.entityAt(e.p);
      }
    } else if (e.type === "down") {
      const g = this.geomAt(e.p);
      if (g) {
        const sel = this.env.selectedGeom();
        // Pressing on something already selected keeps the selection, so several items drag together.
        if (e.shift || !sel.includes(g)) this.env.selectGeom(g, e.shift);
        this.env.select(null);
        const moving = this.env.selectedGeom().includes(g) && !e.shift ? this.env.selectedGeom() : [g];
        if (!["origin", "xaxis", "yaxis"].includes(g)) this.dragging = { id: g, last: e.p, moved: false, geom: moving };
        this.publish();
        return;
      }
      const hit = this.entityAt(e.p);
      this.env.select(hit);
      if (!e.shift || hit) this.env.selectGeom(null, false);
      if (hit) {
        const s = this.snapPoint(e.p, true);
        this.dragging = { id: hit, last: s.p, moved: false };
      } else this.box = { a: e.p, b: e.p, additive: e.shift };
    } else if (e.type === "up") {
      if (this.box) this.finishBox(this.box);
      this.box = null;
      this.dragging = null;
      this.resolvedCache = [];
    }
    this.publish();
  }

  /** Select the constraint geometry inside (window) or touching (crossing) the dragged rectangle. */
  private finishBox(box: { a: Vec2; b: Vec2; additive: boolean }) {
    const px = this.env.pixelSize();
    if (Math.hypot(box.b[0] - box.a[0], box.b[1] - box.a[1]) < 4 * px) return;
    const crossing = box.b[0] < box.a[0];
    const [x0, x1] = [Math.min(box.a[0], box.b[0]), Math.max(box.a[0], box.b[0])];
    const [y0, y1] = [Math.min(box.a[1], box.b[1]), Math.max(box.a[1], box.b[1])];
    const inside = (p: Vec2) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
    const ids: Id[] = [];
    for (const g of this.env.geometry()) {
      if (g.type === "point") {
        if (inside(g.p)) ids.push(g.id);
        continue;
      }
      const outline = geomOutline(g, 48);
      const dense: Vec2[] = [];
      for (let i = 0; i + 1 < outline.length; i++) for (let t = 0; t < 16; t++) dense.push([outline[i]![0] + ((outline[i + 1]![0] - outline[i]![0]) * t) / 16, outline[i]![1] + ((outline[i + 1]![1] - outline[i]![1]) * t) / 16]);
      if (outline.length) dense.push(outline[outline.length - 1]!);
      if (crossing ? dense.some(inside) : dense.length > 0 && dense.every(inside)) ids.push(g.id);
    }
    if (!box.additive) this.env.selectGeom(null, false);
    this.env.select(null);
    for (const id of ids) if (!this.env.selectedGeom().includes(id)) this.env.selectGeom(id, true);
  }

  /** Keyboard while sketching. Returns true when handled. */
  key(e: KeyboardEvent): boolean {
    // A toggles arcs while drawing an outline or path (the A shortcut picks the Path tool otherwise).
    if (this.multi && this.points.length && e.key.toLowerCase() === "a" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.arcMode = !this.arcMode;
      if (!this.arcMode) this.arcEnd = null;
      this.publish();
      return true;
    }
    if (this.tool === "segment" && this.points.length && (e.key === "Escape" || e.key === "Enter")) {
      this.commitSegments(false);
      return true;
    }
    if (this.tool === "spline" && this.points.length && (e.key === "Escape" || e.key === "Enter")) {
      this.commitSpline(false);
      return true;
    }
    if (GEOM_TOOLS.has(this.tool) && this.points.length && (e.key === "Escape" || e.key === "Backspace")) {
      if (e.key === "Escape") this.reset();
      else {
        this.points.pop();
        this.refs.pop();
        this.tanRefs.pop();
        this.publish();
      }
      return true;
    }
    if (e.key === "Escape") {
      if (this.points.length) {
        if (this.multi && this.points.length >= (this.tool === "path" ? 2 : 3)) this.commitPolyline();
        else this.reset();
        this.publish();
        return true;
      }
      return false;
    }
    if (e.key === "Enter" && this.multi && this.points.length >= (this.tool === "path" ? 2 : 3)) {
      this.commitPolyline();
      this.publish();
      return true;
    }
    if (e.key === "Enter" && this.points.length === 1 && this.cursor && !this.multi && !THREE_POINT.has(this.tool)) {
      this.commitTwoPoint(this.cursor);
      this.publish();
      return true;
    }
    if (e.key === "Backspace" && this.multi && this.points.length) {
      if (this.arcEnd) this.arcEnd = null;
      else {
        this.points.pop();
        this.arcFlags.pop();
        // An arc's middle point goes with its end.
        if (this.arcFlags[this.arcFlags.length - 1]) {
          this.points.pop();
          this.arcFlags.pop();
        }
      }
      this.publish();
      return true;
    }
    return false;
  }
}
function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
}
