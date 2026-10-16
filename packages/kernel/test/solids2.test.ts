import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import {
  type AlignFeature,
  type BoundaryFillFeature,
  type ConstructFeature,
  type DeleteFaceFeature,
  type Feature,
  type MirrorFeature,
  type PatternFeature,
  type PrimitiveFeature,
  type ReplaceFaceFeature,
  type RibFeature,
  type SketchEntity,
  type SketchFeature,
  type SplitFeature,
  type ThreadFeature,
  type WhittleDocument,
  makeAlign,
  makeBoundaryFill,
  makeConstruct,
  makeDeleteFace,
  makeMirror,
  makePattern,
  makePrimitive,
  makeReplaceFace,
  makeRib,
  makeSketch,
  makeSplit,
  makeThread,
  newDocument,
  uid,
} from "@whittle/core";
import { Builder } from "../src/build";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const wasm = require.resolve("replicad-opencascadejs/wasm");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => wasm }));
});

function push<T extends Feature>(doc: WhittleDocument, f: T, body = false): T {
  doc.features.push(f);
  if (body) doc.bodies[f.id] = { name: f.name, color: "#ccc", visible: true };
  return f;
}
function prim(doc: WhittleDocument, shape: PrimitiveFeature["shape"], set: Partial<PrimitiveFeature> = {}): PrimitiveFeature {
  const p = makePrimitive(doc, shape) as PrimitiveFeature;
  Object.assign(p, set);
  p.op = "new";
  return push(doc, p, true);
}
function sketch(doc: WhittleDocument, entities: SketchEntity[], plane: SketchFeature["plane"] = { kind: "origin", plane: "XY", offset: "0" }): SketchFeature {
  const s = makeSketch(doc, plane) as SketchFeature;
  s.entities.push(...entities);
  return push(doc, s);
}
const regen = (doc: WhittleDocument) => new Builder().regen(doc, "final");
const status = (r: ReturnType<typeof regen>, id: string) => r.status.find((s) => s.id === id)!;
const vol = (r: ReturnType<typeof regen>, i = 0) => r.bodies[i]!.volume;
const plane = (doc: WhittleDocument, p: "XY" | "XZ" | "YZ", offset: string, extra: object = {}) =>
  push(doc, { id: uid("cp"), type: "cplane", name: "P", plane: { kind: "origin", plane: p, offset, ...extra } } as Feature);

describe("rib", () => {
  it("adds a thin wall from a line in the sketch plane", () => {
    const doc = newDocument();
    prim(doc, "box", { width: "40", depth: "40", height: "10" });
    const s = sketch(doc, [{ id: uid("e"), type: "polyline", open: true, points: [["0", "0"], ["20", "0"]] }], { kind: "origin", plane: "XY", offset: "10" });
    const rib = push(doc, makeRib(doc, s.id) as RibFeature);
    rib.thickness = "2";
    rib.depth = "6";
    const r = regen(doc);
    expect(status(r, rib.id).state, status(r, rib.id).message).toBe("ok");
    // The line sits on the top face, so half of the 2 mm thickness is already inside the body.
    expect(vol(r)).toBeCloseTo(40 * 40 * 10 + 20 * 6 * 1, 0);
  });
});

describe("thread", () => {
  it("cuts a helical groove into a rod", () => {
    const doc = newDocument();
    const rod = prim(doc, "cylinder", { radius: "5", height: "20" });
    const r0 = regen(doc);
    const before = vol(r0);
    const side = r0.bodies[0]!.faces.find((f) => f.surface === "CYLINDRE")!;
    const th = push(doc, makeThread(doc) as ThreadFeature);
    th.face = { bodyId: rod.id, ...side };
    th.pitch = "2";
    const r = regen(doc);
    expect(status(r, th.id).state, status(r, th.id).message).toBe("ok");
    expect(vol(r)).toBeLessThan(before - 5);
    expect(vol(r)).toBeGreaterThan(before * 0.6);
  });
});

describe("replace face", () => {
  it("pulls a face out to a construction plane", () => {
    const doc = newDocument();
    const b = prim(doc, "box", { width: "20", depth: "20", height: "10" });
    const top = regen(doc).bodies[0]!.faces.find((f) => f.normal[2] > 0.99)!;
    const p = plane(doc, "XY", "15");
    const rf = push(doc, makeReplaceFace(doc) as ReplaceFaceFeature);
    rf.faces = [{ bodyId: b.id, ...top }];
    rf.plane = p.id;
    const r = regen(doc);
    expect(status(r, rf.id).state, status(r, rf.id).message).toBe("ok");
    expect(vol(r)).toBeCloseTo(20 * 20 * 15, 0);
  });

  it("tilts a top face onto a sloped plane", () => {
    const doc = newDocument();
    const b = prim(doc, "box", { width: "20", depth: "20", height: "10" });
    const top = regen(doc).bodies[0]!.faces.find((f) => f.normal[2] > 0.99)!;
    const p = plane(doc, "XY", "10", { angle: String(Math.atan(0.5) * (180 / Math.PI)), tilt: "y" });
    const rf = push(doc, makeReplaceFace(doc) as ReplaceFaceFeature);
    rf.faces = [{ bodyId: b.id, ...top }];
    rf.plane = p.id;
    const r = regen(doc);
    expect(status(r, rf.id).state, status(r, rf.id).message).toBe("ok");
    expect(r.bodies[0]!.faces.some((f) => Math.abs(f.normal[0]) > 0.3 && f.normal[2] > 0.3)).toBe(true);
  });
});

