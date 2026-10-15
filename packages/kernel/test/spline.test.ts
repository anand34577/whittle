/** Splines as constraint geometry: fit points the solver moves, and profiles built from the curve. */
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import {
  type ExtrudeFeature,
  type SketchFeature,
  type WhittleDocument,
  addArc,
  addConstraint,
  addLine,
  addPoint,
  expandSketch,
  addSpline,
  createEvaluator,
  deleteGeometry,
  makeExtrude,
  makeSketch,
  mirrorGeometry,
  newDocument,
  resolveGeometry,
  trimGeometry,
} from "@whittle/core";
import { Builder } from "../src/build";
import { initSolver, solveSketch } from "../src/solver";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const wasm = require.resolve("replicad-opencascadejs/wasm");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => wasm }));
  await initSolver();
});

function setup(): { doc: WhittleDocument; sk: SketchFeature } {
  const doc = newDocument();
  const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
  doc.features.push(sk);
  return { doc, sk };
}

const ev = createEvaluator([], "mm");

describe("splines", () => {
  it("is drawn through its fit points", () => {
    const { sk } = setup();
    addSpline(sk, [[0, 0], [10, 8], [20, 0], [30, 8]]);
    const g = resolveGeometry(sk).find((x) => x.type === "spline")!;
    expect(g.type === "spline" && g.pts).toHaveLength(4);
    expect(sk.geometry!.filter((x) => x.type === "point")).toHaveLength(4);
  });

  it("follows its points when the solver moves them", () => {
    const { sk } = setup();
    const id = addSpline(sk, [[0, 3], [10, 8], [20, 1]])!;
    const sp = sk.geometry!.find((g) => g.id === id)!;
    const first = sp.type === "spline" ? sp.pts[0]! : "";
    const last = sp.type === "spline" ? sp.pts[2]! : "";
    addConstraint(sk, "coincident", [first, "origin"]);
    addConstraint(sk, "horizontal", [first, last]);
    addConstraint(sk, "distance", [first, last], "40");
    const sol = solveSketch(sk, ev)!;
    expect(sol.state).not.toBe("error");
    expect(sol.points[first]![1]).toBeCloseTo(0, 5);
    expect(sol.points[last]![0]).toBeCloseTo(40, 4);
    expect(sol.points[last]![1]).toBeCloseTo(0, 5);
    const g = resolveGeometry(sk, sol).find((x) => x.type === "spline")!;
    expect(g.type === "spline" && g.pts[2]![0]).toBeCloseTo(40, 4);
  });

  it("a closed spline extrudes into a solid", () => {
    const { doc, sk } = setup();
    addSpline(sk, [[0, 0], [20, -5], [40, 0], [35, 25], [5, 25]], true);
    const e = makeExtrude(doc, sk.id) as ExtrudeFeature;
    e.distance = "10";
    doc.features.push(e);
    doc.bodies[e.id] = { name: "Body", color: "#ccc", visible: true };
    const r = new Builder().regen(doc, "final");
    expect(r.status.filter((s) => s.state !== "ok")).toHaveLength(0);
    expect(r.bodies[0]!.volume).toBeGreaterThan(5000);
    expect(r.bodies[0]!.volume).toBeLessThan(15000);
  });

  it("mirrors with the rest of the sketch, loses deleted points and refuses to be trimmed", () => {
    const { sk } = setup();
    const id = addSpline(sk, [[10, 0], [20, 10], [30, 0]])!;
    expect(mirrorGeometry(sk, [id], "yaxis")).toBeUndefined();
    expect(sk.geometry!.filter((g) => g.type === "spline")).toHaveLength(2);
    expect(trimGeometry(sk, id, [20, 10])).toMatch(/can't be trimmed/);
    const mid = addPoint(sk, [1, 1]);
    expect(mid).toBeTruthy();
    const sp = sk.geometry!.find((g) => g.id === id)!;
    deleteGeometry(sk, [sp.type === "spline" ? sp.pts[1]! : ""]);
    const after = sk.geometry!.find((g) => g.id === id)!;
    expect(after.type === "spline" && after.pts).toHaveLength(2);
  });

  it("joins lines and arcs in one closed outline that extrudes", () => {
    const { doc, sk } = setup();
    const p = [addPoint(sk, [0, 0]), addPoint(sk, [40, 0]), addPoint(sk, [30, 35]), addPoint(sk, [0, 30])];
    addLine(sk, p[0]!, p[1]!);
    addSpline(sk, [p[1]!, [52, 10], [48, 26], p[2]!]);
    addLine(sk, p[2]!, p[3]!);
    addLine(sk, p[3]!, p[0]!);
    const poly = expandSketch(sk).entities.filter((e) => e.type === "polyline");
    expect(poly).toHaveLength(1);
    const pts = poly[0]!.type === "polyline" ? poly[0]!.points : [];
    expect(pts.filter((q) => q[2] === "spline")).toHaveLength(2);
    expect(poly[0]!.type === "polyline" && !poly[0]!.open).toBe(true);
    const e = makeExtrude(doc, sk.id) as ExtrudeFeature;
    e.distance = "10";
    doc.features.push(e);
    doc.bodies[e.id] = { name: "Body", color: "#ccc", visible: true };
    const r = new Builder().regen(doc, "final");
    expect(r.status.filter((st) => st.state !== "ok")).toHaveLength(0);
    // Roughly a 50 x 35 block with a bulging side.
    expect(r.bodies[0]!.volume).toBeGreaterThan(10000);
    expect(r.bodies[0]!.volume).toBeLessThan(20000);
  });

  it("holds a spline tangent to a line where they meet", () => {
    const { sk } = setup();
    const a = addPoint(sk, [0, 0]);
    const b = addPoint(sk, [40, 0]);
    const line = addLine(sk, a, b);
    const spl = addSpline(sk, [b, [50, 8], [62, 22]])!;
    const r = addConstraint(sk, "tangent", [spl, line]);
    expect("id" in r).toBe(true);
    addConstraint(sk, "horizontal", [line]);
    const sol = solveSketch(sk, ev)!;
    expect(sol.state).not.toBe("error");
    expect(sol.state).not.toBe("over");
    const next = sk.geometry!.find((g) => g.id === spl);
    const id = next?.type === "spline" ? next.pts[1]! : "";
    expect(Math.abs(sol.points[id]![1] - sol.points[b]![1])).toBeLessThan(1e-4);
  });

  it("holds a spline tangent to an arc, and says what is missing otherwise", () => {
    const { sk } = setup();
    const s0 = addPoint(sk, [0, 10]);
    const e0 = addPoint(sk, [10, 0]);
    const arc = addArc(sk, s0, e0, [7.07, 7.07] as [number, number])!;
    const spl = addSpline(sk, [e0, [18, 3], [28, -4]])!;
    const other = addSpline(sk, [[100, 0], [110, 5], [120, 0]])!;
    expect(addConstraint(sk, "tangent", [other, arc])).toHaveProperty("error");
    expect(addConstraint(sk, "tangent", [spl, arc])).toHaveProperty("id");
    const sol = solveSketch(sk, ev)!;
    expect(sol.state).not.toBe("error");
    const g = sk.geometry!.find((x) => x.id === spl)!;
    const c = sk.geometry!.find((x) => x.id === arc)!;
    if (g.type === "spline" && c.type === "arc") {
      const [end, next, ctr] = [sol.points[g.pts[0]!]!, sol.points[g.pts[1]!]!, sol.points[c.c]!];
      const dot = (end[0] - ctr[0]) * (next[0] - end[0]) + (end[1] - ctr[1]) * (next[1] - end[1]);
      expect(Math.abs(dot)).toBeLessThan(1e-3);
    }
  });
});
