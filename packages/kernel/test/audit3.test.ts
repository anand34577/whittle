/** Regression and feature tests from the October 2026 audit (third pass). These run the real OpenCascade kernel. */
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { type RevolveFeature, combineBodies, principalMoments, type ShellFeature, type SketchFeature, type WhittleDocument, makeEntity, makeMove, makeOffset, makePrimitive, makeRevolve, makeShell, makeSketch, newDocument } from "@whittle/core";
import { iterTopo, makeBox, makeCompound } from "replicad";
import { Builder } from "../src/build";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") }));
});

const regen = (doc: WhittleDocument) => new Builder().regen(doc, "final");

describe("revolve directions", () => {
  /** A 10 x 10 square 5 mm right of the sketch's vertical axis, turned about it. */
  const revolved = (set: (r: RevolveFeature) => void) => {
    const doc = newDocument();
    const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
    const rect = makeEntity("rect", [5, 0], [15, 10]);
    sk.entities.push(rect);
    const rv = makeRevolve(doc, sk.id) as RevolveFeature;
    set(rv);
    doc.features.push(sk, rv);
    doc.bodies[rv.id] = { name: "R", color: "#ccc", visible: true };
    return regen(doc);
  };
  const full = Math.PI * (15 * 15 - 5 * 5) * 10;

  it("one side, symmetric and two sides turn the same material by the same total angle", () => {
    const one = revolved((r) => void (r.angle = "90"));
    const sym = revolved((r) => void ((r.angle = "90"), (r.extent = "symmetric")));
    const two = revolved((r) => void ((r.angle = "60"), (r.angle2 = "30"), (r.extent = "two")));
    for (const r of [one, sym, two]) {
      expect(r.status.map((s) => s.state)).toEqual(["ok", "ok"]);
      expect(r.bodies[0]!.volume).toBeCloseTo(full / 4, 0);
    }
  });

  it("symmetric sits either side of the profile, one side only one side", () => {
    const xRange = (r: ReturnType<typeof regen>) => [r.bodies[0]!.bbox[0][0], r.bodies[0]!.bbox[1][0]] as const;
    const sym = xRange(revolved((r) => void ((r.angle = "180"), (r.extent = "symmetric"))));
    const one = xRange(revolved((r) => void (r.angle = "180")));
    // The profile lies on +X. Straddling it by 90 degrees each way keeps X >= 0; a half turn from it reaches -X.
    expect(sym[0]).toBeGreaterThan(-0.01);
    expect(one[0]).toBeLessThan(-14);
  });

  it("a second angle can't be negative, and the total never passes a full turn", () => {
    const bad = revolved((r) => void ((r.extent = "two"), (r.angle2 = "-10")));
    expect(bad.status[1]!.state).toBe("error");
    const over = revolved((r) => void ((r.angle = "300"), (r.extent = "two"), (r.angle2 = "200")));
    expect(over.status[1]!.state).toBe("ok");
    expect(over.bodies[0]!.volume).toBeCloseTo(full, 0);
  });
});

