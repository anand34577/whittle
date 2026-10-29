/** Geometry tests for the second wave of features (real OpenCascade in Node). */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { loadFont, setOC } from "replicad";
import {
  type CombineFeature,
  type EdgeRef,
  type Feature,
  type HoleFeature,
  type LoftFeature,
  type MoveFeature,
  type PrimitiveFeature,
  type SketchEntity,
  type SketchFeature,
  type WhittleDocument,
  makeCombine,
  makeExtrude,
  makeHole,
  makeLoft,
  makeMove,
  makePrimitive,
  makeSketch,
  newDocument,
  uid,
} from "@whittle/core";
import { Builder } from "../src/build";
import { minDistance } from "../src/inspect";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const wasm = require.resolve("replicad-opencascadejs/wasm");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => wasm }));
  const font = require.resolve("@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff");
  const buf = readFileSync(font);
  await loadFont(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, "sans");
});

function push(doc: WhittleDocument, f: Feature, body = false) {
  doc.features.push(f);
  if (body) doc.bodies[f.id] = { name: f.name, color: "#ccc", visible: true };
  return f;
}

function sketchWith(doc: WhittleDocument, entities: SketchEntity[], offset = "0"): SketchFeature {
  const s = makeSketch(doc, { kind: "origin", plane: "XY", offset }) as SketchFeature;
  s.entities.push(...entities);
  return push(doc, s) as SketchFeature;
}

const ok = (r: ReturnType<Builder["regen"]>) => {
  const bad = r.status.filter((s) => s.state !== "ok");
  expect(bad, JSON.stringify(bad)).toHaveLength(0);
};

describe("new primitives", () => {
  it("builds cone, torus and tube with the right volumes", () => {
    const doc = newDocument();
    const cone = makePrimitive(doc, "cone") as PrimitiveFeature;
    cone.radius = "10";
    cone.radius2 = "0";
    cone.height = "30";
    push(doc, cone, true);
    const torus = makePrimitive(doc, "torus") as PrimitiveFeature;
    torus.position = ["100", "0", "0"];
    push(doc, torus, true);
    const tube = makePrimitive(doc, "tube") as PrimitiveFeature;
    tube.position = ["-100", "0", "0"];
    push(doc, tube, true);
    const r = new Builder().regen(doc, "final");
    ok(r);
    const [c, t, u] = r.bodies;
    expect(c!.volume).toBeCloseTo((Math.PI * 100 * 30) / 3, 0);
    expect(t!.volume).toBeCloseTo(2 * Math.PI * Math.PI * 20 * 25, 0);
    expect(u!.volume).toBeCloseTo(Math.PI * (15 * 15 - 11 * 11) * 20, 0);
  });
});

describe("sketch entities", () => {
  it("extrudes an ellipse, a gear with a bore, a rounded outline, text and a rotated rectangle", () => {
    const doc = newDocument();
    const s = sketchWith(doc, [
      { id: uid(), type: "ellipse", cx: "0", cy: "0", rx: "20", ry: "10", angle: "30" },
      { id: uid(), type: "gear", cx: "100", cy: "0", teeth: "20", module: "2", bore: "5" },
      { id: uid(), type: "polyline", points: [["-100", "0"], ["-60", "0"], ["-80", "30"]], corner: "3" },
      { id: uid(), type: "text", x: "0", y: "60", text: "Hi", size: "20", angle: "0" },
      { id: uid(), type: "rect", x: "0", y: "-60", w: "20", h: "10", anchor: "center", angle: "45" },
    ]);
    push(doc, makeExtrude(doc, s.id), true);
    const r = new Builder().regen(doc, "final");
    ok(r);
    const v = r.bodies[0]!.volume;
    const ellipse = Math.PI * 20 * 10 * 10;
    const gearApprox = Math.PI * 20 * 20 * 10 - Math.PI * 2.5 * 2.5 * 10;
    const rect = 20 * 10 * 10;
    expect(v).toBeGreaterThan(ellipse + gearApprox * 0.9 + rect);
    expect(r.sketches[0]!.fill?.length).toBeGreaterThan(0);
  });
});

