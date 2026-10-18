/** Picking sketch regions: every enclosed area can be extruded or revolved on its own. */
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { type ExtrudeFeature, type SketchFeature, type Vec2, type WhittleDocument, makeExtrude, makeSketch, newDocument, uid } from "@whittle/core";
import { Builder } from "../src/build";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const wasm = require.resolve("replicad-opencascadejs/wasm");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => wasm }));
});

function ringDoc(regions?: Vec2[]): { doc: WhittleDocument; sketch: SketchFeature; extrude: ExtrudeFeature } {
  const doc = newDocument("Regions");
  const sketch = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
  sketch.entities.push({ id: uid(), type: "rect", x: "0", y: "0", w: "40", h: "30", anchor: "center" });
  sketch.entities.push({ id: uid(), type: "circle", cx: "0", cy: "0", r: "5" });
  doc.features.push(sketch);
  const extrude = makeExtrude(doc, sketch.id) as ExtrudeFeature;
  extrude.distance = "10";
  if (regions) extrude.regions = regions;
  doc.features.push(extrude);
  doc.bodies[extrude.id] = { name: "Body 1", color: "#ccc", visible: true };
  return { doc, sketch, extrude };
}

const disc = Math.PI * 25 * 10;
const plate = 40 * 30 * 10;

describe("sketch regions", () => {
  it("lists the ring and the disc of a circle inside a rectangle", () => {
    const r = new Builder().regen(ringDoc().doc, "final");
    expect(r.sketches[0]!.regions).toHaveLength(2);
    // Without a choice the inner shape stays a hole, as before.
    expect(r.bodies[0]!.volume).toBeCloseTo(plate - disc, 0);
  });

  it("extrudes just the inner disc", () => {
    const r = new Builder().regen(ringDoc([[0, 0]]).doc, "final");
    expect(r.status.every((s) => s.state === "ok")).toBe(true);
    expect(r.bodies[0]!.volume).toBeCloseTo(disc, 0);
  });

  it("extrudes just the ring", () => {
    const r = new Builder().regen(ringDoc([[15, 10]]).doc, "final");
    expect(r.bodies[0]!.volume).toBeCloseTo(plate - disc, 0);
  });

  it("fuses the ring and the disc back into a full plate", () => {
    const r = new Builder().regen(ringDoc([[15, 10], [0, 0]]).doc, "final");
    expect(r.bodies[0]!.volume).toBeCloseTo(plate, 0);
  });

  it("splits two overlapping circles into three areas", () => {
    const doc = newDocument("Overlap");
    const sketch = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
    sketch.entities.push({ id: uid(), type: "circle", cx: "0", cy: "0", r: "10" });
    sketch.entities.push({ id: uid(), type: "circle", cx: "10", cy: "0", r: "10" });
    doc.features.push(sketch);
    const extrude = makeExtrude(doc, sketch.id) as ExtrudeFeature;
    extrude.distance = "5";
    extrude.regions = [[5, 0]];
    doc.features.push(extrude);
    doc.bodies[extrude.id] = { name: "Body 1", color: "#ccc", visible: true };
    const r = new Builder().regen(doc, "final");
    expect(r.sketches[0]!.regions).toHaveLength(3);
    // The lens where they overlap: 2r²·acos(d/2r) − (d/2)·√(4r²−d²).
    const lens = 2 * 100 * Math.acos(10 / 20) - 5 * Math.sqrt(400 - 100);
    expect(r.bodies[0]!.volume).toBeCloseTo(lens * 5, 0);
  });

  it("matches a chosen area that is no longer there to the nearest one, with a warning", () => {
    const r = new Builder().regen(ringDoc([[0, 60]]).doc, "final");
    expect(r.status[1]!.state).toBe("warning");
    expect(r.bodies).toHaveLength(1);
  });
});
