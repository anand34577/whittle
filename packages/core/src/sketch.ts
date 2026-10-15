/**
 * Numeric sketch geometry shared by the kernel (to build profiles) and the
 * UI (to draw sketches and snap to them).
 */
import type { Evaluator } from "./params";
import type { SketchEntity, Vec2, Vec3 } from "./model";

export type ResolvedEntity =
  | { id: string; type: "rect"; x: number; y: number; w: number; h: number; corner: number; angle: number; construction: boolean; mode: string }
  | { id: string; type: "circle"; cx: number; cy: number; r: number; construction: boolean; mode: string }
  | { id: string; type: "polygon"; cx: number; cy: number; r: number; sides: number; angle: number; construction: boolean; mode: string }
  | { id: string; type: "slot"; cx: number; cy: number; length: number; width: number; angle: number; construction: boolean; mode: string }
  | { id: string; type: "polyline"; points: Vec2[]; arcs: boolean[]; corner: number; smooth: boolean; open: boolean; construction: boolean; mode: string }
  | { id: string; type: "ellipse"; cx: number; cy: number; rx: number; ry: number; angle: number; construction: boolean; mode: string }
  | { id: string; type: "text"; x: number; y: number; text: string; size: number; bold: boolean; angle: number; construction: boolean; mode: string }
  | { id: string; type: "gear"; cx: number; cy: number; teeth: number; module: number; bore: number; construction: boolean; mode: string };

/** Resolve the expressions of a sketch entity. Throws a readable error. */
export function resolveEntity(e: SketchEntity, ev: Evaluator): ResolvedEntity {
  const L = (x: string, label: string) => ev.num(x, "length", label);
  const common = { id: e.id, construction: !!e.construction, mode: e.mode ?? "auto" };
  switch (e.type) {
    case "rect": {
      const w = L(e.w, "Width");
      const h = L(e.h, "Height");
      if (w <= 0 || h <= 0) throw new Error("Rectangle width and height must be greater than zero");
      let x = L(e.x, "X");
      let y = L(e.y, "Y");
      if (e.anchor === "center") {
        x -= w / 2;
        y -= h / 2;
      }
      const corner = e.corner ? L(e.corner, "Corner radius") : 0;
      if (corner < 0 || corner * 2 >= Math.min(w, h)) {
        if (corner !== 0) throw new Error(`Corner radius must be less than ${(Math.min(w, h) / 2).toFixed(2)} mm`);
      }
      const angle = e.angle ? ev.num(e.angle, "angle", "Rotation") : 0;
      return { ...common, type: "rect", x, y, w, h, corner, angle };
    }
    case "circle": {
      const r = L(e.r, "Radius");
      if (r <= 0) throw new Error("Circle radius must be greater than zero");
      return { ...common, type: "circle", cx: L(e.cx, "Center X"), cy: L(e.cy, "Center Y"), r };
    }
    case "polygon": {
      const r = L(e.r, "Radius");
      const sides = ev.num(e.sides, "count", "Sides");
      if (r <= 0) throw new Error("Polygon radius must be greater than zero");
      if (sides < 3 || sides > 64) throw new Error("A polygon needs between 3 and 64 sides");
      return {
        ...common,
        type: "polygon",
        cx: L(e.cx, "Center X"),
        cy: L(e.cy, "Center Y"),
        r,
        sides,
        angle: ev.num(e.angle, "angle", "Rotation"),
      };
    }
    case "slot": {
      const length = L(e.length, "Length");
      const width = L(e.width, "Width");
      if (width <= 0) throw new Error("Slot width must be greater than zero");
      if (length < 0) throw new Error("Slot length can't be negative");
      return {
        ...common,
        type: "slot",
        cx: L(e.cx, "Center X"),
        cy: L(e.cy, "Center Y"),
        length,
        width,
        angle: ev.num(e.angle, "angle", "Rotation"),
      };
    }
    case "polyline": {
      const points = e.points.map(([px, py], i) => [L(px, `Point ${i + 1} X`), L(py, `Point ${i + 1} Y`)] as Vec2);
      const corner = e.corner ? L(e.corner, "Corner radius") : 0;
      if (corner < 0) throw new Error("Corner radius can't be negative");
      if (!e.open && points.length < 3) throw new Error("A closed outline needs at least three points");
      const arcs = e.points.map((p) => p[2] === "arc");
      arcs.forEach((a, i) => {
        if (!a) return;
        if (i === 0 || (e.open && i === points.length - 1)) throw new Error("An arc needs a point before and after it");
        if (arcs[i - 1] || arcs[(i + 1) % arcs.length]) throw new Error("Two arc points can't follow each other; put a corner point between them");
      });
      return { ...common, type: "polyline", points, arcs, corner, smooth: !!e.smooth, open: !!e.open };
    }
    case "ellipse": {
      const rx = L(e.rx, "Radius X");
      const ry = L(e.ry, "Radius Y");
      if (rx <= 0 || ry <= 0) throw new Error("Ellipse radii must be greater than zero");
      return { ...common, type: "ellipse", cx: L(e.cx, "Center X"), cy: L(e.cy, "Center Y"), rx, ry, angle: ev.num(e.angle, "angle", "Rotation") };
    }
    case "text": {
      const size = L(e.size, "Size");
      if (size <= 0) throw new Error("Text size must be greater than zero");
      if (!e.text.trim()) throw new Error("Type some text");
      return { ...common, type: "text", x: L(e.x, "X"), y: L(e.y, "Y"), text: e.text, size, bold: !!e.bold, angle: ev.num(e.angle, "angle", "Rotation") };
    }
    case "gear": {
      const teeth = Math.round(ev.num(e.teeth, "count", "Teeth"));
      const module = L(e.module, "Module");
      const bore = L(e.bore, "Bore");
      if (teeth < 6 || teeth > 200) throw new Error("A gear needs between 6 and 200 teeth");
      if (module <= 0) throw new Error("Module must be greater than zero");
      const root = (module * teeth) / 2 - 1.25 * module;
      if (bore < 0 || bore / 2 >= root * 0.95) throw new Error(`The bore must be smaller than ${(root * 1.9).toFixed(1)} mm`);
      return { ...common, type: "gear", cx: L(e.cx, "Center X"), cy: L(e.cy, "Center Y"), teeth, module, bore };
    }
  }
}

