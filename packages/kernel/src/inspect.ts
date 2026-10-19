/** Model checks that need the real solids (interference between bodies, tight inside corners), and text outlines for 2D export. */
import { type Id, type Vec3, type WhittleDocument, documentEvaluator, resolveEntity } from "@whittle/core";
import { type Edge, type Shape3D, getOC, measureShapeVolumeProperties } from "replicad";
import { circleOf } from "./construct";
import { dot, sub } from "./refs";
import { drawingLoops, entityDrawing } from "./shared";
import type { InterferenceItem, MeasurePick, RadiusItem } from "./protocol";

const volume = (s: Shape3D) => measureShapeVolumeProperties(s).volume;

/** The shortest distance between two picked faces, edges or bodies, and where it runs. */
export function minDistance(shapes: Map<Id, Shape3D>, picks: MeasurePick[]): { d: number; a: Vec3; b: Vec3 } | null {
  const shapeOf = (p: MeasurePick) => {
    const s = shapes.get(p.bodyId);
    if (!s) return undefined;
    return p.kind === "face" ? s.faces[p.index!] : p.kind === "edge" ? s.edges[p.index!] : s;
  };
  const [sa, sb] = picks.map(shapeOf);
  if (picks.length !== 2 || !sa || !sb) return null;
  const oc = getOC();
  const q = new oc.BRepExtrema_DistShapeShape();
  try {
    q.LoadS1(sa.wrapped);
    q.LoadS2(sb.wrapped);
    q.Perform();
    if (!q.IsDone() || q.NbSolution() < 1) return null;
    const pt = (p: { X(): number; Y(): number; Z(): number }): Vec3 => [p.X(), p.Y(), p.Z()];
    return { d: q.Value(), a: pt(q.PointOnShape1(1)), b: pt(q.PointOnShape2(1)) };
  } finally {
    q.delete();
  }
}

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

/** The outlines of every text shape, sketch by sketch (for exporting a sketch to DXF or SVG). */
export function textOutlines(doc: WhittleDocument): { sketchId: Id; loops: [number, number][][] }[] {
  const ev = documentEvaluator(doc);
  const out: { sketchId: Id; loops: [number, number][][] }[] = [];
  for (const f of doc.features) {
    if (f.type !== "sketch") continue;
    const loops: [number, number][][] = [];
    for (const e of f.entities) {
      if (e.type !== "text" || e.construction) continue;
      try {
        loops.push(...drawingLoops(entityDrawing(resolveEntity(e, ev))));
      } catch {
        /* a text with a bad value is skipped, as it is when building */
      }
    }
    if (loops.length) out.push({ sketchId: f.id, loops });
  }
  return out;
}
