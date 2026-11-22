/** Construction geometry from model references: planes, axes and points. */
import { CONSTRUCT_MODES, type ConstructFeature, type DatumKind, type Vec3, constructRefs, frameAxes } from "@whittle/core";
import type { Edge, Face, Shape3D } from "replicad";
import type { SketchFrame } from "./protocol";
import { add, byLength, cross, dist, dot, edgeInfo, faceInfo, len, norm, resolveEdge, resolveFace, scale, sub } from "./refs";

export interface ConstructEnv {
  body(id: string): Shape3D;
  datum(id: string): SketchFrame | undefined;
  angle(expr: string): number;
  num(expr: string): number;
  fail(message: string): Error;
}

/** Center, normal and radius of a circular edge. */
export function circleOf(e: Edge): { c: Vec3; n: Vec3; r: number } | null {
  try {
    const a = e.pointAt(0.1).toTuple();
    const b = e.pointAt(0.4).toTuple();
    const d = e.pointAt(0.8).toTuple();
    const u = sub(b, a);
    const v = sub(d, a);
    const w = cross(u, v);
    const w2 = dot(w, w);
    if (w2 < 1e-18) return null;
    const off = scale(add(scale(cross(w, u), dot(v, v)), scale(cross(v, w), dot(u, u))), 1 / (2 * w2));
    const c = add(a, off);
    return { c, n: norm(w), r: len(off) };
  } catch {
    return null;
  }
}

/** The line where two planes meet (null when parallel). */
export function planeIntersection(p1: Vec3, n1: Vec3, p2: Vec3, n2: Vec3): { p: Vec3; d: Vec3 } | null {
  const dr = cross(n1, n2);
  const l = len(dr);
  if (l < 1e-6) return null;
  const d = scale(dr, 1 / l);
  const h1 = dot(n1, p1);
  const h2 = dot(n2, p2);
  const den = dot(n1, cross(n2, d));
  const p = scale(add(scale(cross(n2, d), h1), scale(cross(d, n1), h2)), 1 / den);
  return { p, d };
}

