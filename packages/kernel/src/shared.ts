/** Pieces of the build shared by the feature builders (build, extra, surface): errors, sketch outlines to drawings, placement helpers. */
import { type Evaluator, type Feature, type Id, type ResolvedEntity, type SketchFeature, type Vec3, entityOutline, polygonInside, chainSegments, crossesItself, splineBeziers, resolveEntity } from "@whittle/core";
import { BoundingBox, Blueprint, CompoundBlueprint, Drawing, Blueprints, Plane, type Face, type Shape3D, type Wire, getOC, draw, drawCircle, drawEllipse, drawPointsInterpolation, drawRoundedRectangle, drawText, iterTopo } from "replicad";
import type { FeatureFix, SketchFrame } from "./protocol";


import { cross, dot, norm } from "./refs";

/** Errors that carry a user-facing message (and optional fix). */
export class FeatureError extends Error {
  constructor(
    message: string,
    public readonly fix?: FeatureFix,
    public readonly warning = false,
  ) {
    super(message);
  }
}

export const FRIENDLY: Record<string, string> = {
  extrude: "The extrusion couldn't be built. Check that the sketch profile is closed and doesn't cross itself.",
  revolve: "The revolve couldn't be built. The profile must not cross the axis it spins around.",
  fillet: "The fillet couldn't be built. The radius is probably too large for the selected edges.",
  chamfer: "The chamfer couldn't be built. The distance is probably too large for the selected edges.",
  shell: "The shell couldn't be built. Try a smaller wall thickness, or pick different faces to open.",
  primitive: "The shape couldn't be built. Check that all sizes are greater than zero.",
  mirror: "The mirror couldn't be built.",
  pattern: "The pattern couldn't be built. Copies that don't touch can't be merged into one body.",
  sketch: "Two shapes in this sketch overlap in a way that can't be combined (often edges that only just touch). Nudge one of them slightly.",
  hole: "The holes couldn't be cut. Check that they sit on the face.",
  loft: "The loft couldn't be built. Profiles should face the same way and not cross each other.",
  move: "The body couldn't be moved.",
  combine: "The bodies couldn't be combined. Check that they touch or overlap.",
  import: "The file couldn't be imported. It may be damaged or use an unsupported variant.",
  sweep: "The sweep couldn't be built. Make the profile smaller than the tightest bend of the path, and place it at the path's start.",
  coil: "The coil couldn't be built. The section is probably too large for the pitch (turns would overlap).",
  split: "The body couldn't be split there. Move the plane so it crosses the body.",
  offset: "The body couldn't be offset by that much. Try a smaller distance; very small details limit how far a body can shrink.",
  scale: "The body couldn't be scaled.",
  draft: "The draft couldn't be applied. Only flat, cylindrical or conical faces can be drafted, and the angle must be small enough.",
};

export function describeError(f: Feature, e: unknown): string {
  if (e instanceof FeatureError) return e.message;
  if (
    e instanceof Error &&
    e.message &&
    !/^\d+$/.test(e.message) &&
    !/BRep|Standard_|StdFail|gp_|Cannot read|undefined|null|Bug in|Failed to|weird|algo/i.test(e.message)
  ) {
    return e.message;
  }
  return FRIENDLY[f.type] ?? "This feature couldn't be built.";
}

export function planeFromFrame(f: SketchFrame): Plane {
  return new Plane(f.origin, f.xDir, f.normal);
}

export const ORIGIN_FRAMES: Record<string, { xDir: Vec3; yDir: Vec3; normal: Vec3 }> = {
  XY: { xDir: [1, 0, 0], yDir: [0, 1, 0], normal: [0, 0, 1] },
  XZ: { xDir: [1, 0, 0], yDir: [0, 0, 1], normal: [0, -1, 0] },
  YZ: { xDir: [0, 1, 0], yDir: [0, 0, 1], normal: [1, 0, 0] },
};

export const deg = (rad: number) => (rad * 180) / Math.PI;

export function polyDrawing(pts: [number, number][]): Drawing {
  if (pts.length < 3) throw new FeatureError("A closed shape needs at least three points");
  let pen = draw(pts[0]);
  for (const p of pts.slice(1)) pen = pen.lineTo(p);
  return pen.close();
}

