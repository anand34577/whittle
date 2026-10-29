/** Sketches whose lines cross, overshoot or meet at junctions still give closed shapes (issue #21). */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { type ExtrudeFeature, type RevolveFeature, type SketchFeature, type WhittleDocument, addArc, addCircle, addConstraint, addLine, addPoint, drawnEntities, expandSketch, resolveGeometry, trimGeometry, makeExtrude, makeRevolve, makeSketch, migrate, newDocument, solidEntities } from "@whittle/core";
import { Builder } from "../src/build";
import { initSolver } from "../src/solver";

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

const run = (doc: WhittleDocument) => {
  const r = new Builder().regen(doc, "final");
  const bad = r.status.filter((s) => s.state !== "ok");
  expect(bad, JSON.stringify(bad)).toHaveLength(0);
  return r;
};
const volume = (r: ReturnType<typeof run>) => r.bodies.reduce((a, b) => a + b.volume, 0);

/** A 20 x 10 rectangle from four lines that each run 2 past the corners, joined nowhere. */
function hash(sk: SketchFeature, x0 = 0, y0 = 0) {
  addLine(sk, [x0 - 2, y0], [x0 + 22, y0]);
  addLine(sk, [x0 - 2, y0 + 10], [x0 + 22, y0 + 10]);
  addLine(sk, [x0, y0 - 2], [x0, y0 + 12]);
  addLine(sk, [x0 + 20, y0 - 2], [x0 + 20, y0 + 12]);
}

