/** Regression tests from the October 2026 audit (second pass). These run the real OpenCascade kernel. */
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { type ExtrudeFeature, type ImportFeature, type PolylineEntity, type SketchFeature, makeExtrude, makeImport, makePrimitive, makeSketch, newDocument, uid } from "@whittle/core";
import { Builder } from "../src/build";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") }));
});

describe("damaged imports", () => {
  it("a bad embedded file fails its own feature, not the whole rebuild", async () => {
    const doc = newDocument();
    const box = makePrimitive(doc, "box");
    const im = makeImport(doc, "broken.step", "step", "!!!not base64!!!") as ImportFeature;
    doc.features.push(box, im);
    doc.bodies[box.id] = { name: "Box", color: "#ccc", visible: true };
    doc.bodies[im.id] = { name: "Imported", color: "#ccc", visible: true };
    const b = new Builder();
    await b.prepareImports(doc);
    const r = b.regen(doc, "final");
    expect(r.status.map((s) => s.state)).toEqual(["ok", "error"]);
    expect(r.bodies).toHaveLength(1);
  });
});

describe("self-intersecting outlines", () => {
  const bowTie = (): PolylineEntity => ({ id: uid(), type: "polyline", points: [["0", "0"], ["10", "10"], ["10", "0"], ["0", "10"]] });
  const extrudeOf = (e: PolylineEntity) => {
    const doc = newDocument();
    const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
    sk.entities.push(e);
    const ex = makeExtrude(doc, sk.id) as ExtrudeFeature;
    ex.distance = "10";
    doc.features.push(sk, ex);
    doc.bodies[ex.id] = { name: "B", color: "#ccc", visible: true };
    return doc;
  };

  it("a bow-tie outline is an error, not an invalid solid reported as fine", () => {
    const r = new Builder().regen(extrudeOf(bowTie()), "final");
    expect(r.status[0]!.state).toBe("error");
    expect(r.status[0]!.message).toMatch(/crosses itself/);
    expect(r.bodies).toHaveLength(0);
  });

  it("outlines that only touch at a corner, and ordinary concave shapes, still build", () => {
    const concave: PolylineEntity = { id: uid(), type: "polyline", points: [["0", "0"], ["20", "0"], ["20", "20"], ["10", "5"], ["0", "20"]] };
    const r = new Builder().regen(extrudeOf(concave), "final");
    expect(r.status.map((s) => s.state)).toEqual(["ok", "ok"]);
    expect(r.bodies[0]!.volume).toBeGreaterThan(0);
  });
});
