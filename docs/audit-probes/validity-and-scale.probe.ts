/** Throwaway probes #2 for the audit. */
import { createRequire } from "node:module";
import { beforeAll, describe, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { getOC, setOC } from "replicad";
import {
  type ExtrudeFeature,
  type FilletFeature,
  type PolylineEntity,
  type SketchFeature,
  makeExtrude,
  makeFillet,
  makePrimitive,
  makeSketch,
  newDocument,
  uid,
} from "@whittle/core";
import { Builder } from "../src/build";
import { initSolver } from "../src/solver";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") }));
  await initSolver();
});

function valid(b: Builder, doc: ReturnType<typeof newDocument>) {
  const oc = getOC();
  const out: string[] = [];
  for (const [id, s] of b.shapes(doc)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = new oc.BRepCheck_Analyzer((s as any).wrapped, true, false);
    out.push(`${id}:${a.IsValid()}`);
    a.delete();
  }
  return out.join(",");
}

function extrudeDoc(entities: SketchFeature["entities"], dist = "10") {
  const doc = newDocument();
  const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
  sk.entities.push(...entities);
  const ex = makeExtrude(doc, sk.id) as ExtrudeFeature;
  ex.distance = dist;
  doc.features.push(sk, ex);
  doc.bodies[ex.id] = { name: "B", color: "#ccc", visible: true };
  return doc;
}

describe("probe2", () => {
  it("Q3 bow-tie (self-intersecting) outline", () => {
    const pl: PolylineEntity = { id: uid(), type: "polyline", points: [["0", "0"], ["10", "10"], ["10", "0"], ["0", "10"]] };
    const doc = extrudeDoc([pl]);
    const b = new Builder();
    const r = b.regen(doc, "final");
    console.log("Q3 bowtie:", r.status.map((s) => `${s.state}:${s.message ?? ""}`).join(" | "), "vol", r.bodies[0]?.volume, "valid", valid(b, doc));
  });

  it("Q3b near-zero thickness extrude and tiny rect", () => {
    const doc = extrudeDoc([{ id: uid(), type: "rect", x: "0", y: "0", w: "20", h: "20", anchor: "center" }], "0.0000001");
    const b = new Builder();
    const r = b.regen(doc, "final");
    console.log("Q3b thin:", r.status.map((s) => `${s.state}:${s.message ?? ""}`).join(" | "), "vol", r.bodies[0]?.volume, "valid", valid(b, doc));
    const doc2 = extrudeDoc([{ id: uid(), type: "rect", x: "0", y: "0", w: "0.000001", h: "20", anchor: "center" }]);
    const r2 = new Builder().regen(doc2, "final");
    console.log("Q3b sliver:", r2.status.map((s) => `${s.state}:${s.message ?? ""}`).join(" | "), "vol", r2.bodies[0]?.volume);
  });

  it("Q3c coincident-face join and touching-edge union validity", () => {
    const doc = newDocument();
    const a = makePrimitive(doc, "box");
    const c = makePrimitive(doc, "box", "join");
    if (c.type === "primitive") c.position = ["40", "30", "0"]; // touches a along one edge only
    doc.features.push(a, c);
    doc.bodies[a.id] = { name: "A", color: "#ccc", visible: true };
    const b = new Builder();
    const r = b.regen(doc, "final");
    console.log("Q3c edge-touch join:", r.status.map((s) => `${s.state}:${s.message ?? ""}`).join(" | "), "bodies", r.bodies.length, "faces", r.bodies[0]?.faces.length, "valid", valid(b, doc));
  });

  it("Q4 big sketch O(n^2) (circles)", () => {
    const ents = Array.from({ length: 200 }, (_, i) => ({ id: uid(), type: "circle" as const, cx: String((i % 20) * 12), cy: String(Math.floor(i / 20) * 12), r: "4" }));
    const doc = extrudeDoc(ents);
    const t = Date.now();
    const r = new Builder().regen(doc, "final");
    console.log("Q4 200 circles sketch+extrude ms", Date.now() - t, r.status.map((s) => s.state).join(","));
    const ents2 = Array.from({ length: 600 }, (_, i) => ({ id: uid(), type: "circle" as const, cx: String((i % 30) * 12), cy: String(Math.floor(i / 30) * 12), r: "4" }));
    const t2 = Date.now();
    const r2 = new Builder().regen(extrudeDoc(ents2), "final");
    console.log("Q4 600 circles ms", Date.now() - t2, r2.status.map((s) => s.state).join(","));
  });

  it("Q5 large timeline 1500 features", () => {
    const doc = newDocument();
    for (let i = 0; i < 1500; i++) {
      const p = makePrimitive(doc, "box");
      if (p.type === "primitive") {
        p.position = [String((i % 40) * 50), String(Math.floor(i / 40) * 50), "0"];
        p.width = "10";
        p.depth = "10";
        p.height = "10";
      }
      doc.features.push(p);
      doc.bodies[p.id] = { name: "B" + i, color: "#ccc", visible: true };
    }
    const b = new Builder();
    const m0 = process.memoryUsage().heapUsed / 1e6;
    let t = Date.now();
    const r = b.regen(doc, "preview");
    console.log("Q5 first regen ms", Date.now() - t, "bodies", r.bodies.length, "heap MB delta", Math.round(process.memoryUsage().heapUsed / 1e6 - m0));
    t = Date.now();
    b.regen(doc, "preview");
    console.log("Q5 cached regen ms", Date.now() - t);
    // edit the LAST feature
    const last = doc.features[1499]!;
    if (last.type === "primitive") last.width = "11";
    t = Date.now();
    const r3 = b.regen(doc, "preview");
    console.log("Q5 edit last ms", Date.now() - t, "rebuilt", r3.rebuilt);
    const first = doc.features[0]!;
    if (first.type === "primitive") first.width = "12";
    t = Date.now();
    const r4 = b.regen(doc, "preview");
    console.log("Q5 edit first ms", Date.now() - t, "rebuilt", r4.rebuilt);
    // @ts-expect-error private
    const keys = (b.cache as { key: string }[]).reduce((a, s) => a + s.key.length, 0);
    console.log("Q5 total key chars", keys);
  });

  it("Q6 fillet radius pathological", () => {
    const doc = newDocument();
    const a = makePrimitive(doc, "box");
    doc.features.push(a);
    doc.bodies[a.id] = { name: "A", color: "#ccc", visible: true };
    const b = new Builder();
    const body = b.regen(doc, "final").bodies[0]!;
    const f = makeFillet(doc) as FilletFeature;
    f.edges = body.edges.map((e) => ({ bodyId: body.id, mid: e.mid, tangent: e.tangent, curve: e.curve, length: e.length }));
    f.radius = "1e-9";
    doc.features.push(f);
    const r = b.regen(doc, "final");
    console.log("Q6 tiny fillet:", r.status.at(-1)!.state, r.status.at(-1)!.message, "vol", r.bodies[0]?.volume, "valid", valid(b, doc));
  });
});
