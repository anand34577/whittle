import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import {
  type CurveFeature,
  type Feature,
  type PrimitiveFeature,
  type SketchEntity,
  type SketchFeature,
  type SweepFeature,
  type WhittleDocument,
  makeCurve,
  makePipe,
  makePrimitive,
  makeSketch,
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
const box = (doc: WhittleDocument) => {
  const b = makePrimitive(doc, "box") as PrimitiveFeature;
  b.width = b.depth = b.height = "20";
  return push(doc, b, true);
};

describe("3D curves", () => {
  it("runs a smooth curve through clicked points and a pipe can follow it", () => {
    const doc = newDocument();
    const c = push(doc, makeCurve(doc, "points") as CurveFeature);
    c.points.push([0, 0, 0], [10, 0, 10], [20, 10, 15], [30, 10, 30]);
    const pipe = push(doc, makePipe(doc, c.id) as SweepFeature, true);
    pipe.pipe = { shape: "circle", size: "2", wall: "0" };
    const r = regen(doc);
    expect(status(r, c.id).state, status(r, c.id).message).toBe("ok");
    expect(r.planes.find((p) => p.id === c.id)!.kind).toBe("curve");
    expect(r.planes.find((p) => p.id === c.id)!.line!.length).toBeGreaterThan(60);
    expect(status(r, pipe.id).state, status(r, pipe.id).message).toBe("ok");
    expect(r.bodies[0]!.volume).toBeGreaterThan(50);
  });

  it("copies model edges", () => {
    const doc = newDocument();
    const b = box(doc);
    const body = regen(doc).bodies[0]!;
    const e = body.edges.find((x) => Math.abs(x.tangent[2]) > 0.99)!;
    const c = push(doc, makeCurve(doc, "edges") as CurveFeature);
    c.edges.push({ bodyId: b.id, mid: e.mid, tangent: e.tangent, curve: e.curve, length: e.length });
    const r = regen(doc);
    expect(status(r, c.id).state, status(r, c.id).message).toBe("ok");
    expect(r.planes.find((p) => p.id === c.id)!.line!.length).toBe(48 * 6);
  });

  it("finds where two faces meet", () => {
    const doc = newDocument();
    const b = box(doc);
    const body = regen(doc).bodies[0]!;
    const top = body.faces.find((f) => f.normal[2] > 0.99)!;
    const side = body.faces.find((f) => f.normal[0] > 0.99)!;
    const c = push(doc, makeCurve(doc, "faces") as CurveFeature);
    c.faces.push({ bodyId: b.id, ...top }, { bodyId: b.id, ...side });
    const r = regen(doc);
    expect(status(r, c.id).state, status(r, c.id).message).toBe("ok");
    const line = r.planes.find((p) => p.id === c.id)!.line!;
    // One straight 20 mm edge, sampled into 48 pieces.
    expect(Math.abs(line[line.length - 2]! - line[1]!) + Math.abs(line[line.length - 3]! - line[0]!)).toBeCloseTo(20, 3);
  });

  it("projects a sketch onto a face", () => {
    const doc = newDocument();
    const b = box(doc);
    const top = regen(doc).bodies[0]!.faces.find((f) => f.normal[2] > 0.99)!;
    const s = sketch(doc, [{ id: uid("e"), type: "circle", cx: "0", cy: "0", r: "5" }], { kind: "origin", plane: "XY", offset: "40" });
    const c = push(doc, makeCurve(doc, "project") as CurveFeature);
    c.faces.push({ bodyId: b.id, ...top });
    c.sketch = s.id;
    const r = regen(doc);
    expect(status(r, c.id).state, status(r, c.id).message).toBe("ok");
    const line = r.planes.find((p) => p.id === c.id)!.line!;
    for (let i = 2; i < line.length; i += 3) expect(line[i]).toBeCloseTo(top.center[2], 3);
  });

  it("a sweep can follow a 3D curve path", () => {
    const doc = newDocument();
    const prof = sketch(doc, [{ id: uid("e"), type: "circle", cx: "0", cy: "0", r: "1.5" }], { kind: "origin", plane: "YZ", offset: "0" });
    const c = push(doc, makeCurve(doc, "points") as CurveFeature);
    c.smooth = false;
    c.points.push([0, 0, 0], [20, 0, 0], [20, 15, 10]);
    const sw = push(doc, makeSweep(doc, prof.id, c.id) as SweepFeature, true);
    const r = regen(doc);
    expect(status(r, sw.id).state, status(r, sw.id).message).toBe("ok");
    expect(r.bodies[0]!.volume).toBeGreaterThan(100);
  });
});
