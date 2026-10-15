/** Shapes as constraint geometry: conversion from entities, sketch fillet and chamfer. */
import { beforeAll, describe, expect, it } from "vitest";
import {
  type SketchFeature,
  type Vec2,
  addEntityGeometry,
  addProjectedPolyline,
  addRectGeometry,
  createEvaluator,
  expandSketch,
  filletCorner,
  makeEntity,
  makeSketch,
  newDocument,
  resolveEntity,
  resolveGeometry,
} from "@whittle/core";
import { initSolver, solveSketch } from "../src/solver";

beforeAll(async () => {
  await initSolver();
});

function sketch(): SketchFeature {
  const doc = newDocument();
  return makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
}

const ev = createEvaluator([], "mm");
const lines = (sk: SketchFeature) => sk.geometry!.filter((g) => g.type === "line");
const arcs = (sk: SketchFeature) => sk.geometry!.filter((g) => g.type === "arc");

describe("entity to geometry", () => {
  it("turns a rectangle into four constrained lines that solve fully level", () => {
    const sk = sketch();
    expect(addEntityGeometry(sk, resolveEntity(makeEntity("rect", [0, 0], [40, 20]), ev))).toBeUndefined();
    expect(lines(sk)).toHaveLength(4);
    const sol = solveSketch(sk, ev)!;
    expect(sol.state).not.toBe("error");
    expect(sol.state).not.toBe("over");
    expect(expandSketch(sk, sol).entities.some((e) => e.type === "polyline")).toBe(true);
  });

  it("keeps a tilted three-point rectangle square", () => {
    const sk = sketch();
    addRectGeometry(sk, [[0, 0], [30, 10], [25, 25], [-5, 15]]);
    const sol = solveSketch(sk, ev)!;
    expect(sol.state).not.toBe("over");
    const g = resolveGeometry(sk, sol).filter((x) => x.type === "line");
    const dir = (l: (typeof g)[number]) => (l.type === "line" ? [l.b[0] - l.a[0], l.b[1] - l.a[1]] : [0, 0]);
    const [u, v] = [dir(g[0]!), dir(g[1]!)] as [number[], number[]];
    expect(Math.abs(u[0]! * v[0]! + u[1]! * v[1]!)).toBeLessThan(1e-3);
  });

  it("converts circles, polygons, slots and rounded rectangles; refuses ellipses", () => {
    const sk = sketch();
    expect(addEntityGeometry(sk, resolveEntity(makeEntity("circle", [0, 0], [5, 0]), ev))).toBeUndefined();
    expect(addEntityGeometry(sk, resolveEntity(makeEntity("polygon", [0, 0], [5, 0]), ev))).toBeUndefined();
    expect(addEntityGeometry(sk, resolveEntity(makeEntity("slot", [0, 0], [20, 0]), ev))).toBeUndefined();
    expect(arcs(sk).length).toBe(2);
    const rr = makeEntity("rect", [0, 0], [30, 20]);
    if (rr.type === "rect") rr.corner = "4";
    addEntityGeometry(sk, resolveEntity(rr, ev));
    expect(arcs(sk).length).toBe(6);
    expect(addEntityGeometry(sk, resolveEntity(makeEntity("ellipse", [0, 0], [5, 3]), ev))).toMatch(/can't be converted/);
  });
});

describe("sketch fillet and chamfer", () => {
  const corner = (sk: SketchFeature) => {
    const l = lines(sk)[0]!;
    return l.type === "line" ? l.b : "";
  };

  it("rounds a corner with a tangent arc of the given radius and keeps the sketch solvable", () => {
    const sk = sketch();
    addEntityGeometry(sk, resolveEntity(makeEntity("rect", [0, 0], [40, 20]), ev));
    expect(filletCorner(sk, corner(sk), 5, "5")).toBeUndefined();
    expect(arcs(sk)).toHaveLength(1);
    expect(lines(sk)).toHaveLength(4);
    const sol = solveSketch(sk, ev)!;
    expect(sol.state).not.toBe("error");
    expect(sol.state).not.toBe("over");
    const arc = resolveGeometry(sk, sol).find((g) => g.type === "arc");
    expect(arc?.type === "arc" ? arc.r : 0).toBeCloseTo(5, 3);
  });

  it("chamfers a corner with a straight cut", () => {
    const sk = sketch();
    addEntityGeometry(sk, resolveEntity(makeEntity("rect", [0, 0], [40, 20]), ev));
    expect(filletCorner(sk, corner(sk), 4, "4", true)).toBeUndefined();
    expect(lines(sk)).toHaveLength(5);
    expect(arcs(sk)).toHaveLength(0);
  });

  it("says why when it can't", () => {
    const sk = sketch();
    addEntityGeometry(sk, resolveEntity(makeEntity("rect", [0, 0], [40, 20]), ev));
    expect(filletCorner(sk, corner(sk), 50, "50")).toMatch(/too big/);
    expect(filletCorner(sk, "origin", 2, "2")).toMatch(/corner/);
    const p: Vec2 = [0, 0];
    expect(p).toBeTruthy();
  });
});

describe("projected edges", () => {
  it("makes a locked line, a circle, an arc and joins shared corners", () => {
    const sk = sketch();
    expect(addProjectedPolyline(sk, [[0, 0], [30, 0]])).toBe(true);
    expect(addProjectedPolyline(sk, [[30, 0], [30, 20]])).toBe(true);
    expect(sk.geometry!.filter((g) => g.type === "point")).toHaveLength(3);
    const ring: Vec2[] = Array.from({ length: 33 }, (_, i) => [50 + 10 * Math.cos((i / 32) * Math.PI * 2), 10 * Math.sin((i / 32) * Math.PI * 2)]);
    expect(addProjectedPolyline(sk, ring)).toBe(true);
    expect(sk.geometry!.some((g) => g.type === "circle")).toBe(true);
    const half: Vec2[] = Array.from({ length: 17 }, (_, i) => [10 * Math.cos((i / 16) * Math.PI), 10 * Math.sin((i / 16) * Math.PI) + 40]);
    expect(addProjectedPolyline(sk, half)).toBe(true);
    expect(sk.geometry!.some((g) => g.type === "arc")).toBe(true);
    expect(addProjectedPolyline(sk, [[5, 5], [5, 5]])).toBe(false);
    const sol = solveSketch(sk, ev)!;
    expect(["under", "full"]).toContain(sol.state);
  });
});
