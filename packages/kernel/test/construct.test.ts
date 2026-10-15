import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { type ConstructFeature, type ConstructMode, type PrimitiveFeature, type Vec3, makeConstruct, makePrimitive, newDocument } from "@whittle/core";
import { Builder } from "../src/build";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const wasm = require.resolve("replicad-opencascadejs/wasm");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => wasm }));
});

function setup() {
  const doc = newDocument();
  const b = makePrimitive(doc, "box") as PrimitiveFeature;
  b.width = "20";
  b.depth = "20";
  b.height = "20";
  doc.features.push(b);
  doc.bodies[b.id] = { name: "b", color: "#ccc", visible: true };
  const body = new Builder().regen(doc, "final").bodies[0]!;
  const face = (n: Vec3, c?: number) => {
    const f = body.faces.find((x) => x.normal.every((v, i) => Math.abs(v - n[i]!) < 1e-6) && (c === undefined || Math.abs(x.center[0] * n[0] + x.center[1] * n[1] + x.center[2] * n[2] - c) < 1e-6))!;
    return { bodyId: body.id, ...f };
  };
  const edge = (dir: Vec3, near: Vec3) => {
    const e = body.edges.filter((x) => Math.abs(x.tangent[0] * dir[0] + x.tangent[1] * dir[1] + x.tangent[2] * dir[2]) > 0.99).sort((p, q) => d(p.mid, near) - d(q.mid, near))[0]!;
    return { bodyId: body.id, mid: e.mid, tangent: e.tangent, curve: e.curve, length: e.length };
  };
  const d = (a: Vec3, c: Vec3) => Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
  const run = (mode: ConstructMode, fill: (f: ConstructFeature) => void) => {
    const f = makeConstruct(doc, mode) as ConstructFeature;
    fill(f);
    doc.features.push(f);
    const r = new Builder().regen(doc, "final");
    doc.features.pop();
    return { r, f, frame: r.planes.find((p) => p.id === f.id), status: r.status.find((s) => s.id === f.id)! };
  };
  const [lo, hi] = [body.bbox[0][2], body.bbox[1][2]];
  return { face, edge, run, lo, hi };
}

describe("construction geometry", () => {
  it("midplane sits between two parallel faces", () => {
    const { face, run } = setup();
    const { frame, status } = run("midplane", (f) => void f.faces.push(face([1, 0, 0]), face([-1, 0, 0])));
    expect(status.state).toBe("ok");
    expect(frame!.kind).toBe("plane");
    expect(Math.abs(frame!.normal[0])).toBeCloseTo(1, 6);
    expect(frame!.origin[0]).toBeCloseTo(0, 6);
  });

  it("plane through three points, axis through two points, point from three planes", () => {
    const { face, run, hi } = setup();
    let o = run("plane3", (f) => void f.points.push([0, 0, 5], [10, 0, 5], [0, 10, 5]));
    expect(Math.abs(o.frame!.normal[2])).toBeCloseTo(1, 6);
    expect(o.frame!.origin[2]).toBeCloseTo(5, 6);
    o = run("axis2p", (f) => void f.points.push([0, 0, 0], [0, 0, 7]));
    expect(o.frame!.kind).toBe("axis");
    expect(o.frame!.normal[2]).toBeCloseTo(1, 6);
    o = run("point3pl", (f) => void f.faces.push(face([1, 0, 0]), face([0, 1, 0]), face([0, 0, 1])));
    expect(o.frame!.kind).toBe("point");
    expect(o.frame!.origin.map((v) => Math.round(v))).toEqual([10, 10, Math.round(hi)]);
  });

  it("axis from an edge, point where an edge meets a plane, plane along a path", () => {
    const { face, edge, run, lo, hi } = setup();
    const e = edge([0, 0, 1], [10, 10, 0]);
    let o = run("axisEdge", (f) => void f.edges.push(e));
    expect(Math.abs(o.frame!.normal[2])).toBeCloseTo(1, 6);
    expect(o.frame!.origin[0]).toBeCloseTo(10, 6);
    o = run("pointEdgePlane", (f) => (f.edges.push(e), f.faces.push(face([0, 0, 1]))));
    expect(o.frame!.origin[2]).toBeCloseTo(hi, 5);
    o = run("planePath", (f) => (f.edges.push(e), (f.value = "25")));
    expect(o.frame!.origin[2]).toBeCloseTo(lo + (hi - lo) / 4, 5);
  });

  it("asks for picks instead of failing", () => {
    const { run } = setup();
    expect(run("midplane", () => {}).status.state).toBe("incomplete");
  });
});

describe("round references", () => {
  it("finds a cylinder's axis and an edge circle's center", () => {
    const doc = newDocument();
    const c = makePrimitive(doc, "cylinder") as PrimitiveFeature;
    doc.features.push(c);
    doc.bodies[c.id] = { name: "c", color: "#ccc", visible: true };
    const body = new Builder().regen(doc, "final").bodies[0]!;
    const side = body.faces.find((f) => f.surface === "CYLINDRE")!;
    const ring = body.edges.find((e) => e.curve === "CIRCLE")!;
    const make = (mode: ConstructMode, fill: (f: ConstructFeature) => void) => {
      const f = makeConstruct(doc, mode) as ConstructFeature;
      fill(f);
      return new Builder().regen({ ...doc, features: [...doc.features, f] }, "final").planes.find((p) => p.id === f.id)!;
    };
    const axis = make("axisCyl", (f) => void f.faces.push({ bodyId: body.id, ...side }));
    expect(Math.hypot(axis.origin[0], axis.origin[1])).toBeLessThan(1e-6);
    expect(Math.abs(axis.normal[2])).toBeCloseTo(1, 6);
    const center = make("pointCenter", (f) => void f.edges.push({ bodyId: body.id, mid: ring.mid, tangent: ring.tangent, curve: ring.curve, length: ring.length }));
    expect(Math.hypot(center.origin[0], center.origin[1])).toBeLessThan(1e-6);
  });
});