describe("shell direction", () => {
  /** A 40 x 30 x 20 box (centred on X and Y, standing on Z = 0), hollowed. */
  const shelled = (set: (s: ShellFeature) => void, openTop = false) => {
    const doc = newDocument();
    const box = makePrimitive(doc, "box");
    const sh = makeShell(doc) as ShellFeature;
    set(sh);
    doc.features.push(box, sh);
    doc.bodies[box.id] = { name: "B", color: "#ccc", visible: true };
    if (openTop) {
      const first = new Builder().regen(doc, "final").bodies[0]!;
      const i = first.faces.findIndex((f) => f.normal[2] > 0.99);
      sh.faces = [{ bodyId: first.id, ...first.faces[i]! }];
    }
    return regen(doc);
  };
  const box = 40 * 30 * 20;
  const hollow = (a: number, b: number, c: number, wall: number) => a * b * c - (a - 2 * wall) * (b - 2 * wall) * (c - 2 * wall);

  it("inside keeps the outer size, outside keeps the cavity size, both splits the wall", () => {
    const inside = shelled((s) => void (s.thickness = "2"));
    const outside = shelled((s) => void ((s.thickness = "2"), (s.direction = "outside")));
    const both = shelled((s) => void ((s.thickness = "2"), (s.direction = "both")));
    for (const r of [inside, outside, both]) expect(r.status.map((s) => s.state)).toEqual(["ok", "ok"]);
    expect(inside.bodies[0]!.volume).toBeCloseTo(hollow(40, 30, 20, 2), 0);
    expect(inside.bodies[0]!.bbox[1][0] - inside.bodies[0]!.bbox[0][0]).toBeCloseTo(40, 3);
    // Outside: the original box is now the cavity, inside a skin 2 mm thick.
    expect(outside.bodies[0]!.bbox[1][0] - outside.bodies[0]!.bbox[0][0]).toBeCloseTo(44, 3);
    expect(outside.bodies[0]!.volume).toBeCloseTo(44 * 34 * 24 - box, 0);
    // Both: 1 mm each way, so the part grows by 2 mm and the cavity shrinks by 2 mm.
    expect(both.bodies[0]!.bbox[1][0] - both.bodies[0]!.bbox[0][0]).toBeCloseTo(42, 3);
    expect(both.bodies[0]!.volume).toBeCloseTo(42 * 32 * 22 - 38 * 28 * 18, 0);
  });

  it("an outside shell can be opened on a face", () => {
    const r = shelled((s) => void ((s.thickness = "2"), (s.direction = "outside")), true);
    expect(r.status.map((s) => s.state)).toEqual(["ok", "ok"]);
    // The cavity is open at the top: a cup 44 x 34 with the original box's footprint as its hollow.
    expect(r.bodies[0]!.volume).toBeCloseTo(44 * 34 * 24 - box - 40 * 30 * 2, 0);
  });
});

describe("mass properties", () => {
  it("a box's inertia matches the textbook values, and a cylinder's principal moments too", () => {
    const doc = newDocument();
    const box = makePrimitive(doc, "box"); // 40 x 30 x 20
    const cyl = makePrimitive(doc, "cylinder");
    if (cyl.type === "primitive") cyl.position = ["200", "0", "0"]; // radius 15, height 20
    doc.features.push(box, cyl);
    doc.bodies[box.id] = { name: "B", color: "#ccc", visible: true };
    doc.bodies[cyl.id] = { name: "C", color: "#ccc", visible: true };
    const r = regen(doc);
    const [b, c] = r.bodies;
    const V = 40 * 30 * 20;
    expect(b!.inertia![0]).toBeCloseTo((V * (30 ** 2 + 20 ** 2)) / 12, -2);
    expect(b!.inertia![2]).toBeCloseTo((V * (40 ** 2 + 30 ** 2)) / 12, -2);
    expect(Math.abs(b!.inertia![3])).toBeLessThan(1); // a symmetric box has no products of inertia
    const Vc = Math.PI * 15 * 15 * 20;
    const pm = principalMoments(c!.inertia!);
    const about = [(Vc * 15 * 15) / 2, (Vc * (3 * 15 * 15 + 20 * 20)) / 12].sort((x, y) => x - y);
    expect(pm[0]).toBeCloseTo(about[0]!, -2);
    expect(pm[2]).toBeCloseTo(about[1]!, -2);
  });

  it("two bodies together obey the parallel-axis theorem", () => {
    // Two unit-mass point-like cubes 10 apart on X: about the middle, Iyy = Izz = 2 * m * 5^2 (+ their own), Ixx = their own.
    const own: [number, number, number, number, number, number] = [1, 1, 1, 0, 0, 0];
    const both = combineBodies([
      { mass: 1, com: [0, 0, 0], inertia: own },
      { mass: 1, com: [10, 0, 0], inertia: own },
    ])!;
    expect(both.com).toEqual([5, 0, 0]);
    expect(both.inertia[0]).toBeCloseTo(2, 9);
    expect(both.inertia[1]).toBeCloseTo(2 + 50, 9);
    expect(both.inertia[2]).toBeCloseTo(2 + 50, 9);
    expect(principalMoments(both.inertia)).toEqual([2, 52, 52].map((v) => expect.closeTo(v, 9)));
  });

  it("principal moments sort out a tilted tensor", () => {
    // Diagonal (1, 2, 3) turned about Z by 30 degrees has the same principal moments.
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const ixx = 1 * c * c + 2 * s * s;
    const iyy = 1 * s * s + 2 * c * c;
    const ixy = (1 - 2) * c * s;
    const pm = principalMoments([ixx, iyy, 3, ixy, 0, 0]);
    expect(pm[0]).toBeCloseTo(1, 9);
    expect(pm[1]).toBeCloseTo(2, 9);
    expect(pm[2]).toBeCloseTo(3, 9);
  });
});

