/** Geometry tests for the second wave of features (real OpenCascade in Node). */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { loadFont, setOC } from "replicad";
import {
  type CombineFeature,
  type Feature,
  type HoleFeature,
  type LoftFeature,
  type MoveFeature,
  type PrimitiveFeature,
  type SketchEntity,
  type SketchFeature,
  type WhittleDocument,
  makeCombine,
  makeExtrude,
  makeHole,
  makeLoft,
  makeMove,
  makePrimitive,
  makeSketch,
  newDocument,
  uid,
} from "@whittle/core";
import { Builder } from "../src/build";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const wasm = require.resolve("replicad-opencascadejs/wasm");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => wasm }));
  const font = require.resolve("@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff");
  const buf = readFileSync(font);
  await loadFont(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, "sans");
});

function push(doc: WhittleDocument, f: Feature, body = false) {
  doc.features.push(f);
  if (body) doc.bodies[f.id] = { name: f.name, color: "#ccc", visible: true };
  return f;
}

function sketchWith(doc: WhittleDocument, entities: SketchEntity[], offset = "0"): SketchFeature {
  const s = makeSketch(doc, { kind: "origin", plane: "XY", offset }) as SketchFeature;
  s.entities.push(...entities);
  return push(doc, s) as SketchFeature;
}

const ok = (r: ReturnType<Builder["regen"]>) => {
  const bad = r.status.filter((s) => s.state !== "ok");
  expect(bad, JSON.stringify(bad)).toHaveLength(0);
};

describe("new primitives", () => {
  it("builds cone, torus and tube with the right volumes", () => {
    const doc = newDocument();
    const cone = makePrimitive(doc, "cone") as PrimitiveFeature;
    cone.radius = "10";
    cone.radius2 = "0";
    cone.height = "30";
    push(doc, cone, true);
    const torus = makePrimitive(doc, "torus") as PrimitiveFeature;
    torus.position = ["100", "0", "0"];
    push(doc, torus, true);
    const tube = makePrimitive(doc, "tube") as PrimitiveFeature;
    tube.position = ["-100", "0", "0"];
    push(doc, tube, true);
    const r = new Builder().regen(doc, "final");
    ok(r);
    const [c, t, u] = r.bodies;
    expect(c!.volume).toBeCloseTo((Math.PI * 100 * 30) / 3, 0);
    expect(t!.volume).toBeCloseTo(2 * Math.PI * Math.PI * 20 * 25, 0);
    expect(u!.volume).toBeCloseTo(Math.PI * (15 * 15 - 11 * 11) * 20, 0);
  });
});

describe("sketch entities", () => {
  it("extrudes an ellipse, a gear with a bore, a rounded outline, text and a rotated rectangle", () => {
    const doc = newDocument();
    const s = sketchWith(doc, [
      { id: uid(), type: "ellipse", cx: "0", cy: "0", rx: "20", ry: "10", angle: "30" },
      { id: uid(), type: "gear", cx: "100", cy: "0", teeth: "20", module: "2", bore: "5" },
      { id: uid(), type: "polyline", points: [["-100", "0"], ["-60", "0"], ["-80", "30"]], corner: "3" },
      { id: uid(), type: "text", x: "0", y: "60", text: "Hi", size: "20", angle: "0" },
      { id: uid(), type: "rect", x: "0", y: "-60", w: "20", h: "10", anchor: "center", angle: "45" },
    ]);
    push(doc, makeExtrude(doc, s.id), true);
    const r = new Builder().regen(doc, "final");
    ok(r);
    const v = r.bodies[0]!.volume;
    const ellipse = Math.PI * 20 * 10 * 10;
    const gearApprox = Math.PI * 20 * 20 * 10 - Math.PI * 2.5 * 2.5 * 10;
    const rect = 20 * 10 * 10;
    expect(v).toBeGreaterThan(ellipse + gearApprox * 0.9 + rect);
    expect(r.sketches[0]!.fill?.length).toBeGreaterThan(0);
  });
});

