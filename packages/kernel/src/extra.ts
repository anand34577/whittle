/** Rib, Thread, Replace/Delete Face, Align, Boundary Fill and Pattern on Path. */
import {
  type AlignFeature,
  type BoundaryFillFeature,
  type CurveFeature,
  type DeleteFaceFeature,
  entityOutline,
  type JointFeature,
  type WhittleDocument,
  frameAxes,
  type Evaluator,
  type Id,
  type PatternFeature,
  type ReplaceFaceFeature,
  type RibFeature,
  type SketchFeature,
  type ThreadFeature,
  type Vec3,
  resolveEntity,
} from "@whittle/core";
import {
  type Edge,
  type Face,
  type Shape3D,
  Plane,
  type Wire,
  assembleWire,
  basicFaceExtrusion,
  makeBSplineApproximation,
  makeLine,
  makeVertex,
  cast,
  downcast,
  getOC,
  genericSweep,
  makeBox,
  makeCompound,
  makeFace,
  makeHelix,
  makeSolid,
  measureShapeVolumeProperties,
} from "replicad";
import type { SketchFrame } from "./protocol";
import { FeatureError, bodyForRefs, boxCenter, clean, deg, orient, planeFromFrame, polyDrawing, sketchPath } from "./build";
import { circleOf } from "./construct";
import { add, cross, dist, dot, norm, resolveEdge, resolveFace, scale, sub } from "./refs";

type SketchLike = { frame: SketchFrame; source?: SketchFeature; error?: string; wire?: Wire };

const volume = (s: Shape3D) => measureShapeVolumeProperties(s).volume;

/** Join two touching bodies without merging coplanar faces, so faces stay split where they met. */
export function joinKeepingFaces(a: Shape3D, b: Shape3D): Shape3D {
  const oc = getOC();
  const builder = new oc.BRepAlgoAPI_Fuse(a.wrapped, b.wrapped);
  try {
    builder.Build();
    return cast(downcast(builder.Shape())) as Shape3D;
  } finally {
    builder.delete();
  }
}

/** The plane offset where a body is widest across (its parting line along that plane's normal). */
export function widestSection(body: Shape3D, plane: Parameters<Shape3D["split"]>[0]): number {
  const [lo, hi] = body.boundingBox.bounds;
  const reach = Math.max(...lo.map(Math.abs), ...hi.map(Math.abs)) * 1.0;
  const n = 40;
  const vols: { h: number; v: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const h = -reach + (2 * reach * i) / n;
    try {
      const parts = body.split(plane, h);
      const neg = parts.negative as Shape3D | null;
      vols.push({ h, v: neg ? volume(neg) : parts.positive ? 0 : volume(body) });
    } catch {
      /* plane misses the body */
    }
  }
  let best = { h: 0, area: -1 };
  for (let i = 1; i + 1 < vols.length; i++) {
    const area = (vols[i + 1]!.v - vols[i - 1]!.v) / (vols[i + 1]!.h - vols[i - 1]!.h);
    // Ignore planes that miss the body (volume constant 0 or total).
    if (vols[i - 1]!.v === vols[i + 1]!.v) continue;
    if (area > best.area) best = { h: vols[i]!.h, area };
  }
  if (best.area < 0) throw new FeatureError("The plane doesn't cross this body.");
  return best.h;
}

/** Cells of the last Boundary Fill per feature, for the editor. */
export const CELL_INFO = new Map<Id, { volume: number; center: Vec3 }[]>();

