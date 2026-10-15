import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import {
  type ExtrudeFeature,
  type Feature,
  type LoftFeature,
  type PrimitiveFeature,
  type RevolveFeature,
  type SketchEntity,
  type SketchFeature,
  type SurfaceFeature,
  type SweepFeature,
  type SurfaceOp,
  type WhittleDocument,
  makeExtrude,
  makeLoft,
  makePrimitive,
  makeRevolve,
  makeSketch,
  makeSurface,
  makeSweep,
  newDocument,
  uid,
} from "@whittle/core";
import { Builder } from "../src/build";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const wasm = require.resolve("replicad-opencascadejs/wasm");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => wasm }));
});

function push<T extends Feature>(doc: WhittleDocument, f: T, body = false): T {
  doc.features.push(f);
  if (body) doc.bodies[f.id] = { name: f.name, color: "#ccc", visible: true };
  return f;
}
const regen = (doc: WhittleDocument) => new Builder().regen(doc, "final");
const status = (r: ReturnType<typeof regen>, id: string) => r.status.find((s) => s.id === id)!;
const sketch = (doc: WhittleDocument, entities: SketchEntity[], plane: SketchFeature["plane"] = { kind: "origin", plane: "XY", offset: "0" }) => {
  const s = makeSketch(doc, plane) as SketchFeature;
  s.entities.push(...entities);
  return push(doc, s);
};
const circle = (r: number): SketchEntity => ({ id: uid("e"), type: "circle", cx: "0", cy: "0", r: String(r) });
const line = (a: [string, string], b: [string, string]): SketchEntity => ({ id: uid("e"), type: "polyline", open: true, points: [a, b] });
const box = (doc: WhittleDocument, size = 10) => {
  const b = makePrimitive(doc, "box") as PrimitiveFeature;
  b.width = b.depth = b.height = String(size);
  b.op = "new";
  return push(doc, b, true);
};
const ok = (r: ReturnType<typeof regen>, id: string) => expect(status(r, id).state, status(r, id).message).toBe("ok");
const op = (doc: WhittleDocument, kind: SurfaceOp, set: Partial<SurfaceFeature> = {}) => {
  const f = makeSurface(doc, kind) as SurfaceFeature;
  Object.assign(f, set);
  return push(doc, f);
};

describe("surface from sketches", () => {
  it("extrudes a circle into a tube surface with no caps and no volume", () => {
    const doc = newDocument();
    const s = sketch(doc, [circle(5)]);
    const ex = push(doc, makeExtrude(doc, s.id) as ExtrudeFeature, true);
    ex.surface = true;
    ex.distance = "10";
    const r = regen(doc);
    ok(r, ex.id);
    expect(r.bodies[0]!.volume).toBeCloseTo(0, 3);
    expect(r.bodies[0]!.area).toBeCloseTo(2 * Math.PI * 5 * 10, 0);
  });

  it("extrudes an open line into a flat surface", () => {
    const doc = newDocument();
    const s = sketch(doc, [line(["0", "0"], ["20", "0"])]);
    const ex = push(doc, makeExtrude(doc, s.id) as ExtrudeFeature, true);
    ex.surface = true;
    ex.distance = "8";
    const r = regen(doc);
    ok(r, ex.id);
    expect(r.bodies[0]!.area).toBeCloseTo(160, 1);
  });

  it("revolves a line into a surface of revolution", () => {
    const doc = newDocument();
    const s = sketch(doc, [line(["5", "0"], ["5", "10"])], { kind: "origin", plane: "XZ", offset: "0" });
    const rv = push(doc, makeRevolve(doc, s.id) as RevolveFeature, true);
    rv.surface = true;
    rv.axis = "y";
    rv.angle = "360";
    const r = regen(doc);
    ok(r, rv.id);
    expect(r.bodies[0]!.area).toBeCloseTo(2 * Math.PI * 5 * 10, 0);
  });

  it("lofts two circles into a surface, and sweeps a circle into a surface", () => {
    const doc = newDocument();
    const a = sketch(doc, [circle(3)]);
    const b = sketch(doc, [circle(5)], { kind: "origin", plane: "XY", offset: "10" });
    const lf = push(doc, makeLoft(doc, [a.id, b.id]) as LoftFeature, true);
    lf.surface = true;
    let r = regen(doc);
    ok(r, lf.id);
    expect(r.bodies[0]!.volume).toBeCloseTo(0, 3);
    expect(r.bodies[0]!.area).toBeGreaterThan(250);
    const doc2 = newDocument();
    const prof = sketch(doc2, [circle(2)], { kind: "origin", plane: "YZ", offset: "0" });
    const path = sketch(doc2, [line(["0", "0"], ["30", "0"])]);
    const sw = push(doc2, makeSweep(doc2, prof.id, path.id) as SweepFeature, true);
    sw.surface = true;
    r = regen(doc2);
    ok(r, sw.id);
    expect(r.bodies[0]!.area).toBeCloseTo(2 * Math.PI * 2 * 30, 0);
  });
});