describe("delete face", () => {
  it("heals a through hole", () => {
    const doc = newDocument();
    const b = prim(doc, "box", { width: "20", depth: "20", height: "10" });
    const hole = prim(doc, "cylinder", { radius: "3", height: "10" });
    hole.op = "cut";
    hole.target = b.id;
    delete doc.bodies[hole.id];
    const r0 = regen(doc);
    expect(vol(r0)).toBeLessThan(4000);
    const wall = r0.bodies[0]!.faces.find((f) => f.surface === "CYLINDRE")!;
    const df = push(doc, makeDeleteFace(doc) as DeleteFaceFeature);
    df.faces = [{ bodyId: b.id, ...wall }];
    const r = regen(doc);
    expect(status(r, df.id).state, status(r, df.id).message).toBe("ok");
    expect(vol(r)).toBeCloseTo(4000, 0);
  });
});

describe("align", () => {
  it("snaps one body face onto another", () => {
    const doc = newDocument();
    const a = prim(doc, "box", { width: "10", depth: "10", height: "10" });
    const b = prim(doc, "box", { width: "10", depth: "10", height: "10", position: ["50", "0", "0"] });
    const r0 = regen(doc);
    const faceA = r0.bodies.find((x) => x.id === a.id)!.faces.find((f) => f.normal[0] > 0.99)!;
    const faceB = r0.bodies.find((x) => x.id === b.id)!.faces.find((f) => f.normal[0] < -0.99)!;
    const al = push(doc, makeAlign(doc, b.id) as AlignFeature);
    al.from = { bodyId: b.id, ...faceB };
    al.to = { bodyId: a.id, ...faceA };
    const r = regen(doc);
    expect(status(r, al.id).state, status(r, al.id).message).toBe("ok");
    const moved = r.bodies.find((x) => x.id === b.id)!;
    expect(moved.bbox[0][0]).toBeCloseTo(5, 3);
  });
});

describe("boundary fill", () => {
  it("keeps the overlap of two bodies as a new body", () => {
    const doc = newDocument();
    const a = prim(doc, "box", { width: "10", depth: "10", height: "10" });
    const b = prim(doc, "box", { width: "10", depth: "10", height: "10", position: ["5", "0", "0"] });
    const bf = push(doc, makeBoundaryFill(doc, [a.id, b.id]) as BoundaryFillFeature);
    let r = regen(doc);
    expect(status(r, bf.id).state).toBe("incomplete");
    expect(status(r, bf.id).cells?.length).toBe(3);
    const overlap = status(r, bf.id).cells!.findIndex((c) => Math.abs(c.volume - 500) < 1);
    expect(overlap).toBeGreaterThanOrEqual(0);
    bf.cells = [overlap];
    r = regen(doc);
    expect(status(r, bf.id).state, status(r, bf.id).message).toBe("ok");
    expect(r.bodies.find((x) => x.id === bf.id)!.volume).toBeCloseTo(500, 0);
  });
});