function rot([x, y]: Vec2, a: number): Vec2 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

/** A closed 2D outline approximating the entity (for display and snapping). */
export function entityOutline(r: ResolvedEntity, segments = 64): Vec2[] {
  switch (r.type) {
    case "rect": {
      if (r.angle) {
        const c: Vec2 = [r.x + r.w / 2, r.y + r.h / 2];
        return entityOutline({ ...r, angle: 0 }, segments).map((p) => rotAbout(p, c, r.angle));
      }
      if (r.corner > 0) {
        const pts: Vec2[] = [];
        const c = r.corner;
        const corners: [number, number, number][] = [
          [r.x + r.w - c, r.y + c, -Math.PI / 2],
          [r.x + r.w - c, r.y + r.h - c, 0],
          [r.x + c, r.y + r.h - c, Math.PI / 2],
          [r.x + c, r.y + c, Math.PI],
        ];
        for (const [cx, cy, a0] of corners) {
          for (let i = 0; i <= 8; i++) {
            const a = a0 + (i / 8) * (Math.PI / 2);
            pts.push([cx + c * Math.cos(a), cy + c * Math.sin(a)]);
          }
        }
        return pts;
      }
      return [
        [r.x, r.y],
        [r.x + r.w, r.y],
        [r.x + r.w, r.y + r.h],
        [r.x, r.y + r.h],
      ];
    }
    case "circle": {
      const pts: Vec2[] = [];
      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        pts.push([r.cx + r.r * Math.cos(a), r.cy + r.r * Math.sin(a)]);
      }
      return pts;
    }
    case "polygon": {
      const pts: Vec2[] = [];
      for (let i = 0; i < r.sides; i++) {
        const a = r.angle + (i / r.sides) * Math.PI * 2;
        pts.push([r.cx + r.r * Math.cos(a), r.cy + r.r * Math.sin(a)]);
      }
      return pts;
    }
    case "slot": {
      const pts: Vec2[] = [];
      const half = r.length / 2;
      const rad = r.width / 2;
      const n = Math.max(8, segments / 4);
      for (let i = 0; i <= n; i++) {
        const a = -Math.PI / 2 + (i / n) * Math.PI;
        pts.push([half + rad * Math.cos(a), rad * Math.sin(a)]);
      }
      for (let i = 0; i <= n; i++) {
        const a = Math.PI / 2 + (i / n) * Math.PI;
        pts.push([-half + rad * Math.cos(a), rad * Math.sin(a)]);
      }
      return pts.map((p) => {
        const q = rot(p, r.angle);
        return [q[0] + r.cx, q[1] + r.cy] as Vec2;
      });
    }
    case "polyline": {
      if (r.smooth && r.points.length >= 3) return r.open ? smoothOpen(r.points, 12) : smoothClosed(r.points, 12);
      if (r.arcs.some(Boolean)) return polylinePath(r.points, r.arcs, !r.open);
      if (!r.open && r.corner > 0 && r.points.length >= 3) return roundCorners(r.points, r.corner);
      return r.points;
    }
    case "ellipse": {
      const pts: Vec2[] = [];
      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        pts.push(rotAbout([r.cx + r.rx * Math.cos(a), r.cy + r.ry * Math.sin(a)], [r.cx, r.cy], r.angle));
      }
      return pts;
    }
    case "text": {
      const [w, h] = textExtent(r);
      const box: Vec2[] = [
        [r.x, r.y - h * 0.22],
        [r.x + w, r.y - h * 0.22],
        [r.x + w, r.y + h],
        [r.x, r.y + h],
      ];
      return box.map((p) => rotAbout(p, [r.x, r.y], r.angle));
    }
    case "gear":
      return gearOutline(r.cx, r.cy, r.teeth, r.module);
  }
}

