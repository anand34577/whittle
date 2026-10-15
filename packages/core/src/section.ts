/** Plane sections of triangle meshes (used by the sketch "Intersect" tool). */
import type { Vec2 } from "./model";

const key = (p: Vec2) => `${Math.round(p[0] * 1e3)},${Math.round(p[1] * 1e3)}`;

/** Triangle mesh ∩ plane as 2D segments in the plane's own coordinates. */
export function sliceMesh(b: { positions: ArrayLike<number>; indices: ArrayLike<number> }, origin: number[], xDir: number[], yDir: number[], normal: number[]): [Vec2, Vec2][] {
  const pos = b.positions;
  const idx = b.indices;
  const out: [Vec2, Vec2][] = [];
  const dist = (i: number) => (pos[i * 3]! - origin[0]!) * normal[0]! + (pos[i * 3 + 1]! - origin[1]!) * normal[1]! + (pos[i * 3 + 2]! - origin[2]!) * normal[2]!;
  const local = (x: number, y: number, z: number): Vec2 => {
    const d = [x - origin[0]!, y - origin[1]!, z - origin[2]!];
    return [d[0]! * xDir[0]! + d[1]! * xDir[1]! + d[2]! * xDir[2]!, d[0]! * yDir[0]! + d[1]! * yDir[1]! + d[2]! * yDir[2]!];
  };
  const eps = 1e-7;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const v = [idx[t]!, idx[t + 1]!, idx[t + 2]!];
    const d = v.map(dist);
    // Faces lying in the plane don't cut it; skip them.
    if (d.every((x) => Math.abs(x) < eps)) continue;
    const pts: Vec2[] = [];
    for (let e = 0; e < 3; e++) {
      const [i, j] = [e, (e + 1) % 3];
      const [di, dj] = [d[i]!, d[j]!];
      if ((di > eps && dj < -eps) || (di < -eps && dj > eps)) {
        const s = di / (di - dj);
        const a = v[i]! * 3;
        const c = v[j]! * 3;
        pts.push(local(pos[a]! + (pos[c]! - pos[a]!) * s, pos[a + 1]! + (pos[c + 1]! - pos[a + 1]!) * s, pos[a + 2]! + (pos[c + 2]! - pos[a + 2]!) * s));
      } else if (Math.abs(di) <= eps && Math.abs(dj) > eps) pts.push(local(pos[v[i]! * 3]!, pos[v[i]! * 3 + 1]!, pos[v[i]! * 3 + 2]!));
    }
    // A vertex on the plane can be counted by two edges; keep distinct points.
    const uniq = pts.filter((p, i) => pts.findIndex((q) => key(q) === key(p)) === i);
    if (uniq.length === 2) out.push([uniq[0]!, uniq[1]!]);
  }
  return out;
}

/** Join segments that share end points into polylines. */
export function chainSegments2D(segs: [Vec2, Vec2][]): { pts: Vec2[]; closed: boolean }[] {
  const at = new Map<string, number[]>();
  segs.forEach((s, i) => {
    for (const p of s) at.set(key(p), [...(at.get(key(p)) ?? []), i]);
  });
  const used = new Set<number>();
  const chains: { pts: Vec2[]; closed: boolean }[] = [];
  const next = (p: Vec2): number | undefined => (at.get(key(p)) ?? []).find((i) => !used.has(i));
  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const pts: Vec2[] = [...segs[i]!];
    for (let side = 0; side < 2; side++) {
      for (;;) {
        const end = side === 0 ? pts[pts.length - 1]! : pts[0]!;
        const n = next(end);
        if (n === undefined) break;
        used.add(n);
        const [a, b] = segs[n]!;
        const other = key(a) === key(end) ? b : a;
        if (side === 0) pts.push(other);
        else pts.unshift(other);
      }
    }
    const closed = pts.length > 3 && key(pts[0]!) === key(pts[pts.length - 1]!);
    chains.push({ pts: closed ? pts.slice(0, -1) : pts, closed });
  }
  return chains;
}

/** Drop points that lie on a straight run (curved sections keep their samples). */
export function simplifyChain(pts: Vec2[], closed: boolean): Vec2[] {
  if (pts.length < 4) return pts;
  const keep = pts.filter((p, i) => {
    if (!closed && (i === 0 || i === pts.length - 1)) return true;
    const a = pts[(i - 1 + pts.length) % pts.length]!;
    const b = pts[(i + 1) % pts.length]!;
    const cross = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]);
    const scale = Math.hypot(p[0] - a[0], p[1] - a[1]) * Math.hypot(b[0] - p[0], b[1] - p[1]) || 1;
    return Math.abs(cross) / scale > 1e-4;
  });
  return keep.length >= (closed ? 3 : 2) ? keep : pts;
}