describe("split faces, path and axis patterns", () => {
  it("splits faces without separating the body", () => {
    const doc = newDocument();
    const b = prim(doc, "box", { width: "20", depth: "20", height: "10" });
    const before = regen(doc).bodies[0]!.faces.length;
    const sp = push(doc, makeSplit(doc, b.id) as SplitFeature);
    sp.plane = "YZ";
    sp.offset = "0";
    sp.facesOnly = true;
    const r = regen(doc);
    expect(status(r, sp.id).state, status(r, sp.id).message).toBe("ok");
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0]!.faces.length).toBeGreaterThan(before);
    expect(vol(r)).toBeCloseTo(4000, 0);
  });

  it("repeats a body along a path", () => {
    const doc = newDocument();
    const b = prim(doc, "box", { width: "4", depth: "4", height: "4" });
    const s = sketch(doc, [{ id: uid("e"), type: "polyline", open: true, points: [["0", "0"], ["40", "0"]] }]);
    const pt = push(doc, makePattern(doc, b.id) as PatternFeature);
    pt.pattern = "path";
    pt.path = s.id;
    pt.count = "3";
    pt.merge = false;
    const r = regen(doc);
    expect(status(r, pt.id).state, status(r, pt.id).message).toBe("ok");
    const copies = r.bodies.find((x) => x.id === pt.id)!;
    expect(copies.bbox[1][0]).toBeCloseTo(42, 3);
  });

  it("patterns around a construction axis and mirrors across a construction plane", () => {
    const doc = newDocument();
    const b = prim(doc, "box", { width: "4", depth: "4", height: "4", position: ["10", "0", "0"] });
    const ax = push(doc, makeConstruct(doc, "axis2p") as ConstructFeature);
    ax.points.push([0, 0, 0], [0, 0, 1]);
    const pt = push(doc, makePattern(doc, b.id) as PatternFeature);
    pt.pattern = "circular";
    pt.axisRef = ax.id;
    pt.count = "4";
    pt.angle = "360";
    pt.merge = false;
    let r = regen(doc);
    expect(status(r, pt.id).state, status(r, pt.id).message).toBe("ok");
    expect(r.bodies.find((x) => x.id === pt.id)!.bbox[0][0]).toBeCloseTo(-12, 3);
    const cp = plane(doc, "YZ", "20");
    const mi = push(doc, makeMirror(doc, b.id) as MirrorFeature);
    mi.planeRef = cp.id;
    mi.merge = false;
    r = regen(doc);
    expect(status(r, mi.id).state, status(r, mi.id).message).toBe("ok");
    expect(r.bodies.find((x) => x.id === mi.id)!.bbox[0][0]).toBeCloseTo(28, 3);
  });
});

describe("variable radius fillet", () => {
  it("rounds an edge with a radius that grows along it", async () => {
    const { makeFillet } = await import("@whittle/core");
    const volumeWith = (r1: string, r2?: string) => {
      const doc = newDocument();
      const b = prim(doc, "box", { width: "20", depth: "20", height: "20" });
      const body = regen(doc).bodies[0]!;
      const e = body.edges.find((x) => Math.abs(x.tangent[2]) > 0.99)!;
      const f = push(doc, makeFillet(doc) as import("@whittle/core").FilletFeature);
      f.edges = [{ bodyId: b.id, mid: e.mid, tangent: e.tangent, curve: e.curve, length: e.length }];
      f.radius = r1;
      if (r2) f.radius2 = r2;
      const r = regen(doc);
      expect(status(r, f.id).state, status(r, f.id).message).toBe("ok");
      return r.bodies[0]!.volume;
    };
    const small = volumeWith("2");
    const big = volumeWith("4");
    const varied = volumeWith("2", "4");
    expect(varied).toBeLessThan(small);
    expect(varied).toBeGreaterThan(big);
  });
});

describe("silhouette split, branching pipes and derived designs", () => {
  it("splits a sphere at its widest outline", () => {
    const doc = newDocument();
    const s = prim(doc, "sphere", { radius: "10" });
    const sp = push(doc, makeSplit(doc, s.id) as SplitFeature);
    sp.plane = "XY";
    sp.silhouette = true;
    sp.keep = "both";
    const r = regen(doc);
    expect(status(r, sp.id).state, status(r, sp.id).message).toBe("ok");
    expect(r.bodies).toHaveLength(2);
    // Each half is about half the sphere (an off-center cut would be lopsided).
    const [a, b] = r.bodies.map((x) => x.volume);
    expect(Math.abs(a! - b!) / (a! + b!)).toBeLessThan(0.08);
  });

  it("a pipe follows every open line of its sketch", async () => {
    const { makePipe } = await import("@whittle/core");
    const doc = newDocument();
    const s = sketch(doc, [
      { id: uid("e"), type: "polyline", open: true, points: [["0", "0"], ["30", "0"]] },
      { id: uid("e"), type: "polyline", open: true, points: [["0", "0"], ["0", "30"]] },
    ]);
    const p = push(doc, makePipe(doc, s.id) as import("@whittle/core").SweepFeature, true);
    p.pipe = { shape: "circle", size: "4", wall: "0" };
    const r = regen(doc);
    expect(status(r, p.id).state, status(r, p.id).message).toBe("ok");
    // Two 30 mm rods of 4 mm diameter (they share an end, so nearly nothing overlaps).
    expect(r.bodies[0]!.volume).toBeGreaterThan(2 * Math.PI * 4 * 30 * 0.9);
  });

  it("brings in another design's bodies", async () => {
    const { serializeDocument, makeImport } = await import("@whittle/core");
    const sub = newDocument();
    prim(sub, "box", { width: "10", depth: "10", height: "10" });
    const bytes = serializeDocument(sub);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    const doc = newDocument();
    const imp = push(doc, makeImport(doc, "part.whittle", "whittle", btoa(bin)), true);
    const builder = new Builder();
    await builder.prepareImports(doc);
    const r = builder.regen(doc, "final");
    expect(status(r, imp.id).state, status(r, imp.id).message).toBe("ok");
    expect(r.bodies[0]!.volume).toBeCloseTo(1000, 0);
  });
});

