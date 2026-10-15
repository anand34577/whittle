/** Geometry tests for the advanced modelling features (real OpenCascade in Node). */
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import {
  type CoilFeature,
  type DraftFeature,
  type ExtrudeFeature,
  type Feature,
  type OffsetFeature,
  type PrimitiveFeature,
  type ScaleFeature,
  type SketchEntity,
  type SketchFeature,
  type SplitFeature,
  type SweepFeature,
  type WhittleDocument,
  makeCoil,
  makeDraft,
  makeExtrude,
  makeOffset,
  makePrimitive,
  makeScale,
  makeSketch,
  makeSplit,
  makeSweep,
  newDocument,
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

function sketch(doc: WhittleDocument, entities: SketchEntity[], plane: SketchFeature["plane"] = { kind: "origin", plane: "XY", offset: "0" }): SketchFeature {
  const s = makeSketch(doc, plane) as SketchFeature;
  s.entities.push(...entities);
  return push(doc, s);
}

const square = (size: number): SketchEntity => ({ id: uid("e"), type: "rect", x: "0", y: "0", w: String(size), h: String(size), anchor: "center" });
const circle = (r: number, cx = 0, cy = 0): SketchEntity => ({ id: uid("e"), type: "circle", cx: String(cx), cy: String(cy), r: String(r) });

const ok = (r: ReturnType<Builder["regen"]>) => {
  const bad = r.status.filter((s) => s.state !== "ok");
  expect(bad, JSON.stringify(bad)).toHaveLength(0);
};

function box(doc: WhittleDocument, w = 20, d = 20, h = 20): PrimitiveFeature {
  const b = makePrimitive(doc, "box") as PrimitiveFeature;
  b.width = String(w);
  b.depth = String(d);
  b.height = String(h);
  return push(doc, b, true);
}

describe("extrude options", () => {
  it("extrudes two different distances each way", () => {
    const doc = newDocument();
    const s = sketch(doc, [square(10)]);
    const ex = push(doc, makeExtrude(doc, s.id) as ExtrudeFeature, true);
    ex.extent = "two";
    ex.distance = "6";
    ex.distance2 = "4";
    const r = new Builder().regen(doc, "final");
    ok(r);
    expect(r.bodies[0]!.volume).toBeCloseTo(1000, 0);
    expect(r.bodies[0]!.bbox[0][2]).toBeCloseTo(-4, 3);
    expect(r.bodies[0]!.bbox[1][2]).toBeCloseTo(6, 3);
  });

  it("tapers a square into a frustum with the right volume", () => {
    const doc = newDocument();
    const s = sketch(doc, [square(20)]);
    const ex = push(doc, makeExtrude(doc, s.id) as ExtrudeFeature, true);
    ex.distance = "10";
    ex.taper = "atan(0.5)";
    // Each side moves in by 10 * 0.5 = 5 mm: 20 -> 10 mm square.
    const r = new Builder().regen(doc, "final");
    ok(r);
    const h = 10;
    const expected = (h / 3) * (400 + 100 + Math.sqrt(400 * 100));
    expect(r.bodies[0]!.volume).toBeCloseTo(expected, 0);
  });

  it("keeps a hole drafted the other way", () => {
    const doc = newDocument();
    const s = sketch(doc, [square(40), circle(5)]);
    const ex = push(doc, makeExtrude(doc, s.id) as ExtrudeFeature, true);
    ex.distance = "10";
    ex.taper = "5";
    const r = new Builder().regen(doc, "final");
    ok(r);
    // The outline shrinks and the hole grows by 10 * tan(5 deg) on each wall.
    const k = 10 * Math.tan((5 * Math.PI) / 180);
    const frustum = (a1: number, a2: number) => (10 / 3) * (a1 + a2 + Math.sqrt(a1 * a2));
    const expected = frustum(1600, (40 - 2 * k) ** 2) - frustum(Math.PI * 25, Math.PI * (5 + k) ** 2);
    expect(r.bodies[0]!.volume).toBeCloseTo(expected, -1);
  });

  it("twists a profile without changing its volume", () => {
    const doc = newDocument();
    const s = sketch(doc, [square(10)]);
    const ex = push(doc, makeExtrude(doc, s.id) as ExtrudeFeature, true);
    ex.distance = "30";
    ex.twist = "90";
    const r = new Builder().regen(doc, "final");
    ok(r);
    expect(r.bodies[0]!.volume).toBeCloseTo(3000, -1);
  });

  it("refuses taper and twist together", () => {
    const doc = newDocument();
    const s = sketch(doc, [square(10)]);
    const ex = push(doc, makeExtrude(doc, s.id) as ExtrudeFeature, true);
    ex.taper = "2";
    ex.twist = "10";
    const r = new Builder().regen(doc, "final");
    expect(r.status.find((x) => x.id === ex.id)?.state).toBe("error");
  });
});

describe("tilted sketch planes", () => {
  it("tilts the XY plane about X by 90 degrees so extrusions go along -Y", () => {
    const doc = newDocument();
    const s = sketch(doc, [square(10)], { kind: "origin", plane: "XY", offset: "0", angle: "90", tilt: "x" });
    push(doc, makeExtrude(doc, s.id), true);
    const r = new Builder().regen(doc, "final");
    ok(r);
    const [min, max] = r.bodies[0]!.bbox;
    expect(max[1] - min[1]).toBeCloseTo(10, 3);
    expect(max[2] - min[2]).toBeCloseTo(10, 3);
    expect(min[1]).toBeCloseTo(-10, 3);
  });
});

describe("sweep", () => {
  it("sweeps a circle along an open straight path into a cylinder", () => {
    const doc = newDocument();
    const prof = sketch(doc, [circle(2)]);
    const path = sketch(doc, [{ id: uid("e"), type: "polyline", open: true, points: [["0", "0"], ["0", "30"]] }], { kind: "origin", plane: "XZ", offset: "0" });
    push(doc, makeSweep(doc, prof.id, path.id) as SweepFeature, true);
    const r = new Builder().regen(doc, "final");
    ok(r);
    expect(r.bodies[0]!.volume).toBeCloseTo(Math.PI * 4 * 30, 0);
  });

  it("sweeps a tube profile (with a hole) along a bent path", () => {
    const doc = newDocument();
    const prof = sketch(doc, [circle(3), circle(2)]);
    const path = sketch(doc, [{ id: uid("e"), type: "polyline", open: true, smooth: true, points: [["0", "0"], ["0", "20"], ["15", "35"], ["35", "40"]] }], { kind: "origin", plane: "XZ", offset: "0" });
    push(doc, makeSweep(doc, prof.id, path.id) as SweepFeature, true);
    const r = new Builder().regen(doc, "final");
    ok(r);
    expect(r.bodies[0]!.volume).toBeGreaterThan(0);
    // Ring area 5π per mm of path; the path is longer than 40 mm.
    expect(r.bodies[0]!.volume).toBeGreaterThan(5 * Math.PI * 40);
  });

  it("asks for picks when the sketches are missing", () => {
    const doc = newDocument();
    const sw = push(doc, makeSweep(doc, "", "") as SweepFeature, true);
    const r = new Builder().regen(doc, "final");
    expect(r.status.find((x) => x.id === sw.id)?.state).toBe("incomplete");
  });
});

describe("coil", () => {
  it("builds a spring whose volume matches its wire length", () => {
    const doc = newDocument();
    const c = push(doc, makeCoil(doc, "spring") as CoilFeature, true);
    c.radius = "10";
    c.pitch = "6";
    c.height = "30";
    c.size = "2";
    const r = new Builder().regen(doc, "final");
    ok(r);
    const turns = 30 / 6;
    const length = turns * Math.hypot(2 * Math.PI * 10, 6);
    expect(r.bodies[0]!.volume).toBeCloseTo(Math.PI * 1 * length, -1);
  });

  it("adds a thread to a rod", () => {
    const doc = newDocument();
    const rod = makePrimitive(doc, "cylinder") as PrimitiveFeature;
    rod.radius = "4";
    rod.height = "20";
    push(doc, rod, true);
    const t = push(doc, makeCoil(doc, "thread") as CoilFeature);
    t.op = "join";
    t.radius = "4";
    const r = new Builder().regen(doc, "final");
    ok(r);
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0]!.volume).toBeGreaterThan(Math.PI * 16 * 20);
  });

  it("offers a size that fits when the section is too large", () => {
    const doc = newDocument();
    const c = push(doc, makeCoil(doc, "spring") as CoilFeature, true);
    c.pitch = "2";
    c.size = "3";
    const r = new Builder().regen(doc, "final");
    const st = r.status.find((x) => x.id === c.id)!;
    expect(st.state).toBe("error");
    expect(st.fix?.field).toBe("size");
  });
});

