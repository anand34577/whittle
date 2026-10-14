/**
 * The regeneration engine. Walks the feature timeline, evaluates each feature
 * with OpenCascade (through replicad) and caches the state after every step,
 * keyed by a hash of everything that step depends on. Editing feature #12 of
 * 60 therefore only recomputes #12 onwards.
 *
 * A failing feature never breaks the whole model: it is reported with a
 * friendly message (and, where possible, a one-click fix) and later features
 * keep building on the last good state.
 */
import {
  type BodyOp,
  type Evaluator,
  type Feature,
  type HoleFeature,
  type Id,
  type ResolvedEntity,
  type SketchFeature,
  type Vec3,
  type WhittleDocument,
  activeEnd,
  createEvaluator,
  entityOutline,
  frameAxes,
  planeOrigin,
  polygonInside,
  resolveEntity,
} from "@whittle/core";
import {
  type Drawing,
  type Edge,
  type Face,
  Plane,
  type Shape3D,
  draw,
  drawCircle,
  drawEllipse,
  drawPointsInterpolation,
  drawRoundedRectangle,
  drawText,
  importSTEP,
  makeBox,
  makeCompound,
  makeCylinder,
  makeSphere,
  measureArea,
  measureShapeVolumeProperties,
} from "replicad";
import type { BodyResult, FeatureFix, FeatureStatus, RegenResult, SketchFrame } from "./protocol";
import { stlToShape } from "./stl";
import { add, cross, dot, edgeInfo, faceInfo, norm, resolveEdge, resolveFace, scale } from "./refs";

interface SketchBuilt {
  frame: SketchFrame;
  drawing: Drawing | null;
  error?: string;
  /** Triangles of the closed profile regions (world coordinates), for display. */
  fill?: Float32Array;
}

interface Snapshot {
  key: string;
  bodies: Map<Id, Shape3D>;
  sketches: Map<Id, SketchBuilt>;
  status: FeatureStatus;
}

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

const FRIENDLY: Record<string, string> = {
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
};

