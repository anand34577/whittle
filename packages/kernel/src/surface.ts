/** Surface bodies: shells and faces (no volume) and the tools that make, edit and thicken them. */
import type { Evaluator, Id, SurfaceFeature, Vec3 } from "@whittle/core";
import {
  type Edge,
  type Face,
  type Shape3D,
  type Wire,
  Vector,
  assembleWire,
  cast,
  downcast,
  getOC,
  makeAx1,
  makeBox,
  makeCompound,
  makeFace,
  makeNonPlanarFace,
  makeOffset,
  makeSolid,
  measureShapeVolumeProperties,
  weldShellsAndFaces,
} from "replicad";
import type { SketchFrame } from "./protocol";
import { AXES, FeatureError, bodyForRefs, clean, hasSolid, orient } from "./build";
import { add, cross, dot, norm, resolveEdge, resolveFace, scale, sub } from "./refs";

const volume = (s: Shape3D) => {
  try {
    return measureShapeVolumeProperties(s).volume;
  } catch {
    return 0;
  }
};

/** Is this shape a closed solid with volume? */
export const isSolid = (s: Shape3D) => hasSolid(s);

/** The prism of wires along a vector: the side surfaces only (no end caps). */
export function prismSurface(wires: Wire[], vec: Vec3): Shape3D {
  const oc = getOC();
  const parts = wires.map((w) => {
    const p = new oc.BRepPrimAPI_MakePrism(w.wrapped, new Vector(vec).wrapped, false, true);
    try {
      p.Build(new oc.Message_ProgressRange());
      return cast(downcast(p.Shape())) as unknown as Shape3D;
    } finally {
      p.delete();
    }
  });
  return parts.length === 1 ? parts[0]! : (makeCompound(parts) as unknown as Shape3D);
}

/** The surfaces swept by wires turning about an axis. */
export function revolveSurface(wires: Wire[], origin: Vec3, dir: Vec3, radians: number): Shape3D {
  const oc = getOC();
  const parts = wires.map((w) => {
    const r = new oc.BRepPrimAPI_MakeRevol(w.wrapped, makeAx1(origin, dir), radians, false);
    try {
      r.Build(new oc.Message_ProgressRange());
      return cast(downcast(r.Shape())) as unknown as Shape3D;
    } finally {
      r.delete();
    }
  });
  return parts.length === 1 ? parts[0]! : (makeCompound(parts) as unknown as Shape3D);
}

/** A solid with the inside out (negative volume) turned the right way round. */
function fixSolid(s: Shape3D): Shape3D {
  if (volume(s) >= 0) return s;
  return cast(downcast((s as unknown as { wrapped: { Reversed(): never } }).wrapped.Reversed())) as unknown as Shape3D;
}

/** Give a surface thickness: `t` along its normals (negative the other way), or `t` centered on it. */
export function thicken(shape: Shape3D, t: number, both: boolean): Shape3D {
  const oc = getOC();
  const one = (d: number): Shape3D => {
    const m = new oc.BRepOffsetAPI_MakeThickSolid();
    try {
      m.MakeThickSolidBySimple((shape as unknown as { wrapped: never }).wrapped, d);
      m.Build(new oc.Message_ProgressRange());
      return fixSolid(cast(downcast(m.Shape())) as unknown as Shape3D);
    } finally {
      m.delete();
    }
  };
  if (!both) return one(t);
  const a = one(t / 2);
  const b = one(-t / 2);
  return a.fuse(b);
}

/** Sew faces and shells into one shell; a closed result becomes a solid. */
export function stitch(shapes: Shape3D[]): Shape3D {
  const faces: Face[] = shapes.flatMap((s) => s.faces as Face[]);
  if (faces.length === 0) throw new FeatureError("There are no surfaces to join.");
  if (faces.length === 1) return faces[0] as unknown as Shape3D;
  const shell = weldShellsAndFaces(faces);
  try {
    const solid = makeSolid([shell]) as unknown as Shape3D;
    const fixed = fixSolid(solid);
    if (volume(fixed) > 1e-9) return fixed;
  } catch {
    /* still open */
  }
  return shell as unknown as Shape3D;
}

const reverseShape = (s: Shape3D): Shape3D => cast(downcast((s as unknown as { wrapped: { Reversed(): never } }).wrapped.Reversed())) as unknown as Shape3D;

