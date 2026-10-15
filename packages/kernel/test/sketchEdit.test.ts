/** Move/copy, scale, grid pattern and break of constraint geometry. */
import { beforeAll, describe, expect, it } from "vitest";
import { type SketchFeature, addCircle, bsplineSamples, addArc, addConstraint, addEntityGeometry, addLine, breakLine, endTangent, tangentArcThrough, createEvaluator, makeEntity, makeSketch, moveGeometry, newDocument, rectPattern, resolveEntity, resolveGeometry, scaleGeometry } from "@whittle/core";
import { initSolver, solveSketch } from "../src/solver";

beforeAll(async () => {
  await initSolver();
});

const ev = createEvaluator([], "mm");
const sketch = () => makeSketch(newDocument(), { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
const rect = (sk: SketchFeature) => addEntityGeometry(sk, resolveEntity(makeEntity("rect", [0, 0], [10, 5]), ev));
const ids = (sk: SketchFeature) => sk.geometry!.filter((g) => g.type !== "point").map((g) => g.id);
const lineCount = (sk: SketchFeature) => resolveGeometry(sk).filter((g) => g.type === "line").length;

describe("sketch edit", () => {
  it("copies a rectangle into a 3 x 2 grid", () => {
    const sk = sketch();
    rect(sk);
    expect(rectPattern(sk, ids(sk), 3, 2, 20, 20)).toBeUndefined();
    expect(lineCount(sk)).toBe(24);
  });

  it("moves in place or adds a copy", () => {
    const sk = sketch();
    rect(sk);
    expect(moveGeometry(sk, ids(sk), 5, 0, true)).toBeUndefined();
    expect(lineCount(sk)).toBe(8);
    expect(moveGeometry(sk, ids(sk), 0, 0, false)).toBeDefined();
  });

  it("scales positions about a base point", () => {
    const sk = sketch();
    rect(sk);
    expect(scaleGeometry(sk, ids(sk), 2, [0, 0])).toBeUndefined();
    const xs = resolveGeometry(sk).flatMap((g) => (g.type === "line" ? [g.a[0], g.b[0]] : []));
    expect(Math.max(...xs)).toBeCloseTo(20);
  });

  it("breaks a line where another crosses it", () => {
    const sk = sketch();
    rect(sk);
    const lines = sk.geometry!.filter((g) => g.type === "line");
    const bottom = lines.find((g) => g.type === "line" && resolveGeometry(sk).some((r) => r.id === g.id && r.type === "line" && r.a[1] === 0 && r.b[1] === 0))!;
    // A vertical cutter through the middle of the bottom edge.
    const cut = makeEntity("polyline", [5, -2], [5, 8]);
    if (cut.type === "polyline") cut.open = true;
    addEntityGeometry(sk, resolveEntity(cut, ev));
    const cutter = sk.geometry!.filter((g) => g.type === "line").pop()!;
    const before = lineCount(sk);
    expect(breakLine(sk, bottom.id, cutter.id)).toBeUndefined();
    expect(lineCount(sk)).toBe(before + 1);
  });
});

describe("tangent arc", () => {
  it("leaves a line smoothly: centre on the normal, and the solver keeps it tangent", () => {
    const sk = sketch();
    const line = addLine(sk, [0, 0], [10, 0]);
    const g = resolveGeometry(sk);
    const t = endTangent(g, [10, 0])!;
    expect(t.curve).toBe(line);
    expect(t.dir[0]).toBeCloseTo(1);
    const arc = tangentArcThrough([10, 0], t.dir, [20, 10])!;
    expect(arc.center[0]).toBeCloseTo(10);
    expect(arc.center[1]).toBeCloseTo(10);
    const lineGeo = sk.geometry!.find((x) => x.id === line)!;
    const id = addArc(sk, (lineGeo as { b: string }).b, [20, 10], arc.through);
    expect(id).not.toBeNull();
    expect("id" in addConstraint(sk, "tangent", [line, id!])).toBe(true);
    expect(solveSketch(sk, ev)?.state).not.toBe("error");
  });

  it("refuses an end point straight ahead of the line", () => {
    expect(tangentArcThrough([0, 0], [1, 0], [5, 0])).toBeNull();
  });
});

describe("tangent circles", () => {
  it("2-tangent circle between two perpendicular lines stays tangent to both", () => {
    const sk = sketch();
    const l1 = addLine(sk, [0, 0], [40, 0]);
    const l2 = addLine(sk, [0, 0], [0, 40]);
    const c = addCircle(sk, [9, 9], 6)!;
    expect("id" in addConstraint(sk, "tangent", [c, l1])).toBe(true);
    expect("id" in addConstraint(sk, "tangent", [c, l2])).toBe(true);
    expect("id" in addConstraint(sk, "radius", [c], "5")).toBe(true);
    expect(solveSketch(sk, ev)?.state).not.toBe("error");
    const sol = solveSketch(sk, ev)!;
    const circle = resolveGeometry(sk, sol).find((g) => g.type === "circle")!;
    if (circle.type !== "circle") throw new Error("no circle");
    expect(circle.r).toBeCloseTo(5, 3);
    const lines = resolveGeometry(sk, sol).filter((g) => g.type === "line");
    for (const l of lines) {
      if (l.type !== "line") continue;
      const [dx, dy] = [l.b[0] - l.a[0], l.b[1] - l.a[1]];
      const d = Math.abs((circle.c[0] - l.a[0]) * dy - (circle.c[1] - l.a[1]) * dx) / Math.hypot(dx, dy);
      expect(d).toBeCloseTo(5, 2);
    }
  });
});

describe("control-point spline", () => {
  it("starts and ends at the end points but passes beside the inner control points", () => {
    const pts = bsplineSamples([[0, 0], [10, 20], [20, 0], [30, 20]], false, 12);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts.at(-1)).toEqual([30, 20]);
    // The curve stays inside the control polygon's hull: it never reaches the 20 mm peak.
    const mid = pts[Math.floor(pts.length / 2)]!;
    expect(mid[1]).toBeGreaterThan(5);
    expect(mid[1]).toBeLessThan(15);
  });

  it("closes into a periodic curve", () => {
    const pts = bsplineSamples([[0, 0], [10, 0], [10, 10], [0, 10]], true, 8);
    expect(pts).toHaveLength(32);
  });
});

describe("sketch intersect", () => {
  it("slices a box mesh into one closed square outline", async () => {
    const { Builder } = await import("../src/build");
    const { createRequire } = await import("node:module");
    const { setOC } = await import("replicad");
    const opencascade = (await import("replicad-opencascadejs")).default;
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setOC(await (opencascade as any)({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") }));
    const { makePrimitive, sliceMesh, chainSegments2D, simplifyChain } = await import("@whittle/core");
    const doc = newDocument();
    const b = makePrimitive(doc, "box");
    if (b.type === "primitive") (b.width = "20"), (b.depth = "20"), (b.height = "20");
    doc.features.push(b);
    doc.bodies[b.id] = { name: "b", color: "#ccc", visible: true };
    const body = new Builder().regen(doc, "final").bodies[0]!;
    const segs = sliceMesh(body, [0, 0, 10], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
    const chains = chainSegments2D(segs);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.closed).toBe(true);
    const pts = simplifyChain(chains[0]!.pts, true);
    expect(pts).toHaveLength(4);
    expect(Math.max(...pts.map((p) => p[0]))).toBeCloseTo(10, 3);
  });
});

describe("DXF import", () => {
  const dxf = (...ents: string[]) => ["0", "SECTION", "2", "ENTITIES", ...ents, "0", "ENDSEC", "0", "EOF"].join("\n");
  const line = (a: number[], b: number[]) => ["0", "LINE", "10", a[0], "20", a[1], "11", b[0], "21", b[1]].map(String).join("\n");

  it("joins loose lines into a closed outline and reads circles", async () => {
    const { parseDxf } = await import("@whittle/core");
    const r = parseDxf(dxf(line([0, 0], [10, 0]), line([10, 0], [10, 10]), line([10, 10], [0, 10]), line([0, 10], [0, 0]), ["0", "CIRCLE", "10", "5", "20", "5", "40", "2"].join("\n")));
    expect(r.loops).toHaveLength(1);
    expect(r.loops[0]!.closed).toBe(true);
    expect(r.loops[0]!.pts).toHaveLength(4);
    expect(r.circles).toEqual([{ c: [5, 5], r: 2 }]);
  });

  it("turns a bulged polyline segment into a true arc", async () => {
    const { parseDxf } = await import("@whittle/core");
    // A semicircle (bulge 1) from (0,0) to (10,0) bulges to the right of travel (below, y < 0).
    const poly = ["0", "LWPOLYLINE", "70", "0", "10", "0", "20", "0", "42", "1", "10", "10", "20", "0"].join("\n");
    const r = parseDxf(dxf(poly));
    expect(r.loops).toHaveLength(1);
    const ys = r.loops[0]!.pts.map((p) => p[1]);
    expect(Math.max(...ys.map(Math.abs))).toBeCloseTo(5, 1);
    expect(Math.min(...ys)).toBeCloseTo(-5, 1);
  });
});