describe("hole, loft, move, combine", () => {
  it("drills counterbored through holes in a plate", () => {
    const doc = newDocument();
    const box = makePrimitive(doc, "box") as PrimitiveFeature;
    box.width = "60";
    box.depth = "40";
    box.height = "10";
    push(doc, box, true);
    const b = new Builder();
    const top = b.regen(doc, "final").bodies[0]!.faces.find((f) => f.normal[2] > 0.99)!;
    const hole = makeHole(doc) as HoleFeature;
    hole.face = { bodyId: box.id, ...top };
    hole.points = [["-15", "0"], ["15", "0"]];
    hole.style = "counterbore";
    hole.diameter = "5";
    hole.headDiameter = "9";
    hole.headDepth = "3";
    push(doc, hole);
    const r = b.regen(doc, "final");
    ok(r);
    const removed = 2 * (Math.PI * 2.5 * 2.5 * 7 + Math.PI * 4.5 * 4.5 * 3);
    expect(r.bodies[0]!.volume).toBeCloseTo(60 * 40 * 10 - removed, 0);
  });

  it("drills countersunk blind holes", () => {
    const doc = newDocument();
    const box = makePrimitive(doc, "box") as PrimitiveFeature;
    push(doc, box, true);
    const b = new Builder();
    const top = b.regen(doc, "final").bodies[0]!.faces.find((f) => f.normal[2] > 0.99)!;
    const hole = makeHole(doc) as HoleFeature;
    hole.face = { bodyId: box.id, ...top };
    hole.points = [["0", "0"]];
    hole.style = "countersink";
    hole.through = false;
    hole.depth = "8";
    push(doc, hole);
    const r = b.regen(doc, "final");
    ok(r);
    expect(r.bodies[0]!.volume).toBeLessThan(40 * 30 * 20 - Math.PI * 2.5 * 2.5 * 8 * 0.9);
  });

  it("ends a blind hole in a drill point and honours the countersink angle", () => {
    const blind = (set: (h: HoleFeature) => void) => {
      const doc = newDocument();
      const box = push(doc, makePrimitive(doc, "box"), true) as PrimitiveFeature;
      const top = new Builder().regen(doc, "final").bodies[0]!.faces.find((f) => f.normal[2] > 0.99)!;
      const hole = makeHole(doc) as HoleFeature;
      Object.assign(hole, { face: { bodyId: box.id, ...top }, points: [["0", "0"]], through: false, depth: "8", diameter: "6" });
      set(hole);
      push(doc, hole);
      const r = new Builder().regen(doc, "final");
      ok(r);
      return 40 * 30 * 20 - r.bodies[0]!.volume;
    };
    const cyl = Math.PI * 9 * 8;
    expect(blind((h) => (h.tipAngle = undefined))).toBeCloseTo(cyl, 1);
    // 90° point: a cone 3 deep under the cylinder.
    expect(blind((h) => (h.tipAngle = "90"))).toBeCloseTo(cyl + (Math.PI * 9 * 3) / 3, 1);
    // A 60° countersink to Ø12 is deeper than the 90° one: (6 - 3) / tan 30°.
    const sink = (a?: string) => blind((h) => ((h.tipAngle = undefined), (h.style = "countersink"), (h.headDiameter = "12"), (h.sinkAngle = a)));
    expect(sink("60")).toBeGreaterThan(sink() + 10);
  });

  it("lofts a square into a circle", () => {
    const doc = newDocument();
    const a = sketchWith(doc, [{ id: uid(), type: "rect", x: "0", y: "0", w: "20", h: "20", anchor: "center" }]);
    const c = sketchWith(doc, [{ id: uid(), type: "circle", cx: "0", cy: "0", r: "5" }], "30");
    push(doc, makeLoft(doc, [a.id, c.id]) as LoftFeature, true);
    const r = new Builder().regen(doc, "final");
    ok(r);
    expect(r.bodies[0]!.bbox[1][2]).toBeCloseTo(30, 3);
    expect(r.bodies[0]!.volume).toBeGreaterThan(Math.PI * 25 * 30);
    expect(r.bodies[0]!.volume).toBeLessThan(400 * 30);
  });

  it("moves a copy and combines bodies", () => {
    const doc = newDocument();
    const box = makePrimitive(doc, "box") as PrimitiveFeature;
    push(doc, box, true);
    const mv = makeMove(doc, box.id) as MoveFeature;
    mv.translate = ["20", "0", "0"];
    mv.copy = true;
    push(doc, mv, true);
    const cb = makeCombine(doc, box.id, [mv.id]) as CombineFeature;
    push(doc, cb);
    const r = new Builder().regen(doc, "final");
    ok(r);
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0]!.volume).toBeCloseTo(60 * 30 * 20, 1);
  });
});