export function ribTool(f: RibFeature, sketches: Map<Id, SketchLike>, ev: Evaluator): Shape3D {
  const sk = sketches.get(f.sketch);
  if (!f.sketch || !sk?.source) throw new FeatureError("Pick the sketch with the rib's line.", undefined, true);
  const t = ev.num(f.thickness, "length", "Thickness");
  const d = ev.num(f.depth, "length", "Depth");
  if (t <= 0 || d <= 0) throw new FeatureError("The thickness and depth must be greater than zero.");
  const plane = planeFromFrame({ ...sk.frame, origin: add(sk.frame.origin, scale(sk.frame.normal, -t / 2)) });
  const side = f.flip ? -1 : 1;
  let out: Shape3D | null = null;
  for (const e of sk.source.entities) {
    if (e.type !== "polyline" || !e.open || e.construction) continue;
    const r = resolveEntity(e, ev);
    if (r.type !== "polyline") continue;
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i]!;
      const b = r.points[i + 1]!;
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l < 1e-9) continue;
      const m: [number, number] = [(-(b[1] - a[1]) / l) * d * side, ((b[0] - a[0]) / l) * d * side];
      const quad = polyDrawing([a, b, [b[0] + m[0], b[1] + m[1]], [a[0] + m[0], a[1] + m[1]]]);
      const piece = quad.sketchOnPlane(plane).extrude(t) as Shape3D;
      out = out ? out.fuse(piece) : piece;
    }
  }
  if (!out) throw new FeatureError("The rib needs an open line: draw one with the Path tool.", undefined, true);
  return clean(out);
}

/** Cut a helical groove along a cylindrical face (a rod or a hole). */
export function threadTool(f: ThreadFeature, bodies: Map<Id, Shape3D>, ev: Evaluator): string | undefined {
  if (!f.face) throw new FeatureError("Click the cylindrical face to thread.", undefined, true);
  const body = bodyForRefs(bodies, f.face.bodyId);
  const res = resolveFace(body, f.face);
  if (!res) throw new FeatureError("The face to thread is gone. Pick it again.");
  const face = res.item;
  if (face.geomType !== "CYLINDRE") throw new FeatureError("Threads go on round (cylindrical) faces: a rod or a hole.");
  const circles = face.edges.filter((e: Edge) => e.geomType === "CIRCLE").map((e: Edge) => circleOf(e)).filter((c): c is NonNullable<ReturnType<typeof circleOf>> => !!c);
  if (!circles.length) throw new FeatureError("This face has no circular end to measure from.");
  const r = circles[0]!.r;
  let start = circles[0]!.c;
  let dir = circles[0]!.n;
  let span = 0;
  if (circles.length >= 2) {
    const far = circles.reduce((a, c) => (dist(c.c, start) > dist(a.c, start) ? c : a), circles[1]!);
    span = dist(far.c, start);
    dir = norm(sub(far.c, start));
  } else if (f.length) span = ev.num(f.length, "length", "Length");
  if (span <= 0) throw new FeatureError("Set the thread length.");
  const pitch = ev.num(f.pitch, "length", "Pitch");
  if (pitch <= 0) throw new FeatureError("The pitch must be greater than zero.");
  const depth = f.depth ? ev.num(f.depth, "length", "Depth") : pitch * 0.6134;
  if (depth <= 0 || depth >= r) throw new FeatureError("The thread depth must be positive and smaller than the radius.");
  const len = Math.min(f.length ? ev.num(f.length, "length", "Length") : span, span);
  if (len / pitch > 300) throw new FeatureError("That's more than 300 turns. Use a larger pitch or a shorter length.");
  // External when the face's outward normal points away from the axis.
  const p = face.pointOnSurface(0.5, 0.5);
  const pn = face.normalAt(p).toTuple();
  const pt = p.toTuple();
  const rel = sub(pt, start);
  const radial = sub(rel, scale(dir, dot(rel, dir)));
  const external = dot(pn, radial) > 0;
  const full = len >= span - 1e-6;
  const over = pitch * 0.6;
  const z0 = full ? -over : 0;
  const height = len + (full ? 2 * over : 0);
  const v0 = volume(body);
  // Boolean cuts with a helix are fussy where it crosses the end faces, so try a few variants.
  const attempts: [number, boolean][] = [[0.4, true], [0.15, true], [0.15, false], [0.7, true]];
  for (const [ovf, clip] of attempts) {
    try {
      const ov = depth * ovf;
      const w = Math.min(2 * (depth + ov) * Math.tan(Math.PI / 6), pitch * 0.7);
      const pts: [number, number][] = external ? [[ov, -w / 2], [-depth, 0], [ov, w / 2]] : [[-ov, -w / 2], [depth, 0], [-ov, w / 2]];
      const plane = new Plane([r, 0, z0], [1, 0, 0], [0, -1, 0]);
      const section = (polyDrawing(pts).sketchOnPlane(plane) as unknown as { wire: Parameters<typeof genericSweep>[0] }).wire;
      const helix = makeHelix(pitch, height, r, [0, 0, z0], [0, 0, 1], f.lefthand);
      let groove = genericSweep(section, helix, { frenet: true }) as Shape3D;
      if (clip) groove = groove.intersect(makeBox([-r * 3, -r * 3, 0], [r * 3, r * 3, len])) as Shape3D;
      const out = clean(body.cut(orient(groove, dir, start)));
      if (volume(out) < v0 - 1e-6 && volume(out) > v0 * 0.2) {
        bodies.set(f.face.bodyId, out);
        return res.uncertain ? "The face moved; please check it's still the right one." : undefined;
      }
    } catch {
      /* try the next variant */
    }
  }
  throw new FeatureError("The thread couldn't be cut. Try a different pitch or a smaller depth.");
}

