/**
 * Persistent references ("topological naming").
 *
 * Users pick faces and edges; indices change whenever upstream geometry
 * changes, so we store a geometric fingerprint instead and re-resolve it on
 * every rebuild:
 *
 *   1. keep candidates of the same surface/curve type and orientation;
 *   2. if exactly one remains it is the match, even if it moved, unless its size changed
 *      more than 4x or it moved more than 3x its own size (then it is flagged);
 *   3. otherwise take the closest one, and flag a warning when the choice is
 *      ambiguous so the user can confirm instead of getting a silent wrong pick.
 */
import type { EdgeRef, FaceRef, Vec3 } from "@whittle/core";
import { type Edge, type Face, type Shape3D, measureArea } from "replicad";
import type { EdgeInfo, FaceInfo } from "./protocol";

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: Vec3, b: Vec3) => len(sub(a, b));
export const norm = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function faceInfo(face: Face): FaceInfo {
  const c = face.center;
  const center = c.toTuple();
  let normal: Vec3 = [0, 0, 1];
  try {
    normal = norm(face.normalAt(c).toTuple());
  } catch {
    /* degenerate faces keep the default normal */
  }
  let area = 0;
  try {
    area = measureArea(face);
  } catch {
    /* ignore */
  }
  return { center, normal, surface: face.geomType, area };
}

export function edgeInfo(edge: Edge): EdgeInfo {
  let mid: Vec3 = [0, 0, 0];
  let tangent: Vec3 = [1, 0, 0];
  try {
    mid = edge.pointAt(0.5).toTuple();
    tangent = norm(edge.tangentAt(0.5).toTuple());
  } catch {
    mid = edge.startPoint.toTuple();
  }
  const info: EdgeInfo = { mid, tangent, curve: edge.geomType, length: edge.length };
  try {
    const a = edge.startPoint.toTuple();
    const b = edge.endPoint.toTuple();
    info.ends = [a, b];
    try {
      info.endTangents = [norm(edge.tangentAt(0).toTuple()), norm(edge.tangentAt(1).toTuple())];
    } catch {
      /* some curves can't report an end tangent: they just aren't chained */
    }
    if (info.curve === "CIRCLE") {
      const p = edge.pointAt(0.25).toTuple();
      const q = edge.pointAt(0.75).toTuple();
      info.radius = circumradius(a, p, q);
    }
  } catch {
    /* optional extras */
  }
  return info;
}

function circumradius(a: Vec3, b: Vec3, c: Vec3): number {
  const ab = dist(a, b);
  const bc = dist(b, c);
  const ca = dist(c, a);
  const area2 = len(cross(sub(b, a), sub(c, a)));
  return area2 > 1e-12 ? (ab * bc * ca) / (2 * area2) : 0;
}

export interface Resolved<T> {
  item: T;
  /** True when the match was a judgement call the user should confirm. */
  uncertain: boolean;
}

function pick<T>(
  items: T[],
  scoreDistance: (i: number) => number,
  compatible: (i: number) => boolean,
  tolerance: number,
  /** False when a lone candidate has changed too much to trust as the same thing. */
  plausible: (i: number) => boolean = () => true,
): Resolved<T> | null {
  const ranked = items
    .map((item, i) => ({ item, i, d: scoreDistance(i), ok: compatible(i) }))
    .filter((r) => r.ok)
    .sort((a, b) => a.d - b.d);
  if (ranked.length === 0) return null;
  if (ranked.length === 1) return { item: ranked[0]!.item, uncertain: ranked[0]!.d > tolerance && !plausible(ranked[0]!.i) };
  const [best, second] = ranked;
  if (best!.d <= tolerance) return { item: best!.item, uncertain: false };
  // Two candidates nearly equally close: ambiguous.
  const uncertain = second!.d < best!.d * 2;
  return { item: best!.item, uncertain };
}

/** A lone same-kind candidate is trusted unless its size changed more than 4x or it moved more than 3x its own size. */
function jumpOk(now: number, was: number, moved: number, size: number): boolean {
  const lo = Math.min(now, was);
  const hi = Math.max(now, was);
  if (lo > 0 && hi / lo > 4) return false;
  return moved <= 3 * size;
}

export function resolveFace(shape: Shape3D, ref: FaceRef, infos?: FaceInfo[]): Resolved<Face> | null {
  const faces = shape.faces;
  const fi = infos ?? faces.map(faceInfo);
  const strict = pick(
    faces,
    (i) => dist(fi[i]!.center, ref.center),
    (i) => fi[i]!.surface === ref.surface && dot(fi[i]!.normal, ref.normal) > 0.999,
    1e-4,
    (i) => jumpOk(fi[i]!.area, ref.area, dist(fi[i]!.center, ref.center), Math.sqrt(Math.max(ref.area, fi[i]!.area))),
  );
  if (strict) return strict;
  // Fall back to the closest roughly-aligned face, and flag it.
  const loose = pick(
    faces,
    (i) => dist(fi[i]!.center, ref.center),
    (i) => dot(fi[i]!.normal, ref.normal) > 0.9,
    0,
  );
  return loose ? { item: loose.item, uncertain: true } : null;
}

export function resolveEdge(shape: Shape3D, ref: EdgeRef, infos?: EdgeInfo[]): Resolved<Edge> | null {
  const edges = shape.edges;
  const ei = infos ?? edges.map(edgeInfo);
  const strict = pick(
    edges,
    (i) => dist(ei[i]!.mid, ref.mid),
    (i) => ei[i]!.curve === ref.curve && Math.abs(dot(ei[i]!.tangent, ref.tangent)) > 0.999,
    1e-4,
    (i) => jumpOk(ei[i]!.length, ref.length, dist(ei[i]!.mid, ref.mid), Math.max(ref.length, ei[i]!.length)),
  );
  if (strict) return strict;
  const loose = pick(
    edges,
    (i) => dist(ei[i]!.mid, ref.mid),
    (i) => Math.abs(dot(ei[i]!.tangent, ref.tangent)) > 0.9,
    0,
  );
  return loose ? { item: loose.item, uncertain: true } : null;
}