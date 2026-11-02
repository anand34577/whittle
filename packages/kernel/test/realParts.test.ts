/**
 * Real-life parts built the way people build them, step by step, each checked against a volume worked out by hand:
 * a mounting plate, an enclosure, a pipe flange, a gear, a spring, a bolt, a phone stand, a cup, a pipe elbow and a
 * parametric box. Then saving, reopening and exporting.
 */
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import {
  type ChamferFeature,
  type CoilFeature,
  type ExtrudeFeature,
  type Feature,
  type FilletFeature,
  type HoleFeature,
  type LoftFeature,
  type PatternFeature,
  type PrimitiveFeature,
  type RevolveFeature,
  type ShellFeature,
  type SketchEntity,
  type SketchFeature,
  type SweepFeature,
  type ThreadFeature,
  type WhittleDocument,
  deserializeDocument,
  makeChamfer,
  makeCoil,
  makeExtrude,
  makeFillet,
  makeHole,
  makeLoft,
  makePattern,
  makePipe,
  makePrimitive,
  makeRevolve,
  makeShell,
  makeSketch,
  makeThread,
  newDocument,
  serializeDocument,
  uid,
} from "@whittle/core";
import { Builder } from "../src/build";
import { exportShapes } from "../src/exporters";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const wasm = require.resolve("replicad-opencascadejs/wasm");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => wasm }));
});

function push<T extends Feature>(doc: WhittleDocument, f: T, body = false): T {
  doc.features.push(f);
  if (body) doc.bodies[f.id] = { name: f.name, color: "#ccc", visible: true };
  return f;
}
function sketch(doc: WhittleDocument, entities: SketchEntity[], plane: "XY" | "XZ" | "YZ" = "XY", offset = "0"): SketchFeature {
  const s = makeSketch(doc, { kind: "origin", plane, offset }) as SketchFeature;
  s.entities.push(...entities);
  return push(doc, s);
}
const poly = (pts: [number, number][], open = false): SketchEntity => ({ id: uid("e"), type: "polyline", open, points: pts.map(([x, y]) => [String(x), String(y)]) });
const circle = (cx: number, cy: number, r: number): SketchEntity => ({ id: uid("e"), type: "circle", cx: String(cx), cy: String(cy), r: String(r) });
const box = (doc: WhittleDocument, w: number, d: number, h: number) => push(doc, { ...(makePrimitive(doc, "box") as PrimitiveFeature), width: String(w), depth: String(d), height: String(h) }, true);

const build = (doc: WhittleDocument, b = new Builder()) => {
  const r = b.regen(doc, "final");
  const bad = r.status.filter((s) => !["ok", "suppressed", "rolledback"].includes(s.state));
  expect(bad, JSON.stringify(bad)).toHaveLength(0);
  return r;
};
type Built = ReturnType<typeof build>;
const one = (r: Built) => {
  expect(r.bodies).toHaveLength(1);
  return r.bodies[0]!;
};
const near = (got: number, want: number, rel = 1e-4) => expect(Math.abs(got - want) / want, `got ${got}, want ${want}`).toBeLessThan(rel);
const edgesOf = (r: Built, id: string, keep: (e: Built["bodies"][0]["edges"][0]) => boolean) => r.bodies.find((x) => x.id === id)!.edges.filter(keep).map((e) => ({ bodyId: id, ...e }));
const faceOf = (r: Built, id: string, keep: (f: Built["bodies"][0]["faces"][0]) => boolean) => ({ bodyId: id, ...r.bodies.find((x) => x.id === id)!.faces.find(keep)! });
const corner = 1 - Math.PI / 4; // what rounding a square corner of radius 1 takes off