/** Lines, three-point arcs and splines through the points (closed or open). */
function penPath(pts: [number, number][], arcs: boolean[], closed: boolean, splines: boolean[] = []): Drawing {
  let pen = draw(pts[0]);
  for (const s of chainSegments(pts, arcs, closed, splines)) {
    if (s.kind === "arc") pen = pen.threePointsArcTo(s.b, s.mid);
    else if (s.kind === "spline" && s.through.length >= 3) for (const b of splineBeziers(s.through)) pen = pen.cubicBezierCurveTo(b.end, b.c1, b.c2);
    else {
      const to = s.kind === "line" ? s.b : s.through[s.through.length - 1]!;
      // The closing line back to the start is what close() draws.
      if (!(closed && to === pts[0])) pen = pen.lineTo(to);
    }
  }
  return closed ? pen.close() : pen.done();
}

/** Closed loops of points along a drawing's outlines (curves sampled), for 2D export. */
export function drawingLoops(d: Drawing, perCurve = 10): [number, number][][] {
  type Bp = { curves?: { firstParameter: number; lastParameter: number; geomType: string; value(t: number): [number, number] }[]; blueprints?: Bp[] };
  const loops = (bp: Bp): [number, number][][] => {
    if (!bp.curves) return (bp.blueprints ?? []).flatMap(loops);
    const out: [number, number][] = [];
    for (const c of bp.curves) {
      const n = c.geomType === "LINE" ? 1 : perCurve;
      for (let i = 0; i < n; i++) out.push(c.value(c.firstParameter + ((c.lastParameter - c.firstParameter) * i) / n));
    }
    return out.length >= 3 ? [out] : [];
  };
  // `blueprint` only gives a drawing of one outline; text has many, so read the shape it wraps.
  return loops((d as unknown as { innerShape: Bp }).innerShape);
}

export function entityDrawing(r: ResolvedEntity): Drawing {
  switch (r.type) {
    case "rect": {
      const d = drawRoundedRectangle(r.w, r.h, r.corner > 0 ? r.corner : 0).translate(r.x + r.w / 2, r.y + r.h / 2);
      return r.angle ? d.rotate(deg(r.angle), [r.x + r.w / 2, r.y + r.h / 2]) : d;
    }
    case "circle":
      return drawCircle(r.r).translate(r.cx, r.cy);
    case "ellipse": {
      const major = Math.max(r.rx, r.ry);
      const minor = Math.min(r.rx, r.ry);
      const base = major - minor < 1e-6 ? drawCircle(major) : drawEllipse(major, minor);
      const turn = deg(r.angle) + (r.ry > r.rx ? 90 : 0);
      return (turn ? base.rotate(turn) : base).translate(r.cx, r.cy);
    }
    case "polygon":
    case "gear":
      return polyDrawing(entityOutline(r));
    case "polyline": {
      if (r.ctrl && r.points.length >= 3) return drawPointsInterpolation(entityOutline(r), {}, { closeShape: !r.open });
      if (r.smooth && r.points.length >= 3) return drawPointsInterpolation(r.points, {}, { closeShape: true });
      const d = r.arcs.some(Boolean) || r.splines.some(Boolean) ? penPath(r.points, r.arcs, true, r.splines) : polyDrawing(r.points);
      if (r.corner > 0) {
        try {
          return d.fillet(r.corner);
        } catch {
          throw new FeatureError("The corner radius is too large for this outline.");
        }
      }
      return d;
    }
    case "text": {
      let d: Drawing;
      try {
        // drawText negates startX, so draw at the origin and place it ourselves.
        d = drawText(r.text, { startX: 0, startY: 0, fontSize: r.size, fontFamily: r.bold ? "bold" : "sans" }).translate(r.x, r.y);
      } catch {
        throw new FeatureError("The text font isn't loaded yet. Try again in a moment.");
      }
      return r.angle ? d.rotate(deg(r.angle), [r.x, r.y]) : d;
    }
    case "slot": {
      const c = Math.cos(r.angle);
      const s = Math.sin(r.angle);
      const half = r.length / 2;
      const rad = r.width / 2;
      const P = (x: number, y: number): [number, number] => [r.cx + x * c - y * s, r.cy + x * s + y * c];
      if (half <= 1e-9) return drawCircle(rad).translate(r.cx, r.cy);
      return draw(P(-half, -rad))
        .lineTo(P(half, -rad))
        .threePointsArcTo(P(half, rad), P(half + rad, 0))
        .lineTo(P(-half, rad))
        .threePointsArcTo(P(-half, -rad), P(-half - rad, 0))
        .close();
    }
  }
}

