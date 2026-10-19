/**
 * The measure tool: one pick reports its own size (length, diameter, area),
 * two picks report the distance and angle between them.
 */
import { LENGTH_TO_MM, type LengthUnit, type Vec3, formatQuantity, trim } from "@whittle/core";
import type { BodyResult, MeasurePick } from "@whittle/kernel";
import type { Pick } from "./store";

export interface MeasureLine {
  label: string;
  value: string;
  primary?: boolean;
}

export interface MeasureResult {
  lines: MeasureLine[];
  /** A dimension segment to draw in the view. */
  segment?: [Vec3, Vec3];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const addS = (a: Vec3, b: Vec3, s: number): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/** Volume in a unit people use for that system: in³ / ft³ for imperial, cm³ otherwise. */
export function volumeText(mm3: number, unit: LengthUnit, digits = 3): string {
  if (unit === "in" || unit === "ft") return `${trim(mm3 / LENGTH_TO_MM[unit] ** 3, digits)} ${unit}³`;
  return `${trim(mm3 / 1000, digits)} cm³`;
}

/** Area in the design's unit (cm² for mm designs, as before). */
export function areaText(mm2: number, unit: LengthUnit, digits = 2): string {
  const u = unit === "mm" ? "cm" : unit;
  return `${trim(mm2 / LENGTH_TO_MM[u] ** 2, digits)} ${u}²`;
}

function pointOf(p: Pick, bodies: BodyResult[]): Vec3 | null {
  if (p.kind !== "face" && p.kind !== "edge" && p.kind !== "body") return null;
  if (p.at) return p.at;
  const b = bodies.find((x) => x.id === p.bodyId);
  if (!b) return null;
  if (p.kind === "face") return b.faces[p.index]?.center ?? null;
  if (p.kind === "edge") return b.edges[p.index]?.mid ?? null;
  return b.centerOfMass;
}

function describe(p: Pick, bodies: BodyResult[], unit: LengthUnit): MeasureLine[] {
  const L = (v: number) => formatQuantity(v, "length", unit);
  const area = (v: number) => (unit === "mm" ? `${trim(v, 2)} mm²` : `${trim(v / LENGTH_TO_MM[unit] ** 2, 3)} ${unit}²`);
  const b = p.kind === "face" || p.kind === "edge" || p.kind === "body" ? bodies.find((x) => x.id === p.bodyId) : undefined;
  if (!b) return [];
  if (p.kind === "edge") {
    const e = b.edges[p.index];
    if (!e) return [];
    const out: MeasureLine[] = [];
    if (e.radius) {
      out.push({ label: "Diameter", value: L(e.radius * 2), primary: true }, { label: "Radius", value: L(e.radius) });
    }
    out.push({ label: "Length", value: L(e.length), primary: !e.radius });
    return out;
  }
  if (p.kind === "face") {
    const f = b.faces[p.index];
    if (!f) return [];
    return [
      { label: "Area", value: area(f.area), primary: true },
      { label: "Surface", value: f.surface.toLowerCase().replace("cylindre", "cylinder").replace("_surface", "") },
    ];
  }
  const size = [0, 1, 2].map((i) => trim((b.bbox[1][i]! - b.bbox[0][i]!) / LENGTH_TO_MM[unit], 2)).join(" × ");
  return [
    { label: "Size", value: `${size} ${unit}`, primary: true },
    { label: "Volume", value: volumeText(b.volume, unit) },
  ];
}

/** One line about what the pointer rests on, for the hover chip: "Round face · Ø 8 mm", "Edge · 35 mm". */
export function quickInfo(p: Pick, bodies: BodyResult[], unit: LengthUnit): string | null {
  if (p.kind !== "face" && p.kind !== "edge") return null;
  const b = bodies.find((x) => x.id === p.bodyId);
  if (!b) return null;
  const L = (v: number) => formatQuantity(v, "length", unit);
  if (p.kind === "edge") {
    const e = b.edges[p.index];
    if (!e) return null;
    return e.radius ? `${e.length >= Math.PI * 2 * e.radius - 1e-6 ? "Circle" : "Arc"} · Ø ${L(e.radius * 2)}` : `Edge · ${L(e.length)}`;
  }
  const f = b.faces[p.index];
  if (!f) return null;
  const r = (b.faceEdges[p.index] ?? []).map((i) => b.edges[i]?.radius).find((x) => x);
  const kind = f.surface === "PLANE" ? "Flat face" : r ? "Round face" : "Curved face";
  return `${kind} · ${f.surface !== "PLANE" && r ? `Ø ${L(r * 2)}` : areaText(f.area, unit)}`;
}

function direction(p: Pick, bodies: BodyResult[]): { kind: "normal" | "tangent"; v: Vec3; planar: boolean } | null {
  const b = p.kind === "face" || p.kind === "edge" ? bodies.find((x) => x.id === p.bodyId) : undefined;
  if (!b) return null;
  if (p.kind === "face") {
    const f = b.faces[p.index];
    return f ? { kind: "normal", v: f.normal, planar: f.surface === "PLANE" } : null;
  }
  if (p.kind === "edge") {
    const e = b.edges[p.index];
    return e ? { kind: "tangent", v: e.tangent, planar: e.curve === "LINE" } : null;
  }
  return null;
}

/** What the geometry engine measures between two picks: faces, edges or bodies (not the clicked spots). */
export function measurePicks(picks: Pick[]): MeasurePick[] | null {
  const out = picks.map((p): MeasurePick | null => (p.kind === "face" || p.kind === "edge" ? { bodyId: p.bodyId, kind: p.kind, index: p.index } : p.kind === "body" ? { bodyId: p.bodyId, kind: "body" } : null));
  return out.length === 2 && out.every((x) => x) ? (out as MeasurePick[]) : null;
}

/** `exact`: the engine's shortest distance between the two picks, once it has answered. */
export function measure(picks: Pick[], bodies: BodyResult[], unit: LengthUnit, exact?: { d: number; a: Vec3; b: Vec3 } | null): MeasureResult | null {
  if (picks.length === 0) return null;
  if (picks.length === 1) return { lines: describe(picks[0]!, bodies, unit) };
  const [a, b] = picks as [Pick, Pick];
  const pa = pointOf(a, bodies);
  const pb = pointOf(b, bodies);
  if (!pa || !pb) return null;
  const L = (v: number) => formatQuantity(v, "length", unit);
  const lines: MeasureLine[] = [];
  let segment: [Vec3, Vec3] = [pa, pb];
  const da = direction(a, bodies);
  const db = direction(b, bodies);
  if (exact) {
    // The shortest distance between the things themselves (touching faces are 0 apart).
    lines.push({ label: "Distance", value: L(exact.d), primary: true });
    segment = [exact.a, exact.b];
  } else if (da && db && da.kind === "normal" && db.kind === "normal" && da.planar && db.planar && Math.abs(dot(da.v, db.v)) > 0.9999) {
    // Two parallel flat faces: the gap between them is what people want.
    const gap = dot(sub(pb, pa), da.v);
    lines.push({ label: "Distance", value: L(Math.abs(gap)), primary: true });
    segment = [pa, addS(pa, da.v, gap)];
  } else {
    lines.push({ label: "Distance", value: L(len(sub(pb, pa))), primary: true });
  }
  const d = sub(segment[1], segment[0]);
  lines.push({ label: "ΔX ΔY ΔZ", value: d.map((v) => trim(v / LENGTH_TO_MM[unit], 2)).join("  ") });
  if (da && db) {
    const c = Math.abs(dot(da.v, db.v));
    let ang = (Math.acos(Math.min(1, c)) * 180) / Math.PI;
    if (da.kind !== db.kind) ang = 90 - ang;
    lines.push({ label: "Angle", value: `${trim(ang, 2)}°` });
  }
  // Things that touch have nothing to draw between them.
  return { lines, segment: len(d) > 1e-9 ? segment : undefined };
}