/** Every closed loop of an entity, outer first (a gear's bore is a second loop). */
export function entityLoops(r: ResolvedEntity, segments = 64): Vec2[][] {
  const out = [entityOutline(r, segments)];
  if (r.type === "gear" && r.bore > 0) {
    out.push(entityOutline({ id: r.id, type: "circle", cx: r.cx, cy: r.cy, r: r.bore / 2, construction: false, mode: "auto" }, segments));
  }
  return out;
}

/** Approximate text block size (the real glyphs come from the kernel). */
export function textExtent(r: { text: string; size: number; bold: boolean }): Vec2 {
  return [r.size * (r.bold ? 0.62 : 0.56) * r.text.length, r.size * 0.72];
}

function rotAbout(p: Vec2, c: Vec2, a: number): Vec2 {
  if (!a) return p;
  const q = rot([p[0] - c[0], p[1] - c[1]], a);
  return [q[0] + c[0], q[1] + c[1]];
}

/** Center of the circle through three points, or null when they're in a line. */
export function circleThrough(a: Vec2, m: Vec2, b: Vec2): Vec2 | null {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  const span = Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(m[0] - a[0], m[1] - a[1]);
  if (Math.abs(d) < 1e-9 * Math.max(1, span * span)) return null;
  const sa = a[0] * a[0] + a[1] * a[1];
  const sm = m[0] * m[0] + m[1] * m[1];
  const sb = b[0] * b[0] + b[1] * b[1];
  return [(sa * (m[1] - b[1]) + sm * (b[1] - a[1]) + sb * (a[1] - m[1])) / d, (sa * (b[0] - m[0]) + sm * (a[0] - b[0]) + sb * (m[0] - a[0])) / d];
}