/** Replace flat faces by a plane: the body grows or shrinks until those faces lie on it. */
export function replaceFaces(f: ReplaceFaceFeature, bodies: Map<Id, Shape3D>, planeOf: (id: Id) => SketchFrame | undefined): string | undefined {
  if (!f.faces.length) throw new FeatureError("Click the flat faces to replace.", undefined, true);
  let q: Vec3;
  let m: Vec3;
  if (f.plane) {
    const fr = planeOf(f.plane);
    if (!fr) throw new FeatureError("The target plane is missing.");
    q = fr.origin;
    m = fr.normal;
  } else if (f.target) {
    const t = resolveFace(bodyForRefs(bodies, f.target.bodyId), f.target);
    if (!t) throw new FeatureError("The target face is gone. Pick it again.");
    if (t.item.geomType !== "PLANE") throw new FeatureError("Faces can only be replaced by a flat target face or a plane.");
    q = t.item.center.toTuple();
    m = norm(t.item.normalAt().toTuple());
  } else throw new FeatureError("Click the flat face (or pick a plane) to replace them with.", undefined, true);
  const bodyId = f.faces[0]!.bodyId;
  const body = bodyForRefs(bodies, bodyId);
  const [lo, hi] = body.boundingBox.bounds;
  const span = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 3 + 100;
  let out = body;
  let warning: string | undefined;
  for (const ref of f.faces) {
    if (ref.bodyId !== bodyId) throw new FeatureError("All faces must belong to one body.");
    const res = resolveFace(body, ref);
    if (!res) throw new FeatureError("A face to replace is gone. Pick it again.");
    if (res.uncertain) warning = "A face moved after an upstream change. Please check the selection.";
    if (res.item.geomType !== "PLANE") throw new FeatureError("Only flat faces can be replaced.");
    const n = norm(res.item.normalAt().toTuple());
    const denom = dot(n, m);
    if (Math.abs(denom) < 1e-6) throw new FeatureError("The face runs parallel to the target's normal, so it can never reach the plane.");
    // Moving out along the normal changes the signed distance g to the plane by `denom` per unit, so the
    // region swept before reaching the plane is on one side of it; moving in sweeps the other side.
    const grow = denom > 0 ? scale(m, -1) : m;
    const shrink = scale(grow, -1);
    const sweep = (dirSign: number, side: Vec3): Shape3D | null => {
      try {
        const slab = orient(makeBox([-span, -span, 0], [span, span, span]), side, q);
        const prism = (basicFaceExtrusion(res.item, res.item.normalAt().multiply(dirSign * span)) as unknown as Shape3D).intersect(slab) as Shape3D;
        return volume(prism) > 1e-9 ? prism : null;
      } catch {
        return null;
      }
    };
    const up = sweep(1, grow);
    const down = sweep(-1, shrink);
    if (up) out = out.fuse(up);
    if (down) out = out.cut(down);
  }
  if (!(volume(out) > 1e-9)) throw new FeatureError("The faces couldn't be replaced that way.");
  bodies.set(bodyId, clean(out));
  return warning;
}