describe("text", () => {
  it("places text where its anchor says", () => {
    const doc = newDocument();
    const s = sketchWith(doc, [{ id: uid(), type: "text", x: "50", y: "10", text: "HELLO", size: "10", angle: "0" }]);
    push(doc, makeExtrude(doc, s.id), true);
    const r = new Builder().regen(doc, "final");
    ok(r);
    const [min, max] = r.bodies[0]!.bbox;
    expect(min[0]).toBeGreaterThan(50);
    expect(min[0]).toBeLessThan(52);
    expect(max[0]).toBeGreaterThan(75);
    expect(min[1]).toBeGreaterThan(9.5);
  });
});

describe("hole placement", () => {
  it("measures positions from the projected world origin and warns about misses", () => {
    const doc = newDocument();
    const box = makePrimitive(doc, "box") as PrimitiveFeature;
    box.position = ["30", "0", "0"]; // top face center is (30, 0, 20)
    push(doc, box, true);
    const b = new Builder();
    const top = b.regen(doc, "final").bodies[0]!.faces.find((f) => f.normal[2] > 0.99)!;
    const hole = makeHole(doc) as HoleFeature;
    hole.face = { bodyId: box.id, ...top };
    hole.points = [["30", "0"], ["200", "0"]];
    push(doc, hole);
    const r = b.regen(doc, "final");
    const st = r.status.find((s) => s.id === hole.id)!;
    expect(st.state).toBe("warning");
    expect(st.message).toMatch(/Hole 2 is off the body/);
    expect(r.bodies[0]!.volume).toBeCloseTo(40 * 30 * 20 - Math.PI * 2.5 * 2.5 * 20, 0);
  });
});

describe("measure distance", () => {
  it("gives the shortest distance between faces, not between the clicked spots", () => {
    const doc = newDocument();
    const box = push(doc, makePrimitive(doc, "box"), true) as PrimitiveFeature; // 40 x 30 x 20
    const b = new Builder();
    const body = b.regen(doc, "final").bodies[0]!;
    const shapes = b.shapes(doc);
    const top = body.faces.findIndex((f) => f.normal[2] > 0.99);
    const bottom = body.faces.findIndex((f) => f.normal[2] < -0.99);
    const front = body.faces.findIndex((f) => f.normal[1] < -0.99);
    const at = (i: number, j: number) => minDistance(shapes, [{ bodyId: box.id, kind: "face", index: i }, { bodyId: box.id, kind: "face", index: j }])!.d;
    expect(at(top, bottom)).toBeCloseTo(20, 6);
    expect(at(top, front)).toBeCloseTo(0, 6); // they share an edge
  });
});

describe("pattern direction picked on the model", () => {
  it("repeats along a picked edge and around a picked round face", () => {
    const doc = newDocument();
    const box = push(doc, makePrimitive(doc, "box"), true) as PrimitiveFeature; // 40 x 30 x 20 at the origin
    const cyl = makePrimitive(doc, "cylinder") as PrimitiveFeature;
    cyl.position = ["100", "0", "0"];
    push(doc, cyl, true);
    const built = new Builder().regen(doc, "final").bodies;
    const b = built.find((x) => x.id === box.id)!;
    const yEdge = b.edges.find((e) => Math.abs(Math.abs(e.tangent[1]) - 1) < 1e-6)!;
    const side = built.find((x) => x.id === cyl.id)!.faces.find((x) => x.surface === "CYLINDRE")!;
    const pattern = (axisGeom: object, kind: "linear" | "circular") => {
      const d = structuredClone(doc);
      const p = { id: uid(), type: "pattern", name: "P", bodyId: box.id, pattern: kind, axis: "x", axisGeom, count: "3", spacing: "50", angle: "360", merge: false } as unknown as Feature;
      d.features.push(p);
      const r = new Builder().regen(d, "final");
      ok(r);
      return r.bodies.find((x) => x.id === p.id)!.bbox;
    };
    const lin = pattern({ edge: { bodyId: box.id, ...yEdge } }, "linear");
    expect(lin[1][1] - lin[0][1]).toBeCloseTo(80, 3); // two copies 50 apart along Y, not the default X
    expect(lin[1][0] - lin[0][0]).toBeCloseTo(40, 3);
    const circ = pattern({ face: { bodyId: cyl.id, ...side } }, "circular");
    expect(circ[1][0]).toBeGreaterThan(150); // swung round the cylinder at x = 100
  });
});

