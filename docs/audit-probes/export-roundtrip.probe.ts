import { createRequire } from "node:module";
import { beforeAll, describe, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { strFromU8, unzipSync } from "fflate";
import { type ExtrudeFeature, type FilletFeature, type ImportFeature, type SketchFeature, makeExtrude, makeFillet, makeImport, makeSketch, newDocument, uid } from "@whittle/core";
import { Builder } from "../src/build";
import { exportShapes } from "../src/exporters";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") }));
});

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

function part() {
  const doc = newDocument("Part");
  const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
  sk.entities.push({ id: uid(), type: "rect", x: "0", y: "0", w: "60", h: "40", anchor: "center", corner: "5" }, { id: uid(), type: "circle", cx: "0", cy: "0", r: "8" });
  const ex = makeExtrude(doc, sk.id) as ExtrudeFeature;
  ex.distance = "12";
  doc.features.push(sk, ex);
  doc.bodies[ex.id] = { name: "Part", color: "#8ea4b3", visible: true };
  const b = new Builder();
  const body = b.regen(doc, "final").bodies[0]!;
  const f = makeFillet(doc) as FilletFeature;
  f.edges = body.edges.filter((e) => e.mid[2] > 11.9 && e.curve === "CIRCLE" && (e.radius ?? 0) > 7).map((e) => ({ bodyId: body.id, mid: e.mid, tangent: e.tangent, curve: e.curve, length: e.length }));
  f.radius = "1.5";
  doc.features.push(f);
  return doc;
}

describe("probe5", () => {
  it("E round trips and file structure", async () => {
    const doc = part();
    const b = new Builder();
    const r0 = b.regen(doc, "final");
    const v0 = r0.bodies[0]!.volume;
    const faces0 = r0.bodies[0]!.faces.length;
    console.log("E source: status", r0.status.map((s) => s.state).join(","), "vol", v0, "faces", faces0);
    const shapes = b.shapes(doc);

    for (const format of ["step", "stl"] as const) {
      const file = await exportShapes(doc, shapes, format);
      const d2 = newDocument("Back");
      const im = makeImport(d2, "p." + format, format, b64(file.data)) as ImportFeature;
      d2.features.push(im);
      d2.bodies[im.id] = { name: "I", color: "#ccc", visible: true };
      const kb = new Builder();
      await kb.prepareImports(d2);
      const r = kb.regen(d2, "final");
      console.log(`E ${format}: bytes ${file.data.length} status ${r.status[0]!.state} ${r.status[0]!.message ?? ""} vol ${r.bodies[0]?.volume} (src ${v0}) faces ${r.bodies[0]?.faces.length} bbox ${JSON.stringify(r.bodies[0]?.bbox)}`);
    }

    // 3MF structure
    const f3 = await exportShapes(doc, shapes, "3mf");
    const model = strFromU8(unzipSync(f3.data)["3D/3dmodel.model"]!);
    const nv = (model.match(/<vertex /g) ?? []).length;
    const tri = [...model.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)].map((m) => [+m[1]!, +m[2]!, +m[3]!]);
    const maxIdx = Math.max(...tri.flat());
    const edges = new Map<string, number>();
    for (const t of tri) for (let k = 0; k < 3; k++) { const a = t[k]!, c = t[(k + 1) % 3]!; const key = a < c ? `${a},${c}` : `${c},${a}`; edges.set(key, (edges.get(key) ?? 0) + 1); }
    const nonManifold = [...edges.values()].filter((n) => n !== 2).length;
    console.log("E 3mf: vertices", nv, "triangles", tri.length, "maxIdx", maxIdx, "edges not shared by exactly 2 triangles:", nonManifold);

    // GLB structure
    const g = await exportShapes(doc, shapes, "glb");
    const dv = new DataView(g.data.buffer, g.data.byteOffset, g.data.byteLength);
    const total = dv.getUint32(8, true);
    const jlen = dv.getUint32(12, true);
    const json = JSON.parse(strFromU8(g.data.subarray(20, 20 + jlen)));
    const blen = dv.getUint32(20 + jlen, true);
    console.log("E glb: total", total, "==", g.data.length, "json chunk", jlen, "bin chunk", blen, "buffer.byteLength", json.buffers[0].byteLength, "accessors", json.accessors.length);

    // OBJ
    const o = strFromU8((await exportShapes(doc, shapes, "obj")).data);
    const vcount = (o.match(/^v /gm) ?? []).length;
    const fidx = [...o.matchAll(/^f (\d+) (\d+) (\d+)/gm)].flatMap((m) => [+m[1]!, +m[2]!, +m[3]!]);
    console.log("E obj: v", vcount, "faces", fidx.length / 3, "max idx", Math.max(...fidx), "min idx", Math.min(...fidx));

    // PLY
    const p = (await exportShapes(doc, shapes, "ply")).data;
    const head = strFromU8(p.subarray(0, 300));
    const nvp = +/element vertex (\d+)/.exec(head)![1]!;
    const nfp = +/element face (\d+)/.exec(head)![1]!;
    const hlen = head.indexOf("end_header\n") + "end_header\n".length;
    console.log("E ply: header", hlen, "nv", nvp, "nf", nfp, "expected size", hlen + nvp * 12 + nfp * 13, "actual", p.length);

    // STL binary triangle count vs header
    const s = (await exportShapes(doc, shapes, "stl")).data;
    const n = new DataView(s.buffer, s.byteOffset, s.byteLength).getUint32(80, true);
    console.log("E stl: header count", n, "size", s.length, "expected", 84 + n * 50);
  });
});
