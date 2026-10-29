/** Sketch "Intersect": the outline where the model crosses the open sketch's plane, drawn into the sketch. */
import { type SketchEntity, chainSegments2D, lengthText, makeEntity, simplifyChain, sliceMesh } from "@whittle/core";
import { type Pick, sketchMutate, toast, useApp } from "./store";

/** Draw the intersection of the (selected, else all visible) bodies with the open sketch's plane into the sketch. */
export function intersectIntoSketch() {
  const s = useApp.getState();
  if (s.mode.kind !== "sketch") return;
  const frame = s.regen?.sketches.find((f) => f.id === (s.mode as { sketchId: string }).sketchId);
  if (!frame) return toast("info", "The sketch plane isn't ready yet.");
  const picked = new Set(s.selection.flatMap((p: Pick) => (p.kind === "body" || p.kind === "face" || p.kind === "edge" ? [p.bodyId] : [])));
  const bodies = (s.regen?.bodies ?? []).filter((b) => (picked.size ? picked.has(b.id) : s.doc.bodies[b.id]?.visible !== false));
  const segs = bodies.flatMap((b) => sliceMesh(b, frame.origin, frame.xDir, frame.yDir, frame.normal));
  if (!segs.length) return toast("info", "The model doesn't cross this sketch plane. Move the plane through the part first.");
  const chains = chainSegments2D(segs).map((c) => ({ ...c, pts: simplifyChain(c.pts, c.closed) })).filter((c) => c.pts.length >= (c.closed ? 3 : 2));
  if (chains.reduce((n, c) => n + c.pts.length, 0) > 4000) return toast("warn", "That section has too many points. Try selecting just one body.");
  // The slice is in mm; sketch fields are in the document unit.
  const len = (mm: number) => lengthText(mm, s.doc.units, 4);
  const entities: SketchEntity[] = chains.map((c) => {
    const e = makeEntity("polyline", c.pts[0]!, c.pts[1]!, s.doc.units);
    if (e.type === "polyline") {
      e.points = c.pts.map(([x, y]) => [len(x), len(y)]);
      if (!c.closed) e.open = true;
    }
    return e;
  });
  sketchMutate("Intersect", (sk) => void sk.entities.push(...(entities as typeof sk.entities)));
  toast("ok", `Drew ${entities.length} outline${entities.length > 1 ? "s" : ""} where the model crosses the plane.`);
}
