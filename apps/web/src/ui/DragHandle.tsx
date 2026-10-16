/**
 * On-canvas handles for the feature being edited (and the section plane): drag
 * to change a value and watch the model follow, or type the number in the box
 * that sits beside the main handle. Linear handles snap to a face you hover
 * and flip direction when pulled through zero; angle handles click into
 * detents every 15 degrees.
 */
import { useRef, useState } from "react";
import { type Feature, type Vec3, LENGTH_TO_MM } from "@whittle/core";
import type { RegenResult } from "@whittle/kernel";
import { cancelSession, commitSession, updateFeature } from "../state/store";
import type { Viewport } from "../viewport/Viewport";

type Round = (v: number, fine: boolean) => number;

interface Spec {
  key: string;
  label?: string;
  anchor: Vec3;
  /** World direction (handle sits `off` mm along it); without it the handle sits `off` pixels along a screen diagonal. */
  dir?: Vec3;
  off: number;
  /** Value change per mm (world mode) or per pixel (screen mode) of handle travel. */
  per: number;
  value: number;
  unit: string;
  min?: number;
  round: Round;
  /** Colour hint: an axis ("x" | "y" | "z") or "cut" for a subtractive pull. */
  tone?: string;
  /** Linear pulls may snap to a hovered flat face: value per mm of reach. */
  snap?: boolean;
  /** Gets the number box. */
  primary?: boolean;
  /** The feature's direction flag when the drag began (for polarity flips). */
  flip?: boolean;
  set(v: number, flip0: boolean): void;
}

const num = (s: string | undefined) => (s !== undefined && s.trim() !== "" && Number.isFinite(Number(s)) ? Number(s) : null);
const AXES: Record<string, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const neg = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];

const stepRound: Round = (v, fine) => {
  const step = fine ? 0.01 : Math.max(0.01, Math.pow(10, Math.floor(Math.log10(Math.max(Math.abs(v), 1))) - 1));
  return Math.round(v / step) * step;
};
const angleRound: Round = (v, fine) => {
  const d = Math.round(v / 15) * 15;
  if (!fine && Math.abs(v - d) < 3) return d;
  return fine ? Math.round(v * 10) / 10 : Math.round(v);
};
const countRound: Round = (v) => Math.round(v);

function center(fill: Float32Array | undefined, fallback: Vec3): Vec3 {
  if (!fill?.length) return fallback;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < fill.length; i += 3) for (let j = 0; j < 3; j++) (lo[j] = Math.min(lo[j]!, fill[i + j]!)), (hi[j] = Math.max(hi[j]!, fill[i + j]!));
  return [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2];
}

function bodyBox(regen: RegenResult | null, id?: string) {
  const b = regen?.bodies.find((x) => x.id === id) ?? regen?.bodies[regen.bodies.length - 1];
  if (!b) return null;
  const [lo, hi] = b.bbox;
  return { c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] as Vec3, size: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) };
}

const perpendicular = (n: Vec3): Vec3 => {
  const t: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const c: Vec3 = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
  const l = Math.hypot(...c) || 1;
  return [c[0] / l, c[1] / l, c[2] / l];
};