describe("real-life parts", () => {
  it("a mounting plate: rounded corners and four counterbored screw holes", () => {
    const doc = newDocument("Mounting plate");
    const plate = box(doc, 80, 60, 8);
    const b = new Builder();
    let r = build(doc, b);
    push(doc, { ...(makeFillet(doc) as FilletFeature), radius: "6", edges: edgesOf(r, plate.id, (e) => Math.abs(e.tangent[2]) > 0.99) });
    r = build(doc, b);
    const top = faceOf(r, plate.id, (f) => f.normal[2] > 0.99);
    const hole = { ...(makeHole(doc) as HoleFeature), face: top, style: "counterbore" as const, diameter: "5.5", headDiameter: "10", headDepth: "3" };
    hole.points = [["-25", "-20"], ["25", "-20"], ["25", "20"], ["-25", "20"]];
    push(doc, hole);
    const body = one(build(doc, b));
    const holes = 4 * Math.PI * (2.75 ** 2 * 5 + 5 ** 2 * 3);
    near(body.volume, 80 * 60 * 8 - 4 * 36 * corner * 8 - holes);
  });

  it("an electronics enclosure: rounded box, shelled open at the top, with four screw bosses and a cable hole", () => {
    const doc = newDocument("Enclosure");
    const shell = box(doc, 100, 60, 40);
    const b = new Builder();
    let r = build(doc, b);
    push(doc, { ...(makeFillet(doc) as FilletFeature), radius: "8", edges: edgesOf(r, shell.id, (e) => Math.abs(e.tangent[2]) > 0.99) });
    r = build(doc, b);
    push(doc, { ...(makeShell(doc) as ShellFeature), bodyId: shell.id, thickness: "2", faces: [faceOf(r, shell.id, (f) => f.normal[2] > 0.99)] });
    const outer = 100 * 60 - 4 * 64 * corner;
    const inner = 96 * 56 - 4 * 36 * corner;
    const walls = 40 * outer - 38 * inner;
    near(one(build(doc, b)).volume, walls);

    for (const [x, y] of [[-40, -20], [40, -20], [40, 20], [-40, 20]]) {
      push(doc, { ...(makePrimitive(doc, "cylinder", "join") as PrimitiveFeature), target: shell.id, radius: "4", height: "30", position: [String(x), String(y), "2"] });
    }
    const bosses = 4 * Math.PI * 16 * 30;
    near(one(build(doc, b)).volume, walls + bosses);

    // A round cable hole through the front and back walls, from a sketch on the middle plane.
    const cable = sketch(doc, [circle(0, 20, 5)], "XZ");
    push(doc, { ...(makeExtrude(doc, cable.id, "cut") as ExtrudeFeature), extent: "symmetric", distance: "80" });
    near(one(build(doc, b)).volume, walls + bosses - 2 * Math.PI * 25 * 2, 1e-3);
  });

  it("a pipe flange: revolved hub and flange with six bolt holes repeated round it", () => {
    const doc = newDocument("Flange");
    const profile = sketch(doc, [poly([[20, 0], [60, 0], [60, 10], [30, 10], [30, 40], [20, 40]])]);
    const rv = push(doc, makeRevolve(doc, profile.id) as RevolveFeature, true);
    const b = new Builder();
    const r = build(doc, b);
    const solid = Math.PI * ((60 ** 2 - 20 ** 2) * 10 + (30 ** 2 - 20 ** 2) * 30);
    near(one(r).volume, solid);
    // The flange's top ring face, at y = 10.
    const ring = faceOf(r, rv.id, (f) => f.normal[1] > 0.99 && Math.abs(f.center[1] - 10) < 1e-6);
    const hole = push(doc, { ...(makeHole(doc) as HoleFeature), face: ring, diameter: "10", points: [["45", "0"]] });
    push(doc, { ...(makePattern(doc, rv.id) as PatternFeature), features: [hole.id], pattern: "circular", axis: "y", count: "6", angle: "360", merge: true });
    near(one(build(doc, b)).volume, solid - 6 * Math.PI * 25 * 10);
  });

  it("a spur gear with a bore, between its root and tip circles", () => {
    const doc = newDocument("Gear");
    const g = sketch(doc, [{ id: uid("e"), type: "gear", cx: "0", cy: "0", teeth: "20", module: "2", bore: "8" }]);
    push(doc, { ...(makeExtrude(doc, g.id) as ExtrudeFeature), distance: "10" }, true);
    const v = one(build(doc)).volume;
    const bore = Math.PI * 16 * 10;
    expect(v).toBeGreaterThan(Math.PI * 17.5 ** 2 * 10 - bore);
    expect(v).toBeLessThan(Math.PI * 22 ** 2 * 10 - bore);
    // Teeth take roughly half the ring between root and tip.
    near(v, Math.PI * ((17.5 ** 2 + 22 ** 2) / 2) * 10 - bore, 0.05);
  });

  it("a compression spring: wire length times wire section", () => {
    const doc = newDocument("Spring");
    push(doc, makeCoil(doc) as CoilFeature, true); // radius 10, pitch 6, height 40, wire 2
    const turns = 40 / 6;
    const wire = turns * Math.hypot(2 * Math.PI * 10, 6);
    near(one(build(doc)).volume, Math.PI * 1 * wire, 0.03);
  });

  it("a hex bolt: head and shank joined, the tip chamfered, the shank threaded", () => {
    const doc = newDocument("Bolt");
    const head = sketch(doc, [{ id: uid("e"), type: "polygon", cx: "0", cy: "0", r: "8", sides: "6", angle: "0" }]);
    const ex = push(doc, { ...(makeExtrude(doc, head.id) as ExtrudeFeature), distance: "5" }, true);
    push(doc, { ...(makePrimitive(doc, "cylinder", "join") as PrimitiveFeature), target: ex.id, radius: "4", height: "30", position: ["0", "0", "5"] });
    const b = new Builder();
    let r = build(doc, b);
    const plain = (3 * Math.sqrt(3) / 2) * 64 * 5 + Math.PI * 16 * 30;
    near(one(r).volume, plain);
    push(doc, { ...(makeChamfer(doc) as ChamferFeature), distance: "0.8", edges: edgesOf(r, ex.id, (e) => e.curve === "CIRCLE" && Math.abs(e.mid[2] - 35) < 1e-6) });
    r = build(doc, b);
    const chamfered = one(r).volume;
    // A 0.8 × 0.8 ring cut off the tip: Pappus with the triangle's centroid at r = 4 − 0.8/3.
    near(chamfered, plain - 0.5 * 0.64 * 2 * Math.PI * (4 - 0.8 / 3), 1e-3);
    const shank = faceOf(r, ex.id, (f) => f.surface === "CYLINDRE");
    push(doc, { ...(makeThread(doc) as ThreadFeature), face: shank, pitch: "1.25", length: "20" });
    const threaded = one(build(doc, b)).volume;
    expect(threaded).toBeLessThan(chamfered);
    expect(threaded).toBeGreaterThan(chamfered - Math.PI * (16 - 3.2 ** 2) * 30);
  });

  it("a phone stand: one bent strip from a thin extrude of an open path", () => {
    const doc = newDocument("Phone stand");
    const path = sketch(doc, [poly([[0, 0], [60, 0], [60, 10], [20, 60]], true)]);
    push(doc, { ...(makeExtrude(doc, path.id) as ExtrudeFeature), distance: "70", thin: "4" }, true);
    const length = 60 + 10 + Math.hypot(40, 50);
    near(one(build(doc)).volume, length * 4 * 70, 0.02);
  });

  it("a cup: lofted from a small circle to a wide one, then shelled open at the top", () => {
    const doc = newDocument("Cup");
    const base = sketch(doc, [circle(0, 0, 30)]);
    const rim = sketch(doc, [circle(0, 0, 40)], "XY", "90");
    const lo = push(doc, makeLoft(doc, [base.id, rim.id]) as LoftFeature, true);
    const b = new Builder();
    const r = build(doc, b);
    const frustum = (r1: number, r2: number, h: number) => (Math.PI * h * (r1 * r1 + r1 * r2 + r2 * r2)) / 3;
    near(one(r).volume, frustum(30, 40, 90));
    push(doc, { ...(makeShell(doc) as ShellFeature), bodyId: lo.id, thickness: "2", faces: [faceOf(r, lo.id, (f) => f.surface === "PLANE" && f.normal[2] > 0.99)] });
    // The inside is a frustum from the floor (z = 2) to the rim, its wall moved in 2 square to the slope.
    const inset = 2 * Math.hypot(1, 10 / 90);
    const at = (z: number) => 30 + z / 9 - inset;
    near(one(build(doc, b)).volume, frustum(30, 40, 90) - frustum(at(2), at(90), 88), 3e-3);
  });

  it("a pipe elbow: a hollow tube swept round a quarter circle", () => {
    const doc = newDocument("Elbow");
    const s = Math.SQRT1_2;
    const path = sketch(doc, [{ id: uid("e"), type: "polyline", open: true, points: [["0", "0"], [String(50 - 50 * s), String(50 * s), "arc"], ["50", "50"]] }]);
    push(doc, { ...(makePipe(doc, path.id) as SweepFeature), pipe: { shape: "circle", size: "20", wall: "2" } }, true);
    near(one(build(doc)).volume, Math.PI * (100 - 64) * (Math.PI * 50) / 2, 1e-3);
  });

  it("a parametric box that follows its parameters", () => {
    const doc = newDocument("Parametric box");
    doc.parameters.push({ id: uid("p"), name: "w", expr: "40", kind: "length" }, { id: uid("p"), name: "wall", expr: "w / 20", kind: "length" });
    const bx = push(doc, { ...(makePrimitive(doc, "box") as PrimitiveFeature), width: "w", depth: "w", height: "w / 2" }, true);
    const b = new Builder();
    const r = build(doc, b);
    push(doc, { ...(makeShell(doc) as ShellFeature), bodyId: bx.id, thickness: "wall", faces: [faceOf(r, bx.id, (f) => f.normal[2] > 0.99)] });
    const hollow = (w: number) => w * w * (w / 2) - (w - w / 10) ** 2 * (w / 2 - w / 20);
    near(one(build(doc, b)).volume, hollow(40));
    doc.parameters[0]!.expr = "60";
    near(one(build(doc, b)).volume, hollow(60));
  });
});

