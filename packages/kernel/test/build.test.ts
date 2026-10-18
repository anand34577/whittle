/**
 * Geometry tests: these run the real OpenCascade kernel (WASM) in Node.
 * They include the Phase-0 exit criterion: edit an upstream sketch and the
 * downstream fillet must survive.
 */
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import {
  type EdgeRef,
  type ExtrudeFeature,
  type FaceRef,
  type FilletFeature,
  type SketchFeature,
  type WhittleDocument,
  makeExtrude,
  makeFillet,
  makePattern,
  makePrimitive,
  makeShell,
  makeSketch,
  newDocument,
  uid,
} from "@whittle/core";
import { Builder } from "../src/build";
import { exportShapes, weld } from "../src/exporters";
import { makeBox } from "replicad";
import type { BodyResult } from "../src/protocol";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const wasm = require.resolve("replicad-opencascadejs/wasm");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => wasm }));
});

function plateDoc(): { doc: WhittleDocument; sketch: SketchFeature; extrude: ExtrudeFeature } {
  const doc = newDocument("Plate");
  doc.parameters.push({ id: "p1", name: "width", expr: "40", kind: "length" });
  const sketch = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
  sketch.entities.push({ id: uid(), type: "rect", x: "0", y: "0", w: "width", h: "30", anchor: "center" });
  doc.features.push(sketch);
  const extrude = makeExtrude(doc, sketch.id) as ExtrudeFeature;
  extrude.distance = "10";
  doc.features.push(extrude);
  doc.bodies[extrude.id] = { name: "Body 1", color: "#ccc", visible: true };
  return { doc, sketch, extrude };
}

const edgeRef = (b: BodyResult, i: number): EdgeRef => ({ bodyId: b.id, ...b.edges[i]! });
const faceRef = (b: BodyResult, i: number): FaceRef => ({ bodyId: b.id, ...b.faces[i]! });

