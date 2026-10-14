/**
 * Sketch shape operations: duplicate, mirror, rotate and pattern copies.
 * They work on shapes whose position fields are plain numbers; shapes driven
 * by parameters are left alone (with a friendly note) so formulas never break.
 */
import type { Draft } from "immer";
import { type SketchEntity, type Vec2, cloneEntity, trim, uid } from "@whittle/core";
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
      const pts: [string, string][] = [];
      for (const [px, py] of c.points) {
        const x = num(px);
        const y = num(py);
        if (x === null || y === null) return null;
        const [nx, ny] = map([x, y]);
        pts.push([s(nx), s(ny)]);
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