describe("overlapping sketch geometry", () => {
  it("extrudes the area enclosed by lines that overshoot each other", () => {
    const { doc, sk } = setup();
    hash(sk);
    extrude(doc, sk);
    expect(volume(run(doc))).toBeCloseTo(20 * 10 * 10, 3);
  });

  it("revolves the area enclosed by crossing lines", () => {
    const { doc, sk } = setup();
    hash(sk, 5, 0);
    const axis = addLine(sk, [0, -5], [0, 20], true);
    const rv = makeRevolve(doc, sk.id) as RevolveFeature;
    rv.axis = "line";
    rv.axisLine = axis;
    rv.angle = "360 deg";
    doc.features.push(rv);
    doc.bodies[rv.id] = { name: "Body", color: "#ccc", visible: true };
    // A ring from radius 5 to 25, 10 tall.
    expect(volume(run(doc))).toBeCloseTo(Math.PI * (25 * 25 - 5 * 5) * 10, 0);
  });

  it("extrudes a rectangle split by a line between two corners", () => {
    const { doc, sk } = setup();
    const p = [addPoint(sk, [0, 0]), addPoint(sk, [20, 0]), addPoint(sk, [20, 10]), addPoint(sk, [0, 10])];
    for (let i = 0; i < 4; i++) addLine(sk, p[i]!, p[(i + 1) % 4]!);
    addLine(sk, p[0]!, p[2]!);
    extrude(doc, sk);
    expect(volume(run(doc))).toBeCloseTo(2000, 3);
  });

  it("extrudes a T-joint and a loose end", () => {
    const { doc, sk } = setup();
    // A rectangle whose right side carries on upward past the corner, and a line ending on the bottom edge.
    addLine(sk, [0, 0], [20, 0]);
    addLine(sk, [20, 0], [20, 15]);
    addLine(sk, [20, 10], [0, 10]);
    addLine(sk, [0, 10], [0, 0]);
    addLine(sk, [10, 0], [10, -5]);
    extrude(doc, sk);
    expect(volume(run(doc))).toBeCloseTo(2000, 3);
  });

  it("keeps an arc true when a line cuts it", () => {
    const { doc, sk } = setup();
    // A half disc of radius 10 whose chord overshoots both ends.
    const arc = addArc(sk, [10, 0], [-10, 0], [0, 10])!;
    expect(arc).toBeTruthy();
    addLine(sk, [-15, 0], [15, 0]);
    extrude(doc, sk);
    expect(volume(run(doc))).toBeCloseTo((Math.PI * 100) / 2 * 10, 2);
  });

  it("marks the enclosed area so thin walls and exports follow the lines alone", () => {
    const { sk } = setup();
    hash(sk);
    const out = expandSketch(sk).entities;
    expect(out.filter((e) => e.type === "polyline" && e.area)).toHaveLength(1);
    expect(out.filter((e) => e.type === "polyline" && e.open)).toHaveLength(4);
  });

  it("makes a hole of a loose-line square inside another", () => {
    const { doc, sk } = setup();
    hash(sk);
    addLine(sk, [5, 3], [15, 3]);
    addLine(sk, [15, 3], [15, 7]);
    addLine(sk, [15, 7], [5, 7]);
    addLine(sk, [5, 7], [5, 3]);
    extrude(doc, sk);
    expect(volume(run(doc))).toBeCloseTo((200 - 40) * 10, 3);
  });

  it("builds the sketch from issue #21: arcs joined partway along each other", () => {
    // The reporter's file: a half disc with two round notches, every corner a point placed on another curve.
    const doc = migrate(JSON.parse(readFileSync(new URL("./fixtures/issue21-sketch.json", import.meta.url), "utf8")));
    const r = run(doc);
    const vol = Object.fromEntries(r.bodies.map((b) => [b.id, b.volume]));
    // Area 967.7 mm² (worked out separately), extruded 10 and revolved a full turn about Y (Pappus).
    expect(vol["exmvpdpy5jbkvmkm"]).toBeCloseTo(9677, -1);
    expect(vol["rvmvpdmtm47j5xeg"]).toBeCloseTo(66007, -2);
  });

  it("adds a bump made by an arc whose ends sit on a joined rectangle's edge", () => {
    const { doc, sk } = setup();
    const p = [addPoint(sk, [0, 0]), addPoint(sk, [20, 0]), addPoint(sk, [20, 10]), addPoint(sk, [0, 10])];
    const sides = p.map((a, i) => addLine(sk, a, p[(i + 1) % 4]!));
    // A half circle of radius 5 standing on the top edge, its ends held on that edge.
    const arc = addArc(sk, [15, 10], [5, 10], [10, 15])!;
    const g = sk.geometry!.find((x) => x.id === arc)!;
    if (g.type !== "arc") throw new Error("no arc");
    for (const end of [g.a, g.b]) {
      const k = addConstraint(sk, "coincident", [end, sides[2]!]);
      expect("id" in k).toBe(true);
    }
    extrude(doc, sk);
    expect(volume(run(doc))).toBeCloseTo((200 + (Math.PI * 25) / 2) * 10, 2);
  });

  it("keeps a circle whole when a line runs through it", () => {
    const { doc, sk } = setup();
    addCircle(sk, [0, 0], 10);
    addLine(sk, [-15, 3], [15, 3]);
    extrude(doc, sk);
    expect(volume(run(doc))).toBeCloseTo(Math.PI * 100 * 10, 2);
    const out = expandSketch(sk).entities;
    // One outline for the solid (the line doesn't split it), and the circle itself kept for export and walls.
    expect(solidEntities(out).filter((e) => e.type === "polyline" && e.area)).toHaveLength(1);
    expect(solidEntities(out).filter((e) => e.type === "circle")).toHaveLength(0);
    expect(drawnEntities(out).filter((e) => e.type === "circle")).toHaveLength(1);
  });

  it("puts a split-up outline back for a thin wall", () => {
    const { doc, sk } = setup();
    const p = [addPoint(sk, [0, 0]), addPoint(sk, [20, 0]), addPoint(sk, [20, 10]), addPoint(sk, [0, 10])];
    p.forEach((a, i) => addLine(sk, a, p[(i + 1) % 4]!));
    const e = extrude(doc, sk);
    e.thin = "1";
    const ring = volume(run(doc));
    // A loose line across the middle adds its own band; the rectangle's wall stays.
    addLine(sk, [10, -5], [10, 15]);
    const both = volume(run(doc));
    expect(ring).toBeCloseTo((21 * 11 - 19 * 9) * 10, 3);
    expect(both).toBeGreaterThan(ring + 9 * 10 - 1e-6);
  });

  it("keeps a thin wall hollow where loose lines close a ring", () => {
    // Four lines crossing at the corners: each makes a 1 wide band, and joined they must leave the middle open.
    for (const side of ["center", "inside", "outside"] as const) {
      const { doc, sk } = setup();
      hash(sk);
      const e = extrude(doc, sk);
      e.thin = "1";
      e.thinSide = side;
      expect(volume(run(doc))).toBeCloseTo((24 * 2 + 14 * 2 - 4) * 10, 3);
    }
  });

  it("keeps both openings when a loose line crosses a joined outline's thin wall", () => {
    const { doc, sk } = setup();
    const p = [addPoint(sk, [0, 0]), addPoint(sk, [20, 0]), addPoint(sk, [20, 10]), addPoint(sk, [0, 10])];
    p.forEach((a, i) => addLine(sk, a, p[(i + 1) % 4]!));
    addLine(sk, [-5, 5], [25, 5]);
    const e = extrude(doc, sk);
    e.thin = "1";
    // The rectangle's wall (21 x 11 less 19 x 9) and the line's 30 long band, less the two squares where they cross.
    expect(volume(run(doc))).toBeCloseTo((21 * 11 - 19 * 9 + 30 - 2) * 10, 3);
  });

  it("gives a surface along the lines only, with no second wall on the area they enclose", () => {
    const { doc, sk } = setup();
    hash(sk);
    const e = extrude(doc, sk);
    e.surface = true;
    const r = run(doc);
    const area = r.bodies.flatMap((b) => b.faces).reduce((a, f) => a + f.area, 0);
    // Two 24-long and two 14-long walls, 10 tall.
    expect(area).toBeCloseTo((2 * 24 + 2 * 14) * 10, 2);
  });

  it("trims without leaving slivers where two circles cross on the line", () => {
    const { sk } = setup();
    addCircle(sk, [0, 0], 10);
    addCircle(sk, [10, 0], 10);
    // Runs a hair beside the points where the circles cross, so each circle cuts it at a slightly different place.
    const line = addLine(sk, [5.0005, -20], [5.0005, 20]);
    expect(trimGeometry(sk, line, [5, 15])).toBeUndefined();
    expect(trimGeometry(sk, line, [5, -15])).toBeUndefined();
    // One line is left, from one crossing to the other: no sliver beside either end.
    const lines = resolveGeometry(sk).filter((g) => g.type === "line");
    expect(lines).toHaveLength(1);
    const l = lines[0]!;
    if (l.type !== "line") throw new Error("not a line");
    expect(Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1])).toBeCloseTo(2 * Math.sqrt(75), 2);
    // Each end is held where the two circles cross: on both of them.
    const src = sk.geometry!.find((g) => g.id === line)!;
    if (src.type !== "line") throw new Error("not a line");
    for (const end of [src.a, src.b]) expect(sk.constraints!.filter((c) => c.type === "coincident" && c.refs[0] === end)).toHaveLength(2);
    // Trimming what's left removes it whole.
    expect(trimGeometry(sk, line, [5, 0])).toBeUndefined();
    expect(resolveGeometry(sk).filter((g) => g.type === "line")).toHaveLength(0);
  });

  it("says where an end stops just short of a curve", () => {
    const { doc, sk } = setup();
    addLine(sk, [0, 0], [20, 0]);
    addLine(sk, [20, 0], [10, 10]);
    // Stops 0.01 short of the line it was meant to land on.
    addLine(sk, [10, 10], [0, 0.01]);
    extrude(doc, sk);
    const r = new Builder().regen(doc, "final");
    const msg = r.status.find((x) => x.state !== "ok")?.message ?? "";
    expect(msg).toMatch(/stops 0\.01 mm short/);
    expect(msg, msg).toMatch(/near \(0, 0(\.01)?\)/);
  });

  it("fills an arc that goes most of the way round, closed by a line across its gap", () => {
    const { doc, sk } = setup();
    // 300° of a radius-10 circle, open on the right; a line at x = 8 crosses it just inside both ends.
    addArc(sk, [10 * Math.cos(Math.PI / 6), 10 * Math.sin(Math.PI / 6)], [10 * Math.cos(Math.PI / 6), -10 * Math.sin(Math.PI / 6)], [-10, 0]);
    addLine(sk, [8, -8], [8, 8]);
    extrude(doc, sk, "1");
    // The disc less the slice beyond the chord at 8: r²·acos(d/r) − d·√(r²−d²).
    expect(volume(run(doc))).toBeCloseTo(Math.PI * 100 - (100 * Math.acos(0.8) - 48), 2);
  });

  it("fills a circle cut through by an arc as one shape", () => {
    const { doc, sk } = setup();
    addCircle(sk, [0, 0], 10);
    addArc(sk, [-15, 0], [15, 0], [0, 5]);
    extrude(doc, sk, "1");
    expect(volume(run(doc))).toBeCloseTo(Math.PI * 100, 2);
  });

  it("fills two loose-line squares that touch at one corner", () => {
    const { doc, sk } = setup();
    hash(sk);
    // A second rectangle whose corner is the first one's top right corner.
    addLine(sk, [18, 10], [42, 10]);
    addLine(sk, [18, 20], [42, 20]);
    addLine(sk, [20, 8], [20, 22]);
    addLine(sk, [40, 8], [40, 22]);
    extrude(doc, sk, "1");
    expect(volume(run(doc))).toBeCloseTo(400, 3);
  });

  it("builds a dense grid of crossing lines quickly", () => {
    const { doc, sk } = setup();
    for (let i = 0; i <= 30; i++) {
      addLine(sk, [i, -1], [i, 31]);
      addLine(sk, [-1, i], [31, i]);
    }
    extrude(doc, sk, "1");
    const t = performance.now();
    expect(volume(run(doc))).toBeCloseTo(900, 3);
    expect(performance.now() - t).toBeLessThan(5000);
  });

  it("builds random tangles of lines and arcs without the geometry engine failing", () => {
    let seed = 3;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let trial = 0; trial < 40; trial++) {
      const { doc, sk } = setup();
      const P = (): [number, number] => [rnd() * 20, rnd() * 20];
      for (let i = 2 + Math.floor(rnd() * 7); i > 0; i--) {
        const r = rnd();
        if (r < 0.25) addArc(sk, P(), P(), P());
        else if (r < 0.35) addCircle(sk, P(), 1 + rnd() * 6);
        else addLine(sk, P(), P());
      }
      extrude(doc, sk, "1");
      const r = new Builder().regen(doc, "final");
      // Either it builds, or it says there's nothing closed: never a geometry error.
      for (const s of r.status) if (s.state !== "ok") expect(s.message).toMatch(/no closed shapes/);
    }
  });

  it("leaves ordinary loops and open paths alone", () => {
    const { sk } = setup();
    const p = [addPoint(sk, [0, 0]), addPoint(sk, [20, 0]), addPoint(sk, [20, 10])];
    addLine(sk, p[0]!, p[1]!);
    addLine(sk, p[1]!, p[2]!);
    const out = expandSketch(sk).entities;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "polyline", open: true });
  });
});