/** The handles for this feature: empty when nothing is picked yet or a value is a formula rather than a plain number. */
function specsFor(f: Feature, regen: RegenResult | null, mm: number, units: string): Spec[] {
  const out: Spec[] = [];
  const len = (s: Omit<Spec, "unit" | "round"> & Partial<Pick<Spec, "round">>): void => void out.push({ unit: units, round: stepRound, ...s });
  const angle = (s: Omit<Spec, "unit" | "round" | "per" | "off">): void => void out.push({ unit: "°", round: angleRound, per: 1, off: 0, ...s });
  switch (f.type) {
    case "extrude": {
      const v = num(f.distance);
      const fr = regen?.sketches.find((s) => s.id === f.sketch);
      if (v === null || !fr) return out;
      const sign = f.flip ? -1 : 1;
      const anchor = center(fr.fill, fr.origin);
      const n = fr.normal.map((x) => x * sign) as Vec3;
      if (f.extent === "one" || f.extent === "symmetric") {
        const k = f.extent === "symmetric" ? 0.5 : 1;
        len({
          key: "d", anchor, dir: n, off: v * mm * k, per: 1 / (mm * k), value: v, primary: true, snap: f.extent === "one", flip: f.flip, tone: f.op === "cut" ? "cut" : undefined,
          set: (x, flip0) => void updateFeature(f.id, "Drag " + f.name, (d) => void (d.type === "extrude" && ((d.distance = String(Math.round(Math.abs(x) * 1000) / 1000)), (d.flip = flip0 !== x < 0))), "drag" + f.id),
        });
      } else if (f.extent === "two") {
        const v2 = num(f.distance2 ?? "0") ?? 0;
        len({ key: "d", anchor, dir: n, off: v * mm, per: 1 / mm, min: 0, value: v, primary: true, set: (x) => void updateFeature(f.id, "Drag " + f.name, (d) => void (d.type === "extrude" && (d.distance = String(x))), "drag" + f.id) });
        len({ key: "d2", anchor, dir: neg(n), off: v2 * mm, per: 1 / mm, min: 0, value: v2, set: (x) => void updateFeature(f.id, "Drag " + f.name, (d) => void (d.type === "extrude" && (d.distance2 = String(x))), "drag2" + f.id) });
      }
      return out;
    }
    case "revolve": {
      const v = num(f.angle);
      const fr = regen?.sketches.find((s) => s.id === f.sketch);
      if (v === null || !fr) return out;
      angle({ key: "a", anchor: center(fr.fill, fr.origin), value: v, primary: true, min: 1, set: (x) => void updateFeature(f.id, "Drag " + f.name, (d) => void (d.type === "revolve" && (d.angle = String(x))), "drag" + f.id) });
      return out;
    }
    case "offsetFace": {
      const v = num(f.distance);
      const face = f.faces[0];
      if (v === null || !face) return out;
      len({ key: "d", anchor: face.center, dir: face.normal, off: v * mm, per: 1 / mm, value: v, primary: true, snap: true, tone: v < 0 ? "cut" : undefined, set: (x) => void updateFeature(f.id, "Drag " + f.name, (d) => void (d.type === "offsetFace" && (d.distance = String(x))), "drag" + f.id) });
      return out;
    }
    case "shell": {
      const v = num(f.thickness);
      const face = f.faces[0];
      if (v === null || !face) return out;
      len({ key: "t", anchor: face.center, dir: neg(face.normal), off: v * mm, per: 1 / mm, min: 0.01, value: v, primary: true, set: (x) => void updateFeature(f.id, "Drag " + f.name, (d) => void (d.type === "shell" && (d.thickness = String(x))), "drag" + f.id) });
      return out;
    }
    case "fillet":
    case "chamfer": {
      const v = num(f.type === "fillet" ? f.radius : f.distance);
      const e = f.edges[0];
      if (v === null || !e) return out;
      len({ key: "r", anchor: e.mid, off: v * mm, per: 1 / mm, min: 0.01, value: v, primary: true, set: (x) => void updateFeature(f.id, "Drag " + f.name, (d) => void ((d.type === "fillet" && (d.radius = String(x))) || (d.type === "chamfer" && (d.distance = String(x)))), "drag" + f.id) });
      return out;
    }
    case "hole": {
      const face = f.face;
      const dia = num(f.diameter);
      if (!face || dia === null) return out;
      const depth = num(f.depth);
      if (!f.through && depth !== null)
        len({ key: "depth", label: "Depth", anchor: face.center, dir: neg(face.normal), off: depth * mm, per: 1 / mm, min: 0.01, value: depth, primary: true, snap: true, set: (x) => void updateFeature(f.id, "Drag " + f.name, (d) => void (d.type === "hole" && (d.depth = String(x))), "drag" + f.id) });
      len({ key: "dia", label: "Ø", anchor: face.center, dir: perpendicular(face.normal), off: (dia * mm) / 2, per: 2 / mm, min: 0.01, value: dia, set: (x) => void updateFeature(f.id, "Drag " + f.name, (d) => void (d.type === "hole" && (d.diameter = String(x))), "drag2" + f.id) });
      return out;
    }
    case "pattern": {
      const box = bodyBox(regen, f.bodyId);
      const count = num(f.count);
      const spacing = num(f.spacing);
      if (!box) return out;
      if (f.pattern === "linear" && count !== null && spacing !== null && spacing > 0) {
        const dir = AXES[f.axis]!;
        len({ key: "sp", label: "Spacing", anchor: box.c, dir, off: spacing * mm, per: 1 / mm, min: 0.01, value: spacing, primary: true, set: (x) => void updateFeature(f.id, "Drag " + f.name, (d) => void (d.type === "pattern" && (d.spacing = String(x))), "drag" + f.id) });
        len({ key: "n", label: "Count", anchor: box.c, dir, off: spacing * mm * count, per: 1 / (spacing * mm), min: 2, value: count, round: countRound, set: (x) => void updateFeature(f.id, "Drag " + f.name, (d) => void (d.type === "pattern" && (d.count = String(Math.max(2, x)))), "drag2" + f.id) });
      }
      if (f.pattern === "circular") {
        const a = num(f.angle);
        if (a !== null) angle({ key: "a", label: "Angle", anchor: box.c, value: a, primary: true, min: 1, set: (x) => void updateFeature(f.id, "Drag " + f.name, (d) => void (d.type === "pattern" && (d.angle = String(x))), "drag" + f.id) });
      }
      return out;
    }
    case "move": {
      const box = bodyBox(regen, f.bodyId);
      if (!box) return out;
      (["x", "y", "z"] as const).forEach((ax, i) => {
        const v = num(f.translate[i]);
        if (v !== null) len({ key: ax, label: ax.toUpperCase(), tone: ax, anchor: box.c, dir: AXES[ax]!, off: box.size * 0.7, per: 1 / mm, value: v, set: (x) => void updateFeature(f.id, "Drag " + f.name, (d) => void (d.type === "move" && (d.translate[i] = String(x))), "drag" + ax + f.id) });
      });
      const a = num(f.angle);
      if (a !== null) angle({ key: "rot", label: "Rotate", anchor: box.c, value: a, set: (x) => void updateFeature(f.id, "Drag " + f.name, (d) => void (d.type === "move" && (d.angle = String(x))), "dragr" + f.id) });
      return out;
    }
    case "draft": {
      const a = num(f.angle);
      const face = f.faces[0];
      if (a === null || !face) return out;
      angle({ key: "a", anchor: face.center, value: a, primary: true, set: (x) => void updateFeature(f.id, "Drag " + f.name, (d) => void (d.type === "draft" && (d.angle = String(x))), "drag" + f.id) });
      return out;
    }
    default:
      return out;
  }
}