describe("changing a finished part", () => {
  /** A sketched plate, rounded, drilled and with a pocket: the steps after the sketch must follow when it changes size. */
  const plate = () => {
    const doc = newDocument("Plate");
    doc.parameters.push({ id: uid("p"), name: "w", expr: "80", kind: "length" }, { id: uid("p"), name: "d", expr: "60", kind: "length" });
    const sk = sketch(doc, [{ id: uid("e"), type: "rect", x: "0", y: "0", w: "w", h: "d", anchor: "center" }]);
    const ex = push(doc, { ...(makeExtrude(doc, sk.id) as ExtrudeFeature), distance: "10" }, true);
    const b = new Builder();
    let r = build(doc, b);
    const fi = push(doc, { ...(makeFillet(doc) as FilletFeature), radius: "5", edges: edgesOf(r, ex.id, (e) => Math.abs(e.tangent[2]) > 0.99) });
    r = build(doc, b);
    const top = faceOf(r, ex.id, (f) => f.surface === "PLANE" && f.normal[2] > 0.99);
    const ho = push(doc, { ...(makeHole(doc) as HoleFeature), face: top, diameter: "6", points: [["0", "0"]] });
    const pocket = sketch(doc, [{ id: uid("e"), type: "rect", x: "0", y: "0", w: "20", h: "20", anchor: "center" }], "XY", "10");
    push(doc, { ...(makeExtrude(doc, pocket.id, "cut") as ExtrudeFeature), distance: "4", flip: true });
    return { doc, b, fi, ho };
  };
  const expected = (w: number, d: number) => w * d * 10 - 4 * 25 * corner * 10 - 20 * 20 * 4 - Math.PI * 9 * 6;

  it("follows a bigger and a smaller plate, keeping every step working", () => {
    const { doc, b } = plate();
    near(one(build(doc, b)).volume, expected(80, 60));
    doc.parameters[0]!.expr = "120";
    near(one(build(doc, b)).volume, expected(120, 60));
    doc.parameters[1]!.expr = "40";
    near(one(build(doc, b)).volume, expected(120, 40));
    doc.parameters[0]!.expr = "80";
    doc.parameters[1]!.expr = "60";
    near(one(build(doc, b)).volume, expected(80, 60));
  });

  it("keeps the later steps when a middle one is turned off or deleted", () => {
    const { doc, b, fi } = plate();
    fi.suppressed = true;
    near(one(build(doc, b)).volume, 80 * 60 * 10 - 20 * 20 * 4 - Math.PI * 9 * 6);
    fi.suppressed = false;
    doc.features = doc.features.filter((f) => f.id !== fi.id);
    near(one(build(doc, b)).volume, 80 * 60 * 10 - 20 * 20 * 4 - Math.PI * 9 * 6);
  });

  it("rolls back to before the hole and forward again", () => {
    const { doc, b, ho } = plate();
    doc.rollback = doc.features.indexOf(ho); // only the steps before the hole
    near(one(build(doc, b)).volume, 80 * 60 * 10 - 4 * 25 * corner * 10);
    doc.rollback = null;
    near(one(build(doc, b)).volume, expected(80, 60));
  });
});