describe("regeneration", () => {
  it("extrudes a parametric sketch", () => {
    const { doc } = plateDoc();
    const r = new Builder().regen(doc, "final");
    expect(r.status.every((s) => s.state === "ok")).toBe(true);
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0]!.volume).toBeCloseTo(40 * 30 * 10, 3);
    expect(r.bodies[0]!.faces).toHaveLength(6);
  });

  it("keeps a fillet attached after the sketch changes (topological naming)", () => {
    const { doc } = plateDoc();
    const b = new Builder();
    const body = b.regen(doc, "final").bodies[0]!;
    // Pick the four vertical edges.
    const vertical = body.edges.map((e, i) => ({ e, i })).filter(({ e }) => Math.abs(e.tangent[2]) > 0.99);
    expect(vertical).toHaveLength(4);
    const fillet = makeFillet(doc) as FilletFeature;
    fillet.edges = vertical.map(({ i }) => edgeRef(body, i));
    fillet.radius = "3";
    doc.features.push(fillet);
    const before = b.regen(doc, "final");
    expect(before.status.map((s) => s.state)).toEqual(["ok", "ok", "ok"]);
    const v1 = before.bodies[0]!.volume;
    expect(v1).toBeLessThan(40 * 30 * 10);

    // Upstream edit: width 40 -> 60.
    doc.parameters[0]!.expr = "60";
    const after = b.regen(doc, "final");
    expect(after.status.map((s) => s.state)).toEqual(["ok", "ok", "ok"]);
    const removed = 4 * (3 * 3 - (Math.PI * 9) / 4) * 10;
    expect(after.bodies[0]!.volume).toBeCloseTo(60 * 30 * 10 - removed, 2);
    expect(after.bodies[0]!.faces).toHaveLength(10);
  });

  it("explains an oversized fillet and suggests a value that fits", () => {
    const { doc } = plateDoc();
    const b = new Builder();
    const body = b.regen(doc, "final").bodies[0]!;
    const fillet = makeFillet(doc) as FilletFeature;
    const top = body.edges.map((e, i) => ({ e, i })).filter(({ e }) => e.mid[2] > 9.9);
    fillet.edges = top.map(({ i }) => edgeRef(body, i));
    fillet.radius = "50";
    doc.features.push(fillet);
    const r = b.regen(doc, "final");
    const s = r.status[2]!;
    expect(s.state).toBe("error");
    expect(s.message).toMatch(/too large/);
    expect(s.fix?.field).toBe("radius");
    expect(s.fix?.value).toMatch(/ mm$/);
    expect(parseFloat(s.fix!.value)).toBeGreaterThan(0);
    expect(parseFloat(s.fix!.value)).toBeLessThanOrEqual(10);
    // The model still shows the last good state.
    expect(r.bodies).toHaveLength(1);
  });

  it("sketches on a face, cuts a hole and shells", () => {
    const { doc } = plateDoc();
    const b = new Builder();
    const body = b.regen(doc, "final").bodies[0]!;
    const topIdx = body.faces.findIndex((f) => f.normal[2] > 0.99);
    const sk = makeSketch(doc, { kind: "face", face: faceRef(body, topIdx), offset: "0" }) as SketchFeature;
    sk.entities.push({ id: uid(), type: "circle", cx: "0", cy: "0", r: "5" });
    doc.features.push(sk);
    const cut = makeExtrude(doc, sk.id, "cut") as ExtrudeFeature;
    cut.distance = "10";
    cut.flip = true;
    doc.features.push(cut);
    let r = b.regen(doc, "final");
    expect(r.status.map((s) => s.state)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(r.bodies[0]!.volume).toBeCloseTo(40 * 30 * 10 - Math.PI * 25 * 10, 1);

    const bottomIdx = r.bodies[0]!.faces.findIndex((f) => f.normal[2] < -0.99);
    const shell = makeShell(doc);
    if (shell.type === "shell") shell.faces = [faceRef(r.bodies[0]!, bottomIdx)];
    doc.features.push(shell);
    r = b.regen(doc, "final");
    expect(r.status.at(-1)!.state).toBe("ok");
    expect(r.bodies[0]!.volume).toBeLessThan(40 * 30 * 10 - Math.PI * 25 * 10);
  });

  it("makes inner shapes holes automatically", () => {
    const doc = newDocument();
    const sk = makeSketch(doc, { kind: "origin", plane: "XZ", offset: "0" }) as SketchFeature;
    sk.entities.push(
      { id: uid(), type: "rect", x: "0", y: "0", w: "20", h: "20", anchor: "center" },
      { id: uid(), type: "circle", cx: "0", cy: "0", r: "5" },
    );
    doc.features.push(sk, makeExtrude(doc, sk.id));
    const r = new Builder().regen(doc, "final");
    expect(r.bodies[0]!.volume).toBeCloseTo((400 - Math.PI * 25) * 10, 1);
  });

  it("only rebuilds what changed", () => {
    const { doc } = plateDoc();
    const prim = makePrimitive(doc, "cylinder");
    doc.features.push(prim);
    const b = new Builder();
    expect(b.regen(doc, "final").rebuilt).toBe(3);
    if (prim.type === "primitive") prim.radius = "7";
    expect(b.regen(doc, "final").rebuilt).toBe(1);
  });

  it("patterns and exports", async () => {
    const doc = newDocument();
    const box = makePrimitive(doc, "box");
    doc.features.push(box);
    doc.bodies[box.id] = { name: "Box", color: "#aabbcc", visible: true };
    const pat = makePattern(doc, box.id);
    if (pat.type === "pattern") pat.spacing = "50";
    doc.features.push(pat);
    const b = new Builder();
    const r = b.regen(doc, "final");
    expect(r.status.map((s) => s.state)).toEqual(["ok", "ok"]);
    expect(r.bodies[0]!.volume).toBeCloseTo(3 * 40 * 30 * 20, 1);
    const shapes = b.shapes(doc);
    for (const fmt of ["step", "stl", "3mf"] as const) {
      const f = await exportShapes(doc, shapes, fmt);
      expect(f.data.byteLength).toBeGreaterThan(500);
    }
  });

  it("welds 3MF meshes into a closed, manifold surface", () => {
    const m = weld(makeBox([0, 0, 0], [10, 20, 30]).mesh({ tolerance: 0.01, angularTolerance: 0.1 }));
    expect(m.vertices.length / 3).toBe(8);
    const edges = new Map<string, number>();
    for (let i = 0; i < m.triangles.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const a = m.triangles[i + k]!;
        const b = m.triangles[i + ((k + 1) % 3)]!;
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    expect([...edges.values()].every((n) => n === 2)).toBe(true);
  });

  it("exports only the requested bodies", async () => {
    const doc = newDocument();
    const a = makePrimitive(doc, "box");
    const c = makePrimitive(doc, "cylinder");
    doc.features.push(a, c);
    const shapes = new Builder().shapes(doc);
    expect(shapes.size).toBe(2);
    const all = await exportShapes(doc, shapes, "stl");
    const one = await exportShapes(doc, shapes, "stl", [a.id]);
    expect(one.data.byteLength).toBeLessThan(all.data.byteLength);
  });
});

