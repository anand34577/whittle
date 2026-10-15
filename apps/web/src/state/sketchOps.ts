/**
 * Sketch shape operations: duplicate, mirror, rotate and pattern copies.
 * They work on shapes whose position fields are plain numbers; shapes driven
 * by parameters are left alone (with a friendly note) so formulas never break.
 */
import type { Draft } from "immer";
import { type PolyPoint, type SketchEntity, type Vec2, cloneEntity, offsetPoints, polygonArea, trim, uid } from "@whittle/core";
import { promptDialog } from "./dialogs";
import { findFeature, sketchMutate, toast, useApp } from "./store";

const PLAIN = /^\s*-?\d*\.?\d+(e-?\d+)?\s*$/i;
const num = (v: string | undefined, fallback = 0): number | null => (v === undefined || v === "" ? fallback : PLAIN.test(v) ? parseFloat(v) : null);
const s = (n: number) => trim(Math.abs(n) < 1e-9 ? 0 : n, 4);

type PointMap = (p: Vec2) => Vec2;

/**
 * Transform an entity by a rigid map. `turn` is the rotation in degrees the map
 * applies; `flip` is set for mirrors (the mirror axis angle, in degrees).
 */
function transform(e: SketchEntity, map: PointMap, turn: number, flip: number | null): SketchEntity | null {
  const c = structuredClone(e) as SketchEntity;
  const ang = (a: number) => (flip === null ? a + turn : 2 * flip - a);
  switch (c.type) {
    case "circle":
    case "polygon":
    case "slot":
    case "ellipse":
    case "gear": {
      const cx = num(c.cx);
      const cy = num(c.cy);
      if (cx === null || cy === null) return null;
      const [x, y] = map([cx, cy]);
      c.cx = s(x);
      c.cy = s(y);
      if (c.type === "polygon" || c.type === "slot" || c.type === "ellipse") {
        const a = num(c.angle);
        if (a === null) return null;
        c.angle = s(ang(a));
      }
      return c;
    }
    case "rect": {
      const x = num(c.x);
      const y = num(c.y);
      const w = num(c.w);
      const h = num(c.h);
      const a = num(c.angle);
      if (x === null || y === null || a === null) return null;
      // Positions may be relative to the corner; the sizes are only needed then.
      let center: Vec2 = [x, y];
      if (c.anchor === "corner") {
        if (w === null || h === null) return null;
        center = [x + w / 2, y + h / 2];
      }
      const [nx, ny] = map(center);
      c.anchor = "center";
      c.x = s(nx);
      c.y = s(ny);
      c.angle = s(ang(a));
      if (c.angle === "0") delete c.angle;
      return c;
    }
    case "text": {
      const x = num(c.x);
      const y = num(c.y);
      const a = num(c.angle);
      if (x === null || y === null || a === null) return null;
      const [nx, ny] = map([x, y]);
      c.x = s(nx);
      c.y = s(ny);
      if (flip === null) c.angle = s(a + turn);
      return c;
    }
    case "polyline": {
      const pts: PolyPoint[] = [];
      for (const [px, py, arc] of c.points) {
        const x = num(px);
        const y = num(py);
        if (x === null || y === null) return null;
        const [nx, ny] = map([x, y]);
        pts.push(arc ? [s(nx), s(ny), arc] : [s(nx), s(ny)]);
      }
      c.points = flip === null ? pts : pts.reverse();
      return c;
    }
  }
}

function current(id: string | null): SketchEntity | undefined {
  const st = useApp.getState();
  if (st.mode.kind !== "sketch" || !id) return undefined;
  return findFeature(st.doc, st.mode.sketchId, "sketch")?.entities.find((x) => x.id === id);
}

const PARAM_NOTE = "This shape's position comes from formulas, so it can't be moved automatically. Edit its values instead.";

function addAll(label: string, list: SketchEntity[]) {
  sketchMutate(label, (sk) => {
    for (const e of list) sk.entities.push(e as Draft<SketchEntity>);
  });
}

const rotMap = (deg: number, c: Vec2 = [0, 0]): PointMap => {
  const a = (deg * Math.PI) / 180;
  const cs = Math.cos(a);
  const sn = Math.sin(a);
  return ([x, y]) => [c[0] + (x - c[0]) * cs - (y - c[1]) * sn, c[1] + (x - c[0]) * sn + (y - c[1]) * cs];
};

export function duplicateEntity(id = useApp.getState().selectedEntity) {
  const e = current(id);
  if (!e) return;
  const step = 10;
  const moved = transform(e, ([x, y]) => [x + step, y - step], 0, null);
  const copy = cloneEntity(moved ?? e);
  addAll("Duplicate shape", [copy]);
  useApp.setState({ selectedEntity: copy.id });
}

/** Mirror across the sketch's vertical ("y") or horizontal ("x") axis, as a copy. */
export function mirrorEntity(axis: "x" | "y", id = useApp.getState().selectedEntity) {
  const e = current(id);
  if (!e) return;
  const m = transform(e, axis === "y" ? ([x, y]) => [-x, y] : ([x, y]) => [x, -y], 0, axis === "y" ? 90 : 0);
  if (!m) return toast("info", PARAM_NOTE);
  addAll("Mirror shape", [{ ...m, id: uid("e") }]);
}

