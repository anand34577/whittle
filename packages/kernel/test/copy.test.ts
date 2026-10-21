/** Mirror, patterns and offset of constraint geometry. */
import { beforeAll, describe, expect, it } from "vitest";
import {
  type SketchFeature,
  type Vec2,
  addEntityGeometry,
  circularPattern,
  createEvaluator,
  linearPattern,
  makeEntity,
  makeSketch,
  mirrorGeometry,
  newDocument,
  offsetGeometry,
  resolveEntity,
  resolveGeometry,
} from "@whittle/core";
import { initSolver, solveSketch } from "../src/solver";

beforeAll(async () => {
  await initSolver();
});

const ev = createEvaluator([], "mm");
const sketch = () => makeSketch(newDocument(), { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
const rect = (sk: SketchFeature, a: Vec2, b: Vec2, corner?: string) => {
  const e = makeEntity("rect", a, b);
  if (corner && e.type === "rect") e.corner = corner;
  addEntityGeometry(sk, resolveEntity(e, ev));
};
const lines = (sk: SketchFeature) => resolveGeometry(sk).filter((g) => g.type === "line");
const ids = (sk: SketchFeature) => sk.geometry!.filter((g) => g.type !== "point").map((g) => g.id);
const bounds = (sk: SketchFeature) => {
  const pts = lines(sk).flatMap((l) => (l.type === "line" ? [l.a, l.b] : []));
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
};

describe("mirror", () => {
  it("copies across the Y axis, holds the copy symmetric and still solves", () => {
    const sk = sketch();
    rect(sk, [10, 0], [40, 20]);
    expect(mirrorGeometry(sk, ids(sk), "yaxis")).toBeUndefined();
    expect(lines(sk)).toHaveLength(8);
    expect(bounds(sk)[0]).toBeCloseTo(-40);
    expect(sk.constraints!.filter((c) => c.type === "symmetric")).toHaveLength(4);
    const sol = solveSketch(sk, ev)!;
    expect(["under", "full"]).toContain(sol.state);
  });

  it("shares points that sit on the mirror line", () => {
    const sk = sketch();
    rect(sk, [0, 0], [30, 20]);
    mirrorGeometry(sk, ids(sk), "yaxis");
    expect(sk.geometry!.filter((g) => g.type === "point")).toHaveLength(6);
  });
});

describe("patterns", () => {
  it("makes a row of copies", () => {
    const sk = sketch();
    rect(sk, [0, 0], [10, 10]);
    expect(linearPattern(sk, ids(sk), 4, 25, 0)).toBeUndefined();
    expect(lines(sk)).toHaveLength(16);
    expect(bounds(sk)[2]).toBeCloseTo(85);
  });

  it("goes round a centre", () => {
    const sk = sketch();
    rect(sk, [20, -5], [30, 5]);
    expect(circularPattern(sk, ids(sk), 4)).toBeUndefined();
    expect(lines(sk)).toHaveLength(16);
    const b = bounds(sk);
    expect(b[0]).toBeCloseTo(-30);
    expect(b[3]).toBeCloseTo(30);
  });
});

describe("offset", () => {
  it("grows a closed rectangle outward", () => {
    const sk = sketch();
    rect(sk, [0, 0], [40, 20]);
    const before = ids(sk);
    expect(offsetGeometry(sk, before, 3)).toBeUndefined();
    expect(lines(sk)).toHaveLength(8);
    const fresh = lines(sk).slice(4).flatMap((l) => (l.type === "line" ? [l.a, l.b] : []));
    expect(Math.min(...fresh.map((p) => p[0]))).toBeCloseTo(-3);
    expect(Math.max(...fresh.map((p) => p[0]))).toBeCloseTo(43);
    expect(Math.max(...fresh.map((p) => p[1]))).toBeCloseTo(23);
  });

  it("shrinks inward with a negative distance", () => {
    const sk = sketch();
    rect(sk, [0, 0], [40, 20]);
    offsetGeometry(sk, ids(sk), -4);
    const fresh = lines(sk).slice(4).flatMap((l) => (l.type === "line" ? [l.a, l.b] : []));
    expect(Math.min(...fresh.map((p) => p[0]))).toBeCloseTo(4);
    expect(Math.max(...fresh.map((p) => p[1]))).toBeCloseTo(16);
  });

  it("follows a rounded rectangle and keeps its arcs concentric", () => {
    const sk = sketch();
    rect(sk, [0, 0], [40, 20], "5");
    expect(offsetGeometry(sk, ids(sk), 2)).toBeUndefined();
    const arcs = resolveGeometry(sk).filter((g) => g.type === "arc");
    expect(arcs).toHaveLength(8);
    expect(arcs.slice(4).every((a) => a.type === "arc" && Math.abs(a.r - 7) < 1e-6)).toBe(true);
  });

  it("keeps the offset as a dimension, so the copy adds no freedom and still solves", () => {
    const sk = sketch();
    rect(sk, [0, 0], [40, 20]);
    const dof0 = solveSketch(sk, ev)!.dof;
    expect(offsetGeometry(sk, ids(sk), -4, "4")).toBeUndefined();
    expect(sk.constraints!.filter((c) => c.type === "distance" && c.value === "4")).toHaveLength(4);
    const sol = solveSketch(sk, ev)!;
    expect(["under", "full"]).toContain(sol.state);
    expect(sol.dof).toBe(dof0);
  });

  it("offsets circles and refuses to collapse them", () => {
    const sk = sketch();
    addEntityGeometry(sk, resolveEntity(makeEntity("circle", [0, 0], [10, 0]), ev));
    expect(offsetGeometry(sk, ids(sk), -12)).toMatch(/shrink/);
    expect(offsetGeometry(sk, ids(sk), 5)).toBeUndefined();
    expect(resolveGeometry(sk).filter((g) => g.type === "circle").map((c) => (c.type === "circle" ? c.r : 0)).sort((a, b) => a - b)).toEqual([10, 15]);
  });
});
