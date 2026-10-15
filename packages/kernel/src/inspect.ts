/** Model checks that need the real solids: interference between bodies and tight inside corners. */
import type { Id, Vec3 } from "@whittle/core";
import { type Edge, type Shape3D, measureShapeVolumeProperties } from "replicad";
import { circleOf } from "./construct";
import { dot, sub } from "./refs";
import type { InterferenceItem, RadiusItem } from "./protocol";

const volume = (s: Shape3D) => measureShapeVolumeProperties(s).volume;

/** Pairs of bodies whose solids overlap, with the overlapping volume and its bounding box. */
export function interference(shapes: Map<Id, Shape3D>): InterferenceItem[] {
  const ids = [...shapes.keys()];
  const out: InterferenceItem[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = shapes.get(ids[i]!)!;
      const b = shapes.get(ids[j]!)!;
      const [alo, ahi] = a.boundingBox.bounds;
      const [blo, bhi] = b.boundingBox.bounds;
      if ([0, 1, 2].some((k) => ahi[k]! < blo[k]! - 1e-6 || bhi[k]! < alo[k]! - 1e-6)) continue;
      try {
        const x = a.intersect(b) as Shape3D;
        const v = volume(x);
        if (v > 1e-6) out.push({ a: ids[i]!, b: ids[j]!, volume: v, bbox: x.boundingBox.bounds as [Vec3, Vec3] });
      } catch {
        /* touching or degenerate: not an overlap */
      }
    }
  }
  return out;
}

/** Round faces (cylinders) with their radius and whether they curve inward (a pocket corner a cutter has to fit into). */
export function radii(shapes: Map<Id, Shape3D>): RadiusItem[] {
  const out: RadiusItem[] = [];
  for (const [bodyId, shape] of shapes) {
    for (const face of shape.faces) {
      if (face.geomType !== "CYLINDRE") continue;
      const ring = (face.edges as Edge[]).find((e) => e.geomType === "CIRCLE");
      const c = ring ? circleOf(ring) : null;
      if (!c) continue;
      try {
        const p = face.pointOnSurface(0.5, 0.5);
        const n = face.normalAt(p).toTuple();
        const concave = dot(n, sub(c.c, p.toTuple())) > 0;
        out.push({ bodyId, radius: c.r, concave, center: face.center.toTuple(), normal: n });
      } catch {
        /* skip faces we can't sample */
      }
    }
  }
  return out;
}
