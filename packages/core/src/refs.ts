/** Relationships between features (used for safe delete, reorder and UI hints). */
import type { Feature, Id, WhittleDocument } from "./model";

/** Ids of features/bodies this feature reads from. */
export function featureInputs(f: Feature): Id[] {
  switch (f.type) {
    case "sketch":
      return f.plane.kind === "face" ? [f.plane.face.bodyId] : f.plane.kind === "construction" ? [f.plane.plane] : [];
    case "cplane":
      return f.plane.kind === "face" ? [f.plane.face.bodyId] : f.plane.kind === "construction" ? [f.plane.plane] : [];
    case "extrude":
    case "revolve":
      return [f.sketch, ...(f.target ? [f.target] : [])];
    case "primitive":
      return f.target ? [f.target] : [];
    case "fillet":
    case "chamfer":
      return [...new Set(f.edges.map((e) => e.bodyId))];
    case "shell":
      return [...new Set([...(f.bodyId ? [f.bodyId] : []), ...f.faces.map((x) => x.bodyId)])];
    case "mirror":
    case "pattern":
    case "move":
      return f.bodyId ? [f.bodyId] : [];
    case "hole":
      return f.face ? [f.face.bodyId] : [];
    case "loft":
      return [...f.sketches, ...(f.target ? [f.target] : [])];
    case "combine":
      return [...(f.target ? [f.target] : []), ...f.tools];
    case "sweep":
      return [f.profile, f.path, ...(f.target ? [f.target] : [])].filter(Boolean);
    case "coil":
      return f.target ? [f.target] : [];
    case "split":
    case "offset":
    case "scale":
      return f.bodyId ? [f.bodyId] : [];
    case "draft":
    case "offsetFace":
      return [...new Set(f.faces.map((x) => x.bodyId))];
    case "import":
      return [];
  }
}

/** Features that (directly or transitively) depend on the given feature. */
export function dependents(doc: WhittleDocument, id: Id): Feature[] {
  const out: Feature[] = [];
  const hit = new Set<Id>([id]);
  for (const f of doc.features) {
    if (f.id === id) continue;
    if (featureInputs(f).some((x) => hit.has(x))) {
      out.push(f);
      hit.add(f.id);
    }
  }
  return out;
}

/**
 * Why moving the feature at `from` to index `to` would break the design, or
 * null when the move is safe (every feature still comes after what it uses).
 */
export function reorderProblem(doc: WhittleDocument, from: number, to: number): string | null {
  const f = doc.features[from];
  if (!f || to < 0 || to >= doc.features.length || from === to) return from === to ? null : "There's nowhere to move it.";
  const order = [...doc.features];
  order.splice(from, 1);
  order.splice(to, 0, f);
  const seen = new Set<Id>();
  for (const g of order) {
    const missing = featureInputs(g).find((id) => !seen.has(id) && order.some((x) => x.id === id));
    if (missing) {
      const needed = order.find((x) => x.id === missing)!;
      return `${g.name} uses ${needed.name}, so it has to come after it.`;
    }
    seen.add(g.id);
  }
  return null;
}

/** Features that create a body with their own id (and so need body metadata). */
export function createsBody(f: Feature): boolean {
  switch (f.type) {
    case "extrude":
    case "revolve":
    case "primitive":
    case "loft":
    case "sweep":
    case "coil":
      return f.op === "new";
    case "split":
      return f.keep === "both";
    case "offset":
    case "scale":
      return f.copy;
    case "mirror":
    case "pattern":
      return !f.merge;
    case "move":
      return f.copy;
    case "import":
      return true;
    default:
      return false;
  }
}

/** A sketch is "consumed" once a downstream feature uses it (Fusion-style dimming). */
export function isSketchConsumed(doc: WhittleDocument, sketchId: Id): boolean {
  return doc.features.some(
    (f) =>
      ((f.type === "extrude" || f.type === "revolve") && f.sketch === sketchId) ||
      (f.type === "loft" && f.sketches.includes(sketchId)) ||
      (f.type === "sweep" && (f.profile === sketchId || f.path === sketchId)),
  );
}

/** Index after which the timeline is rolled back (exclusive end of active features). */
export function activeEnd(doc: WhittleDocument): number {
  return doc.rollback === null ? doc.features.length : Math.min(doc.rollback, doc.features.length);
}

/** Ids of bodies that exist at the end of the active timeline. */
export function bodyIdsBefore(doc: WhittleDocument, endIndex = activeEnd(doc)): Id[] {
  const ids: Id[] = [];
  doc.features.slice(0, endIndex).forEach((f) => {
    if (!f.suppressed && createsBody(f)) ids.push(f.id);
  });
  return ids;
}