/** Group edges into connected loops (by shared end points). */
function edgeLoops(edges: Edge[]): Edge[][] {
  const ends = (e: Edge): [Vec3, Vec3] => [e.startPoint.toTuple(), e.endPoint.toTuple()];
  const near = (a: Vec3, b: Vec3) => dist(a, b) < 1e-5;
  const loops: Edge[][] = [];
  const left = [...edges];
  while (left.length) {
    const loop = [left.pop()!];
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = left.length - 1; i >= 0; i--) {
        const [a, b] = ends(left[i]!);
        if (loop.some((e) => ends(e).some((p) => near(p, a) || near(p, b)))) {
          loop.push(left.splice(i, 1)[0]!);
          grew = true;
        }
      }
    }
    loops.push(loop);
  }
  return loops;
}

/** Delete the faces of a hole, pocket or boss: cap the opening, then fill (or cut) the capped volume. */
export function deleteFaces(f: DeleteFaceFeature, bodies: Map<Id, Shape3D>): string | undefined {
  if (!f.faces.length) throw new FeatureError("Click the faces to delete (all the walls of a hole, pocket or boss).", undefined, true);
  const bodyId = f.faces[0]!.bodyId;
  const body = bodyForRefs(bodies, bodyId);
  const faces: Face[] = [];
  let warning: string | undefined;
  for (const ref of f.faces) {
    if (ref.bodyId !== bodyId) throw new FeatureError("All faces must belong to one body.");
    const res = resolveFace(body, ref);
    if (!res) throw new FeatureError("A face to delete is gone. Pick it again.");
    if (res.uncertain) warning = "A face moved after an upstream change. Please check the selection.";
    faces.push(res.item);
  }
  // The opening is where the deleted faces meet faces that stay (seams stay inside a single face).
  const others = (body.faces as Face[]).filter((fc) => !faces.some((x) => x.isSame(fc)));
  const stay = others.flatMap((fc) => fc.edges as Edge[]);
  const boundary = faces.flatMap((fc) => fc.edges as Edge[]).filter((e) => stay.some((o) => o.isSame(e)));
  if (!boundary.length) throw new FeatureError("These faces already form a closed shape, so there is no opening to heal.");
  try {
    const caps = edgeLoops(boundary).map((loop) => makeFace(assembleWire(loop)));
    const filler = makeSolid([...faces, ...caps]) as unknown as Shape3D;
    if (!(Math.abs(volume(filler)) > 1e-9)) throw new Error("empty");
    const v0 = volume(body);
    let out = body.fuse(filler);
    if (!(volume(out) > v0 + 1e-6)) out = body.cut(filler);
    if (!(Math.abs(volume(out) - v0) > 1e-6)) throw new Error("no change");
    bodies.set(bodyId, clean(out));
  } catch {
    throw new FeatureError("These faces can't be healed automatically: the opening has to be flat. Try selecting the whole hole, pocket or boss.");
  }
  return warning;
}