function rotate(v: Vec3, k: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

const planeFrame = (id: string, origin: Vec3, normal: Vec3): SketchFrame => ({ id, origin, normal, ...frameAxes(normal), kind: "plane" });
const axisFrame = (id: string, origin: Vec3, dir: Vec3): SketchFrame => ({ id, origin, normal: dir, ...frameAxes(dir), kind: "axis" });
const pointFrame = (id: string, origin: Vec3): SketchFrame => ({ id, origin, normal: [0, 0, 1], xDir: [1, 0, 0], yDir: [0, 1, 0], kind: "point" });

export function constructFrame(f: ConstructFeature, env: ConstructEnv): { frame: SketchFrame; warning?: string } {
  let uncertain = false;
  const { planes, lines, points } = constructRefs(f);
  const allowed = CONSTRUCT_MODES[f.mode].datums;
  const datum = (id: string, kind: Exclude<DatumKind, "csys">): SketchFrame => {
    if (!allowed?.includes(kind)) throw env.fail(`This construction does not accept a datum ${kind}.`);
    if (id === f.id) throw env.fail("A datum cannot reference itself.");
    const frame = env.datum(id);
    if (!frame) throw env.fail("The referenced datum is unavailable. It must be earlier in the timeline, unsuppressed, and built successfully.");
    if (frame.kind !== kind) throw env.fail(`The referenced feature must be a datum ${kind}.`);
    return frame;
  };
  const face = (i: number, flat = false): { f: Face; c: Vec3; n: Vec3 } => {
    const ref = planes[i];
    if (!ref) throw env.fail(`Pick ${i === 0 ? "a face" : "another face"}.`);
    if (ref.kind !== "face") throw env.fail("This needs a model face.");
    const r = resolveFace(env.body(ref.face.bodyId), ref.face);
    if (!r) throw env.fail("A face this was built on is gone. Pick it again.");
    uncertain ||= r.uncertain;
    const info = faceInfo(r.item);
    if (flat && info.surface !== "PLANE") throw env.fail("This needs flat faces.");
    return { f: r.item, c: info.center, n: info.normal };
  };
  const plane = (i: number, flat = true): { c: Vec3; n: Vec3 } => {
    const ref = planes[i];
    if (!ref || ref.kind === "face") return face(i, flat);
    if (ref.kind !== "plane") throw env.fail("This needs a datum plane or face.");
    const frame = datum(ref.id, "plane");
    return { c: frame.origin, n: frame.normal };
  };
  const edge = (i: number, straight = false): { e: Edge; mid: Vec3; t: Vec3 } => {
    const ref = lines[i];
    if (!ref) throw env.fail(`Pick ${i === 0 ? "an edge" : "another edge"}.`);
    if (ref.kind !== "edge") throw env.fail("This needs a model edge.");
    const r = resolveEdge(env.body(ref.edge.bodyId), ref.edge);
    if (!r) throw env.fail("An edge this was built on is gone. Pick it again.");
    uncertain ||= r.uncertain;
    const info = edgeInfo(r.item);
    if (straight && info.curve !== "LINE") throw env.fail("This needs straight edges.");
    return { e: r.item, mid: info.mid, t: info.tangent };
  };
  const line = (i: number): { mid: Vec3; t: Vec3 } => {
    const ref = lines[i];
    if (!ref || ref.kind === "edge") return edge(i, true);
    if (ref.kind !== "axis") throw env.fail("This needs a datum axis or straight edge.");
    const frame = datum(ref.id, "axis");
    return { mid: frame.origin, t: frame.normal };
  };
  const pt = (i: number): Vec3 => {
    const ref = points[i];
    if (!ref) throw env.fail(`Pick ${i === 0 ? "a point" : "another point"}.`);
    switch (ref.kind) {
      case "xyz":
        return ref.at;
      case "point":
        return datum(ref.id, "point").origin;
      case "vertex": {
        const r = resolveEdge(env.body(ref.edge.bodyId), ref.edge);
        if (!r || r.item.geomType !== "LINE") throw env.fail("The edge locating this vertex is gone. Pick the vertex again.");
        const start = r.item.startPoint.toTuple();
        const end = r.item.endPoint.toTuple();
        const alignment = dot(norm(sub(end, start)), ref.edge.tangent);
        if (Math.abs(alignment) < 0.9) throw env.fail("The vertex direction changed. Pick the vertex again.");
        uncertain ||= r.uncertain;
        return (ref.end === 0) === (alignment > 0) ? start : end;
      }
      default:
        throw env.fail("This needs a datum point, vertex, or XYZ point.");
    }
  };
  const circle = (): { c: Vec3; n: Vec3; r: number } => {
    const tries: Edge[] = [];
    if (lines.length) tries.push(edge(0).e);
    else if (planes.length) tries.push(...face(0).f.edges);
    for (const e of tries) {
      if (e.geomType !== "CIRCLE") continue;
      const c = circleOf(e);
      if (c) return c;
    }
    throw env.fail("Pick a round face or circular edge.");
  };

  let frame: SketchFrame;
  switch (f.mode) {
    case "midplane": {
      const a = plane(0);
      const b = plane(1);
      const x = planeIntersection(a.c, a.n, b.c, b.n);
      if (!x) {
        const n = a.n;
        frame = planeFrame(f.id, add(a.c, scale(n, dot(sub(b.c, a.c), n) / 2)), n);
      } else {
        const n = norm(sub(a.n, b.n));
        frame = planeFrame(f.id, x.p, n);
      }
      break;
    }
    case "plane3": {
      const [a, b, c] = [pt(0), pt(1), pt(2)];
      const n = cross(sub(b, a), sub(c, a));
      if (len(n) < 1e-9) throw env.fail("The three points are in a line. Pick points that form a triangle.");
      frame = planeFrame(f.id, a, norm(n));
      break;
    }
    case "plane2e": {
      const a = line(0);
      const b = line(1);
      let n = cross(a.t, b.t);
      if (len(n) < 1e-6) n = cross(a.t, sub(b.mid, a.mid));
      else if (Math.abs(dot(norm(n), sub(b.mid, a.mid))) > 1e-3) throw env.fail("The two edges aren't in one plane (they skew past each other).");
      if (len(n) < 1e-9) throw env.fail("The two edges are on one line. Pick edges that span a plane.");
      frame = planeFrame(f.id, a.mid, norm(n));
      break;
    }
    case "planeEdge": {
      const a = line(0);
      let n0: Vec3;
      if (planes.length) n0 = plane(0, false).n;
      else n0 = Math.abs(dot(a.t, [0, 0, 1])) > 0.99 ? [1, 0, 0] : [0, 0, 1];
      n0 = sub(n0, scale(a.t, dot(n0, a.t)));
      if (len(n0) < 1e-9) throw env.fail("The rotation axis is perpendicular to the reference plane.");
      n0 = norm(n0);
      frame = planeFrame(f.id, a.mid, rotate(n0, a.t, env.angle(f.value)));
      break;
    }
    case "planeTangent": {
      const c = circle();
      const { xDir, yDir } = frameAxes(c.n);
      const th = env.angle(f.value);
      const radial = add(scale(xDir, Math.cos(th)), scale(yDir, Math.sin(th)));
      frame = planeFrame(f.id, add(c.c, scale(radial, c.r)), radial);
      break;
    }
    case "planePath": {
      const a = edge(0);
      // "% along the edge" is measured by length, not by the curve's parameter (audit K-6).
      const t = a.e.geomType === "LINE" || a.e.geomType === "CIRCLE" ? Math.min(1, Math.max(0, env.num(f.value) / 100)) : byLength(a.e)(env.num(f.value) / 100);
      frame = planeFrame(f.id, a.e.pointAt(t).toTuple(), norm(a.e.tangentAt(t).toTuple()));
      break;
    }
    case "axisCyl": {
      const c = circle();
      frame = axisFrame(f.id, c.c, c.n);
      break;
    }
    case "axis2p": {
      const [a, b] = [pt(0), pt(1)];
      if (dist(a, b) < 1e-9) throw env.fail("The two points are the same.");
      frame = axisFrame(f.id, a, norm(sub(b, a)));
      break;
    }
    case "axis2pl": {
      const a = plane(0);
      const b = plane(1);
      const x = planeIntersection(a.c, a.n, b.c, b.n);
      if (!x) throw env.fail("The planes are parallel and do not define a unique axis.");
      frame = axisFrame(f.id, x.p, x.d);
      break;
    }
    case "axisEdge": {
      const a = line(0);
      frame = axisFrame(f.id, a.mid, a.t);
      break;
    }
    case "axisPerp": {
      const a = plane(0, false);
      const p = pt(0);
      frame = axisFrame(f.id, sub(p, scale(a.n, dot(sub(p, a.c), a.n))), a.n);
      break;
    }
    case "pointVertex":
      frame = pointFrame(f.id, pt(0));
      break;
    case "point2e": {
      const a = line(0);
      const b = line(1);
      const w = cross(a.t, b.t);
      if (len(w) < 1e-6) throw env.fail("The edges are parallel, so they never cross.");
      const r = sub(b.mid, a.mid);
      const s = dot(cross(r, b.t), w) / dot(w, w);
      const u = dot(cross(r, a.t), w) / dot(w, w);
      const pa = add(a.mid, scale(a.t, s));
      const pb = add(b.mid, scale(b.t, u));
      frame = pointFrame(f.id, scale(add(pa, pb), 0.5));
      if (dist(pa, pb) > 1e-3) {
        if (lines.some((ref) => ref.kind === "axis")) throw env.fail("The lines are skew and do not intersect.");
        return { frame, warning: "The edges don't quite meet; the point is halfway between them." };
      }
      break;
    }
    case "point3pl": {
      const [a, b, c] = [plane(0), plane(1), plane(2)];
      const det = dot(a.n, cross(b.n, c.n));
      if (Math.abs(det) < 1e-9) throw env.fail("These three planes don't meet at one point (two are parallel).");
      const p = scale(add(add(scale(cross(b.n, c.n), dot(a.n, a.c)), scale(cross(c.n, a.n), dot(b.n, b.c))), scale(cross(a.n, b.n), dot(c.n, c.c))), 1 / det);
      frame = pointFrame(f.id, p);
      break;
    }
    case "pointCenter":
      frame = pointFrame(f.id, circle().c);
      break;
    case "pointEdgePlane": {
      const a = line(0);
      const p = plane(0);
      const den = dot(p.n, a.t);
      if (Math.abs(den) < 1e-9) throw env.fail("The axis or edge runs parallel to the plane.");
      frame = pointFrame(f.id, add(a.mid, scale(a.t, dot(p.n, sub(p.c, a.mid)) / den)));
      break;
    }
  }
  return { frame, warning: uncertain ? "A picked face, edge, or vertex moved; please check it's still the right one." : undefined };
}
