/** Construction geometry from model references: planes, axes and points. */
import { type ConstructFeature, type Vec3, frameAxes } from "@whittle/core";
import type { Edge, Face, Shape3D } from "replicad";
import type { SketchFrame } from "./protocol";
import { add, cross, dist, dot, edgeInfo, faceInfo, len, norm, resolveEdge, resolveFace, scale, sub } from "./refs";

export interface ConstructEnv {
  body(id: string): Shape3D;
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
  const face = (i: number, flat = false): { f: Face; c: Vec3; n: Vec3 } => {
    const ref = f.faces[i];
    if (!ref) throw env.fail(`Pick ${f.faces.length === 0 ? "a face" : "another face"}.`);
    const r = resolveFace(env.body(ref.bodyId), ref);
    if (!r) throw env.fail("A face this was built on is gone. Pick it again.");
    uncertain ||= r.uncertain;
    const info = faceInfo(r.item);
    if (flat && info.surface !== "PLANE") throw env.fail("This needs flat faces.");
    return { f: r.item, c: info.center, n: info.normal };
  };
  const edge = (i: number, line = false): { e: Edge; mid: Vec3; t: Vec3 } => {
    const ref = f.edges[i];
    if (!ref) throw env.fail(`Pick ${f.edges.length === 0 ? "an edge" : "another edge"}.`);
    const r = resolveEdge(env.body(ref.bodyId), ref);
    if (!r) throw env.fail("An edge this was built on is gone. Pick it again.");
    uncertain ||= r.uncertain;
    const info = edgeInfo(r.item);
    if (line && info.curve !== "LINE") throw env.fail("This needs straight edges.");
    return { e: r.item, mid: info.mid, t: info.tangent };
  };
  const pt = (i: number): Vec3 => {
    const p = f.points[i];
    if (!p) throw env.fail(`Click ${f.points.length === 0 ? "a point" : "another point"} on the model.`);
    return p;
  };
  const circle = (): { c: Vec3; n: Vec3; r: number } => {
    const tries: Edge[] = [];
    if (f.edges.length) tries.push(edge(0).e);
    else if (f.faces.length) tries.push(...face(0).f.edges);
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
      const a = face(0, true);
      const b = face(1, true);
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
      const a = edge(0, true);
      const b = edge(1, true);
      let n = cross(a.t, b.t);
      if (len(n) < 1e-6) n = cross(a.t, sub(b.mid, a.mid));
      else if (Math.abs(dot(norm(n), sub(b.mid, a.mid))) > 1e-3) throw env.fail("The two edges aren't in one plane (they skew past each other).");
      if (len(n) < 1e-9) throw env.fail("The two edges are on one line. Pick edges that span a plane.");
      frame = planeFrame(f.id, a.mid, norm(n));
      break;
    }
    case "planeEdge": {
      const a = edge(0, true);
      let n0: Vec3;
      if (f.faces.length) n0 = face(0).n;
      else n0 = Math.abs(dot(a.t, [0, 0, 1])) > 0.99 ? [1, 0, 0] : [0, 0, 1];
      n0 = norm(sub(n0, scale(a.t, dot(n0, a.t))));
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
      const t = Math.min(1, Math.max(0, env.num(f.value) / 100));
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
      const a = face(0, true);
      const b = face(1, true);
      const x = planeIntersection(a.c, a.n, b.c, b.n);
      if (!x) throw env.fail("The planes are parallel, so they never meet.");
      frame = axisFrame(f.id, x.p, x.d);
      break;
    }
    case "axisEdge": {
      const a = edge(0, true);
      frame = axisFrame(f.id, a.mid, a.t);
      break;
    }
    case "axisPerp": {
      const a = face(0);
      const p = pt(0);
      frame = axisFrame(f.id, sub(p, scale(a.n, dot(sub(p, a.c), a.n))), a.n);
      break;
    }
    case "pointVertex":
      frame = pointFrame(f.id, pt(0));
      break;
    case "point2e": {
      const a = edge(0, true);
      const b = edge(1, true);
      const w = cross(a.t, b.t);
      if (len(w) < 1e-6) throw env.fail("The edges are parallel, so they never cross.");
      const r = sub(b.mid, a.mid);
      const s = dot(cross(r, b.t), w) / dot(w, w);
      const u = dot(cross(r, a.t), w) / dot(w, w);
      const pa = add(a.mid, scale(a.t, s));
      const pb = add(b.mid, scale(b.t, u));
      frame = pointFrame(f.id, scale(add(pa, pb), 0.5));
      if (dist(pa, pb) > 1e-3) return { frame, warning: "The edges don't quite meet; the point is halfway between them." };
      break;
    }
    case "point3pl": {
      const [a, b, c] = [face(0, true), face(1, true), face(2, true)];
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
      const a = edge(0, true);
      const p = face(0, true);
      const den = dot(p.n, a.t);
      if (Math.abs(den) < 1e-9) throw env.fail("The edge runs parallel to the plane.");
      frame = pointFrame(f.id, add(a.mid, scale(a.t, dot(p.n, sub(p.c, a.mid)) / den)));
      break;
    }
  }
  return { frame, warning: uncertain ? "A picked face or edge moved; please check it's still the right one." : undefined };
}