/** Move a body so one of its flat faces meets a flat face of another body. */
export function alignBody(f: AlignFeature, bodies: Map<Id, Shape3D>, ev: Evaluator): string | undefined {
  if (!f.from || !f.to) throw new FeatureError(!f.from ? "Click a flat face on the body to move." : "Now click the flat face it should meet.", undefined, true);
  const id = f.bodyId ?? f.from.bodyId;
  if (f.to.bodyId === id) throw new FeatureError("Pick the second face on a different body.");
  const body = bodyForRefs(bodies, id);
  const a = resolveFace(body, f.from);
  const b = resolveFace(bodyForRefs(bodies, f.to.bodyId), f.to);
  if (!a || !b) throw new FeatureError("A picked face is gone. Pick the faces again.");
  if (a.item.geomType !== "PLANE" || b.item.geomType !== "PLANE") throw new FeatureError("Align works with flat faces.");
  const n1 = norm(a.item.normalAt().toTuple());
  const n2 = norm(b.item.normalAt().toTuple());
  const c1 = a.item.center.toTuple();
  const c2 = b.item.center.toTuple();
  const want = f.flip ? n2 : scale(n2, -1);
  let out = body.clone();
  const c = Math.max(-1, Math.min(1, dot(n1, want)));
  if (c < 1 - 1e-9) {
    let axis = cross(n1, want);
    if (Math.hypot(axis[0], axis[1], axis[2]) < 1e-9) axis = Math.abs(n1[0]) < 0.9 ? cross(n1, [1, 0, 0]) : cross(n1, [0, 1, 0]);
    out = out.rotate(deg(Math.acos(c)), c1, norm(axis));
  }
  const gap = ev.num(f.offset, "length", "Offset");
  const move = add(sub(c2, c1), scale(n2, gap));
  bodies.set(id, out.translate(move));
  return a.uncertain || b.uncertain ? "A face moved after an upstream change. Please check the selection." : undefined;
}

/** Cut the tool bodies into cells (overlaps and leftovers) and keep the chosen ones as a body. */
export function boundaryCells(f: BoundaryFillFeature, bodies: Map<Id, Shape3D>): string | undefined {
  const tools = f.tools.filter((t) => bodies.has(t));
  if (tools.length < 2) throw new FeatureError("Click two or more bodies that overlap.", undefined, true);
  let cells: Shape3D[] = [bodies.get(tools[0]!)!];
  for (const id of tools.slice(1)) {
    const tool = bodies.get(id)!;
    let rest = tool;
    const next: Shape3D[] = [];
    for (const c of cells) {
      let inter: Shape3D | null = null;
      try {
        inter = c.intersect(tool) as Shape3D;
      } catch {
        inter = null;
      }
      if (inter && volume(inter) > 1e-6) {
        next.push(inter);
        rest = rest.cut(c);
        const only = c.cut(tool);
        if (volume(only) > 1e-6) next.push(only);
      } else next.push(c);
    }
    if (volume(rest) > 1e-6) next.push(rest);
    cells = next;
  }
  CELL_INFO.set(
    f.id,
    cells.map((c) => {
      const [lo, hi] = c.boundingBox.bounds;
      return { volume: volume(c), center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] as Vec3 };
    }),
  );
  const picked = f.cells.filter((i) => cells[i]).map((i) => cells[i]!);
  if (!picked.length) throw new FeatureError("Choose which cells to keep as a body.", undefined, true);
  if (!f.keepTools) for (const id of tools) bodies.delete(id);
  bodies.set(f.id, picked.length === 1 ? clean(picked[0]!) : (makeCompound(picked) as Shape3D));
  return;
}

/** Copies of a body spaced evenly along a sketch path (optionally turning with it). */
export function patternOnPath(f: PatternFeature, src: Shape3D, sketches: Map<Id, SketchLike>, ev: Evaluator): Shape3D[] {
  const sk = f.path ? sketches.get(f.path) : undefined;
  if (!f.path || !sk || !(sk.source || sk.wire)) throw new FeatureError("Pick the sketch (or 3D curve) with the path the copies follow.", undefined, true);
  const count = Math.round(ev.num(f.count, "count", "Count"));
  const wire = sk.wire ?? sketchPath(sk.source!, sk.frame, ev);
  const p0 = wire.pointAt(0).toTuple();
  const t0 = norm(wire.tangentAt(0).toTuple());
  const copies: Shape3D[] = [];
  for (let i = 1; i < count; i++) {
    const t = i / (count - 1);
    const p = wire.pointAt(t).toTuple();
    let c = src.clone().translate(sub(p, p0));
    if (f.follow) {
      const ti = norm(wire.tangentAt(t).toTuple());
      const cs = Math.max(-1, Math.min(1, dot(t0, ti)));
      const ax = cross(t0, ti);
      if (cs < 1 - 1e-9 && Math.hypot(ax[0], ax[1], ax[2]) > 1e-9) c = c.rotate(deg(Math.acos(cs)), p, norm(ax));
    }
    copies.push(c);
  }
  return copies;
}