describe("surface tools", () => {
  const top = (r: ReturnType<typeof regen>) => r.bodies[0]!.faces.findIndex((f) => f.normal[2] > 0.99);
  const faceRef = (r: ReturnType<typeof regen>, id: string, i: number) => ({ bodyId: id, ...r.bodies[0]!.faces[i]! });

  it("patches a loop of edges, offsets and extends faces, and rules an edge outward", () => {
    const doc = newDocument();
    const b = box(doc);
    const r0 = regen(doc);
    const body = r0.bodies[0]!;
    const t = top(r0);
    const loop = body.faceEdges[t]!.map((i) => ({ bodyId: b.id, mid: body.edges[i]!.mid, tangent: body.edges[i]!.tangent, curve: body.edges[i]!.curve, length: body.edges[i]!.length }));
    const patch = op(doc, "patch", { edges: loop });
    let r = regen(doc);
    ok(r, patch.id);
    expect(r.bodies.find((x) => x.id === patch.id)!.area).toBeCloseTo(100, 1);
    const off = op(doc, "offset", { faces: [faceRef(r0, b.id, t)], distance: "3" });
    r = regen(doc);
    ok(r, off.id);
    expect(r.bodies.find((x) => x.id === off.id)!.area).toBeCloseTo(100, 1);
    const ext = op(doc, "extend", { faces: [faceRef(r0, b.id, t)], distance: "2" });
    r = regen(doc);
    ok(r, ext.id);
    expect(r.bodies.find((x) => x.id === ext.id)!.area).toBeCloseTo(14 * 14, 1);
    const ruled = op(doc, "ruled", { edges: [loop[0]!], distance: "4", direction: "normal" });
    r = regen(doc);
    ok(r, ruled.id);
    expect(r.bodies.find((x) => x.id === ruled.id)!.area).toBeCloseTo(40, 1);
  });

  it("trims a surface at a plane and fills a hole with untrim", () => {
    const doc = newDocument();
    const s = sketch(doc, [circle(5)]);
    const ex = push(doc, makeExtrude(doc, s.id) as ExtrudeFeature, true);
    ex.surface = true;
    ex.distance = "10";
    const tr = op(doc, "trim", { bodyId: ex.id, plane: "XY", offset: "4", keep: "below" });
    const r = regen(doc);
    ok(r, tr.id);
    expect(r.bodies[0]!.area).toBeCloseTo(2 * Math.PI * 5 * 4, 0);

    const d2 = newDocument();
    const slab = box(d2, 20);
    const hole = makePrimitive(d2, "cylinder") as PrimitiveFeature;
    hole.radius = "3";
    hole.height = "20";
    hole.op = "cut";
    hole.target = slab.id;
    push(d2, hole);
    const r2 = regen(d2);
    const topIdx = r2.bodies[0]!.faces.findIndex((f) => f.normal[2] > 0.99);
    const un = op(d2, "untrim", { faces: [{ bodyId: slab.id, ...r2.bodies[0]!.faces[topIdx]! }] });
    const r3 = regen(d2);
    ok(r3, un.id);
    expect(r3.bodies.find((x) => x.id === un.id)!.area).toBeCloseTo(400, 1);
  });

  it("unstitches a solid into faces, stitches them back into a solid, and thickens a surface", () => {
    const doc = newDocument();
    const b = box(doc);
    const un = op(doc, "unstitch", { bodyId: b.id });
    let r = regen(doc);
    ok(r, un.id);
    expect(r.bodies[0]!.faces).toHaveLength(6);
    expect(r.bodies[0]!.volume).toBeCloseTo(0, 3);
    const st = op(doc, "stitch", { bodies: [b.id] });
    r = regen(doc);
    ok(r, st.id);
    expect(r.bodies.find((x) => x.id === st.id)!.volume).toBeCloseTo(1000, 0);

    const d2 = newDocument();
    const b2 = box(d2);
    const r0 = regen(d2);
    const face = { bodyId: b2.id, ...r0.bodies[0]!.faces.find((f) => f.normal[2] > 0.99)! };
    const off = op(d2, "offset", { faces: [face], distance: "0" });
    const th = op(d2, "thicken", { bodyId: off.id, distance: "2" });
    r = regen(d2);
    ok(r, th.id);
    expect(r.bodies.find((x) => x.id === th.id)!.volume).toBeCloseTo(200, 0);
  });

  it("reverses normals and merges faces", () => {
    const doc = newDocument();
    const s = sketch(doc, [line(["0", "0"], ["20", "0"])]);
    const ex = push(doc, makeExtrude(doc, s.id) as ExtrudeFeature, true);
    ex.surface = true;
    const before = regen(doc).bodies[0]!.faces[0]!.normal;
    const rv = op(doc, "reverse", { bodyId: ex.id });
    const mg = op(doc, "merge", { bodyId: ex.id });
    const r = regen(doc);
    ok(r, rv.id);
    ok(r, mg.id);
    const after = r.bodies[0]!.faces[0]!.normal;
    expect(after[0] * before[0] + after[1] * before[1] + after[2] * before[2]).toBeLessThan(0);
  });
});
