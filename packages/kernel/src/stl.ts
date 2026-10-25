/**
 * STL import: parse binary or ASCII STL and sew the triangles into a solid.
 * (The library's own reader crashes in this OpenCascade build.) Coplanar
 * triangles are merged afterwards, so STLs exported from CAD come back with
 * clean, pickable faces.
 */
import { type Shape3D, makePolygon, makeSolid } from "replicad";

/** Above this, sewing gets slow enough to freeze the engine for a long time. */
export const MAX_STL_TRIANGLES = 40000;

/** Triangles as flat xyz triples (9 numbers per triangle). */
export function parseSTL(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength >= 84) {
    const n = view.getUint32(80, true);
    // Binary STLs have exactly this size (some exporters pad the end); ASCII ones start with "solid".
    const ascii = new TextDecoder().decode(bytes.subarray(0, 5)) === "solid" && 84 + n * 50 !== bytes.byteLength;
    if (!ascii && n > 0 && 84 + n * 50 <= bytes.byteLength) {
      const out = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) {
        const o = 84 + i * 50 + 12;
        for (let k = 0; k < 9; k++) out[i * 9 + k] = view.getFloat32(o + k * 4, true);
      }
      return out;
    }
  }
  const text = new TextDecoder().decode(bytes);
  const nums: number[] = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) nums.push(+m[1]!, +m[2]!, +m[3]!);
  if (nums.length % 9 !== 0 || nums.some((v) => !Number.isFinite(v))) throw new Error("This STL file looks damaged.");
  return Float32Array.from(nums);
}

/** Triangles of a Wavefront OBJ (polygons are split into fans; normals, textures and groups are ignored). */
export function parseOBJ(bytes: Uint8Array): Float32Array {
  const v: number[][] = [];
  const out: number[] = [];
  for (const line of new TextDecoder().decode(bytes).split("\n")) {
    const t = line.replace(/#.*/, "").trim().split(/\s+/);
    if (t[0] === "v") v.push([+t[1]!, +t[2]!, +t[3]!]);
    else if (t[0] === "f") {
      // "7", "7/1" or "7/1/3"; negative indices count back from the last vertex.
      const ids = t.slice(1).map((s) => {
        const i = Number.parseInt(s, 10);
        return i < 0 ? v.length + i : i - 1;
      });
      for (let k = 1; k + 1 < ids.length; k++) for (const i of [ids[0]!, ids[k]!, ids[k + 1]!]) out.push(...(v[i] ?? [Number.NaN, 0, 0]));
    }
  }
  if (out.some((x) => !Number.isFinite(x))) throw new Error("This OBJ file looks damaged.");
  return Float32Array.from(out);
}

export function stlToShape(bytes: Uint8Array, tris = parseSTL(bytes)): Shape3D {
  const count = tris.length / 9;
  if (count === 0) throw new Error("This mesh file has no triangles.");
  if (count > MAX_STL_TRIANGLES) {
    throw new Error(`This mesh has ${count.toLocaleString()} triangles; Whittle imports up to ${MAX_STL_TRIANGLES.toLocaleString()}. Simplify it in your mesh tool first.`);
  }
  const faces = [];
  for (let i = 0; i < count; i++) {
    const p = (k: number): [number, number, number] => [tris[i * 9 + k * 3]!, tris[i * 9 + k * 3 + 1]!, tris[i * 9 + k * 3 + 2]!];
    const a = p(0);
    const b = p(1);
    const c = p(2);
    // Skip degenerate slivers: they can't form a face.
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = Math.hypot(ab[1]! * ac[2]! - ab[2]! * ac[1]!, ab[2]! * ac[0]! - ab[0]! * ac[2]!, ab[0]! * ac[1]! - ab[1]! * ac[0]!);
    if (cr < 1e-12) continue;
    faces.push(makePolygon([a, b, c]));
  }
  const solid = makeSolid(faces) as Shape3D;
  try {
    return solid.simplify();
  } catch {
    return solid;
  }
}
