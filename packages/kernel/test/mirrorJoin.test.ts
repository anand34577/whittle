/** Joining a body with its own mirror image, where the two halves meet face to face on the mirror plane (issues #29, #32, #33). */
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { type BodyResult } from "../src/protocol";
import { type CombineFeature, type Feature, type MirrorFeature, type MoveFeature, type PatternFeature, type RevolveFeature, type SketchFeature, type WhittleDocument, makeCombine, makeMirror, makeMove, makePattern, makePrimitive, makeRevolve, makeSketch, newDocument, uid } from "@whittle/core";
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

type P = [number, number];
const R = 30; // outer circle at the origin
const r = 14; // the two notches, centred at (20, ±20)
/** How far the upper notch sits off (20, 20): a sketch solved by hand lands a few microns out (issue #33). */
let skew = 0;
const notch = (sy: number): P => [20, 20 * sy + (sy > 0 ? skew : 0)];
const fmt = (p: P): [string, string] => [p[0].toFixed(6), p[1].toFixed(6)];
const at = (c: P, rad: number, t: number): P => [c[0] + rad * Math.cos(t), c[1] + rad * Math.sin(t)];
const angle = (c: P, p: P) => Math.atan2(p[1] - c[1], p[0] - c[0]);

/** Where the outer circle meets a notch, nearer the axis first. */
function meets(sy: number): [P, P] {
  const n = notch(sy);
  const d = Math.hypot(n[0], n[1]);
  const a = (d * d + R * R - r * r) / (2 * d);
  const h = Math.sqrt(R * R - a * a);
  const [ux, uy] = [n[0] / d, n[1] / d];
  const pts: P[] = [[ux * a - uy * h, uy * a + ux * h], [ux * a + uy * h, uy * a - ux * h]];
  return pts.sort((p, q) => p[0] - q[0]) as [P, P];
}

/** An arc's middle point: round the outer circle, or round a notch on the side facing the origin. */
const midOuter = (p: P, q: P): [string, string, "arc"] => [...fmt(at([0, 0], R, (angle([0, 0], p) + angle([0, 0], q)) / 2)), "arc"];
function midNotch(p: P, q: P, sy: number): [string, string, "arc"] {
  const c = notch(sy);
  const t = (angle(c, p) + angle(c, q)) / 2;
  const [m1, m2] = [at(c, r, t), at(c, r, t + Math.PI)];
  return [...fmt(Math.hypot(...m1) < Math.hypot(...m2) ? m1 : m2), "arc"];
}

/** Half of a notched ball (the sketch from issue #28 revolved 180°), joined to `doc`'s last body or a new one. */
function notchedHalf(doc: WhittleDocument, op: "new" | "join" = "new") {
  const [t1, t2] = meets(1);
  const [b1, b2] = meets(-1);
  const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
  sk.entities.push({
    id: uid("e"),
    type: "polyline",
    open: false,
    points: [fmt([0, -R]), fmt([0, R]), midOuter([0, R], t1), fmt(t1), midNotch(t1, t2, 1), fmt(t2), midOuter(t2, b2), fmt(b2), midNotch(b2, b1, -1), fmt(b1), midOuter(b1, [0, -R])],
  });
  push(doc, sk);
  return push(doc, { ...(makeRevolve(doc, sk.id, op) as RevolveFeature), angle: "180" }, op === "new");
}

/** The half and its mirror image across XY. */
function halves(merge: boolean) {
  const doc = newDocument();
  const rv = notchedHalf(doc);
  const mi = push(doc, { ...(makeMirror(doc, rv.id) as MirrorFeature), plane: "XY", merge }, true);
  return { doc, rv, mi };
}

const build = (doc: WhittleDocument) => {
  const r = new Builder().regen(doc, "final");
  expect(r.status.filter((s) => s.state !== "ok")).toHaveLength(0);
  return r;
};