describe("split, offset, scale, draft", () => {
  it("splits a box in two bodies", () => {
    const doc = newDocument();
    const b = box(doc);
    const sp = push(doc, makeSplit(doc, b.id) as SplitFeature, true);
    sp.offset = "5";
    const r = new Builder().regen(doc, "final");
    ok(r);
    expect(r.bodies).toHaveLength(2);
    const vols = r.bodies.map((x) => Math.round(x.volume)).sort((a, z) => a - z);
    expect(vols).toEqual([2000, 6000]);
  });

  it("trims one side away", () => {
    const doc = newDocument();
    const b = box(doc);
    const sp = push(doc, makeSplit(doc, b.id) as SplitFeature);
    sp.offset = "5";
    sp.keep = "below";
    const r = new Builder().regen(doc, "final");
    ok(r);
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0]!.volume).toBeCloseTo(2000, 0);
  });

  it("reports a plane that misses the body", () => {
    const doc = newDocument();
    const b = box(doc);
    const sp = push(doc, makeSplit(doc, b.id) as SplitFeature, true);
    sp.offset = "50";
    const r = new Builder().regen(doc, "final");
    expect(r.status.find((x) => x.id === sp.id)?.state).toBe("error");
  });

  it("grows a box by an offset", () => {
    const doc = newDocument();
    const b = box(doc, 10, 10, 10);
    const of = push(doc, makeOffset(doc, b.id) as OffsetFeature);
    of.distance = "1";
    const r = new Builder().regen(doc, "final");
    ok(r);
    // 12 mm cube with rounded edges: between the cube (1000) and the 12 mm cube (1728).
    expect(r.bodies[0]!.volume).toBeGreaterThan(1600);
    expect(r.bodies[0]!.volume).toBeLessThan(1728);
  });

  it("shrinks a box by a negative offset", () => {
    const doc = newDocument();
    const b = box(doc, 10, 10, 10);
    const of = push(doc, makeOffset(doc, b.id) as OffsetFeature);
    of.distance = "-1";
    const r = new Builder().regen(doc, "final");
    ok(r);
    expect(r.bodies[0]!.volume).toBeCloseTo(512, 0);
  });

  it("scales a copy about its center", () => {
    const doc = newDocument();
    const b = box(doc, 10, 10, 10);
    const sc = push(doc, makeScale(doc, b.id) as ScaleFeature, true);
    sc.factor = "2";
    sc.copy = true;
    const r = new Builder().regen(doc, "final");
    ok(r);
    const vols = r.bodies.map((x) => Math.round(x.volume)).sort((a, z) => a - z);
    expect(vols).toEqual([1000, 8000]);
  });

  it("drafts the side faces of a box", () => {
    const doc = newDocument();
    box(doc, 20, 20, 10);
    const b = new Builder();
    const r0 = b.regen(doc, "final");
    const body = r0.bodies[0]!;
    const sides = body.faces.filter((f) => Math.abs(f.normal[2]) < 0.1).map((f) => ({ bodyId: body.id, ...f }));
    expect(sides).toHaveLength(4);
    const dr = push(doc, makeDraft(doc) as DraftFeature);
    dr.faces = sides;
    dr.angle = "5";
    const r = b.regen(doc, "final");
    ok(r);
    expect(Math.abs(r.bodies[0]!.volume - 4000)).toBeGreaterThan(50);
  });
});

