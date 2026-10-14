/** A circle touching the sides of its outer shape is still a hole. */
import { createRequire } from "node:module";
import { beforeAll, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { type SketchFeature, makeExtrude, makeSketch, newDocument, uid } from "@whittle/core";
import { Builder } from "../src/build";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") }));
});

it("cuts a circle that touches one side of the rectangle", () => {
  const doc = newDocument();
  const s = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
  s.entities.push(
    { id: uid(), type: "rect", x: "-25", y: "-15", w: "45", h: "40", anchor: "corner" },
    { id: uid(), type: "circle", cx: "-2.5", cy: "0", r: "15" },
  );
  doc.features.push(s);
  const ex = makeExtrude(doc, s.id);
  doc.features.push(ex);
  doc.bodies[ex.id] = { name: "B", color: "#ccc", visible: true };
  const r = new Builder().regen(doc, "final");
  expect(r.status.every((x) => x.state === "ok")).toBe(true);
  const v = r.bodies.reduce((a, b) => a + b.volume, 0);
  expect(v).toBeCloseTo((45 * 40 - Math.PI * 15 * 15) * 10, 0);
});

it("warns when a hole would split the outline in two", () => {
  const doc = newDocument();
  const s = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
  s.entities.push(
    { id: uid(), type: "rect", x: "-25", y: "-15", w: "45", h: "30", anchor: "corner" },
    { id: uid(), type: "circle", cx: "-2.5", cy: "0", r: "15" },
  );
  doc.features.push(s);
  const r = new Builder().regen(doc, "final");
  expect(r.status[0]!.state).toBe("warning");
  expect(r.status[0]!.message).toMatch(/split/);
});
