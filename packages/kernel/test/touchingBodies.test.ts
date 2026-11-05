/**
 * Joining bodies that only touch: a body and its mirror image meeting face to face (or at a point, or round a circle),
 * exactly or a few microns apart or overlapping, as rounding in a solved sketch leaves them (issues #29, #32, #33).
 * Every case must give one body with both halves' volume, no hair-thin sliver faces, and a mesh without cracks or
 * normals pointing the wrong way.
 */
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { type BodyResult } from "../src/protocol";
import { type CombineFeature, type Feature, type MirrorFeature, type PatternFeature, type PrimitiveFeature, type WhittleDocument, makeCombine, makeMirror, makePattern, makePrimitive, newDocument } from "@whittle/core";
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

/** Triangle sides no other triangle shares (cracks), and vertex normals facing against their triangle (dark patches). */
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
      if (kp === kq) continue;
      const k = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
      sides.set(k, (sides.get(k) ?? 0) + 1);
    }
  }
  return { cracks: [...sides.values()].filter((k) => k === 1).length, reversed };
}

/** How far the body's side sits from the YZ plane when moved there: half its width (the torus: ring plus tube). */
const HALF_WIDTH = { box: 20, cylinder: 15, sphere: 15, cone: 15, torus: 25, tube: 15 } as const;
type Shape = keyof typeof HALF_WIDTH;

function check(doc: WhittleDocument, copies: number) {
  const single = new Builder().regen({ ...doc, features: doc.features.slice(0, 1) }, "final").bodies[0]!.volume;
  const r = new Builder().regen(doc, "final");
  expect(r.status.filter((s) => s.state !== "ok")).toEqual([]);
  expect(r.bodies).toHaveLength(1);
  const [b] = r.bodies;
  expect(Math.abs(b!.volume - copies * single) / (copies * single)).toBeLessThan(1e-4);
  expect(b!.faces.filter((f) => f.area < 1e-3)).toEqual([]);
  expect(meshFlaws(b!)).toEqual({ cracks: 0, reversed: 0 });
}

describe("joining bodies that only touch", () => {
  // Exactly touching, a few microns apart, and overlapping by a few microns.
  const GAPS = [0, 3.6e-6, -3.6e-6];
  for (const shape of Object.keys(HALF_WIDTH) as Shape[]) {
    for (const plane of ["XY", "YZ"] as const) {
      it(`joins a ${shape} with its mirror image across ${plane}`, () => {
        for (const gap of GAPS) {
          for (const how of ["combine", "merge"] as const) {
            const doc = newDocument();
            const p = { ...(makePrimitive(doc, shape) as PrimitiveFeature) };
            // Primitives stand on z = 0, so XY already touches them; for YZ, slide the body until its side reaches x = 0.
            p.position = plane === "XY" ? ["0", "0", String(gap)] : [String(HALF_WIDTH[shape] + gap), "0", "0"];
            push(doc, p, true);
            const mi = push(doc, { ...(makeMirror(doc, p.id) as MirrorFeature), plane, merge: how === "merge" }, true);
            if (how === "combine") push(doc, makeCombine(doc, p.id, [mi.id]) as CombineFeature);
            check(doc, 2);
          }
        }
      });
    }
  }

  it("merges a row of copies that touch side by side", () => {
    for (const shape of ["box", "cylinder", "cone"] as const) {
      for (const gap of [0, 3.6e-6]) {
        const doc = newDocument();
        const p = push(doc, makePrimitive(doc, shape), true);
        const width = 2 * HALF_WIDTH[shape];
        push(doc, { ...(makePattern(doc, p.id) as PatternFeature), pattern: "linear", axis: "x", count: "3", spacing: String(width + gap), merge: true });
        check(doc, 3);
      }
    }
  });
});