describe("mesh data", () => {
  it("lists the boundary edges of every face", () => {
    const doc = newDocument();
    box(doc);
    const r = new Builder().regen(doc, "final");
    const b = r.bodies[0]!;
    expect(b.faceEdges).toHaveLength(6);
    for (const list of b.faceEdges) expect(list).toHaveLength(4);
  });

  it("reuses meshes of unchanged bodies", () => {
    const doc = newDocument();
    box(doc);
    const builder = new Builder();
    const a = builder.regen(doc, "final");
    const b = builder.regen(doc, "final");
    expect(b.bodies[0]!.positions).not.toBe(a.bodies[0]!.positions);
    expect(Array.from(b.bodies[0]!.positions)).toEqual(Array.from(a.bodies[0]!.positions));
  });
});

describe("exports", () => {
  it("writes valid OBJ, PLY and GLB files", async () => {
    const doc = newDocument();
    box(doc);
    const shapes = new Builder().shapes(doc);
    const obj = await exportShapes(doc, shapes, "obj");
    const text = new TextDecoder().decode(obj.data);
    expect(text.match(/^v /gm)?.length).toBe(8);
    expect(text.match(/^f /gm)?.length).toBe(12);

    const ply = await exportShapes(doc, shapes, "ply");
    expect(new TextDecoder().decode(ply.data.slice(0, 3))).toBe("ply");

    const glb = await exportShapes(doc, shapes, "glb");
    const dv = new DataView(glb.data.buffer, glb.data.byteOffset);
    expect(dv.getUint32(0, true)).toBe(0x46546c67);
    expect(dv.getUint32(8, true)).toBe(glb.data.byteLength);
    const jsonLen = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(glb.data.slice(20, 20 + jsonLen)));
    expect(json.meshes).toHaveLength(1);
    expect(json.accessors[0].max[1]).toBeCloseTo(0.02, 5);
  });
});
