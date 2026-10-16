import type { Vec2 } from "@whittle/core";

/** Ramer–Douglas–Peucker: drop points that stay within `tol` of the simplified line. */
export function simplify(pts: Vec2[], tol: number): Vec2[] {
  if (pts.length < 4) return pts;
  const [fx, fy] = pts[0]!;
  const [lx, ly] = pts[pts.length - 1]!;
  if (Math.hypot(fx - lx, fy - ly) <= tol) {
    // A closed loop: the chord is a point, so split at the farthest point and simplify both halves.
    let far = 1;
    pts.forEach(([x, y], i) => {
      if (Math.hypot(x - fx, y - fy) > Math.hypot(pts[far]![0] - fx, pts[far]![1] - fy)) far = i;
    });
    if (far > 0 && far < pts.length - 1) return [...simplify(pts.slice(0, far + 1), tol).slice(0, -1), ...simplify(pts.slice(far), tol)];
  }
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a]!;
    const [bx, by] = pts[b]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]!;
      const d = Math.abs((px - ax) * dy - (py - ay) * dx) / len;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tol && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
