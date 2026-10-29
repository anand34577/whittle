/** Reads the 2D geometry of an ASCII DXF drawing (lines, arcs, circles, polylines, ellipses, splines, block references). */
import type { Vec2 } from "./model";
import { bsplineSamples, smoothClosed, smoothOpen } from "./sketch";
import { chainSegments2D, simplifyChain } from "./section";

export interface DxfResult {
  /** Closed and open outlines, in the drawing's units. */
  loops: { pts: Vec2[]; closed: boolean }[];
  circles: { c: Vec2; r: number }[];
  /** Entity kinds that were present but not read (text, hatches, 3D solids...). */
  skipped: string[];
  /** Millimetres per drawing unit, when the file's header says which unit it was drawn in. */
  mmPerUnit?: number;
}

/** $INSUNITS codes to millimetres (inches, feet, miles... as the drawing format numbers them). */
const INSUNITS: Record<number, number> = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 0.0000254, 9: 0.0254, 10: 914.4, 13: 0.001, 14: 100 };

type Pair = [number, string];
type Ent = { type: string; data: Pair[] };
/** x' = a x + b y + e, y' = c x + d y + f */
type Affine = [number, number, number, number, number, number];
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];
/** Block references inside block references: deeper than this is treated as a loop in the file. */
const MAX_BLOCK_DEPTH = 16;

function pairs(text: string): Pair[] {
  const lines = text.split(/\r?\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i]!.trim(), 10);
    if (Number.isNaN(code)) continue;
    out.push([code, lines[i + 1]!.trim()]);
  }
  return out;
}

const num = (e: Pair[], code: number, d = 0): number => {
  const p = e.find((x) => x[0] === code);
  return p ? Number.parseFloat(p[1]) : d;
};
const str = (e: Pair[], code: number): string | undefined => e.find((x) => x[0] === code)?.[1];
const fin = (...v: number[]) => v.every(Number.isFinite);
const all = (e: Pair[], code: number): number[] => e.filter((x) => x[0] === code).map((x) => Number.parseFloat(x[1]));

function arcPts(c: Vec2, r: number, a0: number, a1: number, step = Math.PI / 24): Vec2[] {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += Math.PI * 2;
  const n = Math.max(2, Math.ceil(sweep / step));
  return Array.from({ length: n + 1 }, (_, i) => [c[0] + r * Math.cos(a0 + (sweep * i) / n), c[1] + r * Math.sin(a0 + (sweep * i) / n)] as Vec2);
}

/** Points along a polyline whose segments may bulge (DXF: bulge = tan(sweep / 4), positive = counter-clockwise). */
function bulgePoly(v: { p: Vec2; bulge: number }[], closed: boolean): Vec2[] {
  const out: Vec2[] = [];
  const n = closed ? v.length : v.length - 1;
  for (let i = 0; i < n; i++) {
    const a = v[i]!;
    const b = v[(i + 1) % v.length]!;
    out.push(a.p);
    const chord = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]);
    if (Math.abs(a.bulge) > 1e-9 && chord > 1e-9) {
      const theta = 4 * Math.atan(a.bulge);
      const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
      const left: Vec2 = [-(b.p[1] - a.p[1]) / chord, (b.p[0] - a.p[0]) / chord];
      const k = r * Math.cos(theta / 2) * Math.sign(theta);
      const center: Vec2 = [(a.p[0] + b.p[0]) / 2 + left[0] * k, (a.p[1] + b.p[1]) / 2 + left[1] * k];
      const a0 = Math.atan2(a.p[1] - center[1], a.p[0] - center[0]);
      const steps = Math.max(2, Math.ceil(Math.abs(theta) / (Math.PI / 24)));
      for (let s = 1; s < steps; s++) out.push([center[0] + r * Math.cos(a0 + (theta * s) / steps), center[1] + r * Math.sin(a0 + (theta * s) / steps)]);
    }
  }
  if (!closed) out.push(v[v.length - 1]!.p);
  return out;
}

/**
 * Samples of a (rational) B-spline from its degree, knot vector, control points and weights, by de Boor's
 * algorithm (audit C-11: the knots and degree were ignored). Null when the data doesn't describe a valid curve.
 */
