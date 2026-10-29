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
import { type BodyOp, type EdgeRef, type LengthUnit, lengthText, type Evaluator, type FaceRef, type Feature, type HoleFeature, type Id, type SketchFeature, type SketchSolution, type Vec3, type WhittleDocument, activeEnd, createEvaluator, deserializeDocument, drawnEntities, entityOutline, expandSketch, frameAxes, planeOrigin, sketchGap, polylinePath, resolveEntity, thickenPath } from "@whittle/core";
import { type Blueprint, Drawing, type Edge, type Face, draw, organiseBlueprints, type FaceFinder, Plane, type Shape3D, type Wire, asDir, basicFaceExtrusion, cast, downcast, genericSweep, getOC, makeHelix, makeOffset, makePln, drawCircle, importSTEP, loft, makeBox, makeSolid, Vector, makeCompound, makeCylinder, makeSphere, measureArea, measureShapeVolumeProperties } from "replicad";
import type { BodyResult, FeatureStatus, RegenResult, SketchFrame } from "./protocol";
import type { CoilFeature, DraftFeature, OffsetFaceFeature, PlaneRef, SweepFeature } from "@whittle/core";
import "./fastTopo";
import { parseOBJ, stlToShape } from "./stl";
import { circleOf, constructFrame } from "./construct";
import { surfaceTool, prismSurface, revolveSurface } from "./surface";
import { CELL_INFO, alignBody, curveTool, widestSection, applyJoint, joinKeepingFaces, boundaryCells, deleteFaces, patternOnPath, replaceFaces, ribTool, threadTool } from "./extra";
import { solveSketch } from "./solver";
import { add, cross, dot, edgeInfo, faceInfo, norm, resolveEdge, resolveFace, scale, sub as subv } from "./refs";

import { type AnySketch, clean, AXES, FRIENDLY, FeatureError, ORIGIN_FRAMES, bodyForRefs, boxCenter, deg, shapeBounds, describeError, hasSolid, orient, planeFromFrame, polyDrawing, sketchDrawing, sketchPath, sketchRegionDrawings } from "./shared";
export * from "./shared";

interface SketchBuilt {
  frame: SketchFrame;
  /** 3D curve features: a wire sweeps, pipes and path patterns can follow. */
  wire?: Wire;
  /** The sketch feature itself, with solved geometry as entities (sweeps read open paths from it). */
  source?: SketchFeature;
  solution?: SketchSolution;
  drawing: Drawing | null;
  error?: string;
  /** Triangles of the closed profile regions (world coordinates), for display. */
  fill?: Float32Array;
  /** Every enclosed area on its own, so a feature can use some of them. */
  regions?: BuiltRegion[];
}

interface BuiltRegion {
  drawing: Drawing;
  /** World triangles, for display and picking. */
  fill?: Float32Array;
  /** The same triangles in sketch coordinates (xy per vertex), to find which region holds a point. */
  local: Float32Array;
  /** A point inside the region (sketch coordinates). */
  at: [number, number];
}

interface Snapshot {
  key: string;
  bodies: Map<Id, Shape3D>;
  sketches: Map<Id, SketchBuilt>;
  status: FeatureStatus;
  /** The tool shape of the feature being edited and what it did with it (shown as a tinted preview). */
  ghost?: Shape3D;
  ghostOp?: BodyOp;
}

/** Filled by applyOp, so the editor can show what the feature adds, cuts or keeps. */
const ghostSink: { tool: Shape3D | null; op: BodyOp | null } = { tool: null, op: null };

/** The straight edge across the narrowest flat face that edge `e` borders, parallel to it, and the gap between them. */
function fullRoundPartner(body: Shape3D, e: Edge): { partner: Edge; width: number } | null {
  if (e.geomType !== "LINE") return null;
  const a = e.startPoint;
  const d = [e.endPoint.x - a.x, e.endPoint.y - a.y, e.endPoint.z - a.z];
  const len = Math.hypot(d[0]!, d[1]!, d[2]!);
  if (len < 1e-9) return null;
  let best: { partner: Edge; width: number } | null = null;
  for (const face of body.faces) {
    if (face.geomType !== "PLANE" || !face.edges.some((x) => x.isSame(e))) continue;
    for (const x of face.edges) {
      if (x.isSame(e) || x.geomType !== "LINE") continue;
      const b = x.startPoint;
      const dx = [x.endPoint.x - b.x, x.endPoint.y - b.y, x.endPoint.z - b.z];
      const lx = Math.hypot(dx[0]!, dx[1]!, dx[2]!);
      const cr = [d[1]! * dx[2]! - d[2]! * dx[1]!, d[2]! * dx[0]! - d[0]! * dx[2]!, d[0]! * dx[1]! - d[1]! * dx[0]!];
      if (Math.hypot(cr[0]!, cr[1]!, cr[2]!) > 1e-6 * len * lx) continue;
      const w = [b.x - a.x, b.y - a.y, b.z - a.z];
      const c2 = [d[1]! * w[2]! - d[2]! * w[1]!, d[2]! * w[0]! - d[0]! * w[2]!, d[0]! * w[1]! - d[1]! * w[0]!];
      const width = Math.hypot(c2[0]!, c2[1]!, c2[2]!) / len;
      if (width > 1e-6 && (!best || width < best.width)) best = { partner: x, width };
    }
  }
  return best;
}

function bboxOverlap(a: Shape3D, b: Shape3D): boolean {
  const [a0, a1] = shapeBounds(a);
  const [b0, b1] = shapeBounds(b);
  const eps = 1e-6;
  return a0[0] <= b1[0] + eps && b0[0] <= a1[0] + eps && a0[1] <= b1[1] + eps && b0[1] <= a1[1] + eps && a0[2] <= b1[2] + eps && b0[2] <= a1[2] + eps;
}

export function lastBody(bodies: Map<Id, Shape3D>): Id | undefined {
  return [...bodies.keys()].pop();
}

/** Apply a body operation (new / join / cut / intersect) for a tool shape. */
/** Fuse many shapes pairwise, so the work grows with log(n) layers rather than n ever-bigger fuses. */
function fuseTree(shapes: Shape3D[]): Shape3D {
  if (shapes.length === 1) return shapes[0]!;
  const mid = shapes.length >> 1;
  return fuseTree(shapes.slice(0, mid)).fuse(fuseTree(shapes.slice(mid)));
}

/** Volume of a solid, or 0 for shapes that have none (surfaces). */
function safeVolume(s: Shape3D): number {
  try {
    return measureShapeVolumeProperties(s).volume;
  } catch {
    return 0;
  }
}

/** True when OpenCascade's own checker accepts the shape (a malformed solid makes later booleans fail or lie). */
export function isValidShape(shape: Shape3D): boolean {
  const oc = getOC();
  const a = new oc.BRepCheck_Analyzer(shape.wrapped, true, false, false);
  try {
    return a.IsValid();
  } finally {
    a.delete();
  }
}

/**
 * Combines a tool with the bodies. OpenCascade flags some sound shapes (a circle exactly tangent to an edge), so a doubtful
 * tool is only reported when it also leaves a body that is invalid and has no positive volume (inside-out or empty).
 */
export function applyOp(bodies: Map<Id, Shape3D>, featureId: Id, op: BodyOp, target: Id | undefined, tool: Shape3D): string | undefined {
  const doubtful = !isValidShape(tool);
  const before = new Map(bodies);
  const note = applyOpUnchecked(bodies, featureId, op, target, tool);
  if (!doubtful) return note;
  for (const [id, b] of bodies) {
    if (before.get(id) !== b && !(safeVolume(b) > 0) && !isValidShape(b)) {
      return "This step made a shape OpenCascade reports as invalid, and the result looks broken. Check the sketch or settings for overlapping or degenerate parts.";
    }
  }
  return note;
}

function applyOpUnchecked(bodies: Map<Id, Shape3D>, featureId: Id, op: BodyOp, target: Id | undefined, tool: Shape3D): string | undefined {
  ghostSink.tool = tool;
  ghostSink.op = op;
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
  let changed = 0;
  for (const id of ids) {
    const body = bodies.get(id)!;
    if (!bboxOverlap(body, tool)) continue;
    touched++;
    const before = op === "cut" ? safeVolume(body) : 0;
    const out = clean(op === "cut" ? body.cut(tool) : body.intersect(tool));
    bodies.set(id, out);
    // A cut that only grazes a face leaves the volume as it was.
    if (op !== "cut" || Math.abs(safeVolume(out) - before) > Math.max(1e-6, before * 1e-9)) changed++;
  }
  if (touched === 0) {
    throw new FeatureError(op === "cut" ? "The cut doesn't touch any body. Try flipping its direction." : "The shapes don't overlap.");
  }
  if (op === "cut" && changed === 0) return "The cut removed nothing: it only touches the body. Try Flip direction, or reach further into it.";
  return;
}