describe("shell after a fillet", () => {
  // A 40 x 30 x 20 box with its top edges rounded, then opened at the top.
  const shelled = (allTop: boolean, wall: string) => {
    const doc = newDocument();
    const box = push(doc, makePrimitive(doc, "box"), true) as PrimitiveFeature;
    const b = new Builder().regen(doc, "final").bodies[0]!;
    const edges = b.edges.filter((x) => Math.abs(x.mid[2] - 20) < 1e-6 && (allTop || Math.abs(x.mid[1] + 15) < 1e-6));
    push(doc, { id: uid(), type: "fillet", name: "F", edges: edges.map((e) => ({ bodyId: box.id, ...e })), radius: "2" } as Feature);
    const filleted = new Builder().regen(doc, "final").bodies[0]!;
    const top = filleted.faces.find((f) => f.surface === "PLANE" && f.normal[2] > 0.99)!;
    push(doc, { id: uid(), type: "shell", name: "S", bodyId: box.id, faces: [{ bodyId: box.id, ...top }], thickness: wall } as Feature);
    const r = new Builder().regen(doc, "final");
    ok(r);
    return { before: filleted.volume, after: r.bodies[0]!.volume };
  };
  it("hollows a filleted box (it used to come back unchanged)", () => {
    for (const [all, wall] of [[false, "2"], [false, "3"], [true, "1.5"]] as const) {
      const { before, after } = shelled(all, wall);
      expect(after, `${all} ${wall}`).toBeLessThan(before * 0.6);
      expect(after).toBeGreaterThan(before * 0.15);
    }
  });
});

describe("closed shell", () => {
  it("hollows a body with walls all round when no face is opened", () => {
    const doc = newDocument();
    const box = push(doc, makePrimitive(doc, "box"), true) as PrimitiveFeature;
    push(doc, { id: uid(), type: "shell", name: "S", bodyId: box.id, faces: [], thickness: "2" } as Feature);
    const r = new Builder().regen(doc, "final");
    ok(r);
    // 40 x 30 x 20 outside, 36 x 26 x 16 hollow inside.
    expect(r.bodies[0]!.volume).toBeCloseTo(40 * 30 * 20 - 36 * 26 * 16, 0);
  });
});

describe("shell with a face of another body (audit W-6)", () => {
  it("fails with a message instead of opening a look-alike face of the shelled body", () => {
    const doc = newDocument();
    const a = push(doc, makePrimitive(doc, "box"), true) as PrimitiveFeature;
    const b = push(doc, makePrimitive(doc, "box"), true) as PrimitiveFeature;
    b.position = ["100", "0", "0"];
    const built = new Builder().regen(doc, "final");
    const topOf = (id: string) => built.bodies.find((x) => x.id === id)!.faces.find((f) => f.surface === "PLANE" && f.normal[2] > 0.99)!;
    push(doc, { id: uid(), type: "shell", name: "S", bodyId: a.id, faces: [{ bodyId: a.id, ...topOf(a.id) }, { bodyId: b.id, ...topOf(b.id) }], thickness: "2" } as Feature);
    const r = new Builder().regen(doc, "final");
    const st = r.status.at(-1)!;
    expect(st.state).not.toBe("ok");
    expect(JSON.stringify(st)).toMatch(/must belong to the body being shelled/);
  });
});