/** Number of separate places where a hole's outline touches its container. */
function touchCount(hole: [number, number][], outer: [number, number][], tol: number): number {
  const near = hole.map(([x, y]) => {
    let best = Infinity;
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      const [ax, ay] = outer[j]!;
      const [bx, by] = outer[i]!;
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(ax + dx * t - x, ay + dy * t - y));
    }
    return best <= tol;
  });
  let runs = 0;
  near.forEach((n, i) => n && !near[(i - 1 + near.length) % near.length] && runs++);
  return runs === 0 && near.every(Boolean) ? 1 : runs;
}

/** Warning for the last built sketch, if any (holes that would split it). */

/** Groups of shape numbers whose (slightly grown) bounding boxes chain together. */
function clusters(outlines: [number, number][][]): number[][] {
  const eps = 1e-3;
  const boxes = outlines.map((pts) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    return [x0 - eps, y0 - eps, x1 + eps, y1 + eps] as [number, number, number, number];
  });
  const parent = boxes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      if (a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, number[]>();
  boxes.forEach((_, i) => {
    const g = groups.get(find(i));
    if (g) g.push(i);
    else groups.set(find(i), [i]);
  });
  return [...groups.values()];
}

/** Several drawings that don't touch, as one drawing (no boolean work). */
function joinDrawings(parts: Drawing[]): Drawing {
  if (parts.length === 1) return parts[0]!;
  const blueprints = parts.flatMap((d) => {
    const inner = (d as unknown as { innerShape: unknown }).innerShape;
    return inner instanceof Blueprints ? inner.blueprints : [inner as Blueprint | CompoundBlueprint];
  });
  return new Drawing(new Blueprints(blueprints));
}

/** The fused outlines of one cluster with its holes (and gear bores) cut out; null when the cluster has no outline. */
function clusterDrawing(resolved: ResolvedEntity[], outlines: [number, number][][], isHole: boolean[], idx: number[], notes: SketchNotes): Drawing | null {
  let result = null as Drawing | null;
  for (const i of idx) {
    if (isHole[i]) continue;
    const d = entityDrawing(resolved[i]!);
    result = result ? result.fuse(d) : d;
  }
  if (!result) return null;
  const holes = idx.filter((i) => isHole[i]);
  for (const i of holes) {
    const container = idx.find((j) => j !== i && !isHole[j] && polygonInside(outlines[i]!, outlines[j]!));
    if (container !== undefined && touchCount(outlines[i]!, outlines[container]!, 1e-3) >= 2) {
      notes.warning = "A hole touches its outline in two places, which would split the shape in two. Make the hole slightly smaller (or the outline larger).";
    }
  }
  // The common case of one outline with many separate holes inside it is built as one face with inner loops;
  // anything more tangled (overlapping or touching holes, several outlines) is cut hole by hole.
  const outer = (result as unknown as { innerShape: unknown }).innerShape;
  const outers = idx.filter((i) => !isHole[i]);
  const separate =
    outers.length === 1 &&
    outer instanceof Blueprint &&
    holes.length > 1 &&
    clusters(holes.map((i) => outlines[i]!)).length === holes.length &&
    holes.every((i) => polygonInside(outlines[i]!, outlines[outers[0]!]!) && touchCount(outlines[i]!, outlines[outers[0]!]!, 1e-3) === 0);
  if (separate) {
    const loops = holes.map((i) => (entityDrawing(resolved[i]!) as unknown as { innerShape: unknown }).innerShape);
    if (loops.every((l) => l instanceof Blueprint)) result = new Drawing(new CompoundBlueprint([outer, ...(loops as Blueprint[])]));
    else for (const i of holes) result = result.cut(entityDrawing(resolved[i]!));
  } else {
    for (const i of holes) result = result.cut(entityDrawing(resolved[i]!));
  }
  // Gear bores are always holes in their own gear.
  for (const i of idx) {
    const r = resolved[i]!;
    if (r.type === "gear" && r.bore > 0) result = result.cut(drawCircle(r.bore / 2).translate(r.cx, r.cy));
  }
  return result;
}