/** The frame of an origin plane (optionally tilted), a flat face, or a construction plane, moved by its offset. */
function planeFrame(id: Id, plane: PlaneRef, bodies: Map<Id, Shape3D>, sketches: Map<Id, SketchBuilt>, ev: Evaluator): { frame: SketchFrame; warning?: string } {
  const offset = ev.num(plane.offset, "length", "Offset");
  if (plane.kind === "origin") {
    const o = ORIGIN_FRAMES[plane.plane]!;
    let { xDir, yDir, normal } = o;
    const tilt = plane.angle ? ev.num(plane.angle, "angle", "Tilt") : 0;
    if (Math.abs(tilt) > 1e-12) {
      if (plane.tilt === "y") {
        normal = rotateAbout(normal, yDir, tilt);
        xDir = rotateAbout(xDir, yDir, tilt);
      } else {
        normal = rotateAbout(normal, xDir, tilt);
        yDir = rotateAbout(yDir, xDir, tilt);
      }
    }
    return { frame: { id, origin: scale(normal, offset), xDir, yDir, normal } };
  }
  if (plane.kind === "construction") {
    const base = sketches.get(plane.plane)?.frame;
    if (!base) throw new FeatureError("The construction plane this is based on is missing. Pick a new plane.");
    return { frame: { id, origin: add(base.origin, scale(base.normal, offset)), xDir: base.xDir, yDir: base.yDir, normal: base.normal } };
  }
  const body = bodyForRefs(bodies, plane.face.bodyId);
  const res = resolveFace(body, plane.face);
  if (!res) throw new FeatureError("The face this plane was on is gone. Pick a new plane.");
  if (res.item.geomType !== "PLANE") throw new FeatureError("Planes need a flat face.");
  const info = faceInfo(res.item);
  const { xDir, yDir } = frameAxes(info.normal);
  return {
    frame: { id, origin: add(planeOrigin(info.center, info.normal), scale(info.normal, offset)), xDir, yDir, normal: info.normal },
    warning: res.uncertain ? "The face moved; please check it's still the right one." : undefined,
  };
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

/** Fresh copies of a cached mesh (the worker transfers, and so detaches, what it sends). */
function copyBody(b: BodyResult, id: Id): BodyResult {
  return {
    ...b,
    id,
    positions: b.positions.slice(),
    normals: b.normals.slice(),
    indices: b.indices.slice(),
    faceRanges: b.faceRanges.slice(),
    edgePositions: b.edgePositions.slice(),
    edgeRanges: b.edgeRanges.slice(),
  };
}

/** cyrb53: a 53-bit string hash; the seed makes independent variants. */
function cyrb53(s: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Two independent 53-bit hashes plus the length (about 2^-106 collision odds): keys stay small however long the timeline grows. */
function hashKey(s: string): string {
  return cyrb53(s, 0).toString(36) + cyrb53(s, 0x9e3779b9).toString(36) + "." + s.length.toString(36);
}

export class Builder {
  private cache: Snapshot[] = [];
  /** Meshes by shape: a body that didn't change since the last rebuild isn't meshed again. */
  private meshes = new WeakMap<Shape3D, Partial<Record<"preview" | "final", BodyResult>>>();

  private mesh(id: Id, shape: Shape3D, quality: "preview" | "final"): BodyResult {
    let entry = this.meshes.get(shape);
    if (!entry) this.meshes.set(shape, (entry = {}));
    const hit = entry[quality];
    if (hit) return copyBody(hit, id);
    const m = meshBody(id, shape, quality);
    entry[quality] = m;
    return copyBody(m, id);
  }
  /** Parsed imported files, keyed by feature id + content length + content head. */
  private imports = new Map<string, Shape3D>();
  private importErrors = new Map<string, string>();

  /** Parse any imported files the document needs (async, so done before regen). */
  async prepareImports(doc: WhittleDocument): Promise<void> {
    // Parsed files no step uses any more are let go, keeping a few in case an undo brings them back (audit K-5).
    const using = new Set(doc.features.flatMap((f) => (f.type === "import" ? [importKey(f)] : [])));
    for (const cache of [this.imports, this.importErrors] as Map<string, unknown>[]) {
      const unused = [...cache.keys()].filter((k) => !using.has(k));
      for (const k of unused.slice(0, Math.max(0, unused.length - 4))) cache.delete(k);
    }
    for (const f of doc.features) {
      if (f.type !== "import") continue;
      const key = importKey(f);
      if (this.imports.has(key) || this.importErrors.has(key)) continue;
      try {
        // Decoding is inside the try: a damaged file fails its own feature, not every rebuild of the design.
        let bin: string;
        try {
          bin = atob(f.data);
        } catch {
          throw new Error("The file embedded in this design is damaged.");
        }
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        const blob = new Blob([bytes]);
        if (f.format === "whittle") {
          const sub = deserializeDocument(bytes);
          const nested = new Builder();
          await nested.prepareImports(sub);
          const shapes = [...nested.shapes(sub).values()];
          if (!shapes.length) throw new Error("That design has no bodies to bring in.");
          this.imports.set(key, (shapes.length === 1 ? shapes[0]! : makeCompound(shapes)) as Shape3D);
        } else this.imports.set(key, f.format === "step" ? ((await importSTEP(blob)) as Shape3D) : f.format === "obj" ? stlToShape(bytes, parseOBJ(bytes)) : stlToShape(bytes));
      } catch (e) {
        this.importErrors.set(key, e instanceof Error && !/^\d+$/.test(e.message) ? e.message : FRIENDLY.import!);
      }
    }
  }

  private ghostFeature: Id | undefined;

  regen(doc: WhittleDocument, quality: "preview" | "final", pickBefore?: Id, preview?: Id): Omit<RegenResult, "seq"> {
    unitName = doc.units;
    const t0 = performance.now();
    this.ghostFeature = preview ?? pickBefore;
    const { prev, statuses, rebuilt, end } = this.walk(doc);

    const bodies: BodyResult[] = [];
    for (const [id, shape] of prev.bodies) {
      try {
        bodies.push(this.mesh(id, shape, quality));
      } catch {
        // The kernel's own exceptions carry no readable text.
        statuses.push({ id, state: "error", message: "This body couldn't be displayed: its shape is damaged. Edit or suppress the last step that changed it." });
      }
    }
    const sketches: SketchFrame[] = [];
    for (const f of doc.features.slice(0, end)) {
      if (f.type !== "sketch") continue;
      const s = prev.sketches.get(f.id);
      // Copy the fill: the cached array must survive being transferred to the UI.
      if (s) sketches.push({ ...s.frame, fill: s.fill ? s.fill.slice() : undefined, solution: s.solution, regions: s.regions?.flatMap((r) => (r.fill ? [{ fill: r.fill.slice(), at: r.at }] : [])) });
    }
    const planes: SketchFrame[] = [];
    for (const f of doc.features.slice(0, end)) {
      const s = f.type === "cplane" || f.type === "construct" || f.type === "curve" ? prev.sketches.get(f.id) : undefined;
      if (s) planes.push({ ...s.frame, line: s.frame.line ? s.frame.line.slice() : undefined });
    }
    let pickBodies: BodyResult[] | undefined;
    if (pickBefore) {
      const idx = doc.features.findIndex((f) => f.id === pickBefore);
      const before = idx > 0 ? this.cache[idx - 1] : undefined;
      pickBodies = [];
      for (const [id, shape] of before?.bodies ?? []) {
        try {
          pickBodies.push(this.mesh(id, shape, "preview"));
        } catch {
          /* not pickable */
        }
      }
    }
    let ghost: BodyResult | undefined;
    const gi = this.ghostFeature ? doc.features.findIndex((f) => f.id === this.ghostFeature) : -1;
    const gs = gi >= 0 ? this.cache[gi]?.ghost : undefined;
    const ghostOp = gi >= 0 ? this.cache[gi]?.ghostOp : undefined;
    if (gs) {
      try {
        ghost = this.mesh("ghost", gs, "preview");
      } catch {
        /* no ghost */
      }
    }
    for (const s of statuses) if (CELL_INFO.has(s.id)) s.cells = CELL_INFO.get(s.id);
    return { bodies, sketches, planes, status: statuses, pickBodies, ghost, ghostOp: ghost ? ghostOp : undefined, ms: performance.now() - t0, rebuilt };
  }

  /** The final body shapes of the active timeline (for export). */
  shapes(doc: WhittleDocument): Map<Id, Shape3D> {
    return this.walk(doc).prev.bodies;
  }

  /** Build the active timeline, reusing cached steps. */
  /** The document being built (joints read components and other joints from it). */
  private curDoc: WhittleDocument | null = null;
  /** The snapshots of the walk in progress (one per feature built so far), for feature patterns. */
  private walkSnaps: Snapshot[] = [];
  /** Told after every timeline step of a rebuild (done so far, total), so the interface can show progress. */
  onProgress: ((done: number, total: number) => void) | null = null;

  /**
   * Repeat earlier features: whatever each one added to or cut from a body is copied by
   * copiesOf and joined or cut again, in timeline order, so a boss with a hole repeats as a boss with a hole.
   */
  private repeatFeatures(bodies: Map<Id, Shape3D>, ids: Id[], selfId: Id, copiesOf: (s: Shape3D) => Shape3D[]): void {
    const feats = this.curDoc!.features;
    const selfIndex = feats.findIndex((x) => x.id === selfId);
    const sources = ids
      .map((id) => feats.findIndex((x) => x.id === id))
      .filter((i) => i >= 0 && i < selfIndex)
      .sort((a, b) => a - b);
    if (sources.length === 0) throw new FeatureError("Pick the earlier features to repeat.", undefined, true);
    for (const i of sources) {
      const after = this.walkSnaps[i];
      const before = i > 0 ? this.walkSnaps[i - 1] : undefined;
      const name = feats[i]!.name;
      if (!after || after.status.state === "suppressed") continue;
      if (after.status.state === "error" || after.status.state === "incomplete") throw new FeatureError(`${name} has a problem, so it can't be repeated.`);
      let any = false;
      for (const [bodyId, nowShape] of after.bodies) {
        const was = before?.bodies.get(bodyId);
        if (!was) {
          // A feature that makes a new body has no body to repeat into.
          throw new FeatureError(`${name} makes a new body. Repeat features that join to or cut a body, or pattern the body itself.`);
        }
        const added = clean(nowShape.cut(was));
        const removed = clean(was.cut(nowShape));
        const addedV = safeVolume(added);
        const removedV = safeVolume(removed);
        if (addedV < 1e-9 && removedV < 1e-9) continue;
        any = true;
        let acc = bodies.get(bodyId);
        if (!acc) throw new FeatureError(`The body that ${name} changed no longer exists.`);
        const adds = addedV >= 1e-9 ? copiesOf(added) : [];
        const rems = removedV >= 1e-9 ? copiesOf(removed) : [];
        if (rems.length === 0) acc = acc.fuse(fuseTree(adds));
        else if (adds.length === 0) acc = acc.cut(fuseTree(rems));
        else {
          // Both added and removed: keep each copy's order (a copy's cut may reach an earlier copy's addition).
          for (let k = 0; k < Math.max(adds.length, rems.length); k++) {
            if (adds[k]) acc = acc.fuse(adds[k]!);
            if (rems[k]) acc = acc.cut(rems[k]!);
          }
        }
        bodies.set(bodyId, clean(acc));
      }
      if (!any) throw new FeatureError(`${name} didn't change any body, so there is nothing to repeat.`);
    }
  }

  private walk(doc: WhittleDocument) {
    this.curDoc = doc;
    this.walkSnaps = [];
    const compSig = JSON.stringify(Object.entries(doc.bodies).map(([k, m]) => [k, m.component, m.grounded]));
    const ev = createEvaluator(doc.parameters, doc.units);
    const paramSig = JSON.stringify([...ev.params.entries()]) + doc.units;
    const end = activeEnd(doc);
    const statuses: FeatureStatus[] = [];

    let prev: Snapshot = {
      key: hashKey(paramSig),
      bodies: new Map(),
      sketches: new Map(),
      status: { id: "", state: "ok" },
    };
    let rebuilt = 0;
    const nextCache: Snapshot[] = [];
    this.walkSnaps = nextCache;

    for (let i = 0; i < end; i++) {
      const f = doc.features[i]!;
      // Reference images aren't geometry. The key chains every step before this one, so it is hashed to stay a fixed size.
      const key = hashKey(prev.key + "|" + (f.type === "import" ? importKey(f) + f.scale + !!f.suppressed : JSON.stringify(f.type === "sketch" ? { ...f, image: undefined, name: undefined } : { ...f, name: undefined })) + (f.type === "joint" ? compSig : ""));
      const cached = this.cache[i];
      let snap: Snapshot;
      const needGhost = f.id === this.ghostFeature && !!(f as { op?: string }).op && !cached?.ghost;
      if (cached && cached.key === key && !needGhost) {
        snap = cached;
      } else {
        rebuilt++;
        snap = this.step(f, prev, ev, key);
      }
      nextCache.push(snap);
      this.onProgress?.(i + 1, end);
      // A step that lost its body because an earlier step failed should say which one.
      const failedBefore = statuses.findLast((x) => x.state === "error");
      const failedName = failedBefore && doc.features.find((x) => x.id === failedBefore.id)?.name;
      statuses.push(
        snap.status.state === "error" && failedName && snap.status.message?.startsWith("The body this feature was applied to no longer exists")
          ? { ...snap.status, message: `${snap.status.message} It is probably because "${failedName}" failed above.` }
          : snap.status,
      );
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
    ghostSink.tool = null;
    ghostSink.op = null;
    try {
      const warning = this.apply(f, bodies, sketches, ev);
      return {
        key,
        bodies,
        sketches,
        status: { id: f.id, state: warning ? "warning" : "ok", message: warning, ms: performance.now() - t },
        ghost: f.id === this.ghostFeature ? ghostSink.tool ?? undefined : undefined,
        ghostOp: f.id === this.ghostFeature ? ghostSink.op ?? undefined : undefined,
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
      case "surface":
        return surfaceTool(f, bodies, (id) => sketches.get(id)?.frame, ev);

      case "curve": {
        const built = curveTool(f, bodies, sketches, ev);
        const flat: number[] = [];
        for (const poly of built.polys) for (let i = 0; i + 1 < poly.length; i++) flat.push(...poly[i]!, ...poly[i + 1]!);
        const first = built.polys[0]![0]!;
        sketches.set(f.id, { frame: { id: f.id, origin: first, xDir: [1, 0, 0], yDir: [0, 1, 0], normal: [0, 0, 1], kind: "curve", line: new Float32Array(flat) }, drawing: null, wire: built.wire });
        return;
      }

      case "rib":
        return applyOp(bodies, f.id, f.op, f.target, ribTool(f, sketches, ev));

      case "thread":
        return threadTool(f, bodies, ev);

      case "replaceFace":
        return replaceFaces(f, bodies, (id) => sketches.get(id)?.frame);

      case "deleteFace":
        return deleteFaces(f, bodies);

      case "align":
        return alignBody(f, bodies, ev);

      case "boundaryFill":
        return boundaryCells(f, bodies);

      case "construct": {
        const { frame, warning } = constructFrame(f, {
          body: (id) => bodyForRefs(bodies, id),
          angle: (e) => ev.num(e, "angle", "Angle"),
          num: (e) => ev.num(e, "number", "Value"),
          fail: (m) => new FeatureError(m, undefined, /^(Pick|Click)/.test(m)),
        });
        sketches.set(f.id, { frame, drawing: null });
        return warning;
      }

      case "cplane": {
        const { frame, warning } = planeFrame(f.id, f.plane, bodies, sketches, ev);
        sketches.set(f.id, { frame, drawing: null });
        return warning;
      }

      case "sketch": {
        const { frame, warning: planeWarning } = planeFrame(f.id, f.plane, bodies, sketches, ev);
        let warning = planeWarning;
        let drawing: Drawing | null = null;
        let error: string | undefined;
        let solution: SketchSolution | undefined;
        let source = f;
        try {
          solution = solveSketch(f, ev);
          if (solution) source = expandSketch(f, solution);
          if (solution?.message) warning ??= solution.message;
          const notes: { warning?: string } = {};
          drawing = sketchDrawing(source, ev, notes);
          warning ??= notes.warning;
        } catch (e) {
          error = describeError(f, e);
        }
        const regions = drawing ? builtRegions(source, frame, ev) : undefined;
        // Every enclosed area is shaded, an island inside another shape as much as the ring around it.
        sketches.set(f.id, { frame, drawing, error, source, solution, fill: regions ? joinFills(regions.map((r) => r.fill)) : drawing ? profileFill(drawing, frame) : undefined, regions });
        if (error) throw new FeatureError(error);
        return warning;
      }

      case "extrude":
      case "revolve": {
        const sk = sketches.get(f.sketch);
        if (!sk) throw new FeatureError("The sketch for this feature is missing or failed.");
        if (sk.error) throw new FeatureError("Its sketch has an error: " + sk.error);
        const thin = f.type === "extrude" && f.thin ? ev.num(f.thin, "length", "Wall thickness") : 0;
        if (thin < 0) throw new FeatureError("The wall thickness must be greater than zero.");
        const surf = !!f.surface;
        let regionWarning: string | undefined;
        const picked = !surf && thin <= 0 && f.regions?.length ? regionProfile(sk, f.regions) : null;
        if (picked?.warning) regionWarning = picked.warning;
        const profile = !surf && thin > 0 && f.type === "extrude" ? thinProfile(sk, thin, f.thinSide ?? "center", ev) : (picked?.drawing ?? sk.drawing);
        if (!profile && !surf) throw new FeatureError(thin > 0 ? "The sketch has no outlines or paths to thicken." : noClosedShapes(sk));
        let tool: Shape3D;
        if (f.type === "extrude") {
          const fromFace = f.startFace !== undefined ? distanceToFace(bodies, f.startFace ?? undefined, sk.frame, true) : 0;
          const off = fromFace + (f.startOffset ? ev.num(f.startOffset, "length", "Start offset") : 0);
          const start = Math.abs(off) > 1e-9 ? { ...sk.frame, origin: add(sk.frame.origin, scale(sk.frame.normal, off)) } : sk.frame;
          const d =
            f.extent === "through"
              ? throughDistance(bodies, start)
              : f.extent === "face"
                ? distanceToFace(bodies, f.toFace, start)
                : ev.num(f.distance, "length", "Distance");
          if (Math.abs(d) < 1e-6) throw new FeatureError("The distance can't be zero.");
          const sign = f.flip && f.extent !== "face" ? -1 : 1;
          let frame = start;
          let dist = d * sign;
          if (f.extent === "symmetric") {
            frame = { ...frame, origin: add(frame.origin, scale(frame.normal, -Math.abs(d) / 2)) };
            dist = Math.abs(d);
          } else if (f.extent === "two") {
            const d2 = ev.num(f.distance2 ?? "0", "length", "Second distance");
            if (d2 < 0) throw new FeatureError("The second distance can't be negative.");
            const dir = sign * Math.sign(d);
            frame = { ...frame, origin: add(frame.origin, scale(frame.normal, -d2 * dir)) };
            dist = (Math.abs(d) + d2) * dir;
          }
          const taper = f.taper ? ev.num(f.taper, "angle", "Taper") : 0;
          const twist = f.twist ? ev.num(f.twist, "angle", "Twist") : 0;
          if (Math.abs(taper) > 1e-9 && Math.abs(twist) > 1e-9) throw new FeatureError("Use either a taper or a twist on one extrusion, not both.");
          if (Math.abs(taper) >= Math.PI / 2 - 1e-3) throw new FeatureError("The taper must be between -89 and 89 degrees.");
          if (surf) {
            if (Math.abs(taper) > 1e-9 || Math.abs(twist) > 1e-9) throw new FeatureError("Surfaces can't have a taper or a twist. Turn Surface off, or set them to zero.");
            tool = prismSurface(surfaceWires(sk, frame, ev), scale(frame.normal, dist));
          } else if (Math.abs(taper) > 1e-9) {
            tool = clean(taperedExtrude(profile!, frame, dist, taper));
          } else {
            const sketch = profile!.clone().sketchOnPlane(planeFromFrame(frame));
            tool = clean((Math.abs(twist) > 1e-9 ? sketch.extrude(dist, { twistAngle: deg(twist) }) : sketch.extrude(dist)) as Shape3D);
          }
        } else {
          const angle = ev.num(f.angle, "angle", "Angle");
          if (Math.abs(angle) < 1e-6) throw new FeatureError("The angle can't be zero.");
          let d = Math.min(Math.abs(deg(angle)), 360) * Math.sign(angle);
          // Where the turn starts, relative to the profile: symmetric straddles it, two-sided runs back by the second angle.
          let startBack = 0;
          if (f.extent === "symmetric") {
            d = Math.min(Math.abs(d), 360) * Math.sign(d);
            startBack = Math.abs(d) / 2;
          } else if (f.extent === "two") {
            const a2 = ev.num(f.angle2 ?? "0", "angle", "Second angle");
            if (a2 < 0) throw new FeatureError("The second angle can't be negative.");
            const back = Math.min(deg(a2), 360);
            if (Math.abs(d) + back > 360) d = Math.sign(d) * (360 - back);
            startBack = back;
            d = Math.sign(d || 1) * (Math.abs(d) + back);
          }
          const { origin, dir } = revolveAxis(f.axis, f.axisLine, sk, ev);
          if (surf) {
            const axisEntity = f.axis === "line" ? (f.axisLine ?? sk.source?.entities.find((x) => x.type === "polyline" && (x.open || x.construction))?.id) : undefined;
            tool = revolveSurface(surfaceWires(sk, sk.frame, ev, axisEntity), origin, dir, (d * Math.PI) / 180);
          } else {
            const sketch = profile!.clone().sketchOnPlane(planeFromFrame(sk.frame));
            tool = clean(sketch.revolve(dir, { origin, angle: d }) as Shape3D);
          }
          if (startBack > 1e-9 && Math.abs(d) < 360 - 1e-9) tool = tool.rotate(-startBack * Math.sign(d || 1), origin, dir);
        }
        return applyOp(bodies, f.id, surf ? "new" : f.op, f.target, tool) ?? regionWarning;
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
        if (f.surface) {
          bodies.set(f.id, loft(profiles.map((p) => (p as unknown as { wire: Wire }).wire), { ruled: f.ruled }, true));
          return;
        }
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
              throw new FeatureError("The inner radius must be positive and smaller than the outer radius.", inner >= r ? { label: `Use ${lenText(r * 0.8)}`, field: "radius2", value: `${lenText(r * 0.8)}` } : undefined);
            }
            tool = makeCylinder(r, h, [px, py, pz], [0, 0, 1]).cut(makeCylinder(inner, h + 2, [px, py, pz - 1], [0, 0, 1]));
            break;
          }
        }
        return applyOp(bodies, f.id, f.op, f.target, tool);
      }

      case "hole":
        return this.hole(f, bodies, ev);

      case "sweep":
        return applyOp(bodies, f.id, f.surface && !f.pipe ? "new" : f.op, f.target, sweepTool(f, sketches, ev));

      case "coil":
        return applyOp(bodies, f.id, f.op, f.target, coilTool(f, ev));

      case "split": {
        const id = f.bodyId ?? lastBody(bodies);
        if (!id || !bodies.has(id)) throw new FeatureError("Pick a body to split.");
        let off = ev.num(f.offset, "length", "Offset");
        const ref = f.planeRef ? sketches.get(f.planeRef)?.frame : undefined;
        if (f.planeRef && !ref) throw new FeatureError("The construction plane is missing. Pick another plane.");
        if (f.silhouette) off = widestSection(bodies.get(id)!, ref ? planeFromFrame(ref) : f.plane);
        const parts = bodies.get(id)!.split(ref ? planeFromFrame(ref) : f.plane, off);
        const above = parts.positive as Shape3D | null;
        const below = parts.negative as Shape3D | null;
        if (!above || !below) throw new FeatureError("The plane doesn't cross this body, so there's nothing to split. Change the offset.");
        if (f.facesOnly) {
          // Joining the halves without merging faces leaves the old faces cut along the plane.
          bodies.set(id, joinKeepingFaces(above, below));
          return;
        }
        if (f.keep === "both") {
          bodies.set(id, clean(above));
          bodies.set(f.id, clean(below));
        } else bodies.set(id, clean(f.keep === "above" ? above : below));
        return;
      }

      case "offset": {
        const id = f.bodyId ?? lastBody(bodies);
        if (!id || !bodies.has(id)) throw new FeatureError("Pick a body to offset.");
        const d = ev.num(f.distance, "length", "Distance");
        if (Math.abs(d) < 1e-6) throw new FeatureError("The distance can't be zero.");
        const src = bodies.get(id)!;
        let out: Shape3D;
        try {
          out = hasConeTip(src) ? offsetSharp(src, d) : makeOffset(src as unknown as Face, d, 1e-4);
          // A shrunk body that lost all its volume is a failure, not a result.
          if (!(measureShapeVolumeProperties(out).volume > 1e-9)) throw new Error("empty");
        } catch {
          throw new FeatureError(FRIENDLY.offset!);
        }
        bodies.set(f.copy ? f.id : id, out);
        return;
      }

      case "boundingSolid": {
        const ids = f.bodies.length ? f.bodies.filter((b) => bodies.has(b)) : [...bodies.keys()];
        if (!ids.length) throw new FeatureError("There's no body to enclose yet.");
        const pad = ev.num(f.padding, "length", "Padding");
        // Mesh points sit on the surface (curves only sag inwards by the tolerance), so this fits tighter than OCC's box.
        const tol = 0.01;
        const pts: number[] = [];
        for (const id of ids) pts.push(...bodies.get(id)!.mesh({ tolerance: tol, angularTolerance: 0.1 }).vertices);
        const lo = [Infinity, Infinity, Infinity];
        const hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < pts.length; i += 3) for (let k = 0; k < 3; k++) (lo[k] = Math.min(lo[k]!, pts[i + k]!)), (hi[k] = Math.max(hi[k]!, pts[i + k]!));
        const grow = pad + tol;
        if (f.shape === "box") {
          bodies.set(f.id, makeBox([lo[0]! - grow, lo[1]! - grow, lo[2]! - grow], [hi[0]! + grow, hi[1]! + grow, hi[2]! + grow]));
          return;
        }
        // ponytail: centred on the box's middle, not the smallest enclosing circle; exact for round and symmetric parts.
        const a = { x: 0, y: 1, z: 2 }[f.axis];
        const [u, v] = [0, 1, 2].filter((k) => k !== a) as [number, number];
        const cu = (lo[u]! + hi[u]!) / 2;
        const cv = (lo[v]! + hi[v]!) / 2;
        let r = 0;
        for (let i = 0; i < pts.length; i += 3) r = Math.max(r, Math.hypot(pts[i + u]! - cu, pts[i + v]! - cv));
        const base: [number, number, number] = [0, 0, 0];
        base[a] = lo[a]! - grow;
        base[u] = cu;
        base[v] = cv;
        const dir: [number, number, number] = [0, 0, 0];
        dir[a] = 1;
        bodies.set(f.id, makeCylinder(r + grow, hi[a]! - lo[a]! + 2 * grow, base, dir));
        return;
      }

      case "scale": {
        const id = f.bodyId ?? lastBody(bodies);
        if (!id || !bodies.has(id)) throw new FeatureError("Pick a body to scale.");
        const k = ev.num(f.factor, "number", "Factor");
        if (k <= 0) throw new FeatureError("The scale factor must be greater than zero.");
        const src = bodies.get(id)!;
        const out = src.clone().scale(k, f.center === "body" ? boxCenter(src) : [0, 0, 0]);
        bodies.set(f.copy ? f.id : id, out);
        return;
      }

      case "draft":
        return draftFaces(f, bodies, ev);

      case "offsetFace":
        return offsetFaces(f, bodies, ev);

      case "joint":
        return applyJoint(f, bodies, sketches, ev, this.curDoc!);

      case "fillet":
      case "chamfer": {
        if (f.edges.length === 0) throw new FeatureError("Select one or more edges in the viewport.", undefined, true);
        const value = ev.num(f.type === "fillet" ? f.radius : f.distance, "length", f.type === "fillet" ? "Radius" : "Distance");
        if (value <= 0) throw new FeatureError("The size must be greater than zero.");
        let warning: string | undefined;
        const byBody = new Map<Id, Edge[]>();
        let missing = 0;
        for (const ref of f.edges) {
          const body = bodyForRefs(bodies, ref.bodyId);
          const res = resolveEdge(body, ref);
          // A lost edge doesn't stop the rest: the others are still done and the step turns yellow until it is re-picked.
          if (!res) {
            missing++;
            continue;
          }
          if (res.uncertain) warning = "Some edges moved after an upstream change. Please check the selection.";
          const list = byBody.get(ref.bodyId) ?? [];
          list.push(res.item);
          byBody.set(ref.bodyId, list);
        }
        if (byBody.size === 0) throw new FeatureError(f.edges.length > 1 ? "The selected edges no longer exist. Edit the feature to re-pick them." : "The selected edge no longer exists. Edit the feature to re-pick it.");
        if (missing) warning = `${missing} of the ${f.edges.length} selected edges no longer exist after an upstream change, so they were skipped. Edit the feature to re-pick them.`;
        const end = f.type === "fillet" && f.radius2 ? ev.num(f.radius2, "length", "End radius") : null;
        if (end !== null && end <= 0) throw new FeatureError("The end radius must be greater than zero.");
        const ratio = end !== null ? end / value : 1;
        // Uneven chamfers: a second setback (scaled with the first when searching for a size that fits) or an angle.
        const cmode = f.type === "chamfer" ? (f.mode ?? "equal") : "equal";
        const d2 = f.type === "chamfer" && cmode === "two" ? ev.num(f.distance2 ?? f.distance, "length", "Second distance") : null;
        const ang = f.type === "chamfer" && cmode === "angle" ? ev.num(f.angle ?? "45", "angle", "Angle") * (180 / Math.PI) : null;
        if (d2 !== null && d2 <= 0) throw new FeatureError("The second distance must be greater than zero.");
        if (ang !== null && (ang <= 0 || ang >= 90)) throw new FeatureError("The chamfer angle must be between 0° and 90°.");
        const flip = f.type === "chamfer" && !!f.flip;
        // Full round: pair each edge with the parallel edge across its narrow flat face; both get half that width.
        const fullRound = f.type === "fillet" && !!f.fullRound;
        const full = new Map<Id, { edge: Edge; r: number }[]>();
        if (fullRound) {
          for (const [id, edges] of byBody) {
            const list: { edge: Edge; r: number }[] = [];
            for (const e of [...edges]) {
              const pair = fullRoundPartner(bodies.get(id)!, e);
              if (!pair) throw new FeatureError("Full round needs the long edges of a narrow flat face. Pick one edge along such a face (a thin wall's top, for instance).");
              for (const x of [e, pair.partner]) {
                if (!list.some((y) => y.edge.isSame(x))) list.push({ edge: x, r: pair.width * 0.4995 });
                if (!edges.some((y) => y.isSame(x))) edges.push(x);
              }
            }
            full.set(id, list);
          }
        }
        const run = (size: number): Map<Id, Shape3D> => {
          const out = new Map<Id, Shape3D>();
          for (const [id, edges] of byBody) {
            const body = bodies.get(id)!;
            if (fullRound) {
              const list = full.get(id)!;
              out.set(id, body.fillet((e: Edge) => list.find((x) => x.edge.isSame(e))?.r ?? null));
              continue;
            }
            if (f.type === "fillet") {
              out.set(id, body.fillet((e: Edge) => (edges.some((x) => x.isSame(e)) ? (end !== null ? [size, size * ratio] : size) : null)));
              continue;
            }
            const faces = d2 !== null || ang !== null ? body.faces : [];
            out.set(
              id,
              body.chamfer((e: Edge) => {
                if (!edges.some((x) => x.isSame(e))) return null;
                if (d2 === null && ang === null) return size;
                // The face the first setback is measured on: one of the two the edge joins.
                const adj = faces.filter((fc) => fc.edges.some((x) => x.isSame(e)));
                const face = adj[flip ? 1 : 0] ?? adj[0];
                if (!face) return size;
                const selectedFace = (finder: FaceFinder) => finder.when(({ element }) => element.isSame(face));
                return d2 !== null ? { distances: [size, (d2 * size) / value] as [number, number], selectedFace } : { distance: size, angle: ang!, selectedFace };
              }),
            );
          }
          return out;
        };
        const started = performance.now();
        try {
          for (const [id, s] of run(value)) bodies.set(id, s);
        } catch {
          if (fullRound) throw new FeatureError("Full round could not be made here. It needs a flat face with two straight parallel edges and nothing else cutting into it.");
          const field = f.type === "fillet" ? "radius" : "distance";
          // A first try that already took seconds means every further try will too: report the failure instead.
          const fit = performance.now() - started > 3000 ? null : largestWorking(value, (v) => run(v));
          const what = f.type === "fillet" ? "fillet radius" : "chamfer distance";
          throw new FeatureError(
            fit
              ? `A ${lenText(value)} ${what} is too large for these edges. The largest that fits is about ${lenText(fit)}.`
              : `This ${what} can't be applied to the selected edges. Try a much smaller value or fewer edges.`,
            fit ? { label: `Use ${lenText(fit)}`, field, value: `${lenText(fit)}` } : undefined,
          );
        }
        return warning;
      }

      case "shell": {
        const t = ev.num(f.thickness, "length", "Thickness");
        if (t <= 0) throw new FeatureError("The wall thickness must be greater than zero.");
        // No open face: walls all round, hollow inside (picking faces then opens them).
        const bodyId = f.bodyId ?? f.faces[0]?.bodyId ?? lastBody(bodies);
        if (!bodyId || (!f.faces.length && !bodies.has(bodyId))) throw new FeatureError("Pick a body to hollow, or the face to open.", undefined, true);
        const body = bodyForRefs(bodies, bodyId);
        let warning: string | undefined;
        const faces: Face[] = [];
        for (const ref of f.faces) {
          if (ref.bodyId !== bodyId) throw new FeatureError("All faces to open must belong to the body being shelled. Edit the shell and remove the others.");
          const res = resolveFace(body, ref);
          if (!res) throw new FeatureError("A face to open no longer exists. Edit the shell to re-pick it.");
          if (res.uncertain) warning = "A face moved after an upstream change. Please check the selection.";
          faces.push(res.item);
        }
        const shellOf = (v: number) => {
          if (!faces.length) return shellBySubtraction(body, [], v);
          const before = measureShapeVolumeProperties(body).volume;
          try {
            const out = body.shell(v, (finder) => finder.when(({ element }) => faces.some((x) => x.isSame(element))));
            // OpenCascade hands the body back untouched (and says it succeeded) when a fillet meets an open face.
            if (Math.abs(measureShapeVolumeProperties(out).volume - before) > before * 1e-6) return out;
          } catch {
            /* try the other way */
          }
          return shellBySubtraction(body, faces, v);
        };
        const walled = (v: number) => (f.direction === "outside" ? shellBySubtraction(body, faces, 0, v) : f.direction === "both" ? shellBySubtraction(body, faces, v / 2, v / 2) : shellOf(v));
        const started = performance.now();
        try {
          bodies.set(bodyId, walled(t));
        } catch {
          const fit = performance.now() - started > 3000 ? null : largestWorking(t, walled);
          throw new FeatureError(
            fit ? `A ${lenText(t)} wall is too thick for this body. About ${lenText(fit)} fits.` : FRIENDLY.shell!,
            fit ? { label: `Use ${lenText(fit)}`, field: "thickness", value: `${lenText(fit)}` } : undefined,
          );
        }
        return warning;
      }

      case "mirror": {
        const off = f.offset ? ev.num(f.offset, "length", "Offset") : 0;
        const ref = f.planeRef ? sketches.get(f.planeRef)?.frame : undefined;
        if (f.planeRef && !ref) throw new FeatureError("The construction plane is missing. Pick another plane.");
        const mirrorOf = (s: Shape3D) => (ref ? s.clone().mirror(ref.normal, add(ref.origin, scale(ref.normal, off))) : s.clone().mirror(f.plane, scale(MIRROR_NORMALS[f.plane], off)));
        if (f.features?.length) {
          this.repeatFeatures(bodies, f.features, f.id, (s) => [mirrorOf(s)]);
          return;
        }
        const id = f.bodyId ?? lastBody(bodies);
        if (!id || !bodies.has(id)) throw new FeatureError("Pick a body to mirror.");
        const src = bodies.get(id)!;
        const copy = mirrorOf(src);
        if (f.merge) {
          bodies.set(id, clean(src.fuse(copy)));
        } else bodies.set(f.id, copy);
        return;
      }

      case "pattern": {
        const featureMode = !!f.features?.length;
        const id = f.bodyId ?? lastBody(bodies);
        if (!featureMode && (!id || !bodies.has(id))) throw new FeatureError("Pick a body to pattern.");
        const count = ev.num(f.count, "count", "Count");
        if (count < 2 || count > 200) throw new FeatureError("The count must be between 2 and 200.");
        const axisFrame = f.axisRef ? sketches.get(f.axisRef)?.frame : undefined;
        if (f.axisRef && !axisFrame) throw new FeatureError("The construction axis is missing. Pick another axis.");
        const picked = f.axisGeom ? pickedAxis(f.axisGeom, bodies) : undefined;
        const axis = picked?.dir ?? (axisFrame ? axisFrame.normal : AXES[f.axis]);
        const axisAt: Vec3 = picked?.at ?? (axisFrame ? axisFrame.origin : [0, 0, 0]);
        // The copies of one shape, in a fixed order (the original is left alone).
        const copiesOf = (src: Shape3D): Shape3D[] => {
          const copies: Shape3D[] = [];
          if (f.pattern === "path") copies.push(...patternOnPath(f, src, sketches, ev));
          else if (f.pattern === "linear") {
            const spacing = ev.num(f.spacing, "length", "Spacing");
            const count2 = f.count2 ? Math.round(ev.num(f.count2, "count", "Second count")) : 1;
            if (count2 < 1 || count * count2 > 400) throw new FeatureError("A grid can have at most 400 copies.");
            if (count2 > 1 && f.axis2 === f.axis) throw new FeatureError("Pick a different second direction.");
            const axis2 = AXES[f.axis2 ?? (f.axis === "x" ? "y" : "x")];
            const spacing2 = count2 > 1 ? ev.num(f.spacing2 ?? f.spacing, "length", "Second spacing") : 0;
            for (let j = 0; j < count2; j++) {
              for (let i = 0; i < count; i++) {
                if (i || j) copies.push(src.clone().translate(add(scale(axis, spacing * i), scale(axis2, spacing2 * j))));
              }
            }
          } else {
            const total = deg(ev.num(f.angle, "angle", "Angle"));
            const full = Math.abs(Math.abs(total) - 360) < 1e-6;
            const stepDeg = full ? total / count : total / (count - 1);
            for (let i = 1; i < count; i++) copies.push(src.clone().rotate(stepDeg * i, axisAt, axis));
          }
          return copies;
        };
        if (featureMode) {
          this.repeatFeatures(bodies, f.features!, f.id, copiesOf);
          return;
        }
        const src = bodies.get(id!)!;
        const copies = copiesOf(src);
        if (f.merge) {
          const merged = clean(src.fuse(fuseTree(copies)));
          // OpenCascade can return an empty shape when many copies overlap wall on wall; say so rather than lose the body.
          if (safeVolume(src) > 0 && !(safeVolume(merged) > 0)) {
            throw new FeatureError("The copies overlap too much to merge into one body. Space them further apart, or turn off Merge to keep them as separate bodies.");
          }
          bodies.set(id!, merged);
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
        const s = ev.num(f.scale, "number", "Scale");
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
    const [b0, b1] = shapeBounds(body);
    const span = Math.hypot(b1[0] - b0[0], b1[1] - b0[1], b1[2] - b0[2]) * 2 + 10;
    const depth = f.through ? span : ev.num(f.depth, "length", "Depth");
    if (depth <= 0) throw new FeatureError("The hole depth must be greater than zero.");
    let headD = 0;
    let headDepth = 0;
    if (f.style !== "simple") {
      headD = ev.num(f.headDiameter, "length", "Head diameter");
      if (headD <= d) {
        throw new FeatureError("The head diameter must be larger than the hole.", { label: `Use ${lenText(d * 1.8)}`, field: "headDiameter", value: `${lenText(d * 1.8)}` });
      }
      let sink = Math.PI / 2;
      if (f.style === "countersink" && f.sinkAngle) {
        sink = ev.num(f.sinkAngle, "angle", "Countersink angle");
        if (!(sink > 0 && sink < Math.PI)) throw new FeatureError("The countersink angle must be between 0° and 180°.");
      }
      headDepth = f.style === "counterbore" ? ev.num(f.headDepth, "length", "Head depth") : (headD - d) / 2 / Math.tan(sink / 2);
      if (headDepth <= 0) throw new FeatureError("The head depth must be greater than zero.");
    }
    let tipLen = 0;
    if (!f.through && f.tipAngle) {
      const a = ev.num(f.tipAngle, "angle", "Drill point angle");
      if (!(a > 0 && a < Math.PI)) throw new FeatureError("The drill point angle must be between 0° and 180°.");
      tipLen = d / 2 / Math.tan(a / 2);
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
      // The cone a drill leaves below the full-diameter depth.
      if (tipLen > 0) tool = tool.fuse(orient(frustumZ(d / 2, 0, tipLen), down, add(at, scale(down, depth))));
      if (f.style === "counterbore") tool = tool.fuse(makeCylinder(headD / 2, headDepth + lift, top, down));
      if (f.style === "countersink") tool = tool.fuse(orient(frustumZ(headD / 2 + lift, d / 2, headDepth + lift), down, top));
      const before = out.faces.length;
      const prior = out;
      out = out.cut(tool);
      // Same face count can still be a hole (a cut through a face that was already split): check the volume too (audit K-5).
      if (out.faces.length === before && !(measureShapeVolumeProperties(prior).volume - measureShapeVolumeProperties(out).volume > 1e-9)) missed.push(i + 1);
    }
    bodies.set(f.face.bodyId, clean(out));
    if (missed.length) {
      return `Hole${missed.length > 1 ? "s" : ""} ${missed.join(", ")} ${missed.length > 1 ? "are" : "is"} off the body, so nothing was drilled there. Check the X and Y positions.`;
    }
    return warning;
  }
}

/** Normals of the named planes as replicad mirrors them (offset moves the plane along these). */
/** The same normals as sketches and Split (audit K-7): an XZ offset of d is at y = -d everywhere. */
const MIRROR_NORMALS: Record<"XY" | "XZ" | "YZ", Vec3> = { XY: ORIGIN_FRAMES.XY!.normal, XZ: ORIGIN_FRAMES.XZ!.normal, YZ: ORIGIN_FRAMES.YZ!.normal };

/** Long enough to pass through every body from the sketch plane. */
/** The signed distance along the sketch's normal to a flat face's plane (negative when the face is behind the sketch). */
function distanceToFace(bodies: Map<Id, Shape3D>, ref: FaceRef | undefined, frame: SketchFrame, start = false): number {
  const verb = start ? "start from" : "extrude up to";
  if (!ref) throw new FeatureError(`Click the face to ${verb}.`, undefined, true);
  const res = resolveFace(bodyForRefs(bodies, ref.bodyId), ref);
  if (!res) throw new FeatureError(`The face to ${verb} no longer exists. Click another face.`);
  const info = faceInfo(res.item);
  if (info.surface !== "PLANE") throw new FeatureError(start ? "Starting from a face needs a flat face." : "Extruding up to a face needs a flat face.");
  const along = dot(frame.normal, info.normal);
  if (Math.abs(along) < 1e-6) throw new FeatureError(start ? "That face is square on to the sketch, so the extrusion can't start from it. Click a face that faces across the sketch plane." : "That face is parallel to the sketch's direction, so the extrusion would never reach it. Click a face that faces across it.");
  const t = dot(subv(info.center, frame.origin), info.normal) / along;
  if (!start && Math.abs(t) < 1e-6) throw new FeatureError("The sketch is already on that face, so there's no distance to extrude.");
  return t;
}

function throughDistance(bodies: Map<Id, Shape3D>, frame: SketchFrame): number {
  if (bodies.size === 0) throw new FeatureError("There's nothing to go through yet. Create a body first, or use a distance.");
  let far = 0;
  for (const b of bodies.values()) {
    const [lo, hi] = shapeBounds(b);
    for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) {
      far = Math.max(far, Math.hypot(x - frame.origin[0], y - frame.origin[1], z - frame.origin[2]));
    }
  }
  return far + 1;
}

/** The axis a revolve spins around: a sketch axis, or a straight line drawn in the sketch. */
function revolveAxis(axis: "x" | "y" | "line", lineId: Id | undefined, sk: SketchBuilt, ev: Evaluator): { origin: Vec3; dir: Vec3 } {
  const f = sk.frame;
  if (axis !== "line") return { origin: f.origin, dir: axis === "x" ? f.xDir : f.yDir };
  // No line picked yet: use the sketch's first path or construction line.
  const e = sk.source?.entities.find((x) => (lineId ? x.id === lineId : x.type === "polyline" && (x.open || x.construction)));
  if (!e || e.type !== "polyline") throw new FeatureError("Pick a line in the sketch to revolve around (draw it with the Path tool).", undefined, true);
  const r = resolveEntity(e, ev);
  if (r.type !== "polyline" || r.points.length < 2) throw new FeatureError("The axis line needs two points.");
  const at = (p: [number, number]): Vec3 => add(add(f.origin, scale(f.xDir, p[0])), scale(f.yDir, p[1]));
  const pa = at(r.points[0]!);
  const pb = at(r.points[r.points.length - 1]!);
  const v: Vec3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
  if (Math.hypot(...v) < 1e-6) throw new FeatureError("The axis line has no length.");
  return { origin: pa, dir: norm(v) };
}

/**
 * The sketch's outlines as drawn, for walls and surfaces along them: areas worked out from loose lines are left
 * out (the lines themselves are open paths), and outlines those lines split up are back in.
 */
function drawnDrawing(sk: SketchBuilt, ev: Evaluator): Drawing | null {
  const derived = sk.source?.entities.some((e) => e.covered || (e.type === "polyline" && e.area));
  return derived && sk.source ? sketchDrawing({ ...sk.source, entities: drawnEntities(sk.source.entities) }, ev) : sk.drawing;
}

/**
 * A thin-wall profile: a band `t` wide along every outline of the sketch, plus a
 * wall along every open path (ribs, webs, a box's walls drawn as one line).
 */
function thinProfile(sk: SketchBuilt, t: number, side: "center" | "inside" | "outside", ev: Evaluator): Drawing | null {
  const pieces: Drawing[] = [];
  const drawing = drawnDrawing(sk, ev);
  if (drawing) {
    const [grow, shrink] = side === "center" ? [t / 2, -t / 2] : side === "inside" ? [0, -t] : [t, 0];
    const at = (d: number) => (d === 0 ? drawing.clone() : drawing.clone().offset(d, { lineJoinType: "miter" }));
    try {
      pieces.push(at(grow).cut(at(shrink)));
    } catch {
      throw new FeatureError("The wall is too thick for this outline. Use a thinner wall.");
    }
  }
  for (const e of sk.source?.entities ?? []) {
    if (e.type !== "polyline" || !e.open || e.construction) continue;
    const r = resolveEntity(e, ev);
    if (r.type !== "polyline" || r.points.length < 2) continue;
    const line = (r.smooth || r.ctrl) && r.points.length >= 3 ? entityOutline(r) : polylinePath(r.points, r.arcs, false, 16, r.splines);
    pieces.push(polyDrawing(thickenPath(line, t, side)));
  }
  return pieces.length ? fusePlanar(pieces) : null;
}

/**
 * Flat pieces joined into one profile. Drawing booleans can drop a hole when the last piece closes a ring (four
 * wall bands crossing at a frame's corners came out filled), so the join runs on faces in OpenCascade, which keeps
 * holes, and the outlines are read back as a drawing.
 */
function fusePlanar(pieces: Drawing[]): Drawing {
  if (pieces.length === 1) return pieces[0]!;
  const oc = getOC();
  // Every piece facing up, or pieces wound the other way stay separate faces and the holes come out wrong.
  const up = (f: Face) => (f.normalAt().z < 0 ? (cast(downcast(f.wrapped.Reversed())) as unknown as Face) : f);
  type Flat = { face?: () => Face; sketches?: Flat[] };
  // A sketch with holes also lists its loops in `sketches`, so take its own face first.
  const facesOf = (s: Flat): Face[] => (s.face ? [s.face()] : (s.sketches ?? []).flatMap(facesOf));
  const faces = pieces.flatMap((d) => facesOf(d.clone().sketchOnPlane("XY") as unknown as Flat)).map(up);
  let shape = faces[0]!.wrapped;
  for (const f of faces.slice(1)) {
    const op = new oc.BRepAlgoAPI_Fuse(shape, f.wrapped);
    try {
      op.Build();
      if (!op.IsDone()) throw new FeatureError("The wall pieces couldn't be joined. Try a slightly different wall thickness.");
      shape = downcast(op.Shape());
    } finally {
      op.delete();
    }
  }
  const unify = new oc.ShapeUpgrade_UnifySameDomain(shape, true, true, false);
  try {
    unify.Build();
    shape = downcast(unify.Shape());
  } finally {
    unify.delete();
  }
  const loops = (cast(downcast(shape)) as unknown as { faces: Face[] }).faces.flatMap((f) => [f.clone().outerWire(), ...f.clone().innerWires()]);
  return new Drawing(organiseBlueprints(loops.map((w) => (loopDrawing(w) as unknown as { innerShape: Blueprint }).innerShape)));
}

/** A closed wire in the XY plane as a drawing, its edges chained end to end (lines and arcs kept exact). */
function loopDrawing(w: Wire): Drawing {
  const xy = (v: { x: number; y: number }): [number, number] => [v.x, v.y];
  const near = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
  const left = [...w.edges];
  const first = left.shift()!;
  const start = xy(first.startPoint);
  let pen = draw(start);
  let at = start;
  let edge: Edge | undefined = first;
  while (edge) {
    const e: Edge = edge;
    const s = xy(e.startPoint);
    const back = !near(s, at);
    const end = back ? s : xy(e.endPoint);
    // Sample positions along the edge, in the direction it is walked.
    const along = (t: number) => xy(e.pointAt(back ? 1 - t : t));
    if (e.geomType === "LINE") pen = pen.lineTo(end);
    else if (e.geomType === "CIRCLE") {
      // A full circle (or more than half of one) goes in two halves: a three-point arc can't close on itself.
      pen = pen.threePointsArcTo(along(0.5), along(0.25)).threePointsArcTo(end, along(0.75));
    } else for (let i = 1; i <= 16; i++) pen = i === 16 ? pen.lineTo(end) : pen.lineTo(along(i / 16));
    at = end;
    const i = left.findIndex((x) => near(xy(x.startPoint), at) || near(xy(x.endPoint), at));
    edge = i < 0 ? undefined : left.splice(i, 1)[0];
  }
  return pen.close();
}

/** Rotate `v` about the unit axis `k` by `a` radians (Rodrigues). */
function rotateAbout(v: Vec3, k: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const kv = cross(k, v);
  const d = dot(k, v) * (1 - c);
  return norm([v[0] * c + kv[0] * s + k[0] * d, v[1] * c + kv[1] * s + k[1] * d, v[2] * c + kv[2] * s + k[2] * d]);
}


/** Outer and inner wires of every region of a placed sketch. */
export function regions(s: AnySketch): { outer: Wire; inner: Wire[] }[] {
  // A compound sketch also lists its loops in `sketches`: check it first so holes stay holes.
  if (s.outerSketch) return [{ outer: s.outerSketch.wire, inner: (s.innerSketches ?? []).map((x) => x.wire) }];
  if (s.sketches) return s.sketches.flatMap(regions);
  if (s.wire) return [{ outer: s.wire, inner: [] }];
  throw new FeatureError("The profile has no closed shape.");
}

/** A solid through two or more wires with straight (ruled) sides. */
function loftWires(wires: Wire[]): Shape3D {
  const oc = getOC();
  const b = new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6);
  try {
    for (const w of wires) b.AddWire(w.wrapped);
    b.Build(new oc.Message_ProgressRange());
    return cast(downcast(b.Shape())) as Shape3D;
  } finally {
    b.delete();
  }
}

/**
 * A true draft: the profile is offset inward by distance × tan(angle) at the
 * far end and joined to the start with straight sides. Holes grow instead,
 * so every wall keeps the same draft.
 */
function taperedExtrude(drawing: Drawing, frame: SketchFrame, dist: number, angle: number): Shape3D {
  const inset = Math.abs(dist) * Math.tan(angle);
  const far: SketchFrame = { ...frame, origin: add(frame.origin, scale(frame.normal, dist)) };
  // Drawing offsets move every loop the same way relative to itself, so outlines come from
  // an inward offset and holes from an outward one: the whole region shrinks (or grows) evenly.
  const at = (d: number) => {
    try {
      return regions(drawing.clone().offset(d, { lineJoinType: "miter" }).sketchOnPlane(planeFromFrame(far)) as unknown as AnySketch);
    } catch {
      throw new FeatureError("The taper closes the profile before the end. Use a smaller angle or a shorter distance.");
    }
  };
  const a = regions(drawing.clone().sketchOnPlane(planeFromFrame(frame)) as unknown as AnySketch);
  const outs = at(-inset);
  const holes = a.some((r) => r.inner.length) ? at(inset) : outs;
  const same = (b: typeof a) => b.length === a.length && a.every((r, i) => r.inner.length === b[i]!.inner.length);
  if (!same(outs) || !same(holes)) {
    throw new FeatureError("The taper changes the shape too much (a hole or piece disappears or merges). Use a smaller angle.");
  }
  let out: Shape3D | null = null;
  a.forEach((r, i) => {
    let solid = loftWires([r.outer, outs[i]!.outer]);
    r.inner.forEach((w, j) => (solid = solid.cut(loftWires([w, holes[i]!.inner[j]!]))));
    out = out ? out.fuse(solid) : solid;
  });
  return out!;
}

/** Every open line in a path sketch (a branching pipe follows them all); a lone outline counts as one path. */
function sketchPaths(f: SketchFeature, frame: SketchFrame, ev: Evaluator): Wire[] {
  const opens = f.entities.filter((e) => e.type === "polyline" && e.open && !e.construction);
  if (opens.length < 2) return [sketchPath(f, frame, ev)];
  return opens.map((e) => sketchPath({ ...f, entities: [e] }, frame, ev));
}

/** A round or square tube along a path: the section is made here, square to the path at its start. */
function pipeTool(f: SweepFeature, sketches: Map<Id, SketchBuilt>, ev: Evaluator): Shape3D {
  const pipe = f.pipe!;
  const path = sketches.get(f.path);
  if (!f.path || !(path?.source || path?.wire)) throw new FeatureError("Pick the path sketch (an open line or outline).", undefined, true);
  const size = ev.num(pipe.size, "length", "Outer size");
  const wall = ev.num(pipe.wall, "length", "Wall");
  if (size <= 0) throw new FeatureError("The pipe size must be greater than zero.");
  if (wall < 0 || wall * 2 >= size) throw new FeatureError("The wall must be at least zero and less than half the size.");
  const config = { frenet: false, transitionMode: "round" as const };
  const wires = path.wire ? [path.wire] : sketchPaths(path.source!, path.frame, ev);
  const solid = (d: number): Shape3D => {
    let all: Shape3D | null = null;
    for (const wire of wires) {
      const at = wire.startPoint;
      const plane = new Plane(at, null, wire.tangentAt(0));
      const h = d / 2;
      const draw = pipe.shape === "circle" ? drawCircle(h) : polyDrawing([[-h, -h], [h, -h], [h, h], [-h, h]]);
      const section = (draw.sketchOnPlane(plane) as unknown as AnySketch).wire!;
      const one = genericSweep(section, wire, config) as Shape3D;
      all = all ? all.fuse(one) : one;
    }
    return all!;
  };
  try {
    let out = solid(size);
    if (wall > 0) out = out.cut(solid(size - 2 * wall));
    if (!(measureShapeVolumeProperties(out).volume > 1e-9)) throw new Error("empty");
    return clean(out);
  } catch (e) {
    if (e instanceof FeatureError) throw e;
    throw new FeatureError("The pipe couldn't be built. Make it thinner than the tightest bend of the path.");
  }
}

/** The outlines (outer and inner wires) and open lines of a sketch, placed on a frame: what a surface is built from. */
function surfaceWires(sk: SketchBuilt, frame: SketchFrame, ev: Evaluator, skipEntity?: Id): Wire[] {
  const out: Wire[] = [];
  const drawing = drawnDrawing(sk, ev);
  if (drawing) for (const r of regions(drawing.clone().sketchOnPlane(planeFromFrame(frame)) as unknown as AnySketch)) out.push(r.outer, ...r.inner);
  for (const e of sk.source?.entities ?? []) {
    if (e.type !== "polyline" || !e.open || e.construction || e.id === skipEntity) continue;
    out.push(sketchPath({ ...sk.source!, entities: [e] } as SketchFeature, frame, ev));
  }
  if (!out.length) throw new FeatureError("The sketch has no shapes or lines to turn into a surface.");
  return out;
}

function sweepTool(f: SweepFeature, sketches: Map<Id, SketchBuilt>, ev: Evaluator): Shape3D {
  if (f.pipe) return pipeTool(f, sketches, ev);
  if (!f.profile || !f.path) throw new FeatureError("Pick a profile sketch and a path sketch.", undefined, true);
  if (f.profile === f.path) throw new FeatureError("Pick different sketches for the profile and the path.", undefined, true);
  const prof = sketches.get(f.profile);
  const path = sketches.get(f.path);
  if (!prof || !(path?.source || path?.wire)) throw new FeatureError("The profile or path sketch is missing. Re-pick them.");
  if (prof.error || (!prof.drawing && !f.surface)) throw new FeatureError("The profile needs a closed shape.");
  const config = { frenet: f.orientation === "frenet", transitionMode: "round" as const };
  if (f.surface) {
    try {
      const route = () => path.wire ?? sketchPath(path.source!, path.frame, ev);
      const parts = surfaceWires(prof, prof.frame, ev).map((w) => genericSweep(w, route(), config, true)[0] as Shape3D);
      return parts.length === 1 ? parts[0]! : (makeCompound(parts) as unknown as Shape3D);
    } catch (e) {
      if (e instanceof FeatureError) throw e;
      throw new FeatureError(FRIENDLY.sweep!);
    }
  }
  try {
    let out: Shape3D | null = null;
    for (const r of regions(prof.drawing!.clone().sketchOnPlane(planeFromFrame(prof.frame)) as unknown as AnySketch)) {
      const route = () => path.wire ?? sketchPath(path.source!, path.frame, ev);
      let solid = genericSweep(r.outer, route(), config) as Shape3D;
      for (const w of r.inner) solid = solid.cut(genericSweep(w, route(), config) as Shape3D);
      out = out ? out.fuse(solid) : solid;
    }
    if (!out || !(measureShapeVolumeProperties(out).volume > 1e-9)) throw new Error("empty");
    return clean(out);
  } catch (e) {
    if (e instanceof FeatureError) throw e;
    throw new FeatureError(FRIENDLY.sweep!);
  }
}

function coilTool(f: CoilFeature, ev: Evaluator): Shape3D {
  const [px, py, pz] = f.position.map((p, i) => ev.num(p, "length", "XYZ"[i] + " position")) as Vec3;
  const r = ev.num(f.radius, "length", "Radius");
  const pitch = ev.num(f.pitch, "length", "Pitch");
  const h = ev.num(f.height, "length", "Height");
  const size = ev.num(f.size, "length", f.section === "circle" ? "Wire diameter" : "Depth");
  if (r <= 0 || pitch <= 0 || h <= 0 || size <= 0) throw new FeatureError("Radius, pitch, height and size must all be greater than zero.");
  if (h / pitch > 400) throw new FeatureError("That's more than 400 turns. Increase the pitch or reduce the height.");
  // The section's width along the axis has to fit inside one pitch.
  const tan30 = Math.tan(Math.PI / 6);
  const width = f.section === "circle" ? size : f.section === "triangle" ? size * 2 * tan30 : pitch / 2;
  if (width >= pitch * 0.98) {
    const fit = f.section === "circle" ? pitch * 0.9 : (pitch * 0.9) / (2 * tan30);
    throw new FeatureError(`The section is too large for a ${lenText(pitch)} pitch, so the turns would overlap.`, {
      label: `Use ${lenText(fit)}`,
      field: "size",
      value: `${lenText(fit)}`,
    });
  }
  if (f.section === "circle" && size / 2 >= r) throw new FeatureError("The wire is thicker than the coil radius. Increase the radius.");
  // Section in the axial plane at the helix start: x points away from the axis, y along it.
  const plane = new Plane([px + r, py, pz], [1, 0, 0], [0, -1, 0]);
  const overlap = size * 0.05;
  let d: Drawing;
  if (f.section === "circle") d = drawCircle(size / 2);
  else if (f.section === "triangle") d = polyDrawing([[-overlap, -width / 2], [size, 0], [-overlap, width / 2]]);
  else d = polyDrawing([[-overlap, -width / 2], [size, -width / 2], [size, width / 2], [-overlap, width / 2]]);
  const section = (d.sketchOnPlane(plane) as unknown as AnySketch).wire!;
  const helix = makeHelix(pitch, h, r, [px, py, pz], [0, 0, 1], f.lefthand);
  try {
    return clean(genericSweep(section, helix, { frenet: true }) as Shape3D);
  } catch {
    throw new FeatureError(FRIENDLY.coil!);
  }
}

const PULL: Record<"x" | "y" | "z", Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

function draftFaces(f: DraftFeature, bodies: Map<Id, Shape3D>, ev: Evaluator): string | undefined {
  if (f.faces.length === 0) throw new FeatureError("Click the side faces to draft.", undefined, true);
  const angle = ev.num(f.angle, "angle", "Angle");
  if (Math.abs(angle) < 1e-9) throw new FeatureError("The angle can't be zero.");
  if (Math.abs(angle) > Math.PI / 4) throw new FeatureError("Keep the draft angle under 45 degrees.");
  const neutral = ev.num(f.neutral, "length", "Neutral plane");
  const axis = PULL[f.pull];
  const bodyId = f.faces[0]!.bodyId;
  const body = bodyForRefs(bodies, bodyId);
  let warning: string | undefined;
  const oc = getOC();
  const builder = new oc.BRepOffsetAPI_DraftAngle(body.wrapped);
  try {
    const dir = asDir(scale(axis, f.flip ? -1 : 1));
    const pln = makePln(scale(axis, neutral), axis);
    for (const ref of f.faces) {
      if (ref.bodyId !== bodyId) throw new FeatureError("All drafted faces must belong to one body.");
      const res = resolveFace(body, ref);
      if (!res) throw new FeatureError("A face to draft no longer exists. Edit the draft to re-pick it.");
      if (res.uncertain) warning = "A face moved after an upstream change. Please check the selection.";
      builder.Add(res.item.wrapped, dir, angle, pln, true);
      if (!builder.AddDone()) throw new FeatureError("One of the faces can't be drafted: pick side walls (parallel to the pull direction), not tops or curved freeform faces.");
    }
    builder.Build(new oc.Message_ProgressRange());
    if (!builder.IsDone()) throw new FeatureError(FRIENDLY.draft!);
    bodies.set(bodyId, clean(cast(downcast(builder.Shape())) as Shape3D));
  } finally {
    builder.delete();
  }
  return warning;
}

/** Press/Pull on flat faces: sweep each face along its normal and join (pull) or cut (push) the result. */
/** A pattern's direction or axis from what was clicked: a straight edge, a circle's axis, or a face's axis or normal. */
function pickedAxis(g: { edge?: EdgeRef; face?: FaceRef }, bodies: Map<Id, Shape3D>): { at: Vec3; dir: Vec3 } {
  if (g.edge) {
    const r = resolveEdge(bodyForRefs(bodies, g.edge.bodyId), g.edge);
    if (!r) throw new FeatureError("The edge for the direction is gone. Pick it again.");
    if (r.item.geomType === "CIRCLE") {
      const c = circleOf(r.item);
      if (c) return { at: c.c, dir: c.n };
    }
    const info = edgeInfo(r.item);
    if (info.curve !== "LINE") throw new FeatureError("Pick a straight edge, a circular edge or a round face for the direction.");
    return { at: info.mid, dir: info.tangent };
  }
  if (g.face) {
    const r = resolveFace(bodyForRefs(bodies, g.face.bodyId), g.face);
    if (!r) throw new FeatureError("The face for the direction is gone. Pick it again.");
    for (const e of r.item.edges) {
      const c = e.geomType === "CIRCLE" ? circleOf(e) : null;
      if (c && r.item.geomType !== "PLANE") return { at: c.c, dir: c.n };
    }
    const info = faceInfo(r.item);
    if (info.surface === "PLANE") return { at: info.center, dir: info.normal };
    throw new FeatureError("Pick a flat or round face, or an edge, for the direction.");
  }
  throw new FeatureError("Click an edge or a face on the model for the direction.", undefined, true);
}

/**
 * Shell the long way: the body less its inward offset, opened through each removed (flat) face. Used when
 * OpenCascade's thick solid fails, which it does whenever a fillet runs into an open face.
 */
/**
 * A body grown (d > 0) or shrunk (d < 0) with sharp, intersecting joins: every corner stays a corner, and it is quick on
 * shapes where the rounded offset can stall for good.
 */
function offsetSharp(body: Shape3D, d: number): Shape3D {
  const oc = getOC();
  const b = new oc.BRepOffsetAPI_MakeOffsetShape();
  try {
    b.PerformByJoin(body.wrapped, d, 1e-4, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Intersection, false, new oc.Message_ProgressRange());
    const s = cast(downcast(b.Shape())) as unknown as Shape3D;
    return s.constructor.name === "Shell" ? (makeSolid([s as never]) as unknown as Shape3D) : s;
  } finally {
    b.delete();
  }
}

/** A cone that ends in a point (not a truncated one). OpenCascade's rounded offset never returns when it has to round that tip. */
function hasConeTip(shape: Shape3D): boolean {
  // The tip appears as a circle edge of no length.
  return shape.faces.some((f) => f.geomType === "CONE" && f.edges.some((e) => e.geomType === "CIRCLE" && e.length < 1e-6));
}

function shellBySubtraction(body: Shape3D, faces: Face[], t: number, outward = 0): Shape3D {
  const before = measureShapeVolumeProperties(body).volume;
  /** The body grown (`grow`) or shrunk by `d`, with sharp (intersection) joins: rounded ones fail once the wall is thicker than a fillet's radius. */
  const offsetBody = (d: number, grow: boolean): Shape3D => {
    // ponytail: an offset exactly equal to a fillet radius degenerates; a hair more gives the sharp inner corner.
    const started = performance.now();
    for (const k of [1, 1.001, 1.01]) {
      // A slow failure (a wall as thick as the body is) only gets slower with a hair more: give up rather than freeze.
      if (performance.now() - started > 2500) break;
      try {
        const s = offsetSharp(body, grow ? d * k : -d * k);
        const v = measureShapeVolumeProperties(s).volume;
        if (grow ? v > before : v > 1e-9 && v < before) return s;
      } catch {
        /* next */
      }
    }
    throw new Error("no offset");
  };
  const inner = t > 0 ? offsetBody(t, false) : body;
  const outer = outward > 0 ? offsetBody(outward, true) : body;
  let cutter: Shape3D = inner;
  for (const face of faces) {
    if (face.geomType !== "PLANE") throw new Error("curved opening");
    const { center, normal } = faceInfo(face);
    // The inner solid's copy of this face, pushed out through the wall.
    const under =
      t > 0
        ? inner.faces.find((x) => {
            if (x.geomType !== "PLANE") return false;
            const i = faceInfo(x);
            return dot(i.normal, normal) > 0.999 && Math.abs(dot(subv(i.center, center), normal) + t) < Math.max(1e-3, t * 0.01);
          })
        : face;
    if (!under) throw new Error("no inner face");
    cutter = cutter.fuse(basicFaceExtrusion(under, new Vector(scale(normal, (t + outward) * 1.5))) as unknown as Shape3D);
  }
  const out = clean(outer.cut(cutter));
  if (!(measureShapeVolumeProperties(out).volume > 1e-9)) throw new Error("empty");
  return out;
}

function offsetFaces(f: OffsetFaceFeature, bodies: Map<Id, Shape3D>, ev: Evaluator): string | undefined {
  if (f.faces.length === 0) throw new FeatureError("Click the flat faces to push or pull.", undefined, true);
  const d = ev.num(f.distance, "length", "Distance");
  if (Math.abs(d) < 1e-9) throw new FeatureError("The distance can't be zero.");
  const bodyId = f.faces[0]!.bodyId;
  const body = bodyForRefs(bodies, bodyId);
  let warning: string | undefined;
  // Resolve every face against the untouched body first; the prisms are then applied together.
  const prisms: Shape3D[] = [];
  for (const ref of f.faces) {
    if (ref.bodyId !== bodyId) throw new FeatureError("All faces must belong to one body.");
    const res = resolveFace(body, ref);
    if (!res) throw new FeatureError("A face to move no longer exists. Edit the feature to re-pick it.");
    if (res.uncertain) warning = "A face moved after an upstream change. Please check the selection.";
    if (res.item.geomType !== "PLANE") throw new FeatureError("Only flat faces can be pushed or pulled. For a hole or boss, edit its feature instead.");
    const n = res.item.normalAt();
    prisms.push(basicFaceExtrusion(res.item, n.multiply(d)) as unknown as Shape3D);
  }
  try {
    let out = body;
    for (const p of prisms) out = d > 0 ? out.fuse(p) : out.cut(p);
    if (!(measureShapeVolumeProperties(out).volume > 1e-9)) throw new Error("empty");
    bodies.set(bodyId, clean(out));
  } catch {
    throw new FeatureError("The faces couldn't be moved that far. Try a smaller distance.");
  }
  return warning;
}

const importKeys = new Map<Id, { data: string; key: string }>();

/** Identifies an embedded file by its whole content (hashed once per distinct string, not on every rebuild). */
function importKey(f: { id: Id; data: string }): string {
  const known = importKeys.get(f.id);
  if (known && known.data === f.data) return known.key;
  const key = `${f.id}:${f.data.length}:${hashKey(f.data)}`;
  importKeys.set(f.id, { data: f.data, key });
  return key;
}

/** The sketch's regions, each meshed for picking; undefined when they can't be worked out (picking regions is then unavailable). */
function builtRegions(source: SketchFeature, frame: SketchFrame, ev: Evaluator): BuiltRegion[] | undefined {
  try {
    const drawings = sketchRegionDrawings(source, ev);
    if (!drawings || drawings.length < 2) return undefined;
    return drawings.map((drawing) => {
      const fill = profileFill(drawing, frame);
      const local = new Float32Array(((fill?.length ?? 0) / 3) * 2);
      let best = -1;
      let at: [number, number] = [0, 0];
      for (let v = 0; fill && v < fill.length / 3; v++) {
        const d: Vec3 = [fill[v * 3]! - frame.origin[0], fill[v * 3 + 1]! - frame.origin[1], fill[v * 3 + 2]! - frame.origin[2]];
        local[v * 2] = dot(d, frame.xDir);
        local[v * 2 + 1] = dot(d, frame.yDir);
      }
      // The centre of the largest triangle is safely inside, even for rings and crescents.
      for (let t = 0; t + 5 < local.length; t += 6) {
        const [ax, ay, bx, by, cx, cy] = local.subarray(t, t + 6) as unknown as number[];
        const area = Math.abs((bx! - ax!) * (cy! - ay!) - (cx! - ax!) * (by! - ay!));
        if (area > best) {
          best = area;
          at = [Math.round(((ax! + bx! + cx!) / 3) * 1000) / 1000, Math.round(((ay! + by! + cy!) / 3) * 1000) / 1000];
        }
      }
      return { drawing, fill, local, at };
    });
  } catch {
    return undefined;
  }
}

function inTriangles(local: Float32Array, [x, y]: [number, number]): boolean {
  for (let t = 0; t + 5 < local.length; t += 6) {
    const [ax, ay, bx, by, cx, cy] = local.subarray(t, t + 6) as unknown as number[];
    const d1 = (x - bx!) * (ay! - by!) - (ax! - bx!) * (y - by!);
    const d2 = (x - cx!) * (by! - cy!) - (bx! - cx!) * (y - cy!);
    const d3 = (x - ax!) * (cy! - ay!) - (cx! - ax!) * (y - ay!);
    if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return true;
  }
  return false;
}

/** Why a sketch gives no closed shape, pointing at the gap when two curves almost meet. */
function noClosedShapes(sk: SketchBuilt): string {
  const gap = sk.source ? sketchGap(sk.source, sk.solution) : null;
  if (!gap) return "The sketch has no closed shapes yet. Draw a rectangle or circle first.";
  const at = `(${lengthText(gap.at[0], unitName, 2)}, ${lengthText(gap.at[1], unitName, 2)})`;
  return `The sketch has no closed shapes yet: an end near ${at} stops ${lengthText(gap.gap, unitName, 4)} ${unitName} short of meeting a curve. Drag that end onto the curve to close the shape.`;
}

/** The chosen regions of a sketch fused into one profile. A point that no longer falls in any region takes the nearest one, with a warning. */
function regionProfile(sk: SketchBuilt, points: [number, number][]): { drawing: Drawing; warning?: string } {
  const regions = sk.regions ?? [];
  if (!regions.length) {
    if (!sk.drawing) throw new FeatureError(noClosedShapes(sk));
    return { drawing: sk.drawing };
  }
  const chosen = new Set<BuiltRegion>();
  let moved = false;
  for (const p of points) {
    const hit = regions.find((r) => inTriangles(r.local, p));
    if (hit) chosen.add(hit);
    else {
      moved = true;
      chosen.add(regions.reduce((a, b) => (Math.hypot(a.at[0] - p[0], a.at[1] - p[1]) <= Math.hypot(b.at[0] - p[0], b.at[1] - p[1]) ? a : b)));
    }
  }
  const drawing = [...chosen].map((r) => r.drawing.clone()).reduce((a, b) => a.fuse(b));
  return { drawing, warning: moved ? "The sketch changed, so a chosen profile was matched to the nearest area. Check the selected profiles." : undefined };
}

/** Triangles from several fills in one array. */
function joinFills(fills: (Float32Array | undefined)[]): Float32Array {
  const out = new Float32Array(fills.reduce((n, f) => n + (f?.length ?? 0), 0));
  let at = 0;
  for (const f of fills) if (f) out.set(f, at), (at += f.length);
  return out;
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
/** The length unit of the design being built: messages and one-click fixes use it (audit C-9). */
let unitName: LengthUnit = "mm";
const lenText = (mm: number) => `${lengthText(mm, unitName, 2)} ${unitName}`;

/**
 * Find (roughly) the largest value below `start` for which `attempt` succeeds. Each attempt is a whole failed build, so on
 * a heavy body the search is cut short after `budgetMs`: a quick "can't be applied" beats a minute of looking for a number.
 */
function largestWorking(start: number, attempt: (v: number) => unknown, budgetMs = 6000): number | null {
  const t0 = performance.now();
  const spent = () => performance.now() - t0 > budgetMs;
  let lo: number | null = null;
  let hi = start;
  for (const k of [0.9, 0.75, 0.5, 0.25, 0.1]) {
    if (spent()) return null;
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
  for (let i = 0; i < 4 && !spent(); i++) {
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
  const [min, max] = shapeBounds(shape);
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
  let inertia: BodyResult["inertia"];
  try {
    const props = measureShapeVolumeProperties(shape);
    // Surfaces (shells, loose faces) have no volume, whatever the integral says about their open shape.
    if (hasSolid(shape)) {
      volume = props.volume;
      centerOfMass = props.centerOfMass;
      inertia = inertiaTensor(props, centerOfMass);
    }
    area = measureArea(shape);
  } catch {
    /* shells or compounds without volume */
  }
  // Face -> boundary edges, matched through hash buckets (isSame is exact but slow).
  const byHash = new Map<number, number[]>();
  edges.forEach((e, i) => {
    const h = e.hashCode;
    const list = byHash.get(h);
    if (list) list.push(i);
    else byHash.set(h, [i]);
  });
  const faceEdges = faces.map((f) => {
    const out: number[] = [];
    for (const e of f.edges) {
      const i = (byHash.get(e.hashCode) ?? []).find((k) => edges[k]!.isSame(e));
      if (i !== undefined && !out.includes(i)) out.push(i);
    }
    return out;
  });

  return {
    id,
    faceEdges,
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
    inertia,
    bbox: [min, max],
  };
}

/**
 * The inertia tensor about `com` for unit density, from the moments about six axes through it: the three coordinate
 * axes give Ixx, Iyy, Izz, and the moment about a diagonal axis n gives the product term (I(n) = (Ia + Ib) / 2 + I_ab).
 */
function inertiaTensor(props: ReturnType<typeof measureShapeVolumeProperties>, com: Vec3): BodyResult["inertia"] {
  const oc = getOC();
  const about = (d: Vec3): number => {
    const n = Math.hypot(...d);
    const pt = new oc.gp_Pnt(com[0], com[1], com[2]);
    const dir = new oc.gp_Dir(d[0] / n, d[1] / n, d[2] / n);
    const ax = new oc.gp_Ax1(pt, dir);
    try {
      return props.wrapped.MomentOfInertia(ax);
    } finally {
      pt.delete();
      dir.delete();
      ax.delete();
    }
  };
  try {
    const [ixx, iyy, izz] = [about([1, 0, 0]), about([0, 1, 0]), about([0, 0, 1])];
    const ixy = about([1, 1, 0]) - (ixx + iyy) / 2;
    const iyz = about([0, 1, 1]) - (iyy + izz) / 2;
    const izx = about([1, 0, 1]) - (izz + ixx) / 2;
    return [ixx, iyy, izz, ixy, iyz, izx].every(Number.isFinite) ? [ixx, iyy, izz, ixy, iyz, izx] : undefined;
  } catch {
    return undefined;
  }
}