describe("hole, loft, move, combine", () => {
  it("drills counterbored through holes in a plate", () => {
    const doc = newDocument();
    const box = makePrimitive(doc, "box") as PrimitiveFeature;
    box.width = "60";
    box.depth = "40";
    box.height = "10";
    push(doc, box, true);
    const b = new Builder();
    const top = b.regen(doc, "final").bodies[0]!.faces.find((f) => f.normal[2] > 0.99)!;
    const hole = makeHole(doc) as HoleFeature;
    hole.face = { bodyId: box.id, ...top };
    hole.points = [["-15", "0"], ["15", "0"]];
    hole.style = "counterbore";
    hole.diameter = "5";
    hole.headDiameter = "9";
    hole.headDepth = "3";
    push(doc, hole);
    const r = b.regen(doc, "final");
    ok(r);
    const removed = 2 * (Math.PI * 2.5 * 2.5 * 7 + Math.PI * 4.5 * 4.5 * 3);
    expect(r.bodies[0]!.volume).toBeCloseTo(60 * 40 * 10 - removed, 0);
  });

  it("drills countersunk blind holes", () => {
    const doc = newDocument();
    const box = makePrimitive(doc, "box") as PrimitiveFeature;
    push(doc, box, true);
    const b = new Builder();
    const top = b.regen(doc, "final").bodies[0]!.faces.find((f) => f.normal[2] > 0.99)!;
    const hole = makeHole(doc) as HoleFeature;
    hole.face = { bodyId: box.id, ...top };
    hole.points = [["0", "0"]];
    hole.style = "countersink";
    hole.through = false;
    hole.depth = "8";
    push(doc, hole);
    const r = b.regen(doc, "final");
    ok(r);
    expect(r.bodies[0]!.volume).toBeLessThan(40 * 30 * 20 - Math.PI * 2.5 * 2.5 * 8 * 0.9);
  });

  it("lofts a square into a circle", () => {
    const doc = newDocument();
    const a = sketchWith(doc, [{ id: uid(), type: "rect", x: "0", y: "0", w: "20", h: "20", anchor: "center" }]);
    const c = sketchWith(doc, [{ id: uid(), type: "circle", cx: "0", cy: "0", r: "5" }], "30");
    push(doc, makeLoft(doc, [a.id, c.id]) as LoftFeature, true);
    const r = new Builder().regen(doc, "final");
    ok(r);
    expect(r.bodies[0]!.bbox[1][2]).toBeCloseTo(30, 3);
    expect(r.bodies[0]!.volume).toBeGreaterThan(Math.PI * 25 * 30);
    expect(r.bodies[0]!.volume).toBeLessThan(400 * 30);
  });

  it("moves a copy and combines bodies", () => {
    const doc = newDocument();
    const box = makePrimitive(doc, "box") as PrimitiveFeature;
    push(doc, box, true);
    const mv = makeMove(doc, box.id) as MoveFeature;
    mv.translate = ["20", "0", "0"];
    mv.copy = true;
    push(doc, mv, true);
    const cb = makeCombine(doc, box.id, [mv.id]) as CombineFeature;
    push(doc, cb);
    const r = new Builder().regen(doc, "final");
    ok(r);
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0]!.volume).toBeCloseTo(60 * 30 * 20, 1);
  });
});

describe("text", () => {
  it("places text where its anchor says", () => {
    const doc = newDocument();
    const s = sketchWith(doc, [{ id: uid(), type: "text", x: "50", y: "10", text: "HELLO", size: "10", angle: "0" }]);
    push(doc, makeExtrude(doc, s.id), true);
    const r = new Builder().regen(doc, "final");
    ok(r);
    const [min, max] = r.bodies[0]!.bbox;
    expect(min[0]).toBeGreaterThan(50);
    expect(min[0]).toBeLessThan(52);
    expect(max[0]).toBeGreaterThan(75);
    expect(min[1]).toBeGreaterThan(9.5);
  });
});

describe("hole placement", () => {
  it("measures positions from the projected world origin and warns about misses", () => {
    const doc = newDocument();
    const box = makePrimitive(doc, "box") as PrimitiveFeature;
    box.position = ["30", "0", "0"]; // top face center is (30, 0, 20)
    push(doc, box, true);
    const b = new Builder();
    const top = b.regen(doc, "final").bodies[0]!.faces.find((f) => f.normal[2] > 0.99)!;
    const hole = makeHole(doc) as HoleFeature;
    hole.face = { bodyId: box.id, ...top };
    hole.points = [["30", "0"], ["200", "0"]];
    push(doc, hole);
    const r = b.regen(doc, "final");
    const st = r.status.find((s) => s.id === hole.id)!;
    expect(st.state).toBe("warning");
    expect(st.message).toMatch(/Hole 2 is off the body/);
    expect(r.bodies[0]!.volume).toBeCloseTo(40 * 30 * 20 - Math.PI * 2.5 * 2.5 * 20, 0);
  });
});