export function nurbsSamples(degree: number, knots: number[], ctrl: Vec2[], weights: number[] = [], perSpan = 12): Vec2[] | null {
  const p = Math.round(degree);
  const n = ctrl.length;
  if (!(p >= 1) || n <= p || knots.length !== n + p + 1) return null;
  for (let i = 1; i < knots.length; i++) if (!(knots[i]! >= knots[i - 1]!)) return null;
  const w = ctrl.map((_, i) => (weights.length === n && weights[i]! > 0 ? weights[i]! : 1));
  const lo = knots[p]!;
  const hi = knots[n]!;
  if (!(hi > lo)) return null;
  const at = (u: number): Vec2 => {
    let k = p;
    while (k < n - 1 && u >= knots[k + 1]!) k++;
    // Homogeneous control points of the span, then de Boor's triangle.
    const d = Array.from({ length: p + 1 }, (_, j) => {
      const i = k - p + j;
      return [ctrl[i]![0] * w[i]!, ctrl[i]![1] * w[i]!, w[i]!];
    });
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = k - p + j;
        const den = knots[i + p - r + 1]! - knots[i]!;
        const a = den > 0 ? (u - knots[i]!) / den : 0;
        for (let c = 0; c < 3; c++) d[j]![c] = (1 - a) * d[j - 1]![c]! + a * d[j]![c]!;
      }
    }
    const h = d[p]!;
    return [h[0]! / h[2]!, h[1]! / h[2]!];
  };
  const spans = new Set(knots.slice(p, n + 1)).size - 1;
  const count = Math.max(8, spans * perSpan);
  return Array.from({ length: count + 1 }, (_, i) => at(i === count ? hi : lo + ((hi - lo) * i) / count));
}

const apply = (t: Affine, v: Vec2): Vec2 => [t[0] * v[0] + t[1] * v[1] + t[4], t[2] * v[0] + t[3] * v[1] + t[5]];
const compose = (outer: Affine, inner: Affine): Affine => [
  outer[0] * inner[0] + outer[1] * inner[2],
  outer[0] * inner[1] + outer[1] * inner[3],
  outer[2] * inner[0] + outer[3] * inner[2],
  outer[2] * inner[1] + outer[3] * inner[3],
  outer[0] * inner[4] + outer[1] * inner[5] + outer[4],
  outer[2] * inner[4] + outer[3] * inner[5] + outer[5],
];