export function surfaceTool(
  f: SurfaceFeature,
  bodies: Map<Id, Shape3D>,
  planeOf: (id: Id) => SketchFrame | undefined,
  ev: Evaluator,
): string | undefined {
  let warning: string | undefined;
  const target = (): { id: Id; shape: Shape3D } => {
    const id = f.bodyId ?? (f.faces[0]?.bodyId);
    if (!id || !bodies.has(id)) throw new FeatureError("Click the body to work on.", undefined, true);
    return { id, shape: bodies.get(id)! };
  };
  const dist = () => ev.num(f.distance, "length", "Distance");
  const faceOf = (ref: SurfaceFeature["faces"][number]): { face: Face; shape: Shape3D } => {
    const shape = bodyForRefs(bodies, ref.bodyId);
    const r = resolveFace(shape, ref);
    if (!r) throw new FeatureError("A face is gone. Pick it again.");
    if (r.uncertain) warning = "A face moved after an upstream change. Please check the selection.";
    return { face: r.item, shape };
  };
  switch (f.op) {
    case "patch": {
      if (f.edges.length < 2) throw new FeatureError("Click the edges around the opening (they have to form a closed loop).", undefined, true);
      const edges = f.edges.map((ref) => {
        const r = resolveEdge(bodyForRefs(bodies, ref.bodyId), ref);
        if (!r) throw new FeatureError("An edge is gone. Pick it again.");
        return r.item as Edge;
      });
      try {
        const face = makeNonPlanarFace(assembleWire(edges));
        bodies.set(f.id, face as unknown as Shape3D);
      } catch {
        throw new FeatureError("The edges don't form a closed loop, so there's nothing to fill. Pick every edge around the opening.");
      }
      return warning;
    }
    case "ruled": {
      if (!f.edges.length) throw new FeatureError("Click the edges to extend into a surface.", undefined, true);
      const d = dist();
      if (Math.abs(d) < 1e-9) throw new FeatureError("The distance can't be zero.");
      const parts: Shape3D[] = [];
      for (const ref of f.edges) {
        const shape = bodyForRefs(bodies, ref.bodyId);
        const r = resolveEdge(shape, ref);
        if (!r) throw new FeatureError("An edge is gone. Pick it again.");
        const e = r.item as Edge;
        const mid = e.pointAt(0.5).toTuple();
        const t = norm(e.tangentAt(0.5).toTuple());
        // The face the edge belongs to tells which way is "out".
        const owner = (shape.faces as Face[]).find((fc) => (fc.edges as Edge[]).some((x) => x.isSame(e)));
        let dir: Vec3;
        if (f.direction === "axis") dir = AXES[f.axis];
        else if (!owner) throw new FeatureError("This edge has no face to follow. Use a direction instead.");
        else {
          const n = norm(owner.normalAt(owner.pointOnSurface(0.5, 0.5)).toTuple());
          const c = owner.center.toTuple();
          if (f.direction === "normal") dir = n;
          else {
            dir = norm(cross(t, n));
            if (dot(dir, sub(mid, c)) < 0) dir = scale(dir, -1);
          }
        }
        parts.push(prismSurface([assembleWire([e])], scale(dir, d)));
      }
      bodies.set(f.id, parts.length === 1 ? parts[0]! : (makeCompound(parts) as unknown as Shape3D));
      return warning;
    }
    case "offset": {
      if (!f.faces.length) throw new FeatureError("Click the faces to offset into a surface.", undefined, true);
      const d = dist();
      const parts: Shape3D[] = f.faces.map((ref) => {
        const { face } = faceOf(ref);
        if (Math.abs(d) < 1e-9) return face.clone() as unknown as Shape3D;
        try {
          return makeOffset(face, d, 1e-4);
        } catch {
          throw new FeatureError("That face can't be offset by that much. Try a smaller distance.");
        }
      });
      bodies.set(f.id, parts.length === 1 ? parts[0]! : (makeCompound(parts) as unknown as Shape3D));
      return warning;
    }
    case "trim": {
      const { id, shape } = target();
      const ref = f.planeRef ? planeOf(f.planeRef) : undefined;
      if (f.planeRef && !ref) throw new FeatureError("The construction plane is missing. Pick another plane.");
      const off = ev.num(f.offset, "length", "Offset");
      const fr = ref ?? { origin: [0, 0, 0] as Vec3, normal: f.plane === "XY" ? ([0, 0, 1] as Vec3) : f.plane === "XZ" ? ([0, 1, 0] as Vec3) : ([1, 0, 0] as Vec3) };
      const q = add(fr.origin, scale(fr.normal, off));
      const [lo, hi] = shape.boundingBox.bounds;
      const span = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 3 + 100;
      // Remove the part on the chosen side of the plane.
      const side = f.keep === "above" ? scale(fr.normal, -1) : fr.normal;
      const tool = orient(makeBox([-span, -span, 0], [span, span, span]), side, q);
      const out = shape.cut(tool);
      if (!out.faces.length) throw new FeatureError("That removes the whole surface. Move the plane or switch the side to keep.");
      bodies.set(id, out);
      return warning;
    }
    case "untrim": {
      if (!f.faces.length) throw new FeatureError("Click the faces to restore (their holes get filled).", undefined, true);
      const parts: Shape3D[] = f.faces.map((ref) => {
        const { face } = faceOf(ref);
        if (face.geomType !== "PLANE") throw new FeatureError("Untrim works on flat faces.");
        const outer = (face.clone() as unknown as { outerWire(): Wire }).outerWire();
        const holes = (face as unknown as { wires: Wire[] }).wires.filter((w) => !w.isSame(outer));
        if (!holes.length) throw new FeatureError("That face has no holes to fill.");
        return makeFace(outer) as unknown as Shape3D;
      });
      bodies.set(f.id, parts.length === 1 ? parts[0]! : (makeCompound(parts) as unknown as Shape3D));
      return warning;
    }
    case "extend": {
      if (!f.faces.length) throw new FeatureError("Click the flat faces to extend.", undefined, true);
      const d = dist();
      if (Math.abs(d) < 1e-9) throw new FeatureError("The distance can't be zero.");
      const parts: Shape3D[] = f.faces.map((ref) => {
        const { face } = faceOf(ref);
        if (face.geomType !== "PLANE") throw new FeatureError("Extend works on flat faces.");
        try {
          return makeFace((face.clone() as unknown as { outerWire(): Wire }).outerWire().offset2D(d, "intersection")) as unknown as Shape3D;
        } catch {
          throw new FeatureError("The face can't grow (or shrink) by that much.");
        }
      });
      bodies.set(f.id, parts.length === 1 ? parts[0]! : (makeCompound(parts) as unknown as Shape3D));
      return warning;
    }
    case "stitch": {
      const ids = f.bodies.filter((b) => bodies.has(b));
      if (!ids.length) throw new FeatureError("Click the surface bodies to join.", undefined, true);
      let out: Shape3D;
      try {
        out = stitch(ids.map((i) => bodies.get(i)!));
      } catch (e) {
        if (e instanceof FeatureError) throw e;
        throw new FeatureError("The surfaces couldn't be joined: their edges have to meet exactly (no gaps or overlaps).");
      }
      for (const i of ids) bodies.delete(i);
      bodies.set(f.id, out);
      return undefined;
    }
    case "unstitch": {
      const { id, shape } = target();
      const faces = shape.faces as Face[];
      if (faces.length < 2) throw new FeatureError("There's only one face here.");
      bodies.set(id, makeCompound(faces.map((fc) => fc.clone())) as unknown as Shape3D);
      return undefined;
    }
    case "merge": {
      const { id, shape } = target();
      bodies.set(id, clean(shape));
      return undefined;
    }
    case "reverse": {
      const { id, shape } = target();
      bodies.set(id, reverseShape(shape));
      return undefined;
    }
    case "thicken": {
      const { id, shape } = target();
      const t = dist();
      if (Math.abs(t) < 1e-9) throw new FeatureError("The thickness can't be zero.");
      if (isSolid(shape)) throw new FeatureError("This body is already a solid. Thicken works on surfaces.");
      try {
        const solid = thicken(shape, t, !!f.both);
        if (!(volume(solid) > 1e-9)) throw new Error("empty");
        if (!f.keep2) bodies.delete(id);
        bodies.set(f.id, clean(solid));
      } catch (e) {
        if (e instanceof FeatureError) throw e;
        throw new FeatureError("The surface couldn't be thickened that much. Try a smaller thickness.");
      }
      return undefined;
    }
  }
}