/** Points along the arc from `a` through `m` to `b`, without `b`. */
export function arcPoints(a: Vec2, m: Vec2, b: Vec2, segments = 16): Vec2[] {
  const c = circleThrough(a, m, b);
  if (!c) return [a];
  const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const ang = (p: Vec2) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const ccw = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const a0 = ang(a);
  const toB = ccw(ang(b) - a0);
  const sweep = ccw(ang(m) - a0) < toB ? toB : toB - 2 * Math.PI;
  const out: Vec2[] = [];
  for (let k = 0; k < segments; k++) {
    const t = a0 + (sweep * k) / segments;
    out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
  }
  return out;
}

/** An outline or path whose "arc" points bend the segment around them. */
export function polylinePath(pts: Vec2[], arcs: boolean[], closed: boolean, segments = 16): Vec2[] {
  const n = pts.length;
  const out: Vec2[] = [];
  const end = closed ? n : n - 1;
  for (let i = 0; i < end; ) {
    const j = (i + 1) % n;
    if (arcs[j] && (closed || j < n - 1)) {
      out.push(...arcPoints(pts[i]!, pts[j]!, pts[(j + 1) % n]!, segments));
      i += 2;
    } else {
      out.push(pts[i]!);
      i += 1;
    }
  }
  if (!closed) out.push(pts[n - 1]!);
  return out;
}

/**
 * Offset a polyline sideways by `d` (positive = left of the direction of travel),
 * with mitred corners. For a counter-clockwise outline, left is inside.
 */
export function offsetPoints(pts: Vec2[], d: number, closed: boolean): Vec2[] {
  const n = pts.length;
  const left = (a: Vec2, b: Vec2): Vec2 => norm2([a[1] - b[1], b[0] - a[0]]);
  return pts.map((p, i) => {
    const prev = closed || i > 0 ? pts[(i - 1 + n) % n]! : null;
    const next = closed || i < n - 1 ? pts[(i + 1) % n]! : null;
    const n1 = prev ? left(prev, p) : null;
    const n2 = next ? left(p, next) : null;
    if (!n1 || !n2) {
      const k = (n1 ?? n2)!;
      return [p[0] + k[0] * d, p[1] + k[1] * d];
    }
    const m = norm2([n1[0] + n2[0], n1[1] + n2[1]]);
    // ponytail: miter capped at 5x for very sharp corners; a true offset would round them.
    const k = d / Math.max(m[0] * n1[0] + m[1] * n1[1], 0.2);
    return [p[0] + m[0] * k, p[1] + m[1] * k];
  });
}

/** A closed outline around an open path: a wall `t` thick, centered or to one side. */
export function thickenPath(pts: Vec2[], t: number, side: "center" | "inside" | "outside" = "center"): Vec2[] {
  const [l, r] = side === "center" ? [t / 2, -t / 2] : side === "inside" ? [t, 0] : [0, -t];
  return [...offsetPoints(pts, l, false), ...offsetPoints(pts, r, false).reverse()];
}

/** Closed Catmull-Rom curve through the points. */
function smoothClosed(pts: Vec2[], perSeg: number): Vec2[] {
  const out: Vec2[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]!;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % n]!;
    const p3 = pts[(i + 2) % n]!;
    for (let k = 0; k < perSeg; k++) {
      const t = k / perSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out;
}

/** Open Catmull-Rom curve through the points (end tangents mirror the neighbours). */
function smoothOpen(pts: Vec2[], perSeg: number): Vec2[] {
  const n = pts.length;
  const at = (i: number): Vec2 => {
    if (i < 0) return [2 * pts[0]![0] - pts[1]![0], 2 * pts[0]![1] - pts[1]![1]];
    if (i >= n) return [2 * pts[n - 1]![0] - pts[n - 2]![0], 2 * pts[n - 1]![1] - pts[n - 2]![1]];
    return pts[i]!;
  };
  const out: Vec2[] = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let k = 0; k < perSeg; k++) {
      const t = k / perSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[n - 1]!);
  return out;
}