export function parseDxf(text: string): DxfResult {
  const p = pairs(text);
  const segs: [Vec2, Vec2][] = [];
  const circles: DxfResult["circles"] = [];
  const skipped = new Set<string>();
  // Cut into entities at every group code 0 inside the ENTITIES and BLOCKS sections.
  let section = "";
  let mmPerUnit: number | undefined;
  const ents: Ent[] = [];
  const blocks = new Map<string, { base: Vec2; ents: Ent[] }>();
  let block: { base: Vec2; ents: Ent[] } | null = null;
  let blockHead: Ent | null = null;
  for (let i = 0; i < p.length; i++) {
    const [code, value] = p[i]!;
    if (code === 9 && value === "$INSUNITS" && p[i + 1]?.[0] === 70) mmPerUnit = INSUNITS[Number.parseInt(p[i + 1]![1], 10)];
    if (code === 0 && value === "SECTION") {
      section = p[i + 1]?.[0] === 2 ? p[i + 1]![1] : "";
      i++;
      continue;
    }
    if (code === 0 && value === "ENDSEC") {
      section = "";
      continue;
    }
    if (section === "ENTITIES") {
      if (code === 0) ents.push({ type: value, data: [] });
      else ents.at(-1)?.data.push([code, value]);
    } else if (section === "BLOCKS") {
      if (code === 0 && value === "BLOCK") {
        blockHead = { type: "BLOCK", data: [] };
        block = null;
      } else if (code === 0 && value === "ENDBLK") {
        blockHead = null;
        block = null;
      } else if (code === 0) {
        if (blockHead && !block) {
          const name = str(blockHead.data, 2) ?? "";
          block = { base: [num(blockHead.data, 10), num(blockHead.data, 20)], ents: [] };
          blocks.set(name, block);
        }
        block?.ents.push({ type: value, data: [] });
      } else if (block) block.ents.at(-1)?.data.push([code, value]);
      else blockHead?.data.push([code, value]);
    }
  }
  // A block with no entities still gets a (empty) record, so referencing it isn't reported as missing.
  for (let i = 0; i + 1 < p.length; i++) {
    if (p[i]![0] === 0 && p[i]![1] === "BLOCK") {
      const name = p.slice(i + 1, i + 40).find((x) => x[0] === 2)?.[1];
      if (name !== undefined && !blocks.has(name)) blocks.set(name, { base: [0, 0], ents: [] });
    }
  }

  const emit = (list: Ent[], t: Affine, depth: number) => {
    const T = (v: Vec2) => apply(t, v);
    const addPath = (pts: Vec2[], closed: boolean) => {
      if (pts.length < 2) return;
      const q = pts.map(T);
      const loop = closed ? [...q, q[0]!] : q;
      for (let i = 0; i + 1 < loop.length; i++) segs.push([loop[i]!, loop[i + 1]!]);
    };
    // A circle stays a circle under a uniform scale and rotation; otherwise it is drawn as points.
    const sx = Math.hypot(t[0], t[2]);
    const sy = Math.hypot(t[1], t[3]);
    const uniform = Math.abs(sx - sy) < 1e-9 * Math.max(1, sx) && Math.abs(t[0] * t[1] + t[2] * t[3]) < 1e-9 * Math.max(1, sx * sy);
    for (let i = 0; i < list.length; i++) {
      const { type, data: d } = list[i]!;
      // Circles, arcs and 2D polylines are drawn in their own plane; one whose normal points down (-Z) is seen mirrored.
      const flip = num(d, 230, 1) < 0 ? -1 : 1;
      const X = (v: Vec2): Vec2 => [v[0] * flip, v[1]];
      // Numbers that can't be read (or a circle with no size) would reach the sketch as NaN: leave such entities out and say so.
      const bad = () => skipped.add(`${type} (unreadable numbers)`);
      switch (type) {
        case "LINE": {
          const a: Vec2 = [num(d, 10), num(d, 20)];
          const b: Vec2 = [num(d, 11), num(d, 21)];
          if (fin(...a, ...b)) segs.push([T(a), T(b)]);
          else bad();
          break;
        }
        case "CIRCLE": {
          const c: Vec2 = X([num(d, 10), num(d, 20)]);
          const r = num(d, 40);
          if (!(fin(...c, r) && r > 0)) bad();
          else if (uniform) circles.push({ c: T(c), r: r * sx });
          else addPath(arcPts(c, r, 0, Math.PI * 2).slice(0, -1), true);
          break;
        }
        case "ARC": {
          const c: Vec2 = [num(d, 10), num(d, 20)];
          const r = num(d, 40);
          const a0 = num(d, 50);
          const a1 = num(d, 51);
          if (fin(...c, r, a0, a1) && r > 0) addPath(arcPts(c, r, (a0 * Math.PI) / 180, (a1 * Math.PI) / 180).map(X), false);
          else bad();
          break;
        }
        case "ELLIPSE": {
          const c: Vec2 = [num(d, 10), num(d, 20)];
          const m: Vec2 = [num(d, 11), num(d, 21)];
          if (!fin(...c, ...m, num(d, 40, 1), num(d, 41, 0), num(d, 42, Math.PI * 2))) {
            bad();
            break;
          }
          const a = Math.hypot(m[0], m[1]);
          const b = a * num(d, 40, 1);
          const rot = Math.atan2(m[1], m[0]);
          const t0 = num(d, 41, 0);
          let t1 = num(d, 42, Math.PI * 2);
          if (t1 <= t0) t1 += Math.PI * 2;
          const n = Math.max(12, Math.ceil(((t1 - t0) / (Math.PI * 2)) * 72));
          const pts = Array.from({ length: n + 1 }, (_, k) => {
            const u = t0 + ((t1 - t0) * k) / n;
            const x = a * Math.cos(u);
            const y = b * Math.sin(u);
            return [c[0] + x * Math.cos(rot) - y * Math.sin(rot), c[1] + x * Math.sin(rot) + y * Math.cos(rot)] as Vec2;
          });
          addPath(pts, false);
          break;
        }
        case "LWPOLYLINE": {
          const ys = all(d, 20);
          // Bulges (code 42) belong to the vertex that precedes them; walk the codes in order.
          const verts: { p: Vec2; bulge: number }[] = [];
          for (const [code, value] of d) {
            if (code === 10) verts.push({ p: [Number.parseFloat(value), ys[verts.length] ?? 0], bulge: 0 });
            else if (code === 42 && verts.length) verts[verts.length - 1]!.bulge = Number.parseFloat(value);
          }
          const closed = (num(d, 70) & 1) === 1;
          if (verts.some((v) => !fin(...v.p, v.bulge))) {
            bad();
            break;
          }
          addPath(bulgePoly(verts, closed).map(X), closed);
          break;
        }
        case "POLYLINE": {
          const closed = (num(d, 70) & 1) === 1;
          const verts: { p: Vec2; bulge: number }[] = [];
          let j = i + 1;
          while (j < list.length && list[j]!.type === "VERTEX") {
            verts.push({ p: [num(list[j]!.data, 10), num(list[j]!.data, 20)], bulge: num(list[j]!.data, 42) });
            j++;
          }
          i = j - 1;
          if (verts.some((v) => !fin(...v.p, v.bulge))) {
            bad();
            break;
          }
          addPath(bulgePoly(verts, closed).map(X), closed);
          break;
        }
        case "SPLINE": {
          const fitX = all(d, 11);
          const fitY = all(d, 21);
          const ctlX = all(d, 10);
          const ctlY = all(d, 20);
          const closed = (num(d, 70) & 1) === 1;
          const fit = fitX.map((x, k) => [x, fitY[k] ?? 0] as Vec2);
          const ctl = ctlX.map((x, k) => [x, ctlY[k] ?? 0] as Vec2);
          if ([...fit, ...ctl].some((q) => !fin(...q))) {
            bad();
            break;
          }
          // Control points with their knots, degree and weights when the file has them; that is the exact curve.
          const exact = ctl.length >= 2 ? nurbsSamples(num(d, 71, 3), all(d, 40), ctl, all(d, 41)) : null;
          if (exact) addPath(exact, false);
          // Otherwise a smooth curve through the fit points (not straight lines between them).
          else if (fit.length >= 3) addPath(closed ? smoothClosed(fit, 12) : smoothOpen(fit, 12), closed);
          else if (fit.length === 2) addPath(fit, false);
          else if (ctl.length >= 3) addPath(bsplineSamples(ctl, false, 12), false);
          else bad();
          break;
        }
        case "INSERT": {
          // A block reference (audit C-11): the block's entities, moved, scaled and turned into place.
          const name = str(d, 2) ?? "";
          const b = blocks.get(name);
          if (!b) {
            skipped.add(`INSERT (missing block "${name}")`);
            break;
          }
          if (depth >= MAX_BLOCK_DEPTH) {
            skipped.add("INSERT (blocks nested too deep)");
            break;
          }
          const pos: Vec2 = [num(d, 10), num(d, 20)];
          const kx = num(d, 41, 1);
          const ky = num(d, 42, 1);
          const rot = (num(d, 50, 0) * Math.PI) / 180;
          const cols = Math.max(1, Math.round(num(d, 70, 1)));
          const rows = Math.max(1, Math.round(num(d, 71, 1)));
          const dx = num(d, 44, 0);
          const dy = num(d, 45, 0);
          if (!fin(...pos, kx, ky, rot, dx, dy) || kx === 0 || ky === 0) {
            bad();
            break;
          }
          const [cs, sn] = [Math.cos(rot), Math.sin(rot)];
          // Turned and scaled about the block's base point, then placed; a downward normal mirrors it like other entities.
          const local: Affine = [cs * kx, -sn * ky, sn * kx, cs * ky, 0, 0];
          const shift = apply(local, b.base);
          const mirror: Affine = [flip, 0, 0, 1, 0, 0];
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              // Array copies step along the block's own (turned) axes.
              const ox = pos[0] + c * dx * cs - r * dy * sn;
              const oy = pos[1] + c * dx * sn + r * dy * cs;
              const place: Affine = [local[0], local[1], local[2], local[3], ox - shift[0], oy - shift[1]];
              emit(b.ents, compose(t, compose(mirror, place)), depth + 1);
            }
          }
          break;
        }
        case "VERTEX":
        case "SEQEND":
        case "ATTRIB":
        case "ATTDEF":
          break;
        default:
          skipped.add(type);
      }
    }
  };
  emit(ents, IDENTITY, 0);
  const loops = chainSegments2D(segs).map((c) => ({ pts: simplifyChain(c.pts, c.closed), closed: c.closed }));
  return { loops, circles, skipped: [...skipped], ...(mmPerUnit ? { mmPerUnit } : {}) };
}
