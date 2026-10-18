/** Drawing guidance: intersections, points on curves, and lining a new line up with existing ones. */
import { describe, expect, it } from "vitest";
import type { GeomResolved, Vec2 } from "@whittle/core";
import { curveIntersections, directionsFrom, lineUp, nearestOnCurve, nearestOnEllipse, rayMeetsLine } from "../src/viewport/inference";

const line = (id: string, a: Vec2, b: Vec2): GeomResolved => ({ id, type: "line", a, b, construction: false });
const circle = (id: string, c: Vec2, r: number): GeomResolved => ({ id, type: "circle", c, r, construction: false });
const close = (p: Vec2 | undefined, q: Vec2) => {
  expect(p).toBeDefined();
  expect(p![0]).toBeCloseTo(q[0], 6);
  expect(p![1]).toBeCloseTo(q[1], 6);
};

describe("intersections", () => {
  it("finds where two segments cross, but not where they would if extended", () => {
    close(curveIntersections([line("a", [0, 0], [10, 10]), line("b", [0, 10], [10, 0])])[0], [5, 5]);
    expect(curveIntersections([line("a", [0, 0], [1, 1]), line("b", [0, 10], [10, 0])])).toHaveLength(0);
  });
  it("leaves out shared ends (those snap as end points)", () => {
    expect(curveIntersections([line("a", [0, 0], [10, 0]), line("b", [10, 0], [10, 10])])).toHaveLength(0);
  });
  it("crosses lines with circles, and circles with circles", () => {
    const pts = curveIntersections([line("a", [-10, 0], [10, 0]), circle("c", [0, 0], 5)]);
    expect(pts.map((p) => Math.round(p[0])).sort((x, y) => x - y)).toEqual([-5, 5]);
    expect(curveIntersections([circle("c", [0, 0], 5), circle("d", [8, 0], 5)])).toHaveLength(2);
  });
  it("only counts the part of an arc that is drawn", () => {
    // Upper half of a circle of radius 5: the line y = -3 misses it, y = 3 hits it twice.
    const arc: GeomResolved = { id: "r", type: "arc", c: [0, 0], r: 5, a0: 0, sweep: Math.PI, a: [5, 0], b: [-5, 0], construction: false };
    expect(curveIntersections([arc, line("l", [-10, -3], [10, -3])])).toHaveLength(0);
    expect(curveIntersections([arc, line("l", [-10, 3], [10, 3])])).toHaveLength(2);
  });
});

describe("on a curve", () => {
  it("projects onto the nearest curve within reach", () => {
    const hit = nearestOnCurve([line("a", [0, 0], [10, 0]), circle("c", [0, 20], 5)], [4, 0.3], 1);
    expect(hit?.curve).toBe("a");
    close(hit?.p, [4, 0]);
    expect(nearestOnCurve([line("a", [0, 0], [10, 0])], [4, 3], 1)).toBeNull();
  });
});

describe("lining up a new line", () => {
  const slanted = { id: "s", a: [0, 0] as Vec2, b: [10, 10] as Vec2 };
  it("snaps to parallel and perpendicular directions of a slanted line", () => {
    const dirs = directionsFrom([slanted], [], [20, 0]);
    expect(dirs.map((d) => d.type).sort()).toEqual(["parallel", "perpendicular"]);
    const par = lineUp([20, 0], [25.2, 4.9], dirs, 0.5);
    expect(par?.d.type).toBe("parallel");
    close(par?.p, [25.05, 5.05]);
    expect(lineUp([20, 0], [15, 5.3], dirs, 0.5)?.d.type).toBe("perpendicular");
    expect(lineUp([20, 0], [25, 1], dirs, 0.5)).toBeNull();
  });
  it("leaves level and upright lines to the horizontal and vertical guides", () => {
    expect(directionsFrom([{ id: "h", a: [0, 0], b: [10, 0] }], [], [20, 0])).toHaveLength(0);
  });
  it("continues an arc tangentially, forward only", () => {
    // Quarter arc ending at (0, 5), heading toward -x there.
    const arc: GeomResolved = { id: "r", type: "arc", c: [0, 0], r: 5, a0: 0, sweep: Math.PI / 2, a: [5, 0], b: [0, 5], construction: false };
    const at45: GeomResolved = { ...arc, sweep: Math.PI / 4, b: [5 / Math.SQRT2, 5 / Math.SQRT2] } as GeomResolved;
    const from = (at45 as { b: Vec2 }).b;
    const dirs = directionsFrom([], [at45], from);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]!.type).toBe("tangent");
    const ahead: Vec2 = [from[0] - 3, from[1] + 3];
    expect(lineUp(from, ahead, dirs, 0.2)?.d.type).toBe("tangent");
    expect(lineUp(from, [from[0] + 3, from[1] - 3], dirs, 0.2)).toBeNull();
  });
  it("meets a line along a ray (a perpendicular dropped onto it)", () => {
    close(rayMeetsLine([0, 10], [0, -1], [-5, 0], [5, 0])!, [0, 0]);
  });
});

describe("ellipses", () => {
  // 10 by 4 radii, turned 30 degrees about (2, 1).
  const e: Extract<GeomResolved, { type: "ellipse" }> = { id: "e", type: "ellipse", c: [2, 1], a: [2 + 10 * Math.cos(Math.PI / 6), 1 + 10 * Math.sin(Math.PI / 6)], rx: 10, ry: 4, angle: Math.PI / 6, construction: false };
  const onIt = (p: Vec2) => {
    const d: Vec2 = [p[0] - 2, p[1] - 1];
    const [x, y] = [d[0] * Math.cos(Math.PI / 6) + d[1] * Math.sin(Math.PI / 6), -d[0] * Math.sin(Math.PI / 6) + d[1] * Math.cos(Math.PI / 6)];
    return (x / 10) ** 2 + (y / 4) ** 2;
  };
  it("finds the nearest point on the curve, from inside and outside", () => {
    for (const p of [[20, 3], [2, 1.5], [-5, -9], [2, 1]] as Vec2[]) expect(onIt(nearestOnEllipse(e, p))).toBeCloseTo(1, 8);
    const q = nearestOnCurve([e], [2 + 10.5 * Math.cos(Math.PI / 6), 1 + 10.5 * Math.sin(Math.PI / 6)], 1);
    expect(q?.curve).toBe("e");
    close(q!.p, e.a);
  });
  it("crosses lines with ellipses", () => {
    const pts = curveIntersections([e, line("l", [-20, 1], [20, 1])]);
    expect(pts).toHaveLength(2);
    for (const p of pts) expect(onIt(p)).toBeCloseTo(1, 8);
  });
});