export function rotateEntity(deg: number, id = useApp.getState().selectedEntity) {
  const e = current(id);
  if (!e) return;
  const center = pivot(e);
  const r = transform(e, rotMap(deg, center), deg, null);
  if (!r) return toast("info", PARAM_NOTE);
  sketchMutate("Rotate shape", (sk) => {
    const i = sk.entities.findIndex((x) => x.id === e.id);
    if (i >= 0) sk.entities[i] = r as Draft<SketchEntity>;
  });
}

/** Copies spaced evenly around the sketch origin (e.g. a bolt circle). */
export function circularCopies(count: number, id = useApp.getState().selectedEntity) {
  const e = current(id);
  if (!e || count < 2) return;
  const out: SketchEntity[] = [];
  for (let i = 1; i < count; i++) {
    const deg = (360 / count) * i;
    const r = transform(e, rotMap(deg), deg, null);
    if (!r) return toast("info", PARAM_NOTE);
    out.push({ ...r, id: uid("e") });
  }
  addAll("Circular copies", out);
}

/** Copies in a row, `dx`/`dy` apart. */
export function linearCopies(count: number, dx: number, dy: number, id = useApp.getState().selectedEntity) {
  const e = current(id);
  if (!e || count < 2) return;
  const out: SketchEntity[] = [];
  for (let i = 1; i < count; i++) {
    const r = transform(e, ([x, y]) => [x + dx * i, y + dy * i], 0, null);
    if (!r) return toast("info", PARAM_NOTE);
    out.push({ ...r, id: uid("e") });
  }
  addAll("Copies in a row", out);
}

/** `expr + k`, kept as a plain number when it is one (so the result stays editable either way). */
const plus = (expr: string, k: number) => {
  const v = num(expr);
  return v !== null ? s(v + k) : `(${expr}) + ${s(k)}`;
};

/**
 * A copy of a shape grown outward (positive) or shrunk inward (negative) by `d`.
 * Sizes stay formulas of the original's, so the offset follows its edits.
 */
export function offsetShape(e: SketchEntity, d: number): SketchEntity | string {
  const c = { ...structuredClone(e), id: uid("e") } as SketchEntity;
  switch (c.type) {
    case "circle":
      c.r = plus(c.r, d);
      return c;
    case "slot":
      c.width = plus(c.width, 2 * d);
      return c;
    case "ellipse":
      c.rx = plus(c.rx, d);
      c.ry = plus(c.ry, d);
      return c;
    case "polygon": {
      const n = num(c.sides);
      if (n === null) return "Offset needs a polygon with a fixed number of sides.";
      c.r = plus(c.r, d / Math.cos(Math.PI / n));
      return c;
    }
    case "rect": {
      if (c.anchor === "corner") {
        c.x = plus(c.x, -d);
        c.y = plus(c.y, -d);
      }
      c.w = plus(c.w, 2 * d);
      c.h = plus(c.h, 2 * d);
      if (c.corner && num(c.corner) !== 0) c.corner = plus(c.corner, d);
      return c;
    }
    case "polyline": {
      if (c.smooth || c.points.some((p) => p[2])) return "Offset works on outlines with straight sides. Turn off Smooth curve or remove arc points first.";
      const pts = c.points.map(([x, y]) => [num(x), num(y)]);
      if (pts.some(([x, y]) => x === null || y === null)) return PARAM_NOTE;
      const p = pts as Vec2[];
      // Left of travel is inside for counter-clockwise outlines; open paths offset to their left.
      const side = c.open ? 1 : polygonArea(p) > 0 ? -1 : 1;
      c.points = offsetPoints(p, d * side, !c.open).map(([x, y]) => [s(x), s(y)]);
      return c;
    }
    default:
      return "Text and gears can't be offset. Draw an outline around them instead.";
  }
}

export async function offsetEntity(id = useApp.getState().selectedEntity) {
  const e = current(id);
  if (!e) return;
  const v = await promptDialog({
    title: "Offset shape",
    label: "Distance",
    message: "A copy grown outward by this distance. Use a negative distance to shrink it inward (walls, clearances, lips).",
    initial: "2",
    type: "number",
    unit: useApp.getState().doc.units,
    validate: (x) => (Number.isFinite(parseFloat(x)) && parseFloat(x) !== 0 ? null : "Enter a distance other than zero"),
  });
  if (v === null) return;
  const out = offsetShape(e, parseFloat(v));
  if (typeof out === "string") return toast("info", out);
  addAll("Offset shape", [out]);
  useApp.setState({ selectedEntity: out.id });
}

function pivot(e: SketchEntity): Vec2 {
  switch (e.type) {
    case "rect": {
      const x = num(e.x) ?? 0;
      const y = num(e.y) ?? 0;
      return e.anchor === "center" ? [x, y] : [x + (num(e.w) ?? 0) / 2, y + (num(e.h) ?? 0) / 2];
    }
    case "text":
      return [num(e.x) ?? 0, num(e.y) ?? 0];
    case "polyline": {
      const pts = e.points.map(([x, y]) => [num(x) ?? 0, num(y) ?? 0] as Vec2);
      return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
    }
    default:
      return [num(e.cx) ?? 0, num(e.cy) ?? 0];
  }
}
