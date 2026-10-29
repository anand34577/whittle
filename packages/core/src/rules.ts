import type { Evaluator } from "./params";
import type { Feature } from "./model";
import type { QuantityKind } from "./units";

interface Rule {
  field: string;
  kind: QuantityKind;
  label: string;
  /** Returns the problem with an evaluated value, or null when it is fine. */
  bad: (v: number) => string | null;
  /** Skip the rule when this returns true (the field is ignored in that mode). */
  skip?: (f: Record<string, unknown>) => boolean;
}

const positive = (v: number) => (v > 0 ? null : "must be greater than zero");
const nonZero = (v: number) => (v !== 0 ? null : "can't be zero");
const atLeast1 = (v: number) => (v >= 1 ? null : "must be 1 or more");
const upTo360 = (v: number) => (v !== 0 && Math.abs(v) <= 2 * Math.PI + 1e-9 ? null : "must be between 0 and 360 degrees");
// The kernel refuses drafts over 45 degrees (build.ts), so the rule says the same (audit C-12).
const upTo45 = (v: number) => (Math.abs(v) <= Math.PI / 4 + 1e-9 ? null : "must be 45 degrees or less");
const upTo360Or0 = (v: number) => (Math.abs(v) <= 2 * Math.PI + 1e-9 ? null : "must be between 0 and 360 degrees");

const RULES: Partial<Record<Feature["type"], Rule[]>> = {
  extrude: [
    { field: "distance", kind: "length", label: "Distance", bad: nonZero, skip: (f) => f.extent === "through" || f.extent === "face" },
    { field: "distance2", kind: "length", label: "Distance 2", bad: nonZero, skip: (f) => f.extent !== "two" },
  ],
  revolve: [
    { field: "angle", kind: "angle", label: "Angle", bad: upTo360 },
    { field: "angle2", kind: "angle", label: "Second angle", bad: upTo360Or0, skip: (f) => f.extent !== "two" },
  ],
  fillet: [{ field: "radius", kind: "length", label: "Radius", bad: positive }],
  chamfer: [
    { field: "distance", kind: "length", label: "Distance", bad: positive },
    { field: "distance2", kind: "length", label: "Distance 2", bad: positive, skip: (f) => f.mode !== "two" },
  ],
  shell: [{ field: "thickness", kind: "length", label: "Thickness", bad: positive }],
  hole: [
    { field: "diameter", kind: "length", label: "Diameter", bad: positive },
    { field: "depth", kind: "length", label: "Depth", bad: positive, skip: (f) => f.through === true },
    { field: "headDiameter", kind: "length", label: "Head diameter", bad: positive, skip: (f) => f.style === "simple" || f.style === undefined },
    { field: "headDepth", kind: "length", label: "Head depth", bad: positive, skip: (f) => f.style !== "counterbore" },
  ],
  pattern: [
    { field: "count", kind: "count", label: "Count", bad: atLeast1 },
    { field: "count2", kind: "count", label: "Count 2", bad: atLeast1, skip: (f) => f.count2 === undefined },
    // An angle of 0 puts every copy on the original.
    { field: "angle", kind: "angle", label: "Angle", bad: nonZero, skip: (f) => f.pattern !== "circular" },
  ],
  scale: [{ field: "factor", kind: "number", label: "Scale factor", bad: positive }],
  draft: [{ field: "angle", kind: "angle", label: "Angle", bad: upTo45 }],
};

/**
 * Reasons a feature's values can't make a solid (a zero radius, a negative count, a 400 degree sweep...),
 * worded for the person who typed them. Formulas that don't evaluate are reported by the evaluator itself,
 * so only values that evaluate fine are judged here. An empty list means the values are acceptable.
 */
export function featureValueIssues(f: Feature, ev: Evaluator): string[] {
  const rec = f as unknown as Record<string, unknown>;
  const out: string[] = [];
  for (const r of RULES[f.type] ?? []) {
    if (r.skip?.(rec)) continue;
    const raw = rec[r.field];
    if (raw === undefined || raw === "") continue;
    const res = ev.eval(raw as string, r.kind);
    if (!res.ok) {
      out.push(`${r.label}: ${res.error}`);
      continue;
    }
    const problem = r.bad(res.value);
    if (problem) out.push(`${r.label} ${problem} (got ${String(raw)}).`);
  }
  return out;
}