function describeError(f: Feature, e: unknown): string {
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

function planeFromFrame(f: SketchFrame): Plane {
  return new Plane(f.origin, f.xDir, f.normal);
}

const ORIGIN_FRAMES: Record<string, { xDir: Vec3; yDir: Vec3; normal: Vec3 }> = {
  XY: { xDir: [1, 0, 0], yDir: [0, 1, 0], normal: [0, 0, 1] },
  XZ: { xDir: [1, 0, 0], yDir: [0, 0, 1], normal: [0, -1, 0] },
  YZ: { xDir: [0, 1, 0], yDir: [0, 0, 1], normal: [1, 0, 0] },
};

const deg = (rad: number) => (rad * 180) / Math.PI;

function polyDrawing(pts: [number, number][]): Drawing {
  if (pts.length < 3) throw new FeatureError("A closed shape needs at least three points");
  let pen = draw(pts[0]);
  for (const p of pts.slice(1)) pen = pen.lineTo(p);
  return pen.close();
}

function entityDrawing(r: ResolvedEntity): Drawing {
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
      if (r.smooth && r.points.length >= 3) return drawPointsInterpolation(r.points, {}, { closeShape: true });
      const d = polyDrawing(r.points);
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
let sketchWarning: string | undefined;

/** Build the 2D profile of a sketch: outer shapes fused, inner shapes become holes. */
export function sketchDrawing(f: SketchFeature, ev: Evaluator): Drawing | null {
  sketchWarning = undefined;
  const resolved: ResolvedEntity[] = [];
  for (const e of f.entities) {
    try {
      const r = resolveEntity(e, ev);
      if (!r.construction) resolved.push(r);
    } catch (err) {
      throw new FeatureError(err instanceof Error ? err.message : String(err));
    }
  }
  if (resolved.length === 0) return null;
  const outlines = resolved.map((r) => entityOutline(r, 48));
  const isHole = resolved.map((r, i) => {
    if (r.mode === "subtract") return true;
    if (r.mode === "add") return false;
    return resolved.some((_, j) => j !== i && polygonInside(outlines[i]!, outlines[j]!) && !polygonInside(outlines[j]!, outlines[i]!));
  });
  let result = null as Drawing | null;
  resolved.forEach((r, i) => {
    if (isHole[i]) return;
    const d = entityDrawing(r);
    result = result ? result.fuse(d) : d;
  });
  if (!result) throw new FeatureError("Every shape in this sketch is a hole. Add an outer shape.");
  resolved.forEach((r, i) => {
    if (!isHole[i]) return;
    const container = resolved.findIndex((_, j) => j !== i && !isHole[j] && polygonInside(outlines[i]!, outlines[j]!));
    if (container >= 0 && touchCount(outlines[i]!, outlines[container]!, 1e-3) >= 2) {
      sketchWarning = "A hole touches its outline in two places, which would split the shape in two. Make the hole slightly smaller (or the outline larger).";
    }
    result = result!.cut(entityDrawing(r));
  });
  // Gear bores are always holes in their own gear.
  for (const r of resolved) {
    if (r.type === "gear" && r.bore > 0) result = result!.cut(drawCircle(r.bore / 2).translate(r.cx, r.cy));
  }
  return result;
}

function bboxOverlap(a: Shape3D, b: Shape3D): boolean {
  const [a0, a1] = a.boundingBox.bounds;
  const [b0, b1] = b.boundingBox.bounds;
  const eps = 1e-6;
  return a0[0] <= b1[0] + eps && b0[0] <= a1[0] + eps && a0[1] <= b1[1] + eps && b0[1] <= a1[1] + eps && a0[2] <= b1[2] + eps && b0[2] <= a1[2] + eps;
}

/** Merge coplanar faces / collinear edges left over by booleans. */
function clean(s: Shape3D): Shape3D {
  try {
    return s.simplify();
  } catch {
    return s;
  }
}

function lastBody(bodies: Map<Id, Shape3D>): Id | undefined {
  return [...bodies.keys()].pop();
}

/** Apply a body operation (new / join / cut / intersect) for a tool shape. */
function applyOp(bodies: Map<Id, Shape3D>, featureId: Id, op: BodyOp, target: Id | undefined, tool: Shape3D): string | undefined {
  if (op === "new") {
    bodies.set(featureId, tool);
    return;
  }
  if (bodies.size === 0) {
    if (op === "join") {
      bodies.set(featureId, tool);
      return "There was no body to join, so a new body was created.";
    }
    throw new FeatureError(op === "cut" ? "There's nothing to cut yet. Create a body first." : "There's nothing to intersect with yet.");
  }
  if (target && !bodies.has(target)) throw new FeatureError("The target body no longer exists. Pick another body.");
  if (op === "join") {
    const id = target ?? lastBody(bodies)!;
    bodies.set(id, clean(bodies.get(id)!.fuse(tool)));
    return;
  }
  const ids = target ? [target] : [...bodies.keys()];
  let touched = 0;
  for (const id of ids) {
    const body = bodies.get(id)!;
    if (!bboxOverlap(body, tool)) continue;
    touched++;
    bodies.set(id, clean(op === "cut" ? body.cut(tool) : body.intersect(tool)));
  }
  if (touched === 0) {
    throw new FeatureError(op === "cut" ? "The cut doesn't touch any body. Try flipping its direction." : "The shapes don't overlap.");
  }
  return;
}

function bodyForRefs(bodies: Map<Id, Shape3D>, bodyId: Id): Shape3D {
  const b = bodies.get(bodyId);
  if (!b) throw new FeatureError("The body this feature was applied to no longer exists. Re-pick the edges or faces.");
  return b;
}

/** A solid of revolution around +Z from z=0 to z=h, radius r1 at the bottom and r2 at the top. */
function frustumZ(r1: number, r2: number, h: number): Shape3D {
  const pts: [number, number][] = [[0, 0], [r1, 0]];
  if (r2 > 1e-6) pts.push([r2, h]);
  pts.push([0, h]);
  return polyDrawing(pts).sketchOnPlane("XZ").revolve([0, 0, 1]) as Shape3D;
}

function torusZ(major: number, minor: number): Shape3D {
  return drawCircle(minor).translate(major, 0).sketchOnPlane("XZ").revolve([0, 0, 1]) as Shape3D;
}

/** Rotate a shape built along +Z so that +Z points along `dir`, then move it to `at`. */
function orient(s: Shape3D, dir: Vec3, at: Vec3): Shape3D {
  const d = norm(dir);
  const c = dot([0, 0, 1], d);
  let out = s;
  if (c < 1 - 1e-9) {
    const axis: Vec3 = c < -1 + 1e-9 ? [1, 0, 0] : norm(cross([0, 0, 1], d));
    out = out.rotate(deg(Math.acos(Math.max(-1, Math.min(1, c)))), [0, 0, 0], axis);
  }
  return out.translate(at);
}

const AXES: Record<"x" | "y" | "z", Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

function boxCenter(s: Shape3D): Vec3 {
  const [a, b] = s.boundingBox.bounds;
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

export class Builder {
  private cache: Snapshot[] = [];
  /** Parsed imported files, keyed by feature id + content length + content head. */
  private imports = new Map<string, Shape3D>();
  private importErrors = new Map<string, string>();

  /** Parse any imported files the document needs (async, so done before regen). */
  async prepareImports(doc: WhittleDocument): Promise<void> {
    for (const f of doc.features) {
      if (f.type !== "import") continue;
      const key = importKey(f);
      if (this.imports.has(key) || this.importErrors.has(key)) continue;
      const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes]);
      try {
        this.imports.set(key, f.format === "step" ? ((await importSTEP(blob)) as Shape3D) : stlToShape(bytes));
      } catch (e) {
        this.importErrors.set(key, e instanceof Error && !/^\d+$/.test(e.message) ? e.message : FRIENDLY.import!);
      }
    }
  }

  regen(doc: WhittleDocument, quality: "preview" | "final", pickBefore?: Id): Omit<RegenResult, "seq"> {
    const t0 = performance.now();
    const { prev, statuses, rebuilt, end } = this.walk(doc);

    const bodies: BodyResult[] = [];
    for (const [id, shape] of prev.bodies) {
      try {
        bodies.push(meshBody(id, shape, quality));
      } catch (e) {
        statuses.push({ id, state: "error", message: "This body couldn't be displayed: " + String(e) });
      }
    }
    const sketches: SketchFrame[] = [];
    for (const f of doc.features.slice(0, end)) {
      if (f.type !== "sketch") continue;
      const s = prev.sketches.get(f.id);
      // Copy the fill: the cached array must survive being transferred to the UI.
      if (s) sketches.push({ ...s.frame, fill: s.fill ? s.fill.slice() : undefined });
    }
    let pickBodies: BodyResult[] | undefined;
    if (pickBefore) {
      const idx = doc.features.findIndex((f) => f.id === pickBefore);
      const before = idx > 0 ? this.cache[idx - 1] : undefined;
      pickBodies = [];
      for (const [id, shape] of before?.bodies ?? []) {
        try {
          pickBodies.push(meshBody(id, shape, "preview"));
        } catch {
          /* not pickable */
        }
      }
    }
    return { bodies, sketches, status: statuses, pickBodies, ms: performance.now() - t0, rebuilt };
  }

  /** The final body shapes of the active timeline (for export). */
  shapes(doc: WhittleDocument): Map<Id, Shape3D> {
    return this.walk(doc).prev.bodies;
  }

  /** Build the active timeline, reusing cached steps. */
  private walk(doc: WhittleDocument) {
    const ev = createEvaluator(doc.parameters, doc.units);
    const paramSig = JSON.stringify([...ev.params.entries()]) + doc.units;
    const end = activeEnd(doc);
    const statuses: FeatureStatus[] = [];

    let prev: Snapshot = {
      key: paramSig,
      bodies: new Map(),
      sketches: new Map(),
      status: { id: "", state: "ok" },
    };
    let rebuilt = 0;
    const nextCache: Snapshot[] = [];

    for (let i = 0; i < end; i++) {
      const f = doc.features[i]!;
      const key = prev.key + "|" + (f.type === "import" ? importKey(f) + f.scale + !!f.suppressed : JSON.stringify(f));
      const cached = this.cache[i];
      let snap: Snapshot;
      if (cached && cached.key === key) {
        snap = cached;
      } else {
        rebuilt++;
        snap = this.step(f, prev, ev, key);
      }
      nextCache.push(snap);
      statuses.push(snap.status);
      prev = snap;
    }
    for (let i = end; i < doc.features.length; i++) {
      statuses.push({ id: doc.features[i]!.id, state: "rolledback" });
    }
    this.cache = nextCache;
    return { prev, statuses, rebuilt, end };
  }

  private step(f: Feature, prev: Snapshot, ev: Evaluator, key: string): Snapshot {
    const bodies = new Map(prev.bodies);
    const sketches = new Map(prev.sketches);
    const t = performance.now();
    if (f.suppressed) {
      return { key, bodies, sketches, status: { id: f.id, state: "suppressed" } };
    }
    try {
      const warning = this.apply(f, bodies, sketches, ev);
      return {
        key,
        bodies,
        sketches,
        status: { id: f.id, state: warning ? "warning" : "ok", message: warning, ms: performance.now() - t },
      };
    } catch (e) {
      const fix = e instanceof FeatureError ? e.fix : undefined;
      const incomplete = e instanceof FeatureError && e.warning;
      return {
        key,
        bodies: new Map(prev.bodies),
        sketches,
        status: { id: f.id, state: incomplete ? "incomplete" : "error", message: describeError(f, e), fix, ms: performance.now() - t },
      };
    }
  }

  /** Mutates the body/sketch maps; returns a warning message, if any. */
  private apply(f: Feature, bodies: Map<Id, Shape3D>, sketches: Map<Id, SketchBuilt>, ev: Evaluator): string | undefined {
    switch (f.type) {
      case "sketch": {
        let frame: SketchFrame;
        let warning: string | undefined;
        const offset = ev.num(f.plane.offset, "length", "Offset");
        if (f.plane.kind === "origin") {
          const o = ORIGIN_FRAMES[f.plane.plane]!;
          frame = { id: f.id, origin: scale(o.normal, offset), xDir: o.xDir, yDir: o.yDir, normal: o.normal };
        } else {
          const body = bodyForRefs(bodies, f.plane.face.bodyId);
          const res = resolveFace(body, f.plane.face);
          if (!res) throw new FeatureError("The face this sketch was on is gone. Edit the sketch to pick a new plane.");
          if (res.item.geomType !== "PLANE") throw new FeatureError("Sketches need a flat face.");
          if (res.uncertain) warning = "The sketch face moved; please check it's still on the right face.";
          const info = faceInfo(res.item);
          const { xDir, yDir } = frameAxes(info.normal);
          frame = { id: f.id, origin: add(planeOrigin(info.center, info.normal), scale(info.normal, offset)), xDir, yDir, normal: info.normal };
        }
        let drawing: Drawing | null = null;
        let error: string | undefined;
        try {
          drawing = sketchDrawing(f, ev);
          warning ??= sketchWarning;
        } catch (e) {
          error = describeError(f, e);
        }
        sketches.set(f.id, { frame, drawing, error, fill: drawing ? profileFill(drawing, frame) : undefined });
        if (error) throw new FeatureError(error);
        return warning;
      }

      case "extrude":
      case "revolve": {
        const sk = sketches.get(f.sketch);
        if (!sk) throw new FeatureError("The sketch for this feature is missing or failed.");
        if (sk.error) throw new FeatureError("Its sketch has an error: " + sk.error);
        if (!sk.drawing) throw new FeatureError("The sketch has no closed shapes yet. Draw a rectangle or circle first.");
        let tool: Shape3D;
        if (f.type === "extrude") {
          const d = ev.num(f.distance, "length", "Distance");
          if (Math.abs(d) < 1e-6) throw new FeatureError("The distance can't be zero.");
          const sign = f.flip ? -1 : 1;
          let frame = sk.frame;
          let dist = d * sign;
          if (f.extent === "symmetric") {
            frame = { ...frame, origin: add(frame.origin, scale(frame.normal, -Math.abs(d) / 2)) };
            dist = Math.abs(d);
          }
          const sketch = sk.drawing.clone().sketchOnPlane(planeFromFrame(frame));
          tool = clean(sketch.extrude(dist) as Shape3D);
        } else {
          const angle = ev.num(f.angle, "angle", "Angle");
          if (Math.abs(angle) < 1e-6) throw new FeatureError("The angle can't be zero.");
          const d = Math.min(Math.abs(deg(angle)), 360) * Math.sign(angle);
          const axis = f.axis === "x" ? sk.frame.xDir : sk.frame.yDir;
          const sketch = sk.drawing.clone().sketchOnPlane(planeFromFrame(sk.frame));
          tool = clean(sketch.revolve(axis, { origin: sk.frame.origin, angle: d }) as Shape3D);
        }
        return applyOp(bodies, f.id, f.op, f.target, tool);
      }

      case "loft": {
        if (f.sketches.length < 2) throw new FeatureError("Pick at least two sketches to loft between.", undefined, true);
        const profiles = f.sketches.map((id, i) => {
          const sk = sketches.get(id);
          if (!sk) throw new FeatureError(`Profile ${i + 1} is missing. Re-pick the sketches.`);
          if (sk.error || !sk.drawing) throw new FeatureError(`Profile ${i + 1} has no valid closed shape.`);
          const s = sk.drawing.clone().sketchOnPlane(planeFromFrame(sk.frame));
          if (!("loftWith" in s) || "sketches" in s) throw new FeatureError(`Profile ${i + 1} must be a single closed shape (no holes or separate pieces).`);
          return s as unknown as { loftWith(o: unknown[], c: { ruled: boolean }): Shape3D };
        });
        const tool = clean(profiles[0]!.loftWith(profiles.slice(1), { ruled: f.ruled }));
        return applyOp(bodies, f.id, f.op, f.target, tool);
      }

      case "primitive": {
        const [px, py, pz] = f.position.map((p, i) => ev.num(p, "length", "XYZ"[i] + " position")) as Vec3;
        const r2 = () => ev.num(f.radius2 ?? "0", "length", f.shape === "torus" ? "Tube radius" : f.shape === "tube" ? "Inner radius" : "Top radius");
        let tool: Shape3D;
        switch (f.shape) {
          case "box": {
            const w = ev.num(f.width, "length", "Width");
            const d = ev.num(f.depth, "length", "Depth");
            const h = ev.num(f.height, "length", "Height");
            if (w <= 0 || d <= 0 || h <= 0) throw new FeatureError("Width, depth and height must all be greater than zero.");
            tool = makeBox([px - w / 2, py - d / 2, pz], [px + w / 2, py + d / 2, pz + h]);
            break;
          }
          case "cylinder": {
            const r = ev.num(f.radius, "length", "Radius");
            const h = ev.num(f.height, "length", "Height");
            if (r <= 0 || h <= 0) throw new FeatureError("Radius and height must be greater than zero.");
            tool = makeCylinder(r, h, [px, py, pz], [0, 0, 1]);
            break;
          }
          case "sphere": {
            const r = ev.num(f.radius, "length", "Radius");
            if (r <= 0) throw new FeatureError("The radius must be greater than zero.");
            tool = makeSphere(r).translate(px, py, pz + r);
            break;
          }
          case "cone": {
            const r = ev.num(f.radius, "length", "Bottom radius");
            const top = r2();
            const h = ev.num(f.height, "length", "Height");
            if (r <= 0 || h <= 0 || top < 0) throw new FeatureError("Radii and height must be positive.");
            if (Math.abs(r - top) < 1e-6) tool = makeCylinder(r, h, [px, py, pz], [0, 0, 1]);
            else tool = frustumZ(r, top, h).translate(px, py, pz);
            break;
          }
          case "torus": {
            const r = ev.num(f.radius, "length", "Ring radius");
            const t = r2();
            if (t <= 0 || r <= t) throw new FeatureError("The tube radius must be positive and smaller than the ring radius.");
            tool = torusZ(r, t).translate(px, py, pz + t);
            break;
          }
          case "tube": {
            const r = ev.num(f.radius, "length", "Outer radius");
            const inner = r2();
            const h = ev.num(f.height, "length", "Height");
            if (r <= 0 || h <= 0) throw new FeatureError("The outer radius and height must be greater than zero.");
            if (inner <= 0 || inner >= r) {
              throw new FeatureError("The inner radius must be positive and smaller than the outer radius.", inner >= r ? { label: `Use ${fmt(r * 0.8)} mm`, field: "radius2", value: fmt(r * 0.8) } : undefined);
            }
            tool = makeCylinder(r, h, [px, py, pz], [0, 0, 1]).cut(makeCylinder(inner, h + 2, [px, py, pz - 1], [0, 0, 1]));
            break;
          }
        }
        return applyOp(bodies, f.id, f.op, f.target, tool);
      }

      case "hole":
        return this.hole(f, bodies, ev);

      case "fillet":
      case "chamfer": {
        if (f.edges.length === 0) throw new FeatureError("Select one or more edges in the viewport.", undefined, true);
        const value = ev.num(f.type === "fillet" ? f.radius : f.distance, "length", f.type === "fillet" ? "Radius" : "Distance");
        if (value <= 0) throw new FeatureError("The size must be greater than zero.");
        let warning: string | undefined;
        const byBody = new Map<Id, Edge[]>();
        for (const ref of f.edges) {
          const body = bodyForRefs(bodies, ref.bodyId);
          const res = resolveEdge(body, ref);
          if (!res) throw new FeatureError("One of the selected edges no longer exists. Edit the feature to re-pick it.");
          if (res.uncertain) warning = "Some edges moved after an upstream change. Please check the selection.";
          const list = byBody.get(ref.bodyId) ?? [];
          list.push(res.item);
          byBody.set(ref.bodyId, list);
        }
        const run = (size: number): Map<Id, Shape3D> => {
          const out = new Map<Id, Shape3D>();
          for (const [id, edges] of byBody) {
            const body = bodies.get(id)!;
            const pickFn = (e: Edge) => (edges.some((x) => x.isSame(e)) ? size : null);
            out.set(id, f.type === "fillet" ? body.fillet(pickFn) : body.chamfer(pickFn));
          }
          return out;
        };
        try {
          for (const [id, s] of run(value)) bodies.set(id, s);
        } catch {
          const field = f.type === "fillet" ? "radius" : "distance";
          const fit = largestWorking(value, (v) => run(v));
          const what = f.type === "fillet" ? "fillet radius" : "chamfer distance";
          throw new FeatureError(
            fit
              ? `A ${fmt(value)} mm ${what} is too large for these edges. The largest that fits is about ${fmt(fit)} mm.`
              : `This ${what} can't be applied to the selected edges. Try a much smaller value or fewer edges.`,
            fit ? { label: `Use ${fmt(fit)} mm`, field, value: fmt(fit) } : undefined,
          );
        }
        return warning;
      }

      case "shell": {
        const t = ev.num(f.thickness, "length", "Thickness");
        if (t <= 0) throw new FeatureError("The wall thickness must be greater than zero.");
        if (f.faces.length === 0) throw new FeatureError("Pick at least one face to remove (the open side).", undefined, true);
        const bodyId = f.bodyId ?? f.faces[0]!.bodyId;
        const body = bodyForRefs(bodies, bodyId);
        let warning: string | undefined;
        const faces: Face[] = [];
        for (const ref of f.faces) {
          const res = resolveFace(body, ref);
          if (!res) throw new FeatureError("A face to open no longer exists. Edit the shell to re-pick it.");
          if (res.uncertain) warning = "A face moved after an upstream change. Please check the selection.";
          faces.push(res.item);
        }
        try {
          bodies.set(bodyId, body.shell(t, (finder) => finder.when(({ element }) => faces.some((x) => x.isSame(element)))));
        } catch {
          const fit = largestWorking(t, (v) => body.shell(v, (finder) => finder.when(({ element }) => faces.some((x) => x.isSame(element)))));
          throw new FeatureError(
            fit ? `A ${fmt(t)} mm wall is too thick for this body. About ${fmt(fit)} mm fits.` : FRIENDLY.shell!,
            fit ? { label: `Use ${fmt(fit)} mm`, field: "thickness", value: fmt(fit) } : undefined,
          );
        }
        return warning;
      }

      case "mirror": {
        const id = f.bodyId ?? lastBody(bodies);
        if (!id || !bodies.has(id)) throw new FeatureError("Pick a body to mirror.");
        const src = bodies.get(id)!;
        const copy = src.clone().mirror(f.plane);
        if (f.merge) {
          bodies.set(id, clean(src.fuse(copy)));
        } else bodies.set(f.id, copy);
        return;
      }

      case "pattern": {
        const id = f.bodyId ?? lastBody(bodies);
        if (!id || !bodies.has(id)) throw new FeatureError("Pick a body to pattern.");
        const count = ev.num(f.count, "count", "Count");
        if (count < 2 || count > 200) throw new FeatureError("The count must be between 2 and 200.");
        const src = bodies.get(id)!;
        const axis = AXES[f.axis];
        const copies: Shape3D[] = [];
        if (f.pattern === "linear") {
          const spacing = ev.num(f.spacing, "length", "Spacing");
          for (let i = 1; i < count; i++) copies.push(src.clone().translate(scale(axis, spacing * i)));
        } else {
          const total = deg(ev.num(f.angle, "angle", "Angle"));
          const full = Math.abs(Math.abs(total) - 360) < 1e-6;
          const stepDeg = full ? total / count : total / (count - 1);
          for (let i = 1; i < count; i++) copies.push(src.clone().rotate(stepDeg * i, [0, 0, 0], axis));
        }
        if (f.merge) {
          let acc = src;
          for (const c of copies) acc = acc.fuse(c);
          bodies.set(id, clean(acc));
        } else {
          bodies.set(f.id, makeCompound(copies) as Shape3D);
        }
        return;
      }

      case "move": {
        const id = f.bodyId ?? lastBody(bodies);
        if (!id || !bodies.has(id)) throw new FeatureError("Pick a body to move.");
        const src = bodies.get(id)!;
        const tr = f.translate.map((v, i) => ev.num(v, "length", "XYZ"[i]!)) as Vec3;
        const a = deg(ev.num(f.angle, "angle", "Angle"));
        let out = src.clone();
        if (Math.abs(a) > 1e-9) out = out.rotate(a, boxCenter(src), AXES[f.axis]);
        if (tr.some((v) => Math.abs(v) > 1e-12)) out = out.translate(tr);
        if (f.copy) bodies.set(f.id, out);
        else bodies.set(id, out);
        return;
      }

      case "combine": {
        const target = f.target;
        if (!target || !bodies.has(target)) throw new FeatureError("Pick the body to keep (the target).", undefined, true);
        const tools = f.tools.filter((t) => t !== target);
        if (tools.length === 0) throw new FeatureError("Pick one or more tool bodies.", undefined, true);
        let acc = bodies.get(target)!;
        for (const t of tools) {
          const tool = bodies.get(t);
          if (!tool) throw new FeatureError("A tool body no longer exists. Re-pick the tools.");
          acc = f.op === "join" ? acc.fuse(tool) : f.op === "cut" ? acc.cut(tool) : acc.intersect(tool);
        }
        bodies.set(target, clean(acc));
        if (!f.keepTools) for (const t of tools) bodies.delete(t);
        return;
      }

      case "import": {
        const shape = this.imports.get(importKey(f));
        if (!shape) throw new FeatureError(this.importErrors.get(importKey(f)) ?? FRIENDLY.import!);
        const s = ev.num(f.scale, "count", "Scale");
        if (s <= 0) throw new FeatureError("The scale must be greater than zero.");
        bodies.set(f.id, Math.abs(s - 1) > 1e-12 ? shape.clone().scale(s, [0, 0, 0]) : shape.clone());
        return;
      }
    }
  }

  private hole(f: HoleFeature, bodies: Map<Id, Shape3D>, ev: Evaluator): string | undefined {
    if (!f.face) throw new FeatureError("Click a flat face to place holes on.", undefined, true);
    if (f.points.length === 0) throw new FeatureError("Click on the face to place each hole.", undefined, true);
    const body = bodyForRefs(bodies, f.face.bodyId);
    const res = resolveFace(body, f.face);
    if (!res) throw new FeatureError("The face for these holes is gone. Edit the hole to pick a new face.");
    if (res.item.geomType !== "PLANE") throw new FeatureError("Holes need a flat face.");
    const warning = res.uncertain ? "The hole face moved; please check the holes are still in the right place." : undefined;
    const info = faceInfo(res.item);
    const { xDir, yDir } = frameAxes(info.normal);
    const down = scale(info.normal, -1);
    const d = ev.num(f.diameter, "length", "Diameter");
    if (d <= 0) throw new FeatureError("The hole diameter must be greater than zero.");
    const [b0, b1] = body.boundingBox.bounds;
    const span = Math.hypot(b1[0] - b0[0], b1[1] - b0[1], b1[2] - b0[2]) * 2 + 10;
    const depth = f.through ? span : ev.num(f.depth, "length", "Depth");
    if (depth <= 0) throw new FeatureError("The hole depth must be greater than zero.");
    let headD = 0;
    let headDepth = 0;
    if (f.style !== "simple") {
      headD = ev.num(f.headDiameter, "length", "Head diameter");
      if (headD <= d) {
        throw new FeatureError("The head diameter must be larger than the hole.", { label: `Use ${fmt(d * 1.8)} mm`, field: "headDiameter", value: fmt(d * 1.8) });
      }
      headDepth = f.style === "counterbore" ? ev.num(f.headDepth, "length", "Head depth") : (headD - d) / 2;
      if (headDepth <= 0) throw new FeatureError("The head depth must be greater than zero.");
    }
    const lift = 0.02;
    const missed: number[] = [];
    let out = body;
    for (const [i, [xe, ye]] of f.points.entries()) {
      const x = ev.num(xe, "length", `Hole ${i + 1} X`);
      const y = ev.num(ye, "length", `Hole ${i + 1} Y`);
      const at = add(add(planeOrigin(info.center, info.normal), scale(xDir, x)), scale(yDir, y));
      const top = add(at, scale(info.normal, lift));
      let tool: Shape3D = makeCylinder(d / 2, depth + lift, top, down);
      if (f.style === "counterbore") tool = tool.fuse(makeCylinder(headD / 2, headDepth + lift, top, down));
      if (f.style === "countersink") tool = tool.fuse(orient(frustumZ(headD / 2 + lift, d / 2, headDepth + lift), down, top));
      const before = out.faces.length;
      out = out.cut(tool);
      if (out.faces.length === before) missed.push(i + 1);
    }
    bodies.set(f.face.bodyId, clean(out));
    if (missed.length) {
      return `Hole${missed.length > 1 ? "s" : ""} ${missed.join(", ")} ${missed.length > 1 ? "are" : "is"} off the body, so nothing was drilled there. Check the X and Y positions.`;
    }
    return warning;
  }
}

function importKey(f: { id: Id; data: string }): string {
  return `${f.id}:${f.data.length}:${f.data.slice(0, 64)}:${f.data.slice(-64)}`;
}

/** Triangulate a sketch's closed regions for the translucent profile fill. */
function profileFill(drawing: Drawing, frame: SketchFrame): Float32Array | undefined {
  try {
    const sk = drawing.clone().sketchOnPlane(planeFromFrame(frame)) as unknown as { faces?: () => Shape3D; face?: () => Shape3D };
    const shape = sk.faces ? sk.faces() : sk.face!();
    const m = shape.mesh({ tolerance: 0.05, angularTolerance: 0.3 });
    const out = new Float32Array(m.triangles.length * 3);
    m.triangles.forEach((vi, k) => {
      out[k * 3] = m.vertices[vi * 3]!;
      out[k * 3 + 1] = m.vertices[vi * 3 + 1]!;
      out[k * 3 + 2] = m.vertices[vi * 3 + 2]!;
    });
    return out;
  } catch {
    return undefined;
  }
}

const fmt = (v: number) => String(Math.round(v * 100) / 100);

/** Find (roughly) the largest value below `start` for which `attempt` succeeds. */
function largestWorking(start: number, attempt: (v: number) => unknown): number | null {
  let lo: number | null = null;
  let hi = start;
  for (const k of [0.9, 0.75, 0.5, 0.25, 0.1]) {
    try {
      attempt(start * k);
      lo = start * k;
      break;
    } catch {
      hi = start * k;
    }
  }
  if (lo === null) return null;
  let good: number = lo;
  for (let i = 0; i < 4; i++) {
    const mid: number = (good + hi) / 2;
    try {
      attempt(mid);
      good = mid;
    } catch {
      hi = mid;
    }
  }
  const v = Math.floor(good * 0.98 * 100) / 100;
  return v > 0 ? v : null;
}

function meshBody(id: Id, shape: Shape3D, quality: "preview" | "final"): BodyResult {
  const [min, max] = shape.boundingBox.bounds;
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  const tolerance = Math.max(0.005, diag * (quality === "final" ? 0.0004 : 0.0015));
  const angularTolerance = quality === "final" ? 0.15 : 0.3;
  const m = shape.mesh({ tolerance, angularTolerance });
  const e = shape.meshEdges({ tolerance, angularTolerance });
  const faces = shape.faces;
  const edges = shape.edges;

  const faceRanges = new Int32Array(m.faceGroups.length * 2);
  m.faceGroups.forEach((g, i) => {
    faceRanges[i * 2] = g.start;
    faceRanges[i * 2 + 1] = g.count;
  });
  const edgeRanges = new Int32Array(e.edgeGroups.length * 2);
  e.edgeGroups.forEach((g, i) => {
    edgeRanges[i * 2] = g.start;
    edgeRanges[i * 2 + 1] = g.count;
  });

  let volume = 0;
  let area = 0;
  let centerOfMass: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  try {
    const props = measureShapeVolumeProperties(shape);
    volume = props.volume;
    centerOfMass = props.centerOfMass;
    area = measureArea(shape);
  } catch {
    /* shells or compounds without volume */
  }
  return {
    id,
    positions: Float32Array.from(m.vertices),
    normals: Float32Array.from(m.normals),
    indices: Uint32Array.from(m.triangles),
    faceRanges,
    edgePositions: Float32Array.from(e.lines),
    edgeRanges,
    faces: faces.map(faceInfo),
    edges: edges.map(edgeInfo),
    volume,
    area,
    centerOfMass,
    bbox: [min, max],
  };
}