describe("a fillet that lost one of its edges", () => {
  it("rounds the edges it still finds and turns yellow instead of failing", async () => {
    const { makeFillet } = await import("@whittle/core");
    const doc = newDocument();
    const b = prim(doc, "box", { width: "20", depth: "20", height: "20" });
    const body = regen(doc).bodies[0]!;
    const e = body.edges.find((x) => Math.abs(x.tangent[2]) > 0.99)!;
    const f = push(doc, makeFillet(doc) as import("@whittle/core").FilletFeature);
    f.radius = "3";
    f.edges = [
      { bodyId: b.id, mid: e.mid, tangent: e.tangent, curve: e.curve, length: e.length },
      { bodyId: b.id, mid: [500, 500, 500], tangent: [0.577, 0.577, 0.577], curve: "CIRCLE", length: 5 },
    ];
    const r = regen(doc);
    expect(status(r, f.id).state).toBe("warning");
    expect(status(r, f.id).message).toMatch(/1 of the 2/);
    expect(vol(r)).toBeLessThan(8000);
    f.edges = [f.edges[1]!];
    expect(status(regen(doc), f.id).state).toBe("error");
  });
});

describe("delete a fillet or chamfer", () => {
  it("restores a sharp convex edge and an inside corner", async () => {
    const { makeFillet, makeChamfer } = await import("@whittle/core");
    const sharp = (kind: "fillet" | "chamfer") => {
      const doc = newDocument();
      const b = prim(doc, "box", { width: "20", depth: "20", height: "20" });
      const body = regen(doc).bodies[0]!;
      const e = body.edges.find((x) => Math.abs(x.tangent[2]) > 0.99)!;
      const f = push(doc, (kind === "fillet" ? makeFillet(doc) : makeChamfer(doc)) as import("@whittle/core").FilletFeature);
      f.edges = [{ bodyId: b.id, mid: e.mid, tangent: e.tangent, curve: e.curve, length: e.length }];
      if (kind === "fillet") f.radius = "3";
      else (f as unknown as { distance: string }).distance = "3";
      const r1 = regen(doc);
      expect(vol(r1)).toBeLessThan(8000);
      const rounded = r1.bodies[0]!.faces.find((x) => x.surface === (kind === "fillet" ? "CYLINDRE" : "PLANE") && Math.abs(x.normal[2]) < 0.1 && Math.abs(x.normal[0]) > 0.3 && Math.abs(x.normal[1]) > 0.3)!;
      const df = push(doc, makeDeleteFace(doc) as DeleteFaceFeature);
      df.faces = [{ bodyId: b.id, ...rounded }];
      const r2 = regen(doc);
      expect(status(r2, df.id).state, status(r2, df.id).message).toBe("ok");
      return vol(r2);
    };
    expect(sharp("fillet")).toBeCloseTo(8000, 0);
    expect(sharp("chamfer")).toBeCloseTo(8000, 0);
  });
});

describe("delete a concave fillet", () => {
  it("restores the sharp inside corner of an L-shaped body", async () => {
    const { makeFillet, makeCombine } = await import("@whittle/core");
    const doc = newDocument();
    const a = prim(doc, "box", { width: "20", depth: "20", height: "20" });
    const b = prim(doc, "box", { width: "20", depth: "20", height: "10", position: ["20", "0", "0"] });
    const c = push(doc, makeCombine(doc, a.id, [b.id]) as import("@whittle/core").CombineFeature);
    c.op = "join";
    c.keepTools = false;
    const base = vol(regen(doc));
    const body = regen(doc).bodies[0]!;
    const e = body.edges.find((x) => Math.abs(x.tangent[1]) > 0.99 && Math.abs(x.mid[0] - 10) < 1e-6 && Math.abs(x.mid[2] - 10) < 1e-6)!;
    const f = push(doc, makeFillet(doc) as import("@whittle/core").FilletFeature);
    f.edges = [{ bodyId: a.id, mid: e.mid, tangent: e.tangent, curve: e.curve, length: e.length }];
    f.radius = "3";
    const r1 = regen(doc);
    expect(status(r1, f.id).state, status(r1, f.id).message).toBe("ok");
    expect(vol(r1)).toBeGreaterThan(base);
    const round = r1.bodies[0]!.faces.find((x) => x.surface === "CYLINDRE")!;
    const df = push(doc, makeDeleteFace(doc) as DeleteFaceFeature);
    df.faces = [{ bodyId: a.id, ...round }];
    const r2 = regen(doc);
    expect(status(r2, df.id).state, status(r2, df.id).message).toBe("ok");
    expect(vol(r2)).toBeCloseTo(base, 0);
  });
});