describe("chamfer types", () => {
  // A 40 x 30 x 20 box; the top front edge (40 long) is cut, so the removed volume is a triangle x 40.
  const cut = (set: (c: Extract<Feature, { type: "chamfer" }>) => void) => {
    const doc = newDocument();
    const box = push(doc, makePrimitive(doc, "box"), true) as PrimitiveFeature;
    const b = new Builder().regen(doc, "final").bodies[0]!;
    const i = b.edges.findIndex((e) => Math.abs(e.mid[1] + 15) < 1e-6 && Math.abs(e.mid[2] - 20) < 1e-6);
    const c = { id: uid(), type: "chamfer", name: "C", edges: [{ bodyId: box.id, ...b.edges[i]! }], distance: "2" } as Extract<Feature, { type: "chamfer" }>;
    set(c);
    push(doc, c);
    const r = new Builder().regen(doc, "final");
    ok(r);
    return 40 * 30 * 20 - r.bodies[0]!.volume;
  };
  it("cuts equal, two-distance and distance-angle chamfers", () => {
    expect(cut(() => {})).toBeCloseTo(0.5 * 2 * 2 * 40, 1);
    expect(cut((c) => ((c.mode = "two"), (c.distance2 = "6")))).toBeCloseTo(0.5 * 2 * 6 * 40, 1);
    expect(cut((c) => ((c.mode = "two"), (c.distance2 = "6"), (c.flip = true)))).toBeCloseTo(0.5 * 2 * 6 * 40, 1);
    expect(cut((c) => ((c.mode = "angle"), (c.distance = "4"), (c.angle = "45")))).toBeCloseTo(0.5 * 4 * 4 * 40, 1);
  });
});

describe("bounding solid", () => {
  it("encloses a cylinder with a tight box and cylinder, plus padding", () => {
    const doc = newDocument();
    const cyl = push(doc, makePrimitive(doc, "cylinder"), true) as PrimitiveFeature;
    cyl.radius = "10";
    cyl.height = "30";
    const box = push(doc, { id: uid("bs"), type: "boundingSolid", name: "B", bodies: [cyl.id], shape: "box", padding: "1", axis: "z" } as Feature);
    const tube = push(doc, { id: uid("bs"), type: "boundingSolid", name: "C", bodies: [cyl.id], shape: "cylinder", padding: "0", axis: "z" } as Feature);
    const r = new Builder().regen(doc, "final");
    ok(r);
    const vol = (id: string) => r.bodies.find((b) => b.id === id)!.volume;
    expect(vol(box.id) / (22 * 22 * 32)).toBeCloseTo(1, 2);
    expect(vol(tube.id) / (Math.PI * 100 * 30)).toBeCloseTo(1, 2);
  });
});

describe("XZ plane offsets agree between tools (audit K-7)", () => {
  const meanY = (b: { edges: { mid: number[] }[] }) => b.edges.reduce((t, e) => t + e.mid[1]!, 0) / b.edges.length;
  it("mirrors across y = -d, like an XZ sketch plane offset by d", () => {
    const doc = newDocument();
    const box = push(doc, makePrimitive(doc, "box"), true) as PrimitiveFeature;
    const m = push(doc, { id: uid(), type: "mirror", name: "M", bodyId: box.id, plane: "XZ", offset: "50", merge: false } as Feature, true);
    const r = new Builder().regen(doc, "final");
    ok(r);
    expect(meanY(r.bodies.find((b) => b.id === m.id)!)).toBeCloseTo(-100, 3);
  });
  it("keeps the same shape for files saved before the change", async () => {
    const { migrate } = await import("@whittle/core");
    const d = migrate({ schema: 3, features: [{ id: "m", type: "mirror", plane: "XZ", offset: "50" }, { id: "t", type: "surface", op: "trim", plane: "XZ", offset: "2 mm", keep: "above" }, { id: "n", type: "mirror", plane: "XY", offset: "5" }] });
    const [m, t, n] = d.features as unknown as Record<string, unknown>[];
    expect(m!.offset).toBe("-(50)");
    expect([t!.offset, t!.keep]).toEqual(["-(2 mm)", "below"]);
    expect(n!.offset).toBe("5");
  });
});

describe("pattern along a path (audit K-6)", () => {
  it("spaces copies evenly by length on a path of unequal edges", () => {
    const doc = newDocument();
    const box = push(doc, makePrimitive(doc, "box"), true) as PrimitiveFeature;
    // 100 mm then 20 mm: three copies sit at 0, 60 and 120 mm along it.
    const path = sketchWith(doc, [{ id: uid("e"), type: "polyline", open: true, points: [["0", "0"], ["100", "0"], ["100", "20"]] } as SketchEntity]);
    push(doc, { id: uid(), type: "pattern", name: "P", bodyId: box.id, pattern: "path", path: path.id, axis: "x", count: "3", spacing: "0", angle: "0", merge: false } as Feature);
    const r = new Builder().regen(doc, "final");
    ok(r);
    const mids = r.bodies.flatMap((b) => b.edges.map((e) => e.mid));
    const cx = (lo: number, hi: number) => mids.filter((m) => m[0]! > lo && m[0]! < hi);
    // The box is 40 wide around x = 0, so the middle copy spans x = 40..80 (it was at the corner, 80..120, before).
    expect(cx(39, 81).length).toBeGreaterThan(0);
    expect(cx(85, 115).filter((m) => m[1]! < -10).length).toBe(0);
  });
});

