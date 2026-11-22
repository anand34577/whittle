import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { type ConstructFeature, type ConstructMode, type ConstructionPlaneFeature, type PrimitiveFeature, type Vec3, dependents, deserializeDocument, makeConstruct, makeConstructionPlane, makePrimitive, newDocument, reorderProblem, serializeDocument } from "@whittle/core";
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

describe("persistent datum references", () => {
  function fixture() {
    const doc = newDocument();
    const addPlane = (plane: "XY" | "XZ" | "YZ", offset: string) => {
      const f = makeConstructionPlane(doc, { kind: "origin", plane, offset }) as ConstructionPlaneFeature;
      doc.features.push(f);
      return f;
    };
    const xy = addPlane("XY", "5");
    const yz = addPlane("YZ", "3");
    const xz = addPlane("XZ", "0");
    const axis = makeConstruct(doc, "axis2pl") as ConstructFeature;
    axis.refs = { planes: [{ kind: "plane", id: xy.id }, { kind: "plane", id: yz.id }], lines: [], points: [] };
    doc.features.push(axis);
    const point = makeConstruct(doc, "pointEdgePlane") as ConstructFeature;
    point.refs = { planes: [{ kind: "plane", id: xz.id }], lines: [{ kind: "axis", id: axis.id }], points: [] };
    doc.features.push(point);
    return { doc, xy, yz, xz, axis, point };
  }

  it("round-trips, regenerates through a chain and protects timeline dependencies", () => {
    const { doc, xy, axis, point } = fixture();
    const literal = makeConstruct(doc, "pointVertex") as ConstructFeature;
    literal.points = [[13, 0, 5]];
    doc.features.push(literal);
    const through = makeConstruct(doc, "axis2p") as ConstructFeature;
    through.refs = { planes: [], lines: [], points: [{ kind: "point", id: point.id }, { kind: "point", id: literal.id }] };
    doc.features.push(through);
    const plane = makeConstruct(doc, "plane3") as ConstructFeature;
    plane.refs = { planes: [], lines: [], points: [...through.refs.points, { kind: "xyz", at: [3, 10, 5] }] };
    doc.features.push(plane);
    const offset = makeConstructionPlane(doc, { kind: "construction", plane: plane.id, offset: "2" });
    doc.features.push(offset);

    expect(dependents(doc, xy.id).map((f) => f.id)).toEqual([axis.id, point.id, through.id, plane.id, offset.id]);
    expect(reorderProblem(doc, 0, 4)).toMatch(/uses/);
    const saved = deserializeDocument(serializeDocument(doc));
    expect(saved.features).toEqual(doc.features);
    const builder = new Builder();
    const read = () => {
      const built = builder.regen(saved, "final");
      expect(built.status.map((f) => f.state)).toEqual(saved.features.map(() => "ok"));
      return built.planes;
    };
    expect(read().find((f) => f.id === point.id)?.origin).toEqual([3, 0, 5]);
    const source = saved.features[0] as ConstructionPlaneFeature;
    source.plane.offset = "8";
    const updated = read();
    for (const { id } of [axis, point, through, plane]) {
      expect(updated.find((f) => f.id === id)?.origin[2]).toBeCloseTo(8);
    }
    expect(updated.find((f) => f.id === offset.id)!.origin[2]).toBeGreaterThan(8);
  });

  it("rejects wrong kinds, self-references, cycles, forward references, suppression and parallel inputs", () => {
    const { doc, xy, xz, axis, point } = fixture();
    const state = (f: ConstructFeature, message: RegExp) => {
      const built = new Builder().regen(doc, "final");
      expect(built.status.find((s) => s.id === f.id)).toMatchObject({ state: "error", message: expect.stringMatching(message) });
      expect(built.planes.find((p) => p.id === f.id)).toBeUndefined();
    };
    const source = axis.refs!.planes[1]!;
    const input = (id: string) => { axis.refs!.planes[1] = { kind: "plane", id }; };

    point.refs!.lines[0] = { kind: "axis", id: xy.id };
    state(point, /must be a datum axis/);
    point.refs!.lines[0] = { kind: "axis", id: axis.id };
    input(axis.id);
    state(axis, /itself/);
    const later = makeConstructionPlane(doc, { kind: "origin", plane: "XZ", offset: "0" });
    doc.features.push(later);
    input(later.id);
    state(axis, /earlier in the timeline/);
    axis.refs!.planes[1] = source;
    xy.suppressed = true;
    state(axis, /unsuppressed/);
    xy.suppressed = false;
    input(xy.id);
    state(axis, /parallel/);
    input(xz.id);
    state(point, /parallel/);
  });

  it("rejects a cycle between otherwise compatible datum kinds", () => {
    const { doc, xz, point } = fixture();
    const axis = makeConstruct(doc, "axis2p") as ConstructFeature;
    axis.refs = { planes: [], lines: [], points: [{ kind: "point", id: point.id }, { kind: "xyz", at: [0, 5, 0] }] };
    doc.features.splice(doc.features.indexOf(point), 0, axis);
    point.refs = { planes: [{ kind: "plane", id: xz.id }], lines: [{ kind: "axis", id: axis.id }], points: [] };
    const built = new Builder().regen(doc, "final");
    for (const { id } of [axis, point]) {
      expect(built.status.find((status) => status.id === id)).toMatchObject({ state: "error", message: expect.stringMatching(/earlier in the timeline/) });
      expect(built.planes.some((frame) => frame.id === id)).toBe(false);
    }
  });

  it("keeps a straight-edge vertex attached when the source box changes height", () => {
    const doc = newDocument();
    const box = makePrimitive(doc, "box") as PrimitiveFeature;
    box.height = "20";
    doc.features.push(box);
    doc.bodies[box.id] = { name: box.name, color: "#ccc", visible: true };
    const builder = new Builder();
    const body = builder.regen(doc, "final").bodies[0]!;
    const { mid, tangent, curve, length } = body.edges.find((e) => e.curve === "LINE" && Math.abs(e.tangent[2]) > 0.99)!;
    const point = makeConstruct(doc, "pointVertex") as ConstructFeature;
    point.refs = {
      planes: [], lines: [],
      points: [{ kind: "vertex", edge: { bodyId: box.id, mid, tangent, curve, length }, end: tangent[2] > 0 ? 1 : 0 }],
    };
    doc.features.push(point);
    expect(dependents(doc, box.id)).toEqual([point]);
    const height = () => builder.regen(doc, "final").planes.find((p) => p.id === point.id)!.origin[2];
    expect(height()).toBeCloseTo(body.bbox[1][2]);
    box.height = "25";
    expect(height()).toBeCloseTo(body.bbox[1][2] + 5);
  });
});
