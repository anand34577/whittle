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