/* ───────────────────────────── Joints ───────────────────────────── */

const TURNS = new Set(["revolute", "cylindrical", "pinslot", "planar"]);
const SLIDES = new Set(["slider", "cylindrical", "pinslot", "planar"]);

/** Bodies that move together: everything in the same component (just the body when it has none). */
export function componentBodies(doc: WhittleDocument, id: Id): Id[] {
  const c = doc.bodies[id]?.component;
  if (!c) return [id];
  return Object.entries(doc.bodies)
    .filter(([, m]) => m.component === c)
    .map(([k]) => k);
}

/** The values a joint puts its body at (radians and mm), with limits and any motion link applied. */
export function jointValue(f: JointFeature, doc: WhittleDocument, ev: Evaluator, depth = 0): { angle: number; dist: number; dist2: number; angle2: number; angle3: number; warning?: string } {
  let warning: string | undefined;
  const t = f.joint;
  let angle = TURNS.has(t) || t === "ball" ? ev.num(f.angle, "angle", "Angle") : 0;
  let dist = SLIDES.has(t) ? ev.num(f.distance, "length", "Distance") : 0;
  const dist2 = t === "planar" ? ev.num(f.distance2 ?? "0", "length", "Second distance") : 0;
  const angle2 = t === "ball" ? ev.num(f.angle2 ?? "0", "angle", "Angle about Y") : 0;
  const angle3 = t === "ball" ? ev.num(f.angle3 ?? "0", "angle", "Angle about Z") : 0;
  if (f.link && depth < 8) {
    const src = doc.features.find((x) => x.id === f.link!.joint);
    if (!src || src.type !== "joint") throw new FeatureError("The joint this one follows is missing. Choose it again.");
    const sv = jointValue(src, doc, ev, depth + 1);
    const srcMain = src.joint === "revolute" || src.joint === "ball" ? (sv.angle * 180) / Math.PI : TURNS.has(src.joint) && !SLIDES.has(src.joint) ? (sv.angle * 180) / Math.PI : SLIDES.has(src.joint) ? sv.dist : (sv.angle * 180) / Math.PI;
    const v = ev.num(f.link.ratio, "number", "Ratio") * srcMain;
    if (t === "revolute" || t === "ball") angle = (v * Math.PI) / 180;
    else dist = v;
  }
  if (f.limited) {
    const rotLimited = t === "revolute";
    const kind = rotLimited ? "angle" : "length";
    const lo = ev.num(f.min, kind, "Minimum");
    const hi = ev.num(f.max, kind, "Maximum");
    const x = rotLimited ? angle : dist;
    const c = Math.min(hi, Math.max(lo, x));
    if (c !== x) warning = c === lo ? "The joint is at its lower limit." : "The joint is at its upper limit.";
    if (rotLimited) angle = c;
    else if (SLIDES.has(t)) dist = c;
  }
  return { angle, dist, dist2, angle2, angle3, warning };
}