/** Polygon with each corner replaced by a circular arc (display approximation). */
function roundCorners(pts: Vec2[], radius: number): Vec2[] {
  const out: Vec2[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const a = pts[(i - 1 + n) % n]!;
    const b = pts[(i + 1) % n]!;
    const u = norm2([a[0] - p[0], a[1] - p[1]]);
    const v = norm2([b[0] - p[0], b[1] - p[1]]);
    const half = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1]))) / 2;
    if (half < 1e-3 || Math.abs(half - Math.PI / 2) < 1e-3) {
      out.push(p);
      continue;
    }
    const maxD = Math.min(Math.hypot(a[0] - p[0], a[1] - p[1]), Math.hypot(b[0] - p[0], b[1] - p[1])) / 2;
    const d = Math.min(radius / Math.tan(half), maxD);
    const r = d * Math.tan(half);
    const s: Vec2 = [p[0] + u[0] * d, p[1] + u[1] * d];
    const e: Vec2 = [p[0] + v[0] * d, p[1] + v[1] * d];
    const bis = norm2([u[0] + v[0], u[1] + v[1]]);
    const cd = r / Math.sin(half);
    const c: Vec2 = [p[0] + bis[0] * cd, p[1] + bis[1] * cd];
    const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
    let da = Math.atan2(e[1] - c[1], e[0] - c[0]) - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    for (let k = 0; k <= 6; k++) {
      const t = a0 + (da * k) / 6;
      out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
    }
  }
  return out;
}

