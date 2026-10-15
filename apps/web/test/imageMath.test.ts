import { describe, expect, it } from "vitest";
import { applyH, contours, fitCircle, homography, otsu, signedArea, warp } from "../src/state/imageMath";

describe("reference image math", () => {
  it("homography maps a skewed quad onto a rectangle", () => {
    const quad: [number, number][] = [[12, 30], [205, 18], [230, 260], [5, 240]];
    const rect: [number, number][] = [[0, 0], [210, 0], [210, 297], [0, 297]];
    const H = homography(quad, rect)!;
    quad.forEach((p, i) => {
      const [u, v] = applyH(H, p);
      expect(u).toBeCloseTo(rect[i]![0], 6);
      expect(v).toBeCloseTo(rect[i]![1], 6);
    });
  });

  it("warp with the identity copies pixels", () => {
    const data = new Uint8ClampedArray(4 * 4 * 4).map((_, i) => (i * 7) % 256);
    const out = warp({ data, width: 4, height: 4 }, [1, 0, 0, 0, 1, 0, 0, 0, 1], 4, 4);
    // Interior pixels (bilinear needs a neighbour) are unchanged.
    expect(Array.from(out.data.slice(20, 24))).toEqual(Array.from(data.slice(20, 24)));
  });

  it("otsu separates two levels", () => {
    const g = new Uint8Array(1000).map((_, i) => (i < 300 ? 40 : 210));
    const t = otsu(g);
    expect(t).toBeGreaterThan(40);
    expect(t).toBeLessThan(210);
  });

  it("traces a ring as an outer loop and a hole, with sub-pixel accuracy", () => {
    const w = 80;
    const field = new Float32Array(w * w);
    // Anti-aliased ring: radii 30 and 15 around (40, 40); value = coverage 0..1.
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x + 0.5 - 40, y + 0.5 - 40);
        field[y * w + x] = Math.min(Math.max(30.5 - d, 0), 1) * Math.min(Math.max(d - 14.5, 0), 1);
      }
    const loops = contours(field, w, w, 0.5);
    expect(loops.length).toBe(2);
    const [outer, inner] = [...loops].sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
    // Opposite windings: the outline and its hole.
    expect(Math.sign(signedArea(outer!))).toBe(-Math.sign(signedArea(inner!)));
    const c1 = fitCircle(outer!)!;
    const c2 = fitCircle(inner!)!;
    expect(c1.r).toBeCloseTo(30, 0);
    expect(c2.r).toBeCloseTo(15, 0);
    expect(c1.cx).toBeCloseTo(40, 1);
  });

  it("a square is not mistaken for a circle", () => {
    const sq: [number, number][] = [];
    for (let i = 0; i < 40; i++) {
      const t = i / 10;
      sq.push(t < 1 ? [t, 0] : t < 2 ? [1, t - 1] : t < 3 ? [3 - t, 1] : [0, 4 - t]);
    }
    expect(fitCircle(sq)).toBeNull();
  });
});