/** Screen position of a handle, plus the unit direction of its travel and the pixels per mm along it. */
function place(vp: Viewport, s: Spec) {
  const a = vp.worldToScreen(s.anchor);
  if (!s.dir) {
    const u: [number, number] = [Math.SQRT1_2, -Math.SQRT1_2];
    // Lengths scale with the zoom (so the handle sits on the edge it rounds); angles use a fixed pixel scale.
    const angleMode = s.unit === "°";
    const ppu = angleMode ? 0.6 : 1 / vp.pixelSize;
    const px = angleMode ? 40 + s.value * ppu : s.off * ppu;
    return { at: [a[0] + u[0] * px, a[1] + u[1] * px] as [number, number], u, ppm: ppu };
  }
  const probe = vp.worldToScreen([s.anchor[0] + s.dir[0] * 10, s.anchor[1] + s.dir[1] * 10, s.anchor[2] + s.dir[2] * 10]);
  const dx = probe[0] - a[0];
  const dy = probe[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const u: [number, number] = [dx / len, dy / len];
  return { at: [a[0] + (dx * s.off) / 10, a[1] + (dy * s.off) / 10] as [number, number], u, ppm: len / 10 };
}

export interface SectionState {
  axis: "x" | "y" | "z";
  offset: number;
}

export function DragHandles({
  vp,
  feature,
  regen,
  units,
  section,
  setSection,
}: {
  vp: Viewport | null;
  feature: Feature | undefined;
  regen: RegenResult | null;
  units: keyof typeof LENGTH_TO_MM;
  section?: SectionState | null;
  setSection?: (offset: number) => void;
}) {
  const f = LENGTH_TO_MM[units];
  const specs: Spec[] = [];
  if (feature && vp) specs.push(...specsFor(feature, regen, f, units));
  if (vp && section && setSection && !specs.length) {
    const c: Vec3 = [0, 0, 0];
    const i = { x: 0, y: 1, z: 2 }[section.axis];
    for (const ax of ["x", "y", "z"] as const) if (ax !== section.axis) c[{ x: 0, y: 1, z: 2 }[ax]] = (vp.sectionRange(ax)[0] + vp.sectionRange(ax)[1]) / 2;
    c[i] = 0;
    specs.push({ key: "sec", label: "Section", anchor: c, dir: AXES[section.axis]!, off: section.offset, per: 1 / f, value: section.offset / f, unit: units, round: stepRound, primary: false, set: (x) => setSection(x * f) });
  }
  const drag = useRef<{ key: string; x: number; y: number; start: number; flip0: boolean; u: [number, number]; ppm: number } | null>(null);
  const [live, setLive] = useState<string | null>(null);
  const [snapped, setSnapped] = useState(false);
  if (!vp || !specs.length) return null;

  const move = (e: React.PointerEvent, s: Spec) => {
    const d = drag.current;
    if (!d || d.key !== s.key) return;
    const fine = e.altKey || e.ctrlKey || e.metaKey;
    let v = d.start + (((e.clientX - d.x) * d.u[0] + (e.clientY - d.y) * d.u[1]) / d.ppm) * s.per;
    let snap = false;
    if (s.snap && s.dir && !fine) {
      // Hovering a flat face square to the pull: run exactly up to it.
      const hit = vp.pick(e);
      if (hit?.kind === "face") {
        const face = regen?.bodies.find((b) => b.id === hit.bodyId)?.faces[hit.index];
        if (face && Math.abs(dot(face.normal, s.dir)) > 0.98) {
          const reach = dot(sub(face.center, s.anchor), s.dir) * s.per;
          if (Math.abs(reach) > 0.01) (v = reach), (snap = true);
        }
      }
    }
    setSnapped(snap);
    if (!snap) v = s.round(v, fine);
    if (s.min !== undefined) v = Math.max(s.min, v);
    s.set(Math.round(v * 1000) / 1000, d.flip0);
  };

  return (
    <>
      {specs.map((s) => {
        const { at, u, ppm } = place(vp, s);
        const active = live === s.key;
        const danger = s.tone === "cut";
        return (
          <button
            key={s.key}
            type="button"
            className={`drag-handle ${active ? "is-live" : ""} ${danger ? "is-cut" : ""} ${s.tone && "xyz".includes(s.tone) ? "is-axis-" + s.tone : ""}`}
            style={{ left: at[0], top: at[1] }}
            aria-label={`Drag to change ${s.label ?? "the value"} (now ${Math.round(s.value * 100) / 100} ${s.unit})`}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { key: s.key, x: e.clientX, y: e.clientY, start: s.value, flip0: !!s.flip, u, ppm };
              setLive(s.key);
            }}
            onPointerMove={(e) => move(e, s)}
            onPointerUp={() => {
              drag.current = null;
              setLive(null);
              setSnapped(false);
            }}
          >
            <span className="drag-handle__dot" />
            {s.primary && feature && (
              <input
                className="drag-handle__input mono"
                inputMode="decimal"
                aria-label={`${s.label ?? "Value"} in ${s.unit}`}
                value={Math.round(s.value * 1000) / 1000}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  // Enter finishes the edit, Escape abandons it, as everywhere else.
                  if (e.key === "Enter") (e.currentTarget.blur(), commitSession());
                  else if (e.key === "Escape") (e.currentTarget.blur(), cancelSession());
                }}
                onChange={(e) => {
                  const t = e.target.value.trim();
                  const v = Number(t);
                  if (t === "" || !Number.isFinite(v)) return;
                  s.set(s.min !== undefined ? Math.max(s.min, v) : v, !!s.flip);
                }}
              />
            )}
            {((active && (!s.primary || snapped)) || (!s.primary && s.label)) && (
              <span className={`drag-handle__tip mono ${active ? "" : "is-quiet"}`}>
                {s.label && `${s.label} `}
                {Math.round(s.value * 100) / 100}
                {s.unit === "°" ? "°" : ` ${s.unit}`}
                {active && snapped && " · to face"}
              </span>
            )}
          </button>
        );
      })}
    </>
  );
}
