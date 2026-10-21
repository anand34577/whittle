/** Library parts must survive saving, STEP export and re-import, and print as a watertight STL. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { loadFont, setOC } from "replicad";
import { type ImportFeature, deserializeDocument, makeImport, newDocument, serializeDocument } from "@whittle/core";
import { Builder } from "../../../packages/kernel/src/build";
import { exportShapes } from "../../../packages/kernel/src/exporters";
import { PARTS, PartBuilder } from "../src/state/parts";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") }));
  for (const [file, name] of [
    ["ibm-plex-sans-latin-400-normal.woff", "sans"],
    ["ibm-plex-sans-latin-700-normal.woff", "bold"],
  ] as const) {
    const buf = readFileSync(require.resolve(`@fontsource/ibm-plex-sans/files/${file}`));
    await loadFont(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, name);
  }
});

/** Open edges (used by one triangle) and edges shared by more than two, after welding vertices. */
function meshProblems(stl: Uint8Array) {
  const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  const n = dv.getUint32(80, true);
  const key = (o: number) => [0, 4, 8].map((k) => Math.round(dv.getFloat32(o + k, true) * 1e3)).join(",");
  const edges = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    const v = [key(o), key(o + 12), key(o + 24)];
    for (let k = 0; k < 3; k++) {
      const [a, b] = [v[k]!, v[(k + 1) % 3]!];
      if (a === b) continue;
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
  }
  let open = 0;
  let over = 0;
  for (const c of edges.values()) {
    if (c === 1) open++;
    if (c > 2) over++;
  }
  return { open, over, triangles: n };
}

// One of each kind (swept, revolved, lofted, gear, curved, thin-walled, coiled) keeps this quick; parts.test.ts builds them all.
const SAMPLE = new Set(["gear", "bracket", "enclosure", "vase", "pulley", "boss", "spring"]);

describe("round trip", () => {
  for (const part of PARTS.filter((p) => SAMPLE.has(p.id))) {
    it(`${part.title}: save, STEP and STL`, async () => {
      const doc = newDocument();
      const pb = new PartBuilder(doc, `${part.id}1`);
      part.build(pb);
      doc.parameters.push(...pb.params);
      doc.features.push(...pb.features);
      for (const [id, name] of pb.bodyNames) doc.bodies[id] = { name, color: "#ccc", visible: true };
      const builder = new Builder();
      const first = builder.regen(doc, "final");
      const volume = first.bodies.reduce((a, b) => a + b.volume, 0);

      // The saved file builds the same part.
      const back = deserializeDocument(serializeDocument(doc));
      const again = new Builder().regen(back, "final");
      expect(again.bodies.reduce((a, b) => a + b.volume, 0)).toBeCloseTo(volume, 4);

      // STEP: the same volume comes back.
      const step = await exportShapes(doc, builder.shapes(doc), "step");
      const im = makeImport(newDocument(), `${part.id}.step`, "step", Buffer.from(step.data).toString("base64")) as ImportFeature;
      const idoc = newDocument();
      idoc.features.push(im);
      idoc.bodies[im.id] = { name: "I", color: "#ccc", visible: true };
      const ib = new Builder();
      await ib.prepareImports(idoc);
      const imported = ib.regen(idoc, "final");
      expect(imported.status[0]!.state).toBe("ok");
      expect(imported.bodies.reduce((a, b) => a + b.volume, 0) / volume).toBeCloseTo(1, 3);

      // STL: closed, so a slicer accepts it (each body on its own: bodies may touch).
      for (const [id] of builder.shapes(doc)) {
        const one = await exportShapes(doc, builder.shapes(doc), "stl", [id]);
        const m = meshProblems(one.data);
        expect(m.triangles).toBeGreaterThan(0);
        expect({ open: m.open, over: m.over }).toEqual({ open: 0, over: 0 });
      }
    });
  }
});
