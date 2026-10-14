/**
 * Units. Internally every length is millimetres and every angle is radians.
 * Display units are a per-document preference.
 */

export type LengthUnit = "mm" | "cm" | "m" | "in" | "ft";
export type AngleUnit = "deg" | "rad";

/** Dimension exponents of a quantity: length^len · angle^ang. */
export interface Dim {
  len: number;
  ang: number;
}

export const LENGTH_TO_MM: Record<LengthUnit, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

export const ANGLE_TO_RAD: Record<AngleUnit, number> = {
  deg: Math.PI / 180,
  rad: 1,
};

export const UNIT_LITERALS: Record<string, { factor: number; dim: Dim }> = {
  mm: { factor: 1, dim: { len: 1, ang: 0 } },
  cm: { factor: 10, dim: { len: 1, ang: 0 } },
  m: { factor: 1000, dim: { len: 1, ang: 0 } },
  in: { factor: 25.4, dim: { len: 1, ang: 0 } },
  ft: { factor: 304.8, dim: { len: 1, ang: 0 } },
  deg: { factor: Math.PI / 180, dim: { len: 0, ang: 1 } },
  rad: { factor: 1, dim: { len: 0, ang: 1 } },
};

export type QuantityKind = "length" | "angle" | "number" | "count";

export const KIND_DIM: Record<QuantityKind, Dim> = {
  length: { len: 1, ang: 0 },
  angle: { len: 0, ang: 1 },
  number: { len: 0, ang: 0 },
  count: { len: 0, ang: 0 },
};

export function dimEquals(a: Dim, b: Dim): boolean {
  return a.len === b.len && a.ang === b.ang;
}

export function isDimensionless(d: Dim): boolean {
  return d.len === 0 && d.ang === 0;
}

export function describeDim(d: Dim): string {
  if (isDimensionless(d)) return "a plain number";
  if (d.len === 1 && d.ang === 0) return "a length";
  if (d.len === 0 && d.ang === 1) return "an angle";
  if (d.len === 2 && d.ang === 0) return "an area";
  if (d.len === 3 && d.ang === 0) return "a volume";
  const parts: string[] = [];
  if (d.len) parts.push(`length^${d.len}`);
  if (d.ang) parts.push(`angle^${d.ang}`);
  return parts.join("·");
}

/** Format an internal value (mm or rad) in the given display unit. */
export function formatQuantity(
  value: number,
  kind: QuantityKind,
  lengthUnit: LengthUnit = "mm",
  digits = 2,
): string {
  if (kind === "length") {
    return `${trim(value / LENGTH_TO_MM[lengthUnit], digits)} ${lengthUnit}`;
  }
  if (kind === "angle") return `${trim((value * 180) / Math.PI, digits)}°`;
  if (kind === "count") return String(Math.round(value));
  return trim(value, digits + 2);
}

export function trim(value: number, digits: number): string {
  if (!Number.isFinite(value)) return "—";
  const fixed = value.toFixed(digits);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}