describe("listing a big shape's faces and edges", () => {
  it("is linear (replicad's own listing is quadratic) and finds the same pieces", () => {
    const box = makeBox([0, 0, 0], [10, 10, 5]).fillet(1);
    const comp = makeCompound(Array.from({ length: 60 }, (_, i) => box.clone().translate([i * 12, 0, 0])));
    const t0 = performance.now();
    const faces = comp.faces;
    const edges = comp.edges;
    const fast = performance.now() - t0;
    // The same pieces replicad's own walk finds (it is slow here, so only count them once).
    expect(faces.length).toBe([...iterTopo(comp.wrapped, "face")].length);
    expect(edges.length).toBe([...iterTopo(comp.wrapped, "edge")].length);
    expect(faces.length).toBe(60 * 26);
    expect(fast).toBeLessThan(1000);
    // A shared edge is listed once: a plain box has 12 edges, not 24.
    expect(makeBox([0, 0, 0], [1, 1, 1]).edges).toHaveLength(12);
    expect(makeBox([0, 0, 0], [1, 1, 1]).solids).toHaveLength(1);
  });
});

describe("offsetting a body with a pointed tip", () => {
  // OpenCascade's rounded offset never returns for a pointed cone that sits off the origin's axis or is tilted.
  // (If this ever hangs, the guard in the "offset" feature has been lost.)
  const offsetOf = (position: [string, string, string], tilt: boolean, tip: string) => {
    const doc = newDocument();
    const cone = makePrimitive(doc, "cone");
    if (cone.type === "primitive") {
      cone.position = position;
      cone.radius2 = tip;
    }
    doc.features.push(cone);
    doc.bodies[cone.id] = { name: "C", color: "#ccc", visible: true };
    if (tilt) {
      const mv = makeMove(doc, cone.id);
      if (mv.type === "move") Object.assign(mv, { axis: "x", angle: "35" });
      doc.features.push(mv);
    }
    const off = makeOffset(doc, cone.id);
    if (off.type === "offset") off.distance = "2";
    doc.features.push(off);
    return regen(doc);
  };

  it("builds, off-axis and tilted, and keeps the tip sharp", () => {
    for (const [pos, tilt] of [[["-3", "-19", "0"], false], [["40", "25", "5"], false], [["0", "0", "0"], true], [["-3", "-19", "0"], true]] as const) {
      const r = offsetOf([...pos], tilt, "0");
      expect(r.status.map((x) => x.state), JSON.stringify([pos, tilt])).toEqual(["ok", ...(tilt ? ["ok"] : []), "ok"]);
      // A cone 15 across and 30 tall, grown 2 mm all round with its point kept.
      expect(r.bodies[0]!.volume).toBeCloseTo(12701.4, 0);
    }
  });

  it("a flat-topped cone keeps the usual rounded offset", () => {
    const r = offsetOf(["-3", "-19", "0"], false, "5");
    expect(r.status.map((x) => x.state)).toEqual(["ok", "ok"]);
    expect(r.bodies[0]!.volume).toBeGreaterThan(Math.PI * 15 * 15 * 30 / 3);
  });
});
