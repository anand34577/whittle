/** Constraint-driven sketches: PlaneGCS solving, profiles from solved geometry, trim and extend. */
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import {
  type ExtrudeFeature,
  type RevolveFeature,
  type SketchFeature,
  type Vec2,
  type WhittleDocument,
  addArc,
  addCircle,
  addConstraint,
  addLine,
  addPoint,
  createEvaluator,
  expandSketch,
  extendGeometry,
  makeExtrude,
  makeRevolve,
  makeSketch,
  migrate,
  newDocument,
  resolveGeometry,
  SCHEMA_VERSION,
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

function extrude(doc: WhittleDocument, sk: SketchFeature, distance = "10") {
  const e = makeExtrude(doc, sk.id) as ExtrudeFeature;
  e.distance = distance;
  doc.features.push(e);
  doc.bodies[e.id] = { name: "Body", color: "#ccc", visible: true };
  return e;
}

const ok = <T,>(r: { id: T } | { error: string }): T => {
  if ("error" in r) throw new Error(r.error);
  return r.id;
};

/** A deliberately crooked four-line loop, joined at shared corner points. */
function quad(sk: SketchFeature, corners: Vec2[]) {
  const p = corners.map((c) => addPoint(sk, c));
  return p.map((a, i) => addLine(sk, a, p[(i + 1) % p.length]!));
}

function rectangle(sk: SketchFeature, w: string, h: string) {
  const [bottom, right, top, left] = quad(sk, [[0.4, -0.3], [33, 1.2], [31, 18], [-1, 22]]) as [string, string, string, string];
  ok(addConstraint(sk, "horizontal", [bottom]));
  ok(addConstraint(sk, "horizontal", [top]));
  ok(addConstraint(sk, "vertical", [left]));
  ok(addConstraint(sk, "vertical", [right]));
  ok(addConstraint(sk, "distance", [bottom], w));
  ok(addConstraint(sk, "distance", [left], h));
  const corner = sk.geometry!.find((g) => g.type === "line" && g.id === bottom)!;
  if (corner.type === "line") ok(addConstraint(sk, "coincident", [corner.a, "origin"]));
  return { bottom, right, top, left };
}

const run = (doc: WhittleDocument) => {
  const r = new Builder().regen(doc, "final");
  const bad = r.status.filter((s) => s.state !== "ok");
  expect(bad, JSON.stringify(bad)).toHaveLength(0);
  return r;
};
const volume = (r: ReturnType<typeof run>) => r.bodies.reduce((a, b) => a + b.volume, 0);

describe("constraint solving", () => {
  it("solves a crooked rectangle to exact size and reports it fully defined", () => {
    const { doc, sk } = setup();
    doc.parameters.push({ id: "p1", name: "w", expr: "40", kind: "length" });
    rectangle(sk, "w", "20");
    extrude(doc, sk);
    const r = run(doc);
    expect(volume(r)).toBeCloseTo(8000, 4);
    const sol = r.sketches[0]!.solution!;
    expect(sol.state).toBe("full");
    expect(sol.dof).toBe(0);
    expect(sol.defined).toHaveLength(sk.geometry!.length);
  });

  it("re-solves when a parameter used by a dimension changes", () => {
    const { doc, sk } = setup();
    doc.parameters.push({ id: "p1", name: "w", expr: "40", kind: "length" });
    rectangle(sk, "w", "w / 2");
    extrude(doc, sk);
    const b = new Builder();
    expect(b.regen(doc, "final").bodies[0]!.volume).toBeCloseTo(40 * 20 * 10, 4);
    doc.parameters[0]!.expr = "60";
    expect(b.regen(doc, "final").bodies[0]!.volume).toBeCloseTo(60 * 30 * 10, 4);
  });

  it("colours only the free geometry as under-defined", () => {
    const { sk } = setup();
    const { bottom } = rectangle(sk, "40", "20");
    sk.constraints = sk.constraints!.filter((c) => !(c.type === "distance" && c.refs[0] !== bottom));
    const sol = solveSketch(sk, createEvaluator([], "mm"))!;
    expect(sol.state).toBe("under");
    expect(sol.dof).toBe(1);
    // The bottom edge is pinned (origin, horizontal, width); the top can still slide up and down.
    expect(sol.defined).toContain(bottom);
    expect(sol.defined).not.toContain(sk.constraints!.find((c) => c.type === "horizontal" && c.refs[0] !== bottom)!.refs[0]);
  });

  it("explains conflicting constraints and names them", () => {
    const { sk } = setup();
    const line = addLine(sk, [0, 0], [10, 1]);
    const h = ok(addConstraint(sk, "horizontal", [line]));
    const v = ok(addConstraint(sk, "vertical", [line]));
    ok(addConstraint(sk, "distance", [line], "25"));
    const sol = solveSketch(sk, createEvaluator([], "mm"))!;
    expect(sol.state).toBe("over");
    expect(sol.bad).toEqual(expect.arrayContaining([h, v]));
    expect(sol.message).toMatch(/Horizontal.*Vertical/);
  });

  it("reports a bad dimension formula as a readable sketch error", () => {
    const { doc, sk } = setup();
    rectangle(sk, "nope * 2", "20");
    const r = new Builder().regen(doc, "final");
    expect(r.status[0]!.state).toBe("error");
    expect(r.status[0]!.message).toMatch(/Distance nope \* 2/);
  });

  it("builds a tangent slot from lines and arcs", () => {
    const { doc, sk } = setup();
    // Rough slot: bottom line, right arc, top line, left arc, sharing end points.
    const [p1, p2, p3, p4] = ([[-10, -4], [11, -6], [9, 5], [-12, 6]] as Vec2[]).map((p) => addPoint(sk, p)) as [string, string, string, string];
    const bottom = addLine(sk, p1, p2);
    const right = addArc(sk, p2, p3, [17, 0])!;
    const top = addLine(sk, p3, p4);
    const left = addArc(sk, p4, p1, [-18, 0])!;
    ok(addConstraint(sk, "horizontal", [bottom]));
    ok(addConstraint(sk, "tangent", [bottom, right]));
    ok(addConstraint(sk, "tangent", [top, right]));
    ok(addConstraint(sk, "tangent", [bottom, left]));
    ok(addConstraint(sk, "tangent", [top, left]));
    ok(addConstraint(sk, "equal", [right, left]));
    ok(addConstraint(sk, "radius", [right], "5"));
    ok(addConstraint(sk, "distance", [bottom], "20"));
    extrude(doc, sk, "4");
    const r = run(doc);
    expect(volume(r)).toBeCloseTo((20 * 10 + Math.PI * 25) * 4, 3);
  });

  it("cuts a constrained circle as a hole and revolves about a construction line", () => {
    const { doc, sk } = setup();
    rectangle(sk, "40", "20");
    const c = addCircle(sk, [18, 9], 3);
    ok(addConstraint(sk, "radius", [c], "4"));
    extrude(doc, sk);
    expect(volume(run(doc))).toBeCloseTo((800 - Math.PI * 16) * 10, 3);

    const { doc: d2, sk: s2 } = setup();
    // A 10 x 20 rectangle 5 mm from a vertical construction axis: a tube with walls 10 thick.
    const [, , , left] = quad(s2, [[5, 0], [15, 0], [15, 20], [5, 20]]);
    const axis = addLine(s2, [0, 0], [0, 10], true);
    ok(addConstraint(s2, "vertical", [axis]));
    void left;
    const rev = makeRevolve(d2, s2.id) as RevolveFeature;
    rev.axis = "line";
    rev.axisLine = axis;
    rev.angle = "360 deg";
    d2.features.push(rev);
    d2.bodies[rev.id] = { name: "Tube", color: "#ccc", visible: true };
    expect(volume(run(d2))).toBeCloseTo(Math.PI * (15 ** 2 - 5 ** 2) * 20, 2);
  });

  it("mirrors points about an axis into an exact trapezoid", () => {
    const { doc, sk } = setup();
    const [bottom, , top] = quad(sk, [[-21, 0.5], [19, -0.4], [11, 9], [-9, 11]]) as [string, string, string, string];
    const ends = (id: string) => {
      const g = sk.geometry!.find((x) => x.id === id)!;
      return g.type === "line" ? [g.a, g.b] : [];
    };
    ok(addConstraint(sk, "symmetric", [...ends(bottom), "yaxis"]));
    ok(addConstraint(sk, "symmetric", [...ends(top), "yaxis"]));
    ok(addConstraint(sk, "coincident", [ends(bottom)[0]!, "xaxis"]));
    ok(addConstraint(sk, "distance", [bottom], "40"));
    ok(addConstraint(sk, "distance", [top], "20"));
    ok(addConstraint(sk, "distance", [top, bottom], "10"));
    extrude(doc, sk);
    const r = run(doc);
    expect(r.sketches[0]!.solution!.state).toBe("full");
    expect(volume(r)).toBeCloseTo(((40 + 20) / 2) * 10 * 10, 4);
  });

  it("puts a hole at a diagonal's midpoint and mirrors a point about it", () => {
    const { doc, sk } = setup();
    const { bottom, right } = rectangle(sk, "40", "20");
    const end = (id: string, k: "a" | "b") => {
      const g = sk.geometry!.find((x) => x.id === id)!;
      return g.type === "line" ? g[k] : "";
    };
    const diag = addLine(sk, end(bottom, "a"), end(right, "b"), true);
    const center = addPoint(sk, [18, 11]);
    const hole = addCircle(sk, center, 4);
    ok(addConstraint(sk, "radius", [hole], "5"));
    ok(addConstraint(sk, "midpoint", [center, diag]));
    const far = addPoint(sk, [37, 22]);
    ok(addConstraint(sk, "symmetric", ["origin", far, center]));
    extrude(doc, sk);
    const r = run(doc);
    const sol = r.sketches[0]!.solution!;
    expect(sol.state).toBe("full");
    expect(sol.points[center]![0]).toBeCloseTo(20, 6);
    expect(sol.points[center]![1]).toBeCloseTo(10, 6);
    expect(sol.points[far]![0]).toBeCloseTo(40, 6);
    expect(sol.points[far]![1]).toBeCloseTo(20, 6);
    expect(volume(r)).toBeCloseTo((800 - Math.PI * 25) * 10, 3);
  });

  it("keeps the two halves of a notched edge collinear", () => {
    const { doc, sk } = setup();
    const [bottom, right, topRight, notchR, notchBottom, notchL, topLeft, left] = quad(sk, [
      [0.3, 0.2], [39, -0.5], [41, 21], [24, 19], [26, 14], [14, 16], [16, 21], [-0.4, 18],
    ]) as string[] as [string, string, string, string, string, string, string, string];
    const p0 = sk.geometry!.find((g) => g.id === bottom)!;
    if (p0.type === "line") ok(addConstraint(sk, "coincident", [p0.a, "origin"]));
    for (const l of [bottom, notchBottom, topRight]) ok(addConstraint(sk, "horizontal", [l]));
    for (const l of [right, left, notchL, notchR]) ok(addConstraint(sk, "vertical", [l]));
    ok(addConstraint(sk, "collinear", [topRight, topLeft]));
    ok(addConstraint(sk, "distance", [bottom], "40"));
    ok(addConstraint(sk, "distance", [left], "20"));
    ok(addConstraint(sk, "distance", [notchBottom], "10"));
    ok(addConstraint(sk, "distance", [topRight], "15"));
    ok(addConstraint(sk, "distance", [notchBottom, topRight], "5"));
    extrude(doc, sk);
    const r = run(doc);
    expect(r.sketches[0]!.solution!.state).toBe("full");
    expect(volume(r)).toBeCloseTo((40 * 20 - 10 * 5) * 10, 4);
  });

  it("keeps old files and plain shape sketches working", () => {
    const doc = migrate({ schema: 1, name: "Old", units: "mm", parameters: [], features: [], bodies: {}, rollback: null });
    expect(doc.schema).toBe(SCHEMA_VERSION);
    const { sk } = setup();
    expect(expandSketch(sk)).toBe(sk);
    expect(solveSketch(sk, createEvaluator([], "mm"))).toBeUndefined();
  });
});

describe("trim and extend", () => {
  const ends = (sk: SketchFeature, id: string) => {
    const g = resolveGeometry(sk).find((x) => x.id === id)!;
    return g.type === "line" ? [g.a.map((v) => +v.toFixed(6)), g.b.map((v) => +v.toFixed(6))] : g;
  };

  it("trims a line back to a crossing and splits a middle piece", () => {
    const { sk } = setup();
    const h = addLine(sk, [-10, 0], [10, 0]);
    addLine(sk, [0, -10], [0, 10]);
    addLine(sk, [5, -10], [5, 10]);
    expect(trimGeometry(sk, h, [8, 0])).toBeUndefined();
    expect(ends(sk, h)).toEqual([[-10, 0], [5, 0]]);
    expect(trimGeometry(sk, h, [2, 0])).toBeUndefined();
    const lines = resolveGeometry(sk).filter((g) => g.type === "line");
    expect(lines).toHaveLength(3);
    expect(ends(sk, h)).toEqual([[-10, 0], [0, 0]]);
    // The trimmed end stays on the line it was cut by.
    expect(sk.constraints!.some((c) => c.type === "coincident" && c.refs[1] !== h)).toBe(true);
  });

  it("turns a crossed circle into an arc and deletes a lone line", () => {
    const { sk } = setup();
    const c = addCircle(sk, [0, 0], 10);
    addLine(sk, [-20, 0], [20, 0]);
    const lone = addLine(sk, [30, 30], [40, 30]);
    expect(trimGeometry(sk, c, [0, 10])).toBeUndefined();
    const arc = resolveGeometry(sk).find((g) => g.id === c)!;
    expect(arc.type).toBe("arc");
    if (arc.type === "arc") expect(arc.sweep).toBeCloseTo(Math.PI, 6);
    trimGeometry(sk, lone, [35, 30]);
    expect(sk.geometry!.some((g) => g.id === lone)).toBe(false);
  });

  it("extends a line and an arc to the next curve", () => {
    const { sk } = setup();
    const l = addLine(sk, [-10, 0], [-5, 0]);
    addLine(sk, [0, -10], [0, 10]);
    expect(extendGeometry(sk, l, [-5, 0])).toBeUndefined();
    expect(ends(sk, l)).toEqual([[-10, 0], [0, 0]]);
    expect(extendGeometry(sk, l, [-10, 0])).toMatch(/nothing to extend/);

    const { sk: s2 } = setup();
    const arc = addArc(s2, [10, 0], [0, 10], [7.0710678, 7.0710678])!;
    addLine(s2, [-20, -1], [20, -1]);
    expect(extendGeometry(s2, arc, [0, 10])).toBeUndefined();
    const g = resolveGeometry(s2).find((x) => x.id === arc)!;
    if (g.type === "arc") expect(g.b[1]).toBeCloseTo(-1, 6);
  });
});
