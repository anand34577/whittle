/** Which enclosed area of a sketch holds a point (the kernel sends each area's triangles). */
import type { Vec2 } from "@whittle/core";
import type { SketchFrame } from "@whittle/kernel";

const local = new WeakMap<Float32Array, Float32Array>();

/** A region's triangles in sketch coordinates (xy per vertex). */
function localTriangles(frame: SketchFrame, fill: Float32Array): Float32Array {
  let out = local.get(fill);
  if (out) return out;
  out = new Float32Array((fill.length / 3) * 2);
  const { origin: o, xDir: x, yDir: y } = frame;
  for (let v = 0; v < fill.length / 3; v++) {
    const dx = fill[v * 3]! - o[0];
    const dy = fill[v * 3 + 1]! - o[1];
    const dz = fill[v * 3 + 2]! - o[2];
    out[v * 2] = dx * x[0] + dy * x[1] + dz * x[2];
    out[v * 2 + 1] = dx * y[0] + dy * y[1] + dz * y[2];
  }
  local.set(fill, out);
  return out;
}

function inTriangles(t: Float32Array, [x, y]: Vec2): boolean {
  for (let i = 0; i + 5 < t.length; i += 6) {
    const d1 = (x - t[i + 2]!) * (t[i + 1]! - t[i + 3]!) - (t[i]! - t[i + 2]!) * (y - t[i + 3]!);
    const d2 = (x - t[i + 4]!) * (t[i + 3]! - t[i + 5]!) - (t[i + 2]! - t[i + 4]!) * (y - t[i + 5]!);
    const d3 = (x - t[i]!) * (t[i + 5]! - t[i + 1]!) - (t[i + 4]! - t[i]!) * (y - t[i + 1]!);
    if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return true;
  }
  return false;
}

/** Index of the region containing `p` (sketch coordinates), or -1. */
export function regionAt(frame: SketchFrame, p: Vec2): number {
  return frame.regions?.findIndex((r) => inTriangles(localTriangles(frame, r.fill), p)) ?? -1;
}
