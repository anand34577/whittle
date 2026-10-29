/**
 * Changing a design's length unit (audit U-2). A bare number in a formula means the design's unit, so after the
 * change every formula reads its numbers in the new unit: "20" was 20 mm and is now 20 in. Values written with a
 * unit ("20 mm") keep their size. Everything stored in millimetres that was drawn against those numbers (sketch
 * geometry, its dimension labels, picked regions, the trace picture) is scaled with them, so a sketch keeps its
 * shape and its dimensions keep fitting. Embedded imports are real-world files and keep their size.
 */
import { LENGTH_TO_MM, type LengthUnit } from "./units";
import type { WhittleDocument } from "./model";

export function relabelUnits(doc: WhittleDocument, to: LengthUnit): void {
  const k = LENGTH_TO_MM[to] / LENGTH_TO_MM[doc.units];
  doc.units = to;
  if (k === 1) return;
  for (const f of doc.features) {
    const regions = (f as { regions?: [number, number][] }).regions;
    if (Array.isArray(regions)) for (const r of regions) (r[0] *= k), (r[1] *= k);
    if (f.type !== "sketch") continue;
    for (const g of f.geometry ?? []) {
      if (g.type === "point") (g.x *= k), (g.y *= k);
      else if (g.type === "circle" || g.type === "ellipse") g.r *= k;
    }
    for (const c of f.constraints ?? []) {
      if (!c.label) continue;
      // A radius or diameter label is [angle, distance]; the others are two lengths, or [radius, 0] for an angle.
      if (c.type === "radius" || c.type === "diameter") c.label = [c.label[0], c.label[1] * k];
      else c.label = [c.label[0] * k, c.label[1] * k];
    }
    if (f.image) (f.image.x *= k), (f.image.y *= k), (f.image.width *= k);
  }
}