function norm2(v: Vec2): Vec2 {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

const inv = (a: number) => Math.tan(a) - a;

/** Involute spur gear outline (20 degree pressure angle, standard proportions). */
export function gearOutline(cx: number, cy: number, teeth: number, module: number): Vec2[] {
  const alpha = (20 * Math.PI) / 180;
  const rp = (module * teeth) / 2;
  const rb = rp * Math.cos(alpha);
  const ra = rp + module;
  const rf = Math.max(rp - 1.25 * module, module * 0.5);
  const half = Math.PI / (2 * teeth) + inv(alpha);
  const flankAngle = (r: number) => half - inv(Math.acos(Math.min(1, rb / r)));
  const r0 = Math.max(rb, rf);
  const steps = 7;
  const flankR: number[] = [];
  for (let k = 0; k <= steps; k++) flankR.push(r0 + ((ra - r0) * k) / steps);
  const P = (r: number, a: number): Vec2 => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const out: Vec2[] = [];
  for (let i = 0; i < teeth; i++) {
    const th = (2 * Math.PI * i) / teeth;
    const baseA = flankAngle(r0);
    if (rf < r0) out.push(P(rf, th - baseA));
    for (const r of flankR) out.push(P(r, th - flankAngle(r)));
    const tipA = flankAngle(ra);
    out.push(P(ra, th - tipA / 3), P(ra, th + tipA / 3));
    for (const r of [...flankR].reverse()) out.push(P(r, th + flankAngle(r)));
    if (rf < r0) out.push(P(rf, th + baseA));
    const g0 = th + baseA;
    const g1 = th + (2 * Math.PI) / teeth - baseA;
    for (let k = 1; k < 3; k++) out.push(P(rf, g0 + ((g1 - g0) * k) / 3));
  }
  return out;
}

/**
 * Origin of a sketch (or hole) frame on a face: the world origin projected
 * onto the face's plane. Unlike the face's center it doesn't move when the
 * face changes shape, so positions measured from it stay put.
 */
export function planeOrigin(center: Vec3, normal: Vec3): Vec3 {
  const l = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const n: Vec3 = [normal[0] / l, normal[1] / l, normal[2] / l];
  const d = center[0] * n[0] + center[1] * n[1] + center[2] * n[2];
  return [n[0] * d, n[1] * d, n[2] * d];
}

/**
 * A stable in-plane frame for a sketch (or hole) on an arbitrary face: keeps
 * "up" up on walls. Shared by the kernel and the UI so both agree exactly.
 */
export function frameAxes(normal: Vec3): { xDir: Vec3; yDir: Vec3 } {
  const l = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const n: Vec3 = [normal[0] / l, normal[1] / l, normal[2] / l];
  // Near-horizontal faces: project world X; walls: cross(Z, n).
  const x: Vec3 = Math.abs(n[2]) > 0.9 ? [1 - n[0] * n[0], -n[0] * n[1], -n[0] * n[2]] : [-n[1], n[0], 0];
  const xl = Math.hypot(x[0], x[1], x[2]) || 1;
  const xDir: Vec3 = [x[0] / xl, x[1] / xl, x[2] / xl];
  const yDir: Vec3 = [n[1] * xDir[2] - n[2] * xDir[1], n[2] * xDir[0] - n[0] * xDir[2], n[0] * xDir[1] - n[1] * xDir[0]];
  return { xDir, yDir };
}

/** Characteristic points used for snapping (corners, centers, midpoints). */
export function entitySnapPoints(r: ResolvedEntity): { p: Vec2; kind: "end" | "mid" | "center" }[] {
  const out: { p: Vec2; kind: "end" | "mid" | "center" }[] = [];
  switch (r.type) {
    case "rect": {
      const xs = [r.x, r.x + r.w];
      const ys = [r.y, r.y + r.h];
      for (const x of xs) for (const y of ys) out.push({ p: [x, y], kind: "end" });
      out.push({ p: [r.x + r.w / 2, r.y + r.h / 2], kind: "center" });
      out.push({ p: [r.x + r.w / 2, r.y], kind: "mid" }, { p: [r.x + r.w / 2, r.y + r.h], kind: "mid" });
      out.push({ p: [r.x, r.y + r.h / 2], kind: "mid" }, { p: [r.x + r.w, r.y + r.h / 2], kind: "mid" });
      if (r.angle) for (const s of out) s.p = rotAbout(s.p, [r.x + r.w / 2, r.y + r.h / 2], r.angle);
      break;
    }
    case "circle":
      out.push({ p: [r.cx, r.cy], kind: "center" });
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2;
        out.push({ p: [r.cx + r.r * Math.cos(a), r.cy + r.r * Math.sin(a)], kind: "end" });
      }
      break;
    case "polygon":
      out.push({ p: [r.cx, r.cy], kind: "center" });
      for (const p of entityOutline(r)) out.push({ p, kind: "end" });
      break;
    case "slot":
      out.push({ p: [r.cx, r.cy], kind: "center" });
      break;
    case "ellipse":
    case "gear":
      out.push({ p: [r.cx, r.cy], kind: "center" });
      break;
    case "text":
      out.push({ p: [r.x, r.y], kind: "end" });
      break;
    case "polyline":
      r.points.forEach((p, i) => {
        out.push({ p, kind: r.arcs[i] ? "mid" : "end" });
        if (r.arcs[i] || r.arcs[(i + 1) % r.points.length]) return;
        if (r.open && i === r.points.length - 1) return;
        const q = r.points[(i + 1) % r.points.length]!;
        out.push({ p: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], kind: "mid" });
      });
      break;
  }
  return out;
}

export function polygonArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function pointInPolygon([x, y]: Vec2, pts: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToPolygon([x, y]: Vec2, pts: Vec2[]): number {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j]!;
    const [bx, by] = pts[i]!;
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    best = Math.min(best, Math.hypot(ax + dx * t - x, ay + dy * t - y));
  }
  return best;
}

/**
 * True when every vertex of `inner` lies inside `outer`, or on its boundary
 * (so a circle touching a rectangle's sides still counts as a hole).
 */
export function polygonInside(inner: Vec2[], outer: Vec2[], tol = 1e-3): boolean {
  return inner.length > 0 && inner.every((p) => pointInPolygon(p, outer) || distToPolygon(p, outer) <= tol);
}