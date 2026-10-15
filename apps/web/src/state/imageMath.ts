/**
 * Pure image geometry for reference images: perspective correction
 * (homography), automatic thresholding (Otsu), sub-pixel contour tracing
 * (marching squares) and circle fitting. No DOM: unit tested in Node.
 */
import type { Vec2 } from "@whittle/core";

/** Solve A·x = b by Gaussian elimination with partial pivoting; null if singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-12) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / M[c]![c]!;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

/** The 3×3 homography (row-major, h33 = 1) taking each `from[i]` to `to[i]` (four pairs). */
export function homography(from: Vec2[], to: Vec2[]): number[] | null {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i]!;
    const [u, v] = to[i]!;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return h ? [...h, 1] : null;
}

export function applyH(h: number[], [x, y]: Vec2): Vec2 {
  const w = h[6]! * x + h[7]! * y + h[8]!;
  return [(h[0]! * x + h[1]! * y + h[2]!) / w, (h[3]! * x + h[4]! * y + h[5]!) / w];
}

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Resample `src` into a w×h image: output pixel p shows src at H·p (bilinear; outside = white). */
export function warp(src: Pixels, H: number[], w: number, h: number): Pixels {
  const out = new Uint8ClampedArray(w * h * 4);
  const { data, width: sw, height: sh } = src;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const [x, y] = applyH(H, [i + 0.5, j + 0.5]);
      const fx = x - 0.5;
      const fy = y - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const o = (j * w + i) * 4;
      if (x0 < 0 || y0 < 0 || x0 + 1 >= sw || y0 + 1 >= sh) {
        out.fill(255, o, o + 4);
        continue;
      }
      const tx = fx - x0;
      const ty = fy - y0;
      const a = (y0 * sw + x0) * 4;
      const b = a + 4;
      const c = a + sw * 4;
      const d = c + 4;
      for (let k = 0; k < 4; k++) {
        const top = data[a + k]! + (data[b + k]! - data[a + k]!) * tx;
        const bot = data[c + k]! + (data[d + k]! - data[c + k]!) * tx;
        out[o + k] = top + (bot - top) * ty;
      }
    }
  }
  return { data: out, width: w, height: h };
}

/** Luminance 0–255 per pixel (transparent pixels count as white paper). */
export function grayscale({ data, width, height }: Pixels): Uint8Array {
  const g = new Uint8Array(width * height);
  for (let i = 0; i < g.length; i++) {
    const a = data[i * 4 + 3]! / 255;
    const l = 0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!;
    g[i] = Math.round(l * a + 255 * (1 - a));
  }
  return g;
}

/** Otsu's method: the threshold that best separates the histogram into two classes. */
export function otsu(gray: Uint8Array): number {
  const hist = new Float64Array(256);
  for (const v of gray) hist[v]!++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return thr + 0.5;
}

/**
 * Marching squares on a scalar field (`inside` where value > thr), with
 * sub-pixel interpolation along cell edges. Returns closed loops in pixel
 * coordinates (pixel i's centre at i + 0.5). The field is padded with
 * "outside", so every loop closes.
 */
export function contours(field: ArrayLike<number>, w: number, h: number, thr: number): Vec2[][] {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? -Infinity : field[y * w + x]!);
  // Edge ids: horizontal edge (x,y)-(x+1,y) and vertical edge (x,y)-(x,y+1), on corners -1..w, -1..h.
  const W = w + 2;
  const hId = (x: number, y: number) => ((y + 1) * W + (x + 1)) * 2;
  const vId = (x: number, y: number) => ((y + 1) * W + (x + 1)) * 2 + 1;
  const point = (id: number): Vec2 => {
    const cell = id >> 1;
    const x = (cell % W) - 1;
    const y = Math.floor(cell / W) - 1;
    const [x2, y2] = id & 1 ? [x, y + 1] : [x + 1, y];
    const a = at(x, y);
    const b = at(x2, y2);
    // Next to the padding the boundary is the image edge, half way; elsewhere interpolate.
    const t = a === -Infinity || b === -Infinity ? 0.5 : Math.min(1, Math.max(0, (thr - a) / (b - a)));
    return [x + (x2 - x) * t + 0.5, y + (y2 - y) * t + 0.5];
  };
  const next = new Map<number, number>();
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const tl = at(x, y) > thr ? 8 : 0;
      const tr = at(x + 1, y) > thr ? 4 : 0;
      const br = at(x + 1, y + 1) > thr ? 2 : 0;
      const bl = at(x, y + 1) > thr ? 1 : 0;
      const c = tl | tr | br | bl;
      if (c === 0 || c === 15) continue;
      const T = hId(x, y);
      const B = hId(x, y + 1);
      const L = vId(x, y);
      const R = vId(x + 1, y);
      // Segments run with the inside on their left (on screen, y down).
      const segs: [number, number][] = (
        {
          8: [[L, T]], 4: [[T, R]], 2: [[R, B]], 1: [[B, L]],
          7: [[T, L]], 11: [[R, T]], 13: [[B, R]], 14: [[L, B]],
          12: [[L, R]], 6: [[T, B]], 3: [[R, L]], 9: [[B, T]],
          10: [[L, T], [R, B]], 5: [[T, R], [B, L]],
        } as Record<number, [number, number][]>
      )[c]!;
      for (const [a, b] of segs) next.set(a, b);
    }
  }
  const loops: Vec2[][] = [];
  for (const start of next.keys()) {
    if (!next.has(start)) continue;
    const loop: Vec2[] = [];
    let id: number | undefined = start;
    while (id !== undefined && next.has(id)) {
      loop.push(point(id));
      const n: number = next.get(id)!;
      next.delete(id);
      id = n;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** Signed shoelace area. */
export function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * Least-squares circle through points (Kåsa fit). Returns the circle when every
 * point lies within `tol` (a fraction of the radius) of it, else null.
 */
export function fitCircle(pts: Vec2[], tol = 0.02): { cx: number; cy: number; r: number } | null {
  if (pts.length < 8) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  for (const [x, y] of pts) {
    const z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z;
  }
  const n = pts.length;
  const s = solve([[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], [sxz, syz, sz]);
  if (!s) return null;
  const cx = s[0]! / 2;
  const cy = s[1]! / 2;
  const r = Math.sqrt(s[2]! + cx * cx + cy * cy);
  if (!(r > 0)) return null;
  for (const [x, y] of pts) if (Math.abs(Math.hypot(x - cx, y - cy) - r) > tol * r) return null;
  // The points must also go all the way round, not be one arc of a bigger outline.
  const angles = pts.map(([x, y]) => Math.atan2(y - cy, x - cx)).sort((a, b) => a - b);
  let gap = angles[0]! + 2 * Math.PI - angles[angles.length - 1]!;
  for (let i = 1; i < angles.length; i++) gap = Math.max(gap, angles[i]! - angles[i - 1]!);
  return gap < Math.PI / 4 ? { cx, cy, r } : null;
}
