/** Patterns and mirrors of features: repeat a boss or a cut, not the whole body. */
import { createRequire } from "node:module";
import { beforeAll, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import {
  type ExtrudeFeature,
  type Feature,
  type MirrorFeature,
  type PatternFeature,
  type SketchEntity,
  type SketchFeature,
  type WhittleDocument,
  makeExtrude,
  makeMirror,
  makePattern,
  makePrimitive,
  makeSketch,
  newDocument,
  uid,
} from "@whittle/core";
import { Builder } from "../src/build";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") }));
});

const push = <T extends Feature>(doc: WhittleDocument, f: T, body = false): T => {
  doc.features.push(f);
  if (body) doc.bodies[f.id] = { name: f.name, color: "#ccc", visible: true };
  return f;
};
const circle = (x: number, y: number, r: number): SketchEntity => ({ id: uid("e"), type: "circle", cx: String(x), cy: String(y), r: String(r) }) as SketchEntity;
const sketchOn = (doc: WhittleDocument, entities: SketchEntity[], offset = "0"): SketchFeature => {
  const s = makeSketch(doc, { kind: "origin", plane: "XY", offset }) as SketchFeature;
  s.entities.push(...entities);
  return push(doc, s);
};
const build = (doc: WhittleDocument) => new Builder().regen(doc, "final");
const volume = (r: ReturnType<typeof build>) => r.bodies.reduce((a, b) => a + b.volume, 0);

function plate(doc: WhittleDocument) {
  const base = makePrimitive(doc, "box", "new");
  if (base.type === "primitive") {
    base.width = "100";
    base.depth = "100";
    base.height = "10";
    base.position = ["0", "0", "0"];
  }
  return push(doc, base, true);
}

it("repeats a boss around an axis, not the plate", () => {
  const doc = newDocument();
  const base = plate(doc);
  const baseVol = volume(build(doc));
  // A 5 mm post, 10 tall, standing on the plate at (30, 0).
  const sk = sketchOn(doc, [circle(30, 0, 5)], "10");
  const ex = push(doc, makeExtrude(doc, sk.id, "join")) as ExtrudeFeature;
  ex.distance = "10";
  const single = volume(build(doc));
  expect(single - baseVol).toBeCloseTo(Math.PI * 25 * 10, 0);

  const pat = push(doc, makePattern(doc, base.id)) as PatternFeature;
  pat.pattern = "circular";
  pat.axis = "z";
  pat.count = "4";
  pat.angle = "360";
  pat.features = [ex.id];
  const r = build(doc);
  const bad = r.status.filter((s) => s.state !== "ok");
  expect(bad, JSON.stringify(bad)).toHaveLength(0);
  expect(r.bodies).toHaveLength(1);
  expect(volume(r) - baseVol).toBeCloseTo(4 * Math.PI * 25 * 10, 0);
});

it("repeats a cut in a row", () => {
  const doc = newDocument();
  const base = plate(doc);
  const baseVol = volume(build(doc));
  const sk = sketchOn(doc, [circle(-30, 0, 4)], "10");
  const ex = push(doc, makeExtrude(doc, sk.id, "cut")) as ExtrudeFeature;
  ex.extent = "one";
  ex.distance = "10";
  ex.flip = true;
  expect(baseVol - volume(build(doc))).toBeCloseTo(Math.PI * 16 * 10, 0);
  const pat = push(doc, makePattern(doc, base.id)) as PatternFeature;
  pat.pattern = "linear";
  pat.axis = "x";
  pat.count = "3";
  pat.spacing = "30";
  pat.features = [ex.id];
  const r = build(doc);
  expect(r.status.filter((s) => s.state !== "ok")).toHaveLength(0);
  expect(baseVol - volume(r)).toBeCloseTo(3 * Math.PI * 16 * 10, 0);
});

it("mirrors a feature across a plane", () => {
  const doc = newDocument();
  const base = plate(doc);
  const baseVol = volume(build(doc));
  const sk = sketchOn(doc, [circle(30, 10, 5)], "10");
  const ex = push(doc, makeExtrude(doc, sk.id, "join")) as ExtrudeFeature;
  ex.distance = "10";
  const mi = push(doc, makeMirror(doc, base.id)) as MirrorFeature;
  mi.plane = "YZ";
  mi.features = [ex.id];
  const r = build(doc);
  expect(r.status.filter((s) => s.state !== "ok")).toHaveLength(0);
  expect(volume(r) - baseVol).toBeCloseTo(2 * Math.PI * 25 * 10, 0);
  const [min, max] = r.bodies[0]!.bbox;
  expect(min[0]).toBeCloseTo(-50, 0);
  expect(max[2]).toBeCloseTo(20, 0);
});

it("explains when a feature makes a new body", () => {
  const doc = newDocument();
  const base = plate(doc);
  const pat = push(doc, makePattern(doc, base.id)) as PatternFeature;
  pat.features = [base.id];
  const r = build(doc);
  const s = r.status.find((x) => x.id === pat.id)!;
  expect(s.state).not.toBe("ok");
});

it("extrudes exactly up to a chosen face, up or down", () => {
  const doc = newDocument();
  plate(doc);
  // A ceiling block 30 mm above the plate's top (z 40 to 50).
  const ceil = makePrimitive(doc, "box", "new");
  if (ceil.type === "primitive") {
    ceil.width = "100";
    ceil.depth = "100";
    ceil.height = "10";
    ceil.position = ["0", "0", "40"];
  }
  push(doc, ceil, true);
  const r0 = build(doc);
  const ceilBody = r0.bodies.find((b) => b.id === ceil.id)!;
  const down = ceilBody.faces.find((f) => f.normal[2] < -0.9)!;
  const sk = sketchOn(doc, [circle(0, 0, 5)], "10");
  const ex = push(doc, makeExtrude(doc, sk.id, "new")) as ExtrudeFeature;
  ex.extent = "face";
  ex.toFace = { bodyId: ceil.id, center: down.center, normal: down.normal, surface: down.surface, area: down.area };
  const r = build(doc);
  expect(r.status.filter((s) => s.state !== "ok")).toHaveLength(0);
  const post = r.bodies.find((b) => b.id === ex.id)!;
  expect(post.volume).toBeCloseTo(Math.PI * 25 * 30, 0);
  // Moving the ceiling up changes the distance with it.
  if (ceil.type === "primitive") ceil.position = ["0", "0", "60"];
  const down2 = build(doc).bodies.find((b) => b.id === ceil.id)!.faces.find((f) => f.normal[2] < -0.9)!;
  ex.toFace = { bodyId: ceil.id, center: down2.center, normal: down2.normal, surface: down2.surface, area: down2.area };
  expect(build(doc).bodies.find((b) => b.id === ex.id)!.volume).toBeCloseTo(Math.PI * 25 * 50, 0);
});