describe("re-resolving a lost edge (audit K-1)", () => {
  it("flags the nearest look-alike as uncertain when it is far from the old edge", async () => {
    const { makeBox } = await import("replicad");
    const { edgeInfo, resolveEdge } = await import("../src/refs");
    const box = makeBox([0, 0, 0], [40, 30, 20]);
    const e = edgeInfo(box.edges[0]!);
    // The same edge, just nudged: certain.
    expect(resolveEdge(box, { bodyId: "b", ...e, mid: [e.mid[0] + 1e-6, e.mid[1], e.mid[2]] } as EdgeRef)!.uncertain).toBe(false);
    // A 2 mm edge 8 mm below the box: the nearest box edge is clearly closest (the next is 28 mm away),
    // but it is 20 times longer, so it is only a look-alike.
    const bottom = box.edges.map(edgeInfo).find((x) => Math.abs(x.tangent[0]) > 0.99 && Math.abs(x.mid[1]) < 1e-6 && Math.abs(x.mid[2]) < 1e-6)!;
    const far = resolveEdge(box, { bodyId: "b", ...bottom, mid: [bottom.mid[0], 0, -8], length: 2 } as EdgeRef)!;
    expect(far.uncertain).toBe(true);
  });
});

describe("engine aborts (audit K-2)", () => {
  it("are not reported as an ordinary feature error", async () => {
    const { describeError, isEngineAbort } = await import("../src/shared");
    const f = { id: "f", type: "fillet" } as Feature;
    expect(isEngineAbort(new WebAssembly.RuntimeError("memory access out of bounds"))).toBe(true);
    expect(isEngineAbort(new Error("abort(OOM). Build with -sASSERTIONS for more info."))).toBe(true);
    expect(isEngineAbort(new Error("BRep_API: command not done"))).toBe(false);
    expect(() => describeError(f, new Error("abort(OOM)"))).toThrow();
    expect(describeError(f, new Error("Pick an edge."))).toBe("Pick an edge.");
  });
});

describe("an island inside a hole (audit K-4)", () => {
  it("is kept: a plate with a ring cut into it, not a plain hole", () => {
    const doc = newDocument();
    const sk = sketchWith(doc, [
      { id: uid("e"), type: "rect", x: "0", y: "0", w: "100", h: "100", anchor: "center" } as SketchEntity,
      { id: uid("e"), type: "circle", cx: "0", cy: "0", r: "30" } as SketchEntity,
      { id: uid("e"), type: "circle", cx: "0", cy: "0", r: "10" } as SketchEntity,
    ]);
    const ex = push(doc, makeExtrude(doc, sk.id), true);
    (ex as { distance: string }).distance = "10";
    const r = new Builder().regen(doc, "final");
    ok(r);
    const area = 100 * 100 - Math.PI * 30 * 30 + Math.PI * 10 * 10;
    expect(r.bodies.reduce((t, b) => t + b.volume, 0)).toBeCloseTo(area * 10, 0);
  });
});

describe("smooth closed outlines (audit K-3)", () => {
  it("build the same curve the sketch draws", async () => {
    const { polygonArea, smoothClosed } = await import("@whittle/core");
    const pts: [number, number][] = [[0, 0], [40, 0], [50, 30], [10, 40]];
    const doc = newDocument();
    const sk = sketchWith(doc, [{ id: uid("e"), type: "polyline", smooth: true, points: pts.map(([x, y]) => [String(x), String(y)]) } as SketchEntity]);
    const ex = push(doc, makeExtrude(doc, sk.id), true);
    (ex as { distance: string }).distance = "1";
    const r = new Builder().regen(doc, "final");
    ok(r);
    const drawn = Math.abs(polygonArea(smoothClosed(pts, 200)));
    expect(Math.abs(r.bodies[0]!.volume - drawn) / drawn).toBeLessThan(1e-3);
  });
});
