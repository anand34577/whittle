/** Throwaway probes for the audit. Not committed. */
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { unzipSync, zipSync } from "fflate";
import {
  type ExtrudeFeature,
  type HoleFeature,
  type ImportFeature,
  type SketchFeature,
  deserializeDocument,
  makeExtrude,
  makeHole,
  makeImport,
  makePrimitive,
  makeSketch,
  newDocument,
  parseDxf,
  renameParameter,
  uid,
} from "@whittle/core";
import { Builder } from "../src/build";
import { initSolver, solveSketch } from "../src/solver";
import { createEvaluator } from "@whittle/core";
import { parseSTL } from "../src/stl";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") }));
  await initSolver();
});

describe("probe", () => {
  it("P2 rename parameter corrupts enum values", () => {
    const doc = newDocument();
    doc.parameters.push({ id: "a", name: "axis", expr: "5", kind: "length" });
    const sw = { id: "s", type: "surface", name: "S", op: "ruled", bodies: [], faces: [], edges: [], distance: "axis", direction: "axis", axis: "z", plane: "XY", offset: "0", keep: "below" } as never;
    const ex = { id: "e", type: "extrude", name: "E", sketch: "x", distance: "10", extent: "one", flip: false, thinSide: "inside", op: "new" } as never;
    doc.features.push(sw, ex);
    doc.parameters.push({ id: "b", name: "inside", expr: "1", kind: "length" });
    renameParameter(doc, "axis", "shaft");
    renameParameter(doc, "inside", "wall");
    console.log("P2 direction ->", (doc.features[0] as never as { direction: string }).direction, "thinSide ->", (doc.features[1] as never as { thinSide: string }).thinSide);
  });

  it("P4 malformed base64 import blocks regen", async () => {
    const doc = newDocument();
    const im = makeImport(doc, "x.step", "step", "!!!not base64!!!") as ImportFeature;
    doc.features.push(im);
    const b = new Builder();
    let err = "";
    try {
      await b.prepareImports(doc);
    } catch (e) {
      err = String(e);
    }
    console.log("P4 prepareImports threw:", err || "(no throw)");
  });

  it("P5 import cache key collision", async () => {
    // Two ascii STL files of identical length, identical first/last 48 bytes, different middle.
    const tri = (z: number) => `facet normal 0 0 1\nouter loop\nvertex 0 0 ${z}\nvertex 10 0 ${z}\nvertex 0 10 ${z}\nendloop\nendfacet\n`;
    const mk = (z: number) => {
      const tris = [tri(0), tri(z), tri(5), tri(7)];
      return "solid a\n" + tris.join("") + "endsolid a\n";
    };
    const a = mk(1);
    const c = mk(2);
    console.log("P5 lengths", a.length, c.length, "head eq", a.slice(0, 48) === c.slice(0, 48), "tail eq", a.slice(-48) === c.slice(-48));
  });

  it("P7 solver with absurd values", () => {
    const doc = newDocument();
    const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
    sk.geometry = [
      { id: "p1", type: "point", x: 0, y: 0 },
      { id: "p2", type: "point", x: 10, y: 0 },
      { id: "l1", type: "line", a: "p1", b: "p2" },
    ];
    sk.constraints = [{ id: "k1", type: "distance", refs: ["l1"], value: "1e300" }, { id: "k2", type: "horizontal", refs: ["l1"] }];
    const ev = createEvaluator([], "mm");
    const sol = solveSketch(sk, ev);
    console.log("P7 state", sol?.state, "dof", sol?.dof, "points", JSON.stringify(sol?.points));
    sk.constraints = [{ id: "k1", type: "distance", refs: ["l1"], value: "1e12" }, { id: "k2", type: "horizontal", refs: ["l1"] }];
    const sol2 = solveSketch(sk, ev);
    console.log("P7b state", sol2?.state, "points", JSON.stringify(sol2?.points));
  });

  it("P8 dxf with garbage numbers", () => {
    const dxf = "0\nSECTION\n2\nENTITIES\n0\nLINE\n10\nabc\n20\n0\n11\n5\n21\n5\n0\nCIRCLE\n10\n1\n20\n1\n40\nxyz\n0\nENDSEC\n0\nEOF\n";
    const r = parseDxf(dxf);
    console.log("P8 dxf", JSON.stringify(r));
  });

  it("P9 zip bomb with lying size", () => {
    const big = new Uint8Array(300 * 1024 * 1024);
    const z = zipSync({ "document.json": big }, { level: 1 });
    // patch uncompressed size in the local header (offset 22) and central directory
    const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
    dv.setUint32(22, 100, true);
    for (let i = z.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x02014b50) {
        dv.setUint32(i + 24, 100, true);
        break;
      }
    }
    const t = Date.now();
    let out = 0;
    try {
      const files = unzipSync(z, { filter: (f) => f.originalSize <= 256 * 1024 * 1024 });
      out = files["document.json"]?.length ?? 0;
    } catch (e) {
      out = -1;
      console.log("P9 unzip threw", String(e).slice(0, 100));
    }
    console.log("P9 zip size", z.length, "decompressed bytes", out, "ms", Date.now() - t);
    try {
      deserializeDocument(z);
    } catch (e) {
      console.log("P9 deserialize ->", String(e).slice(0, 100));
    }
  });

  it("P12 binary STL with NaN", () => {
    const buf = new Uint8Array(84 + 50);
    new DataView(buf.buffer).setUint32(80, 1, true);
    const dv = new DataView(buf.buffer);
    for (let k = 0; k < 9; k++) dv.setFloat32(84 + 12 + k * 4, k === 0 ? NaN : k, true);
    const t = parseSTL(buf);
    console.log("P12 parse NaN ok, values:", Array.from(t).join(","));
  });

  it("P3 key growth + timing", () => {
    const doc = newDocument();
    for (let i = 0; i < 300; i++) {
      const p = makePrimitive(doc, "box");
      if (p.type === "primitive") p.position = [String(i * 50), "0", "0"];
      doc.features.push(p);
      doc.bodies[p.id] = { name: "B" + i, color: "#ccc", visible: true };
    }
    const b = new Builder();
    let t = Date.now();
    const r = b.regen(doc, "preview");
    console.log("P3 first regen 300 boxes ms", Date.now() - t, "rebuilt", r.rebuilt);
    t = Date.now();
    const r2 = b.regen(doc, "preview");
    console.log("P3 cached regen ms", Date.now() - t, "rebuilt", r2.rebuilt);
    // @ts-expect-error private
    const cache = b.cache as { key: string }[];
    console.log("P3 key length last", cache[cache.length - 1]!.key.length, "sum", cache.reduce((a, s) => a + s.key.length, 0));
  });

  it("P1 silent face rebinding", () => {
    // base plate 40x40x10 with a boss 10x10x10 on top; hole on the boss top; then suppress the boss.
    const doc = newDocument();
    const s1 = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
    s1.entities.push({ id: uid(), type: "rect", x: "0", y: "0", w: "40", h: "40", anchor: "center" });
    const e1 = makeExtrude(doc, s1.id) as ExtrudeFeature;
    e1.distance = "10";
    doc.features.push(s1, e1);
    doc.bodies[e1.id] = { name: "Base", color: "#ccc", visible: true };
    const s2 = makeSketch(doc, { kind: "origin", plane: "XY", offset: "10" }) as SketchFeature;
    s2.entities.push({ id: uid(), type: "rect", x: "0", y: "0", w: "10", h: "10", anchor: "center" });
    const e2 = makeExtrude(doc, s2.id, "join") as ExtrudeFeature;
    e2.distance = "10";
    doc.features.push(s2, e2);
    const b = new Builder();
    let r = b.regen(doc, "final");
    const body = r.bodies[0]!;
    const topIdx = body.faces.findIndex((f) => f.normal[2] > 0.99 && Math.abs(f.center[2] - 20) < 1e-6);
    const hole = makeHole(doc) as HoleFeature;
    hole.face = { bodyId: body.id, ...body.faces[topIdx]! };
    hole.points = [["0", "0"]];
    hole.diameter = "4";
    hole.through = false;
    hole.depth = "5";
    doc.features.push(hole);
    r = b.regen(doc, "final");
    console.log("P1 before:", r.status.at(-1)!.state, r.status.at(-1)!.message, "vol", r.bodies[0]!.volume);
    e2.suppressed = true;
    r = b.regen(doc, "final");
    console.log("P1 after suppressing boss:", r.status.at(-1)!.state, r.status.at(-1)!.message, "vol", r.bodies[0]!.volume, "expected plate vol", 40 * 40 * 10);
  });
});