describe("joining mirrored halves", () => {
  it("keeps every bit of both halves, with Combine or with Mirror's merge", () => {
    const { doc } = halves(false);
    const half = build(doc).bodies[0]!.volume;
    expect(half).toBeGreaterThan(20000);

    const joined = halves(false);
    push(joined.doc, makeCombine(joined.doc, joined.rv.id, [joined.mi.id]) as CombineFeature);
    const combined = build(joined.doc).bodies;
    expect(combined).toHaveLength(1);
    expect(combined[0]!.volume).toBeCloseTo(2 * half, 3);

    const merged = build(halves(true).doc).bodies;
    expect(merged).toHaveLength(1);
    expect(merged[0]!.volume).toBeCloseTo(2 * half, 3);
  });

  it("keeps every bit when mirroring or patterning the half as a feature", () => {
    const half = build(halves(false).doc).bodies[0]!.volume;
    // A small block inside the ball, so the revolve joins an existing body and is repeatable.
    const withBlock = () => {
      const doc = newDocument();
      push(doc, { ...makePrimitive(doc, "box"), width: "4", depth: "4", height: "4" } as Feature, true);
      return { doc, rv: notchedHalf(doc, "join") };
    };
    const m = withBlock();
    push(m.doc, { ...(makeMirror(m.doc) as MirrorFeature), features: [m.rv.id], plane: "XY", merge: true });
    expect(build(m.doc).bodies[0]!.volume).toBeCloseTo(2 * half, 3);

    const p = withBlock();
    push(p.doc, { ...(makePattern(p.doc) as PatternFeature), features: [p.rv.id], pattern: "circular", axis: "y", count: "2", angle: "360", merge: true });
    expect(build(p.doc).bodies[0]!.volume).toBeCloseTo(2 * half, 3);
  });

  it("joins halves that miss each other by microns without slivers, cracks or dark patches", () => {
    skew = 3.6e-6;
    try {
      for (const quality of ["preview", "final"] as const) {
        // The mirror image turned a quarter turn, so the notches line up again: as in the file attached to issue #33.
        const { doc, rv, mi } = halves(false);
        push(doc, { ...(makeMove(doc, mi.id) as MoveFeature), axis: "z", angle: "90" });
        const apart = new Builder().regen(doc, quality).bodies;
        for (const b of apart) expect(meshFlaws(b)).toEqual({ cracks: 0, reversed: 0 });

        push(doc, makeCombine(doc, rv.id, [mi.id]) as CombineFeature);
        const r = new Builder().regen(doc, quality);
        expect(r.status.filter((s) => s.state !== "ok")).toHaveLength(0);
        const [joined] = r.bodies;
        expect(r.bodies).toHaveLength(1);
        // No hair-thin leftovers of the two flat faces on the mirror plane.
        expect(joined!.faces.every((f) => f.area > 1e-3)).toBe(true);
        expect(joined!.volume).toBeCloseTo(2 * apart[0]!.volume, 2);
        expect(meshFlaws(joined!)).toEqual({ cracks: 0, reversed: 0 });
      }
    } finally {
      skew = 0;
    }
  });

  it("says the bodies don't overlap when Intersect would leave nothing", () => {
    const { doc, rv, mi } = halves(false);
    push(doc, { ...(makeCombine(doc, rv.id, [mi.id]) as CombineFeature), op: "intersect" });
    const r = new Builder().regen(doc, "final");
    const last = r.status.at(-1)!;
    expect(last.state).toBe("error");
    expect(last.message).toMatch(/don't overlap/);
  });
});

/**
 * Flaws a viewer would show: triangle sides that no other triangle shares (cracks; the poles of revolved faces, where a
 * fan of triangles meets at one point, are fine), and vertex normals pointing against their triangle (dark patches).
 */
function meshFlaws(b: BodyResult) {
  const { positions: v, normals: n, indices: t } = b;
  const key = (i: number) => `${Math.round(v[i * 3]! * 1e4)},${Math.round(v[i * 3 + 1]! * 1e4)},${Math.round(v[i * 3 + 2]! * 1e4)}`;
  const sides = new Map<string, number>();
  let reversed = 0;
  for (let i = 0; i < t.length; i += 3) {
    const [a, b2, c] = [t[i]!, t[i + 1]!, t[i + 2]!];
    const u = [0, 1, 2].map((k) => v[b2 * 3 + k]! - v[a * 3 + k]!);
    const w = [0, 1, 2].map((k) => v[c * 3 + k]! - v[a * 3 + k]!);
    const g = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
    const len = Math.hypot(g[0]!, g[1]!, g[2]!);
    for (const p of [a, b2, c]) if (n[p * 3]! * g[0]! + n[p * 3 + 1]! * g[1]! + n[p * 3 + 2]! * g[2]! < -1e-3 * len) reversed++;
    for (const [p, q] of [[a, b2], [b2, c], [c, a]] as const) {
      const [kp, kq] = [key(p), key(q)];
      if (kp !== kq) sides.set(kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`, (sides.get(kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`) ?? 0) + 1);
    }
  }
  return { cracks: [...sides.values()].filter((k) => k === 1).length, reversed };
}
