/** How sketch dimensions are drawn: extension lines and arrows, leaders, angle arcs, and labels that follow the geometry. */
import { describe, expect, it } from "vitest";
import type { GeomResolved, SketchConstraint, Vec2 } from "@whittle/core";
import { dimGraphic, labelFor, lengthEnds } from "../src/viewport/dimGraphics";

const pt = (id: string, p: Vec2): GeomResolved => ({ id, type: "point", p, construction: false });
const line = (id: string, a: Vec2, b: Vec2): GeomResolved => ({ id, type: "line", a, b, construction: false });
const circle = (id: string, c: Vec2, r: number): GeomResolved => ({ id, type: "circle", c, r, construction: false });
const geo = (...g: GeomResolved[]) => new Map(g.map((x) => [x.id, x]));
const dim = (type: SketchConstraint["type"], refs: string[], label?: [number, number]): SketchConstraint => ({ id: "k", type, refs, value: "1", label });
const close = (p: Vec2, q: Vec2) => {
  expect(p[0]).toBeCloseTo(q[0], 6);
  expect(p[1]).toBeCloseTo(q[1], 6);
};

describe("lengths", () => {
  const g = geo(line("l", [0, 0], [40, 0]), pt("p", [10, 20]));

  it("stands away from the middle of the sketch, with two extension lines, a dimension line and two arrows", () => {
    const d = dimGraphic(dim("distance", ["l"]), g, 0.1, [20, 10])!;
    // 28 px of 0.1 mm, below the line (the sketch is above it).
    close(d.label, [20, -2.8]);
    expect(d.lines).toHaveLength(3);
    expect(d.arrows.map((a) => a.dir)).toEqual([
      [-1, -0],
      [1, 0],
    ]);
  });

  it("keeps a dragged label as an offset from what it measures, so it follows when that moves", () => {
    const c = dim("distance", ["l"]);
    const place = labelFor(c, g, [30, 6])!;
    close(place, [6, 10]);
    const moved = geo(line("l", [100, 50], [140, 50]));
    close(dimGraphic({ ...c, label: place }, moved, 0.1, [0, 0])!.label, [130, 56]);
  });

  it("measures from a point to a line at the foot of the perpendicular", () => {
    const ends = lengthEnds(dim("distance", ["p", "l"]), g)!;
    close(ends[0], [10, 20]);
    close(ends[1], [10, 0]);
  });
});

describe("radius and diameter", () => {
  const g = geo(circle("c", [0, 0], 10));

  it("puts a radius on a leader from the curve, the arrow pointing at the curve", () => {
    const d = dimGraphic(dim("radius", ["c"], [0, 5]), g, 0.1, [0, 0])!;
    close(d.label, [15, 0]);
    close(d.arrows[0]!.tip, [10, 0]);
    close(d.arrows[0]!.dir, [-1, 0]);
  });

  it("draws a diameter right across, with an arrow at each side", () => {
    const d = dimGraphic(dim("diameter", ["c"], [Math.PI / 2, 4]), g, 0.1, [0, 0])!;
    close(d.lines[0]![0], [0, -10]);
    close(d.lines[0]![1], [0, 10]);
    expect(d.arrows).toHaveLength(2);
    expect(labelFor(dim("diameter", ["c"]), g, [0, -14])![1]).toBeCloseTo(4, 6);
  });
});

describe("angles", () => {
  it("arcs between two lines about where they meet, with the value halfway round", () => {
    const g = geo(line("a", [0, 0], [10, 0]), line("b", [0, 0], [0, 10]));
    const d = dimGraphic(dim("angle", ["a", "b"], [5, 0]), g, 0.1, [0, 0])!;
    const r = Math.SQRT1_2 * 5;
    close(d.label, [r, r]);
    close(d.arrows[0]!.tip, [5, 0]);
    close(d.arrows[1]!.tip, [0, 5]);
    expect(labelFor(dim("angle", ["a", "b"]), g, [3, 4])![0]).toBeCloseTo(5, 6);
  });

  it("measures a single line from the horizontal through its start", () => {
    const g = geo(line("a", [2, 2], [12, 12]));
    const d = dimGraphic(dim("angle", ["a"], [10, 0]), g, 0.1, [0, 0])!;
    close(d.arrows[0]!.tip, [12, 2]);
    close(d.label, [2 + 10 * Math.cos(Math.PI / 8), 2 + 10 * Math.sin(Math.PI / 8)]);
  });

  it("has nothing to draw for parallel lines", () => {
    expect(dimGraphic(dim("angle", ["a", "b"]), geo(line("a", [0, 0], [10, 0]), line("b", [0, 5], [10, 5])), 0.1, [0, 0])).toBeNull();
  });
});