describe("saving, reopening and exporting a real part", () => {
  const enclosure = () => {
    const doc = newDocument("Enclosure");
    const bx = box(doc, 100, 60, 40);
    const r = build(doc);
    push(doc, { ...(makeFillet(doc) as FilletFeature), radius: "8", edges: edgesOf(r, bx.id, (e) => Math.abs(e.tangent[2]) > 0.99) });
    const r2 = build(doc);
    push(doc, { ...(makeShell(doc) as ShellFeature), bodyId: bx.id, thickness: "2", faces: [faceOf(r2, bx.id, (f) => f.normal[2] > 0.99)] });
    return doc;
  };

  it("reopens to the same part", () => {
    const doc = enclosure();
    const before = one(build(doc)).volume;
    const back = deserializeDocument(serializeDocument(doc));
    expect(back.features.map((f) => f.type)).toEqual(doc.features.map((f) => f.type));
    near(one(build(back)).volume, before, 1e-9);
  });

  it("exports STEP and a watertight STL", async () => {
    const doc = enclosure();
    const b = new Builder();
    build(doc, b);
    const shapes = b.shapes(doc);
    const step = await exportShapes(doc, shapes, "step");
    const text = new TextDecoder().decode(step.data);
    expect(text).toMatch(/^ISO-10303-21;/);
    expect(text).toMatch(/MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS/);
    const stl = await exportShapes(doc, shapes, "stl");
    expect(stl.data.byteLength).toBeGreaterThan(84);
    // Binary STL: 80-byte header, a count, 50 bytes a triangle.
    const tris = new DataView(stl.data.buffer, stl.data.byteOffset).getUint32(80, true);
    expect(stl.data.byteLength).toBe(84 + 50 * tris);
    expect(tris).toBeGreaterThan(100);
  });
});