/** Build the 2D profile of a sketch: outer shapes fused, inner shapes become holes. */
/** Something worth telling the person that building a sketch's outline found. */
export interface SketchNotes {
  warning?: string;
}

export function sketchDrawing(f: SketchFeature, ev: Evaluator, notes: SketchNotes = {}): Drawing | null {
  const resolved: ResolvedEntity[] = [];
  for (const e of f.entities) {
    try {
      const r = resolveEntity(e, ev);
      // Open paths guide sweeps; they never enclose material.
      if (!r.construction && !(r.type === "polyline" && r.open)) resolved.push(r);
    } catch (err) {
      throw new FeatureError(err instanceof Error ? err.message : String(err));
    }
  }
  if (resolved.length === 0) return null;
  const outlines = resolved.map((r) => entityOutline(r, 48));
  // A bow-tie outline would extrude into an invalid solid that the kernel doesn't flag, so refuse it here.
  resolved.forEach((r, i) => {
    if (r.type === "polyline" && !r.open && crossesItself(outlines[i]!)) {
      throw new FeatureError("An outline in this sketch crosses itself. Move its points so no edges cross.");
    }
  });
  const isHole = resolved.map((r, i) => {
    if (r.mode === "subtract") return true;
    if (r.mode === "add") return false;
    return resolved.some((_, j) => j !== i && polygonInside(outlines[i]!, outlines[j]!) && !polygonInside(outlines[j]!, outlines[i]!));
  });
  if (!isHole.includes(false)) throw new FeatureError("Every shape in this sketch is a hole. Add an outer shape.");
  // Shapes whose bounding boxes don't meet can't affect each other, so each cluster is combined on its own (the
  // boolean cost grows steeply with the number of shapes in one go) and the clusters are then placed side by side.
  const parts = clusters(outlines).map((idx) => clusterDrawing(resolved, outlines, isHole, idx, notes)).filter((d): d is Drawing => d !== null);
  if (parts.length === 1) return parts[0]!;
  return joinDrawings(parts);
}

/** The separate pieces of a drawing: each one outline with its holes. */
export function drawingPieces(d: Drawing): Drawing[] {
  const inner = (d as unknown as { innerShape: unknown }).innerShape;
  if (!inner) return [];
  if (inner instanceof Blueprints) return inner.blueprints.map((b) => new Drawing(b));
  return [d];
}

// ponytail: the arrangement costs a boolean per shape pair in a cluster; past this many shapes the cluster stays one region.
const REGION_LIMIT = 40;

/**
 * Every enclosed area of a sketch as its own region, the way the sketch reads on screen: a circle inside a
 * rectangle gives the ring and the disc, two overlapping circles give three pieces. Construction shapes and
 * open paths don't enclose anything. Null when the sketch has no closed shapes.
 */
export function sketchRegionDrawings(f: SketchFeature, ev: Evaluator): Drawing[] | null {
  const resolved: ResolvedEntity[] = [];
  for (const e of f.entities) {
    try {
      const r = resolveEntity(e, ev);
      if (!r.construction && !(r.type === "polyline" && r.open)) resolved.push(r);
    } catch {
      /* the sketch's own build reports it */
    }
  }
  if (!resolved.length) return null;
  const shape = (r: ResolvedEntity) => {
    const d = entityDrawing(r);
    return r.type === "gear" && r.bore > 0 ? d.cut(drawCircle(r.bore / 2).translate(r.cx, r.cy)) : d;
  };
  const outlines = resolved.map((r) => entityOutline(r, 48));
  const out: Drawing[] = [];
  for (const idx of clusters(outlines)) {
    if (idx.length > REGION_LIMIT) {
      out.push(...drawingPieces(idx.map((i) => shape(resolved[i]!)).reduce((a, b) => a.fuse(b))));
      continue;
    }
    let regions: Drawing[] = [];
    for (const i of idx) {
      const s = shape(resolved[i]!);
      const next: Drawing[] = [];
      let rest: Drawing | null = s;
      for (const r of regions) {
        if (r.boundingBox.isOut(s.boundingBox)) {
          next.push(r);
          continue;
        }
        next.push(...drawingPieces(r.intersect(s)), ...drawingPieces(r.cut(s)));
        if (rest) rest = drawingPieces(rest).length ? rest.cut(r) : null;
      }
      if (rest) next.push(...drawingPieces(rest));
      regions = next;
    }
    out.push(...regions);
  }
  return out.length ? out : null;
}