/** Put the moving body (and its whole component) where the joint's values say. */
export function applyJoint(f: JointFeature, bodies: Map<Id, Shape3D>, sketches: Map<Id, { frame: SketchFrame }>, ev: Evaluator, doc: WhittleDocument): string | undefined {
  const id = f.bodyId;
  if (!id || !bodies.has(id)) throw new FeatureError("Pick the body that moves.", undefined, true);
  if (f.fixedId && !bodies.has(f.fixedId)) throw new FeatureError("The body this joint is attached to no longer exists. Re-pick it.");
  if (f.fixedId === id) throw new FeatureError("Pick two different bodies.", undefined, true);
  const v = jointValue(f, doc, ev);
  let warning = v.warning;
  if (doc.bodies[id]?.grounded) {
    const moves = Math.abs(v.angle) + Math.abs(v.dist) + Math.abs(v.dist2) + Math.abs(v.angle2) + Math.abs(v.angle3) > 1e-12;
    return moves ? "This body is grounded, so it stays put. Un-ground it or make the other body the moving one." : undefined;
  }
  const axisFrame = f.axisRef ? sketches.get(f.axisRef)?.frame : undefined;
  if (f.axisRef && !axisFrame) throw new FeatureError("The construction axis is missing. Choose another axis.");
  const originFrame = f.originRef ? sketches.get(f.originRef)?.frame : undefined;
  if (f.originRef && !originFrame) throw new FeatureError("The construction point is missing. Choose another point.");
  const world: Record<"x" | "y" | "z", Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const axis: Vec3 = axisFrame ? norm(axisFrame.normal) : world[f.axis];
  const { xDir, yDir } = frameAxes(axis);
  const src = bodies.get(id)!;
  const pivot: Vec3 = originFrame ? originFrame.origin : f.origin === "point" ? (f.point.map((p, i) => ev.num(p, "length", "XYZ"[i]!)) as Vec3) : axisFrame ? axisFrame.origin : boxCenter(src);
  const move = (s: Shape3D): Shape3D => {
    let o = s.clone();
    if (f.joint === "ball") {
      const axes: Vec3[] = axisFrame ? [xDir, yDir, axis] : [world.x, world.y, world.z];
      [v.angle, v.angle2, v.angle3].forEach((a, i) => {
        if (Math.abs(a) > 1e-12) o = o.rotate(deg(a), pivot, axes[i]!);
      });
      return o;
    }
    if (Math.abs(v.angle) > 1e-12 && TURNS.has(f.joint)) o = o.rotate(deg(v.angle), pivot, axis);
    let t: Vec3 = [0, 0, 0];
    if (f.joint === "slider" || f.joint === "cylindrical") t = scale(axis, v.dist);
    else if (f.joint === "pinslot") t = scale(xDir, v.dist);
    else if (f.joint === "planar") t = add(scale(xDir, v.dist), scale(yDir, v.dist2));
    return t.some((c) => Math.abs(c) > 1e-12) ? o.translate(t) : o;
  };
  const group = componentBodies(doc, id);
  for (const b of group) {
    const s = bodies.get(b);
    if (s && b !== f.fixedId && !doc.bodies[b]?.grounded) bodies.set(b, move(s));
  }
  if (f.collide && !warning) {
    for (const [other, shape] of bodies) {
      if (group.includes(other) || other === f.fixedId) continue;
      for (const g of group) {
        const mine = bodies.get(g);
        if (!mine) continue;
        const [alo, ahi] = mine.boundingBox.bounds;
        const [blo, bhi] = shape.boundingBox.bounds;
        if ([0, 1, 2].some((k) => ahi[k]! < blo[k]! - 1e-6 || bhi[k]! < alo[k]! - 1e-6)) continue;
        try {
          if (volume(mine.intersect(shape) as Shape3D) > 1e-3) {
            warning = `Collision: ${doc.bodies[g]?.name ?? "the moving body"} runs into ${doc.bodies[other]?.name ?? "another body"}.`;
            break;
          }
        } catch {
          /* touching only */
        }
      }
      if (warning) break;
    }
  }
  return warning;
}

/* ───────────────────────────── 3D curves ───────────────────────────── */

export interface CurveBuilt {
  polys: Vec3[][];
  /** The first curve as a wire, so sweeps and pipes can follow it. */
  wire?: Wire;
}

const wireFromPoints = (pts: Vec3[], smooth: boolean): Wire | undefined => {
  try {
    if (smooth && pts.length >= 3) return assembleWire([makeBSplineApproximation(pts, { tolerance: 1e-3 })]);
    return assembleWire(pts.slice(0, -1).map((p, i) => makeLine(p, pts[i + 1]!)));
  } catch {
    return undefined;
  }
};

const sampleEdge = (e: Edge, n = 48): Vec3[] => Array.from({ length: n + 1 }, (_, i) => e.pointAt(i / n).toTuple());

