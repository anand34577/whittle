/** Round-trip: export a part, import the file back as a body. */
import { createRequire } from "node:module";
import { beforeAll, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { type ImportFeature, type PrimitiveFeature, makeImport, makePrimitive, newDocument } from "@whittle/core";
import { Builder } from "../src/build";
import { exportShapes } from "../src/exporters";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") }));
});

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

for (const format of ["step", "stl"] as const) {
  it(`imports a ${format.toUpperCase()} file and scales it`, async () => {
    const src = newDocument();
    const box = makePrimitive(src, "box") as PrimitiveFeature;
    src.features.push(box);
    src.bodies[box.id] = { name: "Box", color: "#ccc", visible: true };
    const b = new Builder();
    const file = await exportShapes(src, b.shapes(src), format);

    const doc = newDocument();
    const im = makeImport(doc, `box.${format}`, format, b64(file.data)) as ImportFeature;
    im.scale = "2";
    doc.features.push(im);
    doc.bodies[im.id] = { name: "Imported", color: "#ccc", visible: true };
    const kb = new Builder();
    await kb.prepareImports(doc);
    const r = kb.regen(doc, "final");
    expect(r.status[0]!.state).toBe("ok");
    expect(r.bodies[0]!.volume).toBeCloseTo(40 * 30 * 20 * 8, -2);
  });
}

it("keeps fractional import scales (25.4 for inches, 0.5 to halve) instead of rounding them", async () => {
  const src = newDocument();
  const box = makePrimitive(src, "box") as PrimitiveFeature;
  src.features.push(box);
  src.bodies[box.id] = { name: "Box", color: "#ccc", visible: true };
  const file = await exportShapes(src, new Builder().shapes(src), "step");
  for (const [scale, k] of [["0.5", 0.5], ["1.5", 1.5], ["25.4", 25.4]] as const) {
    const doc = newDocument();
    const im = makeImport(doc, "box.step", "step", b64(file.data)) as ImportFeature;
    im.scale = scale;
    doc.features.push(im);
    doc.bodies[im.id] = { name: "Imported", color: "#ccc", visible: true };
    const kb = new Builder();
    await kb.prepareImports(doc);
    const r = kb.regen(doc, "final");
    expect(r.status[0]!.state).toBe("ok");
    expect(r.bodies[0]!.volume / (40 * 30 * 20)).toBeCloseTo(k ** 3, 1);
  }
});
