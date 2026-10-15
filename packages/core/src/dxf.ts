/** Reads the 2D geometry of an ASCII DXF drawing (lines, arcs, circles, polylines, ellipses, splines). */
import type { Vec2 } from "./model";
import { bsplineSamples } from "./sketch";
import { chainSegments2D, simplifyChain } from "./section";

export interface DxfResult {
  /** Closed and open outlines, in the drawing's units. */
  loops: { pts: Vec2[]; closed: boolean }[];
  circles: { c: Vec2; r: number }[];
  /** Entity kinds that were present but not read (text, hatches, 3D solids...). */
  skipped: string[];
}

type Pair = [number, string];

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

export function parseDxf(text: string): DxfResult {
  const p = pairs(text);
  const segs: [Vec2, Vec2][] = [];
  const direct: { pts: Vec2[]; closed: boolean }[] = [];
  const circles: DxfResult["circles"] = [];
  const skipped = new Set<string>();
  const addPath = (pts: Vec2[], closed: boolean) => {
    if (pts.length < 2) return;
    const list = closed ? [...pts, pts[0]!] : pts;
    for (let i = 0; i + 1 < list.length; i++) segs.push([list[i]!, list[i + 1]!]);
  };
  // Cut into entities at every group code 0 inside the ENTITIES section.
  let inEntities = false;
  const ents: { type: string; data: Pair[] }[] = [];
  for (let i = 0; i < p.length; i++) {
    const [code, value] = p[i]!;
    if (code === 0 && value === "SECTION" && p[i + 1]?.[1] === "ENTITIES") {
      inEntities = true;
      continue;
    }
    if (code === 0 && value === "ENDSEC") inEntities = false;
    if (!inEntities) continue;
    if (code === 0) ents.push({ type: value, data: [] });
    else ents.at(-1)?.data.push([code, value]);
  }
  for (let i = 0; i < ents.length; i++) {
    const { type, data: d } = ents[i]!;
    switch (type) {
      case "LINE":
        segs.push([[num(d, 10), num(d, 20)], [num(d, 11), num(d, 21)]]);
        break;
      case "CIRCLE":
        circles.push({ c: [num(d, 10), num(d, 20)], r: num(d, 40) });
        break;
      case "ARC":
        addPath(arcPts([num(d, 10), num(d, 20)], num(d, 40), (num(d, 50) * Math.PI) / 180, (num(d, 51) * Math.PI) / 180), false);
        break;
      case "ELLIPSE": {
        const c: Vec2 = [num(d, 10), num(d, 20)];
        const m: Vec2 = [num(d, 11), num(d, 21)];
        const a = Math.hypot(m[0], m[1]);
        const b = a * num(d, 40, 1);
        const rot = Math.atan2(m[1], m[0]);
        const t0 = num(d, 41, 0);
        let t1 = num(d, 42, Math.PI * 2);
        if (t1 <= t0) t1 += Math.PI * 2;
        const n = Math.max(12, Math.ceil(((t1 - t0) / (Math.PI * 2)) * 72));
        const pts = Array.from({ length: n + 1 }, (_, k) => {
          const t = t0 + ((t1 - t0) * k) / n;
          const x = a * Math.cos(t);
          const y = b * Math.sin(t);
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
        const pts = bulgePoly(verts, closed);
        addPath(pts, closed);
        break;
      }
      case "POLYLINE": {
        const closed = (num(d, 70) & 1) === 1;
        const verts: { p: Vec2; bulge: number }[] = [];
        let j = i + 1;
        while (j < ents.length && ents[j]!.type === "VERTEX") {
          verts.push({ p: [num(ents[j]!.data, 10), num(ents[j]!.data, 20)], bulge: num(ents[j]!.data, 42) });
          j++;
        }
        i = j - 1;
        addPath(bulgePoly(verts, closed), closed);
        break;
      }
      case "SPLINE": {
        const fitX = all(d, 11);
        const fitY = all(d, 21);
        const ctlX = all(d, 10);
        const ctlY = all(d, 20);
        const closed = (num(d, 70) & 1) === 1;
        if (fitX.length >= 2) addPath(fitX.map((x, k) => [x, fitY[k] ?? 0] as Vec2), closed);
        else if (ctlX.length >= 3) addPath(bsplineSamples(ctlX.map((x, k) => [x, ctlY[k] ?? 0] as Vec2), false, 12), false);
        break;
      }
      case "VERTEX":
      case "SEQEND":
        break;
      default:
        skipped.add(type);
    }
  }
  const loops = chainSegments2D(segs).map((c) => ({ pts: simplifyChain(c.pts, c.closed), closed: c.closed }));
  return { loops: [...loops, ...direct], circles, skipped: [...skipped] };
}
