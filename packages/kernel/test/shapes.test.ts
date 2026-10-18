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

  it("converts circles, polygons, slots, rounded rectangles and ellipses; refuses text", () => {
    const sk = sketch();
    expect(addEntityGeometry(sk, resolveEntity(makeEntity("circle", [0, 0], [5, 0]), ev))).toBeUndefined();
    expect(addEntityGeometry(sk, resolveEntity(makeEntity("polygon", [0, 0], [5, 0]), ev))).toBeUndefined();
    expect(addEntityGeometry(sk, resolveEntity(makeEntity("slot", [0, 0], [20, 0]), ev))).toBeUndefined();
    expect(arcs(sk).length).toBe(2);
    const rr = makeEntity("rect", [0, 0], [30, 20]);
    if (rr.type === "rect") rr.corner = "4";
    addEntityGeometry(sk, resolveEntity(rr, ev));
    expect(arcs(sk).length).toBe(6);
    expect(addEntityGeometry(sk, resolveEntity(makeEntity("text", [0, 0], [5, 3]), ev))).toMatch(/whole shapes/);
  });

  it("converts an outline with rounded corners into lines and tangent arcs", () => {
    const sk = sketch();
    const l = makeEntity("polyline", [0, 0], [40, 0]);
    if (l.type !== "polyline") throw new Error("no outline");
    l.points = [["0", "0"], ["40", "0"], ["40", "10"], ["15", "10"], ["15", "30"], ["0", "30"]];
    l.corner = "3";
    expect(addEntityGeometry(sk, resolveEntity(l, ev))).toBeUndefined();
    expect(arcs(sk).length).toBe(6);
    const sol = solveSketch(sk, ev)!;
    expect(sol.state).not.toBe("over");
    expect(sk.constraints!.filter((c) => c.type === "radius").map((c) => c.value)).toEqual(Array(6).fill("3"));
  });

  it("converts an ellipse with its long axis as the major one, kept level", () => {
    const sk = sketch();
    // 3 across and 5 up: the major axis is the upright one.
    expect(addEntityGeometry(sk, resolveEntity(makeEntity("ellipse", [0, 0], [3, 5]), ev))).toBeUndefined();
    const sol = solveSketch(sk, ev)!;
    expect(sol.state).toBe("under");
    const e = resolveGeometry(sk, sol).find((g) => g.type === "ellipse")!;
    expect(e.type === "ellipse" && [e.rx, e.ry].map((v) => +v.toFixed(3))).toEqual([5, 3]);
    expect(e.type === "ellipse" && Math.abs(Math.cos(e.angle))).toBeLessThan(1e-6);
    expect(sk.constraints!.map((c) => c.type)).toEqual(["vertical"]);
    const out = expandSketch(sk, sol).entities.find((x) => x.type === "ellipse");
    expect(out).toBeDefined();
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