export function bodyForRefs(bodies: Map<Id, Shape3D>, bodyId: Id): Shape3D {
  const b = bodies.get(bodyId);
  if (!b) throw new FeatureError("The body this feature was applied to no longer exists. Re-pick the edges or faces.");
  return b;
}

/** Rotate a shape built along +Z so that +Z points along `dir`, then move it to `at`. */
export function orient(s: Shape3D, dir: Vec3, at: Vec3): Shape3D {
  const d = norm(dir);
  const c = dot([0, 0, 1], d);
  let out = s;
  if (c < 1 - 1e-9) {
    const axis: Vec3 = c < -1 + 1e-9 ? [1, 0, 0] : norm(cross([0, 0, 1], d));
    out = out.rotate(deg(Math.acos(Math.max(-1, Math.min(1, c)))), [0, 0, 0], axis);
  }
  return out.translate(at);
}

export const AXES: Record<"x" | "y" | "z", Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/**
 * A shape's bounding box. OpenCascade's tight ("optimal") box throws on some valid solids (a pattern of shelled boxes
 * fused together), which used to drop the whole body from the view; the standard box is a little looser but always works.
 */
export function shapeBounds(s: Shape3D | Face): [Vec3, Vec3] {
  try {
    return s.boundingBox.bounds as [Vec3, Vec3];
  } catch {
    const box = new BoundingBox();
    try {
      getOC().BRepBndLib.Add(s.wrapped, box.wrapped, true);
      return box.bounds as [Vec3, Vec3];
    } finally {
      box.delete();
    }
  }
}

export function boxCenter(s: Shape3D): Vec3 {
  const [a, b] = shapeBounds(s);
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

/** Does this shape contain a closed solid (rather than being only surfaces)? */
export function hasSolid(shape: Shape3D): boolean {
  for (const _ of iterTopo((shape as unknown as { wrapped: never }).wrapped, "solid")) return true;
  return false;
}

export type AnySketch = { wire?: Wire; outerSketch?: { wire: Wire }; innerSketches?: { wire: Wire }[]; sketches?: AnySketch[] };

/** The path a sweep follows: the sketch's first open line, else its first outline. */
export function sketchPath(f: SketchFeature, frame: SketchFrame, ev: Evaluator): Wire {
  const open = f.entities.find((e) => e.type === "polyline" && e.open);
  const e = open ?? f.entities.find((x) => !x.construction);
  if (!e) throw new FeatureError("The path sketch is empty. Draw a path (open line) or a shape in it.", undefined, true);
  const r = resolveEntity(e, ev);
  let d: Drawing;
  if (r.type === "polyline" && r.open) {
    if (r.points.length < 2) throw new FeatureError("The path needs at least two points.");
    if (r.ctrl && r.points.length >= 3) d = drawPointsInterpolation(entityOutline(r), {}, { closeShape: false });
    else if (r.smooth && r.points.length >= 3) d = drawPointsInterpolation(r.points, {}, { closeShape: false });
    else d = penPath(r.points, r.arcs, false, r.splines);
  } else d = entityDrawing(r);
  const placed = d.sketchOnPlane(planeFromFrame(frame)) as unknown as AnySketch;
  const w = placed.wire ?? placed.outerSketch?.wire ?? placed.sketches?.[0]?.wire;
  if (!w) throw new FeatureError("The path couldn't be read.");
  return w;
}

/** Merge coplanar faces / collinear edges left over by booleans. */
export function clean(s: Shape3D): Shape3D {
  try {
    return s.simplify();
  } catch {
    return s;
  }
}
