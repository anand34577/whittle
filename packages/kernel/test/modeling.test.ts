/** Geometry tests: arcs in outlines, thin and through-all extrudes, revolve about a line, offset mirrors, grid patterns. */
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import {
  type ExtrudeFeature,
  type Feature,
  type MirrorFeature,
  type PatternFeature,
  type RevolveFeature,
  type SketchEntity,
  type SketchFeature,
  type WhittleDocument,
  makeExtrude,
  makeMirror,
  makePattern,
  makePrimitive,
  makeRevolve,
  makeSketch,
  newDocument,
  offsetPoints,
  polylinePath,
  polygonArea,
  uid,
} from "@whittle/core";
import { Builder } from "../src/build";

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

function sketch(doc: WhittleDocument, entities: SketchEntity[]): SketchFeature {
  const s = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
  s.entities.push(...entities);
  return push(doc, s);
}

const build = (doc: WhittleDocument) => {
  const r = new Builder().regen(doc, "final");
  const bad = r.status.filter((s) => s.state !== "ok");
  expect(bad, JSON.stringify(bad)).toHaveLength(0);
  return r;
};
const volume = (r: ReturnType<typeof build>) => r.bodies.reduce((a, b) => a + b.volume, 0);
const path = (pts: ([string, string] | [string, string, "arc"])[], open = true): SketchEntity => ({
  id: uid("e"),
  type: "polyline",
  points: pts,
  open,
});

describe("sketch geometry", () => {
  it("samples arcs through their middle point", () => {
    const pts = polylinePath([[-10, 0], [0, 10], [10, 0]], [false, true, false], false, 32);
    expect(pts.length).toBe(33);
    for (const p of pts) expect(Math.hypot(p[0], p[1])).toBeCloseTo(10, 6);
  });

  it("offsets a square outline by a mitred distance", () => {
    const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    // Counter-clockwise: left is inside.
    expect(Math.abs(polygonArea(offsetPoints(sq, -1, true)))).toBeCloseTo(144, 6);
    expect(Math.abs(polygonArea(offsetPoints(sq, 1, true)))).toBeCloseTo(64, 6);
  });
});

describe("modelling", () => {
  it("extrudes an outline with an arc (a D shape)", () => {
    const doc = newDocument();
    const sk = sketch(doc, [path([["0", "-10"], ["10", "0", "arc"], ["0", "10"]], false)]);
    push(doc, { ...(makeExtrude(doc, sk.id) as ExtrudeFeature), distance: "5" }, true);
    expect(volume(build(doc))).toBeCloseTo(((Math.PI * 100) / 2) * 5, 1);
  });

  it("makes a thin wall from an outline and a rib from an open path", () => {
    const doc = newDocument();
    const sq: SketchEntity = { id: uid("e"), type: "rect", x: "0", y: "0", w: "20", h: "20", anchor: "center" };
    const sk = sketch(doc, [sq]);
    push(doc, { ...(makeExtrude(doc, sk.id) as ExtrudeFeature), distance: "10", thin: "2" }, true);
    expect(volume(build(doc))).toBeCloseTo((22 * 22 - 18 * 18) * 10, 1);

    const doc2 = newDocument();
    const rib = sketch(doc2, [path([["0", "0"], ["30", "0"]])]);
    push(doc2, { ...(makeExtrude(doc2, rib.id) as ExtrudeFeature), distance: "5", thin: "2" }, true);
    expect(volume(build(doc2))).toBeCloseTo(30 * 2 * 5, 3);
  });

  it("cuts through everything", () => {
    const doc = newDocument();
    push(doc, { ...makePrimitive(doc, "box"), width: "40", depth: "40", height: "30" } as Feature, true);
    const hole = sketch(doc, [{ id: uid("e"), type: "circle", cx: "0", cy: "0", r: "5" }]);
    push(doc, { ...(makeExtrude(doc, hole.id, "cut") as ExtrudeFeature), extent: "through", distance: "0" });
    expect(volume(build(doc))).toBeCloseTo(40 * 40 * 30 - Math.PI * 25 * 30, 0);
  });

  it("revolves around a line drawn in the sketch", () => {
    const doc = newDocument();
    const sk = sketch(doc, [{ id: uid("e"), type: "circle", cx: "15", cy: "0", r: "2" }]);
    const axis = path([["5", "-5"], ["5", "5"]]);
    sk.entities.push(axis);
    push(doc, { ...(makeRevolve(doc, sk.id) as RevolveFeature), axis: "line", axisLine: axis.id }, true);
    // Torus: ring radius 10 around x = 5.
    expect(volume(build(doc))).toBeCloseTo(2 * Math.PI * 10 * Math.PI * 4, 0);
  });

  it("mirrors across an offset plane and patterns in a grid", () => {
    const doc = newDocument();
    const box = push(doc, { ...makePrimitive(doc, "box"), width: "10", depth: "10", height: "10" } as Feature, true);
    push(doc, { ...(makeMirror(doc, box.id) as MirrorFeature), offset: "20", merge: false }, true);
    const r = build(doc);
    const copy = r.bodies.find((b) => b.id !== box.id)!;
    expect((copy.bbox[0][0] + copy.bbox[1][0]) / 2).toBeCloseTo(40, 6);

    const doc2 = newDocument();
    const b2 = push(doc2, { ...makePrimitive(doc2, "box"), width: "10", depth: "10", height: "10" } as Feature, true);
    push(doc2, { ...(makePattern(doc2, b2.id) as PatternFeature), count: "3", spacing: "20", count2: "2", spacing2: "15", merge: false }, true);
    expect(volume(build(doc2))).toBeCloseTo(6 * 1000, 1);
  });
});