describe("feature preview", () => {
  it("reports the edited feature's tool and what it does with it", () => {
    const { doc, extrude } = plateDoc();
    const b = new Builder();
    // Built once without a preview, so the step is cached and must be rebuilt to recover its tool.
    expect(b.regen(doc, "final").ghost).toBeUndefined();
    const first = b.regen(doc, "preview", undefined, extrude.id);
    expect(first.ghostOp).toBe("new");
    expect(first.ghost!.volume).toBeCloseTo(40 * 30 * 10, 3);

    const boss = makeSketch(doc, { kind: "origin", plane: "XY", offset: "10" }) as SketchFeature;
    boss.entities.push({ id: uid(), type: "circle", cx: "0", cy: "0", r: "5" });
    doc.features.push(boss);
    const join = makeExtrude(doc, boss.id, "join") as ExtrudeFeature;
    join.distance = "4";
    doc.features.push(join);
    const joined = b.regen(doc, "preview", undefined, join.id);
    expect(joined.ghostOp).toBe("join");
    expect(joined.ghost!.volume).toBeCloseTo(Math.PI * 25 * 4, 1);

    const cut = makeExtrude(doc, boss.id, "cut") as ExtrudeFeature;
    cut.distance = "4";
    cut.flip = true;
    doc.features.push(cut);
    const cutting = b.regen(doc, "preview", undefined, cut.id);
    expect(cutting.ghostOp).toBe("cut");
    expect(cutting.ghost).toBeDefined();
    // Nothing is previewed once the edit ends.
    expect(b.regen(doc, "final").ghost).toBeUndefined();
  });
});

describe("mesh export detail", () => {
  it("draft, standard and fine give coarser and finer meshes of curved parts", async () => {
    const doc = newDocument();
    const cyl = makePrimitive(doc, "cylinder");
    doc.features.push(cyl);
    const shapes = new Builder().shapes(doc);
    for (const fmt of ["stl", "3mf"] as const) {
      const [draft, standard, fine] = await Promise.all((["draft", "standard", "fine"] as const).map((q) => exportShapes(doc, shapes, fmt, undefined, q)));
      expect(draft!.data.byteLength).toBeLessThan(standard!.data.byteLength);
      expect(standard!.data.byteLength).toBeLessThan(fine!.data.byteLength);
    }
    // The default stays what it always was.
    const plain = await exportShapes(doc, shapes, "stl");
    const standard = await exportShapes(doc, shapes, "stl", undefined, "standard");
    expect(plain.data.byteLength).toBe(standard.data.byteLength);
  });
});