export function curveTool(f: CurveFeature, bodies: Map<Id, Shape3D>, sketches: Map<Id, SketchLike>, ev: Evaluator): CurveBuilt {
  switch (f.source) {
    case "points": {
      if (f.points.length < 2) throw new FeatureError("Click at least two points on the model.", undefined, true);
      const pts = f.points;
      if (f.smooth && pts.length >= 3) {
        const edge = makeBSplineApproximation(pts, { tolerance: 1e-3 });
        return { polys: [sampleEdge(edge, 64)], wire: assembleWire([edge]) };
      }
      return { polys: [pts], wire: wireFromPoints(pts, false) };
    }
    case "edges": {
      if (!f.edges.length) throw new FeatureError("Click the model edges to copy.", undefined, true);
      const found: Edge[] = [];
      for (const ref of f.edges) {
        const r = resolveEdge(bodyForRefs(bodies, ref.bodyId), ref);
        if (!r) throw new FeatureError("An edge is gone. Pick it again.");
        found.push(r.item);
      }
      let wire: Wire | undefined;
      try {
        wire = assembleWire(found);
      } catch {
        wire = found.length === 1 ? assembleWire([found[0]!]) : undefined;
      }
      return { polys: found.map((e) => sampleEdge(e)), wire };
    }
    case "faces": {
      if (f.faces.length < 2) throw new FeatureError(f.faces.length ? "Click the second face." : "Click two faces that meet.", undefined, true);
      const [a, b] = f.faces.map((ref) => {
        const r = resolveFace(bodyForRefs(bodies, ref.bodyId), ref);
        if (!r) throw new FeatureError("A face is gone. Pick it again.");
        return r.item;
      }) as [Face, Face];
      const oc = getOC();
      const sec = new oc.BRepAlgoAPI_Section(a.wrapped, b.wrapped, true);
      try {
        const shape = cast(downcast(sec.Shape())) as unknown as { edges: Edge[] };
        const edges = shape.edges;
        if (!edges.length) throw new FeatureError("These faces don't meet. Pick faces that cross each other.");
        let wire: Wire | undefined;
        try {
          wire = assembleWire(edges);
        } catch {
          wire = edges.length === 1 ? assembleWire([edges[0]!]) : undefined;
        }
        return { polys: edges.map((e) => sampleEdge(e)), wire };
      } finally {
        sec.delete();
      }
    }
    case "project": {
      if (!f.faces.length) throw new FeatureError("Click the face to project onto.", undefined, true);
      const sk = f.sketch ? sketches.get(f.sketch) : undefined;
      if (!f.sketch || !sk?.source) throw new FeatureError("Now click the sketch to lay onto the face.", undefined, true);
      const r = resolveFace(bodyForRefs(bodies, f.faces[0]!.bodyId), f.faces[0]!);
      if (!r) throw new FeatureError("The face is gone. Pick it again.");
      const oc = getOC();
      const { origin, xDir, yDir } = sk.frame;
      const polys: Vec3[][] = [];
      for (const ent of sk.source.entities) {
        if (ent.construction) continue;
        const res = resolveEntity(ent, ev);
        const open = res.type === "polyline" && res.open;
        const pts2 = entityOutline(res, 64);
        const pts3 = (open ? pts2 : [...pts2, pts2[0]!]).map(([x, y]) => add(origin, add(scale(xDir, x), scale(yDir, y))));
        const onFace = pts3.map((p) => {
          const v = makeVertex(p);
          const d = new oc.BRepExtrema_DistShapeShape(v.wrapped, r.item.wrapped);
          try {
            if (!d.IsDone() || d.NbSolution() < 1) return p;
            const q = d.PointOnShape2(1);
            return [q.X(), q.Y(), q.Z()] as Vec3;
          } finally {
            d.delete();
          }
        });
        polys.push(onFace);
      }
      if (!polys.length) throw new FeatureError("The sketch has no shapes to project.");
      return { polys, wire: wireFromPoints(polys[0]!, false) };
    }
  }
}